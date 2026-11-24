import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CognitionStore } from '../lib/roles/cognition.mjs'
import { openDatabase } from '../lib/state/sqlite/db.mjs'
import { SCHEMA_SQL } from '../lib/state/sqlite/schema.mjs'

const root = mkdtempSync(join(tmpdir(), 'ria-principles-'))
try {
  const stateDir = join(root, 'state')
  mkdirSync(join(stateDir, 'cognition'), { recursive: true })
  const db = openDatabase(join(stateDir, 'test.sqlite'), { create: true })
  db.exec(SCHEMA_SQL)
  db.prepare('INSERT INTO cognition_entries(id,scope,kind,status,tags,body,cause,sources,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run('cog_1', 'principle', 'preference', 'active', '[]', '中文原则：先给结论再展开', 'test', '[]', 'sage', 1, 1)
  db.close()
  const store = new CognitionStore({ stateDir, dbPath: join(stateDir, 'test.sqlite') })
  const calls = []
  const original = store.searchEntries.bind(store)
  store.searchEntries = args => { calls.push({ ...args }); return original(args) }
  const result = store.retrieve({ workspace: root, goal: 'anything' })
  assert.ok(result.snapshot.includes('中文原则：先给结论再展开'))
  assert.equal(calls.some(item => Array.isArray(item.scopes) && item.scopes.length === 1 && item.scopes[0] === 'principle' && 'text' in item), false)

  const emptyDir = join(root, 'empty')
  mkdirSync(emptyDir, { recursive: true })
  const emptyDb = openDatabase(join(emptyDir, 'test.sqlite'), { create: true })
  emptyDb.exec(SCHEMA_SQL); emptyDb.close()
  const empty = new CognitionStore({ stateDir: emptyDir, dbPath: join(emptyDir, 'test.sqlite') }).retrieve({ workspace: root, goal: 'x' })
  assert.equal(empty.snapshot, '')
  console.log('cognition principles ok')
} finally { rmSync(root, { recursive: true, force: true }) }