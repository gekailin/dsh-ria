import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { StateStore } from '../lib/store/store.mjs'
import { CoManagement } from '../lib/roles/co-management.mjs'

const root = mkdtempSync(join(tmpdir(), 'ria-co-management-state-'))
try {
  const dir = join(root, 'state'); writeFileSync(dir + '.tmp', '')
  const { mkdirSync } = await import('node:fs'); mkdirSync(dir, { recursive: true })
  const file = join(dir, 'co-management.json')
  const payload = { version: 1, watches: [{ sessionId: 'session-one', titleSnapshot: 'One', addedAt: 1, options: {} }] }
  writeFileSync(file, JSON.stringify(payload, null, 2) + '\n')
  const before = { mtime: (await import('node:fs')).statSync(file).mtimeMs, sha: createHash('sha256').update(readFileSync(file)).digest('hex') }

  const state = new StateStore(dir)
  const first = new CoManagement({ stateDir: dir, state, send: async () => {}, notify: () => {} })
  assert.equal(first.watches().length, 1)
  assert.equal(Array.isArray(state.data.coManagement), true)
  assert.equal(state.data.coManagement[0].sessionId, 'session-one')
  assert.equal(readdirSync(dir).filter(name => name.startsWith('co-management.json.bak.')).length, 1)
  assert.equal(createHash('sha256').update(readFileSync(file)).digest('hex'), before.sha)
  first.add({ sessionId: 'session-two', title: 'Two' })
  assert.equal((await import('node:fs')).statSync(file).mtimeMs, before.mtime)
  assert.equal(createHash('sha256').update(readFileSync(file)).digest('hex'), before.sha)
  assert.equal(state.data.coManagement.length, 2)

  // Second start is idempotent: state key wins, no new backup.
  const state2 = new StateStore(dir)
  const second = new CoManagement({ stateDir: dir, state: state2, send: async () => {}, notify: () => {} })
  assert.equal(second.watches().length, 2)
  assert.equal(readdirSync(dir).filter(name => name.startsWith('co-management.json.bak.')).length, 1)

  // Existing empty key also wins over the file; missing file is harmless.
  const existing = new StateStore(dir)
  existing.data.coManagement = []
  existing.save()
  const third = new CoManagement({ stateDir: dir, state: existing, send: async () => {}, notify: () => {} })
  assert.equal(third.watches().length, 0)
  const missing = join(root, 'missing'); mkdirSync(missing, { recursive: true })
  const missingState = new StateStore(missing)
  const fourth = new CoManagement({ stateDir: missing, state: missingState, send: async () => {}, notify: () => {} })
  assert.equal(fourth.watches().length, 0)
  console.log('co-management state ok')
} finally { rmSync(root, { recursive: true, force: true }) }
