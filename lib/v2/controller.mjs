import { randomUUID } from 'node:crypto'
import { mkdirSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute, join, resolve, sep } from 'node:path'
import { HOST_REQUEST_PREFIX } from '../wechat/request-ids.mjs'
import {
  chatbotPrompt,
  advisorPrompt,
  workerPrompt,
  ticketBrief,
  workOrderBrief,
  workerBrief,
  routerNotice,
  clip,
} from './prompts.mjs'
import { V2Store } from './store.mjs'

const ACTIVE = new Set(['intake', 'open', 'working', 'blocked', 'forked'])
const TERMINAL = new Set(['done', 'failed', 'cancelled'])
// Host approval outcomes that resume the Worker. Everything else (rejected,
// cancelled, unavailable) keeps the ticket parked with a durable reason.
const ALLOWED_APPROVAL_OUTCOMES = new Set(['allowed-once', 'allowed', 'approved'])

// Worker is the execution end of the responsibility chain and must not
// delegate. Deny the whole family (spawn/fork, list, message, interrupt), not
// only `subagent`; agent-team names are included for profiles that mount them
// and are intersected with the tools this agent actually exposes below.
const WORKER_DENIED_DELEGATION_TOOLS = [
  'subagent',
  'subagent_fork',
  'list_agents',
  'send_message',
  'interrupt_agent',
  'spawn_teammate',
  'wait_agent',
]

const text = value => typeof value === 'string' ? value.trim() : ''
const arrayOfText = value => Array.isArray(value)
  ? value.map(item => text(item)).filter(Boolean)
  : (text(value) ? [text(value)] : [])
const now = () => Date.now()
const newId = prefix => prefix + randomUUID()
// Human-readable approval time for blockedReason. Asia/Shanghai has no DST, so
// a fixed +08:00 shift is exact.
function clockText(ms) {
  const shifted = new Date((Number.isFinite(ms) ? ms : Date.now()) + 8 * 60 * 60 * 1000)
  const pad = value => String(value).padStart(2, '0')
  return pad(shifted.getUTCHours()) + ':' + pad(shifted.getUTCMinutes()) + ':' + pad(shifted.getUTCSeconds()) + ' +08:00'
}

const TOOL_OUTPUT = {
  schema: { type: 'object', additionalProperties: true },
  render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
}

function defineTool(name, description, parameters, execute) {
  return {
    name,
    description,
    parameters,
    output: TOOL_OUTPUT,
    execute: (args, exec) => execute(args && typeof args === 'object' ? args : {}, exec),
  }
}

// A message content block can be text, an attachment, or a tool call. Only text
// is useful to the Chatbot, which cannot open a file itself.
function contentText(content) {
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

// sessionController.events() returns { type: 'event', event } wire records;
// wait().output.records uses the same shape. Accept a bare event too.
function eventOf(record) {
  if (!record || typeof record !== 'object') return null
  return record.type === 'event' && record.event && typeof record.event === 'object' ? record.event : record
}

function messageOf(record) {
  const event = eventOf(record)
  if (!event) return null
  const data = event.data && typeof event.data === 'object' ? event.data : event
  let role
  let content
  if (event.type === 'user/message') {
    role = 'user'
    content = data.content
  } else if (event.type === 'assistant/message') {
    role = 'assistant'
    content = data.message && data.message.content ? data.message.content : data.content
  } else {
    return null
  }
  const body = contentText(content).trim()
  if (!body) return null
  return {
    role,
    text: body,
    seq: Number.isSafeInteger(event.seq) ? event.seq : undefined,
    at: Number.isSafeInteger(event.at) ? event.at : (Number.isSafeInteger(event.time) ? event.time : undefined),
  }
}

function assistantProse(record) {
  const event = eventOf(record)
  if (!event || event.type !== 'assistant/message') return ''
  const data = event.data && typeof event.data === 'object' ? event.data : event
  const content = data.message && data.message.content !== undefined ? data.message.content : data.content
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''
  if (content.some(part => part && part.type === 'tool-call')) return ''
  return content
    .filter(part => part && part.type === 'text' && typeof part.text === 'string')
    .map(part => part.text)
    .join('\n')
    .trim()
}

function assistantText(records) {
  const parts = []
  for (const record of Array.isArray(records) ? records : []) {
    const value = assistantProse(record)
    if (value) parts.push(value)
  }
  return parts.join('\n\n').trim()
}

// Review-critical event types for session_events. Any event whose type also
// contains "error" is treated as review-critical even when it is not listed
// here (external/plugin events are not part of the host vocabulary).
const REVIEW_EVENT_TYPES = [
  'turn/start',
  'turn/end',
  'approval/asked',
  'approval/decided',
  'tool/call',
  'tool/result',
  'command/run',
  'error',
]

// Title, cwd and event summaries can all carry credentials. Redact by shape
// first (token=..., apiKey: '...', Authorization: Bearer ...), then by object
// key when a summary is built from a whole object.
const SENSITIVE_KEY = /token|secret|password|passwd|api[-_]?key|authorization|cookie|credential/i
const AUTH_PAIR = /(authorization\s*[:=]\s*)(?:bearer\s+)?(?:"[^"]*"|'[^']*'|[^\s&;,]+)/gi
const SECRET_PAIR = /((?:access[_-]?token|refresh[_-]?token|token|api[_-]?key|apikey|secret|password|passwd|cookie|credential)\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s&;,]+)/gi

function redactSecrets(value) {
  return String(value == null ? '' : value)
    .replace(AUTH_PAIR, '$1[redacted]')
    .replace(SECRET_PAIR, '$1***')
}

/** Deep-scrub a value so an object summary cannot leak a credential by key. */
function scrubValue(value, depth = 0) {
  if (value === null || value === undefined) return value
  if (typeof value === 'string') return redactSecrets(value)
  if (typeof value !== 'object') return value
  if (depth >= 4) return '[truncated]'
  if (Array.isArray(value)) return value.slice(0, 20).map(item => scrubValue(item, depth + 1))
  const out = {}
  let count = 0
  for (const [key, item] of Object.entries(value)) {
    if (count >= 30) {
      out['…'] = '[truncated]'
      break
    }
    count += 1
    out[key] = SENSITIVE_KEY.test(key) ? '[redacted]' : scrubValue(item, depth + 1)
  }
  return out
}

/** Collapse to one line and clip hard; the ellipsis counts toward the limit. */
function clipText(value, limit) {
  const body = String(value == null ? '' : value).replace(/\s+/g, ' ').trim()
  if (body.length <= limit) return body
  return limit <= 1 ? '…' : body.slice(0, limit - 1) + '…'
}

/** Epoch milliseconds or an ISO 8601 string; undefined when absent, null when invalid. */
function parseTimeArg(value) {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value === 'number') return Number.isFinite(value) ? Math.trunc(value) : null
  const body = String(value).trim()
  if (!body) return undefined
  if (/^-?\d+$/.test(body)) return Number(body)
  const parsed = Date.parse(body)
  return Number.isFinite(parsed) ? parsed : null
}

function eventTimeOf(event) {
  if (Number.isSafeInteger(event && event.time)) return event.time
  if (Number.isSafeInteger(event && event.at)) return event.at
  return undefined
}

function eventDataOf(event) {
  return event && event.data && typeof event.data === 'object' ? event.data : {}
}

function eventReasonText(reason) {
  if (reason === undefined || reason === null || reason === '') return 'unknown'
  if (typeof reason === 'string') return reason
  if (typeof reason !== 'object') return String(reason)
  const kind = reason.kind !== undefined ? reason.kind : (reason.type !== undefined ? reason.type : reason.reason)
  if (kind === undefined || kind === null) return 'unknown'
  if (typeof kind === 'object') return eventReasonText(kind)
  const inner = reason.reason && typeof reason.reason === 'object' ? '(' + eventReasonText(reason.reason) + ')' : ''
  return String(kind) + inner
}

function eventOutcomeText(outcome) {
  if (typeof outcome === 'string') return outcome
  if (outcome && typeof outcome === 'object') {
    const kind = outcome.kind || outcome.outcome || outcome.decision
    if (typeof kind === 'string') {
      const detail = outcome.reason && typeof outcome.reason === 'string' ? '(' + outcome.reason + ')' : ''
      return kind + detail
    }
    return JSON.stringify(scrubValue(outcome))
  }
  return String(outcome === undefined || outcome === null ? 'unknown' : outcome)
}

function eventErrorCode(data) {
  const error = data && data.error && typeof data.error === 'object' ? data.error : null
  if (error) {
    if (error.code) return String(error.code)
    if (error.name) return String(error.name)
    if (error.message) return String(error.message).split(/\r?\n/)[0]
  }
  if (data && data.code) return String(data.code)
  if (data && typeof data.error === 'string') return data.error
  return ''
}

function eventTypeMatches(type, patterns) {
  for (const pattern of patterns) {
    if (pattern.endsWith('/*')) {
      const prefix = pattern.slice(0, -1)
      if (type === pattern.slice(0, -2) || type.startsWith(prefix)) return true
    } else if (type === pattern) {
      return true
    }
  }
  return false
}

/** One review line per event; never expands tool arguments or message bodies. */
function eventSummary(event, summaryChars) {
  const type = String(event && event.type ? event.type : '')
  const data = eventDataOf(event)
  let body
  if (type === 'turn/start') {
    body = 'turn ' + (data.turn === undefined ? '?' : String(data.turn))
  } else if (type === 'turn/end') {
    body = 'turn ' + (data.turn === undefined ? '?' : String(data.turn)) + ' end ' + eventReasonText(data.reason)
  } else if (type === 'approval/asked') {
    body = 'approval ' + (data.id === undefined ? '?' : String(data.id))
      + ' tool=' + (data.toolName === undefined ? '?' : String(data.toolName))
      + ' reason=' + (data.reason ? String(data.reason) : 'unspecified')
  } else if (type === 'approval/decided') {
    body = 'approval ' + (data.id === undefined ? '?' : String(data.id)) + ' outcome=' + eventOutcomeText(data.outcome)
  } else if (type === 'tool/call') {
    body = 'tool ' + (data.name === undefined ? '?' : String(data.name))
  } else if (type === 'tool/result') {
    const code = eventErrorCode(data)
    body = 'tool result ' + (code ? 'error:' + code : 'ok')
  } else if (type === 'command/run') {
    body = 'command ' + (data.name === undefined ? '?' : String(data.name))
    if (data.args !== undefined && data.args !== null && String(data.args)) body += ' ' + String(data.args)
  } else if (type === 'error' || /error/i.test(type)) {
    const firstLine = typeof data.message === 'string' ? data.message.split(/\r?\n/)[0] : ''
    body = 'error: ' + (eventErrorCode(data) || firstLine || type)
  } else {
    body = type
  }
  return clipText(redactSecrets(body), summaryChars)
}

function normalizeTitle(value) {
  return String(value == null ? '' : value)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\u3000]+/g, '')
    .replace(/[·•:：,，.。!！?？/\\_\-—–()（）\[\]【】{}<>《》"'“”‘’]+/g, '')
}

function titleBigrams(value) {
  const chars = Array.from(value)
  const grams = new Map()
  for (let index = 0; index < chars.length - 1; index += 1) {
    const gram = chars[index] + chars[index + 1]
    grams.set(gram, (grams.get(gram) || 0) + 1)
  }
  return grams
}

function titleDice(left, right) {
  if (!left || !right) return 0
  if (left === right) return 1
  const a = titleBigrams(left)
  const b = titleBigrams(right)
  if (a.size === 0 || b.size === 0) return 0
  let overlap = 0
  for (const [gram, count] of a) overlap += Math.min(count, b.get(gram) || 0)
  return (2 * overlap) / (left.length - 1 + right.length - 1)
}

function titleScore(query, title) {
  const wanted = normalizeTitle(query)
  const value = normalizeTitle(title)
  if (!wanted || !value) return 0
  if (wanted === value) return 1
  if (value.includes(wanted)) {
    const slack = (value.length - wanted.length) / Math.max(value.length, 1)
    return 0.94 - 0.12 * slack
  }
  if (wanted.includes(value)) {
    const slack = (wanted.length - value.length) / Math.max(wanted.length, 1)
    return 0.88 - 0.12 * slack
  }
  return titleDice(wanted, value) * 0.8
}

function containsPath(root, target) {
  if (!root || !target) return false
  const base = resolve(root)
  const value = resolve(target)
  return value === base || value.startsWith(base.endsWith(sep) ? base : base + sep)
}

// Deterministic commands are intercepted at the channel boundary, so they keep
// working even while the Chatbot itself is bypassed by direct mode.
function directCommand(body) {
  const value = String(body || '').trim()
  if (!value) return null
  if (/^(?:\/|！|!)?\s*(?:退出直通(?:模式)?|直通(?:模式)?\s*(?:关闭|退出)|direct\s+(?:off|exit|quit))\s*$/i.test(value)) {
    return { kind: 'off' }
  }
  if (/^(?:\/|！|!)?\s*(?:直通(?:模式)?\s*状态|direct\s+status)\s*$/i.test(value)) {
    return { kind: 'status' }
  }
  const on = value.match(/^(?:\/|！|!)\s*(?:直通|direct)\s+(.+)$/i)
  if (on) return { kind: 'on', target: on[1].trim() }
  return null
}

/**
 * v2 control plane. The controller owns the Chatbot, Advisors and managed
 * Workers; Router logic lives here as ordinary methods so it stays
 * deterministic and testable. It never talks to the model itself.
 */
export class V2Controller {
  constructor(service) {
    this.service = service
    this.ctx = service.ctx
    this.stateDir = service.stateDir
    this.v2 = new V2Store(service.stateDir)
    this.installed = new WeakSet()
    // The host can hand back a fresh agent facade for the same session (the
    // agent/created event and sessionController.resolveAgent are two separate
    // resolutions). Scoped tools belong to the session, so key installation by
    // session id as well; otherwise a second install re-registers the same
    // names and the host rejects them as duplicates.
    this.installedRoles = new Map()
    // A preset's tools may not be mounted when agent/created fires. A role that
    // needs a tool restriction is retried at the next pre-step, after the
    // preset has finished mounting, instead of failing session creation.
    this.pendingRestrictions = new Map()
    this.disposers = []
    this.ensuringChatbot = undefined
    this.ensuringAdvisor = new Map()
    // Direct mode is deliberately memory-only: a restart must return to the
    // normal Chatbot conversation instead of silently steering WeChat traffic
    // into a session the user no longer remembers choosing.
    this.direct = undefined
    // Read-only blocked notices. Nothing here answers an approval or a
    // question: every result still comes from the downstream next(). Keyed by
    // sessionId|kind so one session cannot flood the Chatbot with every request
    // it hits.
    this.blockedNotices = new Map()
    this.lastBlockedNoticeAt = new Map()
    this.turnStartedAt = new Map()
    const noticeOptions = service.options && typeof service.options === 'object' ? service.options : {}
    this.blockedNoticeWindowMs = Number.isFinite(noticeOptions.v2BlockedNoticeWindowMs)
      ? Math.max(0, noticeOptions.v2BlockedNoticeWindowMs)
      : 10 * 60_000
    this.blockedNoticeMinIntervalMs = Number.isFinite(noticeOptions.v2BlockedNoticeMinIntervalMs)
      ? Math.max(0, noticeOptions.v2BlockedNoticeMinIntervalMs)
      : 60_000
    // Worker approvals currently holding a ticket. Entries arrive with
    // approval/asked and leave with approval/decided or the turn ending; no
    // timer ever scans this map.
    this.pendingApprovals = new Map()
    // Requests this plugin approved itself through settings.approvalAutoAllow,
    // keyed by call id (or session+tool when the host supplied none), so the
    // matching approval/asked does not park the ticket it just let through.
    this.autoAllowed = new Map()
  }

  log(level, message) {
    if (typeof this.service.log === 'function') this.service.log(level, 'v2: ' + message)
  }

  roleFor(sessionId) {
    const id = String(sessionId || '')
    if (!id) return null
    if (String(this.v2.chatbotSessionId || '') === id) return 'chatbot'
    for (const advisor of Object.values(this.v2.data.advisors || {})) {
      if (advisor && String(advisor.sessionId) === id) return 'advisor'
    }
    if (this.v2.worker(id)) return 'worker'
    return null
  }

  onAgentCreated(agent) {
    const role = this.roleFor(agent && agent.id)
    if (!role) return false
    try {
      this.install(agent, role)
    } catch (error) {
      this.log('error', 'could not install ' + role + ' tools on ' + String(agent && agent.id) + ': ' + String(error && error.message ? error.message : error))
    }
    return true
  }

  onSessionEvent(session, event) {
    if (!session || !event) return false
    const header = session.header
    const id = String(header && header.id !== undefined ? header.id : (session.id !== undefined ? session.id : ''))
    if (!id) return false
    // Runs for every session, including ordinary ones that never return true
    // below: the notice bookkeeping needs their turn boundaries and settlements.
    this.trackBlockedNotice(id, event)
    // Approval audit events are what move a Worker's ticket into and out of
    // blocked(waitingOn=approval); see trackApprovalTicket.
    this.trackApprovalTicket(id, event)
    if (String(this.v2.chatbotSessionId || '') === id) {
      if (event.type === 'turn/start') {
        const turn = event.data && event.data.turn
        if (Number.isSafeInteger(turn)) this.service.currentRiaTurn = turn
      } else if (event.type === 'turn/end') {
        const turn = event.data && event.data.turn
        if (!Number.isSafeInteger(turn) || this.service.currentRiaTurn === turn) this.service.currentRiaTurn = undefined
      }
      return true
    }
    if (this.direct && String(this.direct.sessionId) === id) {
      if (event.type === 'assistant/message' && !(event.data && event.data.interrupted)) {
        const prose = assistantProse(event)
        if (prose) this.forwardDirectReply(prose, event)
      }
      return true
    }
    const worker = this.v2.worker(id)
    if (!worker) return false
    if (event.type === 'turn/start') {
      // Returning true below stops RiaService.onSessionEvent() before its
      // legacy worker turn/start confirmation, so v2 must confirm here: this
      // is the real signal that the dispatch actually started. Without it the
      // 60s reconcile sweep parks a perfectly healthy ticket.
      this.service.confirmWorkerTurnStart(id)
      this.v2.addWorker(id, { status: 'working', lastTurnAt: now() })
    } else if (event.type === 'turn/end') {
      this.v2.addWorker(id, { status: 'idle', lastTurnAt: now() })
    }
    return true
  }

  /**
   * Notice bookkeeping for every session: remember when a turn started (so a
   * notice can say how long the session has been waiting) and drop a session's
   * key once the blocking request settles, so the next one can notify again.
   * Event timestamps only; nothing here schedules work.
   */
  trackBlockedNotice(sessionId, event) {
    if (event.type === 'turn/start') {
      this.rememberTurnStart(sessionId)
      return
    }
    if (event.type === 'turn/end') {
      this.turnStartedAt.delete(sessionId)
      return
    }
    if (event.type === 'approval/decided') {
      // The waterfall request carries no approval id (only the audit event
      // does), so settlement is tracked per session rather than per request.
      this.clearBlockedNotice(sessionId, 'approval')
      return
    }
    // A late reply to ask_user_question lands as a normal user message.
    if (event.type === 'user/message') {
      const data = event.data || {}
      const source = data.source || (data.message && data.message.source)
      if (source && source.kind === 'user-question-reply') this.clearBlockedNotice(sessionId, 'question')
    }
  }

  rememberTurnStart(sessionId) {
    this.turnStartedAt.set(sessionId, now())
    if (this.turnStartedAt.size <= 1000) return
    // A session can be abandoned mid-turn; keep the map bounded by dropping the
    // oldest entries rather than running a timer.
    const oldest = [...this.turnStartedAt.entries()].sort((left, right) => left[1] - right[1])
    for (const [key] of oldest.slice(0, oldest.length - 800)) this.turnStartedAt.delete(key)
  }

  /**
   * Approval audit events drive ticket state, so a Worker parked on a human
   * decision is visible as blocked(waitingOn=approval) instead of silently
   * "working". Both events are session events; nothing here schedules work.
   */
  trackApprovalTicket(sessionId, event) {
    if (event.type === 'approval/asked') {
      this.onApprovalAsked(sessionId, event)
      return
    }
    if (event.type === 'approval/decided') {
      this.onApprovalDecided(sessionId, event)
      return
    }
    if (event.type === 'turn/end') this.clearApprovalsForSession(sessionId)
  }

  onApprovalAsked(sessionId, event) {
    const data = event.data || {}
    const approvalId = text(data.id)
    if (!approvalId) return
    const toolName = text(data.toolName) || 'unknown'
    const reason = text(data.reason) || '未说明'
    // An approval this plugin let through itself must not park the ticket.
    if (this.consumeAutoAllowed(sessionId, toolName, text(data.callId))) return
    const ticket = this.workingTicketFor(sessionId)
    if (!ticket) return
    const askedAt = Number.isFinite(event.time) ? event.time : now()
    const blockedReason = '等待审批：工具 ' + toolName + '（' + reason + '），请求于 ' + clockText(askedAt)
    const moved = this.service.store.transitionTicket(ticket.ticketId, 'blocked', {
      actor: 'router',
      executor: sessionId,
      waitingOn: 'approval',
      blockedReason,
      attention: { kind: 'approval', question: blockedReason, ref: approvalId },
      reason: 'worker approval wait',
    })
    if (!moved.ok) {
      this.log('warn', 'could not block ' + ticket.ticketId + ' on approval ' + approvalId + ': ' + moved.code + ' ' + moved.message)
      return
    }
    this.rememberPendingApproval(approvalId, { ticketId: ticket.ticketId, sessionId, toolName, reason, askedAt })
    this.v2.setTicketMeta(ticket.ticketId, { phase: 'blocked' })
    // The Worker keeps running (it is only waiting), so currentTicketId stays.
    this.queueChatbotNotice('ticket ' + ticket.ticketId + ' 的 Worker 在等审批：工具 ' + toolName + '（' + reason + '），请求于 ' + clockText(askedAt) + '，已转 blocked(waitingOn=approval)。批准后自动回到 working；拒绝/超时会停在这里，需要 chatbot_resume。')
  }

  onApprovalDecided(sessionId, event) {
    const data = event.data || {}
    const approvalId = text(data.id)
    const outcome = text(data.outcome)
    const record = approvalId ? this.pendingApprovals.get(approvalId) : null
    if (approvalId) this.pendingApprovals.delete(approvalId)
    const ticketId = record ? record.ticketId : this.approvalBlockedTicketFor(sessionId)
    if (!ticketId) return
    const ticket = this.service.store.ticket(ticketId)
    if (!ticket || ticket.status !== 'blocked' || ticket.waitingOn !== 'approval') return
    if (ALLOWED_APPROVAL_OUTCOMES.has(outcome)) {
      const executor = String(ticket.executor || sessionId)
      // The state machine has no blocked -> working edge; reopen first.
      const reopened = this.service.store.transitionTicket(ticketId, 'open', {
        actor: 'router',
        executor,
        waitingOn: 'ria',
        // A grant resets the parked state, including an earlier denial record.
        failure: null,
        reason: 'approval granted',
      })
      if (!reopened.ok) {
        this.log('warn', 'could not reopen ' + ticketId + ' after approval: ' + reopened.code + ' ' + reopened.message)
        return
      }
      const working = this.service.store.transitionTicket(ticketId, 'working', {
        actor: 'router',
        executor,
        waitingOn: 'worker',
        reason: 'approval granted, resume execution',
      })
      if (!working.ok) {
        this.log('warn', 'could not resume ' + ticketId + ' after approval: ' + working.code + ' ' + working.message)
        this.queueChatbotNotice('ticket ' + ticketId + ' 审批通过，但恢复到 working 失败（' + working.code + '）；请用 chatbot_resume 处理。')
        return
      }
      this.v2.setTicketMeta(ticketId, { phase: 'working', workerId: executor })
      this.v2.addWorker(executor, { status: 'working', currentTicketId: ticketId, lastUsedAt: now() })
      this.queueChatbotNotice('ticket ' + ticketId + ' 审批通过，已回到 working，Worker 继续执行。')
      return
    }
    const denied = outcome === 'rejected'
    const label = denied ? '拒绝' : (outcome === 'unavailable' ? '无审批人' : '取消')
    const code = denied ? 'approval_denied' : 'approval_cancelled'
    const detail = record ? record.toolName + '：' + record.reason : (outcome || 'unknown')
    const message = '审批被' + label + '（' + detail + '）'
    const attention = ticket.attention && ticket.attention.kind === 'approval'
      ? { ...ticket.attention, question: ticket.attention.question || ticket.blockedReason || message }
      : { kind: 'approval', question: message }
    try {
      this.service.store.updateTicket(ticketId, {
        // The ticket stays blocked; only the reason for stopping changes.
        blockedReason: message,
        attention,
        failure: { code, message, at: now() },
      })
    } catch (error) {
      this.log('warn', 'could not record the approval outcome on ' + ticketId + ': ' + String(error && error.message ? error.message : error))
    }
    this.queueChatbotNotice('ticket ' + ticketId + ' 审批被' + label + '：' + message + '，工单停在 blocked(waitingOn=approval)，可用 chatbot_resume 重试。')
  }

  /** The ticket this Worker is currently executing, if any. */
  workingTicketFor(sessionId) {
    return this.service.store.tickets().find(item =>
      item.status === 'working' && String(item.executor) === String(sessionId)) || null
  }

  /** The ticket this Worker left parked on an approval, if any. */
  approvalBlockedTicketFor(sessionId) {
    const ticket = this.service.store.tickets().find(item =>
      item.status === 'blocked' && item.waitingOn === 'approval' && String(item.executor) === String(sessionId))
    return ticket ? ticket.ticketId : ''
  }

  rememberPendingApproval(approvalId, record) {
    // Bounded without a timer: drop the oldest entries when the map is full.
    if (this.pendingApprovals.size >= 200) {
      const oldest = [...this.pendingApprovals.entries()].sort((left, right) => left[1].askedAt - right[1].askedAt)
      for (const [key] of oldest.slice(0, oldest.length - 150)) this.pendingApprovals.delete(key)
    }
    this.pendingApprovals.set(approvalId, record)
  }

  clearApprovalsForSession(sessionId) {
    for (const [id, record] of [...this.pendingApprovals]) {
      if (String(record.sessionId) === String(sessionId)) this.pendingApprovals.delete(id)
    }
  }

  clearApprovalsForTicket(ticketId) {
    for (const [id, record] of [...this.pendingApprovals]) {
      if (String(record.ticketId) === String(ticketId)) this.pendingApprovals.delete(id)
    }
  }

  /** Fire-and-forget notice: an event callback must never await a prompt. */
  queueChatbotNotice(message) {
    void this.notifyChatbot(message).catch(error => {
      this.log('warn', 'could not notify Chatbot: ' + String(error && error.message ? error.message : error))
    })
  }

  /** Tool names this deployment allows without asking, or [] when disabled. */
  approvalAutoAllow() {
    let settings
    try { settings = this.service.store.settings() } catch { settings = null }
    const raw = settings && settings.approvalAutoAllow
    return raw && raw.enabled === true && Array.isArray(raw.tools) ? raw.tools : []
  }

  markAutoAllowed(sessionId, toolName, callId) {
    const key = text(callId) ? 'call:' + text(callId) : 'tool:' + sessionId + '|' + toolName
    this.autoAllowed.set(key, now())
    if (this.autoAllowed.size <= 200) return
    const oldest = [...this.autoAllowed.entries()].sort((left, right) => left[1] - right[1])
    for (const [entry] of oldest.slice(0, oldest.length - 150)) this.autoAllowed.delete(entry)
  }

  consumeAutoAllowed(sessionId, toolName, callId) {
    const keys = [text(callId) ? 'call:' + text(callId) : '', 'tool:' + sessionId + '|' + toolName]
    for (const key of keys) {
      if (!key) continue
      const at = this.autoAllowed.get(key)
      if (at === undefined) continue
      this.autoAllowed.delete(key)
      // Only a decision this plugin made moments ago counts.
      if (now() - at < 30_000) return true
    }
    return false
  }

  /**
   * Read-only retrospective tools for reflection Workers. They live here (not
   * in the Advisor branch) because reviewing past sessions is execution work:
   * it reads logs, not repository code, and never prompts, appends to, updates
   * or renames a session.
   */
  registerSessionTools(register) {
    register('session_list', 'Read-only retrospective tool: list sessions (never prompts, appends to, renames or otherwise modifies a session). Filter by id prefix, title/cwd substring, updatedAt range, running or agentAvailable. Subagent rows are excluded unless includeSubagents is true; archived rows are marked and kept unless includeArchived is false. Titles and cwd are redacted for tokens and credentials.', {
      type: 'object',
      properties: {
        idPrefix: { type: 'string', description: 'Case-insensitive session id prefix.' },
        titleContains: { type: 'string', description: 'Case-insensitive title substring.' },
        cwdContains: { type: 'string', description: 'Case-insensitive cwd substring.' },
        updatedAfter: { anyOf: [{ type: 'number' }, { type: 'string' }], description: 'Inclusive lower bound on updatedAt: epoch milliseconds or an ISO 8601 string.' },
        updatedBefore: { anyOf: [{ type: 'number' }, { type: 'string' }], description: 'Inclusive upper bound on updatedAt: epoch milliseconds or an ISO 8601 string.' },
        running: { type: 'boolean', description: 'Only sessions whose list row has this running value.' },
        agentAvailable: { type: 'boolean', description: 'Only sessions whose list row has this agent-availability value.' },
        includeSubagents: { type: 'boolean', description: 'Include subagent rows (origin=subagent or with a parentSessionId). Defaults to false.' },
        includeArchived: { type: 'boolean', description: 'Keep archived sessions and mark them archived. Defaults to true.' },
        limit: { type: 'number', minimum: 1, maximum: 50, description: 'Maximum sessions to return, 1-50. Defaults to 20.' },
      },
      additionalProperties: false,
    }, (args, exec) => this.sessionList(args, exec))
    register('session_events', 'Read-only retrospective tool: read a bounded, redacted summary of one session\'s event log (never prompts, appends to, updates, renames or otherwise modifies the session). sessionId accepts a unique prefix. Defaults to review-critical events: ' + REVIEW_EVENT_TYPES.join(', ') + ', plus any event type containing "error". Use types for exact names or prefix globs such as approval/* and turn/*. Reads backwards in bounded pages; limit caps the returned events, summaryChars caps each one-line summary, and truncated/more/nextThroughSeq continue with older events.', {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'Exact session id or a unique id prefix.' },
        types: { type: 'array', items: { type: 'string' }, description: 'Event types to keep: exact names and prefix globs like approval/*. Omit for the review-critical default set.' },
        fromSeq: { type: 'number', description: 'Inclusive lower seq bound.' },
        toSeq: { type: 'number', description: 'Inclusive upper seq bound; defaults to the current log cursor.' },
        fromTime: { anyOf: [{ type: 'number' }, { type: 'string' }], description: 'Inclusive lower event time: epoch milliseconds or an ISO 8601 string.' },
        toTime: { anyOf: [{ type: 'number' }, { type: 'string' }], description: 'Inclusive upper event time: epoch milliseconds or an ISO 8601 string.' },
        limit: { type: 'number', minimum: 1, maximum: 200, description: 'Maximum events to return, 1-200. Defaults to 50.' },
        summaryChars: { type: 'number', minimum: 1, maximum: 300, description: 'Maximum characters per one-line summary, 1-300. Defaults to 160.' },
      },
      required: ['sessionId'],
      additionalProperties: false,
    }, (args, exec) => this.sessionEvents(args, exec))
  }

  install(agent, role) {
    if (!agent || this.installed.has(agent)) return
    const sessionId = String(agent.id)
    const installedRole = this.installedRoles.get(sessionId)
    if (installedRole) {
      if (installedRole === role) {
        this.retryRestriction(agent, role)
        return
      }
      throw new Error('session ' + sessionId + ' is already installed as ' + installedRole + ', not ' + role)
    }
    const pendingDisposers = []
    const visibleTools = () => {
      try {
        // Without the agent argument this is the deployment-global view, which
        // omits preset-scope tools entirely. Ask for this agent's view so an
        // earlier install attempt's scoped registrations are detected.
        const view = agent.ctx.tools.view(agent)
        return view && view.visible instanceof Map ? view.visible : null
      } catch { return null }
    }
    const register = (name, description, parameters, execute) => {
      // A previous install attempt may have registered this role's tools and
      // failed before it could mark the session installed. Reuse the visible
      // registration instead of throwing duplicate-tool on the retry.
      const visible = visibleTools()
      if (visible && visible.has(name)) return
      const definition = defineTool(name, description, parameters, execute)
      try {
        const dispose = agent.ctx.tools.register(definition)
        if (typeof dispose === 'function') pendingDisposers.push(dispose)
      } catch (error) {
        // The visible-tools probe can fail transiently while a preset is still
        // mounting. If the registration is in fact already there, reuse it
        // instead of failing the whole session on a duplicate-name error.
        const message = String(error && error.message ? error.message : error)
        if (!/already registered/i.test(message)) throw error
        const current = visibleTools()
        if (!current || !current.has(name)) throw error
        this.log('warn', 'reusing existing tool ' + name + ' on ' + sessionId)
      }
    }
    const worker = role === 'worker' ? this.v2.worker(sessionId) : null
    if (role === 'chatbot') {
      register('chatbot_request', 'Create a tracked ticket for a user request and hand it to the Advisor. Use this for work that needs follow-up, files, code, or a durable outcome. For a knowledge/investigation question that needs checking (code, docs, current state), ack the user first, then create the ticket with mode=answer so the Advisor can investigate read-only and answer directly without a Worker. Do not use for simple conversation.', {
        type: 'object',
        properties: {
          goal: { type: 'string', description: 'What the user wants, in their own words.' },
          acceptance: { type: 'string', description: 'How completion should be judged.' },
          workspace: { type: 'string', description: 'Optional absolute path of the project directory the work targets. Only set this when the user named an existing directory.' },
          mode: { type: 'string', enum: ['answer', 'work'], description: 'answer: the Advisor investigates read-only and answers directly without a Worker. work (default): plan + dispatch to a Worker.' },
        },
        required: ['goal'],
        additionalProperties: false,
      }, (args, exec) => this.chatbotRequest(args, exec))
      register('chatbot_status', 'Read active tickets and their latest progress. Pass ticketId for one ticket.', {
        type: 'object',
        properties: { ticketId: { type: 'string' } },
        additionalProperties: false,
      }, (args) => this.chatbotStatus(args))
      register('chatbot_steer', 'Send a direction change to the Worker of a ticket. It is delivered at the next checkpoint; a running Worker is not interrupted mid-call.', {
        type: 'object',
        properties: {
          ticketId: { type: 'string' },
          message: { type: 'string' },
        },
        required: ['ticketId', 'message'],
        additionalProperties: false,
      }, (args, exec) => this.chatbotSteer(args, exec))
      register('chatbot_resume', 'Resume a ticket that is blocked on the user or on the environment. Pass the user answer or direction when there is one.', {
        type: 'object',
        properties: {
          ticketId: { type: 'string' },
          message: { type: 'string' },
        },
        required: ['ticketId'],
        additionalProperties: false,
      }, (args, exec) => this.chatbotResume(args, exec))
      register('chatbot_sessions', 'List the ordinary top-level DSH sessions the user can also open directly. Use this when the user asks to talk to, check on, or hand a message to another session. Managed Workers and Advisors are not listed; they are reached through tickets.', {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Optional title substring.' },
          limit: { type: 'number', description: 'Maximum sessions to return, 1-20. Defaults to 10.' },
        },
        additionalProperties: false,
      }, (args, exec) => this.chatbotSessions(args, exec))
      register('chatbot_talk', 'Send a message to an ordinary independent session and wait briefly for its reply. The message is added as a normal user turn; the target session keeps its own context, model and tools. Do not use this for tracked tickets, managed Workers, or Advisors.', {
        type: 'object',
        properties: {
          sessionId: { type: 'string', description: 'Exact session id from chatbot_sessions.' },
          title: { type: 'string', description: 'Title text when the id is unknown; spacing and close spelling are tolerated, but ambiguity is rejected.' },
          message: { type: 'string', description: 'What to say to that session.' },
          waitSeconds: { type: 'number', description: 'How long to wait for a reply, 5-120. Defaults to 60.' },
        },
        required: ['message'],
        additionalProperties: false,
      }, (args, exec) => this.chatbotTalk(args, exec))
      register('chatbot_read', 'Read recent messages from an ordinary independent session, optionally only those after a cursor returned by chatbot_talk or a previous chatbot_read. Use this to check a long-running session later.', {
        type: 'object',
        properties: {
          sessionId: { type: 'string' },
          title: { type: 'string', description: 'Title text when the id is unknown; spacing and close spelling are tolerated, but ambiguity is rejected.' },
          afterSeq: { type: 'number', description: 'Only return messages with a sequence number greater than this.' },
          limit: { type: 'number', description: 'Maximum messages to read, 1-30. Defaults to 20.' },
        },
        additionalProperties: false,
      }, (args, exec) => this.chatbotRead(args, exec))
      register('chatbot_direct', 'Turn on WeChat Claw direct mode for one ordinary independent session. While it is on, the user\'s WeChat messages go straight to that session, and its replies are forwarded to WeChat with a prefix. Use action=off to leave; direct mode is never persisted across a restart. Managed Workers and Advisors are not eligible.', {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['on', 'off', 'status'] },
          sessionId: { type: 'string', description: 'Exact session id from chatbot_sessions. Required for action=on unless title is given.' },
          title: { type: 'string', description: 'Title text when the id is unknown; spacing and close spelling are tolerated, but ambiguity is rejected.' },
        },
        required: ['action'],
        additionalProperties: false,
      }, (args, exec) => this.chatbotDirect(args, exec))
      register('chatbot_grant', 'Change one top-level session\'s sandbox mode or approval policy. Call only when the user explicitly asks for it; never widen permissions on your own, and never treat a blocked ticket or approval as permission. A pure downgrade is permanent and can be reset explicitly. Any escalation is temporary and requires a TTL. Automatic restore on expiry, bound-ticket close, or startup undoes only the escalated fields, so a downgrade bundled into the same grant stays in effect; an explicit reset undoes every requested field. The host records the original values and writes audit.jsonl. This changes session permissions only, not tools or model.', {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['set', 'list', 'reset'] },
          sessionId: { type: 'string', description: 'Top-level session id from chatbot_status or chatbot_sessions. Required for set. The Chatbot itself is not eligible.' },
          ticketId: { type: 'string', description: 'Optional ticket to bind a temporary escalation to; defaults to the managed Worker\'s current ticket. Ignored for lifetime by a permanent downgrade.' },
          sandboxMode: { type: 'string', enum: ['read-only', 'workspace-write', 'danger-full-access'] },
          approvalPolicy: { type: 'string', enum: ['ask', 'never'] },
          ttlSeconds: { type: 'number', minimum: 60, maximum: 86400, description: 'Required in practice for an escalation; ignored for a pure downgrade.' },
          reason: { type: 'string', description: 'Why the user asked for this; required for set.' },
          grantId: { type: 'string', description: 'Required for reset.' },
        },
        required: ['action'],
        additionalProperties: false,
      }, (args, exec) => this.chatbotGrant(args, exec))
    } else if (role === 'advisor') {
      register('ticket_read', 'Read one ticket, its WorkOrder, recent Worker reports and manager inbox.', {
        type: 'object',
        properties: { ticketId: { type: 'string' } },
        required: ['ticketId'],
        additionalProperties: false,
      }, (args, exec) => this.ticketRead(args, exec))
      register('ticket_plan', 'Write the WorkOrder for a ticket. Steps must be directly executable by a Worker.', {
        type: 'object',
        properties: {
          ticketId: { type: 'string' },
          summary: { type: 'string' },
          steps: { type: 'array', items: { type: 'string' } },
          acceptance: { type: 'string' },
          artifacts: { type: 'array', items: { type: 'string' } },
          notes: { type: 'string' },
        },
        required: ['ticketId', 'summary'],
        additionalProperties: false,
      }, (args, exec) => this.ticketPlan(args, exec))
      register('ticket_dispatch', 'Dispatch a planned ticket to a managed Worker. Reuses an idle Worker by default; a Worker can run one ticket at a time.', {
        type: 'object',
        properties: {
          ticketId: { type: 'string' },
          workerSessionId: { type: 'string' },
        },
        required: ['ticketId'],
        additionalProperties: false,
      }, (args, exec) => this.ticketDispatch(args, exec))
      register('ticket_block', 'Park a ticket on the user because information or a decision is missing.', {
        type: 'object',
        properties: {
          ticketId: { type: 'string' },
          reason: { type: 'string' },
          question: { type: 'string' },
        },
        required: ['ticketId', 'reason'],
        additionalProperties: false,
      }, (args, exec) => this.ticketBlock(args, exec))
      register('ticket_answer', 'Answer a research/knowledge ticket directly after read-only investigation. Closes the ticket without a WorkOrder or Worker. Only for questions that need no file changes and no command execution; never modifies sessions or files.', {
        type: 'object',
        properties: {
          ticketId: { type: 'string' },
          answer: { type: 'string', description: 'The answer to relay to the user.' },
          summary: { type: 'string', description: 'One-line summary; defaults to the first part of answer.' },
          evidence: { type: 'array', items: { type: 'string' }, description: 'Optional read-only evidence: files, commands or references.' },
        },
        required: ['ticketId', 'answer'],
        additionalProperties: false,
      }, (args, exec) => this.ticketAnswer(args, exec))
    } else if (role === 'worker') {
      register('worker_report', 'Report a milestone, blocked question, completion, or failure for the current ticket. Progress does not close the ticket; done and failed do.', {
        type: 'object',
        properties: {
          ticketId: { type: 'string' },
          status: { type: 'string', enum: ['progress', 'blocked', 'done', 'failed'] },
          summary: { type: 'string', description: 'What was done, or why it is blocked/failed.' },
          evidence: { type: 'array', items: { type: 'string' }, description: 'Commands run, files changed, test results, links.' },
          question: { type: 'string', description: 'For blocked: the exact question for the user.' },
          next: { type: 'string', description: 'For progress: the next milestone.' },
        },
        required: ['ticketId', 'status'],
        additionalProperties: false,
      }, (args, exec) => this.workerReport(args, exec))
      register('worker_checkpoint', 'Read the ticket, WorkOrder, recent reports and unread manager messages. Marks those messages as delivered.', {
        type: 'object',
        properties: { ticketId: { type: 'string' } },
        required: ['ticketId'],
        additionalProperties: false,
      }, (args, exec) => this.workerCheckpoint(args, exec))
      // Retrospective tools belong to reflection Workers only. Ordinary work
      // Workers and the Advisor never see them.
      if (worker && worker.workerType === 'reflection') this.registerSessionTools(register)
    }
    const prompt = role === 'chatbot'
      ? chatbotPrompt()
      : role === 'advisor'
        ? advisorPrompt()
        : workerPrompt(worker || {})
    try {
      // systemPrompt.section() requires a finite order; omitting it throws after
      // the scoped tools are registered and leaves them behind on retry.
      if (agent.ctx && agent.ctx.systemPrompt && typeof agent.ctx.systemPrompt.section === 'function') {
        try {
          const dispose = agent.ctx.systemPrompt.section({
            name: 'ria-v2-' + role,
            order: 60,
            interpolate: false,
            text() { return prompt },
          })
          if (typeof dispose === 'function') pendingDisposers.push(dispose)
        } catch (error) {
          // Same retry case for the prompt section; any other failure is real.
          if (!/already registered/i.test(String(error && error.message ? error.message : error))) throw error
        }
      }
      if (role === 'chatbot') {
        if (!agent.ctx.tools || typeof agent.ctx.tools.restrict !== 'function') {
          throw new Error('Chatbot cannot be restricted to its own tools')
        }
        agent.ctx.tools.restrict({ allow: [] })
      } else if (role === 'advisor') {
        if (!this.restrictToReadOnly(agent)) this.pendingRestrictions.set(sessionId, role)
      } else if (role === 'worker') {
        const kind = worker && worker.workerType === 'reflection' ? 'reflection' : 'work'
        // A reflection Worker must never hold write tools, even if its preset
        // mounts them: keep only read/grep/glob.
        const applied = kind === 'reflection'
          ? this.restrictToReadOnly(agent, 'Reflection Worker')
          : this.restrictWorker(agent)
        if (!applied) this.pendingRestrictions.set(sessionId, role)
      }
    } catch (error) {
      // Do not leave a half-installed role unstricted. Roll back the scoped
      // tools/prompt and let the caller retry or fail the session creation.
      for (const dispose of pendingDisposers.reverse()) {
        try { dispose() } catch { /* already disposed */ }
      }
      throw error
    }
    this.installed.add(agent)
    this.installedRoles.set(sessionId, role)
    for (const dispose of pendingDisposers) {
      this.disposers.push(dispose)
      this.service.disposers.push(dispose)
    }
  }

  /**
   * Apply a restriction that was queued because the preset's tools were not
   * mounted yet. Called when a session is resolved again and before its next
   * step, when the tool registry is complete.
   */
  retryRestriction(agent, role) {
    const sessionId = String(agent && agent.id)
    if (!sessionId || !this.pendingRestrictions.has(sessionId)) return
    let applied = false
    try {
      if (role === 'advisor') applied = this.restrictToReadOnly(agent)
      else if (role === 'worker') {
        const worker = this.v2.worker(sessionId)
        applied = worker && worker.workerType === 'reflection'
          ? this.restrictToReadOnly(agent, 'Reflection Worker')
          : this.restrictWorker(agent)
      }
    } catch (error) {
      this.log('warn', 'could not apply ' + role + ' restriction to ' + sessionId + ': ' + String(error && error.message ? error.message : error))
      return
    }
    if (applied) this.pendingRestrictions.delete(sessionId)
  }

  /**
   * Host bridge for agent/pre-step. Restrictions queued at install time are
   * applied here, before the model sees the step's tool list.
   */
  async onPreStep(payload, next) {
    const agent = payload && payload.agent
    if (agent && this.pendingRestrictions.size > 0) {
      const role = this.pendingRestrictions.get(String(agent.id))
      this.retryRestriction(agent, role)
      // A Advisor without its read-only mask can run arbitrary shell commands
      // through the PTC SDK. Never let that step start; a failed turn is safer
      // than an unrestricted manager.
      if (role === 'advisor' && this.pendingRestrictions.has(String(agent.id))) {
        throw new Error('Advisor read-only restriction is not active; refusing an unrestricted step')
      }
      if (role === 'worker' && this.pendingRestrictions.has(String(agent.id))) {
        const worker = this.v2.worker(String(agent.id))
        if (worker && worker.workerType === 'reflection') {
          throw new Error('Reflection Worker read-only restriction is not active; refusing an unrestricted step')
        }
      }
    }
    return await next()
  }

  /**
   * A Worker must execute the ticket itself, not delegate it. Deny the whole
   * delegation family (spawn/fork plus list/send/interrupt), not just
   * `subagent`: a profile that mounts only some of them must still lose every
   * one it does mount. This is deliberately a deny-list, not an allow-list:
   * the PTC transport run_code cannot be named in restrict(), and the Worker
   * needs the rest of the execution tools. The mask is intersected with the
   * tools this agent actually exposes because dsh-tools rejects unknown global
   * tool names.
   */
  restrictWorker(agent) {
    const tools = agent.ctx && agent.ctx.tools
    if (!tools || typeof tools.restrict !== 'function' || typeof tools.view !== 'function') return
    let known
    try {
      const view = tools.view(agent)
      known = view && view.restrictableNames
    } catch {
      return
    }
    if (!known || typeof known.has !== 'function') return false
    const deny = WORKER_DENIED_DELEGATION_TOOLS.filter(name => known.has(name))
    // A profile with no delegation tools needs no restriction at all.
    if (!deny.length) return true
    try {
      tools.restrict({ deny })
      return true
    } catch {
      // A profile that cannot apply this restriction still has the prompt
      // contract; do not fail Worker creation over it.
      return false
    }
  }

  /**
   * Keep only the read-only investigation tools. A profile may not mount every
   * search tool, and dsh-tools rejects a restriction that names an unknown
   * global tool, so intersect the mask with the tools this agent can see.
   */
  restrictToReadOnly(agent, label = 'Advisor') {
    const tools = agent.ctx && agent.ctx.tools
    if (!tools || typeof tools.restrict !== 'function') {
      throw new Error(label + ' cannot be restricted to read-only tools')
    }
    let allow = ['read', 'grep', 'glob']
    try {
      // tools.view() without a scope is the deployment-global view; the PTC
      // preset mounts its tools on the preset scope, so that view looks empty.
      // Pass the agent to see exactly the set restrict() will validate against.
      const view = typeof tools.view === 'function' ? tools.view(agent) : null
      const known = view && view.restrictableNames
      if (known && typeof known.has === 'function') {
        // An empty set means the preset has not mounted its tools yet, not that
        // the profile is missing them. Defer instead of failing the Advisor.
        if (known.size === 0) return false
        allow = allow.filter(name => known.has(name))
        if (allow.length === 0) {
          this.log('warn', 'profile exposes none of read/grep/glob; Advisor stays unrestricted')
          return false
        }
      }
    } catch (error) {
      // A view() without the restrictable set is not fatal; try the full mask.
      this.log('warn', 'could not inspect Advisor tools: ' + String(error && error.message ? error.message : error))
    }
    try {
      tools.restrict({ allow })
      return true
    } catch (error) {
      this.log('warn', 'could not restrict Advisor tools: ' + String(error && error.message ? error.message : error))
      return false
    }
  }

  async promptSession(sessionId, message, mode = 'queue', requestId) {
    const signal = new AbortController().signal
    return await this.ctx.sessionController.prompt({
      requestId: requestId || (HOST_REQUEST_PREFIX + randomUUID()),
      sessionId: String(sessionId),
      mode,
      content: [{ type: 'text', text: String(message) }],
    }, signal)
  }

  async attachWorkspace(sessionId, cwd) {
    try {
      return await this.service.attachWorkspaceSession(sessionId, cwd)
    } catch (error) {
      this.log('warn', 'could not attach ' + sessionId + ' to ' + cwd + ': ' + String(error && error.message ? error.message : error))
      return undefined
    }
  }

  async createSession({ sessionId, cwd, agentPreset, title }) {
    mkdirSync(cwd, { recursive: true })
    const created = await this.ctx.sessionController.create({ sessionId, cwd, agentPreset })
    if (created && created.agentPreset && String(created.agentPreset) !== agentPreset) {
      throw new Error('DSH created ' + sessionId + ' with preset ' + String(created.agentPreset) + ', expected ' + agentPreset)
    }
    const resolved = await this.service.resolve(sessionId)
    if ('error' in resolved) throw new Error('session ' + sessionId + ' was created but its agent is unavailable: ' + resolved.error.message)
    try {
      await this.ctx.sessionController.rename({ sessionId, title })
    } catch (error) {
      this.log('warn', 'could not rename ' + sessionId + ': ' + String(error && error.message ? error.message : error))
    }
    await this.attachWorkspace(sessionId, cwd)
    return { sessionId, agent: resolved.agent, created: true, preset: agentPreset }
  }

  async ensureChatbot() {
    if (this.ensuringChatbot) return this.ensuringChatbot
    this.ensuringChatbot = this.doEnsureChatbot().finally(() => { this.ensuringChatbot = undefined })
    return this.ensuringChatbot
  }

  async doEnsureChatbot() {
    const stored = this.v2.chatbotSessionId
    if (stored) {
      try {
        const resolved = await this.service.resolve(stored)
        if (!('error' in resolved)) {
          this.install(resolved.agent, 'chatbot')
          this.service.store.setRia(stored, 'standard')
          await this.attachWorkspace(stored, this.stateDir)
          this.v2.clearError('chatbot')
          return { sessionId: stored, created: false, preset: 'standard' }
        }
        if (resolved.error.code !== 'session/not-found') {
          throw new Error('cannot open Chatbot ' + stored + ': ' + resolved.error.message)
        }
        this.v2.clearChatbot(stored)
      } catch (error) {
        this.v2.recordError('chatbot', error, { sessionId: stored, phase: 'resume' })
        if (String(this.service.store.riaSessionId || '') === String(stored)) this.service.store.clearRia()
        throw error
      }
    }
    const sessionId = 'session-' + randomUUID()
    this.v2.setChatbot(sessionId)
    try {
      const result = await this.createSession({ sessionId, cwd: this.stateDir, agentPreset: 'standard', title: 'Chatbot' })
      this.service.store.setRia(sessionId, 'standard')
      this.install(result.agent, 'chatbot')
      this.v2.clearError('chatbot')
      return { sessionId, created: true, preset: 'standard' }
    } catch (error) {
      this.v2.recordError('chatbot', error, { sessionId, phase: 'create' })
      this.v2.clearChatbot(sessionId)
      if (String(this.service.store.riaSessionId || '') === String(sessionId)) this.service.store.clearRia()
      throw error
    }
  }

  async ensureAdvisor(scope = 'global') {
    if (this.ensuringAdvisor.has(scope)) return await this.ensuringAdvisor.get(scope)
    const task = this.doEnsureAdvisor(scope).finally(() => { this.ensuringAdvisor.delete(scope) })
    this.ensuringAdvisor.set(scope, task)
    return await task
  }

  async doEnsureAdvisor(scope) {
    const stored = this.v2.advisor(scope)
    if (stored) {
      const resolved = await this.service.resolve(stored.sessionId)
      if (!('error' in resolved)) {
        this.install(resolved.agent, 'advisor')
        await this.attachWorkspace(stored.sessionId, stored.cwd || this.stateDir)
        return { sessionId: stored.sessionId, created: false, preset: 'ptc' }
      }
      if (resolved.error.code !== 'session/not-found') {
        throw new Error('cannot open Advisor ' + stored.sessionId + ': ' + resolved.error.message)
      }
      this.v2.clearAdvisor(scope, stored.sessionId)
    }
    const sessionId = 'session-' + randomUUID()
    // Keep the Advisor's writable cwd outside the Ria control state. PTC keeps
    // run_code, and restrict() cannot remove that reserved transport, so a
    // Advisor working directly in stateDir could rewrite ria.json or grants.
    const cwd = join(this.stateDir, 'advisors')
    this.v2.setAdvisor(scope, sessionId, { cwd })
    try {
      const result = await this.createSession({ sessionId, cwd, agentPreset: 'ptc', title: 'Advisor' })
      this.install(result.agent, 'advisor')
      return { sessionId, created: true, preset: 'ptc' }
    } catch (error) {
      this.v2.clearAdvisor(scope, sessionId)
      throw error
    }
  }

  async ensureWorker(scope = 'global', projectId = null, projectCwd = undefined) {
    const workspaceCwd = text(projectCwd)
    const reusable = this.v2.workers()
      .filter(item => item && item.kind === 'managed' && item.workerType !== 'reflection' && item.scope === scope)
      .filter(item => scope !== 'project' || item.projectId === projectId)
      // A ticket that names a project directory must reuse only a Worker with
      // that same cwd. Otherwise an idle Global worker rooted in stateDir would
      // be handed a project ticket it has no sandbox access to.
      .filter(item => workspaceCwd ? item.cwd === workspaceCwd : !item.projectCwd)
      .filter(item => item.status === 'idle' && !item.currentTicketId)
      .sort((a, b) => (b.lastUsedAt || b.createdAt || 0) - (a.lastUsedAt || a.createdAt || 0))[0]
    if (reusable) {
      const resolved = await this.service.resolve(reusable.sessionId)
      if (!('error' in resolved)) {
        this.install(resolved.agent, 'worker')
        return { sessionId: reusable.sessionId, created: false, preset: 'ptc', meta: reusable }
      }
      this.v2.removeWorker(reusable.sessionId)
    }
    const sessionId = 'session-' + randomUUID()
    const cwd = workspaceCwd || (scope === 'project' && projectCwd ? projectCwd : join(this.stateDir, 'workers'))
    const artifactDir = join(cwd, workspaceCwd ? 'ria-runs' : 'runs', sessionId)
    mkdirSync(artifactDir, { recursive: true })
    const meta = this.v2.addWorker(sessionId, {
      scope,
      projectId,
      projectCwd: workspaceCwd || null,
      workerType: 'work',
      cwd,
      artifactDir,
      status: 'working',
      createdAt: now(),
      lastUsedAt: now(),
    })
    const count = this.v2.workers().length
    try {
      const result = await this.createSession({ sessionId, cwd, agentPreset: 'ptc', title: 'Worker ' + count })
      this.install(result.agent, 'worker')
      return { sessionId, created: true, preset: 'ptc', meta }
    } catch (error) {
      this.v2.removeWorker(sessionId)
      throw error
    }
  }


  /**
   * One reusable reflection Worker, or a fresh one. Its cwd is a state
   * directory, never a project: the reflection Worker reads repository files
   * through read-only tools only and cannot write code.
   */
  async ensureReflectionWorker(scope = 'global') {
    const reusable = this.v2.workers()
      .filter(item => item && item.kind === 'managed' && item.workerType === 'reflection' && item.scope === scope)
      .filter(item => item.status === 'idle' && !item.currentTicketId)
      .sort((a, b) => (b.lastUsedAt || b.createdAt || 0) - (a.lastUsedAt || a.createdAt || 0))[0]
    if (reusable) {
      const resolved = await this.service.resolve(reusable.sessionId)
      if (!('error' in resolved)) {
        this.install(resolved.agent, 'worker')
        return { sessionId: reusable.sessionId, created: false, preset: 'ptc', meta: reusable }
      }
      this.v2.removeWorker(reusable.sessionId)
    }
    const sessionId = 'session-' + randomUUID()
    const cwd = join(this.stateDir, 'reflection-workers')
    const artifactDir = join(cwd, 'runs', sessionId)
    mkdirSync(artifactDir, { recursive: true })
    const meta = this.v2.addWorker(sessionId, {
      scope,
      projectId: null,
      projectCwd: null,
      workerType: 'reflection',
      cwd,
      artifactDir,
      status: 'working',
      createdAt: now(),
      lastUsedAt: now(),
    })
    try {
      const result = await this.createSession({ sessionId, cwd, agentPreset: 'ptc', title: 'Reflection Worker' })
      this.install(result.agent, 'worker')
      return { sessionId, created: true, preset: 'ptc', meta }
    } catch (error) {
      this.v2.removeWorker(sessionId)
      throw error
    }
  }

  ticketView(ticket) {
    if (!ticket) return null
    const meta = this.v2.data.tickets[ticket.ticketId] || null
    const reports = this.v2.reportsFor(ticket.ticketId, 1)
    return {
      ticketId: ticket.ticketId,
      status: ticket.status,
      waitingOn: ticket.waitingOn,
      goal: ticket.goal,
      acceptance: ticket.acceptance,
      executor: ticket.executor,
      blockedReason: ticket.blockedReason,
      attention: ticket.attention,
      progress: ticket.progress,
      resolution: ticket.resolution,
      failure: ticket.failure,
      createdAt: ticket.createdAt,
      updatedAt: ticket.updatedAt,
      phase: meta && meta.phase ? meta.phase : null,
      workerId: meta && meta.workerId ? meta.workerId : null,
      workspace: meta && meta.projectCwd ? meta.projectCwd : null,
      latestReport: reports.length ? reports[0] : null,
    }
  }

  ticketBundle(ticket) {
    const meta = this.v2.data.tickets[ticket.ticketId] || null
    return {
      ticket: this.ticketView(ticket),
      meta,
      workOrder: this.v2.workOrder(ticket.ticketId),
      reports: this.v2.reportsFor(ticket.ticketId, 20),
      inbox: this.v2.pendingInbox(ticket.ticketId, meta && meta.workerId ? meta.workerId : ''),
      history: Array.isArray(ticket.history) ? ticket.history.slice(-20) : [],
    }
  }

  async notifyChatbot(message) {
    const chatbot = this.v2.chatbotSessionId
    if (!chatbot) return false
    try {
      await this.promptSession(chatbot, routerNotice(message))
      return true
    } catch (error) {
      this.log('warn', 'could not notify Chatbot: ' + String(error && error.message ? error.message : error))
      return false
    }
  }

  async sessionTitle(summary) {
    const known = summary && summary.projections && summary.projections.values
      ? text(summary.projections.values.title)
      : ''
    if (known) return known
    try {
      const projection = await this.ctx.sessionController.projections({ sessionId: String(summary.sessionId) })
      return projection && projection.values ? text(projection.values.title) : ''
    } catch {
      return ''
    }
  }

  archivedSessionIds() {
    const archived = this.ctx.workspaceRegistry && this.ctx.workspaceRegistry.archivedSessionIds
    return new Set((archived || []).map(item => String(item)))
  }

  /**
   * Ordinary top-level sessions the user can also open directly. Shared by the
   * listing and the blocked-notice filter so both agree on eligibility.
   */
  isIndependentSummary(item, archived) {
    const sessionId = String(item && item.sessionId ? item.sessionId : '')
    if (!sessionId || this.roleFor(sessionId)) return false
    // A dormant session (agentAvailable:false) is still perfectly usable: the
    // next prompt attaches a fresh agent. Only archived/subagent/blank rows are
    // excluded; filtering on agentAvailable made every session vanish for a
    // while after a Host restart, until something happened to wake it.
    if (item.blank || item.origin === 'subagent' || item.parentSessionId) return false
    if (archived.has(sessionId)) return false
    // Ria's own sessions (Chatbot, Advisors, Workers, reflection) live under
    // the state directory. They are reachable through their own roles, never
    // through this user-facing bridge.
    const cwd = text(item.cwd)
    if (cwd && containsPath(this.stateDir, cwd)) return false
    return true
  }

  /** Ordinary top-level sessions the user can also open directly. */
  async independentSessions() {
    const listed = await this.ctx.sessionController.list({})
    const archived = this.archivedSessionIds()
    const sessions = []
    for (const item of Array.isArray(listed && listed.items) ? listed.items : []) {
      if (!this.isIndependentSummary(item, archived)) continue
      sessions.push({ ...item, sessionId: String(item.sessionId) })
    }
    sessions.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
    const candidates = sessions.slice(0, 50)
    await Promise.all(candidates.map(async item => { item.title = await this.sessionTitle(item) }))
    return candidates
  }

  /**
   * One ordinary independent session by id, from the full listing. No top-50
   * slice: a session parked on an approval may be older than everything the
   * listing shows, and it is exactly the one worth reporting.
   */
  async independentSessionById(sessionId) {
    const id = String(sessionId || '')
    if (!id) return null
    const listed = await this.ctx.sessionController.list({})
    const items = Array.isArray(listed && listed.items) ? listed.items : []
    const item = items.find(entry => String(entry && entry.sessionId) === id)
    if (!item || !this.isIndependentSummary(item, this.archivedSessionIds())) return null
    return { ...item, sessionId: id, title: await this.sessionTitle(item) }
  }

  /**
   * Report a session that stopped to ask a human, in the Chatbot's channel
   * only. Read-only: no approval decision and no answer ever comes from here,
   * so both listeners delegate with next() immediately.
   *
   * prepend is required. The host web bundle loads before profile plugins and
   * dsh-api-remotes forwards these two waterfalls to the browser, holding the
   * request until the user acts; a normally registered listener would never
   * run (same ordering as lib/approvals.mjs and docs/architecture.md §4.4).
   */
  subscribeBlockedNotices() {
    const prepend = { prepend: true }
    const disposeApproval = this.ctx.on('approval/request', (request, next) => this.noticeApproval(request, next), prepend)
    const disposeQuestion = this.ctx.on('user-questions/request', (request, next) => this.noticeQuestion(request, next), prepend)
    return () => {
      try { disposeApproval() } catch { /* already removed */ }
      try { disposeQuestion() } catch { /* already removed */ }
    }
  }

  async noticeApproval(request, next) {
    try {
      const sessionId = String(request && request.agent && request.agent.id !== undefined ? request.agent.id : '')
      const toolName = text(request.toolName)
      // Optional shortcut, disabled by default. It only ever covers a managed
      // Worker that is executing a ticket, and only the configured tool names;
      // every other request still goes to the downstream answerer.
      if (sessionId && this.roleFor(sessionId) === 'worker' && this.workingTicketFor(sessionId)) {
        const allow = this.approvalAutoAllow()
        if (toolName && allow.includes(toolName)) {
          this.markAutoAllowed(sessionId, toolName, text(request.callId))
          this.log('info', 'auto-allowed ' + toolName + ' for worker ' + sessionId + ' (approvalAutoAllow)')
          return 'allowed-once'
        }
      }
      // Independent sessions get the read-only notice; Workers are covered by
      // the ticket state above instead.
      if (sessionId && !this.roleFor(sessionId)) {
        this.queueBlockedNotice(sessionId, 'approval', {
          toolName,
          reason: text(request.reason),
        })
      }
    } catch (error) {
      this.log('warn', 'could not queue an approval notice: ' + String(error && error.message ? error.message : error))
    }
    // The decision belongs to the downstream answerer; never claim the request.
    return await next()
  }

  async noticeQuestion(request, next) {
    try {
      const sessionId = String(request && request.agent && request.agent.id !== undefined ? request.agent.id : '')
      if (sessionId && !this.roleFor(sessionId)) {
        const first = Array.isArray(request.questions) ? request.questions[0] : null
        this.queueBlockedNotice(sessionId, 'question', {
          question: first && typeof first.question === 'string' ? first.question : '',
        })
      }
    } catch (error) {
      this.log('warn', 'could not queue a question notice: ' + String(error && error.message ? error.message : error))
    }
    return await next()
  }

  /**
   * Fire-and-forget: a notice must never delay the approval waterfall, so the
   * promise is detached and failures are logged instead of surfaced to the host.
   */
  queueBlockedNotice(sessionId, kind, detail) {
    void this.sendBlockedNotice(sessionId, kind, detail).catch(error => {
      this.log('warn', 'could not send a blocked notice: ' + String(error && error.message ? error.message : error))
    })
  }

  async sendBlockedNotice(sessionId, kind, detail) {
    const session = await this.independentSessionById(sessionId)
    if (!session) return false
    const at = now()
    const key = sessionId + '|' + kind
    const signature = kind === 'approval'
      ? kind + '|' + detail.toolName + '|' + detail.reason
      : kind + '|' + String(detail.question || '').slice(0, 80)
    // Flood guard across signatures: one notice per session per minute, no
    // matter how many different requests it hits.
    const last = this.lastBlockedNoticeAt.get(sessionId)
    if (last !== undefined && at - last < this.blockedNoticeMinIntervalMs) return false
    // The same request observed again (retry, re-render) must not notify twice.
    const seen = this.blockedNotices.get(key)
    if (seen && seen.signature === signature && at - seen.at < this.blockedNoticeWindowMs) return false
    this.blockedNotices.set(key, { at, signature })
    this.lastBlockedNoticeAt.set(sessionId, at)
    const title = this.clipNotice(session.title || '(untitled)', 24)
    const elapsed = this.turnSeconds(sessionId)
    const span = elapsed === undefined ? '' : '，本轮已运行 ' + elapsed + 's'
    const message = kind === 'approval'
      ? '「' + title + '」在等审批：' + this.clipNotice(detail.toolName || 'unknown', 24) + '（' + this.clipNotice(detail.reason || '未说明', 24) + '）' + span + '。去该会话处理，Ria 不代答。'
      : '「' + title + '」在等回答：' + this.clipNotice(detail.question || '（未提供问题）', 40) + span + '。去该会话回答。'
    return await this.notifyChatbot(message)
  }

  clearBlockedNotice(sessionId, kind) {
    this.blockedNotices.delete(String(sessionId) + '|' + kind)
  }

  turnSeconds(sessionId) {
    const started = this.turnStartedAt.get(String(sessionId))
    if (!Number.isFinite(started)) return undefined
    const elapsed = Math.round((now() - started) / 1000)
    return elapsed >= 0 ? elapsed : undefined
  }

  clipNotice(value, limit) {
    const body = String(value == null ? '' : value).replace(/\s+/g, ' ').trim()
    return body.length > limit ? body.slice(0, limit) + '…' : body
  }

  async resolveIndependentTarget(args) {
    const sessions = await this.independentSessions()
    const sessionId = text(args.sessionId)
    if (sessionId) {
      const exact = sessions.find(item => item.sessionId === sessionId)
      if (!exact) {
        return {
          error: {
            ok: false,
            code: 'session_not_independent',
            message: 'session is not an ordinary independent session: ' + sessionId,
          },
        }
      }
      return { session: exact }
    }
    const query = text(args.title)
    if (!query) return { error: { ok: false, code: 'session_required', message: 'sessionId or title is required' } }
    const ranked = sessions
      .map(item => ({ item, score: titleScore(query, item.title) }))
      .filter(entry => entry.score > 0)
      .sort((left, right) => right.score - left.score || Number(right.item.updatedAt || 0) - Number(left.item.updatedAt || 0))
    const best = ranked[0]
    const second = ranked[1]
    const describe = entry => ({
      sessionId: entry.item.sessionId,
      title: entry.item.title,
      cwd: entry.item.cwd,
      updatedAt: entry.item.updatedAt,
      score: Math.round(entry.score * 100) / 100,
    })
    if (!best) {
      return {
        error: {
          ok: false,
          code: 'session_missing',
          message: 'no independent session matches title: ' + query,
          candidates: sessions.slice(0, 5).map(item => describe({ item, score: 0 })),
        },
      }
    }
    const clearWinner = best.score >= 0.8 && (!second || best.score - second.score >= 0.05)
    const likelyWinner = best.score >= 0.58 && (!second || best.score - second.score >= 0.12)
    if (clearWinner || likelyWinner) return { session: best.item }
    return {
      error: {
        ok: false,
        code: 'session_ambiguous',
        message: 'more than one session matches; ask the user which one',
        candidates: ranked.slice(0, 10).map(describe),
      },
    }
  }

  directInfo() {
    if (!this.direct) return { active: false }
    return {
      active: true,
      sessionId: this.direct.sessionId,
      title: this.direct.title,
      since: this.direct.since,
    }
  }

  setDirect(session) {
    const title = text(session && session.title) || String(session && session.sessionId ? session.sessionId : '未命名会话')
    this.direct = {
      sessionId: String(session.sessionId),
      title: title.replace(/\s+/g, ' ').slice(0, 80),
      since: now(),
    }
    return this.directInfo()
  }

  /** Send a system-style line to the WeChat Claw user without a model turn. */
  notifyDirect(text) {
    const claw = this.service.wechatClaw
    if (!claw || typeof claw.forwardAssistant !== 'function') return false
    try {
      // Direct-mode chatter is live conversation, not a ticket reply. Queueing
      // it as a durable fallback makes a stale login replay it later as a
      // “补发” burst, so failures stay in the assistant log only.
      claw.forwardAssistant(String(text), undefined, { fallback: false })
      return true
    } catch (error) {
      this.log('warn', 'could not notify direct mode: ' + String(error && error.message ? error.message : error))
      return false
    }
  }

  forwardDirectReply(reply, event) {
    const claw = this.service.wechatClaw
    if (!claw || typeof claw.forwardAssistant !== 'function') return
    const value = String(reply == null ? '' : reply).trim()
    if (!value) return
    const title = this.direct && this.direct.title ? this.direct.title : '会话'
    try {
      claw.forwardAssistant('【直通·' + title + '】\n' + value, event, { fallback: false })
    } catch (error) {
      this.log('warn', 'could not forward direct reply: ' + String(error && error.message ? error.message : error))
    }
  }

  async enableDirect(query) {
    const target = await this.resolveIndependentTarget(query)
    if (target.error) return target.error
    const info = this.setDirect(target.session)
    return {
      ok: true,
      ...info,
      hint: '接下来的微信消息会直接发给这个会话；回复会带【直通·标题】前缀。切换目标：/直通 <会话名>；退出：/退出直通。',
    }
  }

  /**
   * The WeChat Claw inbound funnel. Returning true means this message was
   * consumed by direct mode and must not start a Chatbot turn.
   */
  async directRelay(content, sessionId) {
    const chatbotId = String(this.v2.chatbotSessionId || '')
    if (!chatbotId || String(sessionId || '') !== chatbotId) return false
    const body = contentText(content).trim()
    if (!body) return false
    const command = directCommand(body)
    if (!this.direct) {
      if (!command) return false
      if (command.kind === 'status') {
        this.notifyDirect('直通未开启。发送 /直通 <会话标题或 sessionId> 可开启。')
        return true
      }
      if (command.kind === 'off') {
        this.notifyDirect('直通未开启。')
        return true
      }
      const query = /^session-/i.test(command.target)
        ? { sessionId: command.target }
        : { title: command.target }
      const result = await this.enableDirect(query)
      if (result.ok) {
        this.notifyDirect('已进入直通模式：' + result.title + '\n接下来的微信消息会直接发给它。\n切换目标：/直通 <会话名>\n退出：/退出直通')
      } else {
        const candidates = Array.isArray(result.candidates)
          ? '\n' + result.candidates.map(item => '- ' + (item.title || item.sessionId) + ' (' + item.sessionId + ')').join('\n')
          : ''
        this.notifyDirect('没有开启直通：' + (result.message || result.code || '未知错误') + candidates)
      }
      return true
    }
    if (command && command.kind === 'off') {
      this.direct = undefined
      this.notifyDirect('已退出直通模式。')
      return true
    }
    if (command && command.kind === 'status') {
      const info = this.directInfo()
      this.notifyDirect('直通中：' + info.title + ' (' + info.sessionId + ')\n切换目标：/直通 <会话名>\n退出：/退出直通')
      return true
    }
    if (command && command.kind === 'on') {
      const query = /^session-/i.test(command.target)
        ? { sessionId: command.target }
        : { title: command.target }
      const result = await this.enableDirect(query)
      if (result.ok) this.notifyDirect('已切换直通目标：' + result.title + '\n退出：/退出直通')
      else {
        const candidates = Array.isArray(result.candidates)
          ? '\n' + result.candidates.map(item => '- ' + (item.title || item.sessionId) + ' (' + item.sessionId + ')').join('\n')
          : ''
        this.notifyDirect('没有切换：' + (result.message || result.code || '未知错误') + candidates)
      }
      return true
    }
    const target = this.direct
    try {
      await this.promptSession(target.sessionId, body, 'steer')
    } catch (error) {
      this.direct = undefined
      this.notifyDirect('直通目标 ' + target.title + ' 不可用，已退出直通：'
        + String(error && error.message ? error.message : error))
    }
    return true
  }

  async chatbotDirect(args, exec) {
    if (!this.chatbotCaller(exec)) return { ok: false, code: 'forbidden', message: 'only the Chatbot may control direct mode' }
    const action = text(args.action)
    if (action === 'status') return { ok: true, ...this.directInfo() }
    if (action === 'off') {
      const previous = this.directInfo()
      this.direct = undefined
      return { ok: true, active: false, previous }
    }
    if (action !== 'on') return { ok: false, code: 'invalid_action', message: 'action must be on, off or status' }
    const sessionId = text(args.sessionId)
    const title = text(args.title)
    if (!sessionId && !title) return { ok: false, code: 'session_required', message: 'sessionId or title is required for action=on' }
    return await this.enableDirect(sessionId ? { sessionId } : { title })
  }

  async chatbotGrant(args, exec) {
    if (!this.chatbotCaller(exec)) return { ok: false, code: 'forbidden', message: 'only the Chatbot may change Worker permissions' }
    const action = text(args.action) || 'list'
    if (action === 'list') {
      try { await this.service.grants.reconcile() } catch (error) {
        this.log('warn', 'grant reconcile failed: ' + String(error && error.message ? error.message : error))
      }
      const grants = this.service.grants.list()
      return { ok: true, grants, count: grants.length }
    }
    if (action === 'reset') {
      const grantId = text(args.grantId)
      if (!grantId) return { ok: false, code: 'grant_id_required', message: 'grantId is required for action=reset' }
      try {
        const result = await this.service.grants.restore(grantId, 'explicit-reset')
        if (result.missing) return { ok: false, code: 'grant_missing', message: 'grant not found: ' + grantId }
        if (result.busy) return { ok: false, code: 'grant_busy', message: 'grant is already being restored: ' + grantId }
        if (result.error) return { ok: false, code: 'grant_restore_failed', message: result.error }
        return { ok: true, ...result }
      } catch (error) {
        return { ok: false, code: 'grant_restore_failed', message: String(error && error.message ? error.message : error) }
      }
    }
    if (action !== 'set') return { ok: false, code: 'invalid_action', message: 'action must be set, list or reset' }
    const sessionId = text(args.sessionId)
    if (!sessionId) return { ok: false, code: 'session_required', message: 'sessionId is required for action=set' }
    const reason = text(args.reason)
    if (!reason) return { ok: false, code: 'reason_required', message: 'reason is required for action=set' }
    const requested = {
      ...args,
      action: 'set',
      sessionId,
      reason,
      // The user is the authority here; the tool is only callable from the
      // Chatbot after an explicit request. GrantService verifies the target is
      // a top-level session and enforces the escalation/TTL/audit rules.
      userConfirmed: true,
    }
    // Bind to the current ticket only for a managed Worker. Independent
    // sessions have no ticket and must still be grantable.
    const worker = this.v2.worker(sessionId)
    if (!text(requested.ticketId) && worker && worker.currentTicketId) requested.ticketId = worker.currentTicketId
    try {
      const grant = await this.service.grants.set(requested)
      return { ok: true, grant }
    } catch (error) {
      return { ok: false, code: 'grant_rejected', message: String(error && error.message ? error.message : error) }
    }
  }

  /** Human-readable name for the pending-input kind a session is parked on. */
  inputLabel(state) {
    const pending = Array.isArray(state && state.pendingInput) ? state.pendingInput : []
    if (pending.includes('approval')) return 'approval'
    if (pending.includes('question')) return 'a question answer'
    if (pending.includes('other')) return 'another pending request'
    return 'input'
  }

  /** Why a session refuses a new message right now. */
  busyReason(state) {
    const label = this.inputLabel(state)
    return label === 'input' ? 'working on the current turn' : 'waiting for ' + label
  }

  async chatbotSessions(args, exec) {
    if (!this.chatbotCaller(exec)) return { ok: false, code: 'forbidden', message: 'only the Chatbot may list sessions' }
    const limit = Number.isSafeInteger(args.limit) ? Math.max(1, Math.min(20, args.limit)) : 10
    const query = text(args.query).toLowerCase()
    const sessions = await this.independentSessions()
    const filtered = query
      ? sessions.filter(item => String(item.title || '').toLowerCase().includes(query) || String(item.cwd || '').toLowerCase().includes(query))
      : sessions
    // A session can look idle in the list projection and still be parked on a
    // pending approval or question. Read the state per row and keep the listing
    // intact when one session's live state is gone.
    const signal = new AbortController().signal
    const rows = await Promise.all(filtered.slice(0, limit).map(async item => {
      let state
      try {
        state = await this.ctx.sessionController.state({ sessionId: item.sessionId }, signal)
      } catch {
        state = null
      }
      return {
        sessionId: item.sessionId,
        title: item.title || '(untitled)',
        cwd: item.cwd || null,
        running: Boolean((state && state.running) || item.running),
        pendingInput: Array.isArray(state && state.pendingInput) ? state.pendingInput.slice() : [],
        updatedAt: item.updatedAt || null,
      }
    }))
    return { ok: true, sessions: rows, total: filtered.length }
  }

  async chatbotTalk(args, exec) {
    if (!this.chatbotCaller(exec)) return { ok: false, code: 'forbidden', message: 'only the Chatbot may talk to a session' }
    const message = text(args.message)
    if (!message) return { ok: false, code: 'message_required', message: 'message must not be empty' }
    const target = await this.resolveIndependentTarget(args)
    if (target.error) return target.error
    const session = target.session
    const waitSeconds = Number.isFinite(args.waitSeconds) ? Math.max(5, Math.min(120, Math.floor(args.waitSeconds))) : 60
    let before
    try {
      before = await this.ctx.sessionController.state({ sessionId: session.sessionId }, new AbortController().signal)
    } catch (error) {
      return { ok: false, code: 'session_unavailable', message: String(error && error.message ? error.message : error) }
    }
    // A queued message would sit behind work the user already started, and
    // waiting on it would be indistinguishable from waiting on this message.
    if (before.running || (Array.isArray(before.queue) && before.queue.length > 0) || (Array.isArray(before.pendingInput) && before.pendingInput.length > 0)) {
      // "Busy" alone hides the difference between a long turn and a session
      // parked on a human decision; the Chatbot cannot tell the user which.
      return {
        ok: false,
        code: 'session_busy',
        sessionId: session.sessionId,
        running: Boolean(before.running),
        pendingInput: Array.isArray(before.pendingInput) ? before.pendingInput.slice() : [],
        message: 'session is busy (' + this.busyReason(before) + '); use chatbot_read, or open the session to unblock it',
      }
    }
    const afterSeq = Number.isSafeInteger(before.cursor) ? before.cursor : -1
    const requestId = HOST_REQUEST_PREFIX + randomUUID()
    try {
      await this.promptSession(session.sessionId, message, 'queue', requestId)
    } catch (error) {
      return { ok: false, code: 'send_failed', sessionId: session.sessionId, message: String(error && error.message ? error.message : error) }
    }
    let waited
    try {
      waited = await this.ctx.sessionController.wait({
        sessionId: session.sessionId,
        timeoutMs: waitSeconds * 1000,
        afterSeq,
        maxMessages: 50,
      }, new AbortController().signal)
    } catch (error) {
      return { ok: false, code: 'wait_failed', sessionId: session.sessionId, message: String(error && error.message ? error.message : error) }
    }
    const reply = assistantText(waited && waited.output ? waited.output.records : [])
    const cursor = waited && waited.state && Number.isSafeInteger(waited.state.cursor) ? waited.state.cursor : afterSeq
    if (!reply) {
      const reason = waited && waited.reason ? waited.reason : 'unknown'
      const state = waited && waited.state ? waited.state : {}
      // input-required means the turn stopped to ask the human something. It is
      // pending, exactly like a timeout, but the user must be told which one.
      const inputRequired = reason === 'input-required'
      return {
        ok: true,
        sessionId: session.sessionId,
        title: session.title || '(untitled)',
        replied: false,
        pending: inputRequired || reason === 'timeout',
        reason,
        running: Boolean(state.running),
        pendingInput: Array.isArray(state.pendingInput) ? state.pendingInput.slice() : [],
        cursor,
        message: inputRequired
          ? 'sent; the session is waiting for ' + this.inputLabel(state) + ', open it to unblock'
          : reason === 'timeout'
            ? 'sent; the session is still working, use chatbot_read later'
            : 'sent; no text reply yet',
      }
    }
    return {
      ok: true,
      sessionId: session.sessionId,
      title: session.title || '(untitled)',
      replied: true,
      reply: reply.length > 8000 ? reply.slice(0, 8000) + '…' : reply,
      cursor,
      truncated: Boolean(waited && waited.output && waited.output.truncated),
    }
  }

  async chatbotRead(args, exec) {
    if (!this.chatbotCaller(exec)) return { ok: false, code: 'forbidden', message: 'only the Chatbot may read a session' }
    const target = await this.resolveIndependentTarget(args)
    if (target.error) return target.error
    const session = target.session
    const limit = Number.isSafeInteger(args.limit) ? Math.max(1, Math.min(30, args.limit)) : 20
    const afterSeq = Number.isSafeInteger(args.afterSeq) ? args.afterSeq : -1
    let state
    try {
      state = await this.ctx.sessionController.state({ sessionId: session.sessionId }, new AbortController().signal)
    } catch (error) {
      return { ok: false, code: 'session_unavailable', message: String(error && error.message ? error.message : error) }
    }
    let page
    try {
      page = await this.ctx.sessionController.events({
        address: { kind: 'session', sessionId: session.sessionId },
        throughSeq: Number.isSafeInteger(state.cursor) ? state.cursor : undefined,
        maxMessages: Math.max(limit * 2, 40),
      }, new AbortController().signal)
    } catch (error) {
      return { ok: false, code: 'read_failed', sessionId: session.sessionId, message: String(error && error.message ? error.message : error) }
    }
    const messages = []
    for (const record of Array.isArray(page && page.records) ? page.records : []) {
      const message = messageOf(record)
      if (!message) continue
      if (message.seq !== undefined && message.seq <= afterSeq) continue
      messages.push({
        role: message.role,
        text: message.text.length > 3000 ? message.text.slice(0, 3000) + '…' : message.text,
        seq: message.seq,
        at: message.at,
      })
    }
    const selected = messages.slice(-limit)
    const cursor = selected.length && Number.isSafeInteger(selected[selected.length - 1].seq)
      ? selected[selected.length - 1].seq
      : afterSeq
    // queue stays null when the session has no live agent; flattening that into
    // "empty" would claim knowledge the state controller does not have.
    const queue = Array.isArray(state.queue)
      ? state.queue.map(item => ({ id: item.id, placement: item.placement }))
      : null
    return {
      ok: true,
      sessionId: session.sessionId,
      title: session.title || '(untitled)',
      running: Boolean(state.running),
      pendingInput: Array.isArray(state.pendingInput) ? state.pendingInput.slice() : [],
      queue,
      queueLength: queue ? queue.length : 0,
      messages: selected,
      cursor,
      truncated: Boolean(page && page.hasMore),
    }
  }

  async chatbotRequest(args, exec) {
    const goal = text(args.goal)
    if (!goal) return { ok: false, code: 'goal_required', message: 'goal must not be empty' }
    const acceptance = text(args.acceptance)
    // answer: short Q&A answered by the Advisor itself; work: normal WorkOrder +
    // work Worker; reflection: retrospective ticket for a reflection Worker.
    // Defaults to work for backward compatibility.
    const mode = text(args.mode) || 'work'
    if (mode !== 'answer' && mode !== 'work' && mode !== 'reflection') {
      return { ok: false, code: 'invalid_mode', message: "mode must be 'answer', 'work' or 'reflection'" }
    }
    const workspaceArg = text(args.workspace)
    // Reflection tickets are read-only reviews of past sessions; a project
    // workspace would imply writing repository code, which they must not do.
    if (mode === 'reflection' && workspaceArg) {
      return { ok: false, code: 'reflection_with_workspace', message: 'reflection tickets are read-only and take no workspace' }
    }
    let projectCwd = null
    if (workspaceArg) {
      if (!isAbsolute(workspaceArg)) {
        return { ok: false, code: 'workspace_not_absolute', message: 'workspace must be an absolute directory path' }
      }
      projectCwd = resolve(workspaceArg)
      try {
        if (!statSync(projectCwd).isDirectory()) {
          return { ok: false, code: 'workspace_not_directory', message: 'workspace is not a directory: ' + projectCwd }
        }
      } catch (error) {
        return { ok: false, code: 'workspace_missing', message: 'workspace does not exist: ' + projectCwd }
      }
      // Canonicalize so a symlink cannot hide that the workspace wraps the Ria
      // control state. The Worker's sandbox is rooted at this cwd.
      try {
        projectCwd = realpathSync(projectCwd)
      } catch (error) {
        return { ok: false, code: 'workspace_missing', message: 'workspace is not readable: ' + projectCwd }
      }
      // If that root contains the Ria control state, the Worker could rewrite
      // ria.json or grants without any elevation. Refuse such a workspace.
      let stateRoot
      try {
        stateRoot = realpathSync(this.stateDir)
      } catch {
        stateRoot = resolve(this.stateDir)
      }
      const prefix = projectCwd.endsWith(sep) ? projectCwd : projectCwd + sep
      if (stateRoot === projectCwd || stateRoot.startsWith(prefix)) {
        return { ok: false, code: 'workspace_overlaps_state', message: 'workspace must not contain Ria state: ' + projectCwd }
      }
    }
    const requestId = newId('req_')
    const request = {
      requestId,
      goal,
      acceptance,
      workspace: projectCwd,
      mode,
      source: 'chatbot',
      sessionId: String(exec && exec.agent ? exec.agent.id : ''),
      createdAt: now(),
    }
    this.v2.addRequest(request)
    let ticket
    try {
      ticket = this.service.store.addTicket({
        status: 'intake',
        waitingOn: 'ria',
        executor: null,
        goal,
        acceptance,
        origin: { kind: 'chatbot', text: goal, sessionId: request.sessionId, requestId },
      })
    } catch (error) {
      return { ok: false, code: error && error.code ? error.code : 'ticket_create_failed', message: String(error && error.message ? error.message : error) }
    }
    this.v2.setTicketMeta(ticket.ticketId, { scope: 'global', projectId: null, projectCwd, phase: 'advisor', requestId, mode })
    const opened = this.service.store.transitionTicket(ticket.ticketId, 'open', {
      actor: 'router',
      executor: 'advisor',
      waitingOn: 'ria',
      reason: 'intake routed to the Global Advisor',
    })
    if (!opened.ok) {
      return { ok: false, code: opened.code, message: opened.message, ticketId: ticket.ticketId }
    }
    try {
      const advisor = await this.ensureAdvisor('global')
      await this.promptSession(advisor.sessionId, ticketBrief(opened.ticket, request, this.v2.ticketMeta(ticket.ticketId)))
      return { ok: true, ticketId: ticket.ticketId, requestId, workspace: projectCwd, mode, status: 'open', phase: 'advisor' }
    } catch (error) {
      const message = String(error && error.message ? error.message : error)
      const blocked = this.service.store.transitionTicket(ticket.ticketId, 'blocked', {
        actor: 'router',
        executor: 'advisor',
        waitingOn: 'environment',
        blockedReason: 'Advisor 不可用：' + message,
        reason: 'could not start the Advisor',
      })
      this.v2.setTicketMeta(ticket.ticketId, { phase: 'blocked' })
      if (blocked.ok) await this.notifyChatbot('ticket ' + ticket.ticketId + ' 已创建，但 Advisor 启动失败，已暂停：' + message)
      return { ok: false, code: 'advisor_unavailable', message, ticketId: ticket.ticketId, status: blocked.ok ? 'blocked' : 'open' }
    }
  }

  async chatbotStatus(args) {
    if (text(args.ticketId)) {
      const ticket = this.service.store.knownTicket(text(args.ticketId))
      if (!ticket) return { ok: true, found: false, ticketId: text(args.ticketId) }
      return { ok: true, found: true, ...this.ticketBundle(ticket) }
    }
    const items = []
    for (const meta of this.v2.ticketMetas()) {
      const ticket = this.service.store.ticket(meta.ticketId)
      if (!ticket || !ACTIVE.has(ticket.status)) continue
      items.push(this.ticketView(ticket))
    }
    items.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
    return { ok: true, tickets: items }
  }

  async chatbotSteer(args, exec) {
    const ticketId = text(args.ticketId)
    const message = text(args.message)
    if (!ticketId || !message) return { ok: false, code: 'invalid_input', message: 'ticketId and message are required' }
    const ticket = this.service.store.ticket(ticketId)
    if (!ticket) return { ok: false, code: 'ticket_missing', message: 'ticket not found: ' + ticketId }
    if (TERMINAL.has(ticket.status)) return { ok: false, code: 'ticket_closed', message: 'ticket is already ' + ticket.status }
    if (ticket.status !== 'working') {
      // An open ticket that already has a WorkOrder is recoverable: resume now
      // re-dispatches instead of leaving steer as a dead end.
      const resumable = (ticket.status === 'open' && this.v2.workOrder(ticketId)) || ticket.status === 'blocked'
      return {
        ok: false,
        code: 'ticket_not_working',
        message: 'ticket is ' + ticket.status + (resumable ? '; use chatbot_resume to restart its Worker' : ''),
        hint: resumable ? '调用 chatbot_resume（可带 message）可恢复/重新派发这张 ticket' : undefined,
      }
    }
    const meta = this.v2.ticketMeta(ticketId)
    const workerId = text(meta.workerId) || (ticket.executor !== 'advisor' && ticket.executor !== 'self' ? text(ticket.executor) : '')
    if (!workerId) return { ok: false, code: 'worker_not_assigned', message: 'Advisor has not dispatched this ticket yet' }
    this.v2.addInbox({
      id: newId('inbox_'),
      ticketId,
      workerId,
      message,
      from: 'chatbot',
      by: String(exec && exec.agent ? exec.agent.id : ''),
      at: now(),
    })
    const busy = await this.service.workerBusy(workerId)
    if (!busy.busy && ticket.status === 'working') {
      const workOrder = this.v2.workOrder(ticketId)
      if (workOrder) {
        const worker = this.v2.worker(workerId) || {}
        try {
          await this.promptSession(workerId, '[Manager steer]\n' + message + '\n\n' + workerBrief(ticket, workOrder, worker))
        } catch (error) {
          this.log('warn', 'could not wake ' + workerId + ' for steer: ' + String(error && error.message ? error.message : error))
        }
      }
    }
    return { ok: true, ticketId, workerId, queued: busy.busy, message: busy.busy ? 'Worker 正在执行，会在下一个 checkpoint 读取。' : '已交给 Worker。' }
  }

  chatbotCaller(exec) {
    return this.roleFor(exec && exec.agent ? exec.agent.id : '') === 'chatbot'
  }

  async chatbotResume(args, exec) {
    if (!this.chatbotCaller(exec)) return { ok: false, code: 'forbidden', message: 'only the Chatbot may resume a ticket' }
    const ticketId = text(args.ticketId)
    const message = text(args.message)
    if (!ticketId) return { ok: false, code: 'invalid_input', message: 'ticketId is required' }
    const ticket = this.service.store.ticket(ticketId)
    if (!ticket) return { ok: false, code: 'ticket_missing', message: 'ticket not found: ' + ticketId }
    const workOrder = this.v2.workOrder(ticketId)
    // Idempotent recovery: a blocked ticket is the normal case, but an already
    // reopened ticket with a WorkOrder is a stuck ticket whose dispatch was
    // lost (today's bug). Only refuse when there is nothing to recover.
    // waitingOn=ria means the planned ticket is waiting for Ria to dispatch it;
    // a dependency-waiting ticket must not be force-dispatched.
    const stuckOpen = ticket.status === 'open' && Boolean(workOrder) && ticket.waitingOn === 'ria'
    if (ticket.status !== 'blocked' && !stuckOpen) {
      return { ok: false, code: 'ticket_not_blocked', message: 'ticket is ' + ticket.status + (workOrder ? '' : ' and has no WorkOrder') }
    }
    if (ticket.status === 'blocked' && !['user', 'environment', 'approval'].includes(ticket.waitingOn)) {
      return { ok: false, code: 'not_resumable', message: 'ticket is waiting on ' + ticket.waitingOn }
    }
    const meta = this.v2.ticketMeta(ticketId)
    const workerId = text(meta.workerId)
    const by = String(exec && exec.agent ? exec.agent.id : '')
    let resumed = ticket
    if (ticket.status === 'blocked') {
      const reopened = this.service.store.transitionTicket(ticketId, 'open', {
        actor: 'router',
        executor: 'advisor',
        waitingOn: 'ria',
        // Resuming clears the reason the ticket was parked, including a
        // recorded approval denial.
        failure: null,
        reason: 'user resumed the ticket',
      })
      if (!reopened.ok) return { ok: false, code: reopened.code, message: reopened.message, ticketId }
      // A manual resume overrides the pending approval: a late decision must not
      // flip the ticket again.
      this.clearApprovalsForTicket(ticketId)
      resumed = reopened.ticket
    }
    this.v2.setTicketMeta(ticketId, { phase: workOrder ? 'planned' : 'advisor' })
    if (workOrder) {
      // One recovery path for blocked resumes, stuck open/planned tickets and
      // (optionally) startup recovery. It never returns while the ticket is
      // still open/planned: every failure ends blocked with a readable reason.
      return await this.redispatch(ticketId, { workerId, message, by })
    }
    try {
      const advisor = await this.ensureAdvisor(meta.scope || 'global')
      const lines = [ticketBrief(resumed, meta.requestId ? this.v2.request(meta.requestId) : null, meta)]
      if (message) lines.push('用户回复: ' + message)
      await this.promptSession(advisor.sessionId, lines.join('\n'))
      return { ok: true, ticketId, status: 'open', phase: 'advisor' }
    } catch (error) {
      const failure = String(error && error.message ? error.message : error)
      const blocked = this.service.store.transitionTicket(ticketId, 'blocked', {
        actor: 'router',
        executor: 'advisor',
        waitingOn: 'environment',
        blockedReason: 'Advisor 不可用：' + failure,
        reason: 'could not resume the Advisor',
      })
      if (blocked.ok) this.v2.setTicketMeta(ticketId, { phase: 'blocked' })
      return { ok: false, code: 'advisor_unavailable', message: failure, ticketId }
    }
  }

  /**
   * Re-dispatch an open ticket that already has a WorkOrder. This is the only
   * recovery path for resume, and it is exhaustive: a successful dispatch ends
   * working, a Worker still busy on the same ticket is re-armed to working, and
   * every other failure ends blocked with a durable failure record instead of
   * leaving the ticket silently open/planned.
   */
  async redispatch(ticketId, options = {}) {
    const ticket = this.service.store.ticket(ticketId)
    if (!ticket) return { ok: false, code: 'ticket_missing', message: 'ticket not found: ' + ticketId, ticketId }
    if (ticket.status !== 'open') return { ok: false, code: 'ticket_not_open', message: 'ticket is ' + ticket.status, ticketId }
    const workOrder = this.v2.workOrder(ticketId)
    if (!workOrder) return { ok: false, code: 'work_order_missing', message: 'call ticket_plan first', ticketId }
    const meta = this.v2.ticketMeta(ticketId)
    const workerId = text(options.workerId) || text(meta.workerId)
    const message = text(options.message)
    const by = text(options.by)
    let dispatched = await this.tryDispatch(ticketId, workerId, message)
    // The same Worker can still be running a turn for this very ticket (it was
    // parked by the 60s confirmation sweep, not by the Worker). Do not create a
    // replacement Worker: re-arm the ticket and queue the user's reply.
    if (!dispatched.ok && dispatched.code === 'worker_busy' && workerId) {
      const worker = this.v2.worker(workerId)
      if (worker && String(worker.currentTicketId || '') === ticketId) {
        return await this.rearmWorkingTicket(ticketId, workerId, message, by)
      }
    }
    if (!dispatched.ok && ['worker_busy', 'worker_missing', 'worker_workspace_mismatch', 'worker_unavailable'].includes(dispatched.code)) {
      // Fall back to a fresh managed Worker; the user's answer travels with the
      // first dispatch so it cannot land in the old Worker's inbox.
      dispatched = await this.tryDispatch(ticketId, '', message)
    }
    if (dispatched.ok) {
      if (message) this.addManagerInbox(ticketId, dispatched.workerSessionId, message, by)
      return { ok: true, ticketId, status: 'working', workerSessionId: dispatched.workerSessionId, redispatch: true }
    }
    // dispatchTicket's prompt failure already parks the ticket as blocked.
    if (dispatched.code === 'dispatch_failed') return dispatched
    return await this.blockRedispatch(ticketId, dispatched, { workerId, by })
  }

  async tryDispatch(ticketId, workerId, message) {
    try {
      return await this.dispatchTicket(ticketId, workerId, message)
    } catch (error) {
      return { ok: false, code: 'dispatch_failed', message: String(error && error.message ? error.message : error), ticketId }
    }
  }

  addManagerInbox(ticketId, workerId, message, by) {
    this.v2.addInbox({
      id: newId('inbox_'),
      ticketId,
      workerId,
      message,
      from: 'chatbot',
      by,
      at: now(),
    })
  }

  async rearmWorkingTicket(ticketId, workerId, message, by) {
    const ticket = this.service.store.ticket(ticketId)
    if (!ticket) return { ok: false, code: 'ticket_missing', message: 'ticket not found: ' + ticketId, ticketId }
    const moved = this.service.store.transitionTicket(ticketId, 'working', {
      actor: 'router',
      executor: workerId,
      waitingOn: 'worker',
      // The Worker is demonstrably executing this ticket, so the attempt is
      // confirmed even though no new prompt is sent.
      attempt: { confirmedAt: now(), rearmedAt: now() },
      reason: 'worker is still running this ticket; resumed without a new dispatch',
    })
    if (!moved.ok) {
      return await this.blockRedispatch(ticketId, { code: moved.code || 'dispatch_failed', message: moved.message }, { workerId, by })
    }
    this.v2.setTicketMeta(ticketId, { phase: 'working', workerId })
    this.v2.addWorker(workerId, { status: 'working', currentTicketId: ticketId, lastUsedAt: now() })
    if (message) {
      this.addManagerInbox(ticketId, workerId, message, by)
      try {
        await this.promptSession(workerId, '[Manager resume]\n' + message, 'queue')
      } catch (error) {
        // The inbox copy is durable; a failed wake only means the Worker reads
        // it at its next checkpoint.
        this.log('warn', 'could not wake ' + workerId + ' after re-arm: ' + String(error && error.message ? error.message : error))
      }
    }
    return {
      ok: true,
      ticketId,
      status: 'working',
      waitingOn: 'worker',
      workerSessionId: workerId,
      rearmed: true,
      message: 'Worker 仍在执行这张 ticket；已恢复为 working 并把回复排入其队列。',
    }
  }

  async blockRedispatch(ticketId, failure, options = {}) {
    const message = text(failure && failure.message) || '重新派发失败'
    const reason = '重新派发失败：' + message
    const ticket = this.service.store.ticket(ticketId)
    if (ticket && ticket.status === 'open') {
      const moved = this.service.store.transitionTicket(ticketId, 'blocked', {
        actor: 'router',
        executor: text(options.workerId) || ticket.executor || 'advisor',
        waitingOn: 'environment',
        blockedReason: reason,
        failure: { code: 'dispatch_failed', message, at: now() },
        reason: 'redispatch failed',
      })
      if (moved.ok) {
        this.v2.setTicketMeta(ticketId, { phase: 'blocked' })
        await this.notifyChatbot('ticket ' + ticketId + ' 重新派发失败，已暂停：' + message + '（检查 Worker/环境后用 chatbot_resume 重试）')
      } else {
        this.log('warn', 'could not block ticket ' + ticketId + ' after failed redispatch: ' + moved.code + ' ' + moved.message)
      }
    }
    const current = this.service.store.ticket(ticketId)
    return {
      ok: false,
      code: 'dispatch_failed',
      cause: text(failure && failure.code) || 'dispatch_failed',
      message,
      ticketId,
      status: current ? current.status : undefined,
      waitingOn: 'environment',
    }
  }

  advisorCaller(exec) {
    return this.roleFor(exec && exec.agent ? exec.agent.id : '') === 'advisor'
  }

  /** Only a managed Worker of type reflection may use the retrospective tools. */
  reflectionCaller(exec) {
    const sessionId = String(exec && exec.agent && exec.agent.id !== undefined ? exec.agent.id : '')
    if (!sessionId || this.roleFor(sessionId) !== 'worker') return false
    const worker = this.v2.worker(sessionId)
    return Boolean(worker && worker.workerType === 'reflection')
  }

  workerCaller(exec) {
    return this.roleFor(exec && exec.agent ? exec.agent.id : '') === 'worker'
  }

  async ticketRead(args, exec) {
    if (!this.advisorCaller(exec)) return { ok: false, code: 'forbidden', message: 'only an Advisor may read tickets' }
    const ticketId = text(args.ticketId)
    const ticket = this.service.store.knownTicket(ticketId)
    if (!ticket) return { ok: false, code: 'ticket_missing', message: 'ticket not found: ' + ticketId }
    return { ok: true, ...this.ticketBundle(ticket) }
  }

  async ticketPlan(args, exec) {
    if (!this.advisorCaller(exec)) return { ok: false, code: 'forbidden', message: 'only an Advisor may plan' }
    const ticketId = text(args.ticketId)
    const ticket = this.service.store.ticket(ticketId)
    if (!ticket) return { ok: false, code: 'ticket_missing', message: 'ticket not found: ' + ticketId }
    if (ticket.status !== 'open') return { ok: false, code: 'ticket_not_open', message: 'ticket is ' + ticket.status }
    const summary = text(args.summary)
    if (!summary) return { ok: false, code: 'summary_required', message: 'summary must not be empty' }
    const workOrder = {
      ticketId,
      summary,
      steps: arrayOfText(args.steps),
      acceptance: text(args.acceptance) || ticket.acceptance,
      artifacts: arrayOfText(args.artifacts),
      notes: text(args.notes),
      by: String(exec.agent.id),
      createdAt: now(),
    }
    this.v2.setWorkOrder(ticketId, workOrder)
    this.v2.setTicketMeta(ticketId, { phase: 'planned' })
    return { ok: true, ticketId, workOrder }
  }

  async ticketDispatch(args, exec) {
    if (!this.advisorCaller(exec)) return { ok: false, code: 'forbidden', message: 'only an Advisor may dispatch' }
    const ticketId = text(args.ticketId)
    if (!ticketId) return { ok: false, code: 'invalid_input', message: 'ticketId is required' }
    return await this.dispatchTicket(ticketId, text(args.workerSessionId))
  }

  async dispatchTicket(ticketId, requestedWorkerId, managerNote = '') {
    const ticket = this.service.store.ticket(ticketId)
    if (!ticket) return { ok: false, code: 'ticket_missing', message: 'ticket not found: ' + ticketId }
    if (ticket.status !== 'open') return { ok: false, code: 'ticket_not_open', message: 'ticket is ' + ticket.status }
    const workOrder = this.v2.workOrder(ticketId)
    if (!workOrder) return { ok: false, code: 'work_order_missing', message: 'call ticket_plan first' }
    const meta = this.v2.ticketMeta(ticketId)
    // reflection tickets go to a reflection Worker, everything else to a work
    // Worker. The two kinds are not interchangeable.
    const reflection = meta.mode === 'reflection'
    const wantedKind = reflection ? 'reflection' : 'work'
    let worker
    try {
      const requested = text(requestedWorkerId)
      if (requested) {
        const existing = this.v2.worker(requested)
        if (!existing) return { ok: false, code: 'worker_missing', message: 'worker not found: ' + requested }
        const actualKind = existing.workerType === 'reflection' ? 'reflection' : 'work'
        if (actualKind !== wantedKind) {
          return {
            ok: false,
            code: 'worker_kind_mismatch',
            message: 'worker ' + requested + ' is a ' + actualKind + ' worker; this ticket needs a ' + wantedKind + ' worker',
          }
        }
        // A work Worker's cwd is fixed at creation and is its sandbox boundary.
        // Do not hand a project ticket to a Worker rooted in another directory.
        // Reflection Workers are rooted in the state directory by design.
        if (!reflection && (meta.projectCwd ? existing.cwd !== meta.projectCwd : existing.projectCwd)) {
          return { ok: false, code: 'worker_workspace_mismatch', message: 'worker ' + requested + ' is rooted at ' + String(existing.cwd) }
        }
        if (existing.currentTicketId && existing.currentTicketId !== ticketId) {
          return { ok: false, code: 'worker_busy', message: 'worker is running ' + existing.currentTicketId }
        }
        if (existing.status !== 'idle') return { ok: false, code: 'worker_busy', message: 'worker is ' + existing.status }
        const resolved = await this.service.resolve(requested)
        if ('error' in resolved) return { ok: false, code: 'worker_missing', message: resolved.error.message }
        this.install(resolved.agent, 'worker')
        worker = { sessionId: requested, meta: existing }
      } else if (reflection) {
        worker = await this.ensureReflectionWorker('global')
      } else {
        worker = await this.ensureWorker(meta.scope || 'global', meta.projectId || null, meta.projectCwd || undefined)
      }
    } catch (error) {
      const message = String(error && error.message ? error.message : error)
      return { ok: false, code: 'worker_unavailable', message }
    }
    const requestId = HOST_REQUEST_PREFIX + randomUUID()
    const moved = this.service.store.transitionTicket(ticketId, 'working', {
      actor: 'router',
      executor: worker.sessionId,
      waitingOn: 'worker',
      attempt: { count: (ticket.attempt && ticket.attempt.count ? ticket.attempt.count : 0) + 1, lastRequestId: requestId, startedAt: now(), legacy: false },
      reason: 'dispatched to managed worker',
    })
    if (!moved.ok) return { ok: false, code: moved.code, message: moved.message, ticketId }
    this.v2.setTicketMeta(ticketId, { phase: 'working', workerId: worker.sessionId })
    this.v2.addWorker(worker.sessionId, { status: 'working', currentTicketId: ticketId, lastUsedAt: now() })
    try {
      const note = text(managerNote)
      const brief = workerBrief(moved.ticket, workOrder, this.v2.worker(worker.sessionId) || {})
      await this.promptSession(worker.sessionId, note ? brief + '\n\n[用户回复]\n' + note : brief, 'queue', requestId)
      return { ok: true, ticketId, workerSessionId: worker.sessionId, status: 'working' }
    } catch (error) {
      const message = String(error && error.message ? error.message : error)
      this.service.store.transitionTicket(ticketId, 'blocked', {
        actor: 'router',
        executor: worker.sessionId,
        waitingOn: 'environment',
        blockedReason: 'Worker 派发失败：' + message,
        reason: 'dispatch prompt failed',
      })
      this.v2.setTicketMeta(ticketId, { phase: 'blocked' })
      this.v2.addWorker(worker.sessionId, { status: 'idle', currentTicketId: null })
      return { ok: false, code: 'dispatch_failed', message, ticketId }
    }
  }

  async ticketBlock(args, exec) {
    if (!this.advisorCaller(exec)) return { ok: false, code: 'forbidden', message: 'only an Advisor may block a ticket' }
    const ticketId = text(args.ticketId)
    const ticket = this.service.store.ticket(ticketId)
    if (!ticket) return { ok: false, code: 'ticket_missing', message: 'ticket not found: ' + ticketId }
    if (ticket.status !== 'open') return { ok: false, code: 'ticket_not_open', message: 'ticket is ' + ticket.status }
    const reason = text(args.reason)
    if (!reason) return { ok: false, code: 'reason_required', message: 'reason must not be empty' }
    const question = text(args.question) || reason
    const moved = this.service.store.transitionTicket(ticketId, 'blocked', {
      actor: 'advisor',
      executor: 'advisor',
      waitingOn: 'user',
      blockedReason: reason,
      attention: { kind: 'question', question },
      reason: 'waiting on the user',
    })
    if (!moved.ok) return { ok: false, code: moved.code, message: moved.message }
    this.v2.setTicketMeta(ticketId, { phase: 'blocked' })
    await this.notifyChatbot('ticket ' + ticketId + ' 需要你确认：' + question + '（答复后用 chatbot_resume 继续）')
    return { ok: true, ticketId, status: 'blocked' }
  }

  /**
   * Research/knowledge path: the Advisor investigated read-only and answers the
   * user directly. The ticket goes open -> done in one atomic transition, so no
   * WorkOrder and no Worker are ever created for it.
   */
  async ticketAnswer(args, exec) {
    if (!this.advisorCaller(exec)) return { ok: false, code: 'forbidden', message: 'only an Advisor may answer a ticket' }
    const ticketId = text(args.ticketId)
    if (!ticketId) return { ok: false, code: 'invalid_input', message: 'ticketId is required' }
    const ticket = this.service.store.ticket(ticketId)
    if (!ticket) return { ok: false, code: 'ticket_missing', message: 'ticket not found: ' + ticketId }
    if (ticket.status === 'working') return { ok: false, code: 'ticket_not_open', message: 'ticket is working; wait for the Worker or block it first' }
    if (ticket.status === 'blocked') return { ok: false, code: 'ticket_blocked', message: 'ticket is blocked; resume it before answering' }
    if (ticket.status === 'done') return { ok: false, code: 'ticket_done', message: 'ticket is already done' }
    if (ticket.status !== 'open') return { ok: false, code: 'ticket_closed', message: 'ticket is ' + ticket.status }
    const raw = text(args.answer)
    if (!raw) return { ok: false, code: 'answer_required', message: 'answer must not be empty' }
    const limit = 4000
    const truncated = raw.length > limit
    const answer = truncated ? raw.slice(0, limit) : raw
    const summary = text(args.summary) || clip(answer, 200)
    const evidence = arrayOfText(args.evidence)
    const moved = this.service.store.transitionTicket(ticketId, 'done', {
      actor: 'advisor',
      executor: 'advisor',
      resolution: { kind: 'answered', summary, answer, evidence, by: 'advisor' },
      reason: 'answered directly by Advisor',
    })
    if (!moved.ok) return { ok: false, code: moved.code, message: moved.message, ticketId }
    this.v2.setTicketMeta(ticketId, { phase: 'done' })
    await this.notifyChatbot('ticket ' + ticketId + ' 已答复：' + clip(answer, 1200) + '\n请把结论转述给用户。')
    return { ok: true, ticketId, status: 'done', truncated, summary }
  }

  // Read-only session search for retrospective review. It reads the same
  // SessionSummary rows the host lists and the title projection, then filters
  // in memory. No prompt/append/update call is made anywhere in this path.
  async sessionList(args, exec) {
    if (!this.reflectionCaller(exec)) return { ok: false, code: 'forbidden', message: 'only a reflection Worker may list sessions' }
    const limit = Number.isSafeInteger(args.limit) ? Math.max(1, Math.min(50, args.limit)) : 20
    const updatedAfter = parseTimeArg(args.updatedAfter)
    const updatedBefore = parseTimeArg(args.updatedBefore)
    if (updatedAfter === null || updatedBefore === null) {
      return { ok: false, code: 'invalid_time', message: 'updatedAfter/updatedBefore must be epoch milliseconds or an ISO 8601 timestamp' }
    }
    if (updatedAfter !== undefined && updatedBefore !== undefined && updatedAfter > updatedBefore) {
      return { ok: false, code: 'invalid_range', message: 'updatedAfter must not be later than updatedBefore' }
    }
    let listed
    try {
      listed = await this.ctx.sessionController.list({})
    } catch (error) {
      return { ok: false, code: 'list_failed', message: String(error && error.message ? error.message : error) }
    }
    const archived = this.archivedSessionIds()
    const idPrefix = text(args.idPrefix).toLowerCase()
    const titleContains = text(args.titleContains).toLowerCase()
    const cwdContains = text(args.cwdContains).toLowerCase()
    const includeSubagents = args.includeSubagents === true
    const includeArchived = args.includeArchived !== false
    const candidates = []
    for (const item of Array.isArray(listed && listed.items) ? listed.items : []) {
      if (!item || !item.sessionId) continue
      const sessionId = String(item.sessionId)
      if (!includeSubagents && (item.origin === 'subagent' || item.parentSessionId)) continue
      const archivedFlag = archived.has(sessionId)
      if (!includeArchived && archivedFlag) continue
      if (idPrefix && !sessionId.toLowerCase().startsWith(idPrefix)) continue
      const cwd = text(item.cwd)
      if (cwdContains && !cwd.toLowerCase().includes(cwdContains)) continue
      const updatedAt = Number(item.updatedAt)
      if (updatedAfter !== undefined && !(updatedAt >= updatedAfter)) continue
      if (updatedBefore !== undefined && !(updatedAt <= updatedBefore)) continue
      if (typeof args.running === 'boolean' && Boolean(item.running) !== args.running) continue
      const agentAvailable = item.agentAvailable !== false
      if (typeof args.agentAvailable === 'boolean' && agentAvailable !== args.agentAvailable) continue
      candidates.push({ item, sessionId, cwd, archived: archivedFlag, agentAvailable })
    }
    // Only fetch titles for rows that already passed the cheap filters. A
    // projection read is read-only and never activates the session.
    const titled = await Promise.all(candidates.map(async entry => {
      let title = ''
      try { title = await this.sessionTitle(entry.item) } catch { title = '' }
      return { ...entry, title }
    }))
    const rows = []
    for (const entry of titled) {
      if (titleContains && !entry.title.toLowerCase().includes(titleContains)) continue
      const updatedAt = Number(entry.item.updatedAt)
      rows.push({
        sessionId: entry.sessionId,
        title: clipText(redactSecrets(entry.title), 300),
        cwd: clipText(redactSecrets(entry.cwd), 300),
        updatedAt: Number.isFinite(updatedAt) ? updatedAt : 0,
        running: Boolean(entry.item.running),
        agentAvailable: entry.agentAvailable,
        blank: Boolean(entry.item.blank),
        parentSessionId: entry.item.parentSessionId ? String(entry.item.parentSessionId) : null,
        origin: entry.item.origin === 'subagent' ? 'subagent' : null,
        archived: entry.archived,
      })
    }
    rows.sort((a, b) => b.updatedAt - a.updatedAt || a.sessionId.localeCompare(b.sessionId))
    const total = rows.length
    return { ok: true, sessions: rows.slice(0, limit), total, truncated: total > limit }
  }

  // Read-only event-log review. Only sessionController.list/events/state are
  // used: never prompt, append, updateQueue, rename, or any permission write.
  //
  // The log is read backwards in bounded pages. Each page has at most
  // min(200, limit*2) raw records, at most 10 pages are fetched, and the loop
  // stops as soon as limit matching events are collected, so a huge
  // session.v4 log is never materialised into the model context.
  async sessionEvents(args, exec) {
    if (!this.reflectionCaller(exec)) return { ok: false, code: 'forbidden', message: 'only a reflection Worker may read session events' }
    const query = text(args.sessionId)
    if (!query) return { ok: false, code: 'session_required', message: 'sessionId is required' }
    const limit = Number.isSafeInteger(args.limit) ? Math.max(1, Math.min(200, args.limit)) : 50
    const summaryChars = Number.isSafeInteger(args.summaryChars) ? Math.max(1, Math.min(300, args.summaryChars)) : 160
    const fromSeq = Number.isSafeInteger(args.fromSeq) ? Math.max(0, args.fromSeq) : undefined
    const toSeqArg = Number.isSafeInteger(args.toSeq) ? Math.max(0, args.toSeq) : undefined
    const fromTime = parseTimeArg(args.fromTime)
    const toTime = parseTimeArg(args.toTime)
    if (fromTime === null || toTime === null) {
      return { ok: false, code: 'invalid_time', message: 'fromTime/toTime must be epoch milliseconds or an ISO 8601 timestamp' }
    }
    if (fromTime !== undefined && toTime !== undefined && fromTime > toTime) {
      return { ok: false, code: 'invalid_range', message: 'fromTime must not be later than toTime' }
    }
    if (fromSeq !== undefined && toSeqArg !== undefined && fromSeq > toSeqArg) {
      return { ok: false, code: 'invalid_range', message: 'fromSeq must not be greater than toSeq' }
    }
    const patterns = arrayOfText(args.types)
    const keepType = patterns.length
      ? type => eventTypeMatches(type, patterns)
      : type => REVIEW_EVENT_TYPES.includes(type) || /error/i.test(type)

    let listed
    try {
      listed = await this.ctx.sessionController.list({})
    } catch (error) {
      return { ok: false, code: 'list_failed', message: String(error && error.message ? error.message : error) }
    }
    const items = Array.isArray(listed && listed.items) ? listed.items : []
    const wanted = query.toLowerCase()
    let resolved = items.find(item => String(item && item.sessionId ? item.sessionId : '').toLowerCase() === wanted)
    if (!resolved) {
      const matches = items.filter(item => String(item && item.sessionId ? item.sessionId : '').toLowerCase().startsWith(wanted))
      if (matches.length === 0) {
        return { ok: false, code: 'session_not_found', message: 'no session id starts with: ' + query }
      }
      if (matches.length > 1) {
        const candidates = await Promise.all(matches.slice(0, 5).map(async item => ({
          sessionId: String(item.sessionId),
          title: clipText(redactSecrets(await this.sessionTitle(item)), 160),
        })))
        return { ok: false, code: 'session_ambiguous', message: 'session id prefix matches more than one session', candidates }
      }
      resolved = matches[0]
    }
    const sessionId = String(resolved.sessionId)

    let endCursor = toSeqArg
    if (endCursor === undefined) {
      try {
        const state = await this.ctx.sessionController.state({ sessionId }, new AbortController().signal)
        endCursor = Number.isSafeInteger(state && state.cursor) ? state.cursor : undefined
      } catch (error) {
        return { ok: false, code: 'session_unavailable', sessionId, message: String(error && error.message ? error.message : error) }
      }
    }
    if (endCursor === undefined) {
      return { ok: false, code: 'events_unavailable', sessionId, message: 'session has no readable event cursor' }
    }

    const pageSize = Math.min(200, Math.max(1, limit * 2))
    const maxPages = 10
    const events = []
    let scanned = 0
    let pages = 0
    let throughSeq = endCursor
    let more = false
    let exhausted = false
    while (events.length < limit && pages < maxPages && !exhausted) {
      pages += 1
      let page
      try {
        page = await this.ctx.sessionController.events({
          address: { kind: 'session', sessionId },
          throughSeq,
          maxMessages: pageSize,
        }, new AbortController().signal)
      } catch (error) {
        return {
          ok: false,
          code: 'read_failed',
          sessionId,
          message: String(error && error.message ? error.message : error),
          events,
          count: events.length,
          scanned,
          truncated: false,
          more,
          nextThroughSeq: null,
        }
      }
      const records = Array.isArray(page && page.records) ? page.records : []
      if (records.length === 0) { exhausted = true; break }
      const normalized = []
      for (const record of records) {
        const event = eventOf(record)
        if (event) normalized.push(event)
      }
      if (normalized.length === 0) { exhausted = true; break }
      // Newest first: the caller reads the tail of the log.
      normalized.sort((a, b) => {
        const left = Number.isSafeInteger(a.seq) ? a.seq : 0
        const right = Number.isSafeInteger(b.seq) ? b.seq : 0
        return right - left
      })
      let minSeq
      for (const event of normalized) {
        // Stop before examining the next (older) record. nextThroughSeq must
        // point at the first record not yet returned; scanning the whole page
        // after a mid-page limit would skip the records between the last
        // returned event and the page tail.
        if (events.length >= limit) break
        scanned += 1
        const seq = Number.isSafeInteger(event.seq) ? event.seq : undefined
        if (seq !== undefined && (minSeq === undefined || seq < minSeq)) minSeq = seq
        const type = String(event && event.type ? event.type : '')
        if (!keepType(type)) continue
        if (seq !== undefined && fromSeq !== undefined && seq < fromSeq) continue
        if (seq !== undefined && toSeqArg !== undefined && seq > toSeqArg) continue
        const time = eventTimeOf(event)
        if (time !== undefined) {
          if (fromTime !== undefined && time < fromTime) continue
          if (toTime !== undefined && time > toTime) continue
        }
        events.push({
          seq: seq === undefined ? null : seq,
          type,
          time: time === undefined ? null : time,
          summary: eventSummary(event, summaryChars),
        })
      }
      const pageMore = Boolean(page && page.hasMore)
      const nextThroughSeq = minSeq !== undefined ? minSeq - 1 : throughSeq
      if (events.length >= limit || pageMore) more = true
      if (events.length < limit && !pageMore) exhausted = true
      if (nextThroughSeq < 0 || nextThroughSeq === throughSeq) {
        if (nextThroughSeq < 0) more = false
        exhausted = true
        break
      }
      throughSeq = nextThroughSeq
    }
    if (pages >= maxPages && events.length < limit) more = true
    return {
      ok: true,
      sessionId,
      events,
      count: events.length,
      scanned,
      truncated: more,
      more,
      nextThroughSeq: more && throughSeq >= 0 ? throughSeq : null,
      note: 'read-only',
    }
  }

  async workerReport(args, exec) {
    if (!this.workerCaller(exec)) return { ok: false, code: 'forbidden', message: 'only a Worker may report' }
    const ticketId = text(args.ticketId)
    const ticket = this.service.store.ticket(ticketId)
    if (!ticket) return { ok: false, code: 'ticket_missing', message: 'ticket not found: ' + ticketId }
    const workerId = String(exec.agent.id)
    if (String(ticket.executor) !== workerId) return { ok: false, code: 'not_executor', message: 'ticket is assigned to ' + String(ticket.executor) }
    const status = text(args.status)
    if (!['progress', 'blocked', 'done', 'failed'].includes(status)) return { ok: false, code: 'invalid_status', message: 'invalid report status' }
    // A ticket parked on an approval still accepts reports: the Worker is alive,
    // it is only waiting. Every other non-working status is refused.
    const approvalBlocked = ticket.status === 'blocked' && ticket.waitingOn === 'approval'
    if (ticket.status !== 'working' && !approvalBlocked) return { ok: false, code: 'ticket_not_working', message: 'ticket is ' + ticket.status }
    const summary = text(args.summary)
    const evidence = arrayOfText(args.evidence)
    const question = text(args.question)
    if (!summary && status !== 'blocked') return { ok: false, code: 'summary_required', message: 'summary must not be empty' }
    if (status === 'blocked' && !summary && !question) return { ok: false, code: 'question_required', message: 'blocked requires summary or question' }
    if (status === 'done' && !summary) return { ok: false, code: 'summary_required', message: 'done requires a summary' }
    if (status === 'done' && evidence.length === 0) return { ok: false, code: 'evidence_required', message: 'done requires evidence: a file, command, diff, or observed result' }
    const report = {
      reportId: newId('report_'),
      ticketId,
      workerId,
      status,
      summary,
      evidence,
      question,
      next: text(args.next),
      at: now(),
    }
    this.v2.addReport(report)
    // A worker that can report has certainly begun executing. Confirm while the
    // ticket is still working (before any status branch transitions it), so the
    // 60s sweep can never park a ticket that is demonstrably alive.
    const attempt = ticket.attempt
    if (!approvalBlocked && attempt && attempt.lastRequestId && !attempt.confirmedAt) {
      try {
        this.service.store.confirmDispatchAttempt(ticketId, attempt.lastRequestId)
      } catch (error) {
        this.log('warn', 'could not confirm dispatch for ' + ticketId + ' from worker report: ' + String(error && error.message ? error.message : error))
      }
    }
    if (approvalBlocked) return this.approvalBlockedReport(ticket, { status, summary, question, report })
    if (status === 'progress') {
      this.service.store.updateTicket(ticketId, { progress: { lastPhase: summary.slice(0, 200), lastEventAt: now() } })
      return { ok: true, ticketId, status, report }
    }
    if (status === 'blocked') {
      const moved = this.service.store.transitionTicket(ticketId, 'blocked', {
        actor: 'worker',
        executor: workerId,
        waitingOn: 'user',
        blockedReason: summary || question,
        attention: { kind: 'question', question: question || summary },
        reason: 'worker needs the user',
      })
      if (!moved.ok) return { ok: false, code: moved.code, message: moved.message }
      this.v2.setTicketMeta(ticketId, { phase: 'blocked' })
      this.v2.addWorker(workerId, { status: 'idle', currentTicketId: null })
      await this.notifyChatbot('ticket ' + ticketId + ' 被 Worker 暂停，需要你回答：' + (question || summary) + '（答复后用 chatbot_resume 继续）')
      return { ok: true, ticketId, status: 'blocked', report }
    }
    if (status === 'done') {
      const moved = this.service.store.transitionTicket(ticketId, 'done', {
        actor: 'worker',
        executor: workerId,
        resolution: { kind: 'done', summary, evidence },
        reason: 'worker reported done',
      })
      if (!moved.ok) return { ok: false, code: moved.code, message: moved.message }
      try { await this.service.grants.onTicketChanged(moved.ticket) } catch (error) {
        this.log('warn', 'could not restore grants for ' + ticketId + ': ' + String(error && error.message ? error.message : error))
      }
      this.v2.setTicketMeta(ticketId, { phase: 'done' })
      this.v2.addWorker(workerId, { status: 'idle', currentTicketId: null, lastUsedAt: now() })
      await this.notifyChatbot('ticket ' + ticketId + ' 已完成：' + summary + (evidence.length ? '\n证据：' + evidence.join('; ') : ''))
      return { ok: true, ticketId, status: 'done', report }
    }
    const moved = this.service.store.transitionTicket(ticketId, 'failed', {
      actor: 'worker',
      executor: workerId,
      failure: { code: 'worker_failed', message: summary },
      reason: 'worker reported failure',
    })
    if (!moved.ok) return { ok: false, code: moved.code, message: moved.message }
    this.v2.setTicketMeta(ticketId, { phase: 'failed' })
    this.v2.addWorker(workerId, { status: 'idle', currentTicketId: null })
    await this.notifyChatbot('ticket ' + ticketId + ' 失败了：' + summary)
    return { ok: true, ticketId, status: 'failed', report }
  }

  /**
   * A report that arrives while the ticket is parked on an approval. The Worker
   * is alive, so progress is kept; a `done` is refused, because the approval —
   * not the Worker — is what has to settle first. This is also the budget
   * exhaustion path: the host cancels the approval and the Worker may still try
   * to close the ticket afterwards.
   */
  approvalBlockedReport(ticket, { status, summary, question, report }) {
    const ticketId = ticket.ticketId
    if (status === 'progress') {
      this.service.store.updateTicket(ticketId, { progress: { lastPhase: summary.slice(0, 200), lastEventAt: now() } })
      return { ok: true, ticketId, status: 'blocked', approvalPending: true, report }
    }
    if (status === 'blocked') {
      // Already parked on the approval; its attention outranks a new question.
      return { ok: true, ticketId, status: 'blocked', approvalPending: true, report }
    }
    const code = status === 'done' ? 'approval_timeout' : 'approval_unresolved'
    const message = status === 'done'
      ? 'worker reported done while blocked on approval; the approval never settled'
      : 'worker reported ' + status + ' while blocked on approval: ' + (summary || question || 'no reason')
    try {
      this.service.store.updateTicket(ticketId, { failure: { code, message, at: now() } })
    } catch (error) {
      this.log('warn', 'could not record ' + code + ' on ' + ticketId + ': ' + String(error && error.message ? error.message : error))
    }
    this.queueChatbotNotice('ticket ' + ticketId + ' 因审批未决被取消/超时，Worker 的 ' + status + ' 未被接受（' + code + '）；请处理后用 chatbot_resume 继续。')
    return { ok: false, code, status: 'blocked', ticketId, approvalPending: true, report }
  }

  async workerCheckpoint(args, exec) {
    if (!this.workerCaller(exec)) return { ok: false, code: 'forbidden', message: 'only a Worker may checkpoint' }
    const ticketId = text(args.ticketId)
    const ticket = this.service.store.ticket(ticketId)
    if (!ticket) return { ok: false, code: 'ticket_missing', message: 'ticket not found: ' + ticketId }
    const workerId = String(exec.agent.id)
    if (String(ticket.executor) !== workerId) return { ok: false, code: 'not_executor', message: 'ticket is assigned to ' + String(ticket.executor) }
    const meta = this.v2.data.tickets[ticketId] || {}
    const inbox = this.v2.pendingInbox(ticketId, workerId)
    this.v2.markInboxDelivered(inbox.map(item => item.id))
    const worker = this.v2.worker(workerId) || {}
    return {
      ok: true,
      ticket: this.ticketView(ticket),
      workOrder: this.v2.workOrder(ticketId),
      reports: this.v2.reportsFor(ticketId, 10),
      messages: inbox.map(item => ({ id: item.id, from: item.from, message: item.message, at: item.at })),
      cwd: worker.cwd || null,
      artifactDir: worker.artifactDir || (meta.artifactDir || null),
      manager: meta.phase === 'blocked' ? 'ticket is blocked; wait for a new steer' : 'continue the current milestone',
    }
  }

  status() {
    const tickets = this.v2.ticketMetas()
      .map(meta => {
        const ticket = this.service.store.ticket(meta.ticketId)
        if (!ticket) return null
        return {
          ticketId: ticket.ticketId,
          status: ticket.status,
          waitingOn: ticket.waitingOn || null,
          executor: ticket.executor || null,
          scope: meta.scope || 'global',
          projectId: meta.projectId || null,
          phase: meta.phase || null,
          workerId: meta.workerId || null,
        }
      })
      .filter(Boolean)
    return {
      chatbotSessionId: this.v2.chatbotSessionId,
      advisors: this.v2.advisors(),
      workers: this.v2.workers(),
      tickets,
      direct: this.directInfo(),
      lastError: this.v2.data.lastError || null,
    }
  }

  /**
   * Tell every connected channel that this Ria process restarted. Channels log
   * in asynchronously, so retry for a minute instead of racing the first tick;
   * each channel gets at most one notice per process.
   */
  notifyRestart() {
    const message = 'Ria 已重启，服务已恢复。可以直接继续对话。'
    const channels = [
      ['wechat-claw', this.service.wechatClaw],
      ['wechat', this.service.wechat],
      ['qq-bot', this.service.qqBot],
    ]
    const done = new Set()
    const delays = [0, 5000, 15000, 30000, 60000]
    const attempt = async index => {
      for (const [name, service] of channels) {
        if (done.has(name) || !service || typeof service.statusView !== 'function') continue
        let status
        try {
          status = service.statusView()
        } catch (error) {
          this.log('warn', 'restart notice could not read ' + name + ' status: ' + String(error && error.message ? error.message : error))
          continue
        }
        if (!status || !status.loggedIn) continue
        try {
          // A restart notice is a system line: deliver it even if the user had
          // paused ordinary outbound messages.
          const sent = typeof service.sendPauseNotice === 'function'
            ? await service.sendPauseNotice(message, { durable: false })
            : false
          // Claw's enqueue resolves with undefined on success, while the other
          // channels return true; only false or a deferred marker means retry.
          if (sent !== false && !(sent && sent.deferred)) {
            done.add(name)
            this.log('info', 'restart notice sent via ' + name)
          }
        } catch (error) {
          this.log('warn', 'restart notice failed on ' + name + ': ' + String(error && error.message ? error.message : error))
        }
      }
      const next = index + 1
      if (next < delays.length && done.size < channels.length) {
        const timer = setTimeout(() => { void attempt(next) }, delays[next])
        if (timer.unref) timer.unref()
      }
    }
    void attempt(0)
  }

  /**
   * Old builds queued direct-mode replies (including “[tool run_code]”) as
   * durable fallbacks. After a reconnect those arrive as a burst of “补发”.
   * Direct mode is live-only, so drop any such backlog before anything pumps.
   */
  cleanupDirectBacklog() {
    const removed = this.service.outbox.removeWhere(entry =>
      entry.kind === 'wechat_assistant_note' &&
      entry.status === 'pending' &&
      String(entry.payload && entry.payload.text || '').startsWith('【直通·'))
    if (removed) this.log('info', 'dropped ' + removed + ' stale direct-mode fallback(s)')
    return removed
  }

  async startup() {
    // Direct mode is memory-only by design; a fresh startup is always normal
    // Chatbot mode.
    this.direct = undefined
    this.cleanupDirectBacklog()
    // A grant applied to a Worker must not survive a restart silently. Restore
    // expired/closed grants before any new work starts; failures are retried
    // by GrantService and must not prevent the Chatbot from coming up.
    try {
      await this.service.grants.reconcile()
    } catch (error) {
      this.log('warn', 'grant reconcile on startup failed: ' + String(error && error.message ? error.message : error))
    }
    try {
      await this.ensureChatbot()
    } catch (error) {
      this.v2.recordError('chatbot.startup', error)
      this.log('error', 'Chatbot startup failed: ' + String(error && error.message ? error.message : error))
      return
    }
    for (const meta of this.v2.ticketMetas()) {
      let ticket = this.service.store.ticket(meta.ticketId)
      if (!ticket) continue
      if (ticket.status === 'working') {
        const moved = this.service.store.transitionTicket(ticket.ticketId, 'blocked', {
          actor: 'router',
          executor: ticket.executor,
          waitingOn: 'environment',
          blockedReason: 'Ria 重启中断了这次执行',
          reason: 'startup recovery',
        })
        if (moved.ok) {
          this.v2.setTicketMeta(ticket.ticketId, { phase: 'blocked' })
          if (ticket.executor && ticket.executor !== 'self' && ticket.executor !== 'advisor') {
            this.v2.addWorker(ticket.executor, { status: 'idle', currentTicketId: null })
          }
          await this.notifyChatbot('ticket ' + ticket.ticketId + ' 因 Ria 重启中断，已暂停；需要你决定是否继续（用 chatbot_resume 继续）。')
        }
        continue
      }
      // A crash between creating the intake ticket and routing it leaves an
      // intake ticket that no one owns. Open it and hand it back to the Advisor.
      if (ticket.status === 'intake' && meta.phase === 'advisor') {
        const opened = this.service.store.transitionTicket(ticket.ticketId, 'open', {
          actor: 'router',
          executor: 'advisor',
          waitingOn: 'ria',
          reason: 'startup recovery: route the intake ticket',
        })
        if (!opened.ok) {
          this.log('warn', 'could not open intake ' + ticket.ticketId + ': ' + opened.message)
          continue
        }
        ticket = opened.ticket
      }
      if (ticket.status === 'open' && (meta.phase === 'advisor' || meta.phase === 'planned')) {
        try {
          const advisor = await this.ensureAdvisor('global')
          const request = meta.requestId ? this.v2.request(meta.requestId) : null
          const workOrder = this.v2.workOrder(ticket.ticketId)
          const lines = ['[Startup] 继续处理这张 ticket。', '', ticketBrief(ticket, request, meta)]
          if (workOrder) lines.push('', workOrderBrief(ticket, workOrder))
          await this.promptSession(advisor.sessionId, lines.join('\n'))
        } catch (error) {
          this.log('warn', 'could not resume ' + ticket.ticketId + ' on startup: ' + String(error && error.message ? error.message : error))
        }
      }
    }
    this.notifyRestart()
  }
}
