import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RiaStore } from '../lib/index.js'
import { openDatabase } from '../lib/state/sqlite/db.mjs'
import { writeMirrorSnapshot } from '../lib/state/sqlite/mirror.mjs'
import { SqliteTicketRuntime } from '../lib/state/sqlite/runtime.mjs'

const dir = mkdtempSync(join(tmpdir(), 'ria-no-write-'))
const riaPath = join(dir, 'ria.json')
const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex')
try {
  writeFileSync(riaPath, JSON.stringify({ schemaVersion: 5, version: 5, storage: 'sqlite',
    tickets: [], topics: [], links: [], settings: { blockDirectUserMessages: true } }))
  writeFileSync(join(dir, 'state.json'), JSON.stringify({ workers: {}, meta: {} }))
  const db = openDatabase(join(dir, 'ria.sqlite'), { create: true })
  db.close()
  const runtime = new SqliteTicketRuntime({ stateDir: dir,
    exportMirror: (snapshot, guard) => writeMirrorSnapshot({ stateDir: dir, snapshot, ...guard }) })
  const store = new RiaStore(dir, { runtime })
  const before = { hash: hash(riaPath), mtime: statSync(riaPath).mtimeMs }
  store.addTicket({ goal: 'phase A no write' })
  assert.equal(runtime.flush(), true)
  const after = { hash: hash(riaPath), mtime: statSync(riaPath).mtimeMs }
  assert.equal(after.hash, before.hash, 'ticket write does not change ria.json')
  assert.equal(after.mtime, before.mtime, 'ticket write does not touch ria.json mtime')
  const state = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'))
  assert.ok(state.settings, 'state.json contains control fields')
  await runtime.close()
  console.log('ria.json stays read-only for ticket writes')
} finally { rmSync(dir, { recursive: true, force: true }) }