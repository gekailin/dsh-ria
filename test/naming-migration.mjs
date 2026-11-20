import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { migrateLegacyState, restoreLegacyNaming } from '../lib/state/naming-migration.mjs'

const root = mkdtempSync(join(tmpdir(), 'ria-naming-migration-'))
try {
  const stateDir = join(root, 'state')
  mkdirSync(stateDir, { recursive: true })
  writeFileSync(join(stateDir, 'v2.json'), JSON.stringify({ advisors: { global: { sessionId: 'old' } } }, null, 2) + '\n')
  writeFileSync(join(stateDir, 'ria.json'), JSON.stringify({ schemaVersion: 5, meta: { v2: { scope: 'global' } }, tickets: [] }, null, 2) + '\n')
  const db = new DatabaseSync(join(stateDir, 'ria.sqlite'))
  db.exec("CREATE TABLE tickets (id TEXT PRIMARY KEY, meta TEXT)")
  db.exec("CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT, updated_at INTEGER)")
  db.exec("CREATE TABLE legacy (id TEXT, v2 TEXT)")
  db.prepare('INSERT INTO tickets (id, meta) VALUES (?, ?)').run('t1', JSON.stringify({ ticket: { ticketId: 't1' }, v2: { scope: 'global' } }))
  db.prepare('INSERT INTO schema_meta (key, value, updated_at) VALUES (?, ?, ?)').run('ticket_mirror', JSON.stringify({ pendingV2: { a: 1 } }), 1)
  db.prepare('INSERT INTO legacy (id, v2) VALUES (?, ?)').run('l1', 'v')
  db.close()

  const result = migrateLegacyState({ stateDir })
  assert.equal(result.changed, true)
  assert.ok(existsSync(join(stateDir, 'state.json')))
  assert.ok(!existsSync(join(stateDir, 'v2.json')))
  assert.ok(readdirSync(stateDir).some(name => name.startsWith('v2.json.bak-')))
  assert.ok(existsSync(join(result.backupDir, 'v2.json')))
  assert.ok(existsSync(join(result.backupDir, 'manifest.json')))
  const ria = JSON.parse(readFileSync(join(stateDir, 'ria.json'), 'utf8'))
  assert.deepEqual(ria.meta.state, { scope: 'global' })
  assert.equal(ria.meta.v2, undefined)
  const check = new DatabaseSync(join(stateDir, 'ria.sqlite'))
  const envelope = JSON.parse(check.prepare('SELECT meta FROM tickets WHERE id=?').get('t1').meta)
  assert.deepEqual(envelope.state, { scope: 'global' })
  assert.equal(envelope.v2, undefined)
  const columns = check.prepare('PRAGMA table_info(legacy)').all().map(col => col.name)
  assert.ok(columns.includes('state'))
  assert.ok(!columns.includes('v2'))
  const mirror = JSON.parse(check.prepare('SELECT value FROM schema_meta WHERE key=?').get('ticket_mirror').value)
  assert.deepEqual(mirror.pendingState, { a: 1 })
  check.close()

  const again = migrateLegacyState({ stateDir })
  assert.equal(again.changed, false)

  const boot = join(root, 'boot')
  mkdirSync(boot, { recursive: true })
  writeFileSync(join(boot, 'v2.json'), JSON.stringify({ advisors: { global: { sessionId: 's' } } }))
  migrateLegacyState({ stateDir: boot })
  assert.ok(existsSync(join(boot, 'state.json')))
  assert.ok(!existsSync(join(boot, 'v2.json')))

  assert.equal(restoreLegacyNaming({ stateDir, backupDir: result.backupDir }), true)
  assert.ok(existsSync(join(stateDir, 'v2.json')))
  console.log('naming migration ok')
} finally {
  rmSync(root, { recursive: true, force: true })
}
