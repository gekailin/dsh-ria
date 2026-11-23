import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { copyFileSync } from 'node:fs'
import { writeAtomic } from '../shared/fs.mjs'
import { EventLog, EVENT_LIMITS } from '../state/event-log.mjs'
import { AUTO_TAG_LIMIT, TAG_LIMIT, normalizeTags } from './tags.mjs'

const EMPTY = () => ({
  schemaVersion: 1,
  chatSessionId: null,
  sageSessionId: null,
  coManagement: null,
  workers: {},
  requests: {},
  tickets: {},
  workOrders: {},
  reports: [],
  inbox: [],
  // Lesson candidates proposed by Workers; they stay inert until the Advisor
  // accepts them into lessons.json.
  lessonCandidates: [],
  lastError: null,
  // Monotonic role-session numbering. Never reset when a Worker is removed:
  // a retired "Ria Worker 2" must not be reused by a later Worker.
  meta: { workerSeq: 0, reflectionSeq: 0 },
})

const clone = value => JSON.parse(JSON.stringify(value))

/**
 * Durable state for the state control plane. Tickets themselves stay in RiaStore
 * so the existing board/API keeps working; this file only records the
 * Chat/Advisor/Worker sessions, WorkOrders, reports and manager inbox.
 */
export class StateStore {
  constructor(stateDir, options = {}) {
    this.stateDir = stateDir
    this.path = join(stateDir, 'state.json')
    // In sqlite mode ticket metadata lives in tickets.meta; state.json only
    // keeps non-ticket control-plane state.
    this.metaAuthority = options.metaAuthority || (options.sqlite ? 'sqlite' : 'json')
    this.onWarn = options.onWarn
    this.eventLog = options.eventLog ? new EventLog({ stateDir, ...(options.eventOptions || {}), warn: message => this.warn(message) }) : null
    this.lastSnapshot = null
    this.hasLegacyEvents = false
    this.data = EMPTY()
    this.load()
    if (this.eventLog) {
      this.migrateEvents()
      this.rebuildEvents()
    }
  }

  warn(message) {
    if (typeof this.onWarn === 'function') this.onWarn(message)
    else if (typeof console !== 'undefined' && console.warn) console.warn('[ria-events] ' + message)
  }

  eventSnapshot() {
    return clone({ requests: this.data.requests, reports: this.data.reports, workOrders: this.data.workOrders,
      inbox: this.data.inbox, ticketFeedback: this.data.ticketFeedback, lessonCandidates: this.data.lessonCandidates })
  }

  captureSnapshot() { this.lastSnapshot = this.eventSnapshot() }

  appendEvent(kind, ticketId, payload) {
    if (!this.eventLog) return
    this.eventLog.append({ at: Date.now(), kind, ticketId, payload })
  }

  appendChanges(previous, next) {
    if (!this.eventLog) return
    const ids = item => item && (item.requestId || item.reportId || item.feedbackId || item.id || item.ticketId)
    const mapDiff = (kind, before, after) => {
      for (const [id, item] of Object.entries(after || {})) {
        if (!before || JSON.stringify(before[id]) !== JSON.stringify(item)) this.appendEvent(kind + (before && before[id] ? '.updated' : '.created'), id, item)
      }
      for (const id of Object.keys(before || {})) if (!after || !Object.hasOwn(after, id)) this.appendEvent(kind + '.removed', id, { id })
    }
    const listDiff = (kind, before, after) => {
      const prior = new Map((before || []).map(item => [String(ids(item)), item]))
      for (const item of after || []) {
        const id = String(ids(item))
        if (!prior.has(id) || JSON.stringify(prior.get(id)) !== JSON.stringify(item)) this.appendEvent(kind + (prior.has(id) ? '.updated' : '.created'), item.ticketId, item)
      }
      const current = new Set((after || []).map(item => String(ids(item))))
      for (const item of before || []) if (!current.has(String(ids(item)))) this.appendEvent(kind + '.removed', item.ticketId, { id: ids(item) })
    }
    mapDiff('request', previous.requests, next.requests)
    mapDiff('workorder', previous.workOrders, next.workOrders)
    listDiff('report', previous.reports, next.reports)
    listDiff('inbox', previous.inbox, next.inbox)
    listDiff('feedback', previous.ticketFeedback, next.ticketFeedback)
    listDiff('lesson', previous.lessonCandidates, next.lessonCandidates)
  }

  writeControlState(output) {
    if (this.sqliteRuntime) { this.sqliteRuntime.stageStateSave(); return }
    writeAtomic(this.path, JSON.stringify(output, null, 2))
  }

  syncCoManagedWorkers() {
    const previousCo = Object.fromEntries(Object.entries(this.data.workers || {}).filter(([, worker]) => worker && worker.kind === 'co-managed'))
    const managed = Object.fromEntries(Object.entries(this.data.workers || {}).filter(([, worker]) => worker && worker.kind !== 'co-managed'))
    const co = Array.isArray(this.data.coManagement) ? this.data.coManagement : []
    for (const item of co) {
      const prior = previousCo[String(item.sessionId)] || {}
      const sessionId = String(item && item.sessionId ? item.sessionId : '')
      if (!sessionId) continue
      const label = item.title || item.titleSnapshot || sessionId
      managed[sessionId] = {
        sessionId, kind: 'co-managed', workerType: 'work', scope: 'project', projectCwd: null,
        cwd: item.cwd || null, title: label, workerLabel: label,
        allowAutoDispatch: item.allowDispatch !== false,
        tags: Array.isArray(item.tags) ? item.tags.slice() : [],
        roleNote: item.roleNote || '', dedicated: item.dedicated === true,
        status: prior.status || 'idle', currentTicketId: prior.currentTicketId || null, lastTurnAt: prior.lastTurnAt || null, addedAt: item.addedAt || null,
      }
    }
    this.data.workers = managed
  }

  controlOutput() {
    const output = { ...this.data }
    if (Array.isArray(this.data.coManagement)) {
      output.workers = Object.fromEntries(Object.entries(this.data.workers || {}).filter(([, worker]) => worker && worker.kind !== 'co-managed'))
    }
    for (const key of ['requests', 'reports', 'workOrders', 'inbox', 'ticketFeedback', 'lessonCandidates']) delete output[key]
    if (this.metaAuthority === 'sqlite') { delete output.tickets; delete output.ticketMirror }
    return output
  }

  migrateEvents() {
    const keys = ['requests', 'reports', 'workOrders', 'inbox', 'ticketFeedback', 'lessonCandidates']
    if (!this.hasLegacyEvents) return
    if (!this.data.eventsMigratedAt) {
      try { copyFileSync(this.path, this.path + '.bak.' + new Date().toISOString().replace(/[:.]/g, '-')) } catch (error) { this.warn('state.json backup failed: ' + String(error && error.message ? error.message : error)) }
      const at = Date.now()
      for (const [id, item] of Object.entries(this.data.requests || {})) this.appendEvent('request.created', id, { ...item, migratedAt: at })
      for (const [id, item] of Object.entries(this.data.workOrders || {})) this.appendEvent('workorder.created', id, { ...item, migratedAt: at })
      for (const item of this.data.reports || []) this.appendEvent('report.created', item.ticketId, { ...item, migratedAt: at })
      for (const item of this.data.inbox || []) this.appendEvent('inbox.created', item.ticketId, { ...item, migratedAt: at })
      for (const item of this.data.ticketFeedback || []) this.appendEvent('feedback.created', item.ticketId, { ...item, migratedAt: at })
      for (const item of this.data.lessonCandidates || []) this.appendEvent('lesson.created', item.ticketId, { ...item, migratedAt: at })
      this.data.eventsMigratedAt = at
    }
    for (const key of keys) delete this.data[key]
    this.data.requests = {}
    this.data.reports = []
    this.data.workOrders = {}
    this.data.inbox = []
    this.data.ticketFeedback = []
    this.data.lessonCandidates = []
    this.hasLegacyEvents = false
    this.writeControlState(this.controlOutput())
  }

  rebuildEvents() {
    if (!this.eventLog.hasEvents()) { this.captureSnapshot(); return }
    const { data, badLines, read } = this.eventLog.rebuild(EVENT_LIMITS)
    Object.assign(this.data, data)
    this.captureSnapshot()
    if (badLines) this.warn('events.jsonl skipped ' + badLines + ' bad line(s) while reading ' + read + ' event(s)')
  }

  load() {
    try {
      if (!existsSync(this.path)) return
      const parsed = JSON.parse(readFileSync(this.path, 'utf8'))
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return
      this.data = { ...EMPTY(), ...parsed }
      if (Array.isArray(this.data.coManagement)) this.syncCoManagedWorkers()
      this.hasLegacyEvents = ['requests', 'reports', 'workOrders', 'inbox', 'ticketFeedback', 'lessonCandidates'].some(key => Object.hasOwn(parsed, key))
      if (this.metaAuthority === 'sqlite') {
        // Legacy mirrors are ignored; DB tickets.meta is authoritative.
        delete this.data.tickets
        delete this.data.ticketMirror
      }
      // Stateless Advisor: old "advisors"/"thinkers" bindings are ignored and
      // removed. sagePromptText is likewise deleted; Sage always uses the code
      // prompt. Both disappear on the next save.
      delete this.data.advisors
      delete this.data.thinkers
      delete this.data.sagePromptText
      if (this.data.sageSessionId !== null && typeof this.data.sageSessionId !== 'string') this.data.sageSessionId = null
      for (const key of ['workers', 'requests', 'tickets', 'workOrders']) {
        if (this.metaAuthority === 'sqlite' && key === 'tickets') continue
        if (!this.data[key] || typeof this.data[key] !== 'object' || Array.isArray(this.data[key])) this.data[key] = {}
      }
      if (!this.data.meta || typeof this.data.meta !== 'object' || Array.isArray(this.data.meta)) this.data.meta = { workerSeq: 0, reflectionSeq: 0 }
      this.data.meta.workerSeq = Number.isSafeInteger(this.data.meta.workerSeq) && this.data.meta.workerSeq >= 0 ? this.data.meta.workerSeq : 0
      this.data.meta.reflectionSeq = Number.isSafeInteger(this.data.meta.reflectionSeq) && this.data.meta.reflectionSeq >= 0 ? this.data.meta.reflectionSeq : 0
      let workerFloor = 0
      let reflectionFloor = 0
      for (const worker of Object.values(this.data.workers)) {
        if (!worker || typeof worker !== 'object') continue
        if (Number.isSafeInteger(worker.seq) && worker.seq > 0) {
          if (worker.workerType === 'reflection') reflectionFloor = Math.max(reflectionFloor, worker.seq)
          else workerFloor = Math.max(workerFloor, worker.seq)
        } else if (worker.workerType === 'reflection') reflectionFloor += 1
        else workerFloor += 1
      }
      this.data.meta.workerSeq = Math.max(this.data.meta.workerSeq, workerFloor)
      this.data.meta.reflectionSeq = Math.max(this.data.meta.reflectionSeq, reflectionFloor)
      if (!Array.isArray(this.data.reports)) this.data.reports = []
      if (!Array.isArray(this.data.inbox)) this.data.inbox = []
      // Older state.json files have no candidate list; that is not an error.
      if (!Array.isArray(this.data.lessonCandidates)) this.data.lessonCandidates = []
      this.data.lessonCandidates = this.data.lessonCandidates.filter(item => item && typeof item === 'object').slice(-200)
      if (this.data.lastError !== null && (typeof this.data.lastError !== 'object' || Array.isArray(this.data.lastError))) {
        this.data.lastError = null
      }
      // Ticket metadata written before the rename still says phase "thinker".
      for (const meta of Object.values(this.data.tickets || {})) {
        if (meta && typeof meta === 'object' && meta.phase === 'thinker') meta.phase = 'advisor'
      }
    } catch {
      // A damaged sidecar must not prevent the plugin from starting. Tickets are
      // still recoverable from ria.json; the next write replaces this file.
      this.data = EMPTY()
    }
  }

  save() {
    if (this.eventLog) {
      const next = this.eventSnapshot()
      this.appendChanges(this.lastSnapshot || next, next)
      this.lastSnapshot = next
      this.writeControlState(this.controlOutput())
      return
    }
    if (this.sqliteRuntime) { this.sqliteRuntime.stageStateSave(); return }
    const output = { ...this.data }
    if (Array.isArray(this.data.coManagement)) {
      output.workers = Object.fromEntries(Object.entries(this.data.workers || {}).filter(([, worker]) => worker && worker.kind !== 'co-managed'))
    }
    if (this.metaAuthority === 'sqlite') { delete output.tickets; delete output.ticketMirror }
    writeAtomic(this.path, JSON.stringify(output, null, 2))
  }

  /** Session id of the Chat role (the session titled 'Ria'). */
  get chatSessionId() {
    return this.data.chatSessionId || null
  }

  setChat(sessionId) {
    this.data.chatSessionId = String(sessionId)
    this.save()
  }

  get sageSessionId() {
    return this.data.sageSessionId || null
  }

  setSage(sessionId) {
    this.data.sageSessionId = String(sessionId)
    this.save()
  }

  clearSage(sessionId) {
    if (this.data.sageSessionId === String(sessionId)) {
      this.data.sageSessionId = null
      this.save()
    }
  }

  /**
   * Persist the last role/startup failure so a restart can explain why the
   * Chat is missing instead of silently sending inbound messages to a
   * half-installed session. The stack is kept because the controller's logger
   * is not guaranteed to reach the web log.
   */
  recordError(scope, error, extra = {}) {
    const value = error && typeof error === 'object' ? error : { message: String(error) }
    this.data.lastError = {
      scope: String(scope),
      message: String(value.message || value),
      stack: value.stack ? String(value.stack) : null,
      at: Date.now(),
      ...extra,
    }
    this.save()
    return this.data.lastError
  }

  clearError(scope) {
    if (!this.data.lastError) return
    // Errors persisted before the role rename carry scope 'chat'.
    if (scope && String(this.data.lastError.scope) !== String(scope)) return
    this.data.lastError = null
    this.save()
  }

  clearChat(sessionId) {
    if (this.data.chatSessionId === String(sessionId)) {
      this.data.chatSessionId = null
      this.save()
    }
  }



  /**
   * Older records have no workerType; every one of them is a normal work
   * Worker, so the default is applied on read and persisted with the next save.
   */
  normalizeWorker(item) {
    if (!item || typeof item !== 'object') return item
    if (item.workerType !== 'reflection') item.workerType = 'work'
    // Old bindings remain eligible; only an explicit false opts out.
    item.allowAutoDispatch = item.allowAutoDispatch !== false
    // Worker identity: explicit capability tags, a one-line role note, the
    // dedicated protection switch and the soft auto-learned fields. Every read
    // normalizes them so a hand-edited state.json cannot smuggle bad values into
    // routing.
    item.tags = normalizeTags(item.tags, TAG_LIMIT)
    item.autoTags = normalizeTags(item.autoTags, AUTO_TAG_LIMIT)
    item.roleNote = typeof item.roleNote === 'string' ? [...item.roleNote].slice(0, 120).join('') : ''
    item.dedicated = item.dedicated === true
    // Display name independent of the host Session title: co-managed Sessions
    // keep their own title, and a managed Worker's label is its assigned
    // "Ria Worker NN". Missing on legacy records; readers fall back.
    if (typeof item.workerLabel === 'string' && item.workerLabel.trim()) item.workerLabel = item.workerLabel.trim()
    else delete item.workerLabel
    item.recentTopics = Array.isArray(item.recentTopics)
      ? item.recentTopics.filter(value => typeof value === 'string' && value).slice(0, 5)
      : []
    return item
  }

  worker(sessionId) {
    return this.normalizeWorker(this.data.workers[String(sessionId)] || null)
  }

  addWorker(sessionId, patch = {}, { trigger = 'worker.update' } = {}) {
    const id = String(sessionId)
    const previous = this.data.workers[id]
    const before = previous ? { status: previous.status, currentTicketId: previous.currentTicketId || null } : null
    this.data.workers[id] = {
      sessionId: id,
      kind: 'managed',
      workerType: 'work',
      allowAutoDispatch: true,
      scope: 'global',
      status: 'idle',
      currentTicketId: null,
      createdAt: Date.now(),
      ...(this.data.workers[id] || {}),
      ...patch,
    }
    this.normalizeWorker(this.data.workers[id])
    this.save()
    const after = { status: this.data.workers[id].status, currentTicketId: this.data.workers[id].currentTicketId || null }
    if (!before || before.status !== after.status || before.currentTicketId !== after.currentTicketId) {
      // Emit after the durable write. Observability cannot invalidate a committed
      // state update, and unchanged metadata writes must not duplicate events.
      try {
        const notify = () => this.onWorkerStateChanged?.({ workerId: id, before, after, trigger })
        if (this.sqliteRuntime) this.sqliteRuntime.afterCommit(notify)
        else notify()
      } catch { /* state is already committed */ }
    }
    return this.data.workers[id]
  }

  workers() {
    return Object.values(this.data.workers).map(item => this.normalizeWorker(item))
  }

  nextWorkerSeq() {
    if (!this.data.meta) this.data.meta = { workerSeq: 0, reflectionSeq: 0 }
    this.data.meta.workerSeq = (Number.isSafeInteger(this.data.meta.workerSeq) ? this.data.meta.workerSeq : 0) + 1
    this.save()
    return this.data.meta.workerSeq
  }

  nextReflectionSeq() {
    if (!this.data.meta) this.data.meta = { workerSeq: 0, reflectionSeq: 0 }
    this.data.meta.reflectionSeq = (Number.isSafeInteger(this.data.meta.reflectionSeq) ? this.data.meta.reflectionSeq : 0) + 1
    this.save()
    return this.data.meta.reflectionSeq
  }

  /** Persist one-off migration markers next to the role counters. */
  setMeta(patch = {}) {
    if (!this.data.meta || typeof this.data.meta !== 'object') this.data.meta = { workerSeq: 0, reflectionSeq: 0 }
    Object.assign(this.data.meta, patch || {})
    this.save()
    return this.data.meta
  }

  removeWorker(sessionId) {
    delete this.data.workers[String(sessionId)]
    this.save()
  }

  ticketMeta(ticketId) {
    const id = String(ticketId)
    // SQLite is the authority; the in-memory map is only a legacy/JSON cache.
    if (this.sqliteRuntime) {
      const draft = this.sqliteRuntime.currentDraft?.()
      const inDraft = draft?.v2Data?.tickets?.[id]
      if (inDraft) return inDraft
      const record = this.sqliteRuntime.adapter.record(id)
      if (record && record.meta) return record.meta
    }
    // Reading a legacy ticket must not enroll it in state startup recovery.
    // Only setTicketMeta() creates a durable entry.
    return this.data.tickets?.[id] || { ticketId: id, scope: 'global', projectId: null }
  }

  setTicketMeta(ticketId, patch) {
    const id = String(ticketId)
    if (!this.data.tickets[id]) {
      this.data.tickets[id] = { ticketId: id, scope: 'global', projectId: null, createdAt: Date.now() }
    }
    const meta = this.data.tickets[id]
    Object.assign(meta, patch || {}, { updatedAt: Date.now() })
    this.save()
    return meta
  }

  ticketMetas() {
    if (this.sqliteRuntime) {
      return this.sqliteRuntime.adapter.records({ includeArchived: true })
        .map(record => record.meta).filter(Boolean)
    }
    return Object.values(this.data.tickets)
  }

  addRequest(request) {
    this.data.requests[request.requestId] = clone(request)
    this.save()
    return this.data.requests[request.requestId]
  }

  request(requestId) {
    return this.data.requests[String(requestId)] || null
  }

  setWorkOrder(ticketId, workOrder) {
    this.data.workOrders[String(ticketId)] = clone(workOrder)
    this.save()
    return this.data.workOrders[String(ticketId)]
  }

  workOrder(ticketId) {
    return this.data.workOrders[String(ticketId)] || null
  }

  addReport(report) {
    this.data.reports.push(clone(report))
    if (this.data.reports.length > 2000) this.data.reports.splice(0, this.data.reports.length - 2000)
    this.save()
    return report
  }

  reportsFor(ticketId, limit = 20) {
    const id = String(ticketId)
    return this.data.reports.filter(item => String(item.ticketId) === id).slice(-limit)
  }

  addInbox(entry) {
    this.data.inbox.push(clone(entry))
    if (this.data.inbox.length > 2000) this.data.inbox.splice(0, this.data.inbox.length - 2000)
    this.save()
    return entry
  }

  pendingInbox(ticketId, workerId) {
    const id = String(ticketId)
    const worker = String(workerId)
    return this.data.inbox.filter(item => String(item.ticketId) === id && String(item.workerId || '') === worker && !item.deliveredAt && !item.discardedAt)
  }

  /**
   * Discard every undelivered steering item for one ticket. The entries are
   * kept (with discardedAt/reason) instead of deleted so the audit trail still
   * answers "was anything queued when the ticket was stopped?". pendingInbox
   * filters them out, so a stopped ticket can never receive a late steer.
   */
  discardInboxForTicket(ticketId, { reason = 'ticket cancelled', by = '', at = Date.now() } = {}) {
    const id = String(ticketId)
    let changed = 0
    for (const item of this.data.inbox) {
      if (String(item.ticketId) !== id || item.deliveredAt || item.discardedAt) continue
      item.discardedAt = at
      item.discardedReason = String(reason)
      if (by) item.discardedBy = String(by)
      changed += 1
    }
    if (changed) this.save()
    return changed
  }

  /** Persist a soft-stop request so the worker's next pre-step can end it. */
  requestWorkerStop(sessionId, stop = {}) {
    const id = String(sessionId)
    const worker = this.data.workers[id]
    if (!worker) return null
    worker.stopRequest = {
      ticketId: String(stop.ticketId || ''),
      reason: String(stop.reason || ''),
      at: Number.isFinite(stop.at) ? stop.at : Date.now(),
      hardAbort: Boolean(stop.hardAbort),
      noticedAt: null,
    }
    this.save()
    return worker.stopRequest
  }

  workerStop(sessionId) {
    const worker = this.data.workers[String(sessionId)]
    return worker && worker.stopRequest ? worker.stopRequest : null
  }

  markWorkerStopNoticed(sessionId, at = Date.now()) {
    const worker = this.data.workers[String(sessionId)]
    if (!worker || !worker.stopRequest) return null
    worker.stopRequest.noticedAt = at
    this.save()
    return worker.stopRequest
  }

  clearWorkerStop(sessionId) {
    const worker = this.data.workers[String(sessionId)]
    if (!worker || !worker.stopRequest) return false
    delete worker.stopRequest
    this.save()
    return true
  }

  addLessonCandidate(candidate) {
    this.data.lessonCandidates.push(clone(candidate))
    if (this.data.lessonCandidates.length > 200) this.data.lessonCandidates.splice(0, this.data.lessonCandidates.length - 200)
    this.save()
    return candidate
  }

  lessonCandidates({ status = 'candidate' } = {}) {
    return this.data.lessonCandidates.filter(item => !status || item.status === status)
  }

  lessonCandidate(id) {
    return this.data.lessonCandidates.find(item => String(item.id) === String(id)) || null
  }

  updateLessonCandidate(id, patch = {}) {
    const item = this.lessonCandidate(id)
    if (!item) return null
    Object.assign(item, patch, { updatedAt: Date.now() })
    this.save()
    return item
  }

  markInboxDelivered(ids, at = Date.now(), delivery = {}) {
    const set = new Set((ids || []).map(String))
    let changed = false
    for (const item of this.data.inbox) {
      if (set.has(String(item.id)) && !item.deliveredAt) {
        item.deliveredAt = at
        Object.assign(item, delivery)
        changed = true
      }
    }
    if (changed) this.save()
  }
}
