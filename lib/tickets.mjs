// Ticket state machines for Ria's task model.
//
// A ticket is the durable unit of work a user request turns into. This module
// owns the status vocabulary, the v1 -> v2 migration, and the validation that
// every transition must pass. RiaStore is the only caller that writes a
// transition; keeping the rules here makes them testable without a store.

export const TICKET_STATUSES = ['intake', 'open', 'working', 'blocked', 'forked', 'done', 'failed', 'cancelled']
export const TERMINAL_STATUSES = ['done', 'failed', 'cancelled']
export const ACTIVE_STATUSES = ['intake', 'open', 'working', 'blocked', 'forked']
export const MAX_FORK_DEPTH = 2
export const MIN_CHILDREN = 2
export const MAX_CHILDREN = 8
export const MAX_RECOVERY_ATTEMPTS = 3
export const FEEDBACK_BODY_LIMIT = 500
export const FEEDBACK_DEDUPE_MS = 5000
export const WAITING_ON_BY_STATUS = {
  intake: 'ria',
  open: 'ria',
  working: 'worker',
  blocked: 'user',
  forked: 'children',
  done: 'none',
  failed: 'none',
  cancelled: 'none',
}
export const WAITING_ON_VALUES = ['ria', 'worker', 'user', 'approval', 'environment', 'children', 'none']
export const ATTENTION_KINDS = ['question', 'approval', 'decision']
export const ATTENTION_TEXT_LIMIT = 500
export const ATTENTION_OPTION_LIMIT = 200
export const ATTENTION_MAX_OPTIONS = 10

// T1-T28 from docs/task-model-design.md. Every edge here is legal; anything
// else is rejected with invalid_transition rather than silently rewritten.
export const TICKET_TRANSITIONS = {
  intake: ['open', 'working', 'forked', 'blocked', 'cancelled', 'done'],
  open: ['open', 'working', 'blocked', 'cancelled'],
  working: ['working', 'done', 'failed', 'blocked', 'cancelled'],
  blocked: ['open', 'cancelled'],
  forked: ['forked', 'done', 'failed', 'blocked', 'cancelled'],
  done: ['open'],
  failed: ['open'],
  cancelled: ['open'],
}

export function isTerminal(status) {
  return TERMINAL_STATUSES.includes(status)
}

export function canTransition(from, to) {
  return Boolean(TICKET_TRANSITIONS[from] && TICKET_TRANSITIONS[from].includes(to))
}

export function transitionError(code, message, extra = {}) {
  const error = new Error(message)
  error.code = code
  Object.assign(error, extra)
  return error
}

function asString(value) {
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * Structured "what is Ria waiting for the user to decide" on a blocked ticket.
 * The old free-text blockedReason stays authoritative for the invariant; when a
 * question is present it is also the fallback reason for legacy readers.
 */
export function normalizeAttention(raw, at = Date.now()) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const question = [...asString(raw.question)].slice(0, ATTENTION_TEXT_LIMIT).join('')
  if (!question) return null
  const kind = ATTENTION_KINDS.includes(raw.kind) ? raw.kind : 'question'
  const attention = {
    kind,
    question,
    askedAt: Number.isFinite(raw.askedAt) ? raw.askedAt : at,
    askedBy: asString(raw.askedBy) || 'ria',
  }
  const options = Array.isArray(raw.options)
    ? raw.options.map(item => [...asString(item)].slice(0, ATTENTION_OPTION_LIMIT).join('')).filter(Boolean).slice(0, ATTENTION_MAX_OPTIONS)
    : []
  if (options.length) attention.options = options
  const ref = asString(raw.ref)
  if (ref) attention.ref = ref
  return attention
}

function cloneJson(value) {
  if (value === undefined || value === null) return value
  return JSON.parse(JSON.stringify(value))
}

function normalizeOrigin(raw, ticket, at) {
  const origin = raw && typeof raw === 'object' ? raw : {}
  const text = asString(origin.text) || asString(ticket.goal)
  const result = {
    kind: asString(origin.kind) || 'legacy',
    text: [...text].slice(0, 500).join(''),
    at: Number.isFinite(origin.at) ? origin.at : (Number.isFinite(ticket.createdAt) ? ticket.createdAt : at),
  }
  for (const key of ['sessionId', 'messageId', 'rpcId']) {
    if (typeof origin[key] === 'string' && origin[key]) result[key] = origin[key]
  }
  if (Number.isSafeInteger(origin.turn) && origin.turn > 0) result.turn = origin.turn
  return result
}

export function normalizeTicket(raw, at = Date.now()) {
  if (!raw || typeof raw !== 'object') return undefined
  const ticketId = asString(raw.ticketId) || asString(raw.taskId)
  if (!ticketId) return undefined
  let status = TICKET_STATUSES.includes(raw.status) ? raw.status : 'open'
  const createdAt = Number.isFinite(raw.createdAt) ? raw.createdAt : at
  const updatedAt = Number.isFinite(raw.updatedAt) ? raw.updatedAt : createdAt
  const goal = asString(raw.goal) || '(未填写目标)'
  const acceptance = typeof raw.acceptance === 'string' ? raw.acceptance : ''
  const ticket = {
    ticketId,
    status,
    goal,
    acceptance,
    executor: status === 'intake' || status === 'forked' ? null : (asString(raw.executor) || 'self'),
    waitingOn: WAITING_ON_VALUES.includes(raw.waitingOn) ? raw.waitingOn : WAITING_ON_BY_STATUS[status],
    origin: normalizeOrigin(raw.origin, { goal, createdAt }, at),
    parentTicketId: typeof raw.parentTicketId === 'string' && raw.parentTicketId ? raw.parentTicketId : null,
    rootTicketId: typeof raw.rootTicketId === 'string' && raw.rootTicketId ? raw.rootTicketId : ticketId,
    forkDepth: Number.isSafeInteger(raw.forkDepth) && raw.forkDepth >= 0 ? raw.forkDepth : 0,
    childTicketIds: Array.isArray(raw.childTicketIds) ? [...new Set(raw.childTicketIds.map(asString).filter(Boolean))] : [],
    dependsOn: Array.isArray(raw.dependsOn) ? [...new Set(raw.dependsOn.map(asString).filter(Boolean))] : [],
    fork: raw.fork && typeof raw.fork === 'object' ? cloneJson(raw.fork) : null,
    attempt: raw.attempt && typeof raw.attempt === 'object' ? cloneJson(raw.attempt) : { count: 0, lastRequestId: null, startedAt: null, legacy: true },
    attempts: Array.isArray(raw.attempts) ? raw.attempts.filter(item => item && typeof item === 'object').map(cloneJson) : [],
    lastWorkerTurn: raw.lastWorkerTurn && typeof raw.lastWorkerTurn === 'object' ? cloneJson(raw.lastWorkerTurn) : null,
    progress: raw.progress && typeof raw.progress === 'object' ? cloneJson(raw.progress) : { lastPhase: '', lastEventAt: 0, stale: false },
    recovery: raw.recovery && typeof raw.recovery === 'object'
      ? { count: Number.isSafeInteger(raw.recovery.count) && raw.recovery.count >= 0 ? raw.recovery.count : 0, lastAt: Number.isFinite(raw.recovery.lastAt) ? raw.recovery.lastAt : 0 }
      : { count: Number.isSafeInteger(raw.recoveryCount) && raw.recoveryCount >= 0 ? raw.recoveryCount : 0, lastAt: 0 },
    blockedReason: typeof raw.blockedReason === 'string' ? raw.blockedReason : '',
    attention: normalizeAttention(raw.attention, at),
    failure: raw.failure && typeof raw.failure === 'object' ? cloneJson(raw.failure) : null,
    resolution: raw.resolution && typeof raw.resolution === 'object' ? cloneJson(raw.resolution) : null,
    history: Array.isArray(raw.history) ? raw.history.filter(item => item && typeof item === 'object').map(cloneJson) : [],
    feedback: raw.feedback && typeof raw.feedback === 'object' ? cloneJson(raw.feedback) : { lastAt: 0, lastKind: '' },
    nudgeCount: Number.isSafeInteger(raw.nudgeCount) && raw.nudgeCount >= 0 ? raw.nudgeCount : 0,
    reopenCount: Number.isSafeInteger(raw.reopenCount) && raw.reopenCount >= 0 ? raw.reopenCount : 0,
    revision: Number.isSafeInteger(raw.revision) && raw.revision > 0 ? raw.revision : 1,
    createdAt,
    updatedAt,
    closedAt: Number.isFinite(raw.closedAt) ? raw.closedAt : (isTerminal(status) ? updatedAt : null),
  }
  // Only records without an attempt are legacy; explicit legacy:false must
  // retain the request-id invariant when v2 tickets are loaded.
  if (status === 'working' && !raw.attempt) ticket.attempt = { ...ticket.attempt, lastRequestId: null, legacy: true }
  // v1 tasks closed before the schema knew about terminal metadata. Backfill a
  // minimal, explicit resolution/failure so the invariants stay meaningful
  // instead of rejecting the whole migrated store.
  if (status === 'done' && (!ticket.resolution || !asString(ticket.resolution.summary))) {
    ticket.resolution = { kind: 'done', summary: goal, legacy: true }
  }
  if (status === 'cancelled' && (!ticket.resolution || !(asString(ticket.resolution.reason) || asString(ticket.resolution.summary)))) {
    ticket.resolution = { kind: 'cancelled', reason: goal, legacy: true }
  }
  if (status === 'failed' && (!ticket.failure || !asString(ticket.failure.code) || !asString(ticket.failure.message))) {
    ticket.failure = { code: 'legacy_failure', message: goal, at: updatedAt, legacy: true }
  }
  if (ticket.attention && !(ticket.status === 'blocked' && ticket.waitingOn === 'user')) ticket.attention = null
  if (ticket.attention && !ticket.blockedReason) ticket.blockedReason = ticket.attention.question
  if (status === 'blocked' && !ticket.blockedReason) ticket.blockedReason = 'legacy blocked ticket'
  return ticket
}

function feedbackFromNote(note, at) {
  return {
    feedbackId: 'fb_' + String(at).toString(36) + '_' + Math.random().toString(36).slice(2, 8),
    ticketId: typeof note.taskId === 'string' ? note.taskId : undefined,
    kind: 'dispatched',
    code: '',
    body: [...String(note.note)].slice(0, FEEDBACK_BODY_LIMIT).join(''),
    turn: Number.isSafeInteger(note.turn) ? note.turn : undefined,
    at: Number.isFinite(note.at) ? note.at : at,
    card: true,
    mirror: true,
  }
}

/**
 * Migrate a parsed v1 state object into schema v2. Pure: it does not touch the
 * disk. The caller writes ria.json.v1.bak before saving the result.
 */
export function migrateV1State(parsed, at = Date.now()) {
  const tickets = []
  for (const raw of Array.isArray(parsed.tasks) ? parsed.tasks : []) {
    if (!raw || typeof raw !== 'object') continue
    const ticket = normalizeTicket(raw, at)
    if (!ticket) continue
    tickets.push(ticket)
  }
  // The old top-level inFlight patch becomes a real ticket. Matching an
  // existing active ticket by its captured text avoids duplicating work that
  // already has a home; otherwise it is an open ticket Ria still owes an
  // outcome for.
  const legacyInFlight = parsed.inFlight && typeof parsed.inFlight === 'object' ? parsed.inFlight : undefined
  if (legacyInFlight && typeof legacyInFlight.lastUserMessage === 'string' && legacyInFlight.lastUserMessage.trim()) {
    const text = [...legacyInFlight.lastUserMessage.trim()].slice(0, FEEDBACK_BODY_LIMIT).join('')
    const match = tickets.find(ticket => !isTerminal(ticket.status) && (
      ticket.origin.text === text || ticket.goal === text
    ))
    const recoveryCount = Number.isInteger(legacyInFlight.recoveryCount) && legacyInFlight.recoveryCount > 0 ? legacyInFlight.recoveryCount : 0
    if (match) {
      match.recovery.count = Math.max(match.recovery.count, recoveryCount)
      match.progress.lastPhase = match.progress.lastPhase || (legacyInFlight.lastPhase ? String(legacyInFlight.lastPhase) : '')
      match.updatedAt = at
      match.revision += 1
    } else {
      const exhausted = recoveryCount >= MAX_RECOVERY_ATTEMPTS
      tickets.push(normalizeTicket({
        ticketId: 'ticket_' + at.toString(36) + '_' + Math.random().toString(36).slice(2, 8),
        status: exhausted ? 'blocked' : 'open',
        goal: text,
        acceptance: '',
        executor: 'self',
        waitingOn: exhausted ? 'user' : 'ria',
        origin: {
          kind: 'legacy_inflight',
          text,
          at: Number.isFinite(legacyInFlight.startedAt) ? legacyInFlight.startedAt : at,
          sessionId: typeof parsed.riaSessionId === 'string' ? parsed.riaSessionId : undefined,
          turn: Number.isSafeInteger(legacyInFlight.turnId) ? legacyInFlight.turnId : undefined,
        },
        recovery: { count: recoveryCount, lastAt: at },
        progress: { lastPhase: legacyInFlight.lastPhase ? String(legacyInFlight.lastPhase) : '' },
        ...(exhausted ? {
          blockedReason: '自动恢复已达上限（' + MAX_RECOVERY_ATTEMPTS + '/' + MAX_RECOVERY_ATTEMPTS + '），需要用户手动处理',
          failure: { code: 'recovery_exhausted', message: 'automatic recovery limit reached', at },
        } : {}),
        createdAt: Number.isFinite(legacyInFlight.startedAt) ? legacyInFlight.startedAt : at,
        updatedAt: at,
      }, at))
    }
  }
  const feedback = []
  for (const note of Array.isArray(parsed.dispatchNotes) ? parsed.dispatchNotes : []) {
    if (!note || typeof note.note !== 'string' || !note.note.trim()) continue
    feedback.push(feedbackFromNote(note, at))
  }
  return {
    data: {
      schemaVersion: 2,
      version: 2,
      riaSessionId: typeof parsed.riaSessionId === 'string' ? parsed.riaSessionId : undefined,
      riaPreset: typeof parsed.riaPreset === 'string' ? parsed.riaPreset : undefined,
      createdAt: Number.isFinite(parsed.createdAt) ? parsed.createdAt : undefined,
      tickets,
      ticketFeedback: feedback,
      deliveries: Array.isArray(parsed.deliveries) ? parsed.deliveries : [],
      grants: Array.isArray(parsed.grants) ? parsed.grants : [],
      recentWorkers: parsed.recentWorkers && typeof parsed.recentWorkers === 'object' ? parsed.recentWorkers : {},
      settings: {
        dispatchGuard: !(parsed.settings && parsed.settings.dispatchGuard === false),
        progressCards: Boolean(parsed.settings && parsed.settings.progressCards),
      },
    },
    migrated: true,
  }
}

function requireText(value) {
  return typeof value === 'string' && value.trim().length > 0
}

function normalizeResolution(resolution) {
  if (!resolution || typeof resolution !== 'object') return null
  const result = cloneJson(resolution)
  if (!requireText(result.kind)) return null
  return result
}

/**
 * Validate every invariant that can be checked from the ticket and the current
 * ticket list. Throws a transitionError with a stable code.
 */
export function assertTicketInvariants(ticket, tickets = [], at = Date.now()) {
  if (!TICKET_STATUSES.includes(ticket.status)) {
    throw transitionError('invalid_status', 'invalid ticket status: ' + String(ticket.status))
  }
  if (!WAITING_ON_VALUES.includes(ticket.waitingOn)) {
    throw transitionError('invalid_waiting_on', 'invalid waitingOn: ' + String(ticket.waitingOn))
  }
  if (ticket.status === 'intake' || ticket.status === 'forked') {
    if (ticket.executor !== null) throw transitionError('invalid_executor', ticket.status + ' tickets must not have an executor')
  } else if (!requireText(ticket.executor)) {
    throw transitionError('invalid_executor', ticket.status + ' tickets require an executor')
  }
  if (ticket.attention && !(ticket.status === 'blocked' && ticket.waitingOn === 'user')) {
    throw transitionError('invalid_attention', 'attention is only valid on a ticket blocked waiting on the user')
  }
  if (ticket.status === 'blocked') {
    if (!requireText(ticket.blockedReason)) throw transitionError('blocked_reason_required', 'a blocked ticket requires blockedReason')
    if (!['user', 'approval', 'environment'].includes(ticket.waitingOn)) {
      throw transitionError('invalid_waiting_on', 'a blocked ticket must wait on user, approval, or environment')
    }
  } else if (ticket.status === 'working') {
    if (!['worker', 'ria'].includes(ticket.waitingOn)) throw transitionError('invalid_waiting_on', 'a working ticket must wait on worker or ria')
    if (!ticket.attempt.lastRequestId && !ticket.attempt.legacy) {
      throw transitionError('attempt_required', 'a working ticket requires attempt.lastRequestId')
    }
  } else if (ticket.status === 'forked') {
    if (ticket.waitingOn !== 'children') throw transitionError('invalid_waiting_on', 'a forked ticket must wait on children')
    if (ticket.childTicketIds.length < MIN_CHILDREN || ticket.childTicketIds.length > MAX_CHILDREN) {
      throw transitionError('children_required', 'a forked ticket requires ' + MIN_CHILDREN + '-' + MAX_CHILDREN + ' children')
    }
  } else if (ticket.status === 'intake' || ticket.status === 'open') {
    if (ticket.waitingOn !== 'ria') throw transitionError('invalid_waiting_on', ticket.status + ' tickets must wait on ria')
  } else if (ticket.waitingOn !== 'none') {
    throw transitionError('invalid_waiting_on', 'terminal tickets must wait on none')
  }
  if (ticket.status === 'done' && !(ticket.resolution && requireText(ticket.resolution.summary))) {
    throw transitionError('resolution_required', 'a done ticket requires resolution.summary')
  }
  if (ticket.status === 'failed' && !(ticket.failure && requireText(ticket.failure.code) && requireText(ticket.failure.message))) {
    throw transitionError('failure_required', 'a failed ticket requires failure.code and failure.message')
  }
  if (ticket.status === 'cancelled' && !(ticket.resolution && (requireText(ticket.resolution.reason) || requireText(ticket.resolution.summary)))) {
    throw transitionError('resolution_required', 'a cancelled ticket requires resolution.reason')
  }
  if (ticket.forkDepth > MAX_FORK_DEPTH) throw transitionError('fork_depth_exceeded', 'forkDepth exceeds ' + MAX_FORK_DEPTH)
  if (ticket.parentTicketId) {
    if (ticket.parentTicketId === ticket.ticketId) throw transitionError('fork_cycle', 'a ticket cannot be its own parent')
    const parent = tickets.find(item => item.ticketId === ticket.parentTicketId)
    if (!parent) throw transitionError('parent_missing', 'parent ticket not found: ' + ticket.parentTicketId)
    if (!parent.childTicketIds.includes(ticket.ticketId)) {
      throw transitionError('parent_child_missing', 'parent does not list ' + ticket.ticketId + ' as a child')
    }
    if (ticket.forkDepth !== parent.forkDepth + 1) {
      throw transitionError('fork_depth_invalid', 'forkDepth must be parent.forkDepth + 1')
    }
  }
  // Walk to the root; a cycle or more than MAX_FORK_DEPTH+1 hops is invalid.
  let cursor = ticket
  const seen = new Set([ticket.ticketId])
  for (let depth = 0; cursor.parentTicketId && depth <= MAX_FORK_DEPTH + 1; depth += 1) {
    if (seen.has(cursor.parentTicketId)) throw transitionError('fork_cycle', 'ticket parent cycle')
    seen.add(cursor.parentTicketId)
    cursor = tickets.find(item => item.ticketId === cursor.parentTicketId)
    if (!cursor) throw transitionError('parent_missing', 'parent ticket not found')
  }
  if (cursor && cursor.parentTicketId) throw transitionError('fork_depth_exceeded', 'ticket parent chain is too deep')
  if (isTerminal(ticket.status) && !Number.isFinite(ticket.closedAt)) {
    throw transitionError('closed_at_required', 'a terminal ticket requires closedAt')
  }
  return true
}
