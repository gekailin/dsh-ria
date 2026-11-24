import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { StateStore } from '../lib/store/store.mjs'
import { CoManagement } from '../lib/roles/co-management.mjs'

const root = mkdtempSync(join(tmpdir(), 'ria-co-management-state-'))
try {
  const dir = join(root, 'state')
  mkdirSync(dir, { recursive: true })

  const state = new StateStore(dir)
  const first = new CoManagement({ stateDir: dir, state, send: async () => {}, notify: () => {} })
  first.add({ sessionId: 'session-one', title: 'One' })
  first.add({ sessionId: 'session-two', title: 'Two' })
  assert.equal(Array.isArray(state.data.coManagement), true)
  assert.equal(state.data.coManagement.length, 2)
  assert.equal(existsSync(join(dir, 'co-management.json')), false, 'co-management.json is never created')

  // Reloading from state.json restores watches identically.
  const state2 = new StateStore(dir)
  const second = new CoManagement({ stateDir: dir, state: state2, send: async () => {}, notify: () => {} })
  assert.equal(second.watches().length, 2)
  assert.equal(second.watches()[0].sessionId, 'session-one')

  // Empty state is harmless.
  const missing = join(root, 'missing')
  mkdirSync(missing, { recursive: true })
  const missingState = new StateStore(missing)
  const third = new CoManagement({ stateDir: missing, state: missingState, send: async () => {}, notify: () => {} })
  assert.equal(third.watches().length, 0)
  console.log('co-management state ok')
} finally { rmSync(root, { recursive: true, force: true }) }
