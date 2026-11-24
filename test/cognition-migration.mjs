import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { openDatabase } from '../lib/state/sqlite/db.mjs'

const root = mkdtempSync(join(tmpdir(), 'ria-cognition-mig-'))
const script = new URL('../scripts/migrate-cognition.mjs', import.meta.url).pathname
const run = (...args) => {
  const result = spawnSync(process.execPath, [script, '--state-dir', root, ...args], { encoding: 'utf8' })
  let body
  try { body = JSON.parse(result.stdout) } catch { body = { stdout: result.stdout, stderr: result.stderr } }
  assert.equal(result.status, 0, result.stderr || result.stdout)
  return body
}
const dbCounts = () => {
  const db = openDatabase(join(root, 'ria.sqlite'), { readOnly: true })
  try {
    return {
      entries: db.prepare('SELECT COUNT(*) n FROM cognition_entries').get().n,
      proposals: db.prepare('SELECT COUNT(*) n FROM cognition_proposals').get().n,
      receipts: db.prepare('SELECT COUNT(*) n FROM cognition_receipts').get().n,
    }
  } finally { db.close() }
}

try {
  mkdirSync(join(root, 'cognition', 'chat'), { recursive: true })
  mkdirSync(join(root, 'cognition', 'projects'), { recursive: true })
  mkdirSync(join(root, 'cognition', 'proposals'), { recursive: true })
  const sections = ['# Preferences']
  for (let index = 1; index <= 12; index += 1) sections.push('## 2026-11-23 preference ' + index + '\n原因：cause ' + index + '\npreference body ' + index)
  sections.push('## 2026-11-23 missing cause\nbody without cause')
  sections.push('## 2026-11-23 long body\n原因：long cause\n' + '长'.repeat(300))
  writeFileSync(join(root, 'cognition', 'chat', 'preferences.md'), sections.join('\n\n') + '\n')
  writeFileSync(join(root, 'cognition', 'chat', 'todos.md'), '- todos body without cause\n')
  writeFileSync(join(root, 'cognition', 'projects', 'p1.md'), '# Project\n\n## 2026-11-23 project experience\n原因：project cause\nproject body\n')
  for (let index = 1; index <= 315; index += 1) {
    const status = index === 1 ? 'denied' : index <= 3 ? 'accepted' : index <= 5 ? 'rejected' : index <= 7 ? 'deferred' : index <= 9 ? 'merged' : 'pending'
    writeFileSync(join(root, 'cognition', 'proposals', 'p_' + index + '.json'), JSON.stringify({
      id: 'prop_' + index, author: 'executor', source: 'test', text: 'proposal body ' + index,
      status, ...(status === 'merged' ? { targetEntryId: 'cog_target' } : {}), ...(status === 'accepted' ? { decidedBy: 'sage', decidedAt: 100 + index, rationale: 'ok' } : {}),
      createdAt: 1000 + index,
    }) + '\n')
  }
  const settingsPath = join(root, 'ria.json')
  writeFileSync(settingsPath, JSON.stringify({ settings: { cognition: { backend: 'file' } } }) + '\n')
  const db = openDatabase(join(root, 'ria.sqlite'), { create: true })
  // Simulate the Phase-1 schema (cause NOT NULL, no recorded/truncated) so the
  // migration's table rebuild is exercised.
  db.exec('DROP TABLE cognition_entries')
  db.exec(`CREATE TABLE cognition_entries (
    seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, scope TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'experience', status TEXT NOT NULL DEFAULT 'active',
    tags TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(tags)), body TEXT NOT NULL,
    cause TEXT NOT NULL, sources TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(sources)),
    superseded_by TEXT, dispute_reason TEXT, created_by TEXT NOT NULL DEFAULT 'sage',
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, verified_at INTEGER
  )`)
  db.exec('CREATE INDEX idx_cog_entries_scope_status ON cognition_entries(scope, status)')
  db.exec('CREATE INDEX idx_cog_entries_status_updated ON cognition_entries(status, updated_at)')
  db.close()
  const before = dbCounts()
  assert.deepEqual(before, { entries: 0, proposals: 0, receipts: 0 })
  const backupsBefore = readdirSync(root).filter(name => name.startsWith('cognition.bak-'))
  assert.equal(backupsBefore.length, 0)

  // Default is dry-run: no DB writes and no backup.
  const dry = run()
  assert.equal(dry.mode, 'dry-run')
  assert.equal(dry.strict, false)
  assert.equal(dry.counts.plannedProposals, 315)
  assert.ok(dry.counts.plannedEntries >= 16)
  assert.ok(dry.counts.imported + dry.counts.imported_partial >= 0.9 * (dry.counts.plannedEntries + dry.counts.entry_skipped), 'lenient coverage >=90%')
  assert.ok(dry.counts.imported_partial >= 1)
  assert.ok(dry.counts.truncated >= 1)
  assert.ok(dry.skipped.every(item => item.kind !== 'entry' || item.reason === 'body_empty'), 'only truly unimportable entries skipped')
  assert.deepEqual(dbCounts(), before)
  assert.equal(readdirSync(root).filter(name => name.startsWith('cognition.bak-')).length, 0)

  // Strict mode preserves the old four-elements/body-length behavior.
  const strict = run('--strict')
  assert.equal(strict.strict, true)
  assert.ok(strict.counts.imported < dry.counts.imported)
  assert.ok(strict.counts.skipped > 0)
  assert.equal(strict.counts.truncated, 0)
  assert.ok(strict.skipped.some(item => item.missing?.includes('cause')))
  assert.ok(strict.skipped.some(item => item.reason === 'body_too_long'))

  // Apply: backup, counts, partial/truncated persistence, no receipts, backend unchanged.
  const applied = run('--apply')
  assert.equal(applied.ok, true, JSON.stringify(applied.sampling))
  assert.equal(applied.counts.proposals, 315)
  assert.ok(applied.counts.entries >= 16)
  assert.equal(applied.counts.receiptsBefore, 0)
  assert.equal(applied.counts.receiptsAfter, 0)
  assert.equal(applied.backendBefore, 'file')
  assert.equal(applied.backendAfter, 'file')
  assert.ok(applied.backup && existsSync(applied.backup))
  assert.ok(existsSync(join(applied.backup, 'cognition')))
  assert.ok(existsSync(join(applied.backup, 'ria.sqlite')))
  assert.ok(applied.skipped.every(item => item.kind !== 'entry' || item.reason === 'body_empty'))
  assert.equal(applied.sampling.diffs.length, 0)
  const dbRows = openDatabase(join(root, 'ria.sqlite'), { readOnly: true })
  try {
    const partial = dbRows.prepare("SELECT cause,recorded,truncated FROM cognition_entries WHERE body LIKE '%todos body without cause%'").get()
    assert.equal(partial.cause, null)
    assert.equal(partial.recorded, 'partial')
    const truncated = dbRows.prepare("SELECT body,truncated FROM cognition_entries WHERE truncated=1").get()
    assert.ok(truncated && [...truncated.body].length <= 250)
    assert.equal(truncated.truncated, 1)
    const fallback = dbRows.prepare("SELECT sources FROM cognition_entries WHERE body LIKE '%todos body without cause%'").get()
    const fallbackSources = JSON.parse(fallback.sources)
    assert.ok(fallbackSources.some(source => source.type === 'file' && /chat\/todos\.md:\d+/.test(source.ref) && Number.isFinite(source.at)))
  } finally { dbRows.close() }
  const after = dbCounts()
  assert.equal(after.entries, applied.counts.entries)
  assert.equal(after.proposals, 315)
  assert.equal(after.receipts, 0)
  assert.equal(dbCounts().entries, after.entries, 'dry-run applied count stable')
  assert.equal(JSON.parse(readFileSync(settingsPath, 'utf8')).settings.cognition.backend, 'file')

  // Second apply is idempotent: no new rows, same counts/content.
  const second = run('--apply')
  assert.equal(second.ok, true)
  assert.equal(second.counts.imported, 0)
  assert.equal(second.counts.existing, applied.counts.entries + 315)
  assert.deepEqual(dbCounts(), after)
  const db2 = openDatabase(join(root, 'ria.sqlite'), { readOnly: true })
  try {
    assert.equal(db2.prepare('SELECT COUNT(DISTINCT id) n FROM cognition_entries').get().n, after.entries)
    assert.equal(db2.prepare('SELECT COUNT(DISTINCT id) n FROM cognition_proposals').get().n, after.proposals)
  } finally { db2.close() }

  // Rollback restores cognition/ and removes only this migration's rows.
  const rolled = run('--rollback')
  assert.equal(rolled.ok, true)
  assert.ok(rolled.deletedEntries >= 16)
  assert.equal(rolled.deletedProposals, 315)
  assert.deepEqual(dbCounts(), before)
  assert.equal(readFileSync(join(root, 'cognition', 'chat', 'preferences.md'), 'utf8').includes('preference body 1'), true)
  assert.equal(JSON.parse(readFileSync(settingsPath, 'utf8')).settings.cognition.backend, 'file')
  console.log('cognition migration ok')
} finally { rmSync(root, { recursive: true, force: true }) }
