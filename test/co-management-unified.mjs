import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { StateStore } from '../lib/store/store.mjs'
import { CoManagement } from '../lib/roles/co-management.mjs'

const root = mkdtempSync(join(tmpdir(), 'ria-co-unified-'))
try {
  const dir = join(root, 'state'); const { mkdirSync } = await import('node:fs'); mkdirSync(dir, { recursive: true })
  const state = new StateStore(dir)
  state.data.executors = {
    'session-old': { sessionId: 'session-old', kind: 'co-managed', title: 'Old', cwd: '/work/old', tags: ['old'], allowAutoDispatch: false, dedicated: true, status: 'idle', currentTicketId: null },
  }
  state.save()
  writeFileSync(join(dir, 'co-management.json'), JSON.stringify({ version: 1, watches: [{ watchId: 'w1', sessionId: 'session-file', titleSnapshot: 'File', addedAt: 1, options: { relayReplies: false, relayQuestions: true, rateLimit: { maxPerMin: 4 } } }] }))
  const co = new CoManagement({ stateDir: dir, state, send: async () => {}, notify: () => {} })
  assert.equal(state.data.coManagement.length, 2)
  assert.equal(state.data.coManagement.find(item => item.sessionId === 'session-old').allowDispatch, false)
  assert.equal(state.data.coManagement.find(item => item.sessionId === 'session-old').dedicated, true)
  assert.equal(state.data.coManagement.find(item => item.sessionId === 'session-file').options.relayReplies, false)
  assert.equal(state.worker('session-old').kind, 'co-managed')
  assert.equal(co.watches().length, 2)
  const backupsBefore = readdirSync(dir).filter(name => name.startsWith('co-management.json.bak.')).length
  assert.equal(backupsBefore, 1)
  const secondState = new StateStore(dir)
  const second = new CoManagement({ stateDir: dir, state: secondState, send: async () => {}, notify: () => {} })
  assert.equal(second.watches().length, 2)
  assert.equal(readdirSync(dir).filter(name => name.startsWith('co-management.json.bak.')).length, backupsBefore)
  console.log('co-management unified migration ok')
} finally { rmSync(root, { recursive: true, force: true }) }
