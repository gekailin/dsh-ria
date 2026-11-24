import { join } from 'node:path'
import { openDatabase, transaction, transactionContext } from './db.mjs'
import { SqliteTicketAdapter } from './adapter.mjs'
import { cloneState, publishState, mapPublishedResult } from '../snapshot.mjs'
import { importLegacyEventsJsonl, loadExecutionState, loadTicketFeedback, syncExecutionState, syncTicketFeedback } from './execution-state.mjs'

// Revision/time alone miss readyNotifiedAt, feedback and normalization writes.
const signature = ticket => JSON.stringify(ticket)
const STATE_WRITES = ['save', 'setChat', 'setSage', 'setSagePromptText', 'clearSage',
  'recordError', 'clearError', 'clearChat',
  'addExecutor', 'nextExecutorSeq', 'nextReflectionSeq', 'removeExecutor', 'addRequest',
  'setWorkOrder', 'addReport', 'addInbox', 'discardInboxForTicket', 'requestExecutorStop',
  'markExecutorStopNoticed', 'clearExecutorStop', 'markInboxDelivered']
const STORE_WRITES = [
  'save', 'noteHumanMessage', 'setSettings', 'addTopic', 'updateTopic', 'linkTicket',
  'unlinkTicket', 'mergeTopic', 'archiveTopic', 'setRia', 'clearRia', 'touchExecutor',
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
 * boot, and every committed write is upserted inside the writer transaction.
 */
export class SqliteTicketRuntime {
  constructor({ stateDir, dbPath = join(stateDir, 'ria.sqlite'), log = () => {} }) {
    this.stateDir = stateDir
    this.dbPath = dbPath
    this.log = log
    this.db = openDatabase(dbPath, { readOnly: false, checkpoint: true })
    this.adapter = new SqliteTicketAdapter(this.db)
    this.persisted = new Map()
    this.closed = false
    this.closing = false
    this.transactions = new WeakMap()
    this.storeSlot = null
    this.stateSlot = null
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

  attachState(store) {
    this.state = store
    store.sqliteRuntime = this
    store.executionInSqlite = true
    store.eventsInLog = Boolean(store.eventLog)
    // One-shot import of any legacy events.jsonl into the 5 SQLite execution tables,
    // then hydrate in-memory state from SQLite as the single source of truth.
    try {
      transaction(this.db, () => {
        importLegacyEventsJsonl({ db: this.db, stateDir: this.stateDir, warn: message => this.log('warn', message) })
      })
    } catch (error) {
      this.log('warn', 'legacy events.jsonl import failed: ' + String(error && error.message ? error.message : error))
    }
    const execState = loadExecutionState(this.db)
    const hasSqlExec = Object.keys(execState.workOrders).length || Object.keys(execState.requests).length
      || execState.reports.length || execState.inbox.length || execState.ticketFeedback.length
    if (hasSqlExec) {
      Object.assign(store.data, execState)
    } else if (Object.keys(store.data.workOrders || {}).length || Object.keys(store.data.requests || {}).length
      || (store.data.reports || []).length || (store.data.inbox || []).length || (store.data.ticketFeedback || []).length) {
      // Seed SQLite from any in-memory execution state loaded from legacy state.json.
      transaction(this.db, () => syncExecutionState(this.db, store.data, null))
    }
    const records = this.adapter.records()
    // DB owns the ticket meta namespace. JSON contains only a possibly lagging
    // mirror; even a newer-looking JSON timestamp cannot import ticket data.
    store.data.tickets = Object.fromEntries(records.filter(record => record.meta != null)
      .map(record => [record.ticket.ticketId, cloneState(record.meta)]))
    this.metaPersisted = new Map(Object.entries(store.data.tickets).map(([id, meta]) => [id, JSON.stringify(meta)]))
    this.stateSlot = { data: store.data }
    Object.defineProperty(store, 'data', {
      configurable: true, enumerable: true,
      get: () => this.currentDraft()?.stateData || this.stateSlot.data,
      set: data => {
        const draft = this.currentDraft()
        if (draft) draft.stateData = data
        else this.stateSlot.data = data
      },
    })
    for (const name of STATE_WRITES) {
      const original = store[name]
      if (typeof original === 'function') store[name] = (...args) => this.writeStore(() => original.apply(store, args))
    }
    store.setTicketMeta = (ticketId, patch, options) => this.writeStore(() => this.setTicketMeta(ticketId, patch, options))
    // Remove the retired mirror state row. Safe when absent; idempotent.
    this.writeStore(() => {
      this.db.prepare("DELETE FROM schema_meta WHERE key='ticket_mirror'").run()
      if (store.pendingSave) {
        store.pendingSave = false
        store.save()
      }
    })
  }

  stageStateSave() {
    this.draft().saveRequested = true
  }

  setTicketMeta(ticketId, patch = {}, options = {}) {
    const draft = this.draft()
    const id = String(ticketId)
    const ticket = draft.data?.tickets.find(item => item.ticketId === id)
      || draft.records.get(id)?.ticket || this.adapter.get(id, { includeArchived: true })
    if (!ticket) throw Object.assign(new Error('ticket not found: ' + id), { code: 'ticket_missing' })
    const current = draft.stateData.tickets[id] || { ticketId: id, scope: 'global', projectId: null, createdAt: Date.now() }
    const revision = Number.isSafeInteger(current.metaRevision) ? current.metaRevision : 0
    if (options.expectedRevision !== undefined && options.expectedRevision !== revision) {
      throw Object.assign(new Error('ticket meta changed since revision ' + options.expectedRevision), { code: 'stale_revision' })
    }
    const next = { ...current, ...cloneState(patch || {}), ticketId: id,
      metaRevision: revision + 1, updatedAt: Math.max(Date.now(), (Number(current.updatedAt) || 0) + 1) }
    draft.stateData.tickets[id] = next
    this.stageStateSave()
    return next
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
      stateData: this.stateSlot ? cloneState(this.stateSlot.data) : null,
      signatures: new Map(this.persisted), metaSignatures: new Map(this.metaPersisted || []),
      records: new Map(), mapped: new WeakMap(), written: 0, saveRequested: false }
    this.transactions.set(context, draft)
    context.beforeCommit.set(this, () => {
      // Flush only the final draft. A validation branch may restore its private
      // snapshot; no earlier save can leave intermediate DB rows behind.
      this.prepareMetaDraft(draft)
      for (const record of draft.records.values()) {
        const id = record.ticket.ticketId
        if (draft.stateData && Object.hasOwn(draft.stateData.tickets, id)) record.meta = draft.stateData.tickets[id]
        this.adapter.save(record.ticket, record)
        draft.written += 1
        draft.signatures.set(id, signature(record.ticket))
        if (record.meta != null) draft.metaSignatures.set(id, JSON.stringify(record.meta))
      }
      if (draft.data) {
        this.persist(draft.data.tickets)
        syncTicketFeedback(this.db, draft.data.ticketFeedback, this.storeSlot?.data?.ticketFeedback || null)
      }
      for (const [id, meta] of Object.entries(draft.stateData?.tickets || {})) {
        const next = JSON.stringify(meta)
        if (draft.metaSignatures.get(id) === next) continue
        const record = this.adapter.record(id)
        if (!record) throw Object.assign(new Error('ticket meta has no DB ticket: ' + id), { code: 'ticket_missing' })
        this.adapter.save(record.ticket, { ...record, meta })
        draft.written += 1
        draft.metaSignatures.set(id, next)
      }
      for (const id of draft.metaSignatures.keys()) {
        if (!draft.stateData || Object.hasOwn(draft.stateData.tickets, id)) continue
        const record = this.adapter.record(id)
        if (record) { this.adapter.save(record.ticket, { ...record, meta: null }); draft.written += 1 }
        draft.metaSignatures.delete(id)
      }
      if (draft.stateData) {
        // When RiaStore is attached, it owns ticket_feedback; avoid overwriting it from StateStore.
        const statePayload = draft.data ? { ...draft.stateData } : draft.stateData
        if (draft.data) delete statePayload.ticketFeedback
        syncExecutionState(this.db, statePayload, this.stateSlot?.data || null)
      }
    })
    context.afterCommit.set(this, () => {
      // The live cache and every previously held nested object are unchanged
      // until SQLite COMMIT succeeds, including when COMMIT itself throws.
      if (draft.data) publishState(this.storeSlot.data, draft.data, draft.mapped)
      if (draft.stateData) publishState(this.stateSlot.data, draft.stateData, draft.mapped)
      this.persisted = draft.signatures
      this.metaPersisted = draft.metaSignatures
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

  /** Ticket feedback entries persisted in SQLite, oldest first. */
  ticketFeedback() { return loadTicketFeedback(this.db) }

  /** Seed SQLite ticket_feedback from legacy JSON when the table is still empty. */
  seedTicketFeedback(items) {
    if (!Array.isArray(items) || !items.length) return
    transaction(this.db, () => syncTicketFeedback(this.db, items, null))
  }

  /** Archived snapshots, newest first, as historyRecords() expects them. */
  archivedRecords() {
    return this.adapter.records({ includeArchived: true })
      .filter(record => record.archivedAt !== null)
      .map(record => record.archiveRecords?.at(-1) || { ticket: record.ticket, ticketId: record.ticket.ticketId, closedAt: record.ticket.closedAt || record.archivedAt, schema: 1 })
      .sort((a, b) => (b.closedAt || 0) - (a.closedAt || 0))
  }

  /** Seed the signature map after boot so the first write only touches changes. */
  adopt(tickets) {
    this.persisted.clear()
    for (const ticket of tickets) this.persisted.set(ticket.ticketId, signature(ticket))
  }

  stageStoreSave() { this.draft().saveRequested = true }

  /** Upsert the final tickets that actually changed. Caller owns the transaction. */
  persist(tickets) {
    if (!transactionContext(this.db)) return transaction(this.db, () => this.persist(tickets))
    const draft = this.draft()
    let written = 0
    for (const ticket of tickets) {
      if (!ticket || typeof ticket.ticketId !== 'string') continue
      const next = signature(ticket)
      if (draft.signatures.get(ticket.ticketId) === next) continue
      const options = draft.stateData && Object.hasOwn(draft.stateData.tickets, ticket.ticketId)
        ? { meta: draft.stateData.tickets[ticket.ticketId] } : {}
      this.adapter.save(ticket, options)
      if (options.meta) draft.metaSignatures.set(ticket.ticketId, JSON.stringify(options.meta))
      draft.signatures.set(ticket.ticketId, next)
      draft.written += 1
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

  prepareMetaDraft(draft) {
    for (const [id, value] of Object.entries(draft.stateData?.tickets || {})) {
      if (draft.metaSignatures.get(id) === JSON.stringify(value)) continue
      const previous = this.stateSlot?.data.tickets[id] || this.adapter.record(id)?.meta || {}
      const previousRevision = Number.isSafeInteger(previous.metaRevision) ? previous.metaRevision : 0
      // Internal draft-only edits also acquire a monotonic server version;
      // values loaded from JSON never enter this DB-owned namespace.
      if (!Number.isSafeInteger(value.metaRevision) || value.metaRevision <= previousRevision) value.metaRevision = previousRevision + 1
      value.ticketId = id
      value.updatedAt = Math.max(Number(value.updatedAt) || 0, Date.now(), (Number(previous.updatedAt) || 0) + 1)
    }
  }

  domainTopics() {
    const rows = this.db.prepare('SELECT * FROM topics ORDER BY created_at, id').all()
    return rows.map(row => ({ topicId: row.id, projectKey: row.project_key, title: row.title,
      brief: row.brief, tags: JSON.parse(row.tags || '[]'), archivedAt: row.archived_at,
      mergedInto: row.merged_into, createdAt: row.created_at, updatedAt: row.updated_at }))
  }

  domainLinks() {
    const rows = this.db.prepare('SELECT * FROM topic_links ORDER BY created_at, topic_id, ticket_id').all()
    return rows.map(row => ({ topicId: row.topic_id, ticketId: row.ticket_id, role: row.role, at: row.created_at }))
  }

  /** One aggregate query per sage list, no per-topic SELECT. */
  topicTicketStatuses() {
    const rows = this.db.prepare(`SELECT l.topic_id, t.status FROM topic_links l
      LEFT JOIN tickets t ON t.id=l.ticket_id ORDER BY l.topic_id`).all()
    const map = new Map()
    for (const row of rows) {
      if (!map.has(row.topic_id)) map.set(row.topic_id, [])
      map.get(row.topic_id).push({ status: row.status || 'unknown' })
    }
    return map
  }

  /** Compatibility barrier: there is no pending mirror; control state is already on disk. */
  flush() { return !this.closed }

  stats() {
    return { storage: 'sqlite', dbPath: this.dbPath, tickets: this.persisted.size, closed: this.closed }
  }

  close() {
    if (this.closed || this.closing) return false
    this.closing = true
    this.closed = true
    this.db.close()
    return true
  }
}
