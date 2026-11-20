// The repository preserves RiaStore's synchronous API and state machine. The
// compatibility methods installed on RiaStore ensure old internal integrations
// cannot bypass the single writer; asynchronous boundaries still remain outside.
export const TICKET_READS = [
  'ticket', 'tickets', 'activeTickets', 'knownTicket', 'dependencyTarget', 'dependencyAssessment',
  'validateDependencies', 'queueTokenFor', 'queueInfo', 'queueOverview', 'intakesForTurn', 'intakeCandidates',
  'archiveRecord', 'historyRecords', 'historyTickets', 'findArchivedTicket', 'archivedTickets',
]
export const TICKET_WRITES = [
  'addTicket', 'updateTicket', 'transitionTicket', 'noteTicket', 'confirmDispatchAttempt',
  'markReadyNotified', 'syncTicketDependencies', 'syncDependents', 'reconcileDependencies',
  'captureIntake', 'resolveIntake', 'mergeTicket', 'mergeTask', 'cascadeCancel',
  'aggregateParent', 'bumpRecovery', 'bumpNudge', 'archiveClosedTickets', 'restoreArchivedTicket',
]

export class TicketRepository {
  constructor(store, writer, options = {}) {
    this.store = store
    this.writer = writer
    // storage=sqlite passes the DB transaction so one writer job == one DB txn.
    this.wrap = typeof options.transaction === 'function' ? options.transaction : null
    this.original = new Map()
    this.depth = 0
    this.backend = null
    this.storage = 'json'
    for (const name of [...TICKET_READS, ...TICKET_WRITES]) {
      if (typeof store[name] !== 'function') continue
      this.original.set(name, store[name].bind(store))
      this[name] = (...args) => this.invoke(name, args)
      store[name] = (...args) => this.invoke(name, args)
    }
    store.afterCommit = (callback, key) => writer.afterCommit(callback, key)
    store.onStateSaved = () => writer.afterCommit(() => store.onTicketsCommitted?.(), 'tickets.committed')
  }

  transaction(task) {
    const execute = () => this.store.runtime ? this.store.runtime.writeStore(task) : task()
    return this.wrap ? this.wrap(execute) : execute()
  }

  invoke(name, args) {
    if (this.depth) return this.original.get(name)(...args)
    if (TICKET_WRITES.includes(name)) return this.writer.runSync('tickets.' + name, () => this.perform(name, args))
    if (this.backend) return this.backend.read(name, args)
    return this.original.get(name)(...args)
  }

  perform(name, args) {
    this.depth += 1
    try {
      return this.backend ? this.backend.write(name, args) : this.original.get(name)(...args)
    } finally { this.depth -= 1 }
  }

  /** One logical compound operation; task receives the transaction-local API.
   * This is the explicit async entry point for queued read-modify-write callers.
   */
  run(label, task) {
    if (task?.constructor?.name === 'AsyncFunction') throw Object.assign(new Error('Repository jobs must not be async'), { code: 'async_transaction' })
    return this.writer.run(label, () => this.compound(task))
  }

  /** Synchronous queue entry for callers that cannot await (RiaStore API). */
  runSync(label, task) {
    if (task?.constructor?.name === 'AsyncFunction') throw Object.assign(new Error('Repository jobs must not be async'), { code: 'async_transaction' })
    return this.writer.runSync(label, () => this.compound(task))
  }

  compound(task) {
    const operation = () => {
      this.depth += 1
      try {
        const value = task(this)
        if (value && typeof value.then === 'function') throw Object.assign(new Error('Repository jobs must be synchronous'), { code: 'async_transaction' })
        return value
      } finally { this.depth -= 1 }
    }
    if (this.backend) return this.backend.compound(operation)
    return this.store.runtime ? this.store.runtime.writeStore(operation) : operation()
  }

  attachV2(store) {
    this.v2 = store
    this.originalV2 = new Map(['ticketMeta', 'setTicketMeta', 'ticketMetas'].map(name => [name, store[name].bind(store)]))
    store.ticketMeta = (...args) => this.ticketMeta(...args)
    store.setTicketMeta = (...args) => this.setTicketMeta(...args)
    store.ticketMetas = (...args) => this.ticketMetas(...args)
  }

  ticketMeta(ticketId) { return this.backend ? this.backend.ticketMeta(ticketId) : this.originalV2.get('ticketMeta')(ticketId) }
  ticketMetas() { return this.backend ? this.backend.ticketMetas() : this.originalV2.get('ticketMetas')() }
  setTicketMeta(ticketId, patch, options = {}) {
    const execute = () => this.backend
      ? this.backend.setTicketMeta(ticketId, patch, options)
      : this.originalV2.get('setTicketMeta')(ticketId, patch)
    return this.depth ? execute() : this.writer.runSync('tickets.setTicketMeta', execute)
  }
}
