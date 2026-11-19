import assert from 'node:assert/strict'
import { StateWriter } from '../lib/state/writer.mjs'
import { TicketRepository } from '../lib/state/tickets-repository.mjs'

// C2: one FIFO writer per process. Jobs run in submission order, each inside
// exactly one transaction, and post-commit notifications run outside the queue.

const events = []
const writer = new StateWriter({
  transaction: task => {
    events.push('begin')
    try { const value = task(); events.push('commit'); return value } catch (cause) { events.push('rollback'); throw cause }
  },
  onError: error => events.push('onError:' + error.message),
})

// FIFO ordering for the synchronous compatibility entry point and async run().
const order = []
writer.runSync('one', () => { order.push('one') })
const two = writer.run('two', () => { order.push('two'); return 2 })
const three = writer.run('three', () => { order.push('three'); return 3 })
assert.deepEqual(order, ['one', 'two', 'three'])
assert.equal(await two, 2)
assert.equal(await three, 3)
assert.equal(writer.stats().committed, 3)

// Every job is its own transaction: a failing job rolls back alone.
assert.throws(() => writer.runSync('boom', () => { throw new Error('probe') }), /probe/)
assert.equal(writer.stats().failed, 1)
assert.equal(writer.runSync('after-failure', () => 'ok'), 'ok')

// Async work must never hold a transaction open (no model/session await inside).
assert.throws(() => writer.runSync('async-sync', async () => {}), { code: 'async_transaction' })
await assert.rejects(writer.run('async-run', async () => {}), { code: 'async_transaction' })
await assert.rejects(writer.run('promise-run', () => Promise.resolve(1)), { code: 'async_transaction' })

// Re-entering the writer from inside its own job would deadlock the FIFO queue.
assert.throws(() => writer.runSync('outer', () => writer.runSync('inner', () => {})), { code: 'writer_reentrant' })
await assert.rejects(writer.run('outer-run', () => writer.run('inner-run', () => {})), { code: 'writer_reentrant' })

// Post-commit effects run after COMMIT and outside the queue, so they may enqueue
// a fresh job (markReadyNotified style) without deadlocking.
const effects = []
writer.runSync('with-effect', () => {
  writer.afterCommit(() => {
    effects.push('effect')
    writer.runSync('nested-effect', () => effects.push('nested'))
  }, 'tickets.committed')
  effects.push('body')
})
// `body` runs inside the job, `effect` only after COMMIT returned.
assert.deepEqual(effects, ['body', 'effect', 'nested'])

// A throwing notification is reported, never propagated into the committed write.
const notified = []
const guarded = new StateWriter({ onError: error => notified.push(error.message) })
guarded.runSync('notify-throws', () => guarded.afterCommit(() => { throw new Error('notice failed') }))
assert.deepEqual(notified, ['notice failed'])

// Repository keeps RiaStore's synchronous API: writes go through the writer,
// nested store calls made from inside one write stay in the same transaction.
class FakeStore {
  constructor() {
    this.rows = new Map()
    this.calls = []
  }
  addTicket(patch) {
    this.calls.push('addTicket')
    const ticket = { ticketId: 'ticket_fake', revision: 0, history: [], ...patch }
    this.rows.set(ticket.ticketId, ticket)
    this.save()
    return ticket
  }
  updateTicket(ticketId, patch) {
    this.calls.push('updateTicket')
    const ticket = { ...this.rows.get(ticketId), ...patch, revision: this.rows.get(ticketId).revision + 1 }
    this.rows.set(ticketId, ticket)
    this.save()
    return ticket
  }
  ticket(ticketId) { return this.rows.get(ticketId) }
  tickets() { return [...this.rows.values()] }
  save() {
    if (typeof this.onStateSaved === 'function') { this.onStateSaved(); return }
    if (typeof this.onTicketsCommitted === 'function') this.onTicketsCommitted()
  }
}

const store = new FakeStore()
const committed = []
store.onTicketsCommitted = () => committed.push('committed')
const txLog = []
const repositoryWriter = new StateWriter({
  transaction: task => { txLog.push('begin'); try { const value = task(); txLog.push('commit'); return value } catch (cause) { txLog.push('rollback'); throw cause } },
})
const repository = new TicketRepository(store, repositoryWriter)
const created = store.addTicket({ goal: 'g' })
assert.equal(created.ticketId, 'ticket_fake')
store.updateTicket('ticket_fake', { status: 'open' })
assert.equal(store.ticket('ticket_fake').revision, 1)
assert.equal(txLog.filter(item => item === 'commit').length, 2, 'one transaction per logical write')
assert.deepEqual(committed, ['committed', 'committed'], 'onTicketsCommitted fires after each commit')

// A compound job batches several store writes into one transaction.
const compounded = repository.run('compound', api => {
  api.updateTicket('ticket_fake', { status: 'working' })
  api.updateTicket('ticket_fake', { status: 'done' })
  return api.ticket('ticket_fake').status
})
assert.equal(await compounded, 'done')
assert.equal(txLog.filter(item => item === 'commit').length, 3, 'compound job commits once')
assert.throws(() => repository.run('async', async () => {}), { code: 'async_transaction' })

await repositoryWriter.drain()
await writer.drain()
console.log('sqlite writer and repository ok')
