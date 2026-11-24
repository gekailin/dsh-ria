import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { StateStore } from '../lib/store/store.mjs'
import { CoManagement } from '../lib/roles/co-management.mjs'

const root = mkdtempSync(join(tmpdir(), 'ria-co-unified-'))
try {
  const dir = join(root, 'state')
  mkdirSync(dir, { recursive: true })
  const state = new StateStore(dir)
  state.data.executors = {
    'session-old': { sessionId: 'session-old', kind: 'co-managed', title: 'Old', cwd: '/work/old', tags: ['old'], allowAutoDispatch: false, dedicated: true, status: 'idle', currentTicketId: null },
  }
  state.save()
  const co = new CoManagement({ stateDir: dir, state, send: async () => {}, notify: () => {} })
  assert.equal(state.data.coManagement.length, 1)
  assert.equal(state.data.coManagement.find(item => item.sessionId === 'session-old').allowDispatch, false)
  assert.equal(state.data.coManagement.find(item => item.sessionId === 'session-old').dedicated, undefined)
  assert.equal(state.executor('session-old').kind, 'co-managed')
  assert.equal(co.watches().length, 1)
  assert.equal(existsSync(join(dir, 'co-management.json')), false)
  const secondState = new StateStore(dir)
  const second = new CoManagement({ stateDir: dir, state: secondState, send: async () => {}, notify: () => {} })
  assert.equal(second.watches().length, 1)
  console.log('co-management unified migration ok')
} finally { rmSync(root, { recursive: true, force: true }) }
