import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RiaStore } from '../lib/index.js'
import { StateWriter } from '../lib/state/writer.mjs'
import { TicketRepository } from '../lib/state/tickets-repository.mjs'
import { openDatabase, transaction } from '../lib/state/sqlite/db.mjs'
import { SqliteTicketRuntime } from '../lib/state/sqlite/runtime.mjs'
import { SqliteTicketAdapter } from '../lib/state/sqlite/adapter.mjs'
import { normalizeTicket } from '../lib/tickets.mjs'

const dir = mkdtempSync(join(tmpdir(), 'ria-sqlite-transactions-'))
const file = join(dir, 'ria.sqlite')
const old = Date.now() - 3 * 24 * 60 * 60 * 1000
const seed = openDatabase(file, { create: true })
const adapter = new SqliteTicketAdapter(seed)
const input = (id, patch = {}) => normalizeTicket({ ticketId: id, status: 'open', executor: 'advisor',
  waitingOn: 'ria', goal: id, revision: 1, createdAt: old, updatedAt: old, ...patch })
transaction(seed, () => {
  adapter.save(input('t1', { readyAt: 123 }))
  adapter.save(input('t2'))
  adapter.save(input('work', { status: 'working', waitingOn: 'executor', executor: 'executor', attempt: { legacy: false, count: 1, lastRequestId: 'request', startedAt: old } }))
  adapter.save(input('archive', { status: 'done', closedAt: old }), { archivedAt: old })
  for (let i = 0; i < 52; i++) adapter.save(input('closed' + i, { status: 'done', closedAt: old - i }))
})
seed.close()
writeFileSync(join(dir, 'ria.json'), JSON.stringify({ schemaVersion: 5, tickets: [{ ticketId: 'stale-json', goal: 'ignore' }] }))
const runtime = new SqliteTicketRuntime({ stateDir: dir, debounceMs: 60_000 })
const store = new RiaStore(dir, { runtime })
const writer = new StateWriter({ transaction: task => repository.transaction(task) })
const repository = new TicketRepository(store, writer, { transaction: task => transaction(runtime.db, task) })
const reader = openDatabase(file, { readOnly: true })
const external = new SqliteTicketAdapter(reader)
try {
  const liveData = store.data
  const liveTicket = store.ticket('t1')
  const liveHistory = liveTicket.history
  const originalSave = runtime.adapter.save.bind(runtime.adapter)
  const before = structuredClone(store.data)
  const signatures = [...runtime.persisted]
  const observed = []
  store.onRouterEvent = e => observed.push(e)
  runtime.adapter.save = () => {
    assert.deepEqual(liveData, before, 'DB write sees unchanged committed memory')
    assert.deepEqual(liveTicket, before.tickets.find(t => t.ticketId === 't1'))
    throw new Error('injected DB save failure')
  }
  assert.throws(() => store.noteTicket('t1', { reason: 'must roll back' }), /injected DB/)
  assert.strictEqual(store.data, liveData)
  assert.strictEqual(store.ticket('t1'), liveTicket)
  assert.strictEqual(liveTicket.history, liveHistory)
  assert.deepEqual(store.data, before)
  assert.deepEqual([...runtime.persisted], signatures)
  assert.deepEqual(external.get('t1'), liveTicket)
  assert.deepEqual(observed, [])
  runtime.adapter.save = originalSave

  // A later row failing must roll back the earlier SQL row and staged signature.
  let saves = 0
  runtime.adapter.save = (ticket, options) => {
    if (++saves === 2) throw new Error('second row failed')
    return originalSave(ticket, options)
  }
  await assert.rejects(repository.run('partial-sql-rollback', api => {
    api.noteTicket('t1', { reason: 'first row' })
    api.noteTicket('t2', { reason: 'second row' })
  }), /second row failed/)
  runtime.adapter.save = originalSave
  assert.deepEqual(store.data, before)
  assert.deepEqual(external.get('t1'), liveTicket)
  assert.equal(external.get('t2').revision, 1)
  assert.deepEqual([...runtime.persisted], signatures)

  // Multiple writes in a logical job roll back together, including nested refs
  // and the non-ticket fields participating in that private state draft.
  await assert.rejects(repository.run('rollback', () => {
    store.noteTicket('t1', { reason: 'first' })
    store.updateTicket('t2', { goal: 'second' })
    store.addFeedback({ ticketId: 't1', kind: 'progress', body: 'draft feedback' })
    throw new Error('abort compound')
  }), /abort compound/)
  assert.deepEqual(store.data, before)
  assert.deepEqual([...runtime.persisted], signatures)
  assert.deepEqual(external.get('t1'), liveTicket)
  assert.equal(external.get('t2').goal, 't2')

  // COMMIT failure is different from an adapter failure: no live publication.
  const exec = runtime.db.exec.bind(runtime.db)
  runtime.db.exec = sql => { if (sql === 'COMMIT') throw new Error('injected commit failure'); return exec(sql) }
  assert.throws(() => store.transitionTicket('t1', 'working', { executor: 'executor', attempt: { legacy: true } }), /commit failure/)
  runtime.db.exec = exec
  assert.deepEqual(store.data, before)
  assert.deepEqual(external.get('t1'), liveTicket)
  assert.deepEqual([...runtime.persisted], signatures)
  assert.deepEqual(observed, [])

  const result = store.noteTicket('t1', { reason: 'committed' })
  assert.strictEqual(result, liveTicket, 'published result uses existing live ticket identity')
  assert.strictEqual(store.data, liveData)
  assert.strictEqual(result.history, liveHistory)
  assert.deepEqual(external.get('t1'), liveTicket)
  assert.equal(result.revision, before.tickets.find(t => t.ticketId === 't1').revision + 1)

  // These paths do not increment revision; a complete signature must persist them.
  const revision = liveTicket.revision
  store.markReadyNotified('t1', 123)
  assert.equal(liveTicket.revision, revision)
  assert.equal(external.get('t1').readyNotifiedAt, liveTicket.readyNotifiedAt)
  store.addFeedback({ ticketId: 't1', kind: 'progress', body: 'committed feedback' })
  assert.deepEqual(external.get('t1').feedback, liveTicket.feedback)
  assert.equal(external.get('t1').revision, revision)
  assert.equal(store.confirmDispatchAttempt('work', 'request', 456), true)
  assert.equal(external.get('work').attempt.confirmedAt, 456)

  // Every direct write remains failure-atomic, not only writer.run callers.
  for (const operation of [
    () => store.markReadyNotified('t1', 123),
    () => store.addFeedback({ ticketId: 't2', kind: 'probe', body: 'fail' }),
    () => store.addTicket({ goal: 'fail add' }),
    () => store.bumpRecovery('t1'),
    () => store.bumpNudge('t1'),
    () => store.updateTicket('t1', { goal: 'fail update' }),
    () => store.archiveClosedTickets(),
    () => store.restoreArchivedTicket('archive'),
  ]) {
    const cache = structuredClone(store.data)
    const persisted = [...runtime.persisted]
    runtime.adapter.save = () => { throw new Error('write failure') }
    assert.throws(operation, /write failure/)
    runtime.adapter.save = originalSave
    assert.deepEqual(store.data, cache)
    assert.deepEqual([...runtime.persisted], persisted)
    for (const ticket of store.tickets()) assert.deepEqual(external.get(ticket.ticketId), ticket)
    assert.notEqual(external.record('archive').archivedAt, null)
  }
  const archived = store.archiveClosedTickets()
  assert.ok(archived.archived > 0)
  const restored = store.restoreArchivedTicket('archive')
  assert.deepEqual(external.get('archive'), restored)
  assert.equal(external.record('archive').archivedAt, null)

  // Raw draft edits are flushed at the end of a compound even without save().
  repository.runSync('draft-only', api => { api.ticket('t2').progress.lastPhase = 'draft-only mutation' })
  assert.equal(external.get('t2').progress.lastPhase, 'draft-only mutation')
  assert.deepEqual(external.get('t2'), store.ticket('t2'))

  // A dispatch-like recovery reset must be part of the transition transaction,
  // not a post-commit mutation of the live object.
  store.bumpRecovery('t2')
  assert.equal(store.ticket('t2').recovery.count, 1)
  assert.equal(external.get('t2').recovery.count, 1)
  const working = store.transitionTicket('t2', 'working', {
    executor: 'executor', attempt: { legacy: true }, recovery: { count: 0 },
  })
  assert.equal(working.ok, true)
  assert.equal(working.ticket.recovery.count, 0)
  assert.equal(external.get('t2').recovery.count, 0)
  assert.deepEqual(external.get('t2'), store.ticket('t2'))
  console.log('sqlite transaction drafts, references and signature rollback ok')
} finally { reader.close(); runtime.close(); rmSync(dir, { recursive: true, force: true }) }
