import { join } from 'node:path'
import { openDatabase, transaction, transactionContext } from './db.mjs'
import { SqliteTicketAdapter } from './adapter.mjs'
import { cloneState, publishState, mapPublishedResult } from '../snapshot.mjs'

const STORAGE_MODES = new Set(['json', 'sqlite'])

/** storage=json is the default; DSH_RIA_STORAGE wins so an operator can switch
 * without editing the mirrored ria.json, and "storage" in the file survives a
 * process restart. */
export function resolveStorageMode({ env = process.env, state } = {}) {
  const fromEnv = String(env.DSH_RIA_STORAGE || '').toLowerCase()
  if (fromEnv) {
    if (!STORAGE_MODES.has(fromEnv)) throw Object.assign(new Error('Unknown DSH_RIA_STORAGE: ' + fromEnv + ' (expected json|sqlite)'), { code: 'storage_invalid' })
    return fromEnv
  }
  const fromState = String((state && state.storage) || '').toLowerCase()
  return STORAGE_MODES.has(fromState) ? fromState : 'json'
}

// Revision/time alone miss readyNotifiedAt, feedback and normalization writes.
const signature = ticket => JSON.stringify(ticket)
const STORE_WRITES = [
  'save', 'noteHumanMessage', 'setSettings', 'addTopic', 'updateTopic', 'linkTicket',
  'unlinkTicket', 'mergeTopic', 'archiveTopic', 'setRia', 'clearRia', 'touchWorker',
  'recordDispatchNote', 'addTicket', 'updateTicket', 'transitionTicket', 'noteTicket',
  'confirmDispatchAttempt', 'markReadyNotified', 'syncTicketDependencies', 'syncDependents',
  'reconcileDependencies', 'captureIntake', 'resolveIntake', 'mergeTicket', 'mergeTask',
  'cascadeCancel', 'aggregateParent', 'bumpRecovery', 'bumpNudge', 'archiveClosedTickets',
  'restoreArchivedTicket', 'addFeedback', 'addDelivery', 'removeDelivery',
  'addGrant', 'updateGrant', 'removeGrant',
]

/**
 * SQLite authority for tickets in storage=sqlite mode.
 *
 * The store keeps its in-memory ticket map (all ticket semantics stay in one
 * place), the runtime makes the DB the durable source: rows are hydrated at
 * boot, every committed write is upserted inside the writer transaction, and
 * the JSON file is only a debounced read-only mirror.
 */
export class SqliteTicketRuntime {
  constructor({ stateDir, dbPath = join(stateDir, 'ria.sqlite'), exportMirror = null, debounceMs = 25 }) {
    this.stateDir = stateDir
    this.dbPath = dbPath
    this.exportMirror = exportMirror
    this.debounceMs = debounceMs
    this.db = openDatabase(dbPath, { readOnly: false, checkpoint: true })
    this.adapter = new SqliteTicketAdapter(this.db)
    this.persisted = new Map()
    this.timer = null
    this.dirty = false
    this.closed = false
    this.errors = []
    this.transactions = new WeakMap()
    this.storeSlot = null
  }

  /** Install once before the repository wraps the public compatibility methods. */
  attachStore(store) {
    this.store = store
    this.storeSlot = { data: store.data }
    Object.defineProperty(store, 'data', {
      configurable: true, enumerable: true,
      get: () => this.currentDraft()?.data || this.storeSlot.data,
      set: data => {
        const draft = this.currentDraft()
        if (draft) draft.data = data
        else this.storeSlot.data = data
      },
    })
    for (const name of STORE_WRITES) {
      const original = store[name]
      if (typeof original !== 'function') continue
      store[name] = (...args) => this.writeStore(() => original.apply(store, args))
    }
  }

  currentDraft() {
    const context = transactionContext(this.db)
    return context ? this.transactions.get(context) : null
  }

  draft() {
    const context = transactionContext(this.db)
    if (!context) throw new Error('SQLite mutations require a transaction')
    let draft = this.transactions.get(context)
    if (draft) return draft
    draft = { data: this.storeSlot ? cloneState(this.storeSlot.data) : null,
      signatures: new Map(this.persisted), records: new Map(), mapped: new WeakMap() }
    this.transactions.set(context, draft)
    context.beforeCommit.set(this, () => {
      // Flush only the final draft. A validation branch may restore its private
      // snapshot; no earlier save can leave intermediate DB rows behind.
      for (const record of draft.records.values()) {
        this.adapter.save(record.ticket, record)
        draft.signatures.set(record.ticket.ticketId, signature(record.ticket))
      }
      if (draft.data) this.persist(draft.data.tickets)
    })
    context.afterCommit.set(this, () => {
      // The live cache and every previously held nested object are unchanged
      // until SQLite COMMIT succeeds, including when COMMIT itself throws.
      if (draft.data) publishState(this.storeSlot.data, draft.data, draft.mapped)
      this.persisted = draft.signatures
    })
    context.mapResult.set(this, value => mapPublishedResult(value, draft.mapped))
    return draft
  }

  writeStore(task) {
    return transaction(this.db, () => { this.draft(); return task() })
  }

  afterCommit(callback, key = callback) {
    const context = transactionContext(this.db)
    if (context) context.afterCommit.set(key, callback)
    else callback()
  }

  /** Hot tickets, in the same shape the JSON store keeps in memory. */
  hotTickets() { return this.adapter.records({ includeArchived: false }).map(record => record.ticket) }

  /** Archived snapshots, newest first, as historyRecords() expects them. */
  archivedRecords() {
    return this.adapter.records({ includeArchived: true })
      .filter(record => record.archivedAt !== null)
      .map(record => ({ ticket: record.ticket, ticketId: record.ticket.ticketId, closedAt: record.closedAt || record.archivedAt, schema: 1 }))
      .sort((a, b) => (b.closedAt || 0) - (a.closedAt || 0))
  }

  /** Seed the signature map after boot so the first write only touches changes. */
  adopt(tickets) {
    this.persisted.clear()
    for (const ticket of tickets) this.persisted.set(ticket.ticketId, signature(ticket))
  }

  stageStoreSave() { this.draft() }

  /** Upsert the final tickets that actually changed. Caller owns the transaction. */
  persist(tickets) {
    if (!transactionContext(this.db)) return transaction(this.db, () => this.persist(tickets))
    const draft = this.draft()
    let written = 0
    for (const ticket of tickets) {
      if (!ticket || typeof ticket.ticketId !== 'string') continue
      const next = signature(ticket)
      if (draft.signatures.get(ticket.ticketId) === next) continue
      this.adapter.save(ticket)
      draft.signatures.set(ticket.ticketId, next)
      written += 1
    }
    return written
  }

  archive(tickets, at = Date.now()) {
    if (!transactionContext(this.db)) return transaction(this.db, () => this.archive(tickets, at))
    const draft = this.draft()
    for (const ticket of tickets) {
      const previous = draft.records.get(ticket.ticketId) || this.adapter.record(ticket.ticketId) || {}
      draft.records.set(ticket.ticketId, { ...previous, ticket, archivedAt: at })
    }
    return tickets.length
  }

  restore(ticketId) {
    if (!transactionContext(this.db)) return transaction(this.db, () => this.restore(ticketId))
    const draft = this.draft()
    const record = draft.records.get(ticketId) || this.adapter.record(ticketId)
    if (!record) return undefined
    draft.records.set(ticketId, { ...record, archivedAt: null })
    return record.ticket
  }

  /** Mirror export runs after COMMIT, outside the writer queue, and coalesces. */
  scheduleMirror() {
    if (this.closed || !this.exportMirror) return
    this.dirty = true
    if (this.timer) return
    this.timer = setTimeout(() => { this.timer = null; this.flush() }, this.debounceMs)
    if (typeof this.timer.unref === 'function') this.timer.unref()
  }

  flush() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null }
    if (!this.dirty || !this.exportMirror) return false
    this.dirty = false
    this.exportMirror()
    return true
  }

  stats() { return { storage: 'sqlite', dbPath: this.dbPath, tickets: this.persisted.size, dirty: this.dirty, closed: this.closed } }

  close() {
    if (this.closed) return
    try { this.flush() } catch (cause) { this.errors.push(cause) }
    this.closed = true
    this.db.close()
  }
}
