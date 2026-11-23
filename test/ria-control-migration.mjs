import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { migrateRiaControl } from '../lib/state/control-migration.mjs'
import { RiaStore } from '../lib/index.js'

const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex')
const dir = mkdtempSync(join(tmpdir(), 'ria-control-migration-'))
try {
  const ria = {
    schemaVersion: 5, version: 9, riaSessionId: 'ria-old', riaPreset: 'ptc', createdAt: 10,
    lastHumanMessageAt: 11, storage: 'json', tickets: [{ ticketId: 't1', status: 'open', goal: 'g' }],
    topics: [], links: [], settings: { blockDirectUserMessages: true }, grants: [{ grantId: 'g1' }],
    recentExecutors: { w1: { sessionId: 'w1' } }, ticketFeedback: [{ feedbackId: 'f1', kind: 'x' }],
  }
  writeFileSync(join(dir, 'ria.json'), JSON.stringify(ria))
  writeFileSync(join(dir, 'state.json'), JSON.stringify({ executors: {}, meta: { executorSeq: 0, reflectionSeq: 0 } }))
  const riaHash = hash(join(dir, 'ria.json'))
  const first = migrateRiaControl({ stateDir: dir, now: 1_800_000_000_000 })
  assert.equal(first.mode, 'migrated')
  assert.ok(first.moved.includes('settings'))
  assert.ok(existsSync(first.backup))
  const state = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'))
  for (const key of ['settings', 'grants', 'recentExecutors', 'ticketFeedback', 'riaSessionId', 'riaPreset', 'version', 'createdAt', 'lastHumanMessageAt', 'storage']) {
    assert.ok(Object.hasOwn(state, key), 'state.json has ' + key)
  }
  assert.equal(hash(join(dir, 'ria.json')), riaHash, 'migration never rewrites ria.json')
  const stateHash = hash(join(dir, 'state.json'))
  const second = migrateRiaControl({ stateDir: dir, now: 1_800_000_001_000 })
  assert.equal(second.mode, 'noop')
  assert.equal(hash(join(dir, 'state.json')), stateHash, 'second migration is a no-op')

  writeFileSync(join(dir, 'state.json'), JSON.stringify({ ...state, settings: { blockDirectUserMessages: false } }))
  const store = new RiaStore(dir)
  assert.equal(store.settings().blockDirectUserMessages, false, 'control reads prefer state.json')
  assert.equal(store.data.tickets.length, 1, 'ticket compatibility copy still loads')
  console.log('ria control migration ok')
} finally { rmSync(dir, { recursive: true, force: true }) }