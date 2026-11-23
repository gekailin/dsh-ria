import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { verifySqliteState } from '../scripts/sqlite-verify.mjs'
import { openDatabase } from '../lib/state/sqlite/db.mjs'
import { seedSqliteFromState } from './support/sqlite-seed.mjs'

const script = fileURLToPath(new URL('../scripts/sqlite-verify.mjs', import.meta.url))
const sha = file => createHash('sha256').update(readFileSync(file)).digest('hex')
const ticket = (id, extra = {}) => ({
  ticketId: id, status: 'open', waitingOn: 'ria', executor: 'advisor', goal: 'goal ' + id,
  acceptance: 'accept', revision: 1, createdAt: 100, updatedAt: 100, closedAt: null,
  attempt: { legacy: true }, failure: null, resolution: null,
  history: [{ at: 100, actor: 'router', from: 'intake', to: 'open', reason: 'route' }],
  ...extra,
})
const rule = (result, name) => result.selfConsistency.checks.find(check => check.name === name)

const root = mkdtempSync(join(tmpdir(), 'ria-sqlite-verify-'))
try {
  const dir = join(root, 'state')
  mkdirSync(dir, { recursive: true })
  const hot = [ticket('t1'), ticket('t2', { status: 'working', waitingOn: 'executor' })]
  const archived = ticket('t3', { status: 'done', closedAt: 200, resolution: { summary: 'done' } })
  writeFileSync(join(dir, 'ria.json'), JSON.stringify({ schemaVersion: 5, tickets: hot, settings: { keep: true } }))
  writeFileSync(join(dir, 'state.json'), JSON.stringify({ tickets: { t1: { ticketId: 't1', phase: 'advisor' } } }))
  writeFileSync(join(dir, 'tickets.log.jsonl'), JSON.stringify({ ticket: archived, closedAt: 200 }) + '\n')
  seedSqliteFromState({ stateDir: dir })
  const dbPath = join(dir, 'ria.sqlite')
  const dbBefore = sha(dbPath)

  // T1: self-consistent DB => ok, exit 0.
  const verified = verifySqliteState({ stateDir: dir })
  assert.equal(verified.ok, true)
  assert.equal(verified.selfConsistency.ok, true)
  assert.deepEqual(verified.counts, { tickets: 3, history: 3, hot: 2, archived: 1, meta: 0 })
  assert.equal(rule(verified, 'R1_hot_plus_archived_eq_total').ok, true)
  assert.equal(rule(verified, 'R2_meta_state_subtree_le_hot').ok, true)
  assert.equal(rule(verified, 'R3b_history_count_ge_ticket_count').ok, true)
  assert.equal(rule(verified, 'R4b_archived_topic_no_hot_primary').ok, true)
  assert.equal(rule(verified, 'R5_lessons_status').ok, true)
  assert.equal(sha(dbPath), dbBefore, 'verification is read-only')
  const cli = spawnSync(process.execPath, [script, '--state-dir', dir, '--verify-only'], { encoding: 'utf8' })
  assert.equal(cli.status, 0, cli.stderr)
  assert.equal(JSON.parse(cli.stdout).ok, true)

  // T2: archived sentinel 0 makes hot+archived != total => R1 issue, exit 1.
  {
    const db = openDatabase(dbPath)
    db.prepare('UPDATE tickets SET archived_at=0 WHERE id=?').run('t3')
    db.close()
  }
  const broken = verifySqliteState({ stateDir: dir })
  assert.equal(broken.ok, false)
  assert.equal(rule(broken, 'R1_hot_plus_archived_eq_total').ok, false)
  assert.ok(broken.issues.some(issue => issue.includes('R1_hot_plus_archived_eq_total')))
  const brokenCli = spawnSync(process.execPath, [script, '--state-dir', dir], { encoding: 'utf8' })
  assert.equal(brokenCli.status, 1)
  assert.equal(JSON.parse(brokenCli.stdout).ok, false)
  {
    const db = openDatabase(dbPath)
    db.prepare('UPDATE tickets SET archived_at=200 WHERE id=?').run('t3')
    db.close()
  }

  // T3: archived topic + primary link on a hot ticket => R4b issue, exit 1.
  {
    const db = openDatabase(dbPath)
    db.prepare("INSERT INTO topics(id,title,project_key,tags,brief,archived_at,merged_into,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)")
      .run('topic_archive', 'Archived', null, '[]', '', 123, null, 1, 1)
    db.prepare('INSERT INTO topic_links(topic_id,ticket_id,role,created_at) VALUES(?,?,?,?)').run('topic_archive', 't1', 'primary', 1)
    db.close()
  }
  const badTopic = verifySqliteState({ stateDir: dir })
  assert.equal(badTopic.ok, false)
  assert.equal(rule(badTopic, 'R4b_archived_topic_no_hot_primary').ok, false)
  assert.ok(badTopic.issues.some(issue => issue.includes('R4b_archived_topic_no_hot_primary')))
  const badTopicCli = spawnSync(process.execPath, [script, '--state-dir', dir], { encoding: 'utf8' })
  assert.equal(badTopicCli.status, 1)
  {
    const db = openDatabase(dbPath)
    db.prepare("DELETE FROM topic_links WHERE topic_id='topic_archive'").run()
    db.prepare("DELETE FROM topics WHERE id='topic_archive'").run()
    db.close()
  }

  // T4: legacy ria.json mismatch but DB self-consistent => still ok, exit 0.
  writeFileSync(join(dir, 'ria.json'), JSON.stringify({ schemaVersion: 5, tickets: [hot[0]], settings: { keep: true } }))
  const stale = verifySqliteState({ stateDir: dir })
  assert.equal(stale.ok, true)
  assert.equal(stale.legacyComparison.informational, true)
  assert.equal(stale.legacyComparison.matched, false)
  const staleCli = spawnSync(process.execPath, [script, '--state-dir', dir], { encoding: 'utf8' })
  assert.equal(staleCli.status, 0, staleCli.stderr)
  assert.equal(JSON.parse(staleCli.stdout).ok, true)

  // Missing DB: clear error code, non-zero CLI exit.
  const empty = join(root, 'empty')
  mkdirSync(empty, { recursive: true })
  writeFileSync(join(empty, 'ria.json'), JSON.stringify({ schemaVersion: 5, tickets: [] }))
  assert.throws(() => verifySqliteState({ stateDir: empty }), { code: 'sqlite_missing' })
  const missing = spawnSync(process.execPath, [script, '--state-dir', empty], { encoding: 'utf8' })
  assert.equal(missing.status, 1)
  assert.equal(JSON.parse(missing.stderr).code, 'sqlite_missing')

  console.log('sqlite verify self-consistency ok')
} finally { rmSync(root, { recursive: true, force: true }) }