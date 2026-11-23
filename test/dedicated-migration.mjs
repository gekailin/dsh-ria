import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { StateStore } from '../lib/store/store.mjs'

const dir = mkdtempSync(join(tmpdir(), 'ria-dedicated-migration-'))
try {
  writeFileSync(join(dir, 'state.json'), JSON.stringify({
    schemaVersion: 1,
    chatSessionId: 'session-chat',
    coManagement: [{
      watchId: 'watch_legacy', sessionId: 'session-cm', titleSnapshot: 'Legacy CM',
      cwd: '/work', tags: ['legacy'], roleNote: '', allowDispatch: true, dedicated: true,
      addedAt: 1, status: 'active',
    }],
    executors: {
      'session-managed': {
        sessionId: 'session-managed', kind: 'managed', executorType: 'work',
        status: 'idle', currentTicketId: null, dedicated: true, tags: [],
      },
      'session-false': {
        sessionId: 'session-false', kind: 'managed', executorType: 'work',
        status: 'idle', currentTicketId: null, dedicated: false, tags: [],
      },
    },
  }, null, 2))

  const first = new StateStore(dir, { eventLog: true })
  assert.equal(Object.hasOwn(first.data.executors['session-managed'], 'dedicated'), false)
  assert.equal(Object.hasOwn(first.data.executors['session-false'], 'dedicated'), false)
  assert.equal(Object.hasOwn(first.data.coManagement[0], 'dedicated'), false)
  assert.equal(first.data.executors['session-managed'].status, 'idle')

  const readEvents = () => readFileSync(join(dir, 'events.jsonl'), 'utf8')
    .split('\n').filter(Boolean).map(line => JSON.parse(line))
    .filter(event => event.kind === 'executor.dedicated.migrated')
  const once = readEvents()
  assert.equal(once.length, 1, 'one migration event for the whole scan')
  assert.deepEqual(once[0].payload.sessions, ['session-cm', 'session-managed'])
  assert.deepEqual(once[0].payload.sources.executors, ['session-managed'])
  assert.deepEqual(once[0].payload.sources.coManagement, ['session-cm'])

  // A second load sees no dedicated field and must not append another event.
  const second = new StateStore(dir, { eventLog: true })
  assert.equal(readEvents().length, 1, 'migration is idempotent across loads')
  assert.equal(Object.hasOwn(second.data.executors['session-managed'], 'dedicated'), false)
  assert.equal(Object.hasOwn(second.data.coManagement[0], 'dedicated'), false)
  console.log('dedicated migration ok')
} finally {
  rmSync(dir, { recursive: true, force: true })
}
