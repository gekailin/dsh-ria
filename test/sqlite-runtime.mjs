import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RiaStore } from '../lib/index.js'
import { StateWriter } from '../lib/state/writer.mjs'
import { TicketRepository } from '../lib/state/tickets-repository.mjs'
import { SqliteTicketRuntime, resolveStorageMode } from '../lib/state/sqlite/runtime.mjs'
import { transaction as sqliteTransaction } from '../lib/state/sqlite/db.mjs'
import { SqliteTicketAdapter } from '../lib/state/sqlite/adapter.mjs'
import { openDatabase } from '../lib/state/sqlite/db.mjs'
import { migrateTickets } from '../scripts/sqlite-migrate.mjs'
import { writeExport } from '../scripts/sqlite-export.mjs'

const day = 24 * 60 * 60 * 1000
const ticket = (id, extra = {}) => ({
  ticketId: id, status: 'open', waitingOn: 'ria', executor: 'advisor', goal: 'goal ' + id,
  acceptance: 'accept', revision: 1, createdAt: 1000, updatedAt: 1000, closedAt: null,
  attempt: { legacy: true }, failure: null, resolution: null, progress: { lastPhase: '', lastEventAt: 0 },
  history: [{ at: 1000, actor: 'router', from: 'intake', to: 'open', reason: 'route' }],
  ...extra,
})

const root = mkdtempSync(join(tmpdir(), 'ria-sqlite-runtime-'))
const state = join(root, 'state')
mkdirSync(state, { recursive: true })
const old = Date.now() - 3 * day

const hot = [ticket('t1'), ticket('t2', { status: 'working', waitingOn: 'worker' })]
const closed = Array.from({ length: 52 }, (_, index) => ticket('done' + index, { status: 'done', waitingOn: 'none', closedAt: old - index * 1000, updatedAt: old }))
const archived = ticket('t4', { status: 'done', closedAt: old, resolution: { summary: 'done' } })
writeFileSync(join(state, 'ria.json'), JSON.stringify({ schemaVersion: 5, version: 5, tickets: [...hot, ...closed], settings: { progressCards: false } }))
writeFileSync(join(state, 'v2.json'), JSON.stringify({ tickets: { t1: { ticketId: 't1', phase: 'advisor', projectCwd: '/tmp/p' } } }))
writeFileSync(join(state, 'tickets.log.jsonl'), JSON.stringify({ ticket: archived, closedAt: old }) + '\n')
migrateTickets({ stateDir: state })

const mirror = () => {
  let count = 0
  const write = () => {
    count += 1
    const data = { ...store.data, storage: 'sqlite' }
    data.tickets = store.data.tickets
    writeFileSync(join(state, 'ria.json'), JSON.stringify(data, null, 2) + '\n')
  }
  return { write, get count() { return count } }
}
const mirrorState = mirror()
let store
const openRuntime = () => new SqliteTicketRuntime({ stateDir: state, exportMirror: mirrorState.write, debounceMs: 60_000 })
const runtime = openRuntime()
store = new RiaStore(state, { runtime })

try {
  // Default is json; the file field switches it, env wins, unknown values throw.
  assert.equal(resolveStorageMode({ env: {}, state: {} }), 'json')
  assert.equal(resolveStorageMode({ env: {}, state: { storage: 'sqlite' } }), 'sqlite')
  assert.equal(resolveStorageMode({ env: { DSH_RIA_STORAGE: 'sqlite' }, state: { storage: 'json' } }), 'sqlite')
  assert.throws(() => resolveStorageMode({ env: { DSH_RIA_STORAGE: 'postgres' }, state: {} }), { code: 'storage_invalid' })

  // Reads come from the DB, not from the mirrored JSON.
  assert.equal(store.storage, 'sqlite')
  assert.equal(store.tickets().length, hot.length + closed.length)
  const tampered = JSON.parse(readFileSync(join(state, 'ria.json'), 'utf8'))
  tampered.tickets[0].goal = 'json-only goal'
  writeFileSync(join(state, 'ria.json'), JSON.stringify(tampered))
  assert.equal(store.ticket('t1').goal, 'goal t1', 'sqlite mode ignores ticket JSON')

  const writer = new StateWriter({ transaction: task => sqliteTransaction(runtime.db, task) })
  const repository = new TicketRepository(store, writer, { transaction: task => sqliteTransaction(runtime.db, task) })
  const withReader = fn => {
    const db = openDatabase(join(state, 'ria.sqlite'), { readOnly: true })
    try { return fn(new SqliteTicketAdapter(db)) } finally { db.close() }
  }

  // A write commits the row inside the writer transaction; the JSON mirror is debounced.
  const jsonBefore = readFileSync(join(state, 'ria.json'), 'utf8')
  const revisionBefore = store.ticket('t1').revision
  const historyBefore = store.ticket('t1').history.length
  repository.runSync('note', () => store.noteTicket('t1', { actor: 'worker', reason: 'first' }))
  assert.equal(store.ticket('t1').revision, revisionBefore + 1)
  assert.equal(withReader(adapter => adapter.get('t1').revision), revisionBefore + 1, 'committed row is in the DB')
  assert.equal(readFileSync(join(state, 'ria.json'), 'utf8'), jsonBefore, 'JSON is not written during the transaction')
  assert.equal(runtime.flush(), true)
  const mirrored = JSON.parse(readFileSync(join(state, 'ria.json'), 'utf8'))
  assert.equal(mirrored.storage, 'sqlite')
  assert.equal(mirrored.tickets.find(item => item.ticketId === 't1').revision, revisionBefore + 1, 'mirror catches up after commit')

  // 50 sequential writes: one transaction each, no lost updates.
  const start = store.ticket('t2').revision
  const startHistory = store.ticket('t2').history.length
  for (let index = 0; index < 50; index += 1) {
    repository.runSync('serial-' + index, () => store.noteTicket('t2', { actor: 'worker', reason: 'serial-' + index }))
  }
  assert.equal(store.ticket('t2').revision, start + 50)
  assert.equal(store.ticket('t2').history.length, startHistory + 50)
  runtime.flush()
  assert.equal(withReader(adapter => adapter.get('t2').revision), start + 50)
  assert.equal(withReader(adapter => adapter.history('t2').length), startHistory + 50)

  // 50 concurrent writers funnel through the FIFO queue: still no lost update.
  const concurrentStart = store.ticket('t1').revision
  const concurrentHistory = store.ticket('t1').history.length
  await Promise.all(Array.from({ length: 50 }, (_, index) =>
    repository.run('concurrent-' + index, () => store.noteTicket('t1', { actor: 'worker', reason: 'concurrent-' + index }))))
  assert.equal(store.ticket('t1').revision, concurrentStart + 50, 'revision = 初值 + 50')
  assert.equal(store.ticket('t1').history.length, concurrentHistory + 50, 'history 50 条')
  runtime.flush()
  assert.equal(withReader(adapter => adapter.get('t1').revision), concurrentStart + 50)
  assert.equal(withReader(adapter => adapter.history('t1').length), concurrentHistory + 50)

  // A failed job rolls the DB transaction back.
  const beforeFailure = withReader(adapter => adapter.get('t1').revision)
  await assert.rejects(repository.run('rollback', () => {
    store.noteTicket('t1', { actor: 'worker', reason: 'will roll back' })
    throw new Error('probe rollback')
  }), /probe rollback/)
  assert.equal(withReader(adapter => adapter.get('t1').revision), beforeFailure, 'transaction rolled back')

  // Archive semantics: archived_at moves the row out of the hot set, historyRecords reads the DB.
  const archivedCount = store.archiveClosedTickets()
  assert.ok(archivedCount.archived > 0)
  const archivedRows = withReader(adapter => adapter.records()).filter(record => record.archivedAt !== null)
  assert.ok(archivedRows.length > 0)
  const archivedId = archivedRows[0].ticket.ticketId
  assert.equal(store.ticket(archivedId), undefined, 'archived tickets leave memory')
  assert.ok(store.historyRecords().some(record => record.ticket.ticketId === archivedId), 'historyRecords reads the DB archive')
  assert.ok(store.findArchivedTicket(archivedId))
  const restored = store.restoreArchivedTicket(archivedId)
  assert.equal(restored.ticketId, archivedId)
  assert.equal(store.ticket(archivedId).ticketId, archivedId, 'restore brings the ticket back')
  runtime.flush()
  assert.equal(withReader(adapter => adapter.get(archivedId, { includeArchived: true }).ticketId), archivedId)
  assert.equal(withReader(adapter => adapter.record(archivedId).archivedAt), null, 'restore cleared archived_at')

  // WAL reopen: a new process/connection sees every committed write.
  runtime.close()
  const reopened = openRuntime()
  const reopenedStore = new RiaStore(state, { runtime: reopened })
  assert.equal(reopenedStore.ticket('t1').revision, concurrentStart + 50)
  assert.equal(reopenedStore.ticket('t2').history.length, startHistory + 50)
  assert.equal(reopened.db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal')
  reopened.close()

  // One-command rollback: rebuild JSON + storage=json, and a plain store reads it.
  const rollback = writeExport({ stateDir: state })
  assert.equal(rollback.ok, true)
  assert.equal(rollback.storage, 'json')
  const rolled = JSON.parse(readFileSync(join(state, 'ria.json'), 'utf8'))
  assert.equal(rolled.storage, 'json')
  const plain = new RiaStore(state)
  assert.equal(plain.storage, 'json')
  assert.equal(plain.ticket('t1').revision, concurrentStart + 50, 'rollback JSON carries the DB state')
  assert.ok(existsSync(join(state, 'ria.sqlite')), 'rollback keeps the DB for retry')
  console.log('sqlite runtime, storage switch and rollback ok')
} finally {
  try { store.runtime.close() } catch { /* already closed */ }
  rmSync(root, { recursive: true, force: true })
}
