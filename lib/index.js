// dsh-ria host half.
//
// A globally unique Ria: an ordinary top-level DSH Session running the
// PTC preset, with a manager prompt and seven ria_* tools installed on its
// Agent. She relays ordinary user messages to worker sessions and keeps her
// own task/delivery state in DSH_HOME/state/ria/ria.json.

import { randomUUID } from 'node:crypto'
import { accessSync, closeSync, constants as fsConstants, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { ApprovalObserver } from './approvals.mjs'
import { lastTurnEnd } from './turn-end.mjs'
import { ACTIVE_STATUSES, FEEDBACK_BODY_LIMIT, FEEDBACK_DEDUPE_MS, MAX_RECOVERY_ATTEMPTS as TICKET_MAX_RECOVERY_ATTEMPTS, TICKET_STATUSES, TERMINAL_STATUSES, WAITING_ON_BY_STATUS, assertTicketInvariants, canTransition, isTerminal, migrateV1State, normalizeTicket, transitionError } from './tickets.mjs'
import { DispatchGuard } from './dispatch-guard.mjs'
import { APPROVAL_POLICIES, GrantService, SANDBOX_MODES, publicGrant } from './grants.mjs'
import { HOST_REQUEST_PREFIX, isHostRequestId } from './wechat/request-ids.mjs'
import { WechatService } from './wechat/service.mjs'
import { WorkerIdleWatcher } from './worker-idle.mjs'

export const name = 'dsh-ria'
export const inject = ['webServer', 'sessionController', 'workspaceRegistry', 'sandboxPolicy', 'approval', 'agents']

const RIA_PRESET = 'ptc'
const API_PREFIX = '/plugins/dsh-ria/api'
const MEMORY_LIMIT = 4096
const TASK_STATUSES = ['open', 'working', 'blocked', 'done', 'cancelled']
const MAX_RECOVERY_ATTEMPTS = TICKET_MAX_RECOVERY_ATTEMPTS
const IN_FLIGHT_MESSAGE_LIMIT = 500
const IN_FLIGHT_PHASE_LIMIT = 80
const DISPATCH_NOTE_LIMIT = 500
const DISPATCH_NOTE_HISTORY = 100
const RECENT_WORKER_WINDOW_MS = 7 * 24 * 60 * 60 * 1000
const RECENT_WORKER_RETENTION_MS = 30 * 24 * 60 * 60 * 1000
const RECENT_WORKER_LIMIT = 5
const ATTACHMENT_LIMIT = 20

function recoveryLimitReason() {
  return '自动恢复已达上限（' + MAX_RECOVERY_ATTEMPTS + '/' + MAX_RECOVERY_ATTEMPTS + '），需要用户手动处理'
}
const dshHome = () => process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')
const now = () => Date.now()
const newId = prefix => prefix + now().toString(36) + '_' + randomUUID().replace(/-/g, '').slice(0, 10)
const asString = value => typeof value === 'string' ? value.trim() : ''

function clipText(text, limit) {
  const chars = [...String(text)]
  return chars.length > limit ? chars.slice(0, limit).join('') : String(text)
}

function formatStartedAt(value) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return String(value)
  try {
    return date.toLocaleString('zh-CN', { hour12: false })
  } catch {
    return date.toISOString()
  }
}

function imageMediaType(bytes) {
  if (!bytes || bytes.length < 12) return undefined
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png'
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (bytes.slice(0, 6).toString('latin1') === 'GIF87a' || bytes.slice(0, 6).toString('latin1') === 'GIF89a') return 'image/gif'
  if (bytes.slice(0, 4).toString('latin1') === 'RIFF' && bytes.slice(8, 12).toString('latin1') === 'WEBP') return 'image/webp'
  return undefined
}

function ensureDir(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
}

function readText(file) {
  try {
    return readFileSync(file, 'utf8')
  } catch (error) {
    if (error && error.code === 'ENOENT') return ''
    throw error
  }
}

function writeAtomic(file, text) {
  ensureDir(dirname(file))
  const temp = file + '.' + process.pid + '.' + randomUUID().slice(0, 8) + '.tmp'
  const fd = openSync(temp, 'w', 0o600)
  try {
    writeSync(fd, text)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameSync(temp, file)
}

function textOfContent(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map(part => {
    if (!part || typeof part !== 'object') return ''
    if (part.type === 'text') return typeof part.text === 'string' ? part.text : ''
    if (part.type === 'image') return '[image]'
    if (part.type === 'file') return '[file' + (part.name ? ' ' + part.name : '') + ']'
    if (part.type === 'tool-call') return '[tool ' + (part.name || 'call') + ']'
    return ''
  }).filter(Boolean).join('\n')
}

function recordMessage(record) {
  if (!record || typeof record !== 'object') return undefined
  // sessionController.events() pages wire records as { type: 'event', event }.
  // Live snapshotEvents() returns the event itself, so accept both shapes.
  const event = record.type === 'event' && record.event && typeof record.event === 'object' ? record.event : record
  const data = event.data && typeof event.data === 'object' ? event.data : event
  let role = 'event'
  let content
  if (event.type === 'user/message') {
    role = 'user'
    content = data.content
  } else if (event.type === 'assistant/message') {
    role = 'assistant'
    content = data.message && data.message.content ? data.message.content : data.content
  } else if (event.type === 'tool/result') {
    role = 'tool'
    content = data.content
  } else {
    return undefined
  }
  const text = textOfContent(content).trim()
  if (!text) return undefined
  return {
    seq: typeof event.seq === 'number' ? event.seq : undefined,
    at: typeof event.at === 'number' ? event.at : (typeof event.time === 'number' ? event.time : undefined),
    role,
    text,
  }
}

function taskSummary(ticket) {
  return {
    ticketId: ticket.ticketId,
    taskId: ticket.ticketId,
    goal: ticket.goal,
    acceptance: ticket.acceptance,
    executor: ticket.executor,
    status: ticket.status,
    waitingOn: ticket.waitingOn,
    blockedReason: ticket.blockedReason || '',
    parentTicketId: ticket.parentTicketId || null,
    childTicketIds: Array.isArray(ticket.childTicketIds) ? [...ticket.childTicketIds] : [],
    resolution: ticket.resolution || null,
    failure: ticket.failure || null,
    attempts: Array.isArray(ticket.attempts) ? ticket.attempts.length : 0,
    createdAt: ticket.createdAt,
    updatedAt: ticket.updatedAt,
    closedAt: ticket.closedAt || null,
    recoveryCount: ticket.recovery ? ticket.recovery.count : 0,
    revision: ticket.revision,
  }
}

function recoveryCountOf(ticket) {
  if (!ticket) return 0
  if (ticket.recovery && typeof ticket.recovery.count === 'number') return ticket.recovery.count
  return typeof ticket.recoveryCount === 'number' ? ticket.recoveryCount : 0
}

function sessionTitle(summary) {
  const title = summary && summary.projections && summary.projections.values
    ? summary.projections.values.title
    : undefined
  return typeof title === 'string' ? title.trim() : ''
}

function lastTurnNumber(session) {
  if (!session || typeof session.snapshotEvents !== 'function') return undefined
  const events = session.snapshotEvents()
  if (!Array.isArray(events)) return undefined
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event && event.type === 'turn/start' && Number.isSafeInteger(event.data && event.data.turn)) {
      return event.data.turn
    }
  }
  return undefined
}

class RiaStore {
  constructor(stateDir) {
    this.stateDir = stateDir
    this.file = join(stateDir, 'ria.json')
    this.data = {
      schemaVersion: 2,
      version: 2,
      riaSessionId: undefined,
      riaPreset: undefined,
      createdAt: undefined,
      tickets: [],
      ticketFeedback: [],
      inFlight: undefined,
      deliveries: [],
      grants: [],
      recentWorkers: {},
      settings: { dispatchGuard: true, progressCards: false },
    }
    this.load()
  }

  load() {
    ensureDir(this.stateDir)
    const raw = readText(this.file)
    if (!raw.trim()) return
    try {
      const parsed = JSON.parse(raw)
      if (!parsed || typeof parsed !== 'object') return
      let data
      let migrated = false
      if (parsed.schemaVersion === 2 || parsed.version === 2) {
        data = parsed
      } else {
        const result = migrateV1State(parsed)
        data = result.data
        migrated = true
        // Keep the exact v1 bytes next to the new file before the first save.
        try {
          writeAtomic(this.file + '.v1.bak', raw)
        } catch {
          // A backup failure is not a reason to lose the migrated state.
        }
      }
      this.data.schemaVersion = 2
      this.data.version = 2
      this.data.riaSessionId = typeof data.riaSessionId === 'string' ? data.riaSessionId : undefined
      this.data.riaPreset = typeof data.riaPreset === 'string' ? data.riaPreset : undefined
      this.data.createdAt = Number.isFinite(data.createdAt) ? data.createdAt : undefined
      this.data.tickets = Array.isArray(data.tickets)
        ? data.tickets.map(item => normalizeTicket(item)).filter(Boolean)
        : []
      this.data.ticketFeedback = Array.isArray(data.ticketFeedback)
        ? data.ticketFeedback.filter(item => item && typeof item === 'object' && typeof item.feedbackId === 'string' && typeof item.kind === 'string')
        : []
      this.data.inFlight = data.inFlight && typeof data.inFlight === 'object' ? { ...data.inFlight } : undefined
      this.data.deliveries = Array.isArray(data.deliveries) ? data.deliveries.filter(item => item && typeof item.deliveryId === 'string') : []
      this.data.grants = Array.isArray(data.grants) ? data.grants.filter(item => item && typeof item.grantId === 'string') : []
      const recent = data.recentWorkers && typeof data.recentWorkers === 'object' ? data.recentWorkers : {}
      this.data.recentWorkers = {}
      for (const [id, value] of Object.entries(recent)) {
        if (!id || !value || typeof value !== 'object') continue
        const lastUsedAt = typeof value.lastUsedAt === 'number' && Number.isFinite(value.lastUsedAt) ? value.lastUsedAt : 0
        if (lastUsedAt <= 0) continue
        const record = { lastUsedAt }
        if (typeof value.lastTaskId === 'string' && value.lastTaskId) record.lastTaskId = value.lastTaskId
        this.data.recentWorkers[id] = record
      }
      const settings = data.settings && typeof data.settings === 'object' ? data.settings : {}
      this.data.settings.dispatchGuard = typeof settings.dispatchGuard === 'boolean' ? settings.dispatchGuard : true
      this.data.settings.progressCards = typeof settings.progressCards === 'boolean' ? settings.progressCards : false
      if (migrated) this.save()
    } catch {
      // A corrupt state file must not stop DSH from starting. Keep the file for inspection.
    }
  }

  save() {
    writeAtomic(this.file, JSON.stringify(this.data, null, 2) + '\n')
  }

  get riaSessionId() { return this.data.riaSessionId }
  get riaPreset() { return this.data.riaPreset }

  settings() { return { dispatchGuard: this.data.settings.dispatchGuard, progressCards: this.data.settings.progressCards } }

  setDispatchGuard(enabled) {
    this.data.settings.dispatchGuard = Boolean(enabled)
    this.save()
    return this.settings()
  }

  setRia(sessionId, preset) {
    this.data.riaSessionId = sessionId
    this.data.riaPreset = preset
    this.data.createdAt = this.data.createdAt || now()
    this.save()
  }

  recentWorkers() { return this.data.recentWorkers }
  recentWorker(sessionId) { return this.data.recentWorkers[String(sessionId)] }

  touchWorker(sessionId, taskId) {
    const id = String(sessionId)
    if (!id) return undefined
    const record = this.data.recentWorkers[id] || { lastUsedAt: 0 }
    record.lastUsedAt = now()
    if (taskId) record.lastTaskId = String(taskId)
    this.data.recentWorkers[id] = record
    const cutoff = record.lastUsedAt - RECENT_WORKER_RETENTION_MS
    for (const [key, value] of Object.entries(this.data.recentWorkers)) {
      if (!value || typeof value.lastUsedAt !== 'number' || value.lastUsedAt < cutoff) delete this.data.recentWorkers[key]
    }
    this.save()
    return record
  }

  recordDispatchNote(input) {
    const turn = input && input.turn
    if (!Number.isSafeInteger(turn) || turn < 0) return undefined
    const sessionId = asString(input.sessionId)
    const note = typeof input.note === 'string' ? input.note.trim() : ''
    if (!sessionId || !note) return undefined
    const record = {
      noteId: newId('note_'),
      sessionId,
      turn,
      note,
      isTask: Boolean(input.isTask),
      at: now(),
    }
    if (typeof input.taskId === 'string' && input.taskId) record.taskId = input.taskId
    if (!Array.isArray(this.data.dispatchNotes)) this.data.dispatchNotes = []
    this.data.dispatchNotes.push(record)
    if (this.data.dispatchNotes.length > DISPATCH_NOTE_HISTORY) {
      this.data.dispatchNotes.splice(0, this.data.dispatchNotes.length - DISPATCH_NOTE_HISTORY)
    }
    this.save()
    return record
  }

  dispatchNotes(sessionId) {
    const id = String(sessionId)
    return this.data.dispatchNotes
      .filter(item => item.sessionId === id && Number.isSafeInteger(item.turn))
      .map(item => {
        const result = {
          noteId: item.noteId,
          sessionId: item.sessionId,
          turn: item.turn,
          note: item.note,
          isTask: Boolean(item.isTask),
          at: item.at,
        }
        if (typeof item.taskId === 'string' && item.taskId) result.taskId = item.taskId
        return result
      })
  }

  tickets() { return this.data.tickets }
  activeTickets() { return this.data.tickets.filter(ticket => ACTIVE_STATUSES.includes(ticket.status)) }
  ticket(ticketId) { return this.data.tickets.find(ticket => ticket.ticketId === ticketId) }
  // Legacy names used by the approval, grant, and idle helpers during the
  // transition to tickets. They are aliases, not a second source of truth.
  tasks() { return this.tickets() }
  task(taskId) { return this.ticket(taskId) }
  activeTasks() { return this.activeTickets() }

  addTicket(input) {
    const at = now()
    const status = input.status || 'open'
    if (!TICKET_STATUSES.includes(status)) throw transitionError('invalid_status', 'invalid ticket status: ' + status)
    const ticket = normalizeTicket({
      ticketId: newId('task_'),
      status,
      goal: input.goal,
      acceptance: input.acceptance || '',
      executor: input.executor,
      waitingOn: input.waitingOn || WAITING_ON_BY_STATUS[status],
      origin: input.origin,
      parentTicketId: input.parentTicketId,
      rootTicketId: input.rootTicketId,
      forkDepth: input.forkDepth,
      childTicketIds: input.childTicketIds,
      dependsOn: input.dependsOn,
      fork: input.fork,
      blockedReason: input.blockedReason || '',
      resolution: input.resolution,
      failure: input.failure,
      createdAt: at,
      updatedAt: at,
      closedAt: isTerminal(status) ? at : null,
    }, at)
    if (!ticket) throw transitionError('invalid_ticket', 'could not create a ticket')
    if (ticket.status === 'working' && !ticket.attempt.lastRequestId) {
      ticket.attempt = { count: 0, lastRequestId: null, startedAt: null, legacy: true }
    }
    if (ticket.parentTicketId) {
      const parent = this.ticket(ticket.parentTicketId)
      if (!parent) throw transitionError('parent_missing', 'parent ticket not found: ' + ticket.parentTicketId)
      ticket.forkDepth = parent.forkDepth + 1
      ticket.rootTicketId = parent.rootTicketId || parent.ticketId
      if (!parent.childTicketIds.includes(ticket.ticketId)) parent.childTicketIds.push(ticket.ticketId)
      parent.revision += 1
      parent.updatedAt = at
    }
    assertTicketInvariants(ticket, this.data.tickets, at)
    this.data.tickets.push(ticket)
    this.save()
    return ticket
  }

  // Compatibility for the pre-ticket phase: create through addTicket.
  addTask(input) {
    return this.addTicket(input)
  }

  updateTicket(ticketId, patch, options = {}) {
    const ticket = this.ticket(ticketId)
    if (!ticket) return undefined
    if (options.expectedRevision !== undefined && options.expectedRevision !== ticket.revision) {
      throw transitionError('stale_revision', 'ticket ' + ticketId + ' changed since revision ' + options.expectedRevision)
    }
    const next = JSON.parse(JSON.stringify(ticket))
    if (patch.goal !== undefined) {
      const goal = asString(patch.goal)
      if (!goal) throw transitionError('invalid_goal', 'goal must not be empty')
      next.goal = goal
    }
    if (patch.acceptance !== undefined) next.acceptance = String(patch.acceptance)
    if (patch.executor !== undefined) {
      const executor = asString(patch.executor)
      if (!executor) throw transitionError('invalid_executor', 'executor must not be empty')
      next.executor = executor
    }
    if (patch.blockedReason !== undefined) next.blockedReason = String(patch.blockedReason)
    if (patch.progress !== undefined) next.progress = { ...next.progress, ...patch.progress }
    next.revision += 1
    next.updatedAt = now()
    assertTicketInvariants(next, this.data.tickets)
    Object.assign(ticket, next)
    this.save()
    return ticket
  }

  // Legacy updateTask: status changes go through transitionTicket, so a caller
  // cannot bypass T1-T28 even while the old tool name still exists.
  updateTask(ticketId, patch) {
    const ticket = this.ticket(ticketId)
    if (!ticket) return undefined
    let current = ticket
    if (patch.status !== undefined && patch.status !== ticket.status) {
      let target = patch.status
      // The old tool allowed blocked -> working directly. The ticket table
      // reaches working through open (T22 then T11); do that instead of
      // silently accepting an illegal edge.
      if (current.status === 'blocked' && target === 'working') {
        const reopened = this.transitionTicket(ticketId, 'open', { reason: 'legacy reopen before working' })
        if (!reopened.ok) throw transitionError(reopened.code, reopened.message)
        current = reopened.ticket
      }
      const options = { reason: 'legacy updateTask', blockedReason: patch.blockedReason }
      if (target === 'done') options.resolution = { kind: 'done', summary: patch.blockedReason || current.goal || 'done' }
      if (target === 'cancelled') options.resolution = { kind: 'cancelled', reason: patch.blockedReason || 'cancelled' }
      const moved = this.transitionTicket(ticketId, target, options)
      if (!moved.ok) throw transitionError(moved.code, moved.message)
      current = moved.ticket
    }
    const fields = { ...patch }
    delete fields.status
    delete fields.recoveryCount
    if (patch.blockedReason !== undefined && current.status === 'blocked') fields.blockedReason = patch.blockedReason
    current = this.updateTicket(ticketId, fields) || current
    if (patch.recoveryCount !== undefined) {
      current.recovery = { ...current.recovery, count: patch.recoveryCount }
      current.updatedAt = now()
      current.revision += 1
      this.save()
    }
    return current
  }

  transitionTicket(ticketId, to, options = {}) {
    const ticket = this.ticket(ticketId)
    if (!ticket) return { ok: false, code: 'ticket_missing', message: 'ticket not found: ' + ticketId }
    if (options.expectedRevision !== undefined && options.expectedRevision !== ticket.revision) {
      return { ok: false, code: 'stale_revision', message: 'ticket ' + ticketId + ' changed since revision ' + options.expectedRevision, ticket }
    }
    if (!TICKET_STATUSES.includes(to)) return { ok: false, code: 'invalid_status', message: 'invalid ticket status: ' + to, ticket }
    if (!canTransition(ticket.status, to)) {
      return { ok: false, code: 'invalid_transition', message: 'cannot move ticket ' + ticketId + ' from ' + ticket.status + ' to ' + to, ticket }
    }
    if (isTerminal(ticket.status) && to === 'open' && ticket.resolution && ticket.resolution.kind === 'merged') {
      return { ok: false, code: 'merge_irreversible', message: 'a merged ticket cannot be reopened', ticket }
    }
    const at = now()
    const next = JSON.parse(JSON.stringify(ticket))
    const from = next.status
    next.status = to
    next.waitingOn = options.waitingOn || WAITING_ON_BY_STATUS[to]
    if (options.executor !== undefined) next.executor = options.executor
    if (options.goal !== undefined) next.goal = String(options.goal)
    if (options.acceptance !== undefined) next.acceptance = String(options.acceptance)
    if (options.blockedReason !== undefined) next.blockedReason = String(options.blockedReason)
    if (options.resolution !== undefined) next.resolution = options.resolution
    if (options.failure !== undefined) next.failure = options.failure
    if (options.attempt !== undefined) next.attempt = { ...next.attempt, ...options.attempt }
    if (options.lastWorkerTurn !== undefined) next.lastWorkerTurn = options.lastWorkerTurn
    if (options.progress !== undefined) next.progress = { ...next.progress, ...options.progress }
    if (options.recovery !== undefined) next.recovery = { ...next.recovery, ...options.recovery }
    if (options.childTicketIds !== undefined) next.childTicketIds = [...new Set(options.childTicketIds)]
    if (options.parentTicketId !== undefined) next.parentTicketId = options.parentTicketId || null
    if (options.rootTicketId !== undefined) next.rootTicketId = options.rootTicketId
    if (options.forkDepth !== undefined) next.forkDepth = options.forkDepth
    if (options.reason !== undefined) next.lastTransitionReason = String(options.reason)
    if (next.parentTicketId) {
      const parent = this.ticket(next.parentTicketId)
      if (parent) {
        next.forkDepth = parent.forkDepth + 1
        next.rootTicketId = parent.rootTicketId
        if (!parent.childTicketIds.includes(next.ticketId)) parent.childTicketIds.push(next.ticketId)
        assertTicketInvariants(parent, this.data.tickets, at)
      }
    }
    if (isTerminal(to)) {
      next.closedAt = Number.isFinite(options.closedAt) ? options.closedAt : at
    }
    if (from === 'blocked' && to === 'open') next.blockedReason = ''
    if (isTerminal(from) && to === 'open') {
      next.closedAt = null
      next.failure = null
      next.resolution = null
      next.reopenCount += 1
    }
    next.history.push({ at, from, to, actor: options.actor || 'ria', ...(options.reason ? { reason: String(options.reason) } : {}) })
    next.revision += 1
    next.updatedAt = at
    try {
      assertTicketInvariants(next, this.data.tickets, at)
    } catch (error) {
      return { ok: false, code: error.code || 'invalid_ticket', message: error.message, ticket }
    }
    Object.assign(ticket, next)
    this.save()
    return { ok: true, ticket }
  }

  // Compatibility shim while the in-flight patch is still being retired.
  // The final P0 commit deletes these methods together with startup's in-flight
  // branch and rewrites recovery to scan unconverged tickets.
  inFlight() { return this.data.inFlight ? { ...this.data.inFlight } : undefined }
  setInFlight(input) {
    const turnId = Number(input && input.turnId)
    const lastUserMessage = typeof (input && input.lastUserMessage) === 'string' ? input.lastUserMessage.trim().slice(0, IN_FLIGHT_MESSAGE_LIMIT) : ''
    if (!Number.isSafeInteger(turnId) || turnId < 1 || !lastUserMessage) return undefined
    this.data.inFlight = {
      turnId,
      startedAt: Number.isFinite(input.startedAt) ? input.startedAt : now(),
      lastUserMessage,
      lastPhase: input.lastPhase === undefined ? undefined : String(input.lastPhase).slice(0, IN_FLIGHT_PHASE_LIMIT),
      recoveryCount: Number.isInteger(input.recoveryCount) && input.recoveryCount >= 0 ? input.recoveryCount : 0,
    }
    this.save()
    return { ...this.data.inFlight }
  }
  clearInFlight() {
    if (!this.data.inFlight) return false
    delete this.data.inFlight
    this.save()
    return true
  }

  bumpNudge(ticketId) {
    const ticket = this.ticket(ticketId)
    if (!ticket) return undefined
    ticket.nudgeCount += 1
    ticket.updatedAt = now()
    ticket.revision += 1
    this.save()
    return ticket
  }

  addFeedback(input) {
    const at = Number.isFinite(input.at) ? input.at : now()
    const body = [...String(input.body || '')].slice(0, FEEDBACK_BODY_LIMIT).join('')
    if (!body) return undefined
    const recent = this.data.ticketFeedback
      .filter(item => item.ticketId === input.ticketId && item.kind === input.kind && (item.code || '') === (input.code || '') && (item.workerTurn || 0) === (input.workerTurn || 0))
      .sort((a, b) => b.at - a.at)[0]
    if (recent && at - recent.at < FEEDBACK_DEDUPE_MS) return recent
    const record = {
      feedbackId: newId('fb_'),
      ticketId: input.ticketId,
      kind: input.kind,
      code: input.code || '',
      body,
      at,
      card: Boolean(input.card),
      mirror: Boolean(input.mirror),
    }
    if (Number.isSafeInteger(input.turn)) record.turn = input.turn
    if (Number.isSafeInteger(input.workerTurn)) record.workerTurn = input.workerTurn
    this.data.ticketFeedback.push(record)
    const ticket = this.ticket(input.ticketId)
    if (ticket) ticket.feedback = { lastAt: at, lastKind: input.kind }
    if (this.data.ticketFeedback.length > 1000) this.data.ticketFeedback.splice(0, this.data.ticketFeedback.length - 1000)
    this.save()
    return record
  }

  ticketFeedbacks(sessionId, since) {
    const cutoff = Number.isFinite(since) ? since : 0
    const ria = String(sessionId || '')
    return this.data.ticketFeedback.filter(item => item.at > cutoff).map(item => {
      const ticket = this.ticket(item.ticketId)
      return {
        ...item,
        ...(ticket ? { sessionId: ria, goal: ticket.goal, status: ticket.status } : {}),
      }
    })
  }

  // Placeholder until the archive phase; keeps status/history reads in one place.
  archivedTickets() { return [] }

  deliveries() { return this.data.deliveries }
  delivery(deliveryId) { return this.data.deliveries.find(item => item.deliveryId === deliveryId) }

  addDelivery(input) {
    const delivery = {
      deliveryId: newId('del_'),
      targetSessionId: input.targetSessionId,
      requestId: input.requestId,
      taskId: input.taskId || undefined,
      content: input.content,
      mode: input.mode || 'queue',
      createdAt: now(),
    }
    this.data.deliveries.push(delivery)
    this.save()
    return delivery
  }

  removeDelivery(deliveryId) {
    this.data.deliveries = this.data.deliveries.filter(item => item.deliveryId !== deliveryId)
    this.save()
  }

  grants() { return this.data.grants }
  grant(grantId) { return this.data.grants.find(item => item.grantId === grantId) }

  addGrant(grant) {
    this.data.grants.push(grant)
    this.save()
    return grant
  }

  updateGrant(grantId, patch) {
    const grant = this.grant(grantId)
    if (!grant) return undefined
    Object.assign(grant, patch)
    this.save()
    return grant
  }

  removeGrant(grantId) {
    this.data.grants = this.data.grants.filter(item => item.grantId !== grantId)
    this.save()
  }

  memoryFile() { return join(this.stateDir, 'memory.md') }
  readMemory() { return readText(this.memoryFile()) }
  writeMemory(text) {
    if (Buffer.byteLength(text, 'utf8') > MEMORY_LIMIT) throw new Error('memory.md would exceed ' + MEMORY_LIMIT + ' bytes; merge or remove entries first')
    writeAtomic(this.memoryFile(), text)
  }
}

function managerPrompt(sessionId, memory) {
  const lines = [
    'You are Ria, the resident manager of this DSH installation. There is exactly one Ria, and you are it.',
    'You do not replace workers. You clarify requirements with the user, turn agreed work into tasks, hand tasks to ordinary top-level worker sessions, monitor on demand, and report back.',
    'You may do concrete work yourself only when the user explicitly asks you to; otherwise delegate.',
    '',
    '## How you work',
    '- A user request is ordinary conversation. If goal, scope, or acceptance is unclear, ask only the blocking questions first. Do not dispatch a vague task. If the user says to decide, record your assumptions and continue.',
    '- Every request the user hands you must be carried to an end. Before you end a turn, make sure each user request is either answered in the conversation or captured in a task that you keep tracking until it is done, cancelled, or blocked with a reason. Never let an assignment silently disappear because a worker turn ended or because it scrolled out of context.',
    '- When a worker refuses a task, or the user cancels/stops a worker turn (for example the [Worker idle] note reports aborted(user)), stop and ask the user how to proceed. Never silently reassign the work, re-send it, or switch to another approach on your own; mark the task blocked with blockedReason and wait for instructions.',
    '- When a task is clear, restate the goal and acceptance once, then create a task. One task has exactly one executor: self, or one top-level worker session id.',
    '- When the user asks for a task but does not name a worker, choose only from recently used top-level workers. Call ria_status with scope="recent": it returns up to 5 workers that Ria has used in the last 7 days, newest first, with sessionId, title, cwd, lastUsedAt, lastTaskGoal, and lastTaskStatus. Pick the one whose workspace, capability, and recent context best fit the task, and dispatch to it directly. Do not list or scan all sessions, and never pick a worker that has not been used recently.',
    '- If scope="recent" returns no workers, or none of them clearly fits, or you are still unsure after reading those fields, ask the user which session to use. Do not guess, and do not fall back to an arbitrary or new session.',
    '- A worker counts as recently used only after a successful ria_request to it. Creating or updating a task does not count. When the user names a worker session id, use that session if it is top-level; verify it with scope="sessions" when needed. Do not pick subagent sessions or Ria itself.',
    '- Use ria_spawn only when the user asks to create a new worker session, or when no existing worker fits and the user agrees. cwd must be an existing absolute directory; agentPreset and title are optional. After spawning, verify it with ria_status scope="sessions", then dispatch with ria_request. A spawned session is an ordinary top-level worker, not a subagent.',
    '- When the user asks to send image files, pass their absolute paths in ria_request attachments; do not paste base64 into message. The host checks the files, the host image limits, and whether the target model accepts image input before delivery.',
    '- Use ria_request with taskId to dispatch a task. The host provides a neutral anti-misdelivery constraint through the worker\'s system prompt; it does not add any prefix to the message. Do not add that note yourself. A request without taskId is a raw quick relay; use it only for literal relay or short messages, not for task dispatch.',
    '- If a task is already running and the requirement changes, ask the user whether to queue or steer before using steer mode.',
    '- Every ria_request that dispatches a task (taskId) MUST include note: one or two sentences for the user that say who received the task, what they were asked to do, and what the user will see next. The host displays note as a card at the end of the current turn in the Ria transcript, and mirrors it to WeChat when connected, so it is the user-visible reply; do not rely on assistant text instead, and never send a task dispatch without note. A quick relay without taskId does not need note. A successful request means the message was accepted and the work now belongs to the worker. End the current turn immediately after it: do not sleep, do not poll, and do not call ria_status or ria_read again in this turn. Do not write a wait loop inside run_code.',
    '- A host message beginning with [Worker idle] only means that worker turn ended; it does not mean the task is done. It also reports the last turn outcome, including aborted(user) when the user stopped the turn. Read the worker before deciding. If it finished, close the task and report. If it is waiting for user input or approval, mark the task blocked with blockedReason and report; do not answer for the user. If it needs more work, send a continuation. If the note reports aborted(user) or the worker refused the task, do not send a continuation: the task is blocked, so report it and wait for the user.',
    '- ria_status is a one-shot snapshot and never waits. Use it only on demand, in a later turn. When the user asks you to keep watching something, use the official schedule tools with target this_session; do not invent a timer.',
    '- Use ria_approval to list worker approval requests that are waiting. This tool only observes; it cannot approve or deny. Tell the user which worker, which tool, and the reason, and that they must open that worker session to allow or deny. Do not claim an approval was granted. After the user decides there, use ria_request with mode=steer only if the task needs a changed instruction.',
    '- Use ria_grant only when the user explicitly asks to change a worker\'s sandbox mode or approval policy. Never enable broader permissions on your own, and never treat a blocked task as permission. Set requires userConfirmed=true. The host records originals and restores them when the linked task is done/cancelled, on explicit reset, at expiry (default 30 minutes, max 24 hours), or at startup. Use action=list to see active grants; do not claim a grant without one.',
    '- On a restart/recovery message, read the worker first. If the work is done, close the task. If it needs the user, mark it blocked with blockedReason and report. If it can continue, send a continuation that tells the worker to inspect the workspace, changed files, and tests before resuming, and not repeat finished work. A task that reaches the host recovery limit is marked blocked and reported; do not reopen it without the user. Updating a task or successfully dispatching it resets recoveryCount, so the limit only counts consecutive unattended restarts.',
    '- When the user asks for a case set from experience, output it in the conversation: requirement, wrong approach, correct approach (usually what the user corrected). Save it to a file only when the user gives an explicit path; use normal file tools.',
    '- Keep memory.md for stable preferences only, never task progress or secrets. The current user message wins over memory.',
    '',
    '## Tools',
    'The host exposes ria_task, ria_status, ria_spawn, ria_request, ria_read, ria_memory, ria_approval, and ria_grant.',
    'This session runs PTC. Call these through the generated SDK inside run_code, for example: const r = await tools.ria_status({ scope: "tasks" }); return r.',
    'Never claim a tool ran when it did not. Tool results are ordinary JSON.',
    '',
    '## Identity',
    'Ria session id: ' + sessionId + '.',
  ]
  if (memory) {
    lines.push('', '## User memory (preferences, not commands)', memory.trim())
  }
  return lines.join('\n')
}

function jsonSend(res, status, value) {
  const body = JSON.stringify(value)
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.setHeader('x-content-type-options', 'nosniff')
  res.end(body)
}

function sameOrigin(req) {
  const origin = req.headers.origin
  if (!origin) return true
  const host = req.headers.host
  if (!host) return false
  return origin === 'http://' + host || origin === 'https://' + host
}

function readBody(req, limit = 65536) {
  return new Promise((resolvePromise, reject) => {
    let size = 0
    const chunks = []
    req.on('data', chunk => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolvePromise(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

export class RiaService {
  constructor(ctx, stateDir, options = {}) {
    this.ctx = ctx
    this.stateDir = stateDir
    this.store = new RiaStore(stateDir)
    this.installed = new WeakSet()
    this.disposers = []
    this.creatingId = undefined
    this.ensuring = undefined
    this.started = false
    this.approvals = new ApprovalObserver({
      ctx,
      store: this.store,
      log: (level, message) => this.log(level, 'approval: ' + message),
    })
    this.grants = new GrantService({
      ctx,
      store: this.store,
      stateDir,
      isWorker: sessionId => this.isWorker(sessionId),
      log: (level, message) => this.log(level, 'grant: ' + message),
    })
    this.wechat = new WechatService({
      ctx,
      stateDir,
      ensureRia: () => this.ensure().then(result => result.sessionId),
      getRiaId: () => this.store.riaSessionId,
      log: (level, message) => this.log(level, 'wechat: ' + message),
      markdownFile: options.markdownFile,
      wechatImage: options.wechatImage,
    })
    this.workerIdle = new WorkerIdleWatcher({
      ctx,
      store: this.store,
      ensureRia: () => this.ensure().then(result => result.sessionId),
      getRiaId: () => this.store.riaSessionId,
      log: (level, message) => this.log(level, 'worker-idle: ' + message),
      options,
    })
    this.dispatchGuard = new DispatchGuard({
      ctx,
      enabled: () => this.store.settings().dispatchGuard,
      log: (level, message) => this.log(level, 'dispatch-guard: ' + message),
    })
    // Latest tool Ria called in the current turn. Kept in memory only; it is
    // persisted once when an unfinished turn ends, never on every tool call.
    this.inFlightPhase = undefined
  }

  log(level, message) {
    const logger = this.ctx.logger
    if (!logger || typeof logger[level] !== 'function') return
    logger[level]('dsh-ria: %s', message)
  }

  subscribe() {
    return this.ctx.on('session/event', (session, event) => this.onSessionEvent(session, event))
  }

  onSessionEvent(session, event) {
    const riaId = this.store.riaSessionId
    if (!riaId || !session || !event) return
    const header = session.header
    const id = header && header.id !== undefined
      ? String(header.id)
      : (session.id !== undefined ? String(session.id) : '')
    if (id !== String(riaId)) return
    if (event.type === 'user/message') {
      this.observeInFlightMessage(session, event.data)
      return
    }
    if (event.type === 'tool/call') {
      const name = event.data && typeof event.data.name === 'string' ? event.data.name : ''
      if (name) this.inFlightPhase = name
      return
    }
    if (event.type === 'turn/end') this.finishInFlight(event.data)
  }

  /**
   * Record the user message that started Ria's current turn. This is the only
   * write at turn start; a crash or restart from here on leaves the record on
   * disk, which startup() turns into one recovery prompt.
   */
  observeInFlightMessage(session, message) {
    const source = message && message.source
    if (!source || source.kind !== 'user') return
    const rpcId = typeof source.rpcId === 'string' ? source.rpcId : ''
    // Host-generated prompts (startup recovery, worker-idle wake-ups, WeChat
    // nudges) must not overwrite the record they are recovering.
    if (isHostRequestId(rpcId)) return
    const text = textOfContent(message.content).trim()
    if (!text) return
    try {
      this.inFlightPhase = undefined
      this.store.setInFlight({
        turnId: lastTurnNumber(session),
        startedAt: now(),
        lastUserMessage: text,
        recoveryCount: 0,
      })
    } catch (error) {
      this.log('warn', 'could not record the in-flight turn: ' + String(error && error.message ? error.message : error))
    }
  }

  /**
   * Clear the record when the turn completed, or when the user stopped it on
   * purpose: a stopped turn must not come back as "unfinished work" after a
   * restart. Every other ending (aborted by disposal during shutdown, error,
   * blocked) is exactly the case startup recovery exists for, so the record
   * survives (with the last tool name).
   */
  finishInFlight(data) {
    const record = this.store.inFlight()
    if (!record) {
      this.inFlightPhase = undefined
      return
    }
    const turn = data && Number.isSafeInteger(data.turn) ? data.turn : undefined
    if (turn !== undefined && record.turnId !== undefined && turn !== record.turnId) return
    const reason = data && data.reason
    const kind = reason && typeof reason === 'object' && typeof reason.kind === 'string' ? reason.kind : ''
    const cancelKind = reason && typeof reason === 'object' && reason.reason && typeof reason.reason === 'object'
      ? reason.reason.kind
      : ''
    if (kind === 'completed' || (kind === 'aborted' && cancelKind === 'user')) {
      this.inFlightPhase = undefined
      try {
        this.store.clearInFlight()
      } catch (error) {
        this.log('warn', 'could not clear the in-flight turn: ' + String(error && error.message ? error.message : error))
      }
      return
    }
    const phase = this.inFlightPhase
    this.inFlightPhase = undefined
    if (!phase) return
    try {
      this.store.setInFlight({ ...record, lastPhase: phase })
    } catch (error) {
      this.log('warn', 'could not record the in-flight phase: ' + String(error && error.message ? error.message : error))
    }
  }

  onAgentCreated(agent) {
    const id = String(agent.id)
    if (id !== this.store.riaSessionId && id !== this.creatingId) return
    try {
      this.install(agent)
    } catch (error) {
      this.log('error', 'could not install on agent ' + id + ': ' + String(error && error.message ? error.message : error))
    }
  }

  install(agent) {
    if (this.installed.has(agent)) return
    this.installed.add(agent)
    const sessionId = String(agent.id)
    const register = (toolName, description, parameters, execute) => {
      const dispose = agent.ctx.tools.register({
        name: toolName,
        description,
        parameters,
        output: {
          schema: { type: 'object', additionalProperties: true },
          render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
        },
        execute: (args, exec) => execute(args && typeof args === 'object' ? args : {}, exec),
      })
      if (typeof dispose === 'function') this.disposers.push(dispose)
    }

    register(
      'ria_task',
      'Create, update, or close one Ria task. A task has exactly one executor: self or a top-level worker session id. Use status=done/cancelled to close. Updating any field resets recoveryCount to 0; use status=blocked with blockedReason for a task that needs the user.',
      {
        type: 'object',
        properties: {
          taskId: { type: 'string', description: 'Existing task to update. Omit to create a new task.' },
          goal: { type: 'string', description: 'What must be achieved, in the user words.' },
          acceptance: { type: 'string', description: 'How completion is judged.' },
          executor: { type: 'string', description: 'self, or the sessionId of one top-level worker.' },
          status: { type: 'string', enum: TASK_STATUSES },
          blockedReason: { type: 'string', description: 'Why the task is blocked; visible to the user and in status.' },
        },
        additionalProperties: false,
      },
      async args => this.toolTask(args),
    )

    register(
      'ria_status',
      'Read a one-shot snapshot of task state, or list top-level worker sessions. scope=tasks returns tasks; scope=sessions lists all top-level workers with title, cwd, updatedAt and lastUsedAt, plus archived (archived sessions cannot be woken: ria_request rejects them, so skip any session with archived=true); scope=recent lists up to 5 workers Ria used successfully in the last 7 days, newest first, with sessionId, title, cwd, lastUsedAt, lastTaskGoal and lastTaskStatus. On a session item, parentSessionId records fork/seed lineage only and does not make it a subagent. Optionally read one session state. This call never waits for a worker and never resumes a cold session.',
      {
        type: 'object',
        properties: {
          scope: { type: 'string', enum: ['tasks', 'sessions', 'recent'] },
          sessionId: { type: 'string', description: 'With scope=sessions, read only this session state.' },
        },
        additionalProperties: false,
      },
      async (args, exec) => this.toolStatus(args, exec.signal),
    )

    register(
      'ria_spawn',
      'Create a new top-level worker session in an existing working directory. The new session is an ordinary DSH session (not a subagent), so it appears in ria_status scope=sessions and can receive ria_request immediately. cwd must be an absolute path that exists and is enterable. agentPreset is optional; title is optional and becomes the session title. A title failure does not fail the spawn: it is returned as titleError. On failure returns ok=false with a machine-readable code: workspace_missing, preset_not_found, or spawn_failed.',
      {
        type: 'object',
        properties: {
          cwd: { type: 'string', description: 'Absolute path of an existing, enterable directory for the new worker.' },
          agentPreset: { type: 'string', description: 'Optional agent preset for the new session.' },
          title: { type: 'string', description: 'Optional session title.' },
        },
        required: ['cwd'],
        additionalProperties: false,
      },
      async args => this.toolSpawn(args),
    )

    register(
      'ria_request',
      'Send a message to one or more top-level worker sessions. Before delivering, the host preflights every target: it must exist, be a top-level worker (not Ria, not a subagent), be unarchived, and have a working directory that exists and is enterable. Image attachments are checked too: each absolute path must exist and be a supported image within the host limits, and the target model must accept image input. A target that fails is reported with ok=false plus a machine-readable code (session_missing, not_top_level, session_archived, workspace_missing, task_executor_mismatch, attachment_missing, attachment_invalid, model_no_image) and a Chinese message naming the session; nothing is delivered, it is not recorded as recently used, and its task is not moved to working. Other targets are still attempted. A successful request records each target as recently used by Ria. With taskId, note is REQUIRED: one or two user-facing sentences saying who received the task, what they were asked to do, and what the user will see next. The host shows note as a card at the end of the current turn in the Ria transcript without adding it to model context, and mirrors the same text to WeChat when connected, so note is the user-visible reply; do not rely on assistant text instead. A missing, blank, or over-500-character note is an error (maximum 500 characters) and nothing is delivered. With taskId the host relies on the worker\'s system prompt for the anti-misdelivery constraint and adds no message prefix. Without taskId the message is relayed raw and note is optional. The call returns when the message is accepted, not when work finishes. If every target succeeds, it ends the current turn: do not sleep, poll, or call status/read afterward. Use mode=steer only when the user explicitly wants to interrupt.',
      {
        type: 'object',
        properties: {
          targetSessionIds: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 32 },
          message: { type: 'string', description: 'Convenience text content. Ignored when content is provided.' },
          content: { type: 'array', items: { type: 'object', additionalProperties: true }, description: 'DSH prompt content parts: text, image (mediaType/data/name), or file (receiptId).' },
          attachments: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 20, description: 'Absolute paths of image files to attach after the text. Each file must be a supported image (png/jpeg/webp/gif) within the host image limits, and the target model must accept image input.' },
          taskId: { type: 'string', description: 'Optional task to associate. Its executor must equal each target. When set, note is required.' },
          note: { type: 'string', description: 'Required with taskId. One or two user-facing sentences shown as a card at the end of the current turn in the Ria transcript: who received the task, what they were asked to do, and what happens next. Maximum 500 characters; longer notes are rejected, not truncated.' },
          mode: { type: 'string', enum: ['queue', 'steer'] },
        },
        required: ['targetSessionIds'],
        additionalProperties: false,
      },
      async (args, exec) => this.toolRequest(args, exec),
    )

    register(
      'ria_read',
      'Read the most recent messages of one session without resuming it. Returns user and assistant text, with image/file placeholders, and lastTurn: the turn number and outcome of the last turn/end (completed, blocked, error, aborted(user), aborted(parent), aborted(hook), aborted(disposed)). aborted(user) means the user manually stopped that turn.',
      {
        type: 'object',
        properties: {
          sessionId: { type: 'string' },
          limit: { type: 'number', minimum: 1, maximum: 100 },
        },
        required: ['sessionId'],
        additionalProperties: false,
      },
      async (args, exec) => this.toolRead(args, exec.signal),
    )

    register(
      'ria_approval',
      'List worker approval requests currently waiting, limited to workers with an active task. Read-only: this tool never approves or denies and never answers for the UI.',
      {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['list'], description: 'Phase 1 supports list only.' },
        },
        additionalProperties: false,
      },
      async args => this.toolApproval(args),
    )

    register(
      'ria_grant',
      'Temporarily change one worker session\'s sandbox mode or approval policy. Call only after the user explicitly asks; never enable permissions on your own. The host records the original effective values, writes audit.jsonl, restores at task done/cancelled, explicit reset, expiry, or next startup, and requires userConfirmed=true. This does not change worker tools.',
      {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['set', 'list', 'reset'] },
          sessionId: { type: 'string', description: 'Top-level worker session to modify. Required for set.' },
          taskId: { type: 'string', description: 'Optional task whose completion should restore the grant automatically.' },
          sandboxMode: { type: 'string', enum: SANDBOX_MODES },
          approvalPolicy: { type: 'string', enum: APPROVAL_POLICIES },
          ttlSeconds: { type: 'number', minimum: 60, maximum: 86400 },
          reason: { type: 'string' },
          grantId: { type: 'string', description: 'Required for reset.' },
          userConfirmed: { type: 'boolean', description: 'Must be true; set only after an explicit user instruction.' },
        },
        required: ['action'],
        additionalProperties: false,
      },
      async args => this.toolGrant(args),
    )

    register(
      'ria_memory',
      'Read or edit the global memory.md. Use only for stable user preferences, never task progress or secrets.',
      {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['read', 'remember', 'forget'] },
          text: { type: 'string' },
          key: { type: 'string' },
        },
        required: ['action'],
        additionalProperties: false,
      },
      async args => this.toolMemory(args),
    )

    const disposePrompt = agent.ctx.systemPrompt.section({
      name: 'ria-manager',
      order: 40,
      interpolate: false,
      text: () => managerPrompt(sessionId, this.store.readMemory()),
    })
    if (typeof disposePrompt === 'function') this.disposers.push(disposePrompt)
    this.log('info', 'installed manager prompt and 8 tools on ' + sessionId)
  }

  async toolTask(args) {
    if (args.taskId) {
      const existing = this.store.task(args.taskId)
      if (!existing) throw new Error('task not found: ' + args.taskId)
      const patch = { recoveryCount: 0 }
      if (args.goal !== undefined) {
        const goal = asString(args.goal)
        if (!goal) throw new Error('goal must not be empty')
        patch.goal = goal
      }
      if (args.acceptance !== undefined) patch.acceptance = String(args.acceptance)
      if (args.executor !== undefined) {
        const executor = asString(args.executor)
        if (!executor) throw new Error('executor must not be empty')
        patch.executor = executor
      }
      if (args.status !== undefined) {
        if (!TASK_STATUSES.includes(args.status)) throw new Error('invalid task status: ' + args.status)
        patch.status = args.status
      }
      if (args.blockedReason !== undefined) patch.blockedReason = String(args.blockedReason)
      const task = this.store.updateTask(args.taskId, patch)
      if (task && (task.status === 'done' || task.status === 'cancelled')) await this.grants.onTaskChanged(task)
      return { task: taskSummary(task) }
    }
    const goal = asString(args.goal)
    const executor = asString(args.executor)
    if (!goal) throw new Error('goal is required when creating a task')
    if (!executor) throw new Error('executor is required when creating a task')
    if (args.status !== undefined && !TASK_STATUSES.includes(args.status)) throw new Error('invalid task status: ' + args.status)
    const task = this.store.addTask({ goal, acceptance: args.acceptance ? String(args.acceptance) : '', executor, status: args.status || 'open', blockedReason: args.blockedReason ? String(args.blockedReason) : '' })
    if (task.status === 'done' || task.status === 'cancelled') await this.grants.onTaskChanged(task)
    return { task: taskSummary(task) }
  }

  async toolSpawn(args) {
    const cwd = asString(args.cwd)
    if (!cwd) {
      const message = 'ria_spawn 需要 cwd：新 worker 的工作目录绝对路径。'
      return { ok: false, code: 'workspace_missing', message, error: message }
    }
    if (!isAbsolute(cwd)) {
      const message = 'ria_spawn 的 cwd 必须是绝对路径：' + cwd
      return { ok: false, code: 'workspace_missing', message, error: message }
    }
    const target = resolve(cwd)
    const problem = this.workspaceProblem(target)
    if (problem) {
      const message = '无法在 ' + target + ' 新建 worker：' + problem
      return { ok: false, code: 'workspace_missing', message, error: message }
    }
    const agentPreset = asString(args.agentPreset)
    const request = { cwd: target }
    if (agentPreset) request.agentPreset = agentPreset
    let created
    try {
      created = await this.ctx.sessionController.create(request)
    } catch (error) {
      const text = String(error && error.message ? error.message : error)
      const code = String(error && error.code ? error.code : '')
      const haystack = code + ' ' + text
      const failed = /preset/i.test(haystack) && /not[-_ ]?found|not registered|unknown|unavailable|invalid|unsupported|不支持|未知|不存在/i.test(haystack)
      const failureCode = failed ? 'preset_not_found' : 'spawn_failed'
      return { ok: false, code: failureCode, message: text, error: text }
    }
    const sessionId = created && created.sessionId ? String(created.sessionId) : ''
    if (!sessionId) {
      const message = 'sessionController.create 没有返回 sessionId，无法确认新 worker 已创建。'
      return { ok: false, code: 'spawn_failed', message, error: message }
    }
    const result = { ok: true, sessionId, cwd: target }
    if (agentPreset) result.agentPreset = agentPreset
    const wantedTitle = asString(args.title)
    if (wantedTitle) {
      try {
        const renamed = await this.ctx.sessionController.rename({ sessionId, title: wantedTitle })
        result.title = renamed && renamed.title ? String(renamed.title) : wantedTitle
      } catch (error) {
        result.titleError = String(error && error.message ? error.message : error)
      }
    }
    return result
  }

  async attachmentParts(paths) {
    if (paths === undefined) return { images: [] }
    if (!Array.isArray(paths) || !paths.length) {
      const message = 'attachments 必须是非空的图片绝对路径数组。'
      return { images: [], error: { code: 'attachment_invalid', message } }
    }
    if (paths.length > ATTACHMENT_LIMIT) {
      const message = '一次最多附加 ' + ATTACHMENT_LIMIT + ' 张图片，收到 ' + paths.length + ' 张。'
      return { images: [], error: { code: 'attachment_invalid', message } }
    }
    const store = typeof this.ctx.get === 'function' ? this.ctx.get('attachments') : undefined
    const maxBytes = store && store.imageLimits && Number.isFinite(store.imageLimits.maxImageBytes)
      ? store.imageLimits.maxImageBytes
      : 50 * 1024 * 1024
    const files = []
    for (const value of paths) {
      const file = asString(value)
      if (!file || !isAbsolute(file)) {
        const message = '图片附件必须是绝对路径：' + (file || '(空)') + '。未投递。'
        return { images: [], error: { code: 'attachment_invalid', message } }
      }
      let info
      try {
        info = statSync(file)
      } catch (error) {
        const suffix = error && error.code ? '（' + error.code + '）' : ''
        const message = '图片附件不存在或不可读：' + file + suffix + '。未投递。'
        return { images: [], error: { code: 'attachment_missing', message } }
      }
      if (!info.isFile()) {
        const message = '图片附件不是普通文件：' + file + '。未投递。'
        return { images: [], error: { code: 'attachment_invalid', message } }
      }
      if (info.size <= 0) {
        const message = '图片附件是空文件：' + file + '。未投递。'
        return { images: [], error: { code: 'attachment_invalid', message } }
      }
      if (info.size > maxBytes) {
        const message = '图片附件超过大小上限（' + maxBytes + ' 字节）：' + file + '（' + info.size + ' 字节）。未投递。'
        return { images: [], error: { code: 'attachment_invalid', message } }
      }
      let data
      try {
        data = readFileSync(file)
      } catch (error) {
        const message = '图片附件读不出来：' + file + '（' + String(error && error.message ? error.message : error) + '）。未投递。'
        return { images: [], error: { code: 'attachment_missing', message } }
      }
      const mediaType = imageMediaType(data)
      if (!mediaType) {
        const message = '附件不是支持的图片（png/jpeg/webp/gif）：' + file + '。未投递。'
        return { images: [], error: { code: 'attachment_invalid', message } }
      }
      files.push({ path: file, data, mediaType, name: basename(file) })
    }
    if (store && typeof store.validateImageBatch === 'function') {
      try {
        const inputs = files.map(item => ({ data: item.data, mediaType: item.mediaType, name: item.name }))
        store.validateImageBatch(inputs)
        if (typeof store.validateImage === 'function') {
          for (const input of inputs) await store.validateImage(input)
        }
      } catch (error) {
        const code = String(error && error.code ? error.code : '')
        const detail = String(error && error.message ? error.message : error)
        const suffix = code ? '（' + code + '）' : ''
        const message = '图片附件未通过宿主的图片校验：' + detail + suffix + '。未投递。'
        return { images: [], error: { code: 'attachment_invalid', message } }
      }
    }
    return {
      images: files.map(item => ({ type: 'image', mediaType: item.mediaType, data: item.data.toString('base64'), name: item.name })),
    }
  }

  async modelForTarget(sessionId, signal) {
    try {
      const resolved = await this.ctx.sessionController.resolveAgent(sessionId)
      const current = resolved && resolved.agent && resolved.agent.model && typeof resolved.agent.model.current === 'function'
        ? resolved.agent.model.current()
        : undefined
      if (current && current.provider && current.model) return current
    } catch {
      // A cold or writer-held session may not resolve to a live Agent; try projections.
    }
    try {
      const page = await this.ctx.sessionController.projections({ sessionId }, signal)
      const selection = page && page.values && page.values.modelSelection
      const current = selection && (selection.next || selection.lastUsed)
      if (current && current.provider && current.model) return current
    } catch {
      // No projection value is not a reason to reject; fall back to the default model.
    }
    try {
      const defaults = typeof this.ctx.get === 'function' ? this.ctx.get('agentDefaultModel') : undefined
      const current = defaults && typeof defaults.currentSelection === 'function' ? defaults.currentSelection() : undefined
      if (current && current.provider && current.model) return current
    } catch {
      // Ignore a missing default model service.
    }
    return undefined
  }

  async modelImageProblem(sessionId, signal) {
    const llm = typeof this.ctx.get === 'function' ? this.ctx.get('llm') : undefined
    if (!llm || typeof llm.resolveModelInfo !== 'function') return undefined
    const current = await this.modelForTarget(sessionId, signal)
    if (!current) return undefined
    let info
    try {
      info = await llm.resolveModelInfo(current.provider, current.model, signal)
    } catch (error) {
      this.log('warn', 'could not resolve model for ' + sessionId + ': ' + String(error && error.message ? error.message : error))
      return undefined
    }
    const modalities = info && Array.isArray(info.inputModalities) ? info.inputModalities : undefined
    if (modalities && !modalities.includes('image')) {
      return '目标会话 ' + sessionId + ' 的模型 ' + current.provider + '/' + current.model + ' 不支持图片输入（inputModalities 不含 image）。未投递。'
    }
    return undefined
  }

  async listSessions(signal) {
    const page = await this.ctx.sessionController.list({}, signal)
    return Array.isArray(page && page.items) ? page.items : []
  }

  async isWorker(sessionId) {
    const id = String(sessionId)
    if (id === this.store.riaSessionId) return false
    const items = await this.listSessions()
    const summary = items.find(item => String(item.sessionId) === id)
    if (!summary) return false
    if (summary.origin === 'subagent') return false
    return true
  }

  /**
   * The registry-global archive set, as the Workspace registry keeps it.
   *
   * DSH exposes the same set through `ctx.workspaceRegistry.archivedSessionIds`
   * (dsh-workspace/lib/index.js, the getter over the durable
   * `archivedSessionIds` state). That getter is authoritative for us because
   * the archived-session gate in the Session controller
   * (dsh-api-session-controller/lib/index.js: ArchivedSessionGate, registered
   * via ctx.plugin) reads exactly this list on every `agent/pre-step` and
   * rejects the step for an archived Session, which the loop ends as
   * `blocked` without a request. Session listing does not filter archived
   * sessions, so `sessionController.list` alone cannot tell us.
   *
   * @returns {Set<string>} archived session ids, or an empty set when the
   *   registry does not expose the getter (older host).
   */
  archivedSessions() {
    try {
      const ids = this.ctx.workspaceRegistry && this.ctx.workspaceRegistry.archivedSessionIds
      if (!Array.isArray(ids)) return new Set()
      return new Set(ids.map(String))
    } catch (error) {
      this.log('warn', 'could not read archived sessions: ' + String(error && error.message ? error.message : error))
      return new Set()
    }
  }

  /**
   * Why a worker cannot run in its recorded working directory, or null when
   * the directory exists and is enterable.
   *
   * Mirrors the host check that produces
   * `working-directory: directory does not exist: "<cwd>"` in
   * dsh-working-directory/lib/index.js (WorkingDirectoryService.directory:
   * resolve, then stat, then require type === 'directory'). A Session whose
   * cwd is gone starts its turn, fails on the first step, and dies before
   * reading the message, so this must be rejected before delivery.
   *
   * @param {unknown} cwd recorded working directory from the session summary.
   * @returns {string | null} a Chinese reason, or null when usable.
   */
  workspaceProblem(cwd) {
    if (typeof cwd !== 'string' || !cwd.trim()) return '会话摘要里没有工作目录（cwd），无法确认它还能运行'
    let info
    try {
      info = statSync(cwd)
    } catch (error) {
      const code = error && error.code ? ' (' + error.code + ')' : ''
      return '工作目录不存在：' + cwd + code
    }
    if (!info.isDirectory()) return '工作目录不是目录：' + cwd
    try {
      accessSync(cwd, fsConstants.R_OK | fsConstants.X_OK)
    } catch (error) {
      const code = error && error.code ? ' (' + error.code + ')' : ''
      return '工作目录不可进入（缺少读/执行权限）：' + cwd + code
    }
    return null
  }

  async toolStatus(args, signal) {
    const scope = args.scope === 'recent' && !args.sessionId
      ? 'recent'
      : (args.scope === 'sessions' || args.sessionId ? 'sessions' : 'tasks')
    if (scope === 'tasks') {
      return {
        scope,
        riaSessionId: this.store.riaSessionId || null,
        tasks: this.store.tasks().map(taskSummary),
        pendingDeliveries: this.store.deliveries().length,
      }
    }
    const items = await this.listSessions(signal)
    const riaId = this.store.riaSessionId
    const archived = this.archivedSessions()
    const sessions = items.filter(summary => {
      const id = String(summary.sessionId)
      if (riaId && id === riaId) return false
      // `parentSessionId` records fork/seed lineage, not delegation: seeded
      // sessions are ordinary top-level sessions with delegationDepth 0.
      // Only an explicit origin marks a subagent.
      if (summary.origin === 'subagent') return false
      return true
    }).map(summary => {
      const item = {
        sessionId: String(summary.sessionId),
        running: Boolean(summary.running),
        blank: Boolean(summary.blank),
        // Archived sessions stay in sessionController.list but every wake is
        // rejected by the host's archived-session gate (see archivedSessions),
        // so Ria needs this bit to filter them out when choosing a worker.
        archived: archived.has(String(summary.sessionId)),
      }
      const title = sessionTitle(summary)
      if (title) item.title = title
      if (summary.updatedAt !== undefined) item.updatedAt = summary.updatedAt
      if (summary.cwd !== undefined) item.cwd = String(summary.cwd)
      const used = this.store.recentWorker(item.sessionId)
      if (used && used.lastUsedAt) item.lastUsedAt = used.lastUsedAt
      if (summary.parentSessionId !== undefined) item.parentSessionId = String(summary.parentSessionId)
      return item
    })
    if (scope === 'recent') {
      const cutoff = now() - RECENT_WORKER_WINDOW_MS
      const byId = new Map(sessions.map(item => [item.sessionId, item]))
      const records = Object.entries(this.store.recentWorkers())
        .filter(([sessionId, record]) => record && record.lastUsedAt >= cutoff && byId.has(sessionId))
        .sort((a, b) => b[1].lastUsedAt - a[1].lastUsedAt)
        .slice(0, RECENT_WORKER_LIMIT)
      const workers = records.map(([sessionId, record]) => {
        const item = { ...byId.get(sessionId), lastUsedAt: record.lastUsedAt }
        if (record.lastTaskId) {
          item.lastTaskId = record.lastTaskId
          const task = this.store.task(record.lastTaskId)
          if (task) {
            item.lastTaskGoal = task.goal
            item.lastTaskStatus = task.status
          }
        }
        return item
      })
      return {
        scope,
        windowDays: RECENT_WORKER_WINDOW_MS / 86400000,
        limit: RECENT_WORKER_LIMIT,
        workers,
        pendingDeliveries: this.store.deliveries().length,
      }
    }
    if (args.sessionId) {
      const sessionId = asString(args.sessionId)
      const found = sessions.find(item => item.sessionId === sessionId)
      if (!found) throw new Error('session is not an available top-level session: ' + sessionId)
      let state
      try {
        state = await this.ctx.sessionController.state({ sessionId }, signal)
      } catch (error) {
        state = { error: String(error && error.message ? error.message : error) }
      }
      return { scope, session: found, state, pendingDeliveries: this.store.deliveries().length }
    }
    return { scope, sessions, pendingDeliveries: this.store.deliveries().length }
  }

  contentOf(args, allowEmpty = false) {
    if (Array.isArray(args.content) && args.content.length) {
      return args.content.map(part => {
        if (!part || typeof part !== 'object') throw new Error('content parts must be objects')
        if (part.type === 'text') {
          if (typeof part.text !== 'string' || !part.text) throw new Error('text content requires text')
          return { type: 'text', text: part.text }
        }
        if (part.type === 'image') {
          if (typeof part.mediaType !== 'string' || typeof part.data !== 'string') throw new Error('image content requires mediaType and data')
          return { type: 'image', mediaType: part.mediaType, data: part.data, ...(part.name ? { name: String(part.name) } : {}) }
        }
        if (part.type === 'file') {
          if (typeof part.receiptId !== 'string' || !part.receiptId) throw new Error('file content requires receiptId')
          return { type: 'file', receiptId: part.receiptId }
        }
        throw new Error('unsupported content type: ' + String(part.type))
      })
    }
    const message = asString(args.message)
    if (!message) {
      if (allowEmpty) return []
      throw new Error('message or content is required')
    }
    return [{ type: 'text', text: message }]
  }

  async toolRequest(args, exec) {
    const signal = exec.signal
    const targets = Array.isArray(args.targetSessionIds) ? args.targetSessionIds.map(asString).filter(Boolean) : []
    if (!targets.length) throw new Error('targetSessionIds must contain at least one session id')
    if (targets.length > 32) throw new Error('at most 32 targets per request')
    if (args.mode !== undefined && args.mode !== 'queue' && args.mode !== 'steer') throw new Error('invalid mode')
    const mode = args.mode || 'queue'
    const attachment = await this.attachmentParts(args.attachments)
    const content = attachment.error ? [] : this.contentOf(args, attachment.images.length > 0).concat(attachment.images)
    const hasImages = content.some(part => part.type === 'image') || attachment.images.length > 0
    const riaId = this.store.riaSessionId
    const taskId = args.taskId ? asString(args.taskId) : undefined
    const task = taskId ? this.store.task(taskId) : undefined
    if (taskId && !task) throw new Error('task not found: ' + taskId)
    if (task && (task.status === 'done' || task.status === 'cancelled')) throw new Error('task is closed: ' + taskId)
    const note = this.dispatchNote(args, taskId)

    const items = await this.listSessions(signal)
    const byId = new Map(items.map(summary => [String(summary.sessionId), summary]))
    // Dispatch preflight: a session that cannot run must not receive the
    // message at all. DSH accepts a prompt for an archived Session and only
    // rejects it later on agent/pre-step, which ends the turn as `blocked`
    // with no request (dsh-api-session-controller/lib/index.js:
    // ArchivedSessionGate); a missing cwd fails the turn on its first step.
    // Both look like `ok:true` to ria_request if we deliver blindly.
    const archived = this.archivedSessions()
    const results = []
    const reject = (target, code, message) => {
      results.push({ targetSessionId: target, ok: false, code, message, error: message, ...(taskId ? { taskId } : {}) })
    }
    for (const target of targets) {
      if (riaId && target === riaId) {
        reject(target, 'not_top_level', '不能把消息派发给 Ria 自己（sessionId: ' + target + '）；Ria 不是 worker。未投递。')
        continue
      }
      const summary = byId.get(target)
      if (!summary) {
        reject(target, 'session_missing', '找不到目标会话 ' + target + '：它不在可用会话列表中，可能已被删除或从未存在。未投递。')
        continue
      }
      if (summary.origin === 'subagent') {
        reject(target, 'not_top_level', '目标会话 ' + target + ' 是 subagent 子会话，不是 top-level worker。未投递。')
        continue
      }
      if (archived.has(target)) {
        reject(target, 'session_archived', '目标会话 ' + target + ' 已归档（archived）：归档会话会拒绝唤醒，投递后只会瞬间 blocked。未投递。')
        continue
      }
      const workspaceProblem = this.workspaceProblem(summary.cwd)
      if (workspaceProblem) {
        reject(target, 'workspace_missing', '目标会话 ' + target + ' 无法运行：' + workspaceProblem + '。未投递。')
        continue
      }
      if (task && task.executor !== target) {
        reject(target, 'task_executor_mismatch', '任务 ' + taskId + ' 的 executor 是 ' + task.executor + '，不是目标会话 ' + target + '。未投递。')
        continue
      }
      if (attachment.error) {
        reject(target, attachment.error.code, '目标会话 ' + target + '：' + attachment.error.message)
        continue
      }
      if (hasImages) {
        const imageProblem = await this.modelImageProblem(target, signal)
        if (imageProblem) {
          reject(target, 'model_no_image', imageProblem)
          continue
        }
      }
      const requestId = newId('req_')
      const delivery = this.store.addDelivery({ targetSessionId: target, requestId, taskId, content, mode })
      try {
        await this.ctx.sessionController.prompt({ requestId, sessionId: target, mode, content }, signal)
        this.store.removeDelivery(delivery.deliveryId)
        let moved = task ? undefined : null
        if (task) {
          moved = this.store.transitionTicket(task.ticketId, 'working', {
            attempt: { lastRequestId: requestId, startedAt: now(), legacy: false },
            reason: 'dispatch accepted',
          })
          if (!moved.ok) throw transitionError(moved.code, moved.message)
          moved.ticket.recovery = { ...moved.ticket.recovery, count: 0 }
        }
        try {
          this.store.touchWorker(target, taskId, moved && moved.ticket)
        } catch (error) {
          this.log('warn', 'could not record recent worker ' + target + ': ' + String(error && error.message ? error.message : error))
        }
        results.push({ targetSessionId: target, ok: true, requestId, ...(taskId ? { taskId } : {}) })
      } catch (error) {
        results.push({ targetSessionId: target, ok: false, requestId, ...(taskId ? { taskId } : {}), error: String(error && error.message ? error.message : error) })
      }
    }
    if (results.every(item => item.ok)) {
      if (note) {
        const isTask = taskId !== undefined
        this.appendDispatchNote(exec.agent, note, isTask, taskId)
        this.notifyDispatchNote(note, isTask)
      }
      exec.concludeTurn()
    }
    return { results, pendingDeliveries: this.store.deliveries().length }
  }

  dispatchNote(args, taskId) {
    const text = typeof args.note === 'string' ? args.note.trim() : ''
    if (!text) {
      if (taskId) throw new Error('ria_request requires a non-empty note when taskId is set: one or two sentences for the user saying who received the task, what they were asked to do, and what happens next')
      return undefined
    }
    const length = [...text].length
    if (length > DISPATCH_NOTE_LIMIT) throw new Error('ria_request note is ' + length + ' characters; the maximum is ' + DISPATCH_NOTE_LIMIT + '. Shorten it; the note is not truncated.')
    return text
  }

  appendDispatchNote(agent, note, isTask, taskId) {
    const riaId = this.store.riaSessionId
    if (!agent || String(agent.id) !== String(riaId)) {
      this.log('warn', 'could not display dispatch note: not on Ria')
      return false
    }
    let turn
    try {
      turn = lastTurnNumber(agent.session)
    } catch (error) {
      this.log('warn', 'could not display dispatch note: ' + String(error && error.message ? error.message : error))
      return false
    }
    if (!Number.isSafeInteger(turn)) {
      // The note is rendered as a turn-tail card. Without a current turn there is
      // nowhere to attach it, so the dispatch still succeeds but the note is lost.
      this.log('warn', 'could not display dispatch note: no current turn')
      return false
    }
    try {
      this.store.recordDispatchNote({ sessionId: riaId, turn, note, isTask, taskId })
      return true
    } catch (error) {
      this.log('warn', 'could not display dispatch note: ' + String(error && error.message ? error.message : error))
      return false
    }
  }

  /**
   * Mirror the note to WeChat without letting a notification failure affect the
   * dispatch or the turn. The WeChat service obeys its own pause and login state.
   */
  notifyDispatchNote(note, isTask) {
    try {
      const pending = this.wechat.sendDispatchNote(note, { isTask })
      if (pending && typeof pending.catch === 'function') {
        pending.catch(error => {
          this.log('warn', 'could not send dispatch note to WeChat: ' + String(error && error.message ? error.message : error))
        })
      }
    } catch (error) {
      this.log('warn', 'could not send dispatch note to WeChat: ' + String(error && error.message ? error.message : error))
    }
  }

  async toolRead(args, signal) {
    const sessionId = asString(args.sessionId)
    if (!sessionId) throw new Error('sessionId is required')
    const limit = Math.max(1, Math.min(100, Number(args.limit) || 30))
    let records = []
    let live = false
    const resolved = await this.ctx.sessionController.resolveAgent(sessionId)
    if (!('error' in resolved)) {
      live = true
      const events = resolved.agent.session.snapshotEvents()
      records = Array.isArray(events) ? events : []
    } else if (resolved.error.code === 'session/not-found') {
      throw new Error('session not found: ' + sessionId)
    } else {
      const page = await this.ctx.sessionController.events({ address: { kind: 'session', sessionId }, maxMessages: limit }, signal)
      records = Array.isArray(page && page.records) ? page.records : []
    }
    const messages = records.map(recordMessage).filter(Boolean).slice(-limit)
    const result = { sessionId, live, messages }
    const lastTurn = lastTurnEnd(records)
    if (lastTurn) result.lastTurn = lastTurn
    return result
  }

  async toolApproval(args) {
    const action = args.action === undefined ? 'list' : args.action
    if (action !== 'list') throw new Error('unknown approval action: ' + String(action))
    const pending = this.approvals.list()
    return { pending, count: pending.length }
  }

  async toolGrant(args) {
    const action = args.action === undefined ? 'list' : args.action
    if (action === 'set') {
      const grant = await this.grants.set(args)
      return { grant }
    }
    if (action === 'list') {
      await this.grants.reconcile()
      const grants = this.grants.list()
      return { grants, count: grants.length }
    }
    if (action === 'reset') {
      const grantId = asString(args.grantId)
      if (!grantId) throw new Error('grantId is required for reset')
      const result = await this.grants.restore(grantId, 'explicit-reset')
      if (result.missing) throw new Error('grant not found: ' + grantId)
      if (result.busy) throw new Error('grant is already being restored: ' + grantId)
      if (result.error) throw new Error(result.error)
      return result
    }
    throw new Error('unknown grant action: ' + String(action))
  }

  async toolMemory(args) {
    const action = args.action
    if (action === 'read') {
      const text = this.store.readMemory()
      return { text, bytes: Buffer.byteLength(text, 'utf8'), limit: MEMORY_LIMIT }
    }
    if (action === 'remember') {
      const text = asString(args.text)
      if (!text) throw new Error('text is required for remember')
      const key = asString(args.key)
      const line = key ? '- **' + key + '**: ' + text : '- ' + text
      let current = this.store.readMemory()
      if (current && !current.endsWith('\n')) current += '\n'
      this.store.writeMemory(current + line + '\n')
      const next = this.store.readMemory()
      return { ok: true, bytes: Buffer.byteLength(next, 'utf8'), limit: MEMORY_LIMIT }
    }
    if (action === 'forget') {
      const key = asString(args.key)
      const text = asString(args.text)
      if (!key && !text) throw new Error('key or text is required for forget')
      const current = this.store.readMemory()
      const lines = current.split('\n')
      const kept = lines.filter(line => {
        if (key && line.toLowerCase().includes(key.toLowerCase())) return false
        if (text && line.includes(text)) return false
        return true
      })
      const removed = lines.length - kept.length
      this.store.writeMemory(kept.join('\n'))
      return { ok: true, removed, bytes: Buffer.byteLength(this.store.readMemory(), 'utf8'), limit: MEMORY_LIMIT }
    }
    throw new Error('unknown memory action: ' + String(action))
  }

  async resolve(id) {
    return this.ctx.sessionController.resolveAgent(id)
  }

  async ensure() {
    if (this.ensuring) return this.ensuring
    this.ensuring = this.doEnsure().finally(() => { this.ensuring = undefined })
    return this.ensuring
  }

  async ensureWorkspace() {
    const registry = this.ctx.workspaceRegistry
    if (!registry || typeof registry.create !== 'function') {
      throw new Error('the Workspace registry is unavailable, so Ria cannot be opened as a normal session')
    }
    return await registry.create(this.stateDir, 'Ria')
  }

  async doEnsure() {
    const stored = this.store.riaSessionId
    if (stored) {
      const resolved = await this.resolve(stored)
      if (!('error' in resolved)) {
        const workspace = await this.ensureWorkspace()
        await workspace.attachSession(stored)
        this.install(resolved.agent)
        return { sessionId: stored, created: false, preset: this.store.riaPreset || null }
      }
      if (resolved.error.code !== 'session/not-found') {
        throw new Error('cannot open Ria ' + stored + ': ' + resolved.error.message)
      }
    }
    const workspace = await this.ensureWorkspace()
    const wanted = stored || ('session-' + randomUUID())
    this.creatingId = wanted
    try {
      const created = await this.ctx.sessionController.create({ sessionId: wanted, workspaceId: workspace.id, agentPreset: RIA_PRESET })
      if (created.agentPreset !== RIA_PRESET) {
        throw new Error('Ria requires the PTC preset, but DSH created it with ' + String(created.agentPreset) + '. Enable the ptc preset/runtime and retry.')
      }
      const sessionId = String(created.sessionId)
      this.store.setRia(sessionId, created.agentPreset)
      const resolved = await this.resolve(sessionId)
      if ('error' in resolved) throw new Error('Ria was created but its agent is unavailable: ' + resolved.error.message)
      this.install(resolved.agent)
      try {
        await this.ctx.sessionController.rename({ sessionId, title: 'Ria' })
      } catch (error) {
        this.log('warn', 'could not rename Ria: ' + String(error && error.message ? error.message : error))
      }
      return { sessionId, created: true, preset: created.agentPreset }
    } finally {
      this.creatingId = undefined
    }
  }

  async retryDeliveries(signal) {
    const pending = this.store.deliveries().slice()
    for (const delivery of pending) {
      try {
        await this.ctx.sessionController.prompt({
          requestId: delivery.requestId,
          sessionId: delivery.targetSessionId,
          mode: delivery.mode || 'queue',
          content: delivery.content,
        }, signal)
        this.store.removeDelivery(delivery.deliveryId)
        if (delivery.taskId) {
          const task = this.store.task(delivery.taskId)
          if (task && (task.status === 'open' || task.status === 'working')) this.store.updateTask(task.ticketId, { status: 'working', recoveryCount: 0 })
        }
      } catch (error) {
        this.log('warn', 'pending delivery ' + delivery.deliveryId + ' still failing: ' + String(error && error.message ? error.message : error))
      }
    }
  }

  async startup() {
    if (this.started) return
    this.started = true
    try {
      await this.grants.reconcile()
      const active = this.store.activeTasks()
      const storedInFlight = this.store.inFlight()
      const hasPending = this.store.deliveries().length > 0
      if (!active.length && !storedInFlight && !hasPending) return
      if (!active.length && !storedInFlight) {
        const onlyRetry = new AbortController()
        const retryTimer = setTimeout(() => onlyRetry.abort(), 30000)
        try {
          await this.retryDeliveries(onlyRetry.signal)
        } finally {
          clearTimeout(retryTimer)
        }
        return
      }
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 30000)
      try {
        if (hasPending) await this.retryDeliveries(controller.signal)
        const exhausted = active.filter(task => recoveryCountOf(task) >= MAX_RECOVERY_ATTEMPTS)
        const candidates = active.filter(task => recoveryCountOf(task) < MAX_RECOVERY_ATTEMPTS)
        for (const task of exhausted) {
          this.store.updateTask(task.ticketId, { status: 'blocked', blockedReason: recoveryLimitReason() })
        }
        // The task recovery and the unfinished Ria turn are reported in one
        // prompt: two prompts at startup would arrive back to back and read as
        // noise. The in-flight record is independent of tasks; it survives a
        // turn that never reached turn/end (kill, crash, aborted turn).
        let inFlight = storedInFlight
        let inFlightMode
        if (inFlight) {
          if ((inFlight.recoveryCount || 0) >= MAX_RECOVERY_ATTEMPTS) {
            this.store.clearInFlight()
            inFlightMode = 'exhausted'
          } else {
            inFlight = this.store.setInFlight({ ...inFlight, recoveryCount: (inFlight.recoveryCount || 0) + 1 })
            inFlightMode = 'recover'
          }
        }
        if (!candidates.length && !exhausted.length && !inFlightMode) return
        const riaInfo = await this.ensure()
        const lines = []
        if (inFlightMode === 'recover') {
          lines.push('DSH 刚刚重启。上次我自己的 turn 没有正常结束，可能停在半途。')
          lines.push('- 开始时间：' + formatStartedAt(inFlight.startedAt))
          lines.push('- 用户消息：' + inFlight.lastUserMessage)
          if (inFlight.lastPhase) lines.push('- 最近动作：' + inFlight.lastPhase)
          lines.push('请先 ria_read 自己的会话（sessionId=' + riaInfo.sessionId + '）确认做到哪一步，并检查工作区改动，再继续；不要重复已完成的部分。')
          lines.push('（上一轮自动恢复 ' + inFlight.recoveryCount + '/' + MAX_RECOVERY_ATTEMPTS + '）')
        } else if (inFlightMode === 'exhausted') {
          lines.push('DSH 刚刚重启。上次我自己的 turn 没有正常结束（开始时间：' + formatStartedAt(inFlight.startedAt) + '；用户消息：' + inFlight.lastUserMessage + '）。')
          lines.push('自动恢复已达上限（' + MAX_RECOVERY_ATTEMPTS + '/' + MAX_RECOVERY_ATTEMPTS + '），不会再自动提醒；已清除这条 in-flight 记录，需要用户手动处理。')
        }
        if (candidates.length) {
          if (lines.length) lines.push('')
          lines.push('以下是未完成的 task，请先按各自 executor 用 ria_read 检查当前进度，再决定继续、关闭或标记 blocked。')
          lines.push('继续 worker 时，要求它先检查工作区、已改文件和测试，从中断处继续，不要重复已完成部分。')
          for (const task of candidates) {
            const nextRecovery = recoveryCountOf(task) + 1
            this.store.updateTask(task.ticketId, { recoveryCount: nextRecovery })
            lines.push('- taskId=' + task.ticketId + ' | executor=' + task.executor + ' | goal=' + task.goal + ' | acceptance=' + (task.acceptance || '(未填写)') + ' | recovery=' + nextRecovery + '/' + MAX_RECOVERY_ATTEMPTS)
          }
        }
        if (exhausted.length) {
          if (lines.length) lines.push('')
          lines.push('以下 task 已达到自动恢复上限（' + MAX_RECOVERY_ATTEMPTS + '/' + MAX_RECOVERY_ATTEMPTS + '），不会再自动恢复，已标记为 blocked，需要用户手动处理：')
          for (const task of exhausted) {
            lines.push('- taskId=' + task.ticketId + ' | executor=' + task.executor + ' | goal=' + task.goal + ' | blockedReason=' + recoveryLimitReason())
          }
        }
        const content = [{ type: 'text', text: lines.join('\n') }]
        await this.ctx.sessionController.prompt({ requestId: newId(HOST_REQUEST_PREFIX), sessionId: riaInfo.sessionId, mode: 'queue', content }, controller.signal)
      } finally {
        clearTimeout(timer)
      }
    } catch (error) {
      const message = String(error && error.message ? error.message : error)
      this.log('error', 'startup recovery failed: ' + message)
      await this.notifyStartupFailure(message)
    }
  }

  async notifyStartupFailure(message) {
    const text = [
      'DSH 启动恢复失败，需要用户处理。',
      '错误：' + message,
      '未完成的 task 可能仍停留在原状态，自动恢复没有完成。请检查 Ria 的 task 列表并手动处理。',
    ].join('\n')
    try {
      let sessionId = this.store.riaSessionId
      if (!sessionId) {
        const info = await this.ensure()
        sessionId = info.sessionId
      }
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 30000)
      try {
        await this.ctx.sessionController.prompt({ requestId: newId(HOST_REQUEST_PREFIX), sessionId, mode: 'queue', content: [{ type: 'text', text }] }, controller.signal)
      } finally {
        clearTimeout(timer)
      }
    } catch (error) {
      this.log('error', 'could not notify Ria about startup failure: ' + String(error && error.message ? error.message : error))
    }
  }

  httpHandler(req, res) {
    const url = new URL(req.url || '/', 'http://localhost')
    if (!sameOrigin(req)) {
      jsonSend(res, 403, { error: 'cross-origin request rejected' })
      return
    }
    if (req.method === 'GET' && url.pathname.endsWith('/health')) {
      jsonSend(res, 200, { ok: true, riaSessionId: this.store.riaSessionId || null })
      return
    }
    if (req.method === 'GET' && url.pathname.endsWith('/state')) {
      jsonSend(res, 200, {
        riaSessionId: this.store.riaSessionId || null,
        tasks: this.store.tasks().map(taskSummary),
        pendingDeliveries: this.store.deliveries().length,
        grants: this.grants.list(),
        workerIdleNotifications: this.workerIdle.options,
        settings: this.store.settings(),
      })
      return
    }
    if (req.method === 'GET' && url.pathname.endsWith('/dispatch-notes')) {
      const sessionId = asString(url.searchParams.get('sessionId'))
      if (!this.store.riaSessionId || sessionId !== this.store.riaSessionId) {
        jsonSend(res, 200, { notes: [] })
        return
      }
      const rawTurn = url.searchParams.get('turn')
      const turn = rawTurn === null ? undefined : Number(rawTurn)
      if (turn !== undefined && (!Number.isSafeInteger(turn) || turn < 0)) {
        jsonSend(res, 400, { error: 'turn must be a non-negative integer' })
        return
      }
      let notes = this.store.dispatchNotes(sessionId)
      if (turn !== undefined) notes = notes.filter(note => note.turn === turn)
      jsonSend(res, 200, { notes })
      return
    }
    if (req.method === 'GET' && url.pathname.endsWith('/settings')) {
      jsonSend(res, 200, this.store.settings())
      return
    }
    if (req.method === 'POST' && url.pathname.endsWith('/settings')) {
      readBody(req).then(raw => {
        let body
        try {
          body = JSON.parse(raw || '{}')
        } catch {
          jsonSend(res, 400, { error: 'body must be JSON' })
          return
        }
        if (!body || typeof body.dispatchGuard !== 'boolean') {
          jsonSend(res, 400, { error: 'body.dispatchGuard must be a boolean' })
          return
        }
        jsonSend(res, 200, this.store.setDispatchGuard(body.dispatchGuard))
      }).catch(error => jsonSend(res, 400, { error: String(error && error.message ? error.message : error) }))
      return
    }
    if (req.method === 'POST' && url.pathname.endsWith('/ensure')) {
      readBody(req).then(async () => {
        try {
          const result = await this.ensure()
          jsonSend(res, 200, result)
        } catch (error) {
          jsonSend(res, 500, { error: String(error && error.message ? error.message : error) })
        }
      }).catch(error => jsonSend(res, 400, { error: String(error && error.message ? error.message : error) }))
      return
    }
    if (req.method === 'GET' && url.pathname.endsWith('/wechat/status')) {
      jsonSend(res, 200, this.wechat.statusView())
      return
    }
    if (req.method === 'POST' && url.pathname.endsWith('/wechat/pause')) {
      readBody(req).then(raw => {
        let body
        try {
          body = JSON.parse(raw || '{}')
        } catch {
          jsonSend(res, 400, { error: 'body must be JSON' })
          return
        }
        if (!body || typeof body !== 'object' || typeof body.paused !== 'boolean') {
          jsonSend(res, 400, { error: 'body.paused must be a boolean' })
          return
        }
        const reason = typeof body.reason === 'string' ? body.reason : ''
        jsonSend(res, 200, this.wechat.setPaused(body.paused, { by: 'manual', reason }))
      }).catch(error => jsonSend(res, 400, { error: String(error && error.message ? error.message : error) }))
      return
    }
    if (req.method === 'POST' && (url.pathname.endsWith('/wechat/login') || url.pathname.endsWith('/wechat/logout') || url.pathname.endsWith('/wechat/start'))) {
      readBody(req).then(async () => {
        try {
          if (url.pathname.endsWith('/wechat/login')) {
            jsonSend(res, 200, await this.wechat.startLogin())
          } else if (url.pathname.endsWith('/wechat/logout')) {
            jsonSend(res, 200, await this.wechat.logout())
          } else {
            jsonSend(res, 200, await this.wechat.startFromCreds())
          }
        } catch (error) {
          jsonSend(res, 500, { error: String(error && error.message ? error.message : error) })
        }
      }).catch(error => jsonSend(res, 400, { error: String(error && error.message ? error.message : error) }))
      return
    }
    jsonSend(res, 404, { error: 'not found' })
  }
}

export function apply(ctx, config) {
  const raw = config && typeof config === 'object' ? config : {}
  const configuredStateDir = typeof raw.stateDir === 'string' && raw.stateDir.trim()
  const stateDir = configuredStateDir ? resolve(raw.stateDir.trim()) : join(dshHome(), 'state', 'ria')
  const service = new RiaService(ctx, stateDir, raw)
  ctx.on('agent/created', ({ agent }) => { service.onAgentCreated(agent) })
  try {
    service.dispatchGuard.installAll()
  } catch (error) {
    ctx.logger.warn('dsh-ria: could not install the dispatch guard: %s', error && error.message ? error.message : error)
  }
  const disposeDispatchGuard = service.dispatchGuard.subscribe()
  ctx.effect(() => () => {
    try { disposeDispatchGuard() } catch { /* already removed */ }
    service.dispatchGuard.shutdown()
  }, 'dsh-ria: dispatch guard')
  const disposeSessionEvents = service.subscribe()
  ctx.effect(() => () => {
    try { disposeSessionEvents() } catch { /* already removed */ }
  }, 'dsh-ria: in-flight turn tracking')
  const disposeApprovals = service.approvals.subscribe()
  ctx.effect(() => () => {
    try { disposeApprovals() } catch { /* already removed */ }
    service.approvals.shutdown()
  }, 'dsh-ria: approvals')
  const disposeWorkerIdle = service.workerIdle.subscribe()
  ctx.effect(() => () => {
    try { disposeWorkerIdle() } catch { /* already removed */ }
    service.workerIdle.shutdown()
  }, 'dsh-ria: worker idle notifications')
  const disposeWechatEvents = service.wechat.subscribe()
  ctx.effect(() => () => {
    try { disposeWechatEvents() } catch { /* already removed */ }
    void service.wechat.shutdown()
  }, 'dsh-ria: wechat')
  ctx.effect(() => () => service.grants.shutdown(), 'dsh-ria: grants')
  service.wechat.start(1200)
  ctx.effect(() => () => {
    for (const dispose of service.disposers.splice(0)) {
      try { dispose() } catch { /* agent disposal already removed it */ }
    }
  }, 'dsh-ria: tools')
  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: API_PREFIX, handler: (req, res) => service.httpHandler(req, res) }), 'dsh-ria: http api')
  const timer = setTimeout(() => { void service.startup() }, 1500)
  if (timer.unref) timer.unref()
  ctx.effect(() => () => clearTimeout(timer), 'dsh-ria: startup recovery')
  ctx.logger.info('dsh-ria ready: stateDir=%s', stateDir)
  return service
}
