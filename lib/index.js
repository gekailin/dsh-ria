// dsh-ria host half.
//
// A globally unique Ria: an ordinary top-level DSH Session running the
// PTC preset, with a manager prompt and seven ria_* tools installed on its
// Agent. She relays ordinary user messages to worker sessions and keeps her
// own task/delivery state in DSH_HOME/state/ria/ria.json.

import { randomUUID } from 'node:crypto'
import { accessSync, closeSync, constants as fsConstants, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { ApprovalObserver } from './approvals.mjs'
import { lastTurnEnd } from './turn-end.mjs'
import { ACTIVE_STATUSES, FEEDBACK_BODY_LIMIT, FEEDBACK_DEDUPE_MS, MAX_CHILDREN, MAX_RECOVERY_ATTEMPTS as TICKET_MAX_RECOVERY_ATTEMPTS, TICKET_STATUSES, TERMINAL_STATUSES, WAITING_ON_BY_STATUS, assertTicketInvariants, canTransition, isTerminal, migrateV1State, normalizeTicket, transitionError } from './tickets.mjs'
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
const MAX_RECOVERY_ATTEMPTS = TICKET_MAX_RECOVERY_ATTEMPTS
const ORIGIN_TEXT_LIMIT = 500
const PROGRESS_PHASE_LIMIT = 80
const DISPATCH_NOTE_LIMIT = 500
const DISPATCH_NOTE_HISTORY = 100
const RECENT_WORKER_WINDOW_MS = 7 * 24 * 60 * 60 * 1000
const RECENT_WORKER_RETENTION_MS = 30 * 24 * 60 * 60 * 1000
const RECENT_WORKER_LIMIT = 5
const ATTACHMENT_LIMIT = 20
const TICKET_ARCHIVE_WINDOW_MS = 24 * 60 * 60 * 1000
const TICKET_ARCHIVE_KEEP = 50
const TICKET_ARCHIVE_BATCH = 200
const TICKET_LOG_MONTHS = 12
const TICKET_HISTORY_LIMIT = 50

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

function ticketSummary(ticket) {
  return {
    ticketId: ticket.ticketId,
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
      this.data.deliveries = Array.isArray(data.deliveries) ? data.deliveries.filter(item => item && typeof item.deliveryId === 'string') : []
      this.data.grants = Array.isArray(data.grants) ? data.grants.filter(item => item && typeof item.grantId === 'string') : []
      const recent = data.recentWorkers && typeof data.recentWorkers === 'object' ? data.recentWorkers : {}
      this.data.recentWorkers = {}
      for (const [id, value] of Object.entries(recent)) {
        if (!id || !value || typeof value !== 'object') continue
        const lastUsedAt = typeof value.lastUsedAt === 'number' && Number.isFinite(value.lastUsedAt) ? value.lastUsedAt : 0
        if (lastUsedAt <= 0) continue
        const record = { lastUsedAt }
        const lastTicketId = typeof value.lastTicketId === 'string' ? value.lastTicketId : (typeof value.lastTaskId === 'string' ? value.lastTaskId : '')
        if (lastTicketId) record.lastTicketId = lastTicketId
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

  touchWorker(sessionId, ticketId) {
    const id = String(sessionId)
    if (!id) return undefined
    const record = this.data.recentWorkers[id] || { lastUsedAt: 0 }
    record.lastUsedAt = now()
    if (ticketId) record.lastTicketId = String(ticketId)
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
      isTicket: Boolean(input.isTicket),
      at: now(),
    }
    if (typeof input.ticketId === 'string' && input.ticketId) record.ticketId = input.ticketId
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
          isTicket: Boolean(item.isTicket || item.isTask),
          at: item.at,
        }
        const ticketId = typeof item.ticketId === 'string' ? item.ticketId : (typeof item.taskId === 'string' ? item.taskId : undefined)
        if (ticketId) result.ticketId = ticketId
        return result
      })
  }

  tickets() { return this.data.tickets }
  activeTickets() { return this.data.tickets.filter(ticket => ACTIVE_STATUSES.includes(ticket.status)) }
  ticket(ticketId) { return this.data.tickets.find(ticket => ticket.ticketId === ticketId) }

  /**
   * Register one real user message as a root intake ticket. This is the host
   * side of the "every user message has a home" rule: it runs before the model
   * sees the message, so Ria cannot forget to create a task.
   *
   * Dedupe is intentional: a replayed pre-step or a retried step must not
   * create a second ticket. The durable message id is the primary key; the
   * (turn, rpcId, text) triple covers older messages without one.
   */
  captureIntake(input) {
    const message = input && input.message
    if (!message || typeof message !== 'object') return undefined
    const source = message.source && typeof message.source === 'object' ? message.source : {}
    const text = clipText(textOfContent(message.content).trim(), 500)
    if (!text) return undefined
    const sessionId = asString(input.sessionId)
    const messageId = asString(message.id)
    const rpcId = asString(source.rpcId)
    const turn = Number.isSafeInteger(input.turn) && input.turn > 0 ? input.turn : undefined
    for (const ticket of this.data.tickets) {
      const origin = ticket.origin || {}
      if (messageId && origin.messageId === messageId && origin.sessionId === sessionId) {
        return { ticket, deduped: true }
      }
      if (!messageId && turn && origin.turn === turn && (origin.rpcId || '') === rpcId && origin.text === text) {
        return { ticket, deduped: true }
      }
    }
    const ticket = this.addTicket({
      status: 'intake',
      goal: text,
      origin: {
        kind: 'user_message',
        text,
        at: now(),
        ...(sessionId ? { sessionId } : {}),
        ...(messageId ? { messageId } : {}),
        ...(rpcId ? { rpcId } : {}),
        ...(turn ? { turn } : {}),
      },
    })
    return { ticket, deduped: false }
  }

  /** Unresolved intakes captured during one turn, oldest first. */
  intakesForTurn(turn) {
    if (!Number.isSafeInteger(turn)) return []
    return this.data.tickets.filter(ticket => ticket.status === 'intake' && ticket.origin && ticket.origin.turn === turn)
  }

  /**
   * Candidates offered to Ria in the intake notice. A blocked ticket waiting
   * for the user has priority, then the most recently touched active tickets.
   */
  intakeCandidates(excludeIds = [], limit = 5) {
    const exclude = new Set(excludeIds)
    return this.data.tickets
      .filter(ticket => ['open', 'working', 'blocked'].includes(ticket.status) && !exclude.has(ticket.ticketId))
      .sort((a, b) => {
        const aBlocked = a.status === 'blocked' && a.waitingOn === 'user' ? 1 : 0
        const bBlocked = b.status === 'blocked' && b.waitingOn === 'user' ? 1 : 0
        if (aBlocked !== bBlocked) return bBlocked - aBlocked
        return (b.updatedAt || 0) - (a.updatedAt || 0)
      })
      .slice(0, limit)
  }

  noteTicket(ticketId, entry) {
    const ticket = this.ticket(ticketId)
    if (!ticket) return undefined
    ticket.history.push({ at: now(), ...entry })
    ticket.revision += 1
    ticket.updatedAt = now()
    this.save()
    return ticket
  }

  /**
   * Consume one intake with exactly one disposition (T2-T8, T10). Every path
   * writes through transitionTicket; a failed validation restores the state
   * snapshot so a multi-step disposition (merge/control) cannot leave half a
   * change behind.
   */
  resolveIntake(ticketId, disposition = {}) {
    const snapshot = JSON.parse(JSON.stringify(this.data))
    const restore = (code, message) => {
      this.data = snapshot
      try { this.save() } catch { /* keep the in-memory state authoritative */ }
      return { ok: false, code, message }
    }
    const source = this.ticket(ticketId)
    if (!source) return { ok: false, code: 'ticket_missing', message: 'ticket not found: ' + ticketId }
    if (source.status !== 'intake') {
      return { ok: false, code: 'intake_already_resolved', message: 'ticket ' + ticketId + ' is already ' + source.status }
    }
    const kind = asString(disposition.kind)
    const at = now()
    const text = source.origin && source.origin.text ? source.origin.text : source.goal
    const fallbackSummary = '已回复：' + clipText(text, 80)
    const finish = (to, options) => {
      const moved = this.transitionTicket(ticketId, to, { actor: 'ria', ...options, executor: options && options.executor !== undefined ? options.executor : (source.executor || 'self') })
      if (!moved.ok) return restore(moved.code, moved.message)
      return { ok: true, ticket: moved.ticket }
    }

    if (kind === 'answered') {
      const summary = asString(disposition.summary) || fallbackSummary
      return finish('done', { resolution: { kind: 'answered', summary } })
    }

    if (kind === 'work') {
      const goal = asString(disposition.goal) || source.goal
      const acceptance = disposition.acceptance !== undefined ? String(disposition.acceptance) : source.acceptance
      const executor = asString(disposition.executor) || 'self'
      if (executor === 'self' && disposition.start === true) {
        return finish('working', {
          goal,
          acceptance,
          executor: 'self',
          waitingOn: 'ria',
          attempt: { count: 1, lastRequestId: null, startedAt: at, legacy: true },
        })
      }
      return finish('open', { goal, acceptance, executor, waitingOn: 'ria' })
    }

    if (kind === 'merge') {
      const targetId = asString(disposition.targetTicketId)
      if (!targetId) return { ok: false, code: 'target_required', message: 'merge needs targetTicketId' }
      if (targetId === ticketId) return { ok: false, code: 'merge_self', message: 'a ticket cannot merge into itself' }
      const target = this.ticket(targetId)
      if (!target) return { ok: false, code: 'target_missing', message: 'target ticket not found: ' + targetId }
      if (isTerminal(target.status) || target.status === 'blocked') {
        const reopened = this.transitionTicket(targetId, 'open', { actor: 'user', reason: 'user message merged into this ticket' })
        if (!reopened.ok) return restore(reopened.code, reopened.message)
      }
      const patch = {}
      if (disposition.goal !== undefined) patch.goal = String(disposition.goal)
      if (disposition.acceptance !== undefined) patch.acceptance = String(disposition.acceptance)
      if (Object.keys(patch).length > 0) {
        try { this.updateTicket(targetId, patch) } catch (error) { return restore(error.code || 'invalid_ticket', error.message) }
      }
      this.noteTicket(targetId, {
        from: 'merged',
        to: this.ticket(targetId).status,
        actor: 'ria',
        reason: 'user message merged: ' + clipText(text, 200),
        sourceTicketId: ticketId,
      })
      const merged = this.transitionTicket(ticketId, 'done', {
        actor: 'ria',
        executor: source.executor || 'self',
        resolution: { kind: 'merged', summary: '已并入 ' + targetId, mergedInto: targetId },
      })
      if (!merged.ok) return restore(merged.code, merged.message)
      return { ok: true, ticket: merged.ticket, target: this.ticket(targetId) }
    }

    if (kind === 'control') {
      const targetId = asString(disposition.targetTicketId)
      if (!targetId) return { ok: false, code: 'target_required', message: 'control needs targetTicketId' }
      const target = this.ticket(targetId)
      if (!target) return { ok: false, code: 'target_missing', message: 'target ticket not found: ' + targetId }
      const action = asString(disposition.action)
      if (!['cancel', 'reopen', 'retry'].includes(action)) {
        return { ok: false, code: 'invalid_action', message: 'control action must be cancel, reopen, or retry' }
      }
      if (action === 'cancel') {
        if (target.status !== 'cancelled') {
          const reason = asString(disposition.reason) || '用户要求取消'
          const moved = this.transitionTicket(targetId, 'cancelled', { actor: 'user', resolution: { kind: 'control', reason } })
          if (!moved.ok) return restore(moved.code, moved.message)
        }
      } else if (isTerminal(target.status) || target.status === 'blocked') {
        const moved = this.transitionTicket(targetId, 'open', { actor: 'user', reason: 'user asked to ' + action })
        if (!moved.ok) return restore(moved.code, moved.message)
      }
      const summary = '控制指令 ' + action + ' 已作用于 ' + targetId
      return finish('done', { resolution: { kind: 'control', action, targetTicketId: targetId, summary } })
    }

    if (kind === 'blocked') {
      const blockedReason = asString(disposition.blockedReason) || asString(disposition.reason)
      if (!blockedReason) return { ok: false, code: 'blocked_reason_required', message: 'blocked needs blockedReason' }
      const waitingOn = asString(disposition.waitingOn) || 'user'
      if (!['user', 'approval', 'environment'].includes(waitingOn)) {
        return { ok: false, code: 'invalid_waiting_on', message: 'blocked waitingOn must be user, approval, or environment' }
      }
      return finish('blocked', { blockedReason, waitingOn })
    }

    if (kind === 'split') {
      return { ok: false, code: 'not_supported', message: 'split/fork is P1 and is not supported yet' }
    }
    return { ok: false, code: 'invalid_disposition', message: 'unknown disposition: ' + (kind || '(empty)') }
  }

  /**
   * Merge source into target (M2). The source converges to done with
   * resolution.kind='merged'; the target keeps its executor, goal, acceptance,
   * and status, and receives the source's children, pending deliveries, and a
   * history/attempt summary. Validation happens before any write; a later
   * failure restores the state snapshot.
   */
  mergeTicket(sourceId, targetId, options = {}) {
    const source = this.ticket(sourceId)
    const target = this.ticket(targetId)
    if (sourceId === targetId) return { ok: false, code: 'merge_self', message: '不能把 ticket 合并到自己' }
    if (!source) return { ok: false, code: 'ticket_missing', message: 'source ticket not found: ' + sourceId }
    if (!target) return { ok: false, code: 'ticket_missing', message: 'target ticket not found: ' + targetId }
    if (source.resolution && source.resolution.kind === 'merged') {
      return { ok: false, code: 'merge_irreversible', message: 'ticket ' + sourceId + ' 已经被合并，不能再合并' }
    }
    if (isTerminal(source.status)) return { ok: false, code: 'source_closed', message: 'source ticket ' + sourceId + ' 已收敛（' + source.status + '）' }
    if (isTerminal(target.status)) return { ok: false, code: 'target_closed', message: 'target ticket ' + targetId + ' 已收敛（' + target.status + '）' }
    const isAncestor = (ancestorId, nodeId) => {
      let cursor = this.ticket(nodeId)
      const seen = new Set()
      while (cursor && cursor.parentTicketId) {
        if (seen.has(cursor.parentTicketId)) return false
        seen.add(cursor.parentTicketId)
        if (cursor.parentTicketId === ancestorId) return true
        cursor = this.ticket(cursor.parentTicketId)
      }
      return false
    }
    if (isAncestor(sourceId, targetId) || isAncestor(targetId, sourceId)) {
      return { ok: false, code: 'merge_cycle', message: 'source 与 target 在同一父子链上，合并会形成环' }
    }
    if (source.parentTicketId && target.parentTicketId && source.rootTicketId !== target.rootTicketId) {
      return { ok: false, code: 'merge_root_mismatch', message: '两个 ticket 属于不同任务树，不能直接合并' }
    }
    const children = source.childTicketIds.map(id => this.ticket(id)).filter(Boolean)
    const activeChildren = children.filter(child => !isTerminal(child.status))
    if (activeChildren.length > 0 && target.executor) {
      return { ok: false, code: 'target_busy', message: 'source 还有未收敛的子 ticket，target 有 executor；请先把 target 变成容器' }
    }
    const combined = new Set([...target.childTicketIds, ...source.childTicketIds])
    if (combined.size > MAX_CHILDREN) {
      return { ok: false, code: 'target_busy', message: 'target 的子 ticket 会超过 ' + MAX_CHILDREN + ' 个' }
    }
    const snapshot = JSON.parse(JSON.stringify(this.data))
    const restore = (code, message) => {
      this.data = snapshot
      try { this.save() } catch { /* keep the in-memory state authoritative */ }
      return { ok: false, code, message }
    }
    const at = now()
    const sourceSnapshot = {
      goal: source.goal,
      acceptance: source.acceptance,
      executor: source.executor,
      status: source.status,
      attempts: JSON.parse(JSON.stringify(source.attempts || [])),
      childTicketIds: [...source.childTicketIds],
      resolution: source.resolution ? JSON.parse(JSON.stringify(source.resolution)) : null,
    }
    target.history.push({
      at,
      kind: 'merge',
      from: sourceId,
      to: targetId,
      actor: options.actor || 'user',
      reason: options.reason || options.note || 'merge',
      snapshot: sourceSnapshot,
    })
    target.attempts.push({
      at,
      executor: source.executor || 'none',
      outcome: source.status === 'blocked' ? 'blocked' : 'completed',
      reason: 'merged from ' + sourceId,
    })
    for (const child of children) {
      child.parentTicketId = targetId
      child.rootTicketId = target.rootTicketId
      child.forkDepth = target.forkDepth + 1
      child.revision += 1
      child.updatedAt = at
    }
    target.childTicketIds = [...combined].sort((a, b) => {
      const left = this.ticket(a)
      const right = this.ticket(b)
      return (left ? left.createdAt : 0) - (right ? right.createdAt : 0) || String(a).localeCompare(String(b))
    })
    target.revision += 1
    target.updatedAt = at
    let movedDeliveries = 0
    for (const delivery of this.data.deliveries) {
      if ((delivery.ticketId || delivery.taskId) === sourceId) {
        delivery.ticketId = targetId
        delete delivery.taskId
        movedDeliveries += 1
      }
    }
    source.childTicketIds = []

    const targetBody = clipText('用户把「' + source.goal + '」并入本任务：' + (options.reason || ''), 500)
    const sourceBody = clipText('已并入 ' + targetId + '，后续进展以目标 ticket 为准', 500)
    this.addFeedback({ ticketId: targetId, kind: 'merged', code: 'merge_target', body: targetBody, at })
    this.addFeedback({ ticketId: sourceId, kind: 'merged', code: 'merged_into', body: sourceBody, at })

    const merged = this.transitionTicket(sourceId, 'done', {
      actor: options.actor || 'user',
      merge: true,
      executor: source.executor || 'self',
      resolution: {
        kind: 'merged',
        summary: '已并入 ' + targetId,
        mergedInto: targetId,
        ...(options.note ? { note: clipText(options.note, 500) } : {}),
      },
    })
    if (!merged.ok) return restore(merged.code, merged.message)
    if (target.executor === null && target.childTicketIds.length > 0 && target.status !== 'forked') {
      const forked = this.transitionTicket(targetId, 'forked', { actor: options.actor || 'user', reason: 'merge moved children' })
      if (!forked.ok) return restore(forked.code, forked.message)
    }
    this.save()
    return {
      ok: true,
      source: this.ticket(sourceId),
      target: this.ticket(targetId),
      movedChildren: children.map(child => child.ticketId),
      movedDeliveries,
    }
  }

  // The design document calls this mergeTask; keep the old name working while
  // the public tool surface is renamed.
  mergeTask(sourceId, targetId, options = {}) {
    return this.mergeTicket(sourceId, targetId, options)
  }

  addTicket(input) {
    const at = now()
    const status = input.status || 'open'
    if (!TICKET_STATUSES.includes(status)) throw transitionError('invalid_status', 'invalid ticket status: ' + status)
    const ticket = normalizeTicket({
      ticketId: newId('ticket_'),
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
    if (patch.recovery !== undefined) next.recovery = { ...next.recovery, ...patch.recovery }
    next.revision += 1
    next.updatedAt = now()
    assertTicketInvariants(next, this.data.tickets)
    Object.assign(ticket, next)
    this.save()
    return ticket
  }

  transitionTicket(ticketId, to, options = {}) {
    const ticket = this.ticket(ticketId)
    if (!ticket) return { ok: false, code: 'ticket_missing', message: 'ticket not found: ' + ticketId }
    if (options.expectedRevision !== undefined && options.expectedRevision !== ticket.revision) {
      return { ok: false, code: 'stale_revision', message: 'ticket ' + ticketId + ' changed since revision ' + options.expectedRevision, ticket }
    }
    if (!TICKET_STATUSES.includes(to)) return { ok: false, code: 'invalid_status', message: 'invalid ticket status: ' + to, ticket }
    if (!canTransition(ticket.status, to) && !(options.merge === true && to === 'done' && !isTerminal(ticket.status))) {
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
    if (isTerminal(to) && ticket.parentTicketId) this.aggregateParent(ticket.parentTicketId)
    return { ok: true, ticket }
  }

  /**
   * Recompute a forked parent after one of its children changed. A parent only
   * converges once every child stopped; priority is blocked > failed >
   * cancelled > done (a blocked child means the user must act, which should not
   * be reported as a failure).
   */
  aggregateParent(parentId) {
    const parent = this.ticket(parentId)
    if (!parent || parent.status !== 'forked') return parent
    const children = parent.childTicketIds.map(id => this.ticket(id)).filter(Boolean)
    if (children.length === 0 || children.some(child => !isTerminal(child.status))) return parent
    const count = status => children.filter(child => child.status === status).length
    const total = children.length
    const at = now()
    if (count('blocked') > 0) {
      const blocked = children.filter(child => child.status === 'blocked').map(child => child.ticketId)
      const moved = this.transitionTicket(parentId, 'blocked', {
        actor: 'system',
        reason: 'children blocked',
        waitingOn: 'user',
        executor: parent.executor || 'self',
        blockedReason: clipText('子任务阻塞：' + blocked.join(', '), 500),
      })
      return moved.ok ? moved.ticket : parent
    }
    if (count('failed') > 0) {
      const failed = count('failed')
      const moved = this.transitionTicket(parentId, 'failed', {
        actor: 'system',
        reason: 'children failed',
        executor: parent.executor || 'self',
        failure: { code: 'child_failed', message: failed + '/' + total + ' 个子任务失败', at },
      })
      return moved.ok ? moved.ticket : parent
    }
    if (count('cancelled') > 0) {
      const cancelled = count('cancelled')
      const moved = this.transitionTicket(parentId, 'cancelled', {
        actor: 'system',
        reason: 'children cancelled',
        executor: parent.executor || 'self',
        resolution: { kind: 'control', reason: cancelled + '/' + total + ' 个子任务被取消，' + count('done') + ' 个完成' },
      })
      return moved.ok ? moved.ticket : parent
    }
    const moved = this.transitionTicket(parentId, 'done', {
      actor: 'system',
      reason: 'all children done',
      executor: parent.executor || 'self',
      resolution: { kind: 'done', summary: '所有子任务完成（' + total + ' 个）' },
    })
    return moved.ok ? moved.ticket : parent
  }

  /**
   * Count one automatic startup recovery for a ticket. Only startup calls this;
   * a successful dispatch, a user answer, or a reopen resets the count.
   */
  bumpRecovery(ticketId, at = now()) {
    const ticket = this.ticket(ticketId)
    if (!ticket) return undefined
    ticket.recovery = { ...ticket.recovery, count: ticket.recovery.count + 1, lastAt: at }
    ticket.revision += 1
    ticket.updatedAt = at
    this.save()
    return ticket
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

  // --- terminal ticket archive -------------------------------------------
  //
  // ria.json stays small: it keeps every non-terminal ticket plus the newest
  // 50 terminal tickets and any terminal ticket closed in the last 24 hours.
  // Older terminal tickets move to append-only JSONL. tasks.log.jsonl is the
  // hot archive segment; tickets-YYYY-MM.jsonl groups records by closedAt and
  // the newest 12 monthly files are retained.

  ticketLogFile(name) {
    return join(this.stateDir, name)
  }

  monthKey(at) {
    const date = new Date(at)
    const year = date.getUTCFullYear()
    const month = String(date.getUTCMonth() + 1).padStart(2, '0')
    return year + '-' + month
  }

  appendArchiveLines(file, records) {
    if (records.length === 0) return
    ensureDir(dirname(file))
    const fd = openSync(file, 'a', 0o600)
    try {
      writeSync(fd, records.map(record => JSON.stringify(record) + '\n').join(''))
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
  }

  archiveRecord(ticket) {
    const feedback = this.data.ticketFeedback.filter(item => item.ticketId === ticket.ticketId)
    const attempts = Array.isArray(ticket.attempts) ? ticket.attempts : []
    const lastAttempt = attempts[attempts.length - 1]
    return {
      schema: 1,
      ticketId: ticket.ticketId,
      goal: ticket.goal,
      executor: ticket.executor,
      status: ticket.status,
      resolution: ticket.resolution || null,
      failure: ticket.failure || null,
      attempts: {
        count: attempts.length,
        lastAt: lastAttempt ? lastAttempt.at : null,
        lastOutcome: lastAttempt ? lastAttempt.outcome : null,
        lastReason: lastAttempt ? lastAttempt.reason : null,
      },
      recoveryCount: ticket.recovery ? ticket.recovery.count : 0,
      parentTicketId: ticket.parentTicketId || null,
      rootTicketId: ticket.rootTicketId || null,
      forkDepth: ticket.forkDepth || 0,
      childTicketIds: Array.isArray(ticket.childTicketIds) ? [...ticket.childTicketIds] : [],
      createdAt: ticket.createdAt,
      updatedAt: ticket.updatedAt,
      closedAt: ticket.closedAt,
      feedback: {
        count: feedback.length,
        lastAt: feedback.length ? feedback[feedback.length - 1].at : null,
        lastText: feedback.length ? feedback[feedback.length - 1].body : '',
      },
      ticket: JSON.parse(JSON.stringify(ticket)),
    }
  }

  /**
   * Move terminal tickets outside the retention window to the archive. A
   * record is written before the ticket leaves memory; if a write fails the
   * ticket stays in ria.json and the next call retries it.
   */
  archiveClosedTickets() {
    const at = now()
    const cutoff = at - TICKET_ARCHIVE_WINDOW_MS
    const terminal = this.data.tickets
      .filter(ticket => isTerminal(ticket.status))
      .sort((a, b) => (b.closedAt || 0) - (a.closedAt || 0))
    const overflow = terminal.filter((ticket, index) => {
      const recent = Number.isFinite(ticket.closedAt) && ticket.closedAt >= cutoff
      return !recent && index >= TICKET_ARCHIVE_KEEP
    }).slice(0, TICKET_ARCHIVE_BATCH)
    if (overflow.length === 0) return { archived: 0 }
    const records = overflow.map(ticket => this.archiveRecord(ticket))
    try {
      this.appendArchiveLines(this.ticketLogFile('tasks.log.jsonl'), records)
      const byMonth = new Map()
      for (const record of records) {
        const key = this.monthKey(record.closedAt || record.updatedAt || at)
        const list = byMonth.get(key) || []
        list.push(record)
        byMonth.set(key, list)
      }
      for (const [month, list] of byMonth) {
        this.appendArchiveLines(this.ticketLogFile('tasks-' + month + '.jsonl'), list)
      }
    } catch (error) {
      return { archived: 0, error: String(error && error.message ? error.message : error) }
    }
    const moved = new Set(overflow.map(ticket => ticket.ticketId))
    this.data.tickets = this.data.tickets.filter(ticket => !moved.has(ticket.ticketId))
    this.save()
    this.pruneTicketLogs()
    return { archived: moved.size }
  }

  pruneTicketLogs() {
    let files
    try {
      files = readdirSync(this.stateDir)
    } catch {
      return
    }
    const monthly = files
      .filter(name => /^tasks-\d{4}-\d{2}\.jsonl$/.test(name))
      .sort()
    const stale = monthly.slice(0, Math.max(0, monthly.length - TICKET_LOG_MONTHS))
    for (const name of stale) {
      try {
        unlinkSync(this.ticketLogFile(name))
      } catch {
        // Retention is best effort; a locked file is retried next time.
      }
    }
  }

  archiveFiles() {
    const current = 'tasks-' + this.monthKey(now()) + '.jsonl'
    const previousDate = new Date(now())
    previousDate.setUTCMonth(previousDate.getUTCMonth() - 1)
    const previous = 'tasks-' + this.monthKey(previousDate.getTime()) + '.jsonl'
    const months = (() => {
      try {
        return readdirSync(this.stateDir)
          .filter(name => /^tasks-\d{4}-\d{2}\.jsonl$/.test(name))
          .sort()
          .reverse()
      } catch {
        return []
      }
    })()
    const ordered = ['tasks.log.jsonl', current, previous, ...months].filter((name, index, list) => list.indexOf(name) === index)
    return ordered.map(name => this.ticketLogFile(name))
  }

  readArchiveFile(file) {
    const raw = readText(file)
    if (!raw.trim()) return []
    const records = []
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue
      try {
        const record = JSON.parse(line)
        if (record && record.ticket && typeof record.ticket.ticketId === 'string') records.push(record)
      } catch {
        // A torn final line is ignored; earlier records remain valid.
      }
    }
    return records
  }

  historyRecords() {
    const seen = new Set()
    const records = []
    for (const file of this.archiveFiles()) {
      for (const record of this.readArchiveFile(file)) {
        if (seen.has(record.ticket.ticketId)) continue
        seen.add(record.ticket.ticketId)
        records.push(record)
      }
    }
    return records.sort((a, b) => (b.closedAt || 0) - (a.closedAt || 0))
  }

  historyTickets(limit = TICKET_HISTORY_LIMIT) {
    const max = Math.max(1, Math.min(200, Number.isSafeInteger(limit) ? limit : TICKET_HISTORY_LIMIT))
    return this.historyRecords().slice(0, max).map(record => ({
      ...ticketSummary(record.ticket),
      archived: true,
    }))
  }

  findArchivedTicket(ticketId) {
    const id = String(ticketId)
    for (const file of this.archiveFiles()) {
      for (const record of this.readArchiveFile(file)) {
        if (record.ticket.ticketId === id) return normalizeTicket(record.ticket)
      }
    }
    return undefined
  }

  /**
   * Bring an archived ticket back into ria.json. The caller reopens it through
   * transitionTicket (done/failed/cancelled -> open) so history is preserved
   * and revision increments.
   */
  restoreArchivedTicket(ticketId) {
    const existing = this.ticket(ticketId)
    if (existing) return existing
    const ticket = this.findArchivedTicket(ticketId)
    if (!ticket) return undefined
    this.data.tickets.push(ticket)
    this.save()
    return ticket
  }

  archivedTickets(limit = TICKET_HISTORY_LIMIT) { return this.historyTickets(limit) }

  deliveries() { return this.data.deliveries }
  delivery(deliveryId) { return this.data.deliveries.find(item => item.deliveryId === deliveryId) }

  addDelivery(input) {
    const delivery = {
      deliveryId: newId('del_'),
      targetSessionId: input.targetSessionId,
      requestId: input.requestId,
      ticketId: input.ticketId || undefined,
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
    'You do not replace workers. You clarify requirements with the user, turn agreed work into tickets, hand tickets to ordinary top-level worker sessions, monitor on demand, and report back.',
    'You may do concrete work yourself only when the user explicitly asks you to; otherwise delegate.',
    '',
    '## How you work',
    '- A user request is ordinary conversation. If goal, scope, or acceptance is unclear, ask only the blocking questions first. Do not dispatch a vague ticket. If the user says to decide, record your assumptions and continue.',
    '- Every request the user hands you must be carried to an end. The host registers each real user message as an intake ticket before you see it and lists it in a [Task intake] notice. In the same turn, call ria_resolve once per listed ticket: answered for a chat reply or question, work to open a tracked task (set executor; start=true only when you begin the work yourself now), merge when the message adds to or answers an existing ticket, control for cancel/reopen/retry, and blocked with blockedReason when you need the user. If you end the turn without a disposition, the host reminds you once; a second stop marks the ticket blocked and shows a card. Never use ria_ticket to edit an intake.',
    '- When a worker refuses a ticket, or the user cancels/stops a worker turn (for example the [Worker idle] note reports aborted(user)), stop and ask the user how to proceed. Never silently reassign the work, re-send it, or switch to another approach on your own; mark the ticket blocked with blockedReason and wait for instructions.',
    '- When a ticket is clear, restate the goal and acceptance once, then create a ticket. One ticket has exactly one executor: self, or one top-level worker session id.',
    '- When the user asks for a ticket but does not name a worker, choose only from recently used top-level workers. Call ria_status with scope="recent": it returns up to 5 workers that Ria has used in the last 7 days, newest first, with sessionId, title, cwd, lastUsedAt, lastTicketGoal, and lastTicketStatus. Pick the one whose workspace, capability, and recent context best fit the ticket, and dispatch to it directly. Do not list or scan all sessions, and never pick a worker that has not been used recently.',
    '- If scope="recent" returns no workers, or none of them clearly fits, or you are still unsure after reading those fields, ask the user which session to use. Do not guess, and do not fall back to an arbitrary or new session.',
    '- A worker counts as recently used only after a successful ria_request to it. Creating or updating a ticket does not count. When the user names a worker session id, use that session if it is top-level; verify it with scope="sessions" when needed. Do not pick subagent sessions or Ria itself.',
    '- Use ria_spawn only when the user asks to create a new worker session, or when no existing worker fits and the user agrees. cwd must be an existing absolute directory; agentPreset and title are optional. After spawning, verify it with ria_status scope="sessions", then dispatch with ria_request. A spawned session is an ordinary top-level worker, not a subagent.',
    '- When the user asks to send image files, pass their absolute paths in ria_request attachments; do not paste base64 into message. The host checks the files, the host image limits, and whether the target model accepts image input before delivery.',
    '- Use ria_request with ticketId to dispatch a ticket. ticketId is required: every dispatch belongs to a tracked ticket. The host provides a neutral anti-misdelivery constraint through the worker\'s system prompt; it does not add any prefix to the message. Do not add that note yourself.',
    '- If a ticket is already running and the requirement changes, ask the user whether to queue or steer before using steer mode.',
    '- Every ria_request MUST include note: one or two sentences for the user that say who received the ticket, what they were asked to do, and what the user will see next. The host displays note as a card at the end of the current turn in the Ria transcript, and mirrors it to WeChat when connected, so it is the user-visible reply; do not rely on assistant text instead, and never send a dispatch without note. A successful request means the message was accepted and the work now belongs to the worker. End the current turn immediately after it: do not sleep, do not poll, and do not call ria_status or ria_read again in this turn. Do not write a wait loop inside run_code.',
    '- A host message beginning with [Worker idle] only means that worker turn ended; it does not mean the ticket is done. It also reports the last turn outcome, including aborted(user) when the user stopped the turn. Read the worker before deciding. If it finished, close the ticket and report. If it is waiting for user input or approval, mark the ticket blocked with blockedReason and report; do not answer for the user. If it needs more work, send a continuation. If the note reports aborted(user) or the worker refused the ticket, do not send a continuation: the ticket is blocked, so report it and wait for the user.',
    '- ria_status is a one-shot snapshot and never waits. Use it only on demand, in a later turn. When the user asks you to keep watching something, use the official schedule tools with target this_session; do not invent a timer.',
    '- Use ria_approval to list worker approval requests that are waiting. This tool only observes; it cannot approve or deny. Tell the user which worker, which tool, and the reason, and that they must open that worker session to allow or deny. Do not claim an approval was granted. After the user decides there, use ria_request with mode=steer only if the task needs a changed instruction.',
    '- Use ria_grant only when the user explicitly asks to change a worker\'s sandbox mode or approval policy. Never enable broader permissions on your own, and never treat a blocked ticket as permission. Set requires userConfirmed=true. The host records originals and restores them when the linked ticket is done/cancelled, on explicit reset, at expiry (default 30 minutes, max 24 hours), or at startup. Use action=list to see active grants; do not claim a grant without one.',
    '- On a restart/recovery message, read the worker first. If the work is done, close the ticket. If it needs the user, mark it blocked with blockedReason and report. If it can continue, send a continuation that tells the worker to inspect the workspace, changed files, and tests before resuming, and not repeat finished work. A ticket that reaches the host recovery limit is marked blocked and reported; do not reopen it without the user. Updating a ticket or successfully dispatching it resets recovery.count, so the limit only counts consecutive unattended restarts.',
    '- When the user asks for a case set from experience, output it in the conversation: requirement, wrong approach, correct approach (usually what the user corrected). Save it to a file only when the user gives an explicit path; use normal file tools.',
    '- Keep memory.md for stable preferences only, never ticket progress or secrets. The current user message wins over memory.',
    '',
    '## Tools',
    'The host exposes ria_resolve, ria_ticket, ria_status, ria_spawn, ria_request, ria_read, ria_memory, ria_approval, and ria_grant.',
    'This session runs PTC. Call these through the generated SDK inside run_code, for example: const r = await tools.ria_status({ scope: "tickets" }); return r.',
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
    // Only abnormal turn ends need host-side cleanup. Completed turns have
    // already been resolved by ria_resolve; intakes survive a crash and are
    // picked up by the next startup instead.
    if (event.type === 'turn/end') this.closeIntakesForTurn(event.data)
  }

  /**
   * Host-side intake enforcement. Two hooks, both scoped to Ria's own agent:
   *
   * 1. agent/pre-step captures every real user message as an intake ticket and
   *    appends a [Task intake] notice to the same step. Capturing before the
   *    model sees the message is what makes "every user message has a home" a
   *    fact rather than a prompt request.
   * 2. agent/turn-stopping reminds once via agent.steer(); a second stop with
   *    an unresolved intake parks it as blocked and shows a card.
   */
  subscribeIntake() {
    const disposePreStep = this.ctx.on('agent/pre-step', (payload, next) => this.onPreStep(payload, next))
    const disposeTurnStopping = this.ctx.on('agent/turn-stopping', payload => this.onTurnStopping(payload))
    return () => {
      try { disposePreStep() } catch { /* already removed */ }
      try { disposeTurnStopping() } catch { /* already removed */ }
    }
  }

  isRiaAgent(agent) {
    const riaId = this.store.riaSessionId
    return Boolean(riaId && agent && String(agent.id) === String(riaId))
  }

  hostMessage(text, form) {
    return {
      id: 'msg_' + randomUUID(),
      role: 'user',
      content: [{ type: 'text', text: String(text) }],
      source: { kind: 'ria-task-host', form },
    }
  }

  async onPreStep(payload, next) {
    const decision = await next()
    if (!decision || decision.kind !== 'enter') return decision
    if (!this.isRiaAgent(payload && payload.agent)) return decision
    const messages = Array.isArray(decision.messages) ? decision.messages : []
    const fresh = []
    for (const message of messages) {
      const source = message && message.source
      if (!source || source.kind !== 'user') continue
      if (isHostRequestId(source.rpcId)) continue
      let captured
      try {
        captured = this.store.captureIntake({
          sessionId: this.store.riaSessionId,
          turn: payload.turn,
          message,
        })
      } catch (error) {
        // A silent capture failure would break the only guarantee the task
        // model makes. Surface it instead of letting the turn continue.
        this.log('error', 'could not capture intake: ' + String(error && error.message ? error.message : error))
        throw error
      }
      if (captured && !captured.deduped) fresh.push(captured.ticket)
    }
    if (fresh.length === 0) return decision
    const notice = this.intakeNotice(fresh)
    return { ...decision, messages: [...messages, this.hostMessage(notice, 'notice')] }
  }

  intakeNotice(tickets) {
    const ids = tickets.map(ticket => ticket.ticketId)
    const candidates = this.store.intakeCandidates(ids)
    const lines = ['[Task intake] 本 turn 登记了 ' + tickets.length + ' 条用户消息，请用 ria_resolve 逐条给出归宿：']
    for (const ticket of tickets) {
      const label = clipText(ticket.origin && ticket.origin.text ? ticket.origin.text : ticket.goal, 120).replace(/\s+/g, ' ')
      const options = candidates.length
        ? candidates.map(item => item.ticketId + '（' + clipText(item.goal, 30).replace(/\s+/g, ' ') + (item.status === 'blocked' && item.waitingOn === 'user' ? '，等你回答' : '') + '）').join(' / ')
        : ''
      lines.push('- ' + ticket.ticketId + ' | "' + label + '" | 候选: 新建' + (options ? ' / ' + options : ''))
    }
    lines.push('规则：answered/work/merge/split/control/blocked 六选一；不要用 ria_ticket 直接改 intake。')
    return lines.join('\n')
  }

  async onTurnStopping(payload) {
    if (!this.isRiaAgent(payload && payload.agent)) return
    const signal = payload.signal
    if (signal && signal.aborted) return
    const turn = payload.turn
    const intakes = this.store.intakesForTurn(turn)
    if (intakes.length === 0) return
    const fresh = intakes.filter(ticket => ticket.nudgeCount === 0)
    if (fresh.length > 0) {
      for (const ticket of fresh) {
        try { this.store.bumpNudge(ticket.ticketId) } catch (error) {
          this.log('warn', 'could not record intake nudge: ' + String(error && error.message ? error.message : error))
        }
      }
      const text = [
        '[Task intake reminder] 本轮还有 ' + fresh.length + ' 条用户消息没有归宿：' + fresh.map(ticket => ticket.ticketId).join('、') + '。',
        '请立即调用 ria_resolve 逐条给出 answered/work/merge/control/blocked。',
        '如果确实需要用户补充信息，用 kind=blocked 写明 blockedReason；不要直接结束 turn。',
      ].join('\n')
      try {
        if (payload.agent && typeof payload.agent.steer === 'function') payload.agent.steer(this.hostMessage(text, 'nudge'))
      } catch (error) {
        this.log('warn', 'could not steer the intake reminder: ' + String(error && error.message ? error.message : error))
      }
      return
    }
    for (const ticket of intakes) {
      const body = '这条用户消息没有在本轮得到归宿（已提醒一次），已标记 blocked：' + clipText(ticket.goal, 120)
      this.store.addFeedback({ ticketId: ticket.ticketId, kind: 'blocked', code: 'intake_unresolved', body, card: true, mirror: true, turn, at: now() })
      const moved = this.store.transitionTicket(ticket.ticketId, 'blocked', {
        actor: 'host',
        blockedReason: 'Ria 未在 turn 内给出归宿（已提醒一次）',
        waitingOn: 'user',
        executor: ticket.executor || 'self',
      })
      if (!moved.ok) {
        this.log('warn', 'could not block unresolved intake ' + ticket.ticketId + ': ' + moved.code)
        continue
      }
      if (this.appendDispatchNote(payload.agent, body, true, ticket.ticketId, turn)) this.notifyDispatchNote(body, true)
    }
  }

  /**
   * Turn-end safety net for intakes the model never resolved. A user-cancelled
   * turn cancels them (there is no work to resume); a turn that errored parks
   * them as blocked with a reason. Other abnormal endings (shutdown/disposal)
   * leave the intake for startup recovery.
   */
  closeIntakesForTurn(data) {
    const turn = data && Number.isSafeInteger(data.turn) ? data.turn : undefined
    if (turn === undefined) return
    const reason = data && data.reason
    const kind = reason && typeof reason === 'object' && typeof reason.kind === 'string' ? reason.kind : ''
    const cancelKind = reason && typeof reason === 'object' && reason.reason && typeof reason.reason === 'object' ? reason.reason.kind : ''
    const intakes = this.store.intakesForTurn(turn)
    if (intakes.length === 0) return
    for (const ticket of intakes) {
      if (kind === 'aborted' && cancelKind === 'user') {
        this.store.transitionTicket(ticket.ticketId, 'cancelled', {
          actor: 'user',
          executor: ticket.executor || 'self',
          resolution: { kind: 'aborted', reason: '用户中止了这一轮' },
        })
      } else if (kind === 'error') {
        const body = '这一轮异常结束，用户消息没有归宿，已标记 blocked：' + clipText(ticket.goal, 120)
        this.store.addFeedback({ ticketId: ticket.ticketId, kind: 'blocked', code: 'turn_failed', body, card: true, mirror: true, turn, at: now() })
        this.store.transitionTicket(ticket.ticketId, 'blocked', {
          actor: 'host',
          executor: ticket.executor || 'self',
          blockedReason: '本轮异常结束（' + (reason && reason.error && reason.error.message ? String(reason.error.message) : 'error') + '），尚未给出归宿',
          waitingOn: 'user',
        })
      }
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
      'ria_ticket',
      'Create, update, close, or merge Ria tickets. A ticket has exactly one executor: self or a top-level worker session id. Use status=done/cancelled to close. Updating any field resets recoveryCount to 0; use status=blocked with blockedReason for a ticket that needs the user. action=merge folds sourceTicketId into targetTicketId: the source becomes done with resolution.kind=merged, and its children, pending deliveries, history, and attempt summary move to the target. Merging is irreversible; nothing is written when a merge check fails.',
      {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['merge'], description: 'Omit for create/update. merge folds sourceTicketId into targetTicketId.' },
          sourceTicketId: { type: 'string', description: 'With action=merge: the ticket to fold in and close.' },
          targetTicketId: { type: 'string', description: 'With action=merge: the ticket that keeps going.' },
          note: { type: 'string', description: 'With action=merge: why they belong together; stored on the target.' },
          reason: { type: 'string', description: 'With action=merge: same as note.' },
          ticketId: { type: 'string', description: 'Existing ticket to update. Omit to create a new ticket.' },
          goal: { type: 'string', description: 'What must be achieved, in the user words.' },
          acceptance: { type: 'string', description: 'How completion is judged.' },
          executor: { type: 'string', description: 'self, or the sessionId of one top-level worker.' },
          status: { type: 'string', enum: TICKET_STATUSES },
          blockedReason: { type: 'string', description: 'Why the ticket is blocked; visible to the user and in status.' },
        },
        additionalProperties: false,
      },
      async args => this.toolTicket(args),
    )

    register(
      'ria_resolve',
      'Give one intake ticket its disposition. The host creates an intake ticket for every real user message before you see it, and lists them in a [Task intake] notice. Call this once per listed ticket, in the same turn. kind=answered closes a chat/question ticket with resolution answered; kind=work opens a real task (executor required, default self; start=true only when you begin the work yourself now); kind=merge folds this message into targetTicketId and reopens it when needed; kind=control applies cancel/reopen/retry to targetTicketId; kind=blocked parks the intake with blockedReason and waitingOn=user|approval|environment. split is P1 and returns not_supported. Only intake tickets can be resolved; a second call returns intake_already_resolved. Do not use ria_ticket to edit an intake.',
      {
        type: 'object',
        properties: {
          ticketId: { type: 'string', description: 'The intake ticket from the [Task intake] notice.' },
          kind: { type: 'string', enum: ['answered', 'work', 'merge', 'split', 'control', 'blocked'] },
          summary: { type: 'string', description: 'For answered: what you told the user.' },
          goal: { type: 'string', description: 'For work: the concrete goal. Defaults to the user message.' },
          acceptance: { type: 'string', description: 'For work: how completion is judged.' },
          executor: { type: 'string', description: 'For work: self or a top-level worker session id. Defaults to self.' },
          start: { type: 'boolean', description: 'For work with executor=self: true only when you start the work in this turn.' },
          targetTicketId: { type: 'string', description: 'For merge/control: the ticket this message belongs to or acts on.' },
          action: { type: 'string', enum: ['cancel', 'reopen', 'retry'], description: 'For control.' },
          reason: { type: 'string', description: 'For blocked/control: why.' },
          blockedReason: { type: 'string', description: 'For blocked: what is missing; visible to the user.' },
          waitingOn: { type: 'string', enum: ['user', 'approval', 'environment'], description: 'For blocked; defaults to user.' },
          expectedRevision: { type: 'number', description: 'Optional concurrency guard; a stale revision returns stale_revision.' },
        },
        required: ['ticketId', 'kind'],
        additionalProperties: false,
      },
      async args => this.toolResolve(args),
    )

    register(
      'ria_status',
      'Read a one-shot snapshot of task state, or list top-level worker sessions. scope=tickets returns tickets in the hot store (every non-terminal ticket plus the newest 50 terminal and those closed in the last 24h); scope=history reads archived terminal tickets from tasks.log.jsonl and the monthly logs, newest first; ticketId returns one ticket whether hot or archived (archived=true). scope=sessions lists all top-level workers with title, cwd, updatedAt and lastUsedAt, plus archived (archived sessions cannot be woken: ria_request rejects them, so skip any session with archived=true); scope=recent lists up to 5 workers Ria used successfully in the last 7 days, newest first, with sessionId, title, cwd, lastUsedAt, lastTicketGoal and lastTicketStatus. On a session item, parentSessionId records fork/seed lineage only and does not make it a subagent. Optionally read one session state. This call never waits for a worker and never resumes a cold session.',
      {
        type: 'object',
        properties: {
          scope: { type: 'string', enum: ['tickets', 'sessions', 'recent', 'history'] },
          sessionId: { type: 'string', description: 'With scope=sessions, read only this session state.' },
          ticketId: { type: 'string', description: 'Return one ticket, including an archived one.' },
          limit: { type: 'number', description: 'With scope=history: 1-200 records, default 50.' },
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
      'Send a message to one or more top-level worker sessions. Before delivering, the host preflights every target: it must exist, be a top-level worker (not Ria, not a subagent), be unarchived, and have a working directory that exists and is enterable. Image attachments are checked too: each absolute path must exist and be a supported image within the host limits, and the target model must accept image input. A target that fails is reported with ok=false plus a machine-readable code (session_missing, not_top_level, session_archived, workspace_missing, task_executor_mismatch, attachment_missing, attachment_invalid, model_no_image) and a Chinese message naming the session; nothing is delivered, it is not recorded as recently used, and its task is not moved to working. Other targets are still attempted. A successful request records each target as recently used by Ria. ticketId is REQUIRED and selects the ticket this dispatch belongs to; its executor must equal every target. note is REQUIRED: one or two user-facing sentences saying who received the ticket, what they were asked to do, and what the user will see next. The host shows note as a card at the end of the current turn in the Ria transcript without adding it to model context, and mirrors the same text to WeChat when connected, so note is the user-visible reply; do not rely on assistant text instead. A missing, blank, or over-500-character note is an error (maximum 500 characters) and nothing is delivered. The host relies on the worker\'s system prompt for the anti-misdelivery constraint and adds no message prefix. The call returns when the message is accepted, not when work finishes. If every target succeeds, it ends the current turn: do not sleep, poll, or call status/read afterward. Use mode=steer only when the user explicitly wants to interrupt.',
      {
        type: 'object',
        properties: {
          targetSessionIds: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 32 },
          message: { type: 'string', description: 'Convenience text content. Ignored when content is provided.' },
          content: { type: 'array', items: { type: 'object', additionalProperties: true }, description: 'DSH prompt content parts: text, image (mediaType/data/name), or file (receiptId).' },
          attachments: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 20, description: 'Absolute paths of image files to attach after the text. Each file must be a supported image (png/jpeg/webp/gif) within the host image limits, and the target model must accept image input.' },
          ticketId: { type: 'string', description: 'Ticket this dispatch belongs to. Required; its executor must equal each target.' },
          note: { type: 'string', description: 'Required. One or two user-facing sentences shown as a card at the end of the current turn in the Ria transcript: who received the ticket, what they were asked to do, and what happens next. Maximum 500 characters; longer notes are rejected, not truncated.' },
          mode: { type: 'string', enum: ['queue', 'steer'] },
        },
        required: ['targetSessionIds', 'ticketId', 'note'],
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
          ticketId: { type: 'string', description: 'Optional ticket whose completion should restore the grant automatically.' },
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
    this.log('info', 'installed manager prompt and 9 tools on ' + sessionId)
  }

  async toolTicket(args) {
    // Reopening an archived ticket: pull its snapshot back from the log first,
    // then let the transition table handle the terminal -> open edge.
    const ticketId = asString(args.ticketId)
    if (ticketId && args.status === 'open' && !this.store.ticket(ticketId)) {
      this.store.restoreArchivedTicket(ticketId)
    }
    if (args.action === 'merge') {
      const sourceId = asString(args.sourceTicketId)
      const targetId = asString(args.targetTicketId)
      if (!sourceId) throw new Error('sourceTicketId is required when action=merge')
      if (!targetId) throw new Error('targetTicketId is required when action=merge')
      const merged = this.store.mergeTicket(sourceId, targetId, {
        reason: asString(args.reason) || asString(args.note),
        note: asString(args.note),
        actor: 'ria',
      })
      if (!merged.ok) return { ok: false, code: merged.code, message: merged.message, error: merged.message }
      const source = ticketSummary(merged.source)
      const target = ticketSummary(merged.target)
      await this.grants.onTicketChanged(merged.source)
      return { ok: true, source, target, movedChildren: merged.movedChildren, movedDeliveries: merged.movedDeliveries }
    }
    if (ticketId) {
      const existing = this.store.ticket(ticketId)
      if (!existing) throw new Error('ticket not found: ' + ticketId)
      if (existing.status === 'intake') {
        throw transitionError('intake_requires_resolve', 'ticket ' + existing.ticketId + ' is an intake; give it a disposition with ria_resolve, not ria_ticket')
      }
      let current = existing
      if (args.status !== undefined) {
        if (!TICKET_STATUSES.includes(args.status)) throw new Error('invalid ticket status: ' + args.status)
        if (args.status !== current.status) {
          const options = { reason: 'ria_ticket update' }
          if (args.blockedReason !== undefined) options.blockedReason = String(args.blockedReason)
          if (args.status === 'done') {
            options.resolution = current.resolution && current.resolution.kind ? current.resolution : { kind: 'done', summary: current.goal || 'done' }
          }
          if (args.status === 'cancelled') {
            options.resolution = current.resolution && current.resolution.kind ? current.resolution : { kind: 'cancelled', reason: current.goal || 'cancelled' }
          }
          const moved = this.store.transitionTicket(ticketId, args.status, options)
          if (!moved.ok) throw transitionError(moved.code, moved.message)
          current = moved.ticket
        }
      }
      const patch = { recovery: { count: 0, lastAt: now() } }
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
      if (args.blockedReason !== undefined && current.status === 'blocked') patch.blockedReason = String(args.blockedReason)
      const ticket = this.store.updateTicket(ticketId, patch) || current
      if (ticket.status === 'done' || ticket.status === 'cancelled') await this.grants.onTicketChanged(ticket)
      return { ticket: ticketSummary(ticket) }
    }
    const goal = asString(args.goal)
    const executor = asString(args.executor)
    if (!goal) throw new Error('goal is required when creating a ticket')
    if (!executor) throw new Error('executor is required when creating a ticket')
    if (args.status !== undefined && !TICKET_STATUSES.includes(args.status)) throw new Error('invalid ticket status: ' + args.status)
    const ticket = this.store.addTicket({ goal, acceptance: args.acceptance ? String(args.acceptance) : '', executor, status: args.status || 'open', blockedReason: args.blockedReason ? String(args.blockedReason) : '' })
    if (ticket.status === 'done' || ticket.status === 'cancelled') await this.grants.onTicketChanged(ticket)
    return { ticket: ticketSummary(ticket) }
  }

  async toolResolve(args) {
    const ticketId = asString(args.ticketId)
    if (!ticketId) throw new Error('ticketId is required')
    const ticket = this.store.ticket(ticketId)
    if (!ticket) return { ok: false, code: 'ticket_missing', message: 'ticket not found: ' + ticketId }
    if (args.expectedRevision !== undefined && Number(args.expectedRevision) !== ticket.revision) {
      return { ok: false, code: 'stale_revision', message: 'ticket ' + ticketId + ' changed since revision ' + args.expectedRevision }
    }
    const kind = asString(args.kind)
    if (kind === 'control' && ['reopen', 'retry'].includes(asString(args.action))) {
      const targetId = asString(args.targetTicketId)
      if (targetId && !this.store.ticket(targetId)) this.store.restoreArchivedTicket(targetId)
    }
    if (kind === 'work') {
      const executor = asString(args.executor) || 'self'
      if (executor !== 'self') {
        const problem = await this.executorProblem(executor)
        if (problem) {
          return { ok: false, code: problem.code, message: problem.message, error: problem.message }
        }
      }
    }
    const result = this.store.resolveIntake(ticketId, {
      kind,
      summary: args.summary,
      goal: args.goal,
      acceptance: args.acceptance,
      executor: args.executor,
      start: args.start === true,
      targetTicketId: args.targetTicketId,
      action: args.action,
      reason: args.reason,
      blockedReason: args.blockedReason,
      waitingOn: args.waitingOn,
    })
    if (!result.ok) return { ok: false, code: result.code, message: result.message, error: result.message }
    const response = { ok: true, ticket: ticketSummary(result.ticket) }
    if (result.target) response.target = ticketSummary(result.target)
    return response
  }

  /**
   * Validate a work disposition's executor before the ticket is opened: it
   * must be a live top-level worker, not Ria, a subagent, or an archived
   * session. Mirrors the ria_request preflight so an intake never opens onto a
   * target that cannot receive work.
   */
  async executorProblem(sessionId) {
    const id = String(sessionId)
    if (id === String(this.store.riaSessionId)) {
      return { code: 'not_top_level', message: 'executor ' + id + ' 是 Ria 自己，不能作为 worker' }
    }
    let items
    try {
      items = await this.listSessions()
    } catch (error) {
      return { code: 'session_missing', message: '无法列出会话：' + String(error && error.message ? error.message : error) }
    }
    const summary = items.find(item => String(item.sessionId) === id)
    if (!summary) return { code: 'session_missing', message: '会话不存在：' + id }
    if (summary.origin === 'subagent') return { code: 'not_top_level', message: '会话 ' + id + ' 是 subagent 子会话' }
    if (this.archivedSessions().has(id)) return { code: 'session_archived', message: '会话 ' + id + ' 已归档，不能接收新任务' }
    return undefined
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
    if (args.ticketId) {
      const id = asString(args.ticketId)
      const hot = this.store.ticket(id)
      if (hot) return { scope: 'ticket', ticket: ticketSummary(hot), archived: false }
      const archived = this.store.findArchivedTicket(id)
      if (archived) return { scope: 'ticket', ticket: ticketSummary(archived), archived: true }
      return { scope: 'ticket', ticket: null, archived: false, found: false }
    }
    if (args.scope === 'history' && !args.sessionId) {
      return {
        scope: 'history',
        tickets: this.store.historyTickets(args.limit),
        archived: true,
      }
    }
    const scope = args.scope === 'recent' && !args.sessionId
      ? 'recent'
      : (args.scope === 'sessions' || args.sessionId ? 'sessions' : 'tickets')
    if (scope === 'tickets') {
      return {
        scope,
        riaSessionId: this.store.riaSessionId || null,
        tickets: this.store.tickets().map(ticketSummary),
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
        const lastTicketId = record.lastTicketId || record.lastTaskId
        if (lastTicketId) {
          item.lastTicketId = lastTicketId
          const ticket = this.store.ticket(lastTicketId)
          if (ticket) {
            item.lastTicketGoal = ticket.goal
            item.lastTicketStatus = ticket.status
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
    const ticketId = asString(args.ticketId)
    if (!ticketId) throw new Error('ticketId is required')
    const ticket = this.store.ticket(ticketId)
    if (!ticket) throw new Error('ticket not found: ' + ticketId)
    if (isTerminal(ticket.status)) throw new Error('ticket is closed: ' + ticketId)
    const note = this.dispatchNote(args)

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
      results.push({ targetSessionId: target, ok: false, code, message, error: message, ticketId })
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
      if (ticket.executor !== target) {
        reject(target, 'ticket_executor_mismatch', 'ticket ' + ticketId + ' 的 executor 是 ' + ticket.executor + '，不是目标会话 ' + target + '。未投递。')
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
      const delivery = this.store.addDelivery({ targetSessionId: target, requestId, ticketId, content, mode })
      try {
        await this.ctx.sessionController.prompt({ requestId, sessionId: target, mode, content }, signal)
        this.store.removeDelivery(delivery.deliveryId)
        const moved = this.store.transitionTicket(ticket.ticketId, 'working', {
          attempt: { lastRequestId: requestId, startedAt: now(), legacy: false },
          reason: 'dispatch accepted',
        })
        if (!moved.ok) throw transitionError(moved.code, moved.message)
        moved.ticket.recovery = { ...moved.ticket.recovery, count: 0 }
        try {
          this.store.touchWorker(target, ticketId, moved && moved.ticket)
        } catch (error) {
          this.log('warn', 'could not record recent worker ' + target + ': ' + String(error && error.message ? error.message : error))
        }
        results.push({ targetSessionId: target, ok: true, requestId, ticketId })
      } catch (error) {
        results.push({ targetSessionId: target, ok: false, requestId, ticketId, error: String(error && error.message ? error.message : error) })
      }
    }
    if (results.every(item => item.ok)) {
      this.appendDispatchNote(exec.agent, note, ticketId)
      this.notifyDispatchNote(note, true)
      exec.concludeTurn()
    }
    return { results, pendingDeliveries: this.store.deliveries().length }
  }

  dispatchNote(args) {
    const text = typeof args.note === 'string' ? args.note.trim() : ''
    if (!text) throw new Error('ria_request requires a non-empty note: one or two sentences for the user saying who received the ticket, what they were asked to do, and what happens next')
    const length = [...text].length
    if (length > DISPATCH_NOTE_LIMIT) throw new Error('ria_request note is ' + length + ' characters; the maximum is ' + DISPATCH_NOTE_LIMIT + '. Shorten it; the note is not truncated.')
    return text
  }

  appendDispatchNote(agent, note, ticketId, turnOverride) {
    const riaId = this.store.riaSessionId
    if (!agent || String(agent.id) !== String(riaId)) {
      this.log('warn', 'could not display dispatch note: not on Ria')
      return false
    }
    let turn = Number.isSafeInteger(turnOverride) ? turnOverride : undefined
    try {
      if (turn === undefined) turn = lastTurnNumber(agent.session)
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
      this.store.recordDispatchNote({ sessionId: riaId, turn, note, isTicket: true, ticketId })
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
  notifyDispatchNote(note, isTicket) {
    try {
      const pending = this.wechat.sendDispatchNote(note, { isTask: isTicket })
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
        const ticketId = delivery.ticketId || delivery.taskId
        if (ticketId) {
          const ticket = this.store.ticket(ticketId)
          if (ticket && (ticket.status === 'open' || ticket.status === 'working')) {
            const moved = this.store.transitionTicket(ticket.ticketId, 'working', { attempt: { lastRequestId: delivery.requestId, startedAt: now(), legacy: false } })
            if (moved.ok) moved.ticket.recovery = { ...moved.ticket.recovery, count: 0 }
          }
        }
      } catch (error) {
        this.log('warn', 'pending delivery ' + delivery.deliveryId + ' still failing: ' + String(error && error.message ? error.message : error))
      }
    }
  }

  /**
   * Tickets a restart should report: intake (no disposition yet), open (not
   * dispatched), and working (a worker may still be running). A forked parent
   * is only a container; recurse into its children instead of recovering the
   * parent itself. Blocked, failed, done, and cancelled tickets are not
   * auto-recovered.
   */
  recoveryUnits() {
    const units = []
    const seen = new Set()
    const visit = ticketId => {
      if (!ticketId || seen.has(ticketId)) return
      seen.add(ticketId)
      const ticket = this.store.ticket(ticketId)
      if (!ticket) return
      if (ticket.status === 'forked') {
        for (const childId of ticket.childTicketIds) visit(childId)
        return
      }
      if (['intake', 'open', 'working'].includes(ticket.status)) units.push(ticket)
    }
    for (const ticket of this.store.tickets()) {
      if (!ticket.parentTicketId) visit(ticket.ticketId)
    }
    return units
  }

  /**
   * Stop recovering one ticket: park it as blocked, write the failure code, and
   * emit the one-shot recovery_exhausted feedback. A blocked ticket is no
   * longer a recovery unit, so this happens exactly once.
   */
  async blockForRecovery(ticket, agent) {
    const body = 'ticket ' + ticket.ticketId + ' 自动恢复已达上限（' + MAX_RECOVERY_ATTEMPTS + '/' + MAX_RECOVERY_ATTEMPTS + '），已停止自动推进；需要用户手动处理。'
    const moved = this.store.transitionTicket(ticket.ticketId, 'blocked', {
      actor: 'system',
      reason: 'automatic recovery limit reached',
      blockedReason: recoveryLimitReason(),
      waitingOn: 'user',
      executor: ticket.executor || 'self',
      failure: { code: 'recovery_exhausted', message: recoveryLimitReason(), at: now() },
    })
    if (!moved.ok) {
      this.log('warn', 'could not block ' + ticket.ticketId + ' after recovery limit: ' + moved.message)
      return
    }
    try {
      this.store.addFeedback({
        ticketId: ticket.ticketId,
        kind: 'recovery_exhausted',
        code: 'recovery_exhausted',
        body,
        card: true,
        mirror: true,
      })
    } catch (error) {
      this.log('warn', 'could not record recovery feedback: ' + String(error && error.message ? error.message : error))
    }
    this.appendDispatchNote(agent, body, true, ticket.ticketId)
    this.notifyDispatchNote(body, true)
  }

  async startup() {
    if (this.started) return
    this.started = true
    try {
      const archived = this.store.archiveClosedTickets()
      if (archived.archived) this.log('info', 'archived ' + archived.archived + ' closed ticket(s)')
      if (archived.error) this.log('warn', 'could not archive closed tickets: ' + archived.error)
      await this.grants.reconcile()
      const initialUnits = this.recoveryUnits()
      const hasPending = this.store.deliveries().length > 0
      if (!initialUnits.length && !hasPending) return
      if (!initialUnits.length) {
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
        // Retrying pending deliveries can move tickets, so collect units again.
        const units = this.recoveryUnits()
        const exhausted = units.filter(ticket => (ticket.recovery && ticket.recovery.count || 0) >= MAX_RECOVERY_ATTEMPTS)
        const candidates = units.filter(ticket => (ticket.recovery && ticket.recovery.count || 0) < MAX_RECOVERY_ATTEMPTS)
        if (!candidates.length && !exhausted.length) return
        const riaInfo = await this.ensure()
        const resolved = await this.resolve(riaInfo.sessionId)
        const riaAgent = 'agent' in resolved ? resolved.agent : undefined
        for (const ticket of exhausted) await this.blockForRecovery(ticket, riaAgent)
        if (!candidates.length) return
        const lines = ['DSH 刚刚重启。以下 ticket 还没有收敛，请逐条处理；不要重复已完成的部分。']
        const detailed = candidates.slice(0, 10)
        for (const ticket of detailed) {
          const next = this.store.bumpRecovery(ticket.ticketId)
          const count = next ? next.recovery.count : (ticket.recovery.count || 0) + 1
          const origin = ticket.origin || {}
          const parts = [
            'ticketId=' + ticket.ticketId,
            'status=' + ticket.status,
            'executor=' + (ticket.executor || 'null'),
            'goal=' + ticket.goal,
            'acceptance=' + (ticket.acceptance || '(未填写)'),
          ]
          if (origin.text) parts.push('原消息=' + origin.text)
          if (origin.at) parts.push('开始于=' + formatStartedAt(origin.at))
          if (ticket.progress && ticket.progress.lastPhase) parts.push('最近动作=' + ticket.progress.lastPhase)
          parts.push('recovery=' + count + '/' + MAX_RECOVERY_ATTEMPTS)
          lines.push('- ' + parts.join(' | '))
          if (ticket.status === 'intake') {
            lines.push('  这条用户消息还没有归宿：先 ria_read 自己的会话（sessionId=' + riaInfo.sessionId + '）确认做到哪一步，再用 ria_resolve 定性。')
          } else if (ticket.status === 'working') {
            lines.push('  先 ria_read worker 会话（sessionId=' + (ticket.executor || '未知') + '）和工作区，检查已改文件与测试；判断继续、done、failed 或 blocked，不能假设 worker 还在跑。')
          } else {
            lines.push('  检查 executor 是否可用；可用就用 ria_request 派发，否则标 blocked 并说明缺什么。')
          }
        }
        if (candidates.length > detailed.length) {
          lines.push('')
          lines.push('其余 ' + (candidates.length - detailed.length) + ' 个候选只列摘要：')
          for (const ticket of candidates.slice(detailed.length)) {
            this.store.bumpRecovery(ticket.ticketId)
            lines.push('- ticketId=' + ticket.ticketId + ' | goal=' + ticket.goal)
          }
        }
        lines.push('')
        lines.push('处理后用 ria_ticket/ria_status 更新状态；无法推进就标 blocked 并写清楚卡在谁那里。')
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
        tickets: this.store.tickets().map(ticketSummary),
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
  }, 'dsh-ria: ticket recovery tracking')
  const disposeIntake = service.subscribeIntake()
  ctx.effect(() => () => {
    try { disposeIntake() } catch { /* already removed */ }
  }, 'dsh-ria: intake enforcement')
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
