import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { StateStore } from '../lib/store/store.mjs'
import {
  defaultBackupRoot,
  migrateEventsText,
  migrateStateText,
  migrateWorkerToExecutor,
} from '../lib/state/migrations/worker-to-executor.mjs'

const root = mkdtempSync(join(tmpdir(), 'ria-worker-executor-migration-'))
const dir = join(root, 'state')
const backupRoot = join(root, 'backups')
const stateFile = join(dir, 'state.json')
const eventsFile = join(dir, 'events.jsonl')

const legacyState = {
  schemaVersion: 1,
  chatSessionId: 'session-chat',
  sageSessionId: null,
  workers: {
    'session-old': {
      sessionId: 'session-old', kind: 'managed', workerType: 'work',
      workerLabel: 'Ria Worker 1', status: 'idle', currentTicketId: null,
    },
  },
  tickets: {
    t1: { ticketId: 't1', workerId: 'session-old', workerSeq: 1, phase: 'working' },
  },
  reports: [{ reportId: 'r1', ticketId: 't1', workerId: 'session-old', summary: 'legacy report' }],
  inbox: [{ id: 'i1', ticketId: 't1', workerId: 'session-old', message: 'legacy inbox' }],
  requests: {},
  workOrders: {},
  lessonCandidates: [],
  meta: { workerSeq: 2, reflectionSeq: 0 },
  lastError: null,
}

const legacyEvents = [
  JSON.stringify({ at: 1, kind: 'worker.state.changed', ticketId: null, payload: { workerId: 'session-old', workerType: 'work' } }),
  '{not valid json',
  '',
  JSON.stringify({ at: 2, kind: 'report.created', ticketId: 't1', payload: { reportId: 'r2', ticketId: 't1', workerId: 'session-old', summary: 'event report' } }),
  '',
].join('\n')

try {
  mkdirSync(dir, { recursive: true })
  writeFileSync(stateFile, JSON.stringify(legacyState, null, 2) + '\n')
  writeFileSync(eventsFile, legacyEvents)

  // Old files are readable before migration: old keys map to executor names.
  const warnings = []
  const store = new StateStore(dir, { onWarn: message => warnings.push(message) })
  assert.equal(store.data.executors['session-old'].executorType, 'work')
  assert.equal(store.data.executors['session-old'].executorLabel, 'Ria Worker 1')
  assert.equal(store.executor('session-old').executorType, 'work')
  assert.equal(store.data.meta.executorSeq, 2)
  assert.equal(store.ticketMeta('t1').executorId, 'session-old')
  assert.equal(store.ticketMeta('t1').executorSeq, 1)
  assert.equal(store.reportsFor('t1').at(-1).executorId, 'session-old')
  assert.ok(warnings.some(message => message.includes('legacy worker* keys')), JSON.stringify(warnings))

  // Dry-run: reports the change but leaves bytes and backups untouched.
  const stateBefore = readFileSync(stateFile)
  const eventsBefore = readFileSync(eventsFile)
  const dry = migrateWorkerToExecutor({ stateDir: dir, dryRun: true, backupRoot })
  assert.equal(dry.changed, true)
  assert.equal(dry.backupDir, null)
  assert.deepEqual(readFileSync(stateFile), stateBefore)
  assert.deepEqual(readFileSync(eventsFile), eventsBefore)
  assert.equal(existsSync(backupRoot), false)

  // Real migration: backup first, then atomically rewrite both files.
  const first = migrateWorkerToExecutor({ stateDir: dir, backupRoot })
  assert.equal(first.changed, true)
  assert.ok(first.state.backup && first.events.backup)
  assert.deepEqual(readFileSync(first.state.backup), stateBefore)
  assert.deepEqual(readFileSync(first.events.backup), eventsBefore)
  assert.equal(readdirSync(backupRoot).sort().join(','), 'events.jsonl,state.json')

  const migratedState = JSON.parse(readFileSync(stateFile, 'utf8'))
  assert.equal(Object.hasOwn(migratedState, 'workers'), false)
  assert.equal(migratedState.executors['session-old'].executorType, 'work')
  assert.equal(migratedState.executors['session-old'].executorLabel, 'Ria Worker 1')
  assert.equal(migratedState.tickets.t1.executorId, 'session-old')
  assert.equal(migratedState.tickets.t1.executorSeq, 1)
  assert.equal(migratedState.meta.executorSeq, 2)
  assert.equal(migratedState.reports[0].executorId, 'session-old')
  assert.equal(migratedState.inbox[0].executorId, 'session-old')

  const migratedEvents = readFileSync(eventsFile, 'utf8')
  const migratedLines = migratedEvents.split('\n')
  assert.equal(migratedLines.length, legacyEvents.split('\n').length, 'line count is preserved')
  assert.equal(migratedLines[1], '{not valid json', 'unparseable lines stay byte-identical')
  const firstRow = JSON.parse(migratedLines[0])
  assert.equal(firstRow.payload.executorId, 'session-old')
  assert.equal(firstRow.payload.executorType, 'work')
  assert.equal(Object.hasOwn(firstRow.payload, 'workerId'), false)
  const reportRow = JSON.parse(migratedLines[3])
  assert.equal(reportRow.payload.executorId, 'session-old')
  assert.equal(reportRow.kind, 'report.created', 'line order is preserved')

  // Second run is a byte-for-byte no-op and creates no new backup directory.
  const stateBytes = readFileSync(stateFile)
  const eventBytes = readFileSync(eventsFile)
  const second = migrateWorkerToExecutor({ stateDir: dir, backupRoot: join(root, 'backups-second') })
  assert.equal(second.changed, false)
  assert.deepEqual(readFileSync(stateFile), stateBytes)
  assert.deepEqual(readFileSync(eventsFile), eventBytes)
  assert.equal(existsSync(join(root, 'backups-second')), false)

  // Pure transforms are idempotent and keep a stable JSON shape.
  const textOnce = migrateStateText(JSON.stringify({ workers: { a: { workerType: 'work' } } }, null, 2) + '\n')
  const textTwice = migrateStateText(textOnce.text)
  assert.equal(textTwice.changed, false)
  assert.equal(textTwice.text, textOnce.text)
  const eventsOnce = migrateEventsText('{"kind":"x","payload":{"workerId":"a"}}\n')
  const eventsTwice = migrateEventsText(eventsOnce.text)
  assert.equal(eventsTwice.changed, false)
  assert.equal(eventsTwice.text, eventsOnce.text)

  assert.match(defaultBackupRoot(0), /backups[\\/]\d{8}-\d{6}$/)

  // Event-log rebuild also maps legacy payload keys for unmigrated histories.
  const eventsDir = join(root, 'events-only')
  mkdirSync(eventsDir, { recursive: true })
  writeFileSync(join(eventsDir, 'state.json'), JSON.stringify({ meta: { workerSeq: 0 }, workers: {} }))
  writeFileSync(join(eventsDir, 'events.jsonl'), JSON.stringify({
    at: 3, kind: 'report.created', ticketId: 't9',
    payload: { reportId: 'r9', ticketId: 't9', workerId: 'session-old', summary: 'rebuilt' },
  }) + '\n')
  const rebuilt = new StateStore(eventsDir, { eventLog: true })
  assert.equal(rebuilt.reportsFor('t9').at(-1).executorId, 'session-old')
  console.log('worker -> executor migration ok')
} finally {
  rmSync(root, { recursive: true, force: true })
}
