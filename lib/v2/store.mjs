import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const EMPTY = () => ({
  schemaVersion: 1,
  chatbotSessionId: null,
  sageSessionId: null,
  sageIndexVersion: null,
  advisorMode: 'stateless',
  advisors: {},
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
 * Durable state for the v2 control plane. Tickets themselves stay in RiaStore
 * so the existing board/API keeps working; this file only records the
 * Chatbot/Advisor/Worker sessions, WorkOrders, reports and manager inbox.
 */
export class V2Store {
  constructor(stateDir) {
    this.stateDir = stateDir
    this.path = join(stateDir, 'v2.json')
    this.data = EMPTY()
    this.load()
  }

  load() {
    try {
      if (!existsSync(this.path)) return
      const parsed = JSON.parse(readFileSync(this.path, 'utf8'))
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return
      this.data = { ...EMPTY(), ...parsed }
      // 旧称 Thinker（已改名 Advisor）。Older v2.json files stored the binding
      // under "thinkers"; read that field once so an upgrade never drops an
      // existing session. The next save writes only "advisors", which is the
      // migration; the legacy key is never written back.
      const legacyAdvisors = parsed.thinkers && typeof parsed.thinkers === 'object' && !Array.isArray(parsed.thinkers)
        ? parsed.thinkers
        : null
      if (legacyAdvisors && (!parsed.advisors || typeof parsed.advisors !== 'object' || Array.isArray(parsed.advisors))) {
        this.data.advisors = legacyAdvisors
      }
      delete this.data.thinkers
      if (this.data.sageSessionId !== null && typeof this.data.sageSessionId !== 'string') this.data.sageSessionId = null
      if (this.data.sageIndexVersion !== null && typeof this.data.sageIndexVersion !== 'string') this.data.sageIndexVersion = null
      this.data.advisorMode = this.data.advisorMode === 'legacy' ? 'legacy' : 'stateless'
      for (const key of ['advisors', 'workers', 'requests', 'tickets', 'workOrders']) {
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
      // Older v2.json files have no candidate list; that is not an error.
      if (!Array.isArray(this.data.lessonCandidates)) this.data.lessonCandidates = []
      this.data.lessonCandidates = this.data.lessonCandidates.filter(item => item && typeof item === 'object').slice(-200)
      if (this.data.lastError !== null && (typeof this.data.lastError !== 'object' || Array.isArray(this.data.lastError))) {
        this.data.lastError = null
      }
      // Ticket metadata written before the rename still says phase "thinker".
      for (const meta of Object.values(this.data.tickets)) {
        if (meta && typeof meta === 'object' && meta.phase === 'thinker') meta.phase = 'advisor'
      }
    } catch {
      // A damaged sidecar must not prevent the plugin from starting. Tickets are
      // still recoverable from ria.json; the next write replaces this file.
      this.data = EMPTY()
    }
  }

  save() {
    mkdirSync(dirname(this.path), { recursive: true })
    const tmp = this.path + '.tmp-' + process.pid
    writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 })
    renameSync(tmp, this.path)
  }

  get chatbotSessionId() {
    return this.data.chatbotSessionId || null
  }

  setChatbot(sessionId) {
    this.data.chatbotSessionId = String(sessionId)
    this.save()
  }

  get sageSessionId() {
    return this.data.sageSessionId || null
  }

  setSage(sessionId) {
    this.data.sageSessionId = String(sessionId)
    this.save()
  }

  get sageIndexVersion() {
    return this.data.sageIndexVersion || null
  }

  setSageIndexVersion(version) {
    this.data.sageIndexVersion = version ? String(version) : null
    this.save()
  }

  clearSage(sessionId) {
    if (this.data.sageSessionId === String(sessionId)) {
      this.data.sageSessionId = null
      this.save()
    }
  }

  setAdvisorMode(mode) {
    this.data.advisorMode = mode === 'legacy' ? 'legacy' : 'stateless'
    this.save()
    return this.data.advisorMode
  }

  /**
   * Persist the last role/startup failure so a restart can explain why the
   * Chatbot is missing instead of silently sending inbound messages to a
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
    if (scope && String(this.data.lastError.scope) !== String(scope)) return
    this.data.lastError = null
    this.save()
  }

  clearChatbot(sessionId) {
    if (this.data.chatbotSessionId === String(sessionId)) {
      this.data.chatbotSessionId = null
      this.save()
    }
  }

  advisor(scope = 'global') {
    return this.data.advisors[scope] || null
  }

  setAdvisor(scope, sessionId, extra = {}) {
    this.data.advisors[scope] = { scope, sessionId: String(sessionId), createdAt: Date.now(), ...extra }
    this.save()
  }

  clearAdvisor(scope, sessionId) {
    const current = this.data.advisors[scope]
    if (current && String(current.sessionId) === String(sessionId)) {
      delete this.data.advisors[scope]
      this.save()
    }
  }

  advisors() {
    return Object.values(this.data.advisors)
  }

  /**
   * Older records have no workerType; every one of them is a normal work
   * Worker, so the default is applied on read and persisted with the next save.
   */
  normalizeWorker(item) {
    if (!item || typeof item !== 'object') return item
    if (item.workerType !== 'reflection') item.workerType = 'work'
    return item
  }

  worker(sessionId) {
    return this.normalizeWorker(this.data.workers[String(sessionId)] || null)
  }

  addWorker(sessionId, patch = {}) {
    const id = String(sessionId)
    this.data.workers[id] = {
      sessionId: id,
      kind: 'managed',
      workerType: 'work',
      scope: 'global',
      status: 'idle',
      createdAt: Date.now(),
      ...(this.data.workers[id] || {}),
      ...patch,
    }
    this.normalizeWorker(this.data.workers[id])
    this.save()
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

  removeWorker(sessionId) {
    delete this.data.workers[String(sessionId)]
    this.save()
  }

  ticketMeta(ticketId) {
    const id = String(ticketId)
    // Reading a legacy ticket must not enroll it in v2 startup recovery.
    // Only setTicketMeta() creates a durable entry.
    return this.data.tickets[id] || { ticketId: id, scope: 'global', projectId: null }
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
    return this.data.inbox.filter(item => String(item.ticketId) === id && String(item.workerId || '') === worker && !item.deliveredAt)
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

  markInboxDelivered(ids, at = Date.now()) {
    const set = new Set((ids || []).map(String))
    let changed = false
    for (const item of this.data.inbox) {
      if (set.has(String(item.id)) && !item.deliveredAt) {
        item.deliveredAt = at
        changed = true
      }
    }
    if (changed) this.save()
  }
}
