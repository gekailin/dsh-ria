import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { migrateTickets, repairTicketMeta } from '../scripts/sqlite-migrate.mjs'
import { openDatabase } from '../lib/state/sqlite/db.mjs'

const ticket = (id, extra = {}) => ({
  ticketId: id, status: 'open', waitingOn: 'ria', executor: 'advisor', goal: 'goal ' + id,
  acceptance: 'accept', revision: 1, createdAt: 100, updatedAt: 100, closedAt: null,
  attempt: { legacy: true }, failure: null, resolution: null,
  history: [{ at: 100, actor: 'router', from: 'intake', to: 'open', reason: 'route' }],
  ...extra,
})

const makeDir = name => { const dir = join(root, name); mkdirSync(dir, { recursive: true }); return dir }

function seed(dir) {
  const hot = [ticket('t1'), ticket('t2', { status: 'working', waitingOn: 'worker' }), ticket('t3', { status: 'blocked', waitingOn: 'user' })]
  const archived = ticket('t4', { status: 'done', closedAt: 200, resolution: { summary: 'done' } })
  writeFileSync(join(dir, 'ria.json'), JSON.stringify({ schemaVersion: 5, tickets: hot, settings: { keep: true } }))
  writeFileSync(join(dir, 'v2.json'), JSON.stringify({ tickets: { t1: { ticketId: 't1', phase: 'advisor' } }, reports: ['json'] }))
  writeFileSync(join(dir, 'tickets.log.jsonl'), JSON.stringify({ ticket: archived, closedAt: 200 }) + '\n')
  return { hot, archived }
}

const root = mkdtempSync(join(tmpdir(), 'ria-sqlite-migrate-'))
try {
  {
    const dir = makeDir('happy')
    seed(dir)
    const before = readFileSync(join(dir, 'ria.json'), 'utf8')
    const result = migrateTickets({ stateDir: dir, now: 1_800_000_000_000 })
    assert.equal(result.ok, true)
    assert.equal(result.mode, 'created')
    assert.deepEqual(result.counts, { tickets: 4, history: 4, hot: 3, archived: 1, meta: 1 })
    assert.equal(result.countsMatch, true)
    assert.deepEqual(result.integrity, ['ok'])
    assert.equal(result.foreignKeyViolations, 0)
    assert.equal(result.sampled, 4)
    assert.ok(existsSync(join(dir, 'ria.sqlite')))
    assert.equal(readFileSync(join(dir, 'ria.json'), 'utf8'), before, 'JSON source is never rewritten')
    assert.ok(!existsSync(join(dir, 'ria.sqlite.tmp')), 'tmp DB is published away')

    const stamps = readdirSync(join(dir, 'backup'))
    assert.equal(stamps.length, 1)
    const backupDir = join(dir, 'backup', stamps[0])
    const manifest = JSON.parse(readFileSync(join(backupDir, 'manifest.json'), 'utf8'))
    assert.equal(manifest.importId, result.importId)
    assert.equal(manifest.sourceSha256, result.sourceSha256)
    assert.deepEqual(manifest.files.map(file => file.name).sort(), ['ria.json', 'tickets.log.jsonl', 'v2.json'])
    assert.ok(manifest.files.every(file => /^[0-9a-f]{64}$/.test(file.sha256)))
    assert.equal(readFileSync(join(backupDir, 'ria.json'), 'utf8'), before, 'backup holds the exact source bytes')

    // Re-running the same source is a verified no-op, not a second import.
    const again = migrateTickets({ stateDir: dir, now: 1_800_000_001_000 })
    assert.equal(again.mode, 'idempotent-reuse')
    assert.deepEqual(again.counts, result.counts)
    assert.equal(again.importId, result.importId)
    assert.equal(readdirSync(join(dir, 'backup')).length, 1, 'idempotent re-run must not create a second backup')

    // --verify-only passes on the published DB and does not write anything.
    const verified = migrateTickets({ stateDir: dir, verifyOnly: true })
    assert.equal(verified.ok, true)
    assert.equal(verified.mode, 'verify-only')
    assert.equal(verified.countsMatch, true)
  }

  {
    // A new source against an existing DB refuses to overwrite without --replace.
    const dir = makeDir('conflict')
    const seeded = seed(dir)
    migrateTickets({ stateDir: dir })
    writeFileSync(join(dir, 'ria.json'), JSON.stringify({ schemaVersion: 5, tickets: [...seeded.hot, ticket('t5')] }))
    assert.throws(() => migrateTickets({ stateDir: dir }), { code: 'import_conflict' })
    const replaced = migrateTickets({ stateDir: dir, replace: true, now: 1_800_000_002_000 })
    assert.equal(replaced.mode, 'replaced')
    assert.equal(replaced.counts.tickets, 5)
    const backupDirs = readdirSync(join(dir, 'backup'))
    assert.equal(backupDirs.length, 2, 'the replaced DB gets its own backup directory')
    const manifest = JSON.parse(readFileSync(join(dir, 'backup', backupDirs.sort().at(-1), 'manifest.json'), 'utf8'))
    assert.ok(manifest.files.some(file => file.name === 'ria.sqlite'), 'the previous DB is backed up before replacement')
  }

  {
    // Corrupt source: verification fails, so the tmp DB is removed and JSON stays.
    const dir = makeDir('corrupt')
    writeFileSync(join(dir, 'ria.json'), JSON.stringify({ schemaVersion: 5, tickets: [ticket('bad', { history: 'not-an-array' })] }))
    const before = readFileSync(join(dir, 'ria.json'), 'utf8')
    assert.throws(() => migrateTickets({ stateDir: dir }), { code: 'migration_verification_failed' })
    assert.equal(existsSync(join(dir, 'ria.sqlite')), false, 'no published DB on failure')
    assert.equal(existsSync(join(dir, 'ria.sqlite.tmp')), false, 'tmp DB is cleaned up')
    assert.equal(readFileSync(join(dir, 'ria.json'), 'utf8'), before, 'JSON stays untouched')
    assert.throws(() => migrateTickets({ stateDir: dir, verifyOnly: true }), { code: 'sqlite_missing' })
  }

  {
    // Verification catches drift in a published DB instead of blessing it.
    const dir = makeDir('drift')
    seed(dir)
    migrateTickets({ stateDir: dir })
    const db = openDatabase(join(dir, 'ria.sqlite'))
    db.prepare("UPDATE tickets SET status='done' WHERE id='t2'").run()
    db.close()
    const verified = migrateTickets({ stateDir: dir, verifyOnly: true })
    assert.equal(verified.ok, false)
    assert.equal(verified.countsMatch, true, 'row counts still match')
    assert.ok(verified.sampleMismatches.length >= 1, 'deep comparison flags the drifted ticket')
  }
  {
    // --repair-meta restores JSON meta for DB rows that lost it, and is idempotent.
    const dir = makeDir('repair-meta')
    seed(dir)
    migrateTickets({ stateDir: dir })
    const db = openDatabase(join(dir, 'ria.sqlite'))
    db.prepare("UPDATE tickets SET meta=json_set(meta,'$.v2',json('null')) WHERE id='t1'").run()
    db.close()
    const repaired = repairTicketMeta({ stateDir: dir })
    assert.equal(repaired.ok, true)
    assert.equal(repaired.repaired, 1)
    assert.deepEqual(repaired.ticketIds, ['t1'])
    const again = repairTicketMeta({ stateDir: dir })
    assert.equal(again.repaired, 0, 'repair is idempotent')
    const verified = migrateTickets({ stateDir: dir, verifyOnly: true })
    assert.equal(verified.ok, true)
    assert.equal(verified.countsMatch, true)
  }

  {
    // CLI --verify-only must exit non-zero for any failed signal, zero when clean.
    const script = fileURLToPath(new URL('../scripts/sqlite-migrate.mjs', import.meta.url))
    const okDir = makeDir('exit-ok')
    seed(okDir)
    migrateTickets({ stateDir: okDir })
    const ok = spawnSync(process.execPath, [script, '--state-dir', okDir, '--verify-only'], { encoding: 'utf8' })
    assert.equal(ok.status, 0, ok.stderr)
    const badDir = makeDir('exit-bad')
    seed(badDir)
    migrateTickets({ stateDir: badDir })
    const badDb = openDatabase(join(badDir, 'ria.sqlite'))
    badDb.prepare("UPDATE tickets SET status='done' WHERE id='t2'").run()
    badDb.close()
    const bad = spawnSync(process.execPath, [script, '--state-dir', badDir, '--verify-only'], { encoding: 'utf8' })
    assert.notEqual(bad.status, 0, 'verify failure must be a non-zero exit')
    assert.match(bad.stdout, /"ok": false/)
  }

  console.log('sqlite migration verification ok')
} finally { rmSync(root, { recursive: true, force: true }) }
