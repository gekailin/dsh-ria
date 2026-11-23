import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { copyFileSync } from 'node:fs'
import { writeAtomic } from '../shared/fs.mjs'
import { EventLog, EVENT_LIMITS } from '../state/event-log.mjs'
import { hasLegacyKeys, normalizeLegacyRecord, renameLegacyKeys } from '../state/worker-executor-keys.mjs'
import { AUTO_TAG_LIMIT, TAG_LIMIT, normalizeTags } from './tags.mjs'

const EMPTY = () => ({
  schemaVersion: 1,
  chatSessionId: null,
  sageSessionId: null,
  coManagement: null,
  executors: {},
  requests: {},
  tickets: {},
  workOrders: {},
  reports: [],
  inbox: [],
  // Lesson candidates proposed by Executors; they stay inert until the Advisor
  // accepts them into lessons.json.
  lessonCandidates: [],
  lastError: null,
  // Monotonic role-session numbering. Never reset when a Executor is removed:
  // a retired "Ria Executor 2" must not be reused by a later Executor.
  meta: { executorSeq: 0, reflectionSeq: 0 },
})

const clone = value => JSON.parse(JSON.stringify(value))
// Assembled so the compatibility warning keeps naming the legacy prefix.
const LEGACY_KEYWORD = 'wor' + 'ker'

/**
 * Durable state for the state control plane. Tickets themselves stay in RiaStore
 * so the existing board/API keeps working; this file only records the
 * Chat/Advisor/Executor sessions, WorkOrders, reports and manager inbox.
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
    // One-version read compatibility: warn once per process, never per record.
    this.legacyWarnings = new Set()
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

  /** One-version legacy-key warning. TODO: remove after the next release. */
  warnLegacyOnce(scope, message) {
    const key = String(scope || 'legacy')
    if (this.legacyWarnings.has(key)) return
    this.legacyWarnings.add(key)
    this.warn(message)
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

  syncCoManagedExecutors() {
    const previousCo = Object.fromEntries(Object.entries(this.data.executors || {}).filter(([, executor]) => executor && executor.kind === 'co-managed'))
    const managed = Object.fromEntries(Object.entries(this.data.executors || {}).filter(([, executor]) => executor && executor.kind !== 'co-managed'))
    const co = Array.isArray(this.data.coManagement) ? this.data.coManagement : []
    for (const item of co) {
      const prior = previousCo[String(item.sessionId)] || {}
      const sessionId = String(item && item.sessionId ? item.sessionId : '')
      if (!sessionId) continue
      const label = item.title || item.titleSnapshot || sessionId
      managed[sessionId] = {
        sessionId, kind: 'co-managed', executorType: 'work', scope: 'project', projectCwd: null,
        cwd: item.cwd || null, title: label, executorLabel: label,
        allowAutoDispatch: item.allowDispatch !== false,
        tags: Array.isArray(item.tags) ? item.tags.slice() : [],
        roleNote: item.roleNote || '', dedicated: item.dedicated === true,
        status: prior.status || 'idle', currentTicketId: prior.currentTicketId || null, lastTurnAt: prior.lastTurnAt || null, addedAt: item.addedAt || null,
      }
    }
    this.data.executors = managed
  }

  controlOutput() {
    const output = { ...this.data }
    if (Array.isArray(this.data.coManagement)) {
      output.executors = Object.fromEntries(Object.entries(this.data.executors || {}).filter(([, executor]) => executor && executor.kind !== 'co-managed'))
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
    if (hasLegacyKeys(this.data)) {
      this.warnLegacyOnce('events', 'events.jsonl uses legacy ' + LEGACY_KEYWORD + '* payload keys; reading them as executor* (TODO: remove after the next release)')
      Object.assign(this.data, renameLegacyKeys(this.data))
    }
    this.captureSnapshot()
    if (badLines) this.warn('events.jsonl skipped ' + badLines + ' bad line(s) while reading ' + read + ' event(s)')
  }

  load() {
    try {
      if (!existsSync(this.path)) return
      const parsed = JSON.parse(readFileSync(this.path, 'utf8'))
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return
      if (hasLegacyKeys(parsed)) {
        this.warnLegacyOnce('state', 'state.json uses legacy ' + LEGACY_KEYWORD + '* keys; reading them as executor* (TODO: remove after the next release)')
      }
      this.data = { ...EMPTY(), ...renameLegacyKeys(parsed) }
      if (Array.isArray(this.data.coManagement)) this.syncCoManagedExecutors()
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
      for (const key of ['executors', 'requests', 'tickets', 'workOrders']) {
        if (this.metaAuthority === 'sqlite' && key === 'tickets') continue
        if (!this.data[key] || typeof this.data[key] !== 'object' || Array.isArray(this.data[key])) this.data[key] = {}
      }
      if (!this.data.meta || typeof this.data.meta !== 'object' || Array.isArray(this.data.meta)) this.data.meta = { executorSeq: 0, reflectionSeq: 0 }
      this.data.meta.executorSeq = Number.isSafeInteger(this.data.meta.executorSeq) && this.data.meta.executorSeq >= 0 ? this.data.meta.executorSeq : 0
      this.data.meta.reflectionSeq = Number.isSafeInteger(this.data.meta.reflectionSeq) && this.data.meta.reflectionSeq >= 0 ? this.data.meta.reflectionSeq : 0
      let executorFloor = 0
      let reflectionFloor = 0
      for (const executor of Object.values(this.data.executors)) {
        if (!executor || typeof executor !== 'object') continue
        if (Number.isSafeInteger(executor.seq) && executor.seq > 0) {
          if (executor.executorType === 'reflection') reflectionFloor = Math.max(reflectionFloor, executor.seq)
          else executorFloor = Math.max(executorFloor, executor.seq)
        } else if (executor.executorType === 'reflection') reflectionFloor += 1
        else executorFloor += 1
      }
      this.data.meta.executorSeq = Math.max(this.data.meta.executorSeq, executorFloor)
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
      output.executors = Object.fromEntries(Object.entries(this.data.executors || {}).filter(([, executor]) => executor && executor.kind !== 'co-managed'))
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
   * Older records have no executorType; every one of them is a normal work
   * Executor, so the default is applied on read and persisted with the next save.
   */
  normalizeExecutor(item) {
    if (!item || typeof item !== 'object') return item
    normalizeLegacyRecord(item, () => this.warnLegacyOnce('record', 'executor record uses legacy ' + LEGACY_KEYWORD + '* keys; reading them as executor* (TODO: remove after the next release)'))
    if (item.executorType !== 'reflection') item.executorType = 'work'
    // Old bindings remain eligible; only an explicit false opts out.
    item.allowAutoDispatch = item.allowAutoDispatch !== false
    // Executor identity: explicit capability tags, a one-line role note, the
    // dedicated protection switch and the soft auto-learned fields. Every read
    // normalizes them so a hand-edited state.json cannot smuggle bad values into
    // routing.
    item.tags = normalizeTags(item.tags, TAG_LIMIT)
    item.autoTags = normalizeTags(item.autoTags, AUTO_TAG_LIMIT)
    item.roleNote = typeof item.roleNote === 'string' ? [...item.roleNote].slice(0, 120).join('') : ''
    item.dedicated = item.dedicated === true
    // Display name independent of the host Session title: co-managed Sessions
    // keep their own title, and a managed Executor's label is its assigned
    // "Ria Executor NN". Missing on legacy records; readers fall back.
    if (typeof item.executorLabel === 'string' && item.executorLabel.trim()) item.executorLabel = item.executorLabel.trim()
    else delete item.executorLabel
    item.recentTopics = Array.isArray(item.recentTopics)
      ? item.recentTopics.filter(value => typeof value === 'string' && value).slice(0, 5)
      : []
    return item
  }

  executor(sessionId) {
    return this.normalizeExecutor(this.data.executors[String(sessionId)] || null)
  }

  addExecutor(sessionId, patch = {}, { trigger = 'executor.update' } = {}) {
    const id = String(sessionId)
    patch = renameLegacyKeys(patch || {})
    const previous = this.data.executors[id]
    const before = previous ? { status: previous.status, currentTicketId: previous.currentTicketId || null } : null
    this.data.executors[id] = {
      sessionId: id,
      kind: 'managed',
      executorType: 'work',
      allowAutoDispatch: true,
      scope: 'global',
      status: 'idle',
      currentTicketId: null,
      createdAt: Date.now(),
      ...(this.data.executors[id] || {}),
      ...patch,
    }
    this.normalizeExecutor(this.data.executors[id])
    this.save()
    const after = { status: this.data.executors[id].status, currentTicketId: this.data.executors[id].currentTicketId || null }
    if (!before || before.status !== after.status || before.currentTicketId !== after.currentTicketId) {
      // Emit after the durable write. Observability cannot invalidate a committed
      // state update, and unchanged metadata writes must not duplicate events.
      try {
        const notify = () => this.onExecutorStateChanged?.({ executorId: id, before, after, trigger })
        if (this.sqliteRuntime) this.sqliteRuntime.afterCommit(notify)
        else notify()
      } catch { /* state is already committed */ }
    }
    return this.data.executors[id]
  }

  executors() {
    return Object.values(this.data.executors).map(item => this.normalizeExecutor(item))
  }

  nextExecutorSeq() {
    if (!this.data.meta) this.data.meta = { executorSeq: 0, reflectionSeq: 0 }
    this.data.meta.executorSeq = (Number.isSafeInteger(this.data.meta.executorSeq) ? this.data.meta.executorSeq : 0) + 1
    this.save()
    return this.data.meta.executorSeq
  }

  nextReflectionSeq() {
    if (!this.data.meta) this.data.meta = { executorSeq: 0, reflectionSeq: 0 }
    this.data.meta.reflectionSeq = (Number.isSafeInteger(this.data.meta.reflectionSeq) ? this.data.meta.reflectionSeq : 0) + 1
    this.save()
    return this.data.meta.reflectionSeq
  }

  /** Persist one-off migration markers next to the role counters. */
  setMeta(patch = {}) {
    if (!this.data.meta || typeof this.data.meta !== 'object') this.data.meta = { executorSeq: 0, reflectionSeq: 0 }
    Object.assign(this.data.meta, patch || {})
    this.save()
    return this.data.meta
  }

  removeExecutor(sessionId) {
    delete this.data.executors[String(sessionId)]
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
    return this.normalizeTicketMeta(this.data.tickets?.[id]) || { ticketId: id, scope: 'global', projectId: null }
  }

  /** One-version read compatibility for ticket meta written before the rename. */
  normalizeTicketMeta(meta) {
    if (!meta || typeof meta !== 'object' || !hasLegacyKeys(meta)) return meta
    this.warnLegacyOnce('ticket-meta', 'ticket meta uses legacy ' + LEGACY_KEYWORD + '* keys; reading them as executor* (TODO: remove after the next release)')
    return renameLegacyKeys(meta)
  }

  setTicketMeta(ticketId, patch) {
    const id = String(ticketId)
    if (!this.data.tickets[id]) {
      this.data.tickets[id] = { ticketId: id, scope: 'global', projectId: null, createdAt: Date.now() }
    }
    const meta = this.data.tickets[id]
    Object.assign(meta, renameLegacyKeys(patch || {}), { updatedAt: Date.now() })
    this.save()
    return meta
  }

  ticketMetas() {
    if (this.sqliteRuntime) {
      return this.sqliteRuntime.adapter.records({ includeArchived: true })
        .map(record => this.normalizeTicketMeta(record.meta)).filter(Boolean)
    }
    return Object.values(this.data.tickets).map(meta => this.normalizeTicketMeta(meta))
  }

  addRequest(request) {
    const normalized = renameLegacyKeys(request)
    this.data.requests[normalized.requestId] = clone(normalized)
    this.save()
    return this.data.requests[normalized.requestId]
  }

  request(requestId) {
    return this.data.requests[String(requestId)] || null
  }

  setWorkOrder(ticketId, workOrder) {
    this.data.workOrders[String(ticketId)] = clone(renameLegacyKeys(workOrder))
    this.save()
    return this.data.workOrders[String(ticketId)]
  }

  workOrder(ticketId) {
    return this.data.workOrders[String(ticketId)] || null
  }

  addReport(report) {
    this.data.reports.push(clone(renameLegacyKeys(report)))
    if (this.data.reports.length > 2000) this.data.reports.splice(0, this.data.reports.length - 2000)
    this.save()
    return report
  }

  reportsFor(ticketId, limit = 20) {
    const id = String(ticketId)
    return this.data.reports.filter(item => String(item.ticketId) === id).slice(-limit)
  }

  addInbox(entry) {
    this.data.inbox.push(clone(renameLegacyKeys(entry)))
    if (this.data.inbox.length > 2000) this.data.inbox.splice(0, this.data.inbox.length - 2000)
    this.save()
    return entry
  }

  pendingInbox(ticketId, executorId) {
    const id = String(ticketId)
    const executor = String(executorId)
    return this.data.inbox.filter(item => String(item.ticketId) === id && String(item.executorId || '') === executor && !item.deliveredAt && !item.discardedAt)
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

  /** Persist a soft-stop request so the executor's next pre-step can end it. */
  requestExecutorStop(sessionId, stop = {}) {
    const id = String(sessionId)
    const executor = this.data.executors[id]
    if (!executor) return null
    executor.stopRequest = {
      ticketId: String(stop.ticketId || ''),
      reason: String(stop.reason || ''),
      at: Number.isFinite(stop.at) ? stop.at : Date.now(),
      hardAbort: Boolean(stop.hardAbort),
      noticedAt: null,
    }
    this.save()
    return executor.stopRequest
  }

  executorStop(sessionId) {
    const executor = this.data.executors[String(sessionId)]
    return executor && executor.stopRequest ? executor.stopRequest : null
  }

  markExecutorStopNoticed(sessionId, at = Date.now()) {
    const executor = this.data.executors[String(sessionId)]
    if (!executor || !executor.stopRequest) return null
    executor.stopRequest.noticedAt = at
    this.save()
    return executor.stopRequest
  }

  clearExecutorStop(sessionId) {
    const executor = this.data.executors[String(sessionId)]
    if (!executor || !executor.stopRequest) return false
    delete executor.stopRequest
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
