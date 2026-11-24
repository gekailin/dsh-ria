import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../lib/state/sqlite/db.mjs'
import { CognitionStore } from '../lib/roles/cognition.mjs'
import { StateStore } from '../lib/store/store.mjs'

const root = mkdtempSync(join(tmpdir(), 'ria-data-phase1-'))
try {
  const dbPath = join(root, 'ria.sqlite')
  let db = openDatabase(dbPath, { create: true })
  db.exec('ALTER TABLE cognition_entries ADD COLUMN recorded TEXT')
  db.exec('ALTER TABLE cognition_entries ADD COLUMN truncated INTEGER NOT NULL DEFAULT 0')
  db.exec("ALTER TABLE cognition_proposals ADD COLUMN evidence_refs TEXT NOT NULL DEFAULT '[]'")
  db.exec("ALTER TABLE cognition_proposals ADD COLUMN affected_entries TEXT NOT NULL DEFAULT '[]'")
  db.prepare("INSERT INTO cognition_entries(seq,id,scope,kind,status,tags,body,cause,recorded,truncated,sources,created_by,created_at,updated_at) VALUES(NULL,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run('cog_1', 'global', 'experience', 'active', '[]', 'body', 'cause', 'legacy', 0, '[{"type":"file","ref":"a.mjs"}]', 'sage', 1, 1)
  db.prepare("INSERT INTO cognition_proposals(id,author,source,kind,scope,target_entry_id,body,cause,sources,priority,status,decided_by,decided_at,rationale,evidence_refs,affected_entries,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run('prop_1', 'sage', 'test', 'correct', 'global', 'cog_1', 'body', '', '[{"type":"file","ref":"a.mjs"},{"type":"ticket","ref":"t1"}]', 'normal', 'merged', 'sage', 2, 'ok', '[]', '[]', 1)
  db.prepare('DELETE FROM schema_migrations WHERE version=3').run()
  db.close()

  db = openDatabase(dbPath)
  const entryColumns = db.prepare('PRAGMA table_info(cognition_entries)').all().map(row => row.name)
  const proposalColumns = db.prepare('PRAGMA table_info(cognition_proposals)').all().map(row => row.name)
  for (const column of ['recorded', 'truncated']) assert.equal(entryColumns.includes(column), false, 'cognition_entries.' + column + ' must be dropped')
  for (const column of ['evidence_refs', 'affected_entries']) assert.equal(proposalColumns.includes(column), false, 'cognition_proposals.' + column + ' must be dropped')
  assert.ok(db.prepare('SELECT COUNT(*) n FROM cognition_entries').get().n === 1)
  assert.ok(db.prepare('SELECT COUNT(*) n FROM cognition_proposals').get().n === 1)
  db.close()

  const cognition = new CognitionStore({ stateDir: root, dbPath })
  const receipt = cognition.getReceipt('prop_1')
  assert.deepEqual(receipt.evidenceRefs, [{ type: 'file', ref: 'a.mjs' }, { type: 'ticket', ref: 't1' }])
  assert.deepEqual(receipt.affectedEntries, ['cog_1'])
  assert.equal(cognition.getEntry('cog_1').recorded, undefined)
  assert.equal(cognition.getEntry('cog_1').truncated, undefined)
  cognition.db.close()

  const stateDir = join(root, 'state')
  const statePath = join(stateDir, 'state.json')
  const { mkdirSync } = await import('node:fs')
  mkdirSync(stateDir, { recursive: true })
  writeFileSync(statePath, JSON.stringify({
    schemaVersion: 1, chatSessionId: 'chat', riaSessionId: 'old-ria',
    recentWorkers: { old: { lastUsedAt: 1 } }, eventsMigratedAt: 1, version: 5, storage: 'sqlite',
    meta: { executorSeq: 0, reflectionSeq: 0 }, settings: {},
  }))
  const state = new StateStore(stateDir, { eventLog: true })
  for (const key of ['recentWorkers', 'riaSessionId', 'eventsMigratedAt', 'version', 'storage']) {
    assert.equal(Object.hasOwn(state.data, key), false, key + ' must be removed from memory')
    assert.equal(Object.hasOwn(JSON.parse(readFileSync(statePath, 'utf8')), key), false, key + ' must be removed from state.json')
  }
  assert.equal(state.data.chatSessionId, 'chat')
  assert.equal(state.data.schemaVersion, 1)
  const second = new StateStore(stateDir, { eventLog: true })
  assert.equal(second.data.chatSessionId, 'chat')
  const events = readFileSync(join(stateDir, 'events.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line)).filter(event => event.kind === 'state.legacy_keys.removed')
  assert.equal(events.length, 1, 'legacy removal event is emitted once')
  assert.deepEqual(events[0].payload.keys, ['recentWorkers', 'riaSessionId', 'eventsMigratedAt', 'version', 'storage'])
  console.log('data structure phase 1 ok')
} finally {
  rmSync(root, { recursive: true, force: true })
}
