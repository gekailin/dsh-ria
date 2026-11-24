import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RiaStore } from '../lib/index.js'
import { StateStore } from '../lib/store/store.mjs'
import { openDatabase } from '../lib/state/sqlite/db.mjs'
import { createFixture } from './support/ria-fixture.mjs'

const root = mkdtempSync(join(tmpdir(), 'ria-storage-startup-'))
try {
  mkdirSync(join(root, 'state'), { recursive: true })
  const stateDir = join(root, 'state')
  const chat = 'session-chat-startup'
  writeFileSync(join(stateDir, 'state.json'), JSON.stringify({
    schemaVersion: 1,
    chatSessionId: chat,
    riaSessionId: 'legacy-ria',
    recentWorkers: { old: { lastUsedAt: 1 } },
    eventsMigratedAt: 1,
    version: 5,
    storage: 'sqlite',
    tickets: { legacy: { ticketId: 'legacy', phase: 'advisor' } },
    ticketMirror: { stale: true },
    meta: { executorSeq: 0, reflectionSeq: 0 },
  }))
  const rawBefore = readFileSync(join(stateDir, 'state.json'), 'utf8')
  const state = new StateStore(stateDir, { sqlite: true })
  assert.equal(state.pendingSave, true, 'SQLite state load must defer saving until the runtime is attached')
  assert.equal(readFileSync(join(stateDir, 'state.json'), 'utf8'), rawBefore, 'StateStore.load must not write state.json before attach')
  for (const key of ['recentWorkers', 'riaSessionId', 'eventsMigratedAt', 'version', 'storage']) assert.equal(Object.hasOwn(state.data, key), false, key + ' must be removed in memory')
  assert.equal(state.data.chatSessionId, chat)
  assert.equal(state.data.schemaVersion, 1)
  const output = state.controlOutput()
  assert.equal(Object.hasOwn(output, 'tickets'), false)
  assert.equal(Object.hasOwn(output, 'ticketMirror'), false)

  const store = new RiaStore(stateDir)
  assert.equal(store.riaSessionId, chat, 'RiaStore derives riaSessionId from state.chatSessionId')
  assert.equal(store.chatSessionId, chat)

  const db = openDatabase(join(stateDir, 'ria.sqlite'), { create: true })
  db.close()
  const noStorageDir = join(root, 'no-storage')
  mkdirSync(noStorageDir, { recursive: true })
  writeFileSync(join(noStorageDir, 'state.json'), JSON.stringify({ schemaVersion: 1, chatSessionId: chat, meta: { executorSeq: 0, reflectionSeq: 0 } }))
  const noStorageDb = openDatabase(join(noStorageDir, 'ria.sqlite'), { create: true })
  noStorageDb.close()
  const fixture = await createFixture({ stateDir: noStorageDir, stateDefault: true })
  try {
    assert.ok(fixture.service.runtime, 'a service without a storage key still opens SQLite')
    assert.equal(fixture.service.store.riaSessionId, fixture.service.controller.state.chatSessionId)
  } finally { fixture.cleanup() }
  console.log('storage startup invariants ok')
} finally { rmSync(root, { recursive: true, force: true }) }
