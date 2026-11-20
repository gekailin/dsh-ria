import { join } from 'node:path'
import { openDatabase, transaction, transactionContext } from './db.mjs'
import { SqliteTicketAdapter } from './adapter.mjs'
import { cloneState, publishState, mapPublishedResult } from '../snapshot.mjs'
import { buildMirrorSnapshot } from './mirror.mjs'

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
const STATE_WRITES = ['save', 'setChat', 'setSage', 'setSagePromptText', 'clearSage',
  'recordError', 'clearError', 'clearChat',
  'addWorker', 'nextWorkerSeq', 'nextReflectionSeq', 'removeWorker', 'addRequest',
  'setWorkOrder', 'addReport', 'addInbox', 'discardInboxForTicket', 'requestWorkerStop',
  'markWorkerStopNoticed', 'clearWorkerStop', 'addLessonCandidate', 'updateLessonCandidate', 'markInboxDelivered']
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
  constructor({ stateDir, dbPath = join(stateDir, 'ria.sqlite'), exportMirror = null, debounceMs = 25,
    retryMs = 250, log = () => {}, clock = { setTimeout, clearTimeout, now: Date.now } }) {
    this.stateDir = stateDir
    this.dbPath = dbPath
    this.exportMirror = exportMirror
    this.debounceMs = debounceMs
    this.retryMs = retryMs
    this.log = log
    this.clock = clock
    this.inFlight = null
    this.db = openDatabase(dbPath, { readOnly: false, checkpoint: true })
    this.adapter = new SqliteTicketAdapter(this.db)
    this.persisted = new Map()
    this.timer = null
    this.dirty = false
    this.closed = false
    this.errors = []
    this.transactions = new WeakMap()
    this.storeSlot = null
    this.stateSlot = null
    try { this.setMirrorState(this.readMirrorState()) } catch (cause) { this.db.close(); throw cause }
  }

  /** Install once before the repository wraps the public compatibility methods. */
  attachStore(store) {
    this.store = store
    if (this.dirty && this.mirrorState.pendingRia) Object.assign(store.data, cloneState(this.mirrorState.pendingRia))
    // Keep the pre-B JSON topics/links as a read-only mirror copy. Writes go to
    // SQLite but state.json/ria.json must not start mutating these legacy keys.
    this.legacyDomain = { topics: cloneState(store.data.topics || []), links: cloneState(store.data.links || []) }
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
    // Fake the B-era read surface: if the A migration already imported rows,
    // use them; otherwise keep the legacy JSON copy until the migration runs.
    try {
      const topics = this.db.prepare('SELECT * FROM topics ORDER BY created_at, id').all()
      const links = this.db.prepare('SELECT * FROM topic_links ORDER BY created_at, topic_id, ticket_id').all()
      if (topics.length || links.length) {
        this.storeSlot.data.topics = topics.map(row => ({ topicId: row.id, projectKey: row.project_key,
          title: row.title, brief: row.brief, tags: JSON.parse(row.tags || '[]'),
          archivedAt: row.archived_at, mergedInto: row.merged_into,
          createdAt: row.created_at, updatedAt: row.updated_at }))
        this.storeSlot.data.links = links.map(row => ({ topicId: row.topic_id, ticketId: row.ticket_id,
          role: row.role, at: row.created_at }))
      }
    } catch { /* pre-migration DB: keep JSON */ }
    this.scheduleMirror()
  }

  attachState(store) {
    this.state = store
    store.sqliteRuntime = this
    if (this.dirty && this.mirrorState.pendingState) Object.assign(store.data, cloneState(this.mirrorState.pendingState))
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
    this.scheduleMirror()
  }

  stageStateSave() {
    this.draft()
    this.afterCommit(() => this.scheduleMirror(), 'sqlite.mirror')
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
      records: new Map(), mapped: new WeakMap(), written: 0, saveRequested: false, mirrorState: null }
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
      if (draft.data) this.persist(draft.data.tickets)
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
      if (draft.written || draft.saveRequested
        || (draft.data && JSON.stringify(draft.data) !== JSON.stringify(this.storeSlot.data))
        || (draft.stateData && JSON.stringify(draft.stateData) !== JSON.stringify(this.stateSlot.data))) {
        draft.mirrorState = this.stageMirrorGeneration(draft)
      }
    })
    context.afterCommit.set(this, () => {
      // The live cache and every previously held nested object are unchanged
      // until SQLite COMMIT succeeds, including when COMMIT itself throws.
      if (draft.data) publishState(this.storeSlot.data, draft.data, draft.mapped)
      if (draft.stateData) publishState(this.stateSlot.data, draft.stateData, draft.mapped)
      this.persisted = draft.signatures
      this.metaPersisted = draft.metaSignatures
      if (draft.mirrorState) { this.setMirrorState(draft.mirrorState); this.armMirror() }
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
      const snapshot = this.store ? this.store.archiveRecord(ticket)
        : { ticket: cloneState(ticket), ticketId: ticket.ticketId, closedAt: ticket.closedAt || at, schema: 1 }
      const archiveRecords = [...(previous.archiveRecords || [])]
      if (!archiveRecords.some(record => record.ticket?.ticketId === ticket.ticketId && record.closedAt === snapshot.closedAt)) archiveRecords.push(snapshot)
      draft.records.set(ticket.ticketId, { ...previous, ticket, archivedAt: at, archiveRecords })
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

  readMirrorState() {
    const raw = this.adapter.getSchemaMeta('ticket_mirror')
    const value = raw ? JSON.parse(raw) : {}
    const generation = Number.isSafeInteger(value.generation) ? value.generation : 0
    const exportedGeneration = Number.isSafeInteger(value.exportedGeneration) ? value.exportedGeneration : -1
    return { ...value, generation, exportedGeneration, dirty: value.dirty === true || exportedGeneration < generation }
  }

  setMirrorState(value) {
    this.mirrorState = value
    this.generation = value.generation
    this.dirty = value.dirty === true || value.exportedGeneration < value.generation
  }

  nonTicketFields(data) {
    if (!data) return null
    const { tickets, ...rest } = data
    return cloneState(rest)
  }

  stageMirrorGeneration(draft = null) {
    const previous = this.readMirrorState()
    const next = { ...previous, generation: previous.generation + 1, dirty: true,
      pendingRia: draft?.data ? this.nonTicketFields(draft.data) : previous.pendingRia || this.nonTicketFields(this.storeSlot?.data),
      pendingState: draft?.stateData ? this.nonTicketFields(draft.stateData) : previous.pendingState || this.nonTicketFields(this.stateSlot?.data) }
    // Dirty and the latest non-ticket recovery payload commit with ticket/meta
    // SQL. A failed JSON export/restart cannot let an older file erase them.
    this.adapter.setSchemaMeta('ticket_mirror', next)
    return next
  }

  mirrorSnapshot() {
    if (transactionContext(this.db)) throw Object.assign(new Error('Cannot export an uncommitted SQLite draft'), { code: 'mirror_in_transaction' })
    this.db.exec('BEGIN')
    try {
      const state = this.readMirrorState()
      const current = this.storeSlot?.data || state.pendingRia || {}
      const ria = this.legacyDomain
        ? { ...current, topics: this.legacyDomain.topics, links: this.legacyDomain.links }
        : current
      return buildMirrorSnapshot({ records: this.adapter.records(), counts: this.adapter.counts(),
        ria,
        state: this.stateSlot?.data || state.pendingState || {}, generation: state.generation })
    } finally { this.db.exec('ROLLBACK') }
  }

  /** Schedule only after COMMIT. Dirty is durable even without an exporter. */
  scheduleMirror() {
    if (this.closed || this.closing) return
    const state = this.readMirrorState()
    if (!state.dirty || !this.adapter.getSchemaMeta('ticket_mirror')) {
      this.writeStore(() => { this.draft().saveRequested = true })
    } else this.setMirrorState(state)
    this.armMirror()
  }

  armMirror(delay = this.debounceMs) {
    if (this.closed || this.closing || !this.dirty || !this.exportMirror || this.timer || this.flushing) return
    try {
      this.timer = this.clock.setTimeout(() => {
        this.timer = null
        try {
          const result = this.flush()
          if (result && typeof result.then === 'function') result.catch(() => {})
        } catch { /* flush records the failure and rearms, never an uncaught timer error */ }
      }, delay)
      this.timer?.unref?.()
    } catch (cause) { this.recordMirrorFailure(cause) }
  }

  recordMirrorFailure(cause) {
    this.dirty = true
    this.errors.push(cause)
    if (this.errors.length > 20) this.errors.shift()
    const failure = { message: String(cause?.message || cause), code: cause?.code || 'mirror_export_failed', at: this.clock.now() }
    try {
      const next = transaction(this.db, () => {
        const current = this.readMirrorState()
        const value = { ...current, dirty: true, lastError: failure, failures: (current.failures || 0) + 1 }
        this.adapter.setSchemaMeta('ticket_mirror', value)
        return value
      })
      this.setMirrorState(next)
    } catch (error) { this.errors.push(error) }
    try { this.log('warn', 'SQLite mirror export failed; remains dirty for retry: ' + failure.message) } catch { /* diagnostics cannot stop retry */ }
  }

  completeMirror(snapshot, result) {
    if (result === false) throw new Error('Mirror exporter did not publish the snapshot')
    const next = transaction(this.db, () => {
      const current = this.readMirrorState()
      if (current.generation !== snapshot.generation) return current
      const value = { ...current, exportedGeneration: snapshot.generation, dirty: false,
        pendingRia: null, pendingState: null, lastError: null, lastSuccessAt: this.clock.now() }
      this.adapter.setSchemaMeta('ticket_mirror', value)
      return value
    })
    this.setMirrorState(next)
    return !this.dirty
  }

  flush() {
    if (this.closed) return false
    if (transactionContext(this.db)) throw Object.assign(new Error('Cannot export uncommitted data'), { code: 'mirror_in_transaction' })
    if (this.timer) { this.clock.clearTimeout(this.timer); this.timer = null }
    if (this.flushing) return this.inFlight || false
    this.flushing = true
    let asynchronous = false
    const finish = () => {
      this.flushing = false
      this.inFlight = null
      if (this.dirty) this.armMirror(this.mirrorState.lastError ? this.retryMs : this.debounceMs)
    }
    try {
      this.setMirrorState(this.readMirrorState())
      if (!this.dirty || !this.exportMirror) return false
      const snapshot = this.mirrorSnapshot()
      const result = this.exportMirror(snapshot, {
        isCurrent: () => !this.closed && this.readMirrorState().generation === snapshot.generation,
      })
      if (result && typeof result.then === 'function') {
        asynchronous = true
        this.inFlight = Promise.resolve(result)
          .then(value => this.completeMirror(snapshot, value))
          .catch(cause => { this.recordMirrorFailure(cause); throw cause })
          .finally(finish)
        return this.inFlight
      }
      return this.completeMirror(snapshot, result)
    } catch (cause) {
      this.recordMirrorFailure(cause)
      throw cause
    } finally { if (!asynchronous) finish() }
  }

  domainMigrated() {
    try { return Boolean(this.db.prepare("SELECT 1 FROM schema_meta WHERE key='domain_migration'").get()) } catch { return false }
  }

  domainTopics() {
    try {
      const rows = this.db.prepare('SELECT * FROM topics ORDER BY created_at, id').all()
      if (!rows.length && !this.domainMigrated()) return cloneState(this.legacyDomain?.topics || [])
      return rows.map(row => ({ topicId: row.id, projectKey: row.project_key, title: row.title,
        brief: row.brief, tags: JSON.parse(row.tags || '[]'), archivedAt: row.archived_at,
        mergedInto: row.merged_into, createdAt: row.created_at, updatedAt: row.updated_at }))
    } catch { return cloneState(this.legacyDomain?.topics || []) }
  }

  domainLinks() {
    try {
      const rows = this.db.prepare('SELECT * FROM topic_links ORDER BY created_at, topic_id, ticket_id').all()
      if (!rows.length && !this.domainMigrated()) return cloneState(this.legacyDomain?.links || [])
      return rows.map(row => ({ topicId: row.topic_id, ticketId: row.ticket_id, role: row.role, at: row.created_at }))
    } catch { return cloneState(this.legacyDomain?.links || []) }
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

  /** Lessons are relational in sqlite mode; the JSON file stays read-only. */
  readLessons() {
    try {
      return this.db.prepare('SELECT * FROM lessons ORDER BY created_at, id').all().map(row => ({
        id: row.id, status: row.status, scenario: row.scenario, approach: row.approach,
        pitfall: row.pitfall, tags: [], condition: '', hits: 0,
        source: { ticketId: row.ticket_id || '', reportId: row.report_id || '', sessionId: row.session_id || '' },
        sources: row.evidence ? JSON.parse(row.evidence) : [],
        createdAt: row.created_at, updatedAt: row.created_at, reviewedAt: row.reviewed_at,
      }))
    } catch { return null }
  }

  lessonEntries(status = 'active') {
    const rows = status
      ? this.db.prepare('SELECT * FROM lessons WHERE status=? ORDER BY created_at, id').all(status)
      : this.db.prepare('SELECT * FROM lessons ORDER BY created_at, id').all()
    return rows.map(row => ({
      id: row.id, status: row.status, scenario: row.scenario, approach: row.approach,
      pitfall: row.pitfall, tags: [], condition: '', hits: 0,
      source: { ticketId: row.ticket_id || '', reportId: row.report_id || '', sessionId: row.session_id || '' },
      sources: row.evidence ? JSON.parse(row.evidence) : [],
      createdAt: row.created_at, updatedAt: row.created_at, reviewedAt: row.reviewed_at,
    }))
  }

  writeLessons(entries) {
    transaction(this.db, () => {
      this.db.prepare('DELETE FROM lessons').run()
      const insert = this.db.prepare(`INSERT INTO lessons(id,status,scenario,approach,pitfall,evidence,ticket_id,report_id,session_id,created_at,reviewed_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
      for (const entry of entries) {
        const source = entry.source || {}
        insert.run(entry.id, entry.status || 'active', entry.scenario || '', entry.approach || '', entry.pitfall || '',
          entry.sources && entry.sources.length ? JSON.stringify(entry.sources) : null,
          source.ticketId || null, source.reportId || null, source.sessionId || null,
          Number(entry.createdAt) || Date.now(), entry.reviewedAt == null ? null : Number(entry.reviewedAt))
      }
    })
  }

  stats() {
    return { storage: 'sqlite', dbPath: this.dbPath, tickets: this.persisted.size, dirty: this.dirty,
      generation: this.generation, exportedGeneration: this.mirrorState.exportedGeneration,
      lastError: this.mirrorState.lastError || null, failures: this.mirrorState.failures || 0,
      exporting: Boolean(this.flushing), closed: this.closed }
  }

  close() {
    if (this.closed || this.closing) return this.inFlight
    this.closing = true
    const finish = () => {
      if (this.timer) { this.clock.clearTimeout(this.timer); this.timer = null }
      this.closed = true
      this.db.close()
    }
    try {
      const result = this.flushing ? this.inFlight : this.flush()
      if (result && typeof result.then === 'function') return result.catch(() => {}).finally(finish)
    } catch { /* dirty/error is already durable; do not erase it on shutdown */ }
    finish()
  }
}
