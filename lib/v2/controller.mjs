import { createHash, randomUUID } from 'node:crypto'
import { closeSync, createReadStream, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, statSync } from 'node:fs'
import { basename, isAbsolute, join, resolve, sep } from 'node:path'
import { HOST_REQUEST_PREFIX, isHostRequestId } from '../wechat/request-ids.mjs'
import { imageMediaType } from '../wechat/image.mjs'
import {
  sagePrompt,
  SAGE_PRINCIPLES_MAX_CHARS,
  routerNotice,
  clip,
} from './prompts.mjs'
import { V2Store } from './store.mjs'
import { ROLE_CHAT, isChatRole } from './roles.mjs'
import { CO_MANAGED_KIND, acceptsProjectCwd, dispatchBrief, isCoManaged, parseAssistantReport } from './co-managed.mjs'
import {
  MODEL_CATALOG_TTL_MS,
  bundledModelCatalog,
  filterModelCatalog,
  normalizeModelEntry,
} from './model-catalog.mjs'
import { LessonStore } from './lessons.mjs'
import { CoManagement } from './co-management.mjs'
import { CognitionStore, projectKey } from './cognition.mjs'
import { advisorPlanSystemPrompt, buildAdvisorPlanInput, parseAdvisorOutput } from './advisor.mjs'
import { STUCK_LAST_EVENT_MINUTES, STUCK_SESSION_EVENT_MINUTES, computeTicketHealth } from './ticket-health.mjs'
import { createLlmModel } from '../router/llm-model.mjs'
import { CHATBOT_IMAGE_LIMIT, REVIEW_EVENT_TYPES, SENSITIVE_KEY, WORKER_PRESET_WHITELIST, clipText, now, redactSecrets, text } from './shared.mjs'
import { AUTO_TAG_LIMIT, TAG_LIMIT, mergeTags, normalizeTags } from './tags.mjs'
import { topicMatchScore, topicProgressCounts, topicSuggestions } from '../topics.mjs'
import { rankCandidateWorkers, scoreWorker } from './worker-pool.mjs'
import { ToolRegistry } from './tools/registry.mjs'
import {
  ESCALATION_POLICIES,
  PTC_TRANSPORTS,
  classify as classifyRisk,
  decideEscalation,
  normalizeEscalationPolicy,
  parseTransportCall,
  resolveEscalationPolicy,
} from './risk.mjs'

const ACTIVE = new Set(['intake', 'open', 'working', 'blocked', 'forked'])
const TERMINAL = new Set(['done', 'failed', 'cancelled'])
const DEFAULT_WORKER_PRESET = 'ptc'
const CHATBOT_IMAGE_MAX_BYTES = 10 * 1024 * 1024
const CHATBOT_IMAGE_TOTAL_BYTES = 20 * 1024 * 1024
const STEER_MAX_DELIVERY_ATTEMPTS = 2
const INBOX_DELIVERY_MODES = new Set(['immediate', 'pre-step', 'done-retry'])
const WORKER_ROLE_NOTE_LIMIT = 120
// Budget for the whole Chat memory block: heading, disclaimer, digest and
// the truncation marker all count toward it. Counted in JS string units.
const CHATBOT_MEMORY_LIMIT = 1500
const CHATBOT_MEMORY_NOTICE = '以下为长期记忆摘要，可能滞后；细节以 cognition 文件为准'
// Maximum number of pending steering items merged into one pre-step host
// message. A larger backlog is drained at the following step boundaries.
const STEER_PRE_STEP_BATCH_SIZE = 3

/**
 * Canonical title for a role session. Chat/Advisor/Sage are singletons;
 * Workers carry a monotonic sequence that is persisted in v2.json and never
 * reused after a Worker is removed.
 *
 * Chat keeps the user-facing title `Ria`: the role id was renamed from
 * `chatbot`, the session title never changes. Sage's slow-brain session is
 * titled `Sage`. Both spellings of the Chat role id resolve to the same title.
 */
const STANDARD_SESSION_PRESETS = new Set(['standard', 'ptc'])
const SYSTEM_CWD_PREFIXES = ['/etc', '/usr', '/bin', '/sbin', '/boot', '/proc', '/sys', '/dev']

export function roleSessionTitle(kind, seq = 0) {
  const role = kind == null ? '' : String(kind)
  if (role === ROLE_CHAT) return 'Ria'
  if (role === 'advisor') return 'Ria Advisor'
  if (role === 'sage') return 'Sage'
  if (kind === 'reflection') return 'Ria Reflection Worker' + (Number.isSafeInteger(seq) && seq > 0 ? ' ' + seq : '')
  return 'Ria Worker' + (Number.isSafeInteger(seq) && seq > 0 ? ' ' + seq : '')
}


const arrayOfText = value => Array.isArray(value)
  ? value.map(item => text(item)).filter(Boolean)
  : (text(value) ? [text(value)] : [])
const newId = prefix => prefix + randomUUID()


// A message content block can be text, an attachment, or a tool call. Only text
// is useful to the Chat, which cannot open a file itself.
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

/**
 * Ticket kind out of meta. Only 'reflection' changes behaviour; any historical
 * value (including the removed 'answer') reads as a normal work ticket so old
 * state never hits a missing branch.
 */
function ticketKind(meta) {
  return meta && meta.mode === 'reflection' ? 'reflection' : 'work'
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

// DSH appends one turn/end per turn with data.reason:
//   { kind: 'completed' } | { kind: 'blocked' } | { kind: 'max-tokens' }
//   | { kind: 'error', error: { message, code } }
//   | { kind: 'aborted', reason: { kind: 'user' | 'parent' | 'hook' | 'disposed' } }
// Only 'completed' is a normal end. Everything else ended the turn without the
// Worker finishing its ticket, so the ticket must be parked and reported.
function turnEndKind(reason) {
  const kind = reason && typeof reason.kind === 'string' ? reason.kind.trim() : ''
  return kind || 'unknown'
}

function turnEndDetail(reason, kind) {
  if (kind === 'error') {
    const raw = reason ? reason.error : undefined
    const code = raw && typeof raw === 'object' ? text(raw.code) : ''
    const message = raw && typeof raw === 'object' ? text(raw.message) : text(raw)
    return [code, message].filter(Boolean).join(': ') || 'unknown error'
  }
  if (kind === 'aborted') {
    const by = reason && reason.reason && typeof reason.reason === 'object' ? text(reason.reason.kind) : ''
    return by ? 'aborted(' + by + ')' : 'aborted'
  }
  const message = reason && typeof reason.message === 'string' ? text(reason.message) : ''
  return message ? kind + ': ' + message : kind
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
// working even while the Chat itself is bypassed by direct mode.
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
 * v2 control plane. The controller owns the Chat, Advisors and managed
 * Workers; Router logic lives here as ordinary methods so it stays
 * deterministic and testable. It never talks to the model itself.
 */
export class V2Controller extends ToolRegistry {
  constructor(service) {
    super()
    this.service = service
    this.ctx = service.ctx
    this.stateDir = service.stateDir
    this.v2 = new V2Store(service.stateDir)
    this.service.tickets.attachV2(this.v2)
    // Reservations bridge async resolve/create to the synchronous ticket claim.
    // They are not Worker status: an unassigned Worker remains idle, and failed
    // dispatches release their reservation in finally without a background job.
    this.workerReservations = new Map()
    this.dispatchingTickets = new Set()
    this.stoppingWorkers = new Set()
    this.v2.onWorkerStateChanged = ({ workerId, before, after, trigger }) => {
      this.routerEvent({
        event: 'worker.state.changed',
        ticketId: after.currentTicketId || (before && before.currentTicketId) || null,
        sessionId: workerId,
        actor: 'router',
        reason: trigger,
        payload: { workerId, from: before ? before.status : null, to: after.status, trigger, before, after },
      })
    }
    // Searchable lessons learned, separate from memory.md: only matched entries
    // are injected into a Worker brief.
    this.lessons = new LessonStore({
      stateDir: service.stateDir,
      log: (level, message) => this.log(level, 'lessons: ' + message),
    })
    // Process-local model catalog cache for chatbot_models: 5-minute TTL, no
    // timer and no background refresh; a miss or expiry re-reads the registry.
    this.modelCatalogCache = undefined
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
    this.ensuringChat = undefined
    // Direct mode is deliberately memory-only: a restart must return to the
    // normal Chat conversation instead of silently steering WeChat traffic
    // into a session the user no longer remembers choosing.
    this.direct = undefined
    // Read-only blocked notices. Nothing here answers an approval or a
    // question: every result still comes from the downstream next(). Keyed by
    // sessionId|kind so one session cannot flood the Chat with every request
    // it hits.
    this.blockedNotices = new Map()
    this.lastBlockedNoticeAt = new Map()
    this.turnStartedAt = new Map()
    // One shared resume/steer delivery owns entries until prompt acceptance;
    // pre-step skips in-flight entries to avoid double injection.
    this.steerDeliveryLocks = new Map()
    this.deliveringInbox = new Set()
    const noticeOptions = service.options && typeof service.options === 'object' ? service.options : {}
    this.blockedNoticeWindowMs = Number.isFinite(noticeOptions.v2BlockedNoticeWindowMs)
      ? Math.max(0, noticeOptions.v2BlockedNoticeWindowMs)
      : 10 * 60_000
    this.blockedNoticeMinIntervalMs = Number.isFinite(noticeOptions.v2BlockedNoticeMinIntervalMs)
      ? Math.max(0, noticeOptions.v2BlockedNoticeMinIntervalMs)
      : 60_000
    // A working ticket whose last event is older than this is reported as a
    // stuck suspect by chatbot_status / chatbot_worker_config. One threshold,
    // shared by both views; deployments may override it via options.
    const stuckOption = Number(noticeOptions.v2StuckLastEventMinutes)
    this.stuckThresholdMinutes = Number.isFinite(stuckOption) && stuckOption > 0 ? stuckOption : STUCK_LAST_EVENT_MINUTES
    // Session silence is a wider net than the ticket record: a busy turn emits
    // step events long before it calls worker_report(progress).
    const sessionStuckOption = Number(noticeOptions.v2StuckSessionMinutes)
    this.stuckSessionThresholdMinutes = Number.isFinite(sessionStuckOption) && sessionStuckOption > 0
      ? sessionStuckOption
      : STUCK_SESSION_EVENT_MINUTES
    // Last event time per session, fed by onSessionEvent. Bounded: this map is
    // observability only, never state that a restart must replay.
    this.sessionLastEventAt = new Map()
    // Worker approvals currently holding a ticket. Entries arrive with
    // approval/asked and leave with approval/decided or the turn ending; no
    // timer ever scans this map.
    this.pendingApprovals = new Map()
    // Live approval/request waterflows waiting on a human. Each entry owns a
    // deferred that a successful grant can settle to allowed-once. Keyed by
    // sessionId|callId and bounded; entries leave with approval/decided or the
    // turn ending (no timer).
    this.pendingSettlers = new Map()
    // Terminal decisions prevent a late approval cancellation/denial from
    // undoing a grant settlement. Bounded and lazily pruned on write.
    this.approvalTerminals = new Map()
    for (const meta of this.v2.ticketMetas()) {
      for (const record of Array.isArray(meta.supersededApprovals) ? meta.supersededApprovals : []) {
        for (const key of [record.approvalId, record.key]) if (key) this.approvalTerminals.set(key, record)
      }
    }
    // Chat user-message images are captured from session events; ticket
    // creation attaches only the current message by default, with a bounded
    // recent-message fallback.
    this.chatbotCurrentImages = []
    this.chatbotRecentImageMessages = []
    // Tool arguments cached from tools/pre-execute and keyed by
    // sessionId|callId. approval/request itself carries no argv, so this is how
    // the risk classifier sees the command/path. Entries leave with tools/result.
    this.approvalToolCalls = new Map()
    // One risk decision per approval request, keyed like approvalToolCalls. It
    // memoises classification across approval/asked + approval/request and makes
    // the audit line exactly-once. Bounded by age/count, never by a timer.
    this.approvalRisks = new Map()
    // Risk decision per approval id, kept even when the ticket is not parked
    // (auto-allow), so approval.decided can still state risk/decision.
    this.approvalAskedRisks = new Map()
    // Co-management transport state and in-memory relay pipeline. It owns only
    // watches/cursors/options; approvals and audit reuse the controller.
    this.watchRelayLog = []
    this.cognition = new CognitionStore({
      stateDir: service.stateDir,
      log: (level, message) => this.log(level, 'cognition: ' + message),
      audit: event => {
        try {
          if (this.service && typeof this.service.routerEvent === 'function') {
            this.service.routerEvent({ ticketId: null, sessionId: 'sage', actor: 'sage', reason: '', payload: {}, ...event })
          }
        } catch { /* audit never blocks memory writes */ }
      },
    })
    this.cognition.onIndexChanged = event => this.onCognitionIndexChanged(event)
    this.sageIndexNotifyTimer = null
    this.sageIndexNotifyPending = null
    this.sageIndexNotifyFiles = new Set()
    this.sageIndexLastNotifiedVersion = ''
    this.sageIndexLastNotifiedAt = 0
    this.coManagement = new CoManagement({
      stateDir: service.stateDir,
      now: () => now(),
      log: (level, message) => this.log(level, 'co-management: ' + message),
      send: (watch, body, event) => this.sendWatchRelay(watch, body, event),
      notify: message => this.queueChatNotice(message),
      retryDelaysMs: service.options && Array.isArray(service.options.coManagementRetryDelaysMs)
        ? service.options.coManagementRetryDelaysMs
        : undefined,
    })
    // Direct-mode outbound retries. Live chat is not a durable ticket reply:
    // keep it in memory only, dedupe by event/seq, and give up after a bounded
    // window instead of replaying it after a reconnect.
    this.directSendQueue = new Map()
    // Keys already delivered within the retry window, so a re-emitted event
    // cannot double-send after the first copy left the queue.
    this.directSentKeys = new Map()
    const directOptions = service.options && typeof service.options === 'object' ? service.options : {}
    this.directBackoffMs = Array.isArray(directOptions.directBackoffMs)
      ? directOptions.directBackoffMs.map(value => Number(value)).filter(Number.isFinite).slice(0, 4)
      : [1000, 3000, 9000]
    this.directRetryWindowMs = Number.isFinite(directOptions.directRetryWindowMs)
      ? Math.max(0, directOptions.directRetryWindowMs)
      : 120000
    // Preset allow-list for managed Workers (create/recreate only; DSH has no
    // live preset switch). Deployments may override via options.workerPresets.
    const configuredPresets = Array.isArray(directOptions.workerPresets)
      ? directOptions.workerPresets.map(value => text(value)).filter(Boolean)
      : []
    this.workerPresets = configuredPresets.length ? configuredPresets : WORKER_PRESET_WHITELIST.slice()
  }

  log(level, message) {
    if (typeof this.service.log === 'function') this.service.log(level, 'v2: ' + message)
  }

  /** Fire-and-forget control-plane event; never affects the dispatch path. */
  routerEvent(event) {
    try {
      if (this.service && typeof this.service.routerEvent === 'function') this.service.routerEvent(event)
    } catch (error) {
      this.log('warn', 'could not append router event: ' + String(error && error.message ? error.message : error))
    }
  }

  /** Worker status describes ticket ownership, not a Session's live turn. */
  workerTicketId(worker) {
    if (!worker) return null
    const id = String(worker.sessionId)
    const currentTicketId = text(worker.currentTicketId)
    const current = currentTicketId ? this.service.tickets.ticket(currentTicketId) : null
    // Keep an unknown binding occupied rather than risk assigning two tickets.
    if (currentTicketId && (!current || (!TERMINAL.has(current.status) && String(current.executor) === id))) return currentTicketId
    const active = this.service.tickets.tickets().find(ticket => String(ticket.executor) === id
      && (ticket.status === 'working' || (ticket.status === 'blocked' && ticket.waitingOn === 'approval')))
    return active ? active.ticketId : null
  }

  releaseWorkerForTicket(ticketId, trigger) {
    const ticket = this.service.tickets.ticket(ticketId)
    const meta = this.v2.ticketMeta(ticketId)
    let released = 0
    for (const worker of this.v2.workers()) {
      if (worker.currentTicketId && String(worker.currentTicketId) !== String(ticketId)) continue
      const assigned = this.workerTicketId(worker)
      if (assigned && assigned !== ticketId) continue
      if (String(worker.currentTicketId || '') !== String(ticketId)
        && String(worker.sessionId) !== String(ticket && ticket.executor)
        && String(worker.sessionId) !== String(meta.workerId || '')) continue
      if (worker.status === 'idle' && !worker.currentTicketId) continue
      this.v2.addWorker(worker.sessionId, { status: 'idle', currentTicketId: null, lastUsedAt: now() }, { trigger })
      released += 1
    }
    return released
  }

  onTicketTransition(ticket, { to, reason } = {}) {
    if (!TERMINAL.has(to)) return
    // Dispatch-to-co-managed adds a watch owned by the ticket; the terminal
    // state removes exactly that one and leaves user-added watches alone.
    this.releaseTicketWatch(ticket.ticketId)
    this.releaseWorkerForTicket(ticket.ticketId, reason === 'chatbot_stop_ticket' ? 'chatbot_stop_ticket' : 'ticket.' + to)
  }

  /** Dispatch to a co-managed session also watches it, tagged with the ticket. */
  attachTicketWatch(ticket, worker) {
    if (!this.coManagement || !isCoManaged(worker)) return null
    const added = this.coManagement.add({
      sessionId: worker.sessionId,
      title: worker.title || worker.sessionId,
      addedBy: 'ticket:' + ticket.ticketId,
      reason: 'ticket-dispatch',
      ticketId: ticket.ticketId,
      options: { relayReplies: true, relayQuestions: true },
    })
    return added.ok ? added : null
  }

  releaseTicketWatch(ticketId) {
    if (!this.coManagement) return 0
    const owned = this.coManagement.watches().filter(item => item.addedBy === 'ticket:' + ticketId)
    for (const item of owned) this.coManagement.remove({ watchId: item.watchId })
    return owned.length
  }

  reserveWorker(workerId, reservation) {
    const id = String(workerId)
    const held = this.workerReservations.get(id)
    if (held && held !== reservation) return false
    this.workerReservations.set(id, reservation)
    return true
  }

  releaseWorkerReservation(workerId, reservation) {
    if (this.workerReservations.get(String(workerId)) === reservation) this.workerReservations.delete(String(workerId))
  }

  releaseWorkerReservations(reservation) {
    for (const [workerId, held] of this.workerReservations) {
      if (held === reservation) this.workerReservations.delete(workerId)
    }
  }

  /** All new/recreated work and reflection Workers share idle initialization. */
  async createIdleWorker({ scope = 'global', projectId = null, projectCwd = null, workerType = 'work', preset = DEFAULT_WORKER_PRESET, allowAutoDispatch = true, cwd }, trigger, reservation) {
    const sessionId = 'session-' + randomUUID()
    const artifactDir = join(cwd, workerType === 'reflection' || !projectCwd ? 'runs' : 'ria-runs', sessionId)
    mkdirSync(artifactDir, { recursive: true })
    const seq = workerType === 'reflection' ? this.v2.nextReflectionSeq() : this.v2.nextWorkerSeq()
    this.reserveWorker(sessionId, reservation)
    try {
      this.v2.addWorker(sessionId, {
        scope, projectId, projectCwd, workerType, preset, allowAutoDispatch, cwd, artifactDir, seq,
        status: 'idle', currentTicketId: null, createdAt: now(), lastUsedAt: now(),
      }, { trigger })
      const created = await this.createSession({ sessionId, cwd, agentPreset: preset, title: roleSessionTitle(workerType === 'reflection' ? 'reflection' : 'worker', seq) })
      this.install(created.agent, 'worker')
      return { sessionId, created: true, preset, meta: this.v2.worker(sessionId) }
    } catch (error) {
      this.v2.removeWorker(sessionId)
      this.releaseWorkerReservation(sessionId, reservation)
      throw error
    }
  }

  roleFor(sessionId) {
    const id = String(sessionId || '')
    if (!id) return null
    if (String(this.v2.chatSessionId || '') === id) return ROLE_CHAT
    if (String(this.v2.sageSessionId || '') === id) return 'sage'
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
    this.recordSessionActivity(id, event)
    this.trackBlockedNotice(id, event)
    // Approval audit events are what move a Worker's ticket into and out of
    // blocked(waitingOn=approval); see trackApprovalTicket.
    this.trackApprovalTicket(id, event)
    if (event.type === 'tool/result' || event.type === 'command/result' || event.type === 'command/end') this.recordSuccessfulApprovalOperation(id, event.data)
    // Watched independent sessions: relay assistant output and observe direct
    // user messages. This is independent from direct mode's relay.
    if (this.coManagement && this.handleWatchEvent(id, event)) return true
    if (String(this.v2.chatSessionId || '') === id) {
      if (event.type === 'user/message') {
        this.captureChatImages(event.data && event.data.content)
        const body = contentText(event.data && event.data.content)
        if (body.startsWith('/协管') || body.startsWith('/取消协管')) {
          void this.handleWatchCommand(body, id).then(result => {
            if (result && result.handled) this.queueChatNotice(result.reply)
          }).catch(error => {
            this.log('warn', 'watch command failed: ' + String(error && error.message ? error.message : error))
          })
          return true
        }
      }
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
    // Co-managed sessions have no ria_* tools: their own reply IS the report.
    if (isCoManaged(worker)) this.handleCoManagedEvent(id, worker, event)
    if (event.type === 'turn/start') {
      // Returning true below stops RiaService.onSessionEvent() before its
      // legacy worker turn/start confirmation, so v2 must confirm here: this
      // is the real signal that the dispatch actually started. Without it the
      // 60s reconcile sweep parks a perfectly healthy ticket.
      this.service.confirmWorkerTurnStart(id)
      const currentTicketId = this.workerTicketId(worker)
      this.v2.addWorker(id, { status: currentTicketId ? 'working' : 'idle', currentTicketId, lastTurnAt: now() }, { trigger: 'turn/start' })
    } else if (event.type === 'turn/end') {
      const kind = turnEndKind(event.data && event.data.reason)
      // A completed turn is the only normal end; keep the old behaviour. An
      // error/aborted/max-tokens/unknown end used to be ignored here, leaving
      // the ticket working forever with nobody notified.
      if (kind !== 'completed') {
        this.onWorkerTurnFailed(id, event)
        return true
      }
      // Ending a turn is not the same as finishing its ticket. Keep a live
      // ticket occupied, but never recreate working/null after a done or stop.
      const currentTicketId = this.workerTicketId(worker)
      this.v2.addWorker(id, { status: currentTicketId ? 'working' : 'idle', currentTicketId, lastTurnAt: now() }, { trigger: 'turn/end' })
      if (currentTicketId) {
        void this.retryManagerInboxAtTurnEnd(currentTicketId, id).catch(error => {
          this.log('warn', 'could not flush manager inbox after completed turn: ' + String(error && error.message ? error.message : error))
        })
      }
    }
    return true
  }

  /**
   * A Worker turn that did not complete normally must not leave its ticket
   * working forever. Park it as blocked(waitingOn=environment), release the
   * Worker so the next dispatch can reuse it, write `turn.failed` for the
   * timeline, and tell the Chat how to continue. A completed turn never
   * reaches this method.
   */
  onWorkerTurnFailed(sessionId, event) {
    const data = event && event.data && typeof event.data === 'object' ? event.data : {}
    const reason = data.reason && typeof data.reason === 'object' ? data.reason : {}
    const kind = turnEndKind(reason)
    const detail = clipText(turnEndDetail(reason, kind), 300)
    const turnId = Number.isSafeInteger(data.turn) ? data.turn : null
    const turnLabel = turnId === null ? 'turn' : 'turn ' + turnId
    const at = now()
    // aborted(user) is still an abnormal end for the ticket: the turn stopped
    // without finishing the work. The code names the cause for resumers.
    const failureCode = kind === 'aborted' ? 'turn_aborted' : 'turn_failed'
    const ticket = this.workerWorkingTicket(sessionId)
    let blocked = false
    if (ticket) {
      const blockedReason = clipText('Worker ' + turnLabel + ' 异常结束（' + kind + '）：' + detail, 300)
      const moved = this.service.tickets.transitionTicket(ticket.ticketId, 'blocked', {
        actor: 'router',
        executor: String(ticket.executor || sessionId),
        waitingOn: 'environment',
        blockedReason,
        failure: { code: failureCode, message: blockedReason, at },
        at,
        reason: kind === 'aborted' ? 'worker turn aborted' : 'worker turn failed',
      })
      if (moved.ok) {
        blocked = true
        this.v2.setTicketMeta(ticket.ticketId, { phase: 'blocked' })
        // Release the Worker (currentTicketId cleared, status idle) without
        // touching another ticket it might already own.
        this.releaseWorkerForTicket(ticket.ticketId, failureCode)
      } else {
        this.log('warn', 'could not block ' + ticket.ticketId + ' after ' + turnLabel + ' ended ' + kind + ': ' + moved.code + ' ' + moved.message)
      }
    }
    this.routerEvent({
      event: 'turn.failed',
      ticketId: ticket ? ticket.ticketId : null,
      sessionId,
      actor: 'router',
      reason: 'worker ' + turnLabel + ' ended ' + kind,
      payload: {
        ticketId: ticket ? ticket.ticketId : null,
        workerId: sessionId,
        turnId,
        kind,
        detail,
        failureCode: blocked ? failureCode : null,
        blocked,
        at,
      },
    })
    if (!blocked) return
    void this.notifyChat('ticket ' + ticket.ticketId + ' 的 Worker ' + sessionId + ' ' + turnLabel
      + ' 异常结束（' + kind + '）：' + detail
      + '。工单已转 blocked(waitingOn=environment)；处理后用 chatbot_resume 继续。').catch(error => {
      this.log('warn', 'could not notify Chat about ' + ticket.ticketId + ': ' + String(error && error.message ? error.message : error))
    })
  }

  /** The working ticket this Worker owns, even if its binding lost the id. */
  /**
   * Co-managed sessions report through their own conversation: an assistant
   * reply becomes a ticket report (structured or unstructured), and a session
   * that disappears parks its ticket on the environment instead of leaving it
   * working forever.
   */
  handleCoManagedEvent(sessionId, worker, event) {
    const type = event && event.type
    const ticket = this.workerWorkingTicket(sessionId)
    if (type === 'assistant/message') {
      if (!ticket || (event.data && event.data.interrupted)) return
      const prose = assistantProse(event)
      if (prose) this.recordCoManagedReport(ticket, sessionId, prose)
      return
    }
    if (type === 'session/end-seed' || type === 'session/ended' || type === 'session/disposed') {
      if (ticket) this.blockCoManagedSessionEnd(ticket, sessionId, type)
    }
  }

  recordCoManagedReport(ticket, sessionId, prose) {
    const parsed = parseAssistantReport(prose)
    const report = {
      reportId: newId('report_'),
      ticketId: ticket.ticketId,
      workerId: sessionId,
      status: 'progress',
      summary: parsed.summary,
      evidence: parsed.evidence,
      question: '',
      next: parsed.todo.join('；'),
      at: now(),
      structured: parsed.structured,
      unstructured: parsed.unstructured,
      artifacts: parsed.artifacts,
      raw: parsed.raw,
    }
    this.v2.addReport(report)
    try {
      this.service.tickets.updateTicket(ticket.ticketId, { progress: { lastPhase: parsed.summary.slice(0, 200), lastEventAt: now() } })
    } catch (error) {
      this.log('warn', 'could not record progress for ' + ticket.ticketId + ': ' + String(error && error.message ? error.message : error))
    }
    this.routerEvent({
      event: 'co-managed.report',
      ticketId: ticket.ticketId,
      sessionId,
      actor: 'router',
      reason: parsed.structured ? 'structured reply' : 'unstructured reply',
      payload: { ticketId: ticket.ticketId, workerId: sessionId, structured: parsed.structured, reportId: report.reportId, at: report.at },
    })
    return report
  }

  blockCoManagedSessionEnd(ticket, sessionId, type) {
    const at = now()
    const reason = 'co-managed 会话已结束（' + type + '）'
    const moved = this.service.tickets.transitionTicket(ticket.ticketId, 'blocked', {
      actor: 'router',
      executor: String(ticket.executor || sessionId),
      waitingOn: 'environment',
      blockedReason: reason,
      failure: { code: 'session_ended', message: reason, at },
      reason: 'co-managed session ended',
    })
    if (moved.ok) {
      this.v2.setTicketMeta(ticket.ticketId, { phase: 'blocked' })
      this.releaseWorkerForTicket(ticket.ticketId, 'session_ended')
    }
    this.queueChatNotice('co-managed 会话 ' + sessionId + ' 已结束，工单 ' + ticket.ticketId + ' 转 blocked(waitingOn=environment)。')
    return moved
  }

  workerWorkingTicket(sessionId) {
    const direct = this.workingTicketFor(sessionId)
    if (direct) return direct
    const worker = this.v2.worker(sessionId)
    const bound = worker && worker.currentTicketId ? this.service.tickets.ticket(worker.currentTicketId) : null
    return bound && bound.status === 'working' ? bound : null
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


  /** Fire-and-forget notice: an event callback must never await a prompt. */
  queueChatNotice(message) {
    void this.notifyChat(message).catch(error => {
      this.log('warn', 'could not notify Chat: ' + String(error && error.message ? error.message : error))
    })
  }



  /**
   * Chat system prompt = static role prompt + a live long-term memory block.
   * DSH calls the registered section's text(context) on every assembly, so a
   * cognition write is visible on the very next model step. This is deliberately
   * the only memory delivery path: no host message, event, or version hash.
   */
  chatSystemPrompt(basePrompt, context) {
    return String(basePrompt) + '\n\n' + this.chatbotMemorySummary(context)
  }

  /**
   * Render the memory block for the system prompt. The 1.5k budget covers the
   * heading, disclaimer, digest and the truncation marker. A missing/unreadable
   * cognition store degrades to a placeholder and never throws into assembly.
   */
  chatbotMemorySummary() {
    const header = '[长期记忆摘要]'
    let view
    try {
      view = this.cognition.chatDigest()
    } catch (error) {
      this.log('warn', 'could not build Chat memory digest: ' + String(error && error.message ? error.message : error))
      view = { text: '', degraded: true, truncated: false }
    }
    const digest = String(view && view.text ? view.text : '').trim()
    let body
    if (!digest) {
      body = header + '\n' + CHATBOT_MEMORY_NOTICE + '\n' + (view && view.degraded
        ? '长期记忆暂不可用（cognition/chat/ 文件缺失或读取失败），不影响本次会话。'
        : '长期记忆暂无内容（cognition/chat/ 为空），不影响本次会话。')
    } else {
      body = header + '\n' + CHATBOT_MEMORY_NOTICE
        + (view && view.degraded ? '\n部分记忆文件读取失败，仅展示可读内容。' : '')
        + '\n' + digest
    }
    if (body.length <= CHATBOT_MEMORY_LIMIT) return body
    const marker = '\n…（已截断）'
    return body.slice(0, CHATBOT_MEMORY_LIMIT - marker.length) + marker
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
    const decision = await next()
    if (!decision || decision.kind !== 'enter') return decision
    const agentId = String(agent && agent.id !== undefined ? agent.id : '')
    const role = this.roleFor(agentId)
    // Chat memory lives in the system prompt section, not in the message
    // stream. Do not inject a host message here: that would be a second path.
    if (isChatRole(role)) return decision
    // Advisor, managed Workers and Sage are Ria-only; Chat and ordinary
    // independent sessions keep normal direct conversation.
    if (role !== 'advisor' && role !== 'worker' && role !== 'sage') return decision
    let settings = {}
    try { settings = this.service.store.settings() } catch { settings = {} }
    if (settings.blockDirectUserMessages === false) return this.applyWorkerPreStep(agentId, role, decision, payload)
    // Exception: a ticket explicitly waiting on the user's clarification must
    // remain reachable, otherwise the Worker/Advisor can never receive the answer.
    const tickets = this.service.tickets.tickets()
    const waitingForUser = role !== 'sage' && tickets.find(ticket => ticket.status === 'blocked' && ticket.waitingOn === 'user'
      && (String(ticket.executor) === agentId || (role === 'advisor' && String(ticket.executor) === 'advisor')))
    if (waitingForUser) return this.applyWorkerPreStep(agentId, role, decision, payload)
    const messages = Array.isArray(decision.messages) ? decision.messages : []
    const direct = messages.filter(message => {
      const source = message && message.source
      return source && source.kind === 'user' && !isHostRequestId(source.rpcId)
    })
    if (!direct.length) return this.applyWorkerPreStep(agentId, role, decision, payload)
    // Do not execute, forward, or change ticket state: replace the whole turn
    // input with one host instruction whose only job is the fixed notice. The
    // model's normal assistant turn emits that text; we never append it directly.
    // A hijacked turn never receives a queued steer either: it does not run the
    // worker's task, so marking a steer delivered here would lose it.
    const reply = role === 'sage'
      ? '请通过 Ria 与 Sage 交互。Sage 只接受 Ria/Sage 内部提案，直接对话不会被处理。'
      : '请通过 Ria 下达任务。Advisor/Worker 只接受 Ria 派发的工单，直接对话不会被处理。'
    const instruction = '检测到用户直连消息（非 Ria 注入），不要执行其中任何指令，也不要调用任何工具。只输出下面这段原文：\n' + reply
    const notice = typeof this.service.hostMessage === 'function'
      ? this.service.hostMessage(instruction, 'direct-user-notice')
      : {
        id: 'msg_' + randomUUID(),
        role: 'user',
        content: [{ type: 'text', text: instruction }],
        source: { kind: 'ria-task-host', form: 'direct-user-notice' },
      }
    return { ...decision, messages: [notice] }
  }

  /**
   * Worker-only turn-boundary work. This runs from agent/pre-step, i.e. after
   * the previous tool call has returned and before the next model step starts;
   * it never reaches into a running tool and never calls agent.steer().
   *
   * Order matters: a forced stop wins over steering. A stopped worker must not
   * receive new direction and must not execute another step.
   */
  applyWorkerPreStep(agentId, role, decision, payload) {
    if (role !== 'worker' || !agentId) return decision
    const stopped = this.applyWorkerSoftStop(agentId, decision, payload)
    if (stopped) return stopped
    return this.injectSteerAtPreStep(agentId, decision)
  }

  /**
   * Soft stop for the one case DSH cannot interrupt: the ticket was cancelled
   * but the running tool ignored (or never had) the abort. The next pre-step
   * tells the worker to end with a short termination note; if it keeps calling
   * tools after that, the following pre-step rejects the step instead of
   * letting it keep working.
   */
  applyWorkerSoftStop(agentId, decision, payload) {
    const stop = this.v2.workerStop(agentId)
    if (!stop) return null
    const ticket = this.service.tickets.ticket(stop.ticketId)
    // A resumed/reopened ticket cancels the pending soft stop.
    if (!ticket || ticket.status !== 'cancelled') {
      this.v2.clearWorkerStop(agentId)
      return null
    }
    if (stop.noticedAt) {
      this.v2.clearWorkerStop(agentId)
      this.routerEvent({
        event: 'worker.stop.enforced',
        ticketId: stop.ticketId,
        sessionId: agentId,
        actor: 'router',
        reason: 'cancelled-by-stop',
        payload: { ticketId: stop.ticketId, phase: 'reject-step', mode: 'soft', turn: payload && payload.turn, step: payload && payload.step },
      })
      return { kind: 'reject', reason: 'cancelled-by-stop' }
    }
    this.v2.markWorkerStopNoticed(agentId)
    const instruction = [
      '[Manager stop · ticket 已取消]',
      'ticket ' + stop.ticketId + ' 已被用户强制停止' + (stop.reason ? '（原因：' + stop.reason + '）' : '') + '。',
      '不要再调用任何工具，不要继续执行后续步骤。只输出一段简短的终止说明：说明已停止、当前做到哪一步、还有哪些没有做。',
    ].join('\n')
    this.routerEvent({
      event: 'worker.stop.enforced',
      ticketId: stop.ticketId,
      sessionId: agentId,
      actor: 'router',
      reason: 'cancelled-by-stop',
      payload: { ticketId: stop.ticketId, phase: 'pre-step', mode: 'soft', turn: payload && payload.turn, step: payload && payload.step },
    })
    const notice = {
      id: 'msg_' + randomUUID(),
      role: 'user',
      content: [{ type: 'text', text: instruction }],
      source: { kind: 'ria-task-host', form: 'worker-stop', ticketId: stop.ticketId, reason: stop.reason },
    }
    return { ...decision, messages: [...(Array.isArray(decision.messages) ? decision.messages : []), notice] }
  }

  /**
   * Deliver up to STEER_PRE_STEP_BATCH_SIZE pending steering items as ONE host
   * message at the step boundary. The message carries ticketId and every
   * inboxId, and each item is marked delivered only after the message is built.
   * A longer backlog is left for the following boundary, not dropped.
   */
  injectSteerAtPreStep(agentId, decision) {
    const tickets = this.service.tickets.tickets().filter(ticket =>
      ticket && ticket.status === 'working' && String(ticket.executor) === agentId)
    if (!tickets.length) return decision
    const batch = []
    for (const ticket of tickets) {
      if (batch.length >= STEER_PRE_STEP_BATCH_SIZE) break
      for (const entry of this.v2.pendingInbox(ticket.ticketId, agentId)) {
        if (batch.length >= STEER_PRE_STEP_BATCH_SIZE) break
        if (!this.deliveringInbox.has(entry.id)) batch.push({ ticket, entry })
      }
    }
    if (!batch.length) return decision
    const ticketIds = [...new Set(batch.map(item => String(item.ticket.ticketId)))]
    const inboxIds = batch.map(item => String(item.entry.id))
    const sources = [...new Set(batch.map(item => this.managerInboxSource(item.entry)))]
    const lines = [this.managerInboxText(batch.map(item => item.entry))]
    lines.push('以上是 Ria 转来的方向调整，按最新指令继续当前执行；不要把它当成新任务另起一轮。')
    const notice = {
      id: 'msg_' + randomUUID(),
      role: 'user',
      content: [{ type: 'text', text: lines.join('\n') }],
      source: {
        kind: 'ria-task-host',
        form: 'steer',
        source: sources.length === 1 ? sources[0] : 'mixed',
        sources,
        ticketId: batch[0].ticket.ticketId,
        ticketIds,
        inboxId: inboxIds[0],
        inboxIds,
      },
    }
    this.recordInboxDelivered(batch.map(item => item.entry), agentId, 'pre-step')
    return { ...decision, messages: [...(Array.isArray(decision.messages) ? decision.messages : []), notice] }
  }


  async promptSession(sessionId, message, mode = 'queue', requestId) {
    const signal = new AbortController().signal
    return await this.ctx.sessionController.prompt({
      requestId: requestId || (HOST_REQUEST_PREFIX + randomUUID()),
      sessionId: String(sessionId),
      mode,
      content: Array.isArray(message) ? message : [{ type: 'text', text: String(message) }],
    }, signal)
  }

  imageRejection(error) {
    const code = String(error && error.code || '')
    const reason = String(error && (error.reason || (error.data && error.data.reason)) || '')
    const message = String(error && error.message || '')
    return code === 'session/attachment-invalid' || code === 'model_no_image'
      || reason === 'MODEL_DOES_NOT_SUPPORT_IMAGES' || code === 'MODEL_DOES_NOT_SUPPORT_IMAGES'
      || /does not support image input|不支持图片输入/i.test(message)
  }

  /** Only explicit pre-admission image rejections may be retried as text. A
   * timeout/unknown send failure might have been accepted: never double-send it.
   */
  async promptWithImageFallback(sessionId, content, body, { mode = 'queue', requestId, labels = [], probe = false } = {}) {
    const id = requestId || HOST_REQUEST_PREFIX + randomUUID()
    let reason
    if (probe && content.some(part => part && part.type === 'image')) {
      reason = await this.service.modelImageProblem(sessionId, new AbortController().signal)
    }
    if (!reason) {
      try {
        await this.promptSession(sessionId, content, mode, id)
        return { imagesAttached: labels.length || content.filter(part => part && part.type === 'image').length, imagesDegraded: false }
      } catch (error) {
        if (!this.imageRejection(error)) throw error
        reason = String(error && error.message ? error.message : error)
      }
    }
    const warning = '图片未能附带，已降级为纯文字：' + reason
    this.log('warn', 'multimodal delivery degraded for ' + sessionId + ': ' + reason)
    await this.promptSession(sessionId, body + '\n\n[' + warning + ']', mode, id)
    return { imagesAttached: 0, imagesDegraded: true, warning,
      imageWarnings: (labels.length ? labels : ['image']).map(path => ({ path, reason })) }
  }

  /** Bounded reads via one file descriptor avoid a growing file bypassing the
   * 10MB stat check. Content type comes from bytes, never a trusted extension.
   */
  readChatImage(path) {
    if (typeof path !== 'string' || !path.trim() || !isAbsolute(path.trim()) || path.includes('\0')) {
      throw Object.assign(new Error('图片必须是非空本地绝对路径'), { code: 'image_path_invalid' })
    }
    let fd
    try {
      const canonical = realpathSync(path.trim())
      if (!statSync(canonical).isFile()) throw Object.assign(new Error('图片不是普通文件：' + path), { code: 'image_invalid' })
      fd = openSync(canonical, 'r')
      const info = fstatSync(fd)
      if (!info.isFile() || info.size <= 0) throw Object.assign(new Error('图片不是非空普通文件：' + path), { code: 'image_invalid' })
      if (info.size > CHATBOT_IMAGE_MAX_BYTES) throw Object.assign(new Error('单张图片上限 10MB：' + path), { code: 'image_too_large' })
      const buffer = Buffer.alloc(info.size)
      let offset = 0
      while (offset < buffer.length) {
        const read = readSync(fd, buffer, offset, buffer.length - offset, offset)
        if (!read) break
        offset += read
      }
      if (offset !== buffer.length || fstatSync(fd).size !== info.size) throw Object.assign(new Error('读取期间图片发生变化，请重试：' + path), { code: 'image_changed' })
      const mediaType = imageMediaType(buffer)
      if (!mediaType) throw Object.assign(new Error('不是支持的图片（PNG/JPEG/WebP/GIF）：' + path), { code: 'image_type_invalid' })
      return { path: canonical, name: basename(canonical), buffer, mediaType }
    } catch (error) {
      if (error && error.code && String(error.code).startsWith('image_')) throw error
      throw Object.assign(new Error('图片不存在或不可读：' + path + '（' + String(error && error.code || 'unknown') + '）'), { code: 'image_missing' })
    } finally { if (fd !== undefined) closeSync(fd) }
  }

  async prepareChatImages({ images, attachments } = {}, { partial = false, hostValidation = true } = {}) {
    for (const [label, input] of [['images', images], ['attachments', attachments]]) {
      if (input !== undefined && !Array.isArray(input)) return { ok: false, code: 'images_invalid', message: label + ' 必须是数组' }
    }
    if (images && images.some(path => typeof path !== 'string')) return { ok: false, code: 'images_invalid', message: 'images 必须是本地图片绝对路径数组；引用请用 attachments' }
    const inputs = [...(images || []), ...(attachments || [])]
    if (inputs.length > CHATBOT_IMAGE_LIMIT) return { ok: false, code: 'images_limit', message: '一次最多 5 张图片（images 与 attachments 合计）' }
    const files = [], results = []
    let total = 0
    for (const input of inputs) {
      let path = typeof input === 'string' ? input : ''
      let expectedSha = ''
      try {
        if (typeof input !== 'string') {
          const ref = input && typeof input === 'object' ? input.attachment || input : null
          if (!ref || typeof ref !== 'object') throw Object.assign(new Error('图片附件引用必须是对象或本地绝对路径'), { code: 'image_reference_invalid' })
          path = text(ref.path)
          if (ref.attachmentId !== undefined || !path) {
            const match = /^sha256:([a-f0-9]{64})$/i.exec(String(ref.attachmentId || ''))
            if (!match) throw Object.assign(new Error('图片引用缺少有效 attachmentId/path'), { code: 'image_reference_invalid' })
            expectedSha = match[1].toLowerCase()
          }
          if (!path) {
            const store = typeof this.ctx.get === 'function' ? this.ctx.get('attachments') : null
            if (store && typeof store.imageHostPath === 'function') path = await store.imageHostPath(ref)
            if (!path) {
              const home = process.env.DSH_HOME || join(process.env.HOME || '', '.dsh')
              path = join(home, 'attachments', 'v1', 'objects', expectedSha.slice(0, 2), expectedSha)
            }
          }
        }
        const file = this.readChatImage(path)
        if (expectedSha && createHash('sha256').update(file.buffer).digest('hex') !== expectedSha) {
          throw Object.assign(new Error('图片附件校验值与 attachmentId 不符'), { code: 'image_reference_invalid' })
        }
        total += file.buffer.length
        if (total > CHATBOT_IMAGE_TOTAL_BYTES) return { ok: false, code: 'images_total_too_large', message: '一次图片总量上限 20MB；未投递' }
        files.push(file)
        results.push({ path, ok: true, file })
      } catch (error) {
        const failure = { path: path || String(input && input.attachmentId || ''), ok: false,
          code: error && error.code || 'image_invalid', message: String(error && error.message || error) }
        results.push(failure)
        if (!partial) return { ...failure, results: results.map(({ file, ...result }) => result) }
      }
    }
    if (hostValidation && files.length) {
      try {
        const store = typeof this.ctx.get === 'function' ? this.ctx.get('attachments') : null
        const batch = files.map(file => ({ data: file.buffer, mediaType: file.mediaType, name: file.name }))
        if (store && typeof store.validateImageBatch === 'function') store.validateImageBatch(batch)
        if (store && typeof store.validateImage === 'function') for (const image of batch) await store.validateImage(image)
      } catch (error) {
        return { ok: false, code: 'images_host_rejected', message: '宿主拒绝图片附件：' + String(error && error.message || error) }
      }
    }
    return { ok: true, files, results, totalBytes: total,
      parts: files.map(file => ({ type: 'image', mediaType: file.mediaType, data: file.buffer.toString('base64'), name: file.name })) }
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

  async ensureChat() {
    if (this.ensuringChat) return this.ensuringChat
    this.ensuringChat = this.doEnsureChat().finally(() => { this.ensuringChat = undefined })
    return this.ensuringChat
  }

  async doEnsureChat() {
    const stored = this.v2.chatSessionId
    if (stored) {
      try {
        const resolved = await this.service.resolve(stored)
        if (!('error' in resolved)) {
          this.install(resolved.agent, 'chat')
          this.service.store.setRia(stored, 'standard')
          await this.attachWorkspace(stored, this.stateDir)
          this.v2.clearError('chat')
          return { sessionId: stored, created: false, preset: 'standard' }
        }
        if (resolved.error.code !== 'session/not-found') {
          throw new Error('cannot open Chat ' + stored + ': ' + resolved.error.message)
        }
        this.v2.clearChat(stored)
      } catch (error) {
        this.v2.recordError('chat', error, { sessionId: stored, phase: 'resume' })
        if (String(this.service.store.riaSessionId || '') === String(stored)) this.service.store.clearRia()
        throw error
      }
    }
    const sessionId = 'session-' + randomUUID()
    this.v2.setChat(sessionId)
    try {
      const result = await this.createSession({ sessionId, cwd: this.stateDir, agentPreset: 'standard', title: roleSessionTitle('chat') })
      this.service.store.setRia(sessionId, 'standard')
      this.install(result.agent, 'chat')
      this.v2.clearError('chat')
      return { sessionId, created: true, preset: 'standard' }
    } catch (error) {
      this.v2.recordError('chat', error, { sessionId, phase: 'create' })
      this.v2.clearChat(sessionId)
      if (String(this.service.store.riaSessionId || '') === String(sessionId)) this.service.store.clearRia()
      throw error
    }
  }

  sageSystemPrompt(sessionId = '') {
    if (sessionId && this.v2.sagePromptText) return this.v2.sagePromptText
    this.cognition.ensure()
    const principles = clip(this.cognition.readIfExists('principles.md') || '（principles 为空）', SAGE_PRINCIPLES_MAX_CHARS)
    const prompt = sagePrompt({ principles })
    if (sessionId) this.v2.setSagePromptText(prompt)
    return prompt
  }

  onCognitionIndexChanged(event) {
    const version = text(event && event.version)
    if (!version || version === this.sageIndexLastNotifiedVersion) return
    this.sageIndexNotifyPending = version
    for (const file of arrayOfText(event && event.changedFiles)) this.sageIndexNotifyFiles.add(file)
    if (this.sageIndexNotifyTimer) clearTimeout(this.sageIndexNotifyTimer)
    const options = this.service.options && typeof this.service.options === 'object' ? this.service.options : {}
    const debounce = Number.isFinite(options.cognitionIndexNotifyDebounceMs) ? options.cognitionIndexNotifyDebounceMs : 60_000
    this.sageIndexNotifyTimer = setTimeout(() => {
      this.sageIndexNotifyTimer = null
      void this.flushCognitionIndexNotice()
    }, Math.max(0, debounce))
    if (this.sageIndexNotifyTimer && typeof this.sageIndexNotifyTimer.unref === 'function') this.sageIndexNotifyTimer.unref()
  }

  async flushCognitionIndexNotice() {
    const options = this.service.options && typeof this.service.options === 'object' ? this.service.options : {}
    const minInterval = Number.isFinite(options.cognitionIndexNotifyMinIntervalMs) ? options.cognitionIndexNotifyMinIntervalMs : 300_000
    const wait = Math.max(0, minInterval - (now() - this.sageIndexLastNotifiedAt))
    if (wait > 0) {
      this.sageIndexNotifyTimer = setTimeout(() => {
        this.sageIndexNotifyTimer = null
        void this.flushCognitionIndexNotice()
      }, wait)
      if (this.sageIndexNotifyTimer && typeof this.sageIndexNotifyTimer.unref === 'function') this.sageIndexNotifyTimer.unref()
      return
    }
    const version = this.sageIndexNotifyPending
    if (!version || version === this.sageIndexLastNotifiedVersion) return
    const files = [...this.sageIndexNotifyFiles].slice(0, 20)
    this.sageIndexNotifyPending = null
    this.sageIndexNotifyFiles.clear()
    const sage = this.v2.sageSessionId
    if (!sage) return
    const notice = 'INDEX 已更新（版本 ' + version + '，变更 ' + files.length + ' 个文件：' + files.join(', ') + '）。如需最新内容请 sage_read；不强制。'
    try {
      await this.promptSession(sage, notice, 'queue')
      this.sageIndexLastNotifiedVersion = version
      this.sageIndexLastNotifiedAt = now()
      this.routerEvent({ event: 'cognition.index.notified', ticketId: null, sessionId: sage, actor: 'router', reason: 'index changed', payload: { version, changedFiles: files } })
    } catch (error) {
      this.log('warn', 'could not notify Sage of INDEX change: ' + String(error && error.message ? error.message : error))
      this.routerEvent({ event: 'cognition.index.notify_failed', ticketId: null, sessionId: sage, actor: 'router', reason: 'index changed', payload: { version, changedFiles: files, message: String(error && error.message ? error.message : error) } })
    }
  }

  async ensureSage() {
    if (this.ensuringSage) return await this.ensuringSage
    this.ensuringSage = this.doEnsureSage().finally(() => { this.ensuringSage = undefined })
    return await this.ensuringSage
  }

  async doEnsureSage() {
    this.cognition.ensure()
    const stored = this.v2.sageSessionId
    if (stored) {
      try {
        const resolved = await this.service.resolve(stored)
        if (!('error' in resolved)) {
          this.install(resolved.agent, 'sage')
          await this.attachWorkspace(stored, this.stateDir)
          // Existing Sage keeps its original system prompt snapshot; INDEX is
          // re-read through sage_read when freshness matters.
          return { sessionId: stored, created: false, preset: 'standard' }
        }
        if (resolved.error.code !== 'session/not-found') throw new Error('cannot open Sage ' + stored + ': ' + resolved.error.message)
        this.v2.clearSage(stored)
      } catch (error) {
        this.v2.recordError('sage', error, { sessionId: stored, phase: 'resume' })
        throw error
      }
    }
    return await this.createSageSession()
  }

  async createSageSession() {
    const sessionId = 'session-' + randomUUID()
    this.v2.setSage(sessionId)
    this.sageSystemPrompt(sessionId)
    try {
      const result = await this.createSession({ sessionId, cwd: this.stateDir, agentPreset: 'standard', title: roleSessionTitle('sage') })
      this.install(result.agent, 'sage')
      return { sessionId, created: true, preset: 'standard' }
    } catch (error) {
      this.v2.clearSage(sessionId)
      throw error
    }
  }

  advisorSnapshot(ticket, meta = {}) {
    let snapshot
    let degraded = false
    try {
      let lessons = []
      try {
        lessons = this.lessons.match({ goal: ticket.goal, workspace: meta.projectCwd, mode: ticketKind(meta), limit: 5 }).lessons
      } catch { degraded = true }
      snapshot = this.cognition.retrieve({ workspace: meta.projectCwd, goal: ticket.goal, lessons })
      degraded = Boolean(snapshot.degraded)
    } catch (error) {
      degraded = true
      snapshot = { snapshot: '', degraded: true, files: [] }
      this.log('warn', 'cognition retrieval failed for ' + ticket.ticketId + ': ' + String(error && error.message ? error.message : error))
    }
    return { snapshot, degraded }
  }

  resolveAdvisorModel() {
    const envProvider = text(process.env.RIA_ADVISOR_PROVIDER)
    const envModel = text(process.env.RIA_ADVISOR_MODEL)
    if (envProvider && envModel) return { provider: envProvider, model: envModel }
    try {
      const selection = this.ctx.get('agentDefaultModel').currentSelection()
      if (selection && selection.provider && selection.model) return { provider: selection.provider, model: selection.model }
    } catch { /* fall through */ }
    const error = new Error('Advisor model is unavailable')
    error.code = 'advisor_model_unavailable'
    throw error
  }

  async callAdvisorModel({ system, user }) {
    const llm = this.service.routerLlm || this.ctx.get('llm')
    if (!llm || typeof llm.stream !== 'function') {
      const error = new Error('Advisor llm service is unavailable')
      error.code = 'advisor_llm_unavailable'
      throw error
    }
    const { provider, model } = this.resolveAdvisorModel()
    const client = createLlmModel({ llm, provider, model, maxTokens: 2000, temperature: 0, timeoutMs: 120000 })
    let lastError
    let totalLatency = 0
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const started = Date.now()
      try {
        const result = await client.generate({ system, user })
        totalLatency += Number(result.latencyMs) || (Date.now() - started)
        return { text: result.text, usage: result.usage, latencyMs: totalLatency, attempts: attempt }
      } catch (error) {
        totalLatency += Date.now() - started
        lastError = error
      }
    }
    const failure = new Error(String(lastError && lastError.message ? lastError.message : lastError))
    failure.code = 'advisor_model_failed'
    failure.attempts = 2
    failure.latencyMs = totalLatency
    failure.cause = lastError
    throw failure
  }

  async createAdvisorForTicket(ticket, meta = {}, request = null, extra = '') {
    return await this.planTicketStateless(ticket, meta, request, extra)
  }

  persistWorkOrder(ticketId, plan, { by = 'advisor', sessionId = '', reason = 'stateless llm' } = {}) {
    const ticket = this.service.tickets.ticket(ticketId)
    if (!ticket) return { ok: false, code: 'ticket_missing', message: 'ticket not found: ' + ticketId }
    const workOrder = {
      ticketId,
      summary: text(plan.summary),
      steps: arrayOfText(plan.steps),
      acceptance: text(plan.acceptance) || ticket.acceptance,
      artifacts: arrayOfText(plan.artifacts),
      notes: text(plan.notes),
      by,
      createdAt: now(),
    }
    const requestedRouting = plan.routing && typeof plan.routing === 'object' && !Array.isArray(plan.routing) ? plan.routing : null
    if (requestedRouting) {
      const tags = mergeTags(requestedRouting.tags)
      if (tags.length || requestedRouting.requireTagMatch === true) {
        workOrder.routing = { tags, requireTagMatch: requestedRouting.requireTagMatch === true }
      }
    }
    const requestedTopic = plan.topic && typeof plan.topic === 'object' && !Array.isArray(plan.topic) ? plan.topic : null
    if (requestedTopic && (text(requestedTopic.action) === 'reuse' || text(requestedTopic.action) === 'create')) {
      workOrder.topic = {
        action: text(requestedTopic.action),
        ...(text(requestedTopic.topicId) ? { topicId: text(requestedTopic.topicId) } : {}),
        ...(text(requestedTopic.title) ? { title: text(requestedTopic.title) } : {}),
        ...(text(requestedTopic.brief) ? { brief: text(requestedTopic.brief) } : {}),
      }
    }
    if (!workOrder.summary) return { ok: false, code: 'summary_required', message: 'summary must not be empty' }
    if (!workOrder.steps.length) return { ok: false, code: 'steps_required', message: 'steps must contain at least one step' }
    const requestedPolicy = text(plan.escalationPolicy)
    const escalationPolicy = normalizeEscalationPolicy(requestedPolicy)
    if (requestedPolicy && !escalationPolicy) return { ok: false, code: 'invalid_escalation_policy', message: 'invalid escalationPolicy' }
    const pinned = []
    for (const id of arrayOfText(plan.lessons).slice(0, 5)) {
      const entry = this.lessons.get(id)
      if (entry && entry.status === 'active') pinned.push({ id: entry.id, scenario: entry.scenario })
    }
    if (pinned.length) workOrder.lessons = pinned
    const meta = this.v2.ticketMeta(ticketId)
    if (Array.isArray(meta.attachments) && meta.attachments.length) workOrder.attachments = meta.attachments
    if (Array.isArray(meta.attachmentNotes) && meta.attachmentNotes.length) workOrder.attachmentNotes = meta.attachmentNotes
    let proposal = null
    if (plan.cognitionProposal && typeof plan.cognitionProposal === 'object' && text(plan.cognitionProposal.text)) {
      proposal = this.cognition.propose({
        author: 'advisor', source: 'stateless_advisor', ticketId,
        scope: text(plan.cognitionProposal.scope) || 'global',
        text: text(plan.cognitionProposal.text),
        evidence: arrayOfText(plan.cognitionProposal.evidence),
      })
    }
    this.v2.setWorkOrder(ticketId, workOrder)
    this.v2.setTicketMeta(ticketId, {
      phase: 'planned',
      ...(escalationPolicy ? { escalationPolicy } : {}),
      ...(proposal ? { cognitionProposalId: proposal.id } : {}),
      ...(workOrder.routing && workOrder.routing.tags.length ? { routingTags: mergeTags(meta.routingTags, workOrder.routing.tags) } : {}),
      ...(workOrder.routing && workOrder.routing.requireTagMatch ? { requireTagMatch: true } : {}),
    })
    this.routerEvent({ event: 'advisor.plan.persisted', ticketId, sessionId, actor: 'advisor', reason, payload: { summary: clip(workOrder.summary, 200), steps: workOrder.steps.length } })
    return { ok: true, workOrder, ...(escalationPolicy ? { escalationPolicy } : {}), ...(proposal ? { cognitionProposal: proposal } : {}) }
  }

  async blockTicketInternal(ticketId, { reason, question } = {}) {
    const ticket = this.service.tickets.ticket(ticketId)
    if (!ticket) return { ok: false, code: 'ticket_missing', message: 'ticket not found: ' + ticketId }
    const message = text(reason)
    if (!message) return { ok: false, code: 'reason_required', message: 'reason must not be empty' }
    const moved = this.service.tickets.transitionTicket(ticketId, 'blocked', {
      actor: 'advisor', executor: 'advisor', waitingOn: 'user',
      blockedReason: message, attention: { kind: 'question', question: text(question) || message }, reason: 'stateless advisor blocked',
    })
    if (!moved.ok) return { ok: false, code: moved.code, message: moved.message }
    this.v2.setTicketMeta(ticketId, { phase: 'blocked' })
    await this.notifyChat('ticket ' + ticketId + ' 需要你：' + message)
    return { ok: true, ticketId, status: 'blocked', waitingOn: 'user' }
  }

  /** Project key for a ticket: workspace-derived, null for a global ticket. */
  ticketProjectKey(meta = {}) {
    const cwd = text(meta && meta.projectCwd)
    return cwd ? projectKey(cwd) : null
  }

  /**
   * Optional Advisor input: candidate Topics in the ticket's Project plus the
   * Worker tag vocabulary and dedicated role notes. Any failure degrades to an
   * empty hint; planning itself never depends on it.
   */
  advisorRoutingHints(ticket, meta = {}) {
    try {
      const projectKeyValue = this.ticketProjectKey(meta)
      const store = this.service.store
      const suggestions = topicSuggestions({
        goal: ticket.goal,
        projectKey: projectKeyValue,
        topics: store.topics(),
        links: store.links(),
        tickets: store.tickets(),
        limit: 5,
      })
      const topicLines = suggestions.topics.map(item => '- ' + item.topicId + ': ' + clip(item.title, 60)
        + ' — 待执行 ' + item.counts.open + ' · 已完成 ' + item.counts.done
        + ' [tags: ' + ((item.tags || []).join(', ') || '—') + ']')
      const topicBlock = ['[候选主题 (Project: ' + (projectKeyValue || 'global') + ')]', ...topicLines]
      if (!topicLines.length) topicBlock.push('（同项目暂无候选主题；不要复用其它项目或全局主题）')
      topicBlock.push('（若已有候选明显契合本票方向，优先 reuse 其 topicId；若无契合方向，用 create 新建简短方向标题，切勿把单张工单原话当标题）')
      const closed = this.archivedSessionIds()
      const workers = this.v2.workers().filter(worker => worker.workerType !== 'reflection'
        && !closed.has(String(worker.sessionId))
        && (projectKeyValue
          ? worker.projectCwd === meta.projectCwd || worker.cwd === meta.projectCwd
          : !worker.projectCwd))
      const vocab = [...new Set(workers.flatMap(worker => [...(worker.tags || []), ...(worker.autoTags || [])]))].slice(0, 24)
      const dedicated = workers
        .filter(worker => worker.dedicated === true && worker.roleNote)
        .slice(0, 5)
        .map(worker => '- Worker ' + (worker.seq || '?') + ' [' + [...(worker.tags || []), 'dedicated'].join(', ') + ']: ' + clip(worker.roleNote, 60))
      const parts = [clip(topicBlock.join('\n'), 500)]
      if (vocab.length) parts.push('[可用 Worker 标签词表] ' + vocab.join(', '))
      if (dedicated.length) parts.push('[专职 Worker]', ...dedicated)
      return parts.join('\n')
    } catch (error) {
      this.log('warn', 'advisor routing hints degraded: ' + String(error && error.message ? error.message : error))
      return ''
    }
  }

  /**
   * Deterministically attach the Advisor's optional topic to the ticket.
   * Explicit meta.topicId wins; otherwise reuse/create with same-project dedupe.
   * Every failure is a degraded router event, never a dispatch blocker.
   */
  async assignTicketTopic(ticket, meta = {}, workOrder = null) {
    const ticketId = String(ticket && ticket.ticketId ? ticket.ticketId : '')
    const store = this.service.store
    const degrade = (code, message, extra = {}) => {
      try {
        this.routerEvent({
          event: 'topic.auto_assign.degraded', ticketId, sessionId: '', actor: 'router', reason: 'advisor topic',
          payload: { code, message: String(message || code), ...extra },
        })
      } catch { /* observability can never block dispatch */ }
      return { ok: false, code }
    }
    try {
      if (!ticketId) return degrade('ticket_missing', 'ticket id missing')
      if (text(meta && meta.topicId)) return { ok: true, skipped: 'explicit' }
      const requested = workOrder && workOrder.topic && typeof workOrder.topic === 'object' && !Array.isArray(workOrder.topic)
        ? workOrder.topic
        : null
      if (!requested) return { ok: true, skipped: 'none' }
      const projectKeyValue = this.ticketProjectKey(meta)
      const activeSameProject = topic => Boolean(topic && !topic.archivedAt && !topic.mergedInto
        && (topic.projectKey || null) === projectKeyValue)
      const attach = topicId => store.linkTicket(topicId, ticketId, 'primary')
      const reused = topicId => {
        this.routerEvent({ event: 'topic.auto_assigned', ticketId, sessionId: '', actor: 'router', reason: 'advisor topic', payload: { mode: 'reused', topicId, projectKey: projectKeyValue } })
        return { ok: true, mode: 'reused', topicId }
      }
      if (requested.action === 'reuse') {
        const targetId = text(requested.topicId)
        const target = targetId ? store.topic(targetId) : null
        if (target && activeSameProject(target)) {
          attach(target.topicId)
          return reused(target.topicId)
        }
        // A hallucinated or cross-project reuse falls through to create/dedupe.
      }
      let title = clip(text(requested.title), 60)
      if (!title) {
        const fallback = topicSuggestions({
          goal: ticket.goal, projectKey: projectKeyValue,
          topics: store.topics(), links: store.links(), tickets: store.tickets(), limit: 3,
        }).topics.find(item => item.score >= 0.45)
        if (fallback) {
          attach(fallback.topicId)
          return reused(fallback.topicId)
        }
        return degrade('topic_title_required', 'advisor topic.create has no title and no high-score suggestion')
      }
      const candidates = store.topics().filter(activeSameProject)
      const normalized = title.toLowerCase()
      const duplicate = candidates.find(topic => String(topic.title).trim().toLowerCase() === normalized)
        || candidates.find(topic => topicMatchScore(title, topic.title) >= 0.75)
      if (duplicate) {
        attach(duplicate.topicId)
        return reused(duplicate.topicId)
      }
      const created = store.addTopic({ title, brief: text(requested.brief), projectKey: projectKeyValue })
      attach(created.topicId)
      this.routerEvent({ event: 'topic.auto_assigned', ticketId, sessionId: '', actor: 'router', reason: 'advisor topic', payload: { mode: 'created', topicId: created.topicId, projectKey: projectKeyValue } })
      return { ok: true, mode: 'created', topicId: created.topicId }
    } catch (error) {
      return degrade(error && error.code ? error.code : 'topic_assign_failed', error && error.message ? error.message : error)
    }
  }

  async planTicketStateless(ticket, meta = {}, request = null, extra = '') {
    const ticketId = String(ticket.ticketId)
    const started = Date.now()
    if (this.v2.workOrder(ticketId)) {
      const dispatched = await this.dispatchTicket(ticketId, '')
      return { ...dispatched, ticketId, stateless: true }
    }
    const { snapshot, degraded } = this.advisorSnapshot(ticket, meta)
    const system = advisorPlanSystemPrompt()
    const hints = this.advisorRoutingHints(ticket, meta)
    const user = buildAdvisorPlanInput({ ticket, request, meta, extra: [extra, hints].filter(Boolean).join('\n\n'), snapshot, degraded })
    let parsed
    let lastError
    let lastRun
    let usage = { input: 0, output: 0, total: 0 }
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        lastRun = await this.callAdvisorModel({ system, user })
        usage = {
          input: Number(lastRun.usage && lastRun.usage.input ? lastRun.usage.input : 0),
          output: Number(lastRun.usage && lastRun.usage.output ? lastRun.usage.output : 0),
          total: Number(lastRun.usage && lastRun.usage.total ? lastRun.usage.total : 0),
        }
        parsed = parseAdvisorOutput(lastRun.text)
        if (parsed.ok) break
        lastError = Object.assign(new Error(parsed.message), { code: parsed.code })
      } catch (error) {
        lastError = error
        if (error && error.attempts) lastRun = { ...lastRun, attempts: error.attempts, latencyMs: error.latencyMs }
        // callAdvisorModel already spent the two-attempt budget.
        break
      }
    }
    const latencyMs = lastRun && lastRun.latencyMs ? lastRun.latencyMs : Date.now() - started
    const attempts = lastRun && lastRun.attempts ? lastRun.attempts : 2
    if (!parsed || !parsed.ok) {
      const code = lastError && lastError.code ? lastError.code : 'advisor_model_failed'
      this.routerEvent({
        event: 'advisor.plan.failed', ticketId, sessionId: '', actor: 'advisor', reason: 'stateless llm',
        payload: { briefSummary: clip(ticket.goal, 300), cognitionIds: snapshot.files || [], degraded, latencyMs, attempts, usage, code, message: String(lastError && lastError.message ? lastError.message : lastError) },
      })
      const failure = new Error(String(lastError && lastError.message ? lastError.message : lastError))
      failure.code = ['invalid_output', 'summary_required', 'steps_required', 'reason_required'].includes(code) ? code : 'advisor_model_failed'
      failure.attempts = attempts
      failure.latencyMs = latencyMs
      throw failure
    }
    if (parsed.action === 'plan') {
      // Attach the optional Advisor topic before the WorkOrder is persisted and
      // dispatched; failures only degrade and never block the ticket.
      await this.assignTicketTopic(ticket, meta, parsed.workOrder)
      const persisted = this.persistWorkOrder(ticketId, parsed.workOrder, { by: 'advisor', sessionId: '', reason: 'stateless llm' })
      if (!persisted.ok) {
        this.routerEvent({ event: 'advisor.plan.failed', ticketId, sessionId: '', actor: 'advisor', reason: 'stateless llm', payload: { briefSummary: clip(ticket.goal, 300), cognitionIds: snapshot.files || [], degraded, latencyMs, attempts, usage, code: persisted.code, message: persisted.message } })
        const failure = new Error(persisted.message)
        failure.code = persisted.code
        throw failure
      }
      const dispatched = await this.dispatchTicket(ticketId, '')
      this.routerEvent({
        event: 'advisor.plan', ticketId, sessionId: '', actor: 'advisor', reason: 'stateless llm',
        payload: {
          briefSummary: clip(ticket.goal, 300), cognitionIds: snapshot.files || [], degraded, latencyMs, attempts, usage,
          workOrderSummary: clip(persisted.workOrder.summary, 200), steps: persisted.workOrder.steps.length,
          ...(persisted.escalationPolicy ? { escalationPolicy: persisted.escalationPolicy } : {}),
          dispatched: { ok: Boolean(dispatched && dispatched.ok), ...(dispatched && dispatched.workerSessionId ? { workerSessionId: dispatched.workerSessionId } : {}) },
        },
      })
      return { ...dispatched, ticketId, stateless: true, degraded, workOrder: persisted.workOrder }
    }
    const blocked = await this.blockTicketInternal(ticketId, parsed.block)
    this.routerEvent({ event: 'dispatch.blocked', ticketId, sessionId: '', actor: 'advisor', reason: 'stateless blocked', payload: { briefSummary: clip(ticket.goal, 300), reason: parsed.block.reason, question: parsed.block.question || '', degraded } })
    return { ...blocked, stateless: true, degraded }
  }


  async ensureWorker(scope = 'global', projectId = null, projectCwd = undefined, ticketId = null, preset = null, reservation = null, routing = {}) {
    const held = reservation || Symbol('ensureWorker')
    try {
      const workspaceCwd = text(projectCwd)
      // A request configures only new Workers, never an idle reused Worker.
      const requestedPreset = text(preset)
      const workerPreset = this.workerPresets.includes(requestedPreset) ? requestedPreset : DEFAULT_WORKER_PRESET
      const ticketTags = normalizeTags(routing.ticketTags, TAG_LIMIT)
      const primaryTopicId = routing.topicId || null
      const requireTagMatch = routing.requireTagMatch === true
      const selectable = { scope, projectId, projectCwd: workspaceCwd, workerType: 'work', ticketTags, requireTagMatch }
      const eligible = this.v2.workers().filter(item => this.isWorkerSelectable(item, selectable))
      // Deterministic affinity ranking replaces the old lastUsedAt-only sort;
      // liveness/occupancy checks stay in isWorkerSelectable above.
      const candidates = rankCandidateWorkers(eligible, {
        workerType: 'work', ticketTags, primaryTopicId, requireTagMatch,
        ...(workspaceCwd ? { projectCwd: workspaceCwd } : {}),
      }).map(entry => entry.worker)
      const reusable = await this.selectResolvableWorker(candidates, ticketId, held, workspaceCwd || null, { ticketTags, requireTagMatch })
      if (reusable) return { sessionId: reusable.sessionId, created: false, preset: reusable.preset || DEFAULT_WORKER_PRESET, meta: reusable }
      const created = await this.createIdleWorker({
        scope, projectId, projectCwd: workspaceCwd || null, workerType: 'work', preset: workerPreset,
        cwd: workspaceCwd || join(this.stateDir, 'workers'),
      }, 'worker.create', held)
      // New Workers stay generic (no explicit tags, dedicated=false) but absorb
      // this ticket's tags and primary topic as soft routing hints.
      if (created && created.meta && (ticketTags.length || primaryTopicId)) {
        const explicitTags = Array.isArray(created.meta.tags) ? created.meta.tags : []
        this.v2.addWorker(created.sessionId, {
          autoTags: mergeTags(ticketTags, created.meta.autoTags || []).filter(tag => !explicitTags.includes(tag)),
          ...(primaryTopicId ? { recentTopics: [primaryTopicId, ...(created.meta.recentTopics || []).filter(id => id !== primaryTopicId)].slice(0, 5) } : {}),
        }, { trigger: 'worker.learn' })
        return { ...created, meta: this.v2.worker(created.sessionId) }
      }
      return created
    } finally {
      // Dispatch callers retain the same token until their ticket is claimed.
      if (!reservation) this.releaseWorkerReservations(held)
    }
  }


  /**
   * Drop Worker bindings whose Session no longer exists. Archived Sessions keep
   * their binding (unarchiving is a user action) and are simply not selectable.
   * Idempotent: a second run finds nothing to remove.
   */
  /** One startup pass repairs old working/null rows only with positive idle evidence. */
  async reconcileWorkerStates() {
    let repaired = 0
    for (const item of this.v2.workers()) {
      const workerId = String(item.sessionId)
      if (item.status !== 'working' || item.currentTicketId || this.workerTicketId(item)
        || this.workerReservations.has(workerId) || this.turnStartedAt.has(workerId)) continue
      let state
      try {
        state = await this.ctx.sessionController.state({ sessionId: workerId }, new AbortController().signal)
      } catch (error) {
        this.log('warn', 'could not reconcile worker state for ' + workerId + ': ' + String(error && error.message ? error.message : error))
        continue
      }
      // Unknown is not idle. Pending input/queued turns also count as live
      // activity even if the host reports running=false at this boundary.
      if (!state || state.running !== false || state.active === true
        || (Array.isArray(state.queue) && state.queue.length)
        || (Array.isArray(state.pendingInput) && state.pendingInput.length)) continue
      const current = this.v2.worker(workerId)
      // The read may race a turn/start or dispatch; recheck synchronously before write.
      if (!current || current.status !== 'working' || current.currentTicketId || this.workerTicketId(current)
        || this.workerReservations.has(workerId) || this.turnStartedAt.has(workerId)) continue
      const before = { status: current.status, currentTicketId: null }
      const after = { status: 'idle', currentTicketId: null }
      const reason = 'working without a ticket; host confirms no active turn or queued input'
      this.v2.addWorker(workerId, after, { trigger: 'startup.reconcile' })
      this.routerEvent({
        event: 'worker.state.reconciled', ticketId: null, sessionId: workerId,
        actor: 'router', reason, payload: { workerId, before, after, reason },
      })
      repaired += 1
    }
    return repaired
  }

  async reconcileWorkerBindings() {
    const archived = this.archivedSessionIds()
    let removed = 0
    for (const item of this.v2.workers()) {
      if (item.status === 'working' && item.currentTicketId) continue
      const id = String(item.sessionId || '')
      if (!id || archived.has(id)) continue
      const started = Date.now()
      let message = ''
      let missing = false
      try {
        const resolved = await this.service.resolve(id)
        if (resolved && !('error' in resolved)) continue
        message = resolved && resolved.error ? String(resolved.error.message || resolved.error.code || '') : ''
        const code = resolved && resolved.error && resolved.error.code ? String(resolved.error.code) : ''
        missing = /not-found|not_found|missing/i.test(code + ' ' + message)
      } catch (error) {
        message = String(error && error.message ? error.message : error)
        missing = /not-found|not_found|missing/i.test(message)
      }
      // A transient resolve failure is not proof the session is gone; keep the
      // binding and let the next selection retry it.
      if (!missing) continue
      this.v2.removeWorker(id)
      removed += 1
      this.routerEvent({
        event: 'worker.reconcile_removed',
        ticketId: null,
        sessionId: id,
        actor: 'router',
        reason: 'session_missing',
        payload: { workerId: id, error: message, latencyMs: Date.now() - started },
      })
    }
    if (removed) this.log('info', 'reconciled worker bindings: removed ' + removed + ' stale binding(s)')
    return removed
  }

  /**
   * One reusable reflection Worker, or a fresh one. Its cwd is a state
   * directory, never a project: the reflection Worker reads repository files
   * through read-only tools only and cannot write code.
   */
  async ensureReflectionWorker(scope = 'global', reservation = null, ticketId = null) {
    const held = reservation || Symbol('ensureReflectionWorker')
    try {
      const candidates = this.v2.workers()
        .filter(item => this.isWorkerSelectable(item, { scope, workerType: 'reflection' }))
        .sort((a, b) => (b.lastUsedAt || b.createdAt || 0) - (a.lastUsedAt || a.createdAt || 0))
      const reusable = await this.selectResolvableWorker(candidates, ticketId, held, null)
      if (reusable) return { sessionId: reusable.sessionId, created: false, preset: reusable.preset || DEFAULT_WORKER_PRESET, meta: reusable }
      return await this.createIdleWorker({
        scope, workerType: 'reflection', preset: DEFAULT_WORKER_PRESET, cwd: join(this.stateDir, 'reflection-workers'),
      }, 'worker.create.reflection', held)
    } finally {
      if (!reservation) this.releaseWorkerReservations(held)
    }
  }

  /**
   * Remember when a session last produced any event. Worker sessions emit
   * step/tool/turn events while they run, so this is the real progress signal;
   * it is only used for stuck detection, never for dispatch or state.
   */
  recordSessionActivity(sessionId, event) {
    const id = String(sessionId || '')
    if (!id) return
    const stamp = event && Number.isFinite(event.time) ? event.time
      : event && Number.isFinite(event.at) ? event.at
        : now()
    const previous = this.sessionLastEventAt.get(id) || 0
    if (stamp > previous) this.sessionLastEventAt.set(id, stamp)
    // Keep the map bounded: drop the oldest inserted entry when it grows.
    if (this.sessionLastEventAt.size > 500) {
      const oldest = this.sessionLastEventAt.keys().next()
      if (!oldest.done && oldest.value !== id) this.sessionLastEventAt.delete(oldest.value)
    }
  }

  /** Does this ticket's executor currently hold an unclosed turn? */
  ticketActiveTurn(ticket) {
    if (!ticket) return false
    const executor = String(ticket.executor || '')
    if (!executor) return false
    return this.turnStartedAt.has(executor)
  }

  /**
   * Shared health fields for every ticket projection. chatbot_status (ticket
   * view) and chatbot_worker_config get both call this, so one ticket cannot
   * report two different stuck states.
   */
  ticketHealth(ticket, at = now()) {
    const executor = String(ticket && ticket.executor ? ticket.executor : '')
    return computeTicketHealth(ticket, {
      activeTurn: this.ticketActiveTurn(ticket),
      now: at,
      thresholdMinutes: this.stuckThresholdMinutes,
      sessionThresholdMinutes: this.stuckSessionThresholdMinutes,
      sessionLastEventAt: executor ? this.sessionLastEventAt.get(executor) : undefined,
    })
  }

  ticketView(ticket) {
    if (!ticket) return null
    const meta = this.v2.data.tickets[ticket.ticketId] || null
    const reports = this.v2.reportsFor(ticket.ticketId, 1)
    const health = this.ticketHealth(ticket)
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
      // Stuck detection: a working ticket with no open turn, or with no event
      // for longer than the threshold, is reported instead of looking healthy.
      activeTurn: health.activeTurn,
      lastEventAgeMinutes: health.lastEventAgeMinutes,
      stuckSuspect: health.stuckSuspect,
      stuckReason: health.stuckReason,
      createdAt: ticket.createdAt,
      updatedAt: ticket.updatedAt,
      phase: meta && meta.phase ? meta.phase : null,
      workerId: meta && meta.workerId ? meta.workerId : null,
      // Which lessons were injected into this ticket's brief (traceability).
      usedLessons: Array.isArray(meta && meta.usedLessons) ? meta.usedLessons : [],
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

  async notifyChat(message) {
    const chatbot = this.v2.chatSessionId
    if (!chatbot) return false
    try {
      await this.promptSession(chatbot, routerNotice(message))
      return true
    } catch (error) {
      this.log('warn', 'could not notify Chat: ' + String(error && error.message ? error.message : error))
      return false
    }
  }

  /**
   * Idempotent startup migration for role-session titles. Only sessions that
   * are bound in v2 (chatbot, advisors, managed Workers, future Sage) are
   * touched; ordinary user sessions never appear here and are never renamed.
   * A failure is logged and skipped so one missing/archived session cannot stop
   * startup or block the rest of the migration.
   */
  async renameRoleSessions() {
    const archived = this.archivedSessionIds()
    const renamed = []
    const skipped = []
    const signal = new AbortController().signal
    const currentTitle = async (sessionId, kind = 'role') => {
      const id = String(sessionId)
      try {
        // The host projections() API requires an AbortSignal; omitting it made
        // every read throw inside signal.throwIfAborted() and silently skip all
        // sessions.
        const projection = await this.ctx.sessionController.projections({ sessionId: id }, signal)
        if (!projection || !projection.values) {
          const message = 'projection missing'
          this.log('warn', 'could not read title for ' + id + ' (' + message + ')')
          this.routerEvent({ event: 'role.rename.failed', ticketId: null, sessionId: id, actor: 'router', reason: 'read-title', payload: { kind, phase: 'read-title', error: message } })
          return null
        }
        return text(projection.values.title)
      } catch (error) {
        const message = String(error && error.message ? error.message : error)
        this.log('warn', 'could not read title for ' + id + ': ' + message)
        this.routerEvent({ event: 'role.rename.failed', ticketId: null, sessionId: id, actor: 'router', reason: 'read-title', payload: { kind, phase: 'read-title', error: message } })
        return null
      }
    }
    const move = async (sessionId, title, kind) => {
      const id = String(sessionId || '')
      if (!id) return
      if (archived.has(id)) {
        skipped.push({ sessionId: id, kind, reason: 'archived' })
        return
      }
      const before = await currentTitle(id, kind)
      if (before === null) {
        skipped.push({ sessionId: id, kind, reason: 'unavailable' })
        return
      }
      if (before === title) {
        skipped.push({ sessionId: id, kind, reason: 'already-named' })
        return
      }
      try {
        await this.ctx.sessionController.rename({ sessionId: id, title })
        renamed.push({ sessionId: id, kind, from: before, to: title })
      } catch (error) {
        const message = String(error && error.message ? error.message : error)
        this.log('warn', 'could not rename ' + kind + ' session ' + id + ': ' + message)
        this.routerEvent({ event: 'role.rename.failed', ticketId: null, sessionId: id, actor: 'router', reason: 'rename', payload: { kind, phase: 'rename', from: before, to: title, error: message } })
        skipped.push({ sessionId: id, kind, reason: 'rename-failed' })
      }
    }

    await move(this.v2.chatSessionId, roleSessionTitle('chat'), 'chat')
    for (const advisor of this.v2.advisors()) {
      if (advisor && advisor.sessionId) await move(advisor.sessionId, roleSessionTitle('advisor'), 'advisor')
    }
    for (const worker of this.v2.workers()) {
      const reflection = worker.workerType === 'reflection'
      let seq = Number.isSafeInteger(worker.seq) && worker.seq > 0 ? worker.seq : 0
      if (!seq) {
        seq = reflection ? this.v2.nextReflectionSeq() : this.v2.nextWorkerSeq()
        this.v2.addWorker(worker.sessionId, { seq })
      }
      await move(worker.sessionId, roleSessionTitle(reflection ? 'reflection' : 'worker', seq), reflection ? 'reflection' : 'worker')
    }
    const sageSessionId = this.v2.sageSessionId || (this.v2.data && this.v2.data.sage && this.v2.data.sage.sessionId)
    if (sageSessionId) await move(sageSessionId, roleSessionTitle('sage'), 'sage')
    const counts = skipped.reduce((acc, item) => {
      acc[item.reason] = (acc[item.reason] || 0) + 1
      return acc
    }, {})
    this.log('info', 'role-session rename: renamed ' + renamed.length + ', skipped ' + skipped.length + ' (' + Object.entries(counts).map(([key, value]) => key + ' ' + value).join(', ') + ')')
    return { renamed, skipped }
  }

  async sessionTitle(summary) {
    const known = summary && summary.projections && summary.projections.values
      ? text(summary.projections.values.title)
      : ''
    if (known) return known
    try {
      const projection = await this.ctx.sessionController.projections({ sessionId: String(summary.sessionId) }, new AbortController().signal)
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
    // Ria's own sessions (Chat, Advisors, Workers, reflection) live under
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
   * Report a session that stopped to ask a human, in the Chat's channel
   * only. Read-only: no approval decision and no answer ever comes from here,
   * so both listeners delegate with next() immediately.
   *
   * prepend is required. The host web bundle loads before profile plugins and
   * dsh-api-remotes forwards these two waterfalls to the browser, holding the
   * request until the user acts; a normally registered listener would never
   * run (same ordering as the host approval waterfall and docs/architecture.md §4.4).
   */
  subscribeBlockedNotices() {
    const prepend = { prepend: true }
    // Tool arguments are cached before execute() asks for an escalation; the
    // approval request only carries toolName/callId/reason. No timer prunes the
    // cache: size/age bounds are applied on write and tools/result deletes.
    const disposeToolCall = this.ctx.on('tools/pre-execute', async (exec, next) => {
      this.rememberApprovalToolCall(exec)
      return await next()
    }, prepend)
    const disposeToolResult = this.ctx.on('tools/result', exec => {
      this.recordSuccessfulApprovalOperation(String(exec && exec.agent && exec.agent.id || ''), exec)
      this.forgetApprovalToolCall(exec)
    })
    const disposeApproval = this.ctx.on('approval/request', (request, next) => this.noticeApproval(request, next), prepend)
    const disposeQuestion = this.ctx.on('user-questions/request', (request, next) => this.noticeQuestion(request, next), prepend)
    const disposeWatch = this.subscribeWatch()
    return () => {
      try { disposeToolCall() } catch { /* already removed */ }
      try { disposeToolResult() } catch { /* already removed */ }
      try { disposeApproval() } catch { /* already removed */ }
      try { disposeQuestion() } catch { /* already removed */ }
      try { disposeWatch() } catch { /* already removed */ }
    }
  }

  async noticeApproval(request, next) {
    let raced = false
    try {
      const sessionId = String(request && request.agent && request.agent.id !== undefined ? request.agent.id : '')
      const toolName = text(request.toolName) || 'unknown'
      // Managed Workers under a ticket are decided by risk. approval/asked has
      // already evaluated the same request, so the memo makes both listeners
      // agree and keeps the audit line exactly-once.
      if (sessionId && this.roleFor(sessionId) === 'worker') {
        const terminal = this.approvalTerminals.get(this.approvalKey(sessionId, toolName, text(request.callId)))
        if (terminal && terminal.decision === 'superseded') return terminal.outcome || 'rejected'
        const decision = this.evaluateApprovalRisk(sessionId, toolName, text(request.callId))
        this.auditApprovalRisk(decision)
        if (decision.decision === 'auto-allow') {
          const risk = this.approvalRiskLabel(decision)
          const who = decision.ticketId ? 'ticket ' + decision.ticketId : 'worker ' + sessionId
          const what = this.riskArgv(decision) || this.riskPaths(decision).join(', ') || toolName
          const levelLabel = decision.risk.level === 'medium' ? '中风险' : '低风险'
          const toolLabel = this.approvalToolDisplay(decision)
          this.log('info', 'auto-allowed ' + toolName + ' for ' + sessionId + ' (' + risk.text + ', ' + decision.policy + ')')
          this.queueChatNotice('已自动放行' + levelLabel + '提权：' + who + ' 工具 ' + toolLabel + '「' + what + '」；判为 ' + risk.text + '（策略 ' + decision.policy + '，来源 ' + decision.policySource + '）。')
          return 'allowed-once'
        }
        // The ask path is blocked and notified by onApprovalAsked, which the
        // host runs before this waterfall. Do not duplicate the notice here.
        // Keep the live waterfall settleable: a grant resolves this deferred to
        // allowed-once; otherwise next() (human/tool budget) still decides.
        const pending = this.pendingApprovalFor(sessionId, toolName, text(request.callId))
        const settler = this.createApprovalSettler(
          sessionId,
          toolName,
          text(request.callId),
          pending ? pending.approvalId : '',
          pending ? pending.record : null,
        )
        if (request.signal) {
          settler.requestSignal = request.signal
          if (pending && pending.record) pending.record.signal = request.signal
        }
        if (settler.settled) {
          this.closeApprovalSettler(settler)
          return 'allowed-once'
        }
        const forwarded = Promise.resolve().then(() => next())
        raced = true
        try {
          return await Promise.race([forwarded, settler.promise])
        } finally {
          this.closeApprovalSettler(settler)
        }
      }
      // Chat/Advisor/Worker role sessions stay silent (Workers are handled
      // by the risk branch above).
      if (sessionId && this.roleFor(sessionId)) return await next()
      // Watched sessions are handled by subscribeWatch() (risk relay); this
      // listener must not also send the generic notice.
      if (sessionId && this.coManagement.active(sessionId)) return await next()
      // Unwatched ordinary sessions are intentionally not pushed to Chat:
      // record one trace event so the block is discoverable later.
      if (sessionId) {
        this.routerEvent({
          event: 'notice.suppressed',
          ticketId: null,
          sessionId,
          actor: 'router',
          reason: 'unwatched',
          payload: { kind: 'approval', toolName, reason: text(request.reason), at: now() },
        })
      }
    } catch (error) {
      this.log('warn', 'could not queue an approval notice: ' + String(error && error.message ? error.message : error))
      if (raced) throw error
    }
    // The decision belongs to the downstream answerer; never claim the request.
    return await next()
  }

  async noticeQuestion(request, next) {
    try {
      const sessionId = String(request && request.agent && request.agent.id !== undefined ? request.agent.id : '')
      if (sessionId && this.roleFor(sessionId)) return await next()
      if (sessionId && this.coManagement.active(sessionId)) return await next()
      if (sessionId) {
        const first = Array.isArray(request.questions) ? request.questions[0] : null
        this.routerEvent({
          event: 'notice.suppressed',
          ticketId: null,
          sessionId,
          actor: 'router',
          reason: 'unwatched',
          payload: { kind: 'question', question: clip(first && typeof first.question === 'string' ? first.question : '', 120), at: now() },
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
    return await this.notifyChat(message)
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
    // A new target must not inherit retries aimed at the old one.
    this.resetDirectSendQueue()
    return this.directInfo()
  }

  /** Send a system-style line to the WeChat Claw user without a model turn. */
  notifyDirect(text) {
    const value = String(text == null ? '' : text).trim()
    if (!value) return false
    // Direct-mode chatter is live conversation, not a ticket reply. It retries
    // in memory only and never enters the durable outbox, so a later login
    // cannot replay it as a “补发” burst.
    return this.sendDirectText(value, { key: 'notice:' + now() + ':' + randomUUID().slice(0, 8) })
  }

  forwardDirectReply(reply, event) {
    const value = String(reply == null ? '' : reply).trim()
    if (!value) return
    const title = this.direct && this.direct.title ? this.direct.title : '会话'
    const targetId = this.direct && this.direct.sessionId ? this.direct.sessionId : 'target'
    const key = 'direct:' + targetId + ':' + (event && Number.isSafeInteger(event.seq)
      ? event.seq
      : createHash('sha1').update(value).digest('hex').slice(0, 12))
    this.sendDirectText('【直通·' + title + '】\n' + value, { key, event })
  }

  /**
   * One live direct message: dedupe by key, bounded in-memory retry, visible
   * failure. Never durable, never replayed on resume.
   */
  sendDirectText(text, { key, event } = {}) {
    const claw = this.service.wechatClaw
    if (!claw || typeof claw.forwardAssistant !== 'function') return false
    const value = String(text == null ? '' : text).trim()
    if (!value) return false
    const id = key || ('direct:' + createHash('sha1').update(value).digest('hex').slice(0, 12))
    const at = now()
    for (const [sentKey, sentAt] of this.directSentKeys) {
      if (at - sentAt > this.directRetryWindowMs) this.directSentKeys.delete(sentKey)
    }
    // The same event must not be sent twice: once while queued, and once after
    // delivery (a duplicated log event would otherwise show up twice).
    if (this.directSendQueue.has(id) || this.directSentKeys.has(id)) return false
    this.directSendQueue.set(id, { text: value, event, attempts: 0, firstAt: now(), lastError: '' })
    this.attemptDirectSend(id)
    return true
  }

  attemptDirectSend(id) {
    const record = this.directSendQueue.get(id)
    if (!record) return
    const claw = this.service.wechatClaw
    if (!claw || typeof claw.forwardAssistant !== 'function') return
    record.attempts += 1
    try {
      claw.forwardAssistant(record.text, record.event, {
        fallback: false,
        onSettled: result => this.settleDirectSend(id, result),
      })
    } catch (error) {
      this.settleDirectSend(id, { reason: 'send_failed', error: String(error && error.message ? error.message : error) })
    }
  }

  settleDirectSend(id, result) {
    const record = this.directSendQueue.get(id)
    if (!record) return
    const reason = result && result.reason ? String(result.reason) : 'send_failed'
    if (reason === 'delivered') {
      this.directSendQueue.delete(id)
      this.directSentKeys.set(id, now())
      if (this.directSentKeys.size > 200) {
        const oldest = [...this.directSentKeys.entries()].sort((left, right) => left[1] - right[1])
        for (const [key] of oldest.slice(0, oldest.length - 150)) this.directSentKeys.delete(key)
      }
      return
    }
    record.lastError = (result && (result.error || result.errmsg)) || reason
    const retries = record.attempts - 1
    const backoff = this.directBackoffMs[retries]
    const withinWindow = now() - record.firstAt < this.directRetryWindowMs
    if (retries < 3 && Number.isFinite(backoff) && withinWindow) {
      const timer = setTimeout(() => { this.attemptDirectSend(id) }, backoff)
      if (timer.unref) timer.unref()
      return
    }
    this.directSendQueue.delete(id)
    this.reportDirectFailure(record)
  }

  reportDirectFailure(record) {
    const reason = record.lastError || 'unknown'
    this.log('warn', 'direct message gave up after ' + record.attempts + ' attempts: ' + reason)
    const claw = this.service.wechatClaw
    if (!claw || typeof claw.forwardAssistant !== 'function') return
    const summary = String(record.text || '').replace(/\s+/g, ' ').slice(0, 60)
    try {
      claw.forwardAssistant('⚠️ 直通消息发送失败（已重试 ' + Math.max(0, record.attempts - 1) + ' 次）：' + summary, undefined, { fallback: false })
    } catch (error) {
      this.log('warn', 'could not report direct send failure: ' + String(error && error.message ? error.message : error))
    }
  }

  /** Recovery/login: live direct chatter is never replayed. */
  resetDirectSendQueue() {
    const size = this.directSendQueue.size
    this.directSendQueue.clear()
    this.directSentKeys.clear()
    return size
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
   * consumed by direct mode and must not start a Chat turn.
   */
  async directRelay(content, sessionId) {
    const chatbotId = String(this.v2.chatSessionId || '')
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
      this.resetDirectSendQueue()
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
      const multimodal = Array.isArray(content) && content.some(part => part && part.type !== 'text')
      if (multimodal) {
        const delivered = await this.promptWithImageFallback(target.sessionId, content, body, { mode: 'steer' })
        if (delivered.imagesDegraded) this.notifyDirect('直通到 ' + target.title + '：' + delivered.warning)
      } else {
        await this.promptSession(target.sessionId, body, 'steer')
      }
    } catch (error) {
      this.direct = undefined
      this.resetDirectSendQueue()
      this.notifyDirect('直通目标 ' + target.title + ' 不可用，已退出直通：'
        + String(error && error.message ? error.message : error))
    }
    return true
  }

  async chatbotDirect(args, exec) {
    if (!this.chatCaller(exec)) return { ok: false, code: 'forbidden', message: 'only the Chat may control direct mode' }
    const action = text(args.action)
    if (action === 'status') return { ok: true, ...this.directInfo() }
    if (action === 'off') {
      const previous = this.directInfo()
      this.direct = undefined
      this.resetDirectSendQueue()
      return { ok: true, active: false, previous }
    }
    if (action !== 'on') return { ok: false, code: 'invalid_action', message: 'action must be on, off or status' }
    const sessionId = text(args.sessionId)
    const title = text(args.title)
    if (!sessionId && !title) return { ok: false, code: 'session_required', message: 'sessionId or title is required for action=on' }
    return await this.enableDirect(sessionId ? { sessionId } : { title })
  }

  async chatbotGrant(args, exec) {
    if (!this.chatCaller(exec)) return { ok: false, code: 'forbidden', message: 'only the Chat may change Worker permissions' }
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
    const grantTicketId = text(args.ticketId)
    const grantTicket = grantTicketId ? this.service.tickets.ticket(grantTicketId) : null
    const sessionId = grantTicket ? text(grantTicket.executor) : text(args.sessionId)
    if (!sessionId) return { ok: false, code: 'session_required', message: 'ticketId with current executor or sessionId is required for action=set' }
    const reason = text(args.reason)
    if (!reason) return { ok: false, code: 'reason_required', message: 'reason is required for action=set' }
    const grantKind = text(args.kind) === 'emergency' ? 'emergency' : 'debug'
    const requested = {
      ...args,
      action: 'set',
      sessionId,
      reason,
      grantKind,
      // The user is the authority here; the tool is only callable from the
      // Chat after an explicit request. GrantService verifies the target is
      // a top-level session and enforces the escalation/TTL/audit rules.
      userConfirmed: true,
    }
    // Bind to the current ticket only for a managed Worker. Independent
    // sessions have no ticket and must still be grantable.
    const worker = this.v2.worker(sessionId)
    if (!text(requested.ticketId) && worker) {
      requested.ticketId = worker.currentTicketId || (this.ticketForApproval(sessionId) || {}).ticketId || undefined
    }
    try {
      const grant = await this.service.grants.set(requested)
      const approvals = this.settleApprovalsForGrant(sessionId, grant)
      if (grant.ticketId) await this.finalizeSavedDone(grant.ticketId)
      if (approvals.settled.length) {
        const items = approvals.settled.slice(0, 5).map(item => {
          const target = item.ticketId ? '（ticket ' + item.ticketId + '）' : ''
          return '工具 ' + (item.toolName || 'unknown') + target
        })
        this.queueChatNotice('授权已生效，并已放行此前挂起的请求（grantId ' + grant.grantId + '）：' + items.join('；') + '。')
      }
      if (approvals.unresolved.length) {
        const items = approvals.unresolved.slice(0, 5).map(item => '工具 ' + (item.toolName || 'unknown'))
        this.queueChatNotice('授权已生效（grantId ' + grant.grantId + '），但此前挂起的请求无法直接放行，请 Worker 重试或在必要时 resume：' + items.join('；') + '。')
      }
      return {
        ok: true,
        grant,
        grantKind,
        ...(approvals.settled.length ? { settledApprovals: approvals.settled } : {}),
        ...(approvals.unresolved.length ? { unresolvedApprovals: approvals.unresolved } : {}),
        ...(approvals.superseded.length ? { supersededApprovals: approvals.superseded } : {}),
      }
    } catch (error) {
      const message = String(error && error.message ? error.message : error)
      try {
        if (this.service.grants && typeof this.service.grants.audit === 'function') {
          this.service.grants.audit({ event: 'grant/rejected', sessionId, reason, grant_kind: grantKind, error: message })
        }
      } catch { /* audit failures never block the tool result */ }
      return { ok: false, code: 'grant_rejected', message }
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

  async sendWatchRelay(watch, body, event) {
    const formatted = '【协管·' + (watch.titleSnapshot || watch.sessionId) + '】\n' + body
    this.watchRelayLog.push({ watchId: watch.watchId, sessionId: watch.sessionId, text: formatted, at: now() })
    if (this.watchRelayLog.length > 200) this.watchRelayLog.splice(0, this.watchRelayLog.length - 150)
    const claw = this.service.wechatClaw
    if (claw && typeof claw.forwardAssistant === 'function') {
      const result = claw.forwardAssistant(formatted, event || {}, { fallback: false })
      if (result === false) throw new Error('wechat claw rejected relay')
      const reason = result && typeof result === 'object' ? String(result.reason || '') : ''
      if (reason === 'send_failed' || reason === 'extract_failed') throw new Error('wechat claw ' + reason)
      if (reason === 'delivered') return
      // No configured channel / paused / empty: keep the text visible in the
      // Chat UI instead of silently dropping it.
      await this.notifyChat(formatted)
      return
    }
    // No external channel mounted (tests/headless): deliver through the Chat
    // prompt so the text is still user-visible.
    await this.notifyChat(formatted)
  }

  async sessionCwdFor(sessionId) {
    try {
      const listed = await this.ctx.sessionController.list({})
      const item = Array.isArray(listed && listed.items)
        ? listed.items.find(entry => String(entry && entry.sessionId) === String(sessionId))
        : null
      return text(item && item.cwd)
    } catch {
      return ''
    }
  }

  async evaluateWatchApproval(request) {
    const sessionId = String(request && request.agent && request.agent.id !== undefined ? request.agent.id : '')
    const watch = sessionId ? this.coManagement.active(sessionId) : null
    if (!watch) return null
    const toolName = text(request.toolName) || 'unknown'
    const callId = text(request.callId)
    const cached = this.approvalToolCalls.get(this.approvalKey(sessionId, toolName, callId))
    const args = cached && cached.toolName === toolName ? cached.args : {}
    const cwd = await this.sessionCwdFor(sessionId)
    const workspace = cwd
    let settings = {}
    try { settings = this.service.store.settings() } catch { settings = {} }
    const resolved = resolveEscalationPolicy({ ticket: {}, settings })
    const justification = text(request.reason) || text(args.justification)
    const inner = PTC_TRANSPORTS.has(toolName)
      ? (cached && cached.inner ? cached.inner : parseTransportCall(toolName, args))
      : null
    const risk = PTC_TRANSPORTS.has(toolName)
      ? this.classifyTransportRisk(inner, toolName, { cwd, workspace, justification })
      : classifyRisk({ toolName, args, cwd, workspace, justification })
    const decision = decideEscalation(risk.level, resolved.policy)
    return {
      watch,
      sessionId,
      toolName,
      callId,
      risk,
      decision,
      policy: resolved.policy,
      policySource: resolved.source,
    }
  }

  auditWatchApproval(evaluation) {
    const grantService = this.service && this.service.grants
    if (!grantService || typeof grantService.audit !== 'function') return
    try {
      grantService.audit({
        event: 'approval/decision',
        ticketId: null,
        sessionId: evaluation.sessionId,
        tool: evaluation.toolName,
        callId: evaluation.callId || null,
        level: evaluation.risk.level,
        reasons: evaluation.risk.reasons,
        decision: evaluation.decision === 'auto-allow' ? 'auto-allow' : 'ask',
        policy: evaluation.policy,
        policySource: evaluation.policySource,
        reason: 'watch-risk',
        kind: 'risk',
      })
    } catch (error) {
      this.log('warn', 'could not audit watch approval: ' + String(error && error.message ? error.message : error))
    }
  }

  async watchApproval(request, next) {
    const evaluation = await this.evaluateWatchApproval(request)
    if (!evaluation) return await next()
    const title = evaluation.watch.titleSnapshot || evaluation.sessionId
    if (evaluation.decision === 'auto-allow') {
      this.auditWatchApproval(evaluation)
      this.queueChatNotice('【协管·' + title + '】已自动放行低风险提权：工具 ' + (this.riskArgv({ risk: evaluation.risk }) || evaluation.toolName) + '（原因：' + evaluation.risk.reasons.join('；') + '）。')
      return 'allowed-once'
    }
    this.auditWatchApproval(evaluation)
    this.queueChatNotice('【协管·' + title + '】需要你决定的提权：level=' + evaluation.risk.level + '，工具 ' + evaluation.toolName + '，原因：' + evaluation.risk.reasons.join('；') + '。')
    return await next()
  }

  async watchQuestion(request, next) {
    const sessionId = String(request && request.agent && request.agent.id !== undefined ? request.agent.id : '')
    const watch = sessionId ? this.coManagement.active(sessionId) : null
    if (!watch) return await next()
    const first = Array.isArray(request.questions) ? request.questions[0] : null
    this.coManagement.onUserQuestion(sessionId, first && first.question ? first.question : '', {
      questionId: first && first.id ? first.id : '',
      callId: request.callId || '',
    })
    // Delegate to the host answerer: watch never answers a question itself.
    return await next()
  }

  subscribeWatch() {
    const prepend = { prepend: true }
    const disposeApproval = this.ctx.on('approval/request', (request, next) => this.watchApproval(request, next), prepend)
    const disposeQuestion = this.ctx.on('user-questions/request', (request, next) => this.watchQuestion(request, next), prepend)
    return () => {
      try { disposeApproval() } catch { /* already removed */ }
      try { disposeQuestion() } catch { /* already removed */ }
    }
  }

  handleWatchEvent(sessionId, event) {
    const watch = this.coManagement.active(sessionId)
    if (!watch) return false
    if (event.type === 'assistant/message') {
      const seq = Number.isSafeInteger(event.seq) ? event.seq : undefined
      const prose = assistantProse(event)
      this.coManagement.onAssistant(sessionId, { seq, text: prose, event })
      return true
    }
    if (event.type === 'user/message') {
      const data = event.data || {}
      const source = data.source && typeof data.source === 'object' ? data.source : {}
      if (source.kind && source.kind !== 'user') return false
      if (String(source.rpcId || '').startsWith(HOST_REQUEST_PREFIX)) return true
      const body = contentText(data.content)
      const seq = Number.isSafeInteger(event.seq) ? event.seq : undefined
      this.coManagement.onUserMessage(sessionId, { seq, text: body, event })
      // Keep the normal session-event path alive for user messages.
      return false
    }
    return false
  }

  async reconcileWatches() {
    const sessions = await this.independentSessions()
    const ids = new Set(sessions.map(item => String(item.sessionId)))
    for (const watch of this.coManagement.watches()) {
      if (watch.status === 'active' && !ids.has(watch.sessionId)) {
        this.coManagement.markStale(watch.sessionId, '会话已归档、删除或不再可用')
      }
    }
  }

  async chatbotWatch(args, exec) {
    if (!this.chatCaller(exec)) return { ok: false, code: 'forbidden', message: 'only the Chat may manage watched sessions' }
    const action = text(args.action) || 'list'
    if (action === 'add') {
      const target = await this.resolveIndependentTarget({ sessionId: text(args.sessionId), title: text(args.title) })
      if (target.error) return target.error
      const added = this.coManagement.add({
        sessionId: target.session.sessionId,
        title: target.session.title,
        addedBy: String(exec.agent.id),
        options: args.options,
      })
      if (!added.ok) return added
      return { ok: true, action: 'add', watch: added.watch, sessionId: target.session.sessionId, title: target.session.title, existing: added.existing }
    }
    if (action === 'remove') {
      const removed = this.coManagement.remove({
        watchId: text(args.watchId) || text(args.id),
        sessionId: text(args.sessionId),
        all: args.all === true,
      })
      if (!removed.ok) return removed
      return { ok: true, action: 'remove', removed: removed.removed }
    }
    if (action === 'status') {
      const watch = this.coManagement.watch(text(args.watchId) || text(args.id) || text(args.sessionId))
      if (!watch) return { ok: false, code: 'watch_missing', message: 'watch not found' }
      return { ok: true, action: 'status', watch, pendingQuestions: this.coManagement.pending().filter(item => item.sessionId === watch.sessionId) }
    }
    await this.reconcileWatches()
    return { ok: true, action: 'list', watches: this.coManagement.watches() }
  }

  async handleWatchCommand(body, sessionId) {
    const command = String(body == null ? '' : body).trim()
    if (!command.startsWith('/协管') && !command.startsWith('/取消协管')) return { handled: false }
    const exec = { agent: { id: String(sessionId) } }
    try {
      const listing = /^\/协管列表\s*$/.exec(command)
      if (listing) {
        const result = await this.chatbotWatch({ action: 'list' }, exec)
        const lines = result.watches.map(item => '- ' + (item.titleSnapshot || item.sessionId) + ' [' + item.status + '] ' + item.watchId)
        return { handled: true, ok: true, reply: lines.length ? '协管列表：\n' + lines.join('\n') : '当前没有协管会话。' }
      }
      const status = /^\/协管状态(?:\s+(.+))?$/.exec(command)
      if (status) {
        const result = await this.chatbotWatch({ action: 'status', id: text(status[1]) }, exec)
        if (!result.ok) return { handled: true, ok: false, reply: '没有找到协管记录：' + (status[1] || '') }
        const watch = result.watch
        return { handled: true, ok: true, reply: '【协管·' + watch.titleSnapshot + '】' + watch.status + '；已转述 ' + watch.stats.relayed + ' 条，省略 ' + watch.stats.suppressed + ' 条；lastRelayedSeq=' + watch.cursors.lastRelayedSeq + '。' }
      }
      const remove = /^\/取消协管(?:\s+(.+))?$/.exec(command)
      if (remove) {
        const target = text(remove[1])
        const result = await this.chatbotWatch({ action: 'remove', all: target === 'all', id: target === 'all' ? '' : target, sessionId: target === 'all' ? '' : target }, exec)
        if (!result.ok) return { handled: true, ok: false, reply: result.message || '取消失败' }
        return { handled: true, ok: true, reply: '已取消 ' + result.removed + ' 个协管。' }
      }
      const add = /^\/协管\s+(.+)$/.exec(command)
      if (add) {
        const target = text(add[1])
        const result = await this.chatbotWatch({ action: 'add', sessionId: /^session-/.test(target) ? target : '', title: /^session-/.test(target) ? '' : target }, exec)
        if (!result.ok) return { handled: true, ok: false, reply: result.message || result.code || '添加失败' }
        return { handled: true, ok: true, reply: '已协管：' + result.title + '（' + result.sessionId + '）。' }
      }
      return { handled: true, ok: false, reply: '用法：/协管 <标题|id>、/取消协管 [id|all]、/协管列表、/协管状态 [id]' }
    } catch (error) {
      return { handled: true, ok: false, reply: '协管命令失败：' + String(error && error.message ? error.message : error) }
    }
  }

  async chatbotPropose(args, exec) {
    if (!this.chatCaller(exec)) return { ok: false, code: 'forbidden', message: 'only the Chat may propose user memory' }
    try {
      const proposal = this.cognition.propose({
        author: 'user',
        source: 'chat',
        scope: text(args.scope) || 'global',
        text: text(args.text),
        evidence: arrayOfText(args.evidence),
        priority: 'high',
      })
      this.routerEvent({ event: 'cognition.proposal', ticketId: null, sessionId: String(exec.agent.id), actor: 'user', reason: 'chatbot_propose', payload: { proposalId: proposal.id, priority: proposal.priority } })
      const sage = this.v2.sageSessionId
      if (sage) {
        void this.promptSession(sage, '[新用户提案] ' + proposal.text + '\n提案 id: ' + proposal.id).catch(error => this.log('warn', 'could not notify Sage: ' + String(error && error.message ? error.message : error)))
      }
      return { ok: true, proposal, queuedForSage: Boolean(sage) }
    } catch (error) {
      return { ok: false, code: error && error.code ? error.code : 'proposal_failed', message: String(error && error.message ? error.message : error) }
    }
  }

  sageCaller(exec) {
    return this.roleFor(exec && exec.agent ? exec.agent.id : '') === 'sage'
  }

  sageRead(args, exec) {
    if (!this.sageCaller(exec)) return { ok: false, code: 'forbidden', message: 'only Sage may read cognition' }
    this.cognition.ensure()
    if (args.inbox === true) return { ok: true, proposals: this.cognition.listProposals().slice(0, 50) }
    const rel = text(args.path) || 'INDEX.md'
    try {
      return { ok: true, path: rel, content: this.cognition.read(rel) }
    } catch (error) {
      return { ok: false, code: error && error.code ? error.code : 'cognition_read_failed', message: String(error && error.message ? error.message : error) }
    }
  }

  sageWrite(args, exec) {
    if (!this.sageCaller(exec)) return { ok: false, code: 'forbidden', message: 'only Sage may write cognition' }
    try {
      const result = this.cognition.write(text(args.path), args.content, {
        mode: text(args.mode) === 'append' ? 'append' : 'replace',
        reason: text(args.reason),
        source: text(args.source) || 'sage',
      })
      const proposalId = text(args.resolveProposal)
      if (proposalId) this.cognition.resolveProposal(proposalId, 'accepted')
      this.routerEvent({ event: 'cognition.write', ticketId: null, sessionId: String(exec.agent.id), actor: 'sage', reason: text(args.reason), payload: { path: result.path, mode: result.mode, bytes: result.bytes } })
      return { ok: true, ...result, ...(proposalId ? { resolvedProposal: proposalId } : {}) }
    } catch (error) {
      return { ok: false, code: error && error.code ? error.code : 'cognition_write_failed', message: String(error && error.message ? error.message : error) }
    }
  }

  async sageRequest(args, exec) {
    if (!this.sageCaller(exec)) return { ok: false, code: 'forbidden', message: 'only Sage may create research requests' }
    const mode = text(args.mode) === 'work' ? 'work' : 'reflection'
    const result = await this.requestTicket({ goal: text(args.goal), acceptance: text(args.acceptance), source: 'sage' }, exec, { mode })
    if (result && result.ok) this.v2.setTicketMeta(result.ticketId, { origin: 'sage' })
    return result
  }

  /**
   * Topic gardener: structure only. It never changes ticket state, never
   * dispatches and never stops a Worker; an archive with unfinished tickets is
   * refused by the store (topic_unfinished).
   */
  sageTopic(args, exec) {
    if (!this.sageCaller(exec)) return { ok: false, code: 'forbidden', message: 'only Sage may groom topics' }
    const action = text(args.action)
    const store = this.service.store
    const sessionId = String(exec && exec.agent ? exec.agent.id : '')
    if (action === 'list') {
      const projectKey = text(args.projectKey)
      const includeArchived = args.includeArchived === true
      const items = store.topics()
        .filter(topic => includeArchived || (!topic.archivedAt && !topic.mergedInto))
        .filter(topic => !projectKey || String(topic.projectKey || null) === projectKey)
        .map(topic => {
          const links = store.topicLinks(topic.topicId)
          const tickets = links.map(link => this.service.tickets.knownTicket(link.ticketId)).filter(Boolean)
          return {
            topicId: topic.topicId,
            title: topic.title,
            brief: topic.brief || '',
            projectKey: topic.projectKey || null,
            archived: Boolean(topic.archivedAt),
            mergedInto: topic.mergedInto || null,
            ticketCount: links.length,
            progress: topicProgressCounts(tickets),
            updatedAt: topic.updatedAt,
          }
        })
        .sort((left, right) => (right.updatedAt || 0) - (left.updatedAt || 0))
      return { ok: true, topics: items, total: items.length }
    }
    const topicId = text(args.topicId)
    const fail = error => ({ ok: false, code: error && error.code ? error.code : 'topic_failed', message: String(error && error.message ? error.message : error) })
    try {
      if (action === 'update') {
        if (!topicId) return { ok: false, code: 'topic_id_required', message: 'topicId is required for update' }
        const patch = {}
        if (args.title !== undefined) patch.title = text(args.title)
        if (args.brief !== undefined) patch.brief = text(args.brief)
        if (!Object.keys(patch).length) return { ok: false, code: 'patch_required', message: 'pass title and/or brief' }
        const topic = store.updateTopic(topicId, patch)
        this.routerEvent({ event: 'topic.updated', ticketId: null, sessionId, actor: 'sage', reason: 'sage_topic update', payload: { topicId, fields: Object.keys(patch) } })
        return { ok: true, topic }
      }
      if (action === 'merge') {
        const sourceTopicId = text(args.sourceTopicId)
        const targetTopicId = text(args.targetTopicId)
        if (!sourceTopicId || !targetTopicId) return { ok: false, code: 'topic_id_required', message: 'sourceTopicId and targetTopicId are required for merge' }
        const merged = store.mergeTopic(sourceTopicId, targetTopicId)
        this.routerEvent({ event: 'topic.merged', ticketId: null, sessionId, actor: 'sage', reason: 'sage_topic merge', payload: merged })
        return { ok: true, ...merged }
      }
      if (action === 'archive') {
        if (!topicId) return { ok: false, code: 'topic_id_required', message: 'topicId is required for archive' }
        const archived = store.archiveTopic(topicId)
        this.routerEvent({ event: 'topic.archived', ticketId: null, sessionId, actor: 'sage', reason: 'sage_topic archive', payload: { topicId } })
        return { ok: true, topic: archived }
      }
      return { ok: false, code: 'invalid_action', message: "action must be 'list', 'update', 'merge' or 'archive'" }
    } catch (error) {
      return fail(error)
    }
  }

  /** Register/list/remove an ordinary session as a co-managed ticket executor. */
  async chatbotCoManage(args, exec) {
    if (!this.chatCaller(exec)) return { ok: false, code: 'forbidden', message: 'only the Chat may manage co-managed sessions' }
    const action = text(args.action)
    if (action === 'list') {
      return {
        ok: true,
        workers: this.v2.workers().filter(isCoManaged).map(item => ({
          sessionId: item.sessionId,
          title: item.title || '',
          cwd: item.cwd || null,
          allowAutoDispatch: item.allowAutoDispatch !== false,
          tags: Array.isArray(item.tags) ? item.tags.slice() : [],
          roleNote: item.roleNote || '',
          dedicated: item.dedicated === true,
          status: item.status,
          currentTicketId: item.currentTicketId || null,
        })),
      }
    }
    // Same identity fields as chatbot_worker_config. Validation happens before
    // any write so a bad payload never half-registers a session.
    const identityPatch = {}
    if (args.tags !== undefined) {
      if (!Array.isArray(args.tags)) return { ok: false, code: 'invalid_tags', message: 'tags must be an array of tag strings' }
      identityPatch.tags = normalizeTags(args.tags, TAG_LIMIT)
    }
    if (args.roleNote !== undefined) {
      if (typeof args.roleNote !== 'string') return { ok: false, code: 'invalid_role_note', message: 'roleNote must be a string' }
      if ([...args.roleNote].length > WORKER_ROLE_NOTE_LIMIT) return { ok: false, code: 'invalid_role_note', message: 'roleNote must be at most ' + WORKER_ROLE_NOTE_LIMIT + ' characters' }
      identityPatch.roleNote = [...args.roleNote].join('')
    }
    if (args.dedicated !== undefined) {
      if (typeof args.dedicated !== 'boolean') return { ok: false, code: 'invalid_dedicated', message: 'dedicated must be a boolean' }
      identityPatch.dedicated = args.dedicated
    }
    const sessionId = text(args.sessionId)
    if (!sessionId) return { ok: false, code: 'session_required', message: 'sessionId is required' }
    if (action === 'remove') {
      if (!isCoManaged(this.v2.worker(sessionId))) return { ok: false, code: 'not_co_managed', message: sessionId + ' is not a co-managed session' }
      this.v2.removeWorker(sessionId)
      return { ok: true, removed: true, sessionId }
    }
    if (action === 'set') {
      const existing = this.v2.worker(sessionId)
      if (!isCoManaged(existing)) return { ok: false, code: 'not_co_managed', message: sessionId + ' is not a co-managed session' }
      if (!Object.keys(identityPatch).length) {
        return { ok: false, code: 'config_required', message: 'set requires tags, roleNote and/or dedicated' }
      }
      const worker = this.v2.addWorker(sessionId, identityPatch, { trigger: 'co-managed.update' })
      return {
        ok: true,
        worker: {
          sessionId: worker.sessionId,
          kind: worker.kind,
          title: worker.title,
          cwd: worker.cwd,
          allowAutoDispatch: worker.allowAutoDispatch !== false,
          tags: worker.tags,
          roleNote: worker.roleNote,
          dedicated: worker.dedicated,
        },
      }
    }
    if (action !== 'add') return { ok: false, code: 'invalid_action', message: 'action must be add, set, remove or list' }
    const existing = this.v2.worker(sessionId)
    if (existing && existing.kind === 'managed') return { ok: false, code: 'already_managed_worker', message: sessionId + ' is a managed Worker; a co-managed session must stay an ordinary session' }
    // Re-adding an existing co-managed session updates its opt-out instead of
    // failing the independent-session lookup (it is a worker now, not "ordinary").
    if (isCoManaged(existing)) {
      const worker = this.v2.addWorker(sessionId, {
        kind: CO_MANAGED_KIND,
        cwd: text(args.cwd) || existing.cwd,
        title: text(args.title) || existing.title,
        allowAutoDispatch: args.allowAutoDispatch === undefined ? existing.allowAutoDispatch !== false : args.allowAutoDispatch !== false,
        ...identityPatch,
      }, { trigger: 'co-managed.update' })
      return {
        ok: true,
        worker: {
          sessionId: worker.sessionId,
          kind: worker.kind,
          title: worker.title,
          cwd: worker.cwd,
          allowAutoDispatch: worker.allowAutoDispatch !== false,
          tags: worker.tags,
          roleNote: worker.roleNote,
          dedicated: worker.dedicated,
        },
      }
    }
    const session = await this.independentSessionById(sessionId)
    if (!session) return { ok: false, code: 'session_unavailable', message: 'ordinary session not found: ' + sessionId }
    const cwd = text(args.cwd) || text(session.cwd)
    if (!cwd || !isAbsolute(cwd)) return { ok: false, code: 'cwd_required', message: 'cwd is required and must be absolute' }
    const worker = this.v2.addWorker(sessionId, {
      kind: CO_MANAGED_KIND,
      workerType: 'work',
      scope: 'project',
      projectCwd: null,
      cwd,
      title: text(args.title) || text(session.title) || '',
      allowAutoDispatch: args.allowAutoDispatch !== false,
      status: 'idle',
      currentTicketId: null,
      registeredAt: now(),
      ...identityPatch,
    }, { trigger: 'co-managed.add' })
    return {
      ok: true,
      worker: {
        sessionId: worker.sessionId,
        kind: worker.kind,
        title: worker.title,
        cwd: worker.cwd,
        allowAutoDispatch: worker.allowAutoDispatch !== false,
        tags: worker.tags,
        roleNote: worker.roleNote,
        dedicated: worker.dedicated,
      },
    }
  }

  async chatbotSessions(args, exec) {
    if (!this.chatCaller(exec)) return { ok: false, code: 'forbidden', message: 'only the Chat may list sessions' }
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

  async chatbotNewSession(args, exec) {
    if (!this.chatCaller(exec)) return { ok: false, code: 'forbidden', message: 'only the Chat may create sessions' }
    const title = text(args.title)
    if (!title) return { ok: false, code: 'title_required', message: 'title must not be empty' }
    if (title.length > 80) return { ok: false, code: 'title_too_long', message: 'title must be at most 80 characters' }
    const rawCwd = text(args.cwd)
    if (!rawCwd) return { ok: false, code: 'cwd_required', message: 'cwd must not be empty' }
    if (!isAbsolute(rawCwd)) return { ok: false, code: 'cwd_not_absolute', message: 'cwd must be an absolute path' }
    let cwd
    try { cwd = realpathSync(rawCwd) } catch (error) {
      return { ok: false, code: 'cwd_missing', message: 'cwd does not exist: ' + rawCwd }
    }
    let stat
    try { stat = statSync(cwd) } catch (error) {
      return { ok: false, code: 'cwd_unreadable', message: 'cwd is not readable: ' + cwd }
    }
    if (!stat.isDirectory()) return { ok: false, code: 'cwd_not_directory', message: 'cwd is not a directory: ' + cwd }
    let stateRoot = this.stateDir
    try { stateRoot = realpathSync(this.stateDir) } catch { /* keep resolved */ }
    const dshHome = join(process.env.HOME || '', '.dsh')
    const blocked = (root, label) => {
      const prefix = root.endsWith(sep) ? root : root + sep
      return cwd === root || cwd.startsWith(prefix) ? label : ''
    }
    const stateReason = blocked(stateRoot, 'cwd must not be inside Ria state directory')
    if (stateReason) return { ok: false, code: 'cwd_forbidden', message: stateReason + ': ' + cwd }
    const dshReason = dshHome ? blocked(dshHome, 'cwd must not be inside ~/.dsh') : ''
    if (dshReason) return { ok: false, code: 'cwd_forbidden', message: dshReason + ': ' + cwd }
    if (cwd === sep) return { ok: false, code: 'cwd_forbidden', message: 'cwd must not be the filesystem root' }
    for (const prefix of SYSTEM_CWD_PREFIXES) {
      if (cwd === prefix || cwd.startsWith(prefix + sep)) {
        return { ok: false, code: 'cwd_forbidden', message: 'cwd must not be a system directory: ' + cwd }
      }
    }
    const preset = text(args.preset) || 'standard'
    if (!STANDARD_SESSION_PRESETS.has(preset)) {
      return { ok: false, code: 'preset_invalid', message: 'preset must be one of ' + [...STANDARD_SESSION_PRESETS].join(', ') }
    }
    const nowAt = now()
    this.newSessionCreatedAt = (this.newSessionCreatedAt || []).filter(at => nowAt - at < 60_000)
    if (this.newSessionCreatedAt.length >= 5) {
      const waitMs = Math.max(0, 60_000 - (nowAt - this.newSessionCreatedAt[0]))
      return { ok: false, code: 'session_rate_limited', message: 'at most 5 sessions per minute; retry in ' + Math.ceil(waitMs / 1000) + 's' }
    }
    const sessionId = 'session-' + randomUUID()
    let created
    try {
      created = await this.createSession({ sessionId, cwd, agentPreset: preset, title })
    } catch (error) {
      return { ok: false, code: 'session_create_failed', message: 'could not create session: ' + String(error && error.message ? error.message : error) }
    }
    this.newSessionCreatedAt.push(nowAt)
    this.routerEvent({
      event: 'session.created.by_chatbot',
      ticketId: null,
      sessionId,
      actor: 'chat',
      reason: 'chatbot_new_session',
      payload: { title, cwd, preset },
    })
    let firstMessageSent = false
    let firstMessageError = ''
    const firstMessage = text(args.firstMessage)
    if (firstMessage) {
      try {
        await this.promptSession(sessionId, firstMessage)
        firstMessageSent = true
      } catch (error) {
        firstMessageError = String(error && error.message ? error.message : error)
        this.log('warn', 'could not send first message to ' + sessionId + ': ' + firstMessageError)
      }
    }
    return { ok: true, sessionId, title, cwd, ...(firstMessage ? { firstMessageSent, ...(firstMessageError ? { firstMessageError } : {}) } : {}) }
  }

  async chatbotSendImage(args, exec) {
    if (!this.chatCaller(exec)) return { ok: false, code: 'forbidden', message: 'only the Chat may send images' }
    if (!Array.isArray(args.paths) || args.paths.length < 1 || args.paths.some(path => typeof path !== 'string')) {
      return { ok: false, code: 'image_paths_required', message: 'paths 必须包含 1–5 个本地图片绝对路径' }
    }
    if (args.paths.length > CHATBOT_IMAGE_LIMIT) return { ok: false, code: 'images_limit', message: '一次最多发送 5 张图片' }
    if (args.caption !== undefined && typeof args.caption !== 'string') return { ok: false, code: 'caption_invalid', message: 'caption 必须是文字' }
    const caption = text(args.caption)
    if (caption.length > 2000) return { ok: false, code: 'caption_too_long', message: 'caption 最多 2000 字符' }
    const unavailable = (code, message) => ({ ok: false, code, message,
      results: args.paths.map(path => ({ path, ok: false, code, error: message })) })
    const claw = this.service.wechatClaw
    if (!claw || !claw.session || claw.session.stopping || !claw.outbound || typeof claw.outbound.enqueueImage !== 'function') {
      return unavailable('claw_not_connected', '微信 Claw 尚未连接/登录，未发送图片')
    }
    if (!claw.peer || !claw.peer.userId || !claw.peer.contextToken) return unavailable('claw_no_peer', '微信 Claw 尚无可回复目标；请先发一条微信消息')
    if (claw.paused || claw.outbound.paused) return unavailable('claw_paused', '微信 Claw 推送已暂停，未发送图片')
    const prepared = await this.prepareChatImages({ images: args.paths }, { partial: true, hostValidation: false })
    if (!prepared.ok) return unavailable(prepared.code, prepared.message)
    const results = []
    let captionResult
    if (caption && prepared.files.length) {
      try {
        const sent = await claw.outbound.enqueue(caption)
        captionResult = { ok: true, messageId: typeof sent === 'string' ? sent : sent && (sent.msg_id || sent.message_id) || null }
      } catch (error) {
        // Caption is independent from image delivery; expose its failure and
        // still attempt the validated images in the same serial queue.
        captionResult = { ok: false, error: String(error && error.message || error) }
      }
    }
    for (const entry of prepared.results) {
      if (!entry.ok) {
        results.push({ path: entry.path, ok: false, code: entry.code, error: entry.message })
        continue
      }
      try {
        const file = entry.file
        // Outbound -> Claw.sendImage -> uploadClawImage -> sendItems. Never
        // substitute a file_item, base64 body, or URL for an image_item.
        const sent = await claw.outbound.enqueueImage({ name: file.name, buffer: file.buffer, mime: file.mediaType, ref: file.path })
        results.push({ path: entry.path, ok: true, messageId: typeof sent === 'string' ? sent : sent && (sent.msg_id || sent.message_id) || null })
      } catch (error) {
        results.push({ path: entry.path, ok: false, code: error && error.code || 'image_send_failed', error: String(error && error.message || error) })
      }
    }
    const sentCount = results.filter(item => item.ok).length
    const ok = sentCount === results.length && (!captionResult || captionResult.ok)
    return { ok, ...(ok ? {} : { code: sentCount ? 'images_partial' : 'images_failed' }),
      sent: sentCount, failed: results.length - sentCount, results,
      ...(captionResult ? { caption: captionResult } : {}),
      message: ok ? '图片已发送' : '部分或全部图片未发送，请查看逐张结果',
    }
  }

  async chatbotRead(args, exec) {
    if (!this.chatCaller(exec)) return { ok: false, code: 'forbidden', message: 'only the Chat may read a session' }
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

  captureChatImages(content) {
    const refs = []
    if (Array.isArray(content)) {
      for (const part of content) {
        if (!part || part.type !== 'image') continue
        const ref = part.attachment || part.image || part
        if (ref && typeof ref === 'object') refs.push(ref)
      }
    }
    this.chatbotCurrentImages = refs
    this.chatbotRecentImageMessages.unshift({ refs, at: now() })
    this.chatbotRecentImageMessages = this.chatbotRecentImageMessages.slice(0, 20)
  }

  attachmentFallbackMessages() {
    const options = this.service.options && typeof this.service.options === 'object' ? this.service.options : {}
    const raw = options.attachmentFallbackMessages !== undefined ? options.attachmentFallbackMessages : process.env.RIA_ATTACHMENT_FALLBACK_MESSAGES
    const value = Number(raw)
    return Number.isInteger(value) && value >= 0 ? value : 1
  }

  async resolveImageRef(ref) {
    if (!ref || typeof ref !== 'object') return null
    const attachmentId = String(ref.attachmentId || '')
    const shaMatch = /^sha256:([a-f0-9]{64})$/i.exec(attachmentId)
    let sha256 = text(ref.sha256) || (shaMatch ? shaMatch[1] : '')
    let path = text(ref.path) || text(ref.file) || text(ref.localPath) || text(ref.objectPath)
    const dshHome = process.env.DSH_HOME || join(process.env.HOME || '', '.dsh')
    if (!path && sha256) path = join(dshHome, 'attachments', 'v1', 'objects', sha256.slice(0, 2), sha256)
    if (!path) return { error: 'attachment has no path or sha256' }
    let stat
    try { stat = statSync(path) } catch { return { error: 'attachment missing: ' + path } }
    if (!stat.isFile() || stat.size <= 0) return { error: 'attachment is not a file: ' + path }
    if (!sha256) {
      sha256 = await new Promise((resolve, reject) => {
        const hash = createHash('sha256')
        const stream = createReadStream(path)
        stream.on('data', chunk => hash.update(chunk))
        stream.on('error', reject)
        stream.on('end', () => resolve(hash.digest('hex')))
      }).catch(() => '')
    }
    const ext = String(path).toLowerCase().split('.').pop()
    const mime = text(ref.mediaType) || text(ref.mime) || (ext === 'png' ? 'image/png' : ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : ext === 'webp' ? 'image/webp' : ext === 'gif' ? 'image/gif' : '')
    if (!mime.startsWith('image/')) return { error: 'attachment is not an image: ' + path }
    return {
      path,
      mime,
      ...(Number.isFinite(ref.width) ? { width: ref.width } : {}),
      ...(Number.isFinite(ref.height) ? { height: ref.height } : {}),
      ...(sha256 ? { sha256 } : {}),
      size: stat.size,
      oversized: stat.size > 10 * 1024 * 1024,
    }
  }

  async collectChatbotAttachments() {
    const fallback = this.attachmentFallbackMessages()
    let refs = this.chatbotCurrentImages || []
    if (!refs.length && fallback > 0) {
      refs = this.chatbotRecentImageMessages.slice(1, 1 + fallback).flatMap(item => item.refs || [])
    }
    const attachments = []
    const notes = []
    const seen = new Set()
    for (const ref of refs) {
      const item = await this.resolveImageRef(ref)
      if (!item || item.error) { if (item && item.error) notes.push(item.error); continue }
      if (item.sha256 && seen.has(item.sha256)) continue
      if (attachments.length >= 5) { notes.push('attachments truncated to 5'); break }
      if (item.sha256) seen.add(item.sha256)
      attachments.push(item)
    }
    return { attachments, notes }
  }

  /**
   * chatbot_request has exactly one meaning: create a work ticket. A legacy
   * `mode` argument is ignored so older prompts/callers keep working.
   */
  async chatbotRequest(args, exec) {
    return await this.requestTicket(args || {}, exec, { mode: 'work' })
  }

  /**
   * Internal ticket creation shared by chatbot_request (always work),
   * sage_request (work|reflection) and internal reflection tickets.
   */
  async requestTicket(args, exec, options = {}) {
    const goal = text(args.goal)
    if (!goal) return { ok: false, code: 'goal_required', message: 'goal must not be empty' }
    const acceptance = text(args.acceptance)
    // The ticket kind is internal: there is no answer mode any more. A work
    // ticket is planned and dispatched; a reflection ticket is read-only.
    const mode = options.mode === 'reflection' ? 'reflection' : 'work'
    // Optional preset for a newly created work Worker. An idle Worker is reused
    // with its existing preset (see ensureWorker), so this only affects creation.
    const requestedPreset = text(args.workerPreset)
    if (requestedPreset) {
      if (mode !== 'work') {
        return { ok: false, code: 'worker_preset_not_supported', message: 'workerPreset is only valid for mode=work' }
      }
      if (!this.workerPresets.includes(requestedPreset)) {
        return { ok: false, code: 'invalid_worker_preset', message: 'workerPreset must be one of ' + this.workerPresets.join(', ') }
      }
    }
    const workerPreset = requestedPreset || null
    const hasWorkerId = args.workerId !== undefined
    const hasWorkerSeq = args.workerSeq !== undefined
    if ((hasWorkerId || hasWorkerSeq) && mode !== 'work') {
      return { ok: false, code: 'worker_selector_not_supported', message: 'workerId/workerSeq are only valid for mode=work' }
    }
    if (hasWorkerId && hasWorkerSeq) {
      return { ok: false, code: 'invalid_worker_selector', message: 'pass only one of workerId or workerSeq' }
    }
    const workerSelection = {}
    if (hasWorkerId) {
      if (!text(args.workerId)) return { ok: false, code: 'invalid_worker_selector', message: 'workerId must be a non-empty string' }
      workerSelection.workerId = text(args.workerId)
    }
    if (hasWorkerSeq) {
      if (!Number.isSafeInteger(args.workerSeq) || args.workerSeq < 1) {
        return { ok: false, code: 'invalid_worker_selector', message: 'workerSeq must be a positive integer' }
      }
      // work/reflection have independent sequence counters. Resolve a work
      // sequence once and persist its id so it cannot point at a replacement.
      const target = this.findWorker({ seq: args.workerSeq }, { workerType: 'work' })
      if (target.error) return target.error
      workerSelection.workerId = target.worker.sessionId
      workerSelection.workerSeq = args.workerSeq
    }
    if (args.preferredTags !== undefined && !Array.isArray(args.preferredTags)) {
      return { ok: false, code: 'invalid_preferred_tags', message: 'preferredTags must be an array of tag strings' }
    }
    const preferredTags = normalizeTags(args.preferredTags, TAG_LIMIT)
    const requestedTopicId = text(args.topicId)
    if (requestedTopicId) {
      const topic = this.service.store.topic(requestedTopicId)
      if (!topic) return { ok: false, code: 'topic_missing', message: 'topic not found: ' + requestedTopicId }
      if (topic.archivedAt || topic.mergedInto) return { ok: false, code: 'topic_archived', message: 'topic is archived or merged: ' + requestedTopicId }
    }
    const requestedPolicy = text(args.escalationPolicy)
    const escalationPolicy = normalizeEscalationPolicy(requestedPolicy)
    if (requestedPolicy && !escalationPolicy) {
      return { ok: false, code: 'invalid_escalation_policy', message: 'escalationPolicy must be one of ' + ESCALATION_POLICIES.join(', ') }
    }
    const attachmentResult = args.attachImages === false ? { attachments: [], notes: [] } : await this.collectChatbotAttachments()
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
    const source = text(args.source) || 'chat'
    const request = {
      requestId,
      goal,
      acceptance,
      workspace: projectCwd,
      mode,
      ...workerSelection,
      ...(preferredTags.length ? { preferredTags } : {}),
      ...(requestedTopicId ? { topicId: requestedTopicId } : {}),
      source,
      sessionId: String(exec && exec.agent ? exec.agent.id : ''),
      createdAt: now(),
    }
    this.v2.addRequest(request)
    const policyForTicket = mode === 'work' && escalationPolicy ? { escalationPolicy } : {}
    const presetForTicket = mode === 'work' && workerPreset ? { workerPreset } : {}
    let ticket
    try {
      // Create the ticket row and its DB-owned meta in one writer transaction;
      // JSON is only a mirror. Splitting them can leave a ticket whose meta is
      // visible in JSON but NULL in SQLite.
      ticket = this.service.tickets.runSync('tickets.create', () => {
        const created = this.service.tickets.addTicket({
          status: 'intake',
          waitingOn: 'ria',
          executor: null,
          goal,
          acceptance,
          origin: { kind: source, text: goal, sessionId: request.sessionId, requestId },
        })
        this.v2.setTicketMeta(created.ticketId, {
          scope: 'global', projectId: null, projectCwd, phase: 'advisor', requestId, mode,
          ...policyForTicket, ...presetForTicket, ...workerSelection,
          ...(preferredTags.length ? { routingTags: preferredTags } : {}),
          ...(requestedTopicId ? { topicId: requestedTopicId } : {}),
          attachments: attachmentResult.attachments,
          ...(attachmentResult.notes.length ? { attachmentNotes: attachmentResult.notes.slice(0, 20) } : {}),
        })
        return created
      })
    } catch (error) {
      return { ok: false, code: error && error.code ? error.code : 'ticket_create_failed', message: String(error && error.message ? error.message : error) }
    }
    this.routerEvent({
      event: 'ticket.created',
      ticketId: ticket.ticketId,
      sessionId: request.sessionId,
      actor: source,
      reason: source === 'sage' ? 'sage_request' : 'chatbot_request',
      payload: {
        mode, workspace: projectCwd, requestId, goal: clip(goal, 200),
        ...(policyForTicket.escalationPolicy ? { escalationPolicy: policyForTicket.escalationPolicy } : {}),
        ...(presetForTicket.workerPreset ? { workerPreset: presetForTicket.workerPreset } : {}),
        ...workerSelection,
        ...(preferredTags.length ? { preferredTags } : {}),
        ...(requestedTopicId ? { topicId: requestedTopicId } : {}),
        attachments: { count: attachmentResult.attachments.length, sha256: attachmentResult.attachments.map(item => item.sha256).filter(Boolean) },
      },
    })
    const opened = this.service.tickets.transitionTicket(ticket.ticketId, 'open', {
      actor: 'router',
      executor: 'advisor',
      waitingOn: 'ria',
      reason: 'intake routed to the Global Advisor',
    })
    if (!opened.ok) {
      return { ok: false, code: opened.code, message: opened.message, ticketId: ticket.ticketId }
    }
    // A user-supplied topic is a weak association: it never blocks the ticket.
    // A failure only degrades to the board's unclassified bucket.
    if (requestedTopicId) {
      try {
        this.service.store.linkTicket(requestedTopicId, ticket.ticketId, 'primary')
        this.routerEvent({ event: 'topic.assigned', ticketId: ticket.ticketId, sessionId: request.sessionId, actor: source, reason: 'chatbot_request topicId', payload: { topicId: requestedTopicId } })
      } catch (error) {
        this.routerEvent({ event: 'topic.auto_assign.degraded', ticketId: ticket.ticketId, sessionId: request.sessionId, actor: 'router', reason: 'explicit topicId', payload: { topicId: requestedTopicId, message: String(error && error.message ? error.message : error) } })
      }
    }
    try {
      const advisorResult = await this.createAdvisorForTicket(opened.ticket, this.v2.ticketMeta(ticket.ticketId), request)
      const current = this.service.tickets.ticket(ticket.ticketId) || opened.ticket
      const currentMeta = this.v2.ticketMeta(ticket.ticketId)
      return { ok: true, ticketId: ticket.ticketId, requestId, workspace: projectCwd, mode, status: current.status, phase: currentMeta.phase, ...(advisorResult && advisorResult.stateless ? { stateless: true } : {}), advisorResult }
    } catch (error) {
      const message = String(error && error.message ? error.message : error)
      const blocked = this.service.tickets.transitionTicket(ticket.ticketId, 'blocked', {
        actor: 'router',
        executor: 'advisor',
        waitingOn: 'environment',
        blockedReason: 'Advisor 不可用：' + message,
        reason: 'could not start the Advisor',
      })
      this.v2.setTicketMeta(ticket.ticketId, { phase: 'blocked' })
      if (blocked.ok) await this.notifyChat('ticket ' + ticket.ticketId + ' 已创建，但 Advisor 启动失败，已暂停：' + message)
      return { ok: false, code: 'advisor_unavailable', message, ticketId: ticket.ticketId, status: blocked.ok ? 'blocked' : 'open' }
    }
  }

  async chatbotStatus(args) {
    if (text(args.ticketId)) {
      const ticket = this.service.tickets.knownTicket(text(args.ticketId))
      if (!ticket) return { ok: true, found: false, ticketId: text(args.ticketId) }
      return { ok: true, found: true, ...this.ticketBundle(ticket) }
    }
    const items = []
    for (const meta of this.v2.ticketMetas()) {
      const ticket = this.service.tickets.ticket(meta.ticketId)
      if (!ticket || !ACTIVE.has(ticket.status)) continue
      items.push(this.ticketView(ticket))
    }
    items.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
    return { ok: true, tickets: items }
  }

  async chatbotWorkerConfig(args, exec) {
    if (!this.chatCaller(exec)) return { ok: false, code: 'forbidden', message: 'only the Chat may configure Workers' }
    const action = text(args.action)
    if (action === 'get') {
      const workers = []
      for (const item of this.v2.workers().sort((left, right) => (left.seq || 0) - (right.seq || 0))) {
        workers.push(await this.workerConfigView(item))
      }
      return {
        ok: true,
        workers,
        total: workers.length,
        presets: this.workerPresets.slice(),
        note: 'allowAutoDispatch changes apply immediately; false requires explicit ticket selection and does not stop current work. tags/roleNote/dedicated apply immediately and feed deterministic routing. Model changes apply from the next turn; preset changes need recreate=true (DSH has no live preset switch).',
      }
    }
    if (action !== 'set') return { ok: false, code: 'invalid_action', message: "action must be 'get' or 'set'" }
    const target = this.findWorker(args)
    if (target.error) return target.error
    const worker = target.worker
    const preset = text(args.preset)
    const model = text(args.model)
    const recreate = args.recreate === true
    const hasAutoDispatch = args.allowAutoDispatch !== undefined
    if (hasAutoDispatch && typeof args.allowAutoDispatch !== 'boolean') {
      return { ok: false, code: 'invalid_allow_auto_dispatch', message: 'allowAutoDispatch must be a boolean' }
    }
    const hasTags = args.tags !== undefined
    const hasRoleNote = args.roleNote !== undefined
    const hasDedicated = args.dedicated !== undefined
    if (hasTags && !Array.isArray(args.tags)) {
      return { ok: false, code: 'invalid_tags', message: 'tags must be an array of tag strings' }
    }
    if (hasRoleNote && typeof args.roleNote !== 'string') {
      return { ok: false, code: 'invalid_role_note', message: 'roleNote must be a string' }
    }
    if (hasRoleNote && [...args.roleNote].length > WORKER_ROLE_NOTE_LIMIT) {
      return { ok: false, code: 'invalid_role_note', message: 'roleNote must be at most ' + WORKER_ROLE_NOTE_LIMIT + ' characters' }
    }
    if (hasDedicated && typeof args.dedicated !== 'boolean') {
      return { ok: false, code: 'invalid_dedicated', message: 'dedicated must be a boolean' }
    }
    const hasIdentity = hasTags || hasRoleNote || hasDedicated
    if (!preset && !model && !hasAutoDispatch && !hasIdentity) {
      return { ok: false, code: 'config_required', message: 'pass preset, model, allowAutoDispatch, tags, roleNote and/or dedicated' }
    }
    if (preset && !this.workerPresets.includes(preset)) {
      return { ok: false, code: 'invalid_worker_preset', message: 'preset must be one of ' + this.workerPresets.join(', ') }
    }
    const before = await this.workerConfigView(worker)
    let resolvedModel = null
    if (model) {
      const resolved = await this.resolveWorkerModel({
        provider: text(args.provider),
        model,
        reasoningEffort: text(args.reasoningEffort),
      })
      if (!resolved.ok) return resolved
      resolvedModel = resolved.selection
    }
    if (preset) {
      const currentPreset = worker.preset || DEFAULT_WORKER_PRESET
      if (!recreate) {
        return {
          ok: false,
          code: 'worker_preset_requires_recreate',
          message: 'DSH 不支持运行中切换 preset；需要重建 worker 才生效。传 recreate:true 将停用旧绑定、在同 cwd 新建同类型 worker，旧会话归档保留。',
          worker: before,
          presets: this.workerPresets.slice(),
        }
      }
      const recreated = await this.recreateWorker(worker, { preset, model: resolvedModel,
        ...(hasAutoDispatch ? { allowAutoDispatch: args.allowAutoDispatch } : {}),
      })
      if (!recreated.ok) return recreated
      return {
        ok: true,
        recreated: true,
        worker: recreated.worker,
        previousWorkerId: worker.sessionId,
        archivedOld: recreated.archivedOld,
        presetFrom: currentPreset,
        presetTo: preset,
        ...(recreated.model ? { model: recreated.model } : {}),
      }
    }
    let applied = null
    if (model) {
      applied = await this.applyWorkerModel(worker.sessionId, resolvedModel)
      if (!applied.ok) return applied
    }
    const autoDispatch = hasAutoDispatch
      ? this.setWorkerAutoDispatch(worker.sessionId, args.allowAutoDispatch)
      : null
    if (autoDispatch && autoDispatch.ok === false) return autoDispatch
    let identity = null
    if (hasIdentity) {
      const patch = {}
      if (hasTags) patch.tags = normalizeTags(args.tags, TAG_LIMIT)
      if (hasRoleNote) patch.roleNote = [...args.roleNote].join('')
      if (hasDedicated) patch.dedicated = args.dedicated
      this.v2.addWorker(worker.sessionId, patch, { trigger: 'worker.config' })
      const updated = this.v2.worker(worker.sessionId)
      identity = {
        before: { tags: before.tags, roleNote: before.roleNote, dedicated: before.dedicated },
        after: { tags: updated.tags, roleNote: updated.roleNote, dedicated: updated.dedicated },
      }
      if (hasTags) this.recordWorkerConfigChange(worker.sessionId, 'tags', identity.before.tags, identity.after.tags)
      if (hasRoleNote) this.recordWorkerConfigChange(worker.sessionId, 'roleNote', identity.before.roleNote, identity.after.roleNote)
      if (hasDedicated) this.recordWorkerConfigChange(worker.sessionId, 'dedicated', identity.before.dedicated, identity.after.dedicated)
    }
    return {
      ok: true,
      recreated: false,
      worker: await this.workerConfigView(this.v2.worker(worker.sessionId) || worker),
      before: applied ? applied.before : autoDispatch ? autoDispatch.before : null,
      after: applied ? applied.after : autoDispatch ? autoDispatch.after : null,
      ...(applied && autoDispatch ? { autoDispatch } : {}),
      ...(identity ? { identity } : {}),
    }
  }

  setWorkerAutoDispatch(workerId, allowAutoDispatch) {
    const worker = this.v2.worker(workerId)
    // A concurrent removal/recreation may finish while the config view/model
    // read is in flight; never revive the old binding just to set this flag.
    if (!worker) return { ok: false, code: 'worker_missing', message: 'worker not found: ' + workerId }
    const before = worker.allowAutoDispatch !== false
    if (before !== allowAutoDispatch) {
      this.v2.addWorker(workerId, { allowAutoDispatch }, { trigger: 'worker.config' })
      this.recordWorkerAutoDispatchChange(workerId, before, allowAutoDispatch)
    }
    return { before, after: allowAutoDispatch }
  }

  recordWorkerAutoDispatchChange(workerId, before, after) {
    this.recordWorkerConfigChange(workerId, 'allowAutoDispatch', before, after)
  }

  recordWorkerConfigChange(workerId, field, before, after) {
    this.routerEvent({
      event: 'worker.config.changed', ticketId: null, sessionId: workerId, actor: 'chat',
      reason: field, payload: { workerId, field, before, after },
    })
  }

  findWorker(args = {}, { workerType } = {}) {
    const id = text(args.workerId)
    const seq = Number.isSafeInteger(args.seq) ? args.seq : null
    const workers = this.v2.workers().filter(item => !workerType || item.workerType === workerType)
    const worker = id
      ? workers.find(item => String(item.sessionId) === id)
      : (seq !== null ? workers.find(item => Number(item.seq) === seq) : null)
    if (!worker) {
      return {
        error: {
          ok: false,
          code: id || seq !== null ? 'worker_missing' : 'worker_selector_required',
          message: id ? 'worker not found: ' + id : seq !== null ? (workerType || 'managed') + ' worker seq not found: ' + seq : 'pass workerId or seq',
        },
      }
    }
    return { worker }
  }

  /**
   * Read-only model catalog for the Chat. The registry is the source of
   * truth; a total registry failure returns the bundled fallback instead of an
   * error. Provider/query filters run after the snapshot; count is the returned
   * page size and total is the number of matches before limit.
   */
  async chatbotModels(args, exec) {
    if (!this.chatCaller(exec)) return { ok: false, code: 'forbidden', message: 'only the Chat may list models' }
    const provider = text(args.provider)
    const query = text(args.query)
    const rawLimit = args.limit === undefined ? 50 : Number(args.limit)
    if (!Number.isSafeInteger(rawLimit) || rawLimit < 1 || rawLimit > 200) {
      return { ok: false, code: 'invalid_limit', message: 'limit must be an integer between 1 and 200' }
    }
    const snapshot = await this.modelCatalogSnapshot()
    const matched = filterModelCatalog(snapshot.models, { provider, query })
    const models = matched.slice(0, rawLimit)
    const result = {
      ok: true,
      models,
      count: models.length,
      total: matched.length,
      source: snapshot.source,
      cached: snapshot.cached,
      ...(snapshot.reason ? { reason: snapshot.reason } : {}),
      ...(snapshot.failures && snapshot.failures.length ? { failures: snapshot.failures } : {}),
    }
    if (!models.length) {
      const scope = [provider ? 'provider=' + provider : '', query ? 'query=' + query : ''].filter(Boolean).join(', ')
      result.message = scope
        ? '没有匹配 ' + scope + ' 的模型'
        : (snapshot.source === 'bundled-fallback'
          ? '模型目录不可用，且内置清单为空'
          : '模型目录为空：当前没有已注册的模型')
    }
    return result
  }

  /**
   * Process-local snapshot with a short TTL. There is deliberately no timer and
   * no background refresh: callers hit the registry only on a miss or expiry.
   */
  async modelCatalogSnapshot() {
    const at = Date.now()
    if (this.modelCatalogCache && at - this.modelCatalogCache.at < MODEL_CATALOG_TTL_MS) {
      return { ...this.modelCatalogCache.snapshot, cached: true }
    }
    const llm = typeof this.ctx.get === 'function' ? this.ctx.get('llm') : undefined
    const failures = []
    const models = []
    let source = 'catalog'
    if (llm && typeof llm.listModels === 'function') {
      let providers = []
      try {
        providers = typeof llm.listProviders === 'function' ? await llm.listProviders() : []
      } catch (error) {
        failures.push('llm.listProviders: ' + String(error && error.message ? error.message : error))
      }
      for (const entry of Array.isArray(providers) ? providers : []) {
        const providerId = text(entry && (entry.id || entry.provider))
        if (!providerId) continue
        try {
          const list = await llm.listModels(providerId)
          for (const item of Array.isArray(list) ? list : []) {
            const normalized = normalizeModelEntry(providerId, item, 'catalog')
            if (normalized) models.push(normalized)
          }
        } catch (error) {
          failures.push(providerId + ': ' + String(error && error.message ? error.message : error))
        }
      }
    } else {
      failures.push('DSH llm registry is unavailable (no listModels)')
    }
    // Mark the host's current default route. This is a projection, not a
    // registry field, and a missing projection never fails the listing.
    try {
      const defaults = this.ctx.get('agentDefaultModel')
      const selected = defaults && typeof defaults.currentSelection === 'function' ? defaults.currentSelection() : undefined
      if (selected && selected.provider && selected.model) {
        for (const item of models) if (item.provider === selected.provider && item.model === selected.model) item.default = true
      }
    } catch { /* optional marker */ }
    const unique = [...new Map(models.map(item => [item.provider + '/' + item.model, item])).values()]
    let reason
    if (!unique.length) {
      if (failures.length) {
        source = 'bundled-fallback'
        reason = '模型目录读取失败，已回退内置清单：' + failures.join('；')
        for (const item of bundledModelCatalog()) unique.push(item)
      } else {
        reason = '模型目录为空：注册表没有返回任何模型'
      }
    }
    const snapshot = {
      models: unique,
      source,
      ...(failures.length ? { failures } : {}),
      ...(reason ? { reason } : {}),
    }
    this.modelCatalogCache = { at, snapshot }
    return { ...snapshot, cached: false }
  }

  async workerConfigView(item) {
    const workerType = item && item.workerType === 'reflection' ? 'reflection' : 'work'
    let title = roleSessionTitle(workerType === 'reflection' ? 'reflection' : 'worker', item && item.seq ? item.seq : 0)
    let model = null
    try {
      const projection = await this.ctx.sessionController.projections({ sessionId: item.sessionId })
      const values = projection && projection.values ? projection.values : {}
      if (values.title) title = values.title
      const selected = values.modelSelection && values.modelSelection.next ? values.modelSelection.next : null
      if (selected && selected.provider && selected.model) {
        model = {
          provider: selected.provider,
          model: selected.model,
          ...(selected.reasoningEffort ? { reasoningEffort: selected.reasoningEffort } : {}),
        }
      }
    } catch (error) {
      this.log('warn', 'could not read config for worker ' + String(item && item.sessionId) + ': ' + String(error && error.message ? error.message : error))
    }
    const busy = await this.service.workerBusy(item.sessionId)
    const current = this.v2.worker(item.sessionId) || item
    const currentTicketId = this.workerTicketId(current)
    const status = currentTicketId ? 'working' : 'idle'
    // The same ticket must report the same health here and in chatbot_status.
    // Unbound Workers have no ticket to judge, so they fall back to their own
    // session turn (lifecycle ownership is distinct from the physical turn: a
    // cancelled Worker can be idle while its soft-stop still drains a tool).
    const boundTicket = currentTicketId ? this.service.tickets.ticket(currentTicketId) : null
    const health = boundTicket ? this.ticketHealth(boundTicket) : null
    return {
      sessionId: current.sessionId,
      seq: current.seq || 0,
      title,
      cwd: current.cwd || null,
      workerType,
      preset: current.preset || DEFAULT_WORKER_PRESET,
      allowAutoDispatch: current.allowAutoDispatch !== false,
      tags: Array.isArray(current.tags) ? current.tags.slice() : [],
      autoTags: Array.isArray(current.autoTags) ? current.autoTags.slice() : [],
      recentTopics: Array.isArray(current.recentTopics) ? current.recentTopics.slice() : [],
      roleNote: current.roleNote || '',
      dedicated: current.dedicated === true,
      model,
      status,
      currentTicketId,
      activeTurn: health ? health.activeTurn : (busy.running || this.turnStartedAt.has(String(current.sessionId))),
      lastEventAgeMinutes: health ? health.lastEventAgeMinutes : null,
      stuckSuspect: health ? health.stuckSuspect : false,
      stuckReason: health ? health.stuckReason : null,
      selectable: !busy.busy && !busy.unknown && this.isWorkerSelectable(current, {
        scope: current.scope, projectId: current.projectId, projectCwd: current.projectCwd || null, workerType,
      }),
      stateConsistent: current.status === status && (current.currentTicketId || null) === currentTicketId,
      ...(current.status !== status ? { storedStatus: current.status } : {}),
    }
  }

  async workerModelOf(sessionId) {
    try {
      const projection = await this.ctx.sessionController.projections({ sessionId })
      const values = projection && projection.values ? projection.values : {}
      const selected = values.modelSelection && values.modelSelection.next ? values.modelSelection.next : null
      return selected && selected.provider && selected.model
        ? { provider: selected.provider, model: selected.model, ...(selected.reasoningEffort ? { reasoningEffort: selected.reasoningEffort } : {}) }
        : null
    } catch {
      return null
    }
  }

  async resolveWorkerModel({ provider = '', model = '', reasoningEffort = '' } = {}) {
    const wanted = text(model)
    if (!wanted) return { ok: false, code: 'model_required', message: 'model must not be empty' }
    const llm = typeof this.ctx.get === 'function' ? this.ctx.get('llm') : undefined
    if (!llm || typeof llm.listModels !== 'function') {
      return { ok: false, code: 'model_catalog_unavailable', message: '模型列表不可用，暂时无法校验收 worker 模型' }
    }
    let requestedProvider = text(provider)
    const failures = []
    const found = []
    if (requestedProvider) {
      try {
        for (const item of await llm.listModels(requestedProvider)) {
          if (item && text(item.id) === wanted) found.push({ provider: requestedProvider, model: wanted })
        }
      } catch (error) {
        return { ok: false, code: 'model_not_found', message: '无法读取 provider ' + requestedProvider + ' 的模型列表：' + String(error && error.message ? error.message : error) }
      }
    } else {
      const providers = typeof llm.listProviders === 'function' ? await llm.listProviders() : []
      for (const entry of Array.isArray(providers) ? providers : []) {
        const pid = text(entry && entry.id)
        if (!pid) continue
        try {
          for (const item of await llm.listModels(pid)) {
            if (item && text(item.id) === wanted) found.push({ provider: pid, model: wanted })
          }
        } catch (error) {
          failures.push(pid + '（' + String(error && error.message ? error.message : error) + '）')
        }
      }
    }
    if (!found.length) {
      const sample = failures.length ? '；部分 provider 读取失败：' + failures.join('；') : ''
      return { ok: false, code: 'model_not_found', message: '找不到模型 ' + (requestedProvider ? requestedProvider + '/' : '') + wanted + sample }
    }
    const unique = [...new Map(found.map(item => [item.provider + '/' + item.model, item])).values()]
    if (unique.length > 1) {
      return { ok: false, code: 'model_ambiguous', message: '模型 ' + wanted + ' 在多个 provider 下存在，请显式传 provider：' + unique.map(item => item.provider + '/' + item.model).join(', ') }
    }
    const selection = { provider: unique[0].provider, model: wanted }
    if (text(reasoningEffort)) selection.reasoningEffort = text(reasoningEffort)
    return { ok: true, selection }
  }

  async applyWorkerModel(sessionId, selection) {
    if (!selection) return { ok: false, code: 'model_required', message: 'model must not be empty' }
    const before = await this.workerModelOf(sessionId)
    try {
      const result = await this.ctx.sessionController.selectModel({
        sessionId,
        provider: selection.provider,
        model: selection.model,
        ...(selection.reasoningEffort ? { reasoningEffort: selection.reasoningEffort } : {}),
      })
      const selected = result && result.selected ? result.selected : selection
      const after = {
        provider: selected.provider || selection.provider,
        model: selected.model || selection.model,
        ...(selected.reasoningEffort || selection.reasoningEffort ? { reasoningEffort: selected.reasoningEffort || selection.reasoningEffort } : {}),
      }
      this.routerEvent({
        event: 'worker.config.changed',
        ticketId: null,
        sessionId,
        actor: 'chat',
        reason: 'model',
        payload: { workerId: sessionId, field: 'model', before, after },
      })
      return { ok: true, before, after }
    } catch (error) {
      return { ok: false, code: 'worker_model_switch_failed', message: '无法切换 worker 模型：' + String(error && error.message ? error.message : error) }
    }
  }

  /**
   * DSH has no live preset switch, so a preset change means a new Session. The
   * old binding stops being selectable immediately; its session is archived
   * read-only (kept on disk) rather than deleted.
   */
  async recreateWorker(old, { preset, model, allowAutoDispatch } = {}) {
    const workerType = old.workerType === 'reflection' ? 'reflection' : 'work'
    const reservation = Symbol('recreateWorker')
    if (this.workerTicketId(old) || !this.reserveWorker(old.sessionId, reservation)) {
      return { ok: false, code: 'worker_busy', message: '先停止或完成 Worker 当前工单，再重建 preset。', previousWorkerId: old.sessionId }
    }
    try {
      const busy = await this.service.workerBusy(old.sessionId)
      const latest = this.v2.worker(old.sessionId)
      if (!latest || this.workerTicketId(latest) || busy.busy || busy.unknown || this.turnStartedAt.has(String(old.sessionId))) {
        return { ok: false, code: 'worker_busy', message: 'Worker 仍有活跃回合/队列，或无法确认空闲；稍后再重建。', previousWorkerId: old.sessionId }
      }
      const cwd = text(old.cwd) || join(this.stateDir, workerType === 'reflection' ? 'reflection-workers' : 'workers')
      let replacement
      try {
        replacement = await this.createIdleWorker({
          scope: old.scope || 'global', projectId: old.projectId || null,
          projectCwd: old.projectCwd || null, workerType, preset, cwd,
          // Rebuilding a preset must not silently opt an explicit-only Worker in.
          allowAutoDispatch: allowAutoDispatch === undefined ? latest.allowAutoDispatch !== false : allowAutoDispatch,
        }, 'worker.recreate', reservation)
      } catch (error) {
        return {
          ok: false, code: 'worker_recreate_failed',
          message: '无法用 preset ' + preset + ' 重建 worker：' + String(error && error.message ? error.message : error),
          previousWorkerId: old.sessionId,
        }
      }
      const { sessionId, meta } = replacement
      // A preset rebuild is a new session context: inherit the user-set identity
      // (tags/roleNote/dedicated) but never the learned autoTags/recentTopics.
      const inherited = {}
      if (Array.isArray(latest.tags) && latest.tags.length) inherited.tags = latest.tags
      if (latest.roleNote) inherited.roleNote = latest.roleNote
      if (latest.dedicated === true) inherited.dedicated = true
      if (Object.keys(inherited).length) this.v2.addWorker(sessionId, inherited, { trigger: 'worker.recreate.inherit' })
      if ((latest.allowAutoDispatch !== false) !== meta.allowAutoDispatch) {
        this.recordWorkerAutoDispatchChange(sessionId, latest.allowAutoDispatch !== false, meta.allowAutoDispatch)
      }
      this.v2.removeWorker(old.sessionId)
      let archivedOld = false
      try {
        const registry = this.ctx.workspaceRegistry
        if (registry && typeof registry.archiveSession === 'function') {
          await registry.archiveSession(old.sessionId, { stopActivity: true })
          archivedOld = true
        }
      } catch (error) {
        this.log('warn', 'could not archive old worker session ' + old.sessionId + ': ' + String(error && error.message ? error.message : error))
      }
      let modelResult = null
      if (model) {
        const applied = await this.applyWorkerModel(sessionId, model)
        if (!applied.ok) {
          return {
            ok: false,
            code: applied.code,
            message: applied.message + '（新 worker 已创建：' + sessionId + '，旧绑定已停用）',
            workerSessionId: sessionId,
            previousWorkerId: old.sessionId,
          }
        }
        modelResult = applied.after
      }
      this.routerEvent({
        event: 'worker.config.changed',
        ticketId: null,
        sessionId,
        actor: 'chat',
        reason: 'recreate',
        payload: {
          workerId: old.sessionId,
          newWorkerId: sessionId,
          field: 'preset',
          before: old.preset || DEFAULT_WORKER_PRESET,
          after: preset,
          recreated: true,
          archivedOld,
          ...(modelResult ? { model: modelResult } : {}),
        },
      })
      return {
        ok: true,
        worker: await this.workerConfigView(meta),
        archivedOld,
        model: modelResult,
      }
    } finally {
      this.releaseWorkerReservations(reservation)
    }
  }

  steerSummary(message) {
    return clip(String(message == null ? '' : message), 120)
  }

  managerInboxSource(entry) {
    return entry.source === 'resume' ? 'resume' : 'steer'
  }

  managerInboxText(entries) {
    const resumeOnly = entries.every(entry => this.managerInboxSource(entry) === 'resume')
    const lines = [resumeOnly ? '[Manager resume]' : '[Manager steer · 未读指令]']
    for (const entry of entries) {
      lines.push('- ' + (!resumeOnly && this.managerInboxSource(entry) === 'resume' ? '[Manager resume] ' : '') + entry.message)
    }
    return lines.join('\n')
  }

  /** @param {'immediate' | 'pre-step' | 'done-retry'} deliveryMode */
  recordInboxDelivered(entries, workerId, deliveryMode, attempts = 1, trigger = deliveryMode) {
    if (!INBOX_DELIVERY_MODES.has(deliveryMode)) throw new TypeError('Unsupported manager inbox delivery mode: ' + deliveryMode)
    const delivered = entries.filter(entry => !entry.deliveredAt && !entry.discardedAt)
    if (!delivered.length) return
    const inboxIds = delivered.map(entry => entry.id)
    const ticketIds = [...new Set(delivered.map(entry => entry.ticketId))]
    const sources = [...new Set(delivered.map(entry => this.managerInboxSource(entry)))]
    this.v2.markInboxDelivered(inboxIds, now(), { deliveryMode, deliveryAttempts: attempts })
    this.routerEvent({
      event: 'steer.delivered', ticketId: ticketIds[0], sessionId: workerId, actor: 'router', reason: trigger,
      payload: { count: delivered.length, attempts, deliveryMode, inboxIds, ticketIds,
        source: sources.length === 1 ? sources[0] : 'mixed', sources,
        messages: delivered.map(entry => ({ inboxId: entry.id, ticketId: entry.ticketId, workerId, source: this.managerInboxSource(entry) })),
      },
    })
  }

  async recordSteerUndelivered(ticketId, workerId, trigger, attempts = 0) {
    const pending = this.v2.pendingInbox(ticketId, workerId)
    if (!pending.length) return []
    for (const entry of pending) {
      this.routerEvent({
        event: 'steer.undelivered', ticketId, sessionId: workerId, actor: 'router', reason: trigger,
        payload: { inboxId: entry.id, source: this.managerInboxSource(entry), workerId, ticketId,
          summary: this.steerSummary(entry.message), at: new Date(entry.at || now()).toISOString(), trigger, attempts },
      })
    }
    try {
      await this.notifyChat('⚠️ ticket ' + ticketId + ' 有 ' + pending.length + ' 条指令没送到（' + trigger + '）：' + pending.map(item => this.steerSummary(item.message)).join('；'))
    } catch (error) {
      this.log('warn', 'could not notify Chat of undelivered inbox: ' + String(error && error.message ? error.message : error))
    }
    return pending
  }

  async blockUndeliveredSteer(ticketId, workerId, trigger, attempts) {
    const pending = this.v2.pendingInbox(ticketId, workerId)
    if (!pending.length) return false
    const ticket = this.service.tickets.ticket(ticketId)
    if (ticket && ticket.status === 'working' && String(ticket.executor) === workerId) {
      const moved = this.service.tickets.transitionTicket(ticketId, 'blocked', {
        actor: 'router', executor: workerId, waitingOn: 'user',
        blockedReason: '有未读指令未能送达：' + pending.map(item => this.steerSummary(item.message)).join('；'),
        attention: { kind: 'question', question: '有未读指令没送到，请处理后 resume。' },
        reason: 'pending manager inbox undelivered at ' + trigger,
      })
      if (moved.ok) {
        this.v2.setTicketMeta(ticketId, { phase: 'blocked' })
        this.releaseWorkerForTicket(ticketId, 'steer.undelivered')
      }
    }
    await this.recordSteerUndelivered(ticketId, workerId, trigger, attempts)
    return false
  }

  /** @param {'immediate' | 'pre-step' | 'done-retry'} deliveryMode */
  async deliverSteerInbox(ticketId, workerId, trigger, deliveryMode = 'done-retry', options = {}) {
    if (!INBOX_DELIVERY_MODES.has(deliveryMode)) throw new TypeError('Unsupported manager inbox delivery mode: ' + deliveryMode)
    // Resume and steer share one delivery owner; a pre-step cannot
    // consume the same ids while an immediate/done prompt is being admitted.
    const previous = this.steerDeliveryLocks.get(workerId) || Promise.resolve()
    const running = previous.catch(() => {}).then(async () => {
      const ticket = this.service.tickets.ticket(ticketId)
      if (!ticket || ticket.status !== 'working' || String(ticket.executor) !== workerId) return false
      if (deliveryMode === 'immediate' && !options.dispatch) {
        const busy = await this.service.workerBusy(workerId)
        if (busy.busy || busy.unknown || this.turnStartedAt.has(workerId)) return false
      }
      // A pre-step may have consumed entries while state() awaited.
      const current = this.service.tickets.ticket(ticketId)
      if (!current || current.status !== 'working' || String(current.executor) !== workerId) return false
      const pending = this.v2.pendingInbox(ticketId, workerId).filter(entry => !this.deliveringInbox.has(entry.id))
      if (!pending.length) return true
      const workOrder = this.v2.workOrder(ticketId)
      const worker = this.v2.worker(workerId) || {}
      const brief = options.brief ?? (workOrder ? dispatchBrief({ worker, ticket, workOrder }) : '')
      const textBody = this.managerInboxText(pending) + (brief ? '\n\n' + brief : '')
      // Reuse one request id across attempts, including a lost acceptance reply.
      const requestId = options.requestId || HOST_REQUEST_PREFIX + 'inbox-' + createHash('sha256').update(pending.map(entry => entry.id).join('|')).digest('hex').slice(0, 24)
      for (const entry of pending) this.deliveringInbox.add(entry.id)
      try {
        for (let attempt = 1; attempt <= STEER_MAX_DELIVERY_ATTEMPTS; attempt += 1) {
          const latest = this.service.tickets.ticket(ticketId)
          if (!latest || latest.status !== 'working' || String(latest.executor) !== workerId) return false
          if (pending.every(entry => entry.deliveredAt || entry.discardedAt)) return true
          try {
            await this.promptSession(workerId, textBody, 'queue', requestId)
            this.recordInboxDelivered(pending, workerId, deliveryMode, attempt, trigger)
            return true
          } catch (error) {
            this.log('warn', 'could not deliver pending manager inbox for ' + ticketId + ' attempt ' + attempt + ': ' + String(error && error.message ? error.message : error))
          }
        }
      } finally { for (const entry of pending) this.deliveringInbox.delete(entry.id) }
      return await this.blockUndeliveredSteer(ticketId, workerId, trigger, STEER_MAX_DELIVERY_ATTEMPTS)
    })
    const settled = running.catch(() => {})
    this.steerDeliveryLocks.set(workerId, settled)
    void settled.then(() => { if (this.steerDeliveryLocks.get(workerId) === settled) this.steerDeliveryLocks.delete(workerId) })
    return await running
  }

  async deliverManagerInboxIfIdle(ticketId, workerId, trigger) {
    const busy = await this.service.workerBusy(workerId)
    if (busy.busy || busy.unknown || this.turnStartedAt.has(workerId)) return { ok: true, queued: true, deliveryMode: 'pre-step' }
    const delivered = await this.deliverSteerInbox(ticketId, workerId, trigger, 'immediate')
    const current = this.service.tickets.ticket(ticketId)
    if (!delivered && current?.status === 'blocked') return { ok: false, code: 'steer_undelivered', status: 'blocked', message: 'pending manager inbox could not be delivered' }
    const queued = this.v2.pendingInbox(ticketId, workerId).length > 0
    return { ok: true, queued, deliveryMode: queued ? 'pre-step' : 'immediate' }
  }

  async retryManagerInboxAtTurnEnd(ticketId, workerId) {
    const ticket = this.service.tickets.ticket(ticketId)
    if (!ticket || ticket.status !== 'working' || String(ticket.executor) !== workerId) return
    if (this.v2.pendingInbox(ticketId, workerId).length) await this.deliverSteerInbox(ticketId, workerId, 'turn-end', 'done-retry')
  }

  async chatbotSteer(args, exec) {
    const ticketId = text(args.ticketId)
    const message = text(args.message)
    if (!ticketId || !message) return { ok: false, code: 'invalid_input', message: 'ticketId and message are required' }
    const ticket = this.service.tickets.ticket(ticketId)
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
    const by = String(exec && exec.agent ? exec.agent.id : '')
    const entry = this.addManagerInbox(ticketId, workerId, message, by, 'steer')
    const delivery = await this.deliverManagerInboxIfIdle(ticketId, workerId, 'idle-direct')
    return { ...delivery, ticketId, workerId, inboxId: entry.id,
      message: delivery.ok === false ? delivery.message : delivery.queued
        ? 'Worker 正在执行，会在下一步开始前读取（不打断当前工具）。' : '已交给 Worker。',
    }
  }

  /**
   * Force-stop a ticket (Chat only). DSH exposes sessionController.cancel(),
   * which aborts the active turn the same way the user's own stop does. The
   * ticket is cancelled first so the cancellation watcher sees no working ticket
   * and cannot re-park it. When the abort is unavailable or the turn was not
   * running, a durable soft-stop marker makes the next pre-step end the turn.
   */
  async chatbotStopTicket(args, exec) {
    if (!this.chatCaller(exec)) return { ok: false, code: 'forbidden', message: 'only the Chat may stop a ticket' }
    const ticketId = text(args.ticketId)
    const ticket = this.service.tickets.ticket(ticketId)
    const meta = this.v2.ticketMeta(ticketId)
    const workerId = text(meta.workerId) || text(ticket && ticket.executor)
    const worker = this.v2.worker(workerId)
    const assigned = this.workerTicketId(worker)
    const guard = ticket && !TERMINAL.has(ticket.status) && worker && (!assigned || assigned === ticketId)
      && !this.stoppingWorkers.has(workerId)
    // Lifecycle release happens before cancel()/notifications await. Prevent a
    // concurrent dispatch from starting a new ticket that this cancel would abort.
    if (guard) this.stoppingWorkers.add(workerId)
    try {
      return await this.stopTicketInternal(args, exec)
    } finally {
      if (guard) this.stoppingWorkers.delete(workerId)
    }
  }

  async stopTicketInternal(args, exec) {
    if (!this.chatCaller(exec)) return { ok: false, code: 'forbidden', message: 'only the Chat may stop a ticket' }
    const ticketId = text(args.ticketId)
    const reason = text(args.reason)
    if (!ticketId) return { ok: false, code: 'invalid_input', message: 'ticketId is required' }
    if (!reason) return { ok: false, code: 'invalid_input', message: 'reason is required' }
    const ticket = this.service.tickets.ticket(ticketId)
    if (!ticket) return { ok: false, code: 'ticket_missing', message: 'ticket not found: ' + ticketId }
    // A repeated stop is a successful no-op: no second transition, no second
    // ticket.cancelled event, and the pending inbox stays empty.
    if (ticket.status === 'cancelled') {
      return { ok: true, ticketId, status: 'cancelled', stopped: true, idempotent: true, message: '工单已经是 cancelled，无需重复停止。' }
    }
    if (ticket.status === 'done') {
      return { ok: false, code: 'ticket_done', message: '工单已 done，不能停止；状态保持不变。', ticketId, status: 'done' }
    }
    if (TERMINAL.has(ticket.status)) {
      return { ok: false, code: 'ticket_closed', message: '工单已 ' + ticket.status + '，不能停止。', ticketId, status: ticket.status }
    }
    const meta = this.v2.ticketMeta(ticketId)
    const workerId = text(meta.workerId)
      || (ticket.executor !== 'advisor' && ticket.executor !== 'self' ? text(ticket.executor) : '')
    const previousStatus = ticket.status
    const by = String(exec && exec.agent ? exec.agent.id : '')
    let resolution = {
      kind: 'cancelled',
      reason,
      by: 'chat',
      source: 'chatbot_stop_ticket',
      stoppedAt: now(),
    }
    const transition = () => this.service.tickets.transitionTicket(ticketId, 'cancelled', {
      actor: 'chat',
      ...(ticket.executor ? { executor: ticket.executor } : {}),
      resolution,
      reason: 'chatbot_stop_ticket',
    })
    let moved = transition()
    if (!moved.ok && moved.code === 'checklist_pending') {
      // A forced stop must not be blocked by unfinished checklist steps; the
      // waiver is explicit and recorded in resolution.
      resolution = { ...resolution, waiver: '用户强制停止工单：未完成的 checklist 步骤不再执行' }
      moved = transition()
    }
    if (!moved.ok) {
      return { ok: false, code: moved.code, message: moved.message, ticketId, status: ticket.status, ...(moved.checklistPending ? { checklistPending: moved.checklistPending } : {}) }
    }
    // The unified terminal hook already released this ticket; keep this
    // idempotent check for legacy rows and never clear another ticket's binding.
    this.releaseWorkerForTicket(ticketId, 'chatbot_stop_ticket')
    const inboxCleared = this.v2.discardInboxForTicket(ticketId, { reason: 'ticket stopped by chatbot', by: 'chat' })
    this.v2.setTicketMeta(ticketId, { phase: 'cancelled' })
    try { await this.service.grants.onTicketChanged(moved.ticket) } catch (error) {
      this.log('warn', 'could not restore grants for stopped ticket ' + ticketId + ': ' + String(error && error.message ? error.message : error))
    }
    let hardAbort = false
    let abortAvailable = false
    let abortError = ''
    const busy = workerId ? await this.service.workerBusy(workerId) : { busy: false, running: false }
    const bound = workerId ? this.v2.worker(workerId) : null
    const boundTicketId = this.workerTicketId(bound)
    const ownsAnotherTicket = boundTicketId && boundTicketId !== ticketId
    if (workerId && !ownsAnotherTicket) {
      const cancel = this.ctx.sessionController && this.ctx.sessionController.cancel
      if (typeof cancel === 'function') {
        abortAvailable = true
        try {
          await cancel({ sessionId: workerId })
          hardAbort = busy.running === true
        } catch (error) {
          abortError = String(error && error.message ? error.message : error)
          this.log('warn', 'could not abort worker ' + workerId + ' for stopped ticket ' + ticketId + ': ' + abortError)
        }
      }
      if (hardAbort) {
        // The active turn is gone, but DSH keeps pending inbox work on cancel.
        // Leave a guard marker so any retained/queued turn still ends at its
        // next pre-step instead of resuming work on a cancelled ticket.
        this.v2.requestWorkerStop(workerId, { ticketId, reason, at: now(), hardAbort: true })
      } else if (busy.running === true || busy.unknown || (busy.queued || 0) > 0) {
        // The worker may still be inside a tool or have a queued turn. The
        // marker makes the next pre-step end it instead of continuing.
        this.v2.requestWorkerStop(workerId, { ticketId, reason, at: now(), hardAbort: false })
      } else {
        // Nothing is running and nothing is queued: there is no turn for the
        // stop to land on, and a stale marker would reject a later resume.
        this.v2.clearWorkerStop(workerId)
      }
    }
    const softStop = Boolean(workerId) && !ownsAnotherTicket && !hardAbort && Boolean(this.v2.workerStop(workerId))
    this.routerEvent({
      event: 'ticket.cancelled',
      ticketId,
      sessionId: workerId || null,
      actor: 'chat',
      reason: 'chatbot_stop_ticket',
      payload: {
        reason,
        previousStatus,
        workerId: workerId || null,
        inboxCleared,
        hardAbort,
        abortAvailable,
        ...(abortError ? { abortError } : {}),
        by,
      },
    })
    const message = hardAbort
      ? '已立即停止：ticket ' + ticketId + ' 已取消，Worker 当前回合已中断。'
      : softStop
        ? '已请求停止，当前步骤结束后生效：ticket ' + ticketId + ' 已取消，Worker 会在下一步开始前收到终止说明并结束回合。'
        : '已停止：ticket ' + ticketId + ' 已取消' + (workerId ? '（Worker 当前没有运行中的步骤）。' : '（没有绑定 Worker）。')
    await this.notifyChat('⛔ ' + message + ' 原因：' + reason)
    return {
      ok: true,
      ticketId,
      status: 'cancelled',
      stopped: true,
      idempotent: false,
      workerId: workerId || null,
      inboxCleared,
      hardAbort,
      softStop,
      abortAvailable,
      ...(abortError ? { abortError } : {}),
      message,
    }
  }

  chatCaller(exec) {
    return isChatRole(this.roleFor(exec && exec.agent ? exec.agent.id : ''))
  }

  async chatbotResume(args, exec) {
    if (!this.chatCaller(exec)) return { ok: false, code: 'forbidden', message: 'only the Chat may resume a ticket' }
    const ticketId = text(args.ticketId)
    const message = text(args.message)
    if (!ticketId) return { ok: false, code: 'invalid_input', message: 'ticketId is required' }
    const ticket = this.service.tickets.ticket(ticketId)
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
    const executor = text(ticket.executor)
    const workerId = executor && executor !== 'advisor' && (!this.roleFor(executor) || this.roleFor(executor) === 'worker')
      ? executor : text(meta.workerId)
    const by = String(exec && exec.agent ? exec.agent.id : '')
    let resumed = ticket
    if (ticket.status === 'blocked') {
      const reopened = this.service.tickets.transitionTicket(ticketId, 'open', {
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
      const request = meta.requestId ? this.v2.request(meta.requestId) : null
      const advisorResult = await this.createAdvisorForTicket(resumed, meta, request, message ? '用户回复: ' + message : '')
      const current = this.service.tickets.ticket(ticketId)
      const currentMeta = this.v2.ticketMeta(ticketId)
      return { ok: true, ticketId, status: current ? current.status : 'open', phase: currentMeta.phase, ...(advisorResult && advisorResult.stateless ? { stateless: true } : {}), advisorResult }
    } catch (error) {
      const failure = String(error && error.message ? error.message : error)
      const blocked = this.service.tickets.transitionTicket(ticketId, 'blocked', {
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
    const ticket = this.service.tickets.ticket(ticketId)
    if (!ticket) return { ok: false, code: 'ticket_missing', message: 'ticket not found: ' + ticketId, ticketId }
    if (ticket.status !== 'open') return { ok: false, code: 'ticket_not_open', message: 'ticket is ' + ticket.status, ticketId }
    const workOrder = this.v2.workOrder(ticketId)
    if (!workOrder) return { ok: false, code: 'work_order_missing', message: 'call ticket_plan first', ticketId }
    const selected = this.dispatchWorkerSelection(ticketId, options.workerId)
    const workerId = selected.workerId || ''
    if (selected.error) return await this.blockResumeWorker(ticketId, workerId, selected.error, { workerSeq: selected.workerSeq })
    const message = text(options.message)
    const by = text(options.by)
    let dispatched = await this.tryDispatch(ticketId, workerId, message, by)
    // The same Worker can still be running a turn for this very ticket (it was
    // parked by the 60s confirmation sweep, not by the Worker). Do not create a
    // replacement Worker: re-arm the ticket and queue the user's reply.
    if (!dispatched.ok && dispatched.code === 'worker_busy' && workerId) {
      const worker = this.v2.worker(workerId)
      const owner = this.workerTicketId(worker)
      if (worker && (!owner || owner === ticketId) && !this.archivedSessionIds().has(workerId)
        && !this.stoppingWorkers.has(workerId)
        && (String(worker.currentTicketId || '') === ticketId || this.turnStartedAt.has(workerId))) {
        return await this.rearmWorkingTicket(ticketId, workerId, message, by)
      }
    }
    // Shared inbox exhaustion already parked/notified this ticket; preserve
    // its delivery failure instead of rewriting it as worker selection failure.
    if (!dispatched.ok && dispatched.code === 'steer_undelivered') return dispatched
    // A bound worker is a hard affinity, not a preference. Only the user may
    // choose another worker when that session cannot resume.
    if (!dispatched.ok && workerId) return await this.blockResumeWorker(ticketId, workerId, dispatched)
    if (dispatched.ok) {
      return { ok: true, ticketId, status: 'working', workerSessionId: dispatched.workerSessionId, redispatch: true, deliveryMode: message ? 'immediate' : undefined }
    }
    // dispatchTicket's prompt failure already parks the ticket as blocked.
    if (dispatched.code === 'dispatch_failed') return dispatched
    return await this.blockRedispatch(ticketId, dispatched, { workerId, by })
  }

  async blockResumeWorker(ticketId, workerId, failure, {
    code = 'resume_worker_unavailable', event = 'resume.worker_unavailable', workerSeq,
  } = {}) {
    let ticket = this.service.tickets.ticket(ticketId)
    if (!ticket) return { ok: false, code: 'ticket_missing', message: 'ticket not found: ' + ticketId, ticketId }
    // A stop/report can win while host resolution was in flight. Preserve it.
    if (!['open', 'blocked'].includes(ticket.status)) {
      return { ...failure, ok: false, ticketId, status: ticket.status, waitingOn: ticket.waitingOn }
    }
    const worker = workerId ? this.v2.worker(workerId) : null
    const selector = workerId || 'seq=' + String(workerSeq)
    const label = worker && worker.title ? worker.title + '/' + selector : selector
    const reason = '指定 worker ' + label + ' 不可用（' + (text(failure && failure.message) || text(failure && failure.code) || '未知原因') + '），需要你决定：换 worker / 重建 worker / 取消'
    const executor = workerId || ticket.executor || 'advisor'
    // updateTicket deliberately does not change waitingOn. A failed prompt
    // already parked on environment must take legal edges to wait on the user.
    if (ticket.status === 'blocked' && ticket.waitingOn !== 'user') {
      const reopened = this.service.tickets.transitionTicket(ticketId, 'open', { actor: 'router', executor,
        waitingOn: 'ria', failure: null, reason: 'specified worker requires a user decision' })
      if (!reopened.ok) return { ok: false, code: reopened.code, message: reopened.message, ticketId }
      // SQLite returns snapshots rather than mutating the previous read.
      ticket = reopened.ticket
    }
    if (ticket.status === 'blocked') {
      this.service.tickets.updateTicket(ticketId, { executor, blockedReason: reason,
        attention: { kind: 'decision', question: reason }, failure: { code, message: reason, at: now() } })
    } else {
      const moved = this.service.tickets.transitionTicket(ticketId, 'blocked', { actor: 'router', executor,
        waitingOn: 'user', blockedReason: reason, attention: { kind: 'decision', question: reason },
        failure: { code, message: reason, at: now() }, reason: 'specified worker unavailable' })
      if (!moved.ok) return { ok: false, code: moved.code, message: moved.message, ticketId }
    }
    this.v2.setTicketMeta(ticketId, { phase: 'blocked', ...(workerId ? { workerId } : {}) })
    this.routerEvent({ event, ticketId, sessionId: workerId || null, actor: 'router',
      reason: 'specified worker unavailable', payload: { workerId: workerId || null,
        ...(workerSeq !== undefined ? { workerSeq } : {}), cause: failure && failure.code, message: reason } })
    await this.notifyChat('ticket ' + ticketId + '：' + reason)
    return { ok: false, code, cause: failure && failure.code, ticketId, workerSessionId: workerId || null,
      status: 'blocked', waitingOn: 'user', message: reason }
  }

  async tryDispatch(ticketId, workerId, message, by) {
    try {
      // Resume has its own same-ticket re-arm path before it blocks on failure.
      return await this.dispatchTicket(ticketId, workerId, message, { blockSpecifiedFailure: false, inboxSource: 'resume', by })
    } catch (error) {
      return { ok: false, code: 'dispatch_failed', message: String(error && error.message ? error.message : error), ticketId }
    }
  }

  addManagerInbox(ticketId, workerId, message, by, source = 'steer') {
    const entry = this.v2.addInbox({
      id: newId('inbox_'), ticketId, workerId, message, from: 'chat', by, source, at: now(),
    })
    this.routerEvent({
      event: 'steer.queued', ticketId, sessionId: workerId, actor: 'chat',
      reason: source === 'resume' ? 'chatbot_resume' : 'chatbot_steer',
      payload: { inboxId: entry.id, source, workerId, ticketId,
        summary: this.steerSummary(message), at: new Date(entry.at).toISOString() },
    })
    return entry
  }

  async rearmWorkingTicket(ticketId, workerId, message, by) {
    const ticket = this.service.tickets.ticket(ticketId)
    if (!ticket) return { ok: false, code: 'ticket_missing', message: 'ticket not found: ' + ticketId, ticketId }
    const moved = this.service.tickets.transitionTicket(ticketId, 'working', {
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
    this.v2.addWorker(workerId, { status: 'working', currentTicketId: ticketId, lastUsedAt: now() }, { trigger: 'ticket.rearmed' })
    if (message) this.addManagerInbox(ticketId, workerId, message, by, 'resume')
    const delivery = message
      ? await this.deliverManagerInboxIfIdle(ticketId, workerId, 'resume-rearm')
      : { ok: true, queued: false }
    if (!delivery.ok) return { ...delivery, ticketId, workerSessionId: workerId, rearmed: true }
    return {
      ok: true,
      ticketId,
      status: 'working',
      waitingOn: 'worker',
      workerSessionId: workerId,
      rearmed: true,
      queued: delivery.queued,
      deliveryMode: delivery.deliveryMode,
      message: delivery.queued
        ? 'Worker 仍在执行这张 ticket；已恢复为 working，回复将在下一 step 边界消费。'
        : '已恢复为 working 并投递回复。',
    }
  }

  async blockRedispatch(ticketId, failure, options = {}) {
    const message = text(failure && failure.message) || '重新派发失败'
    const reason = '重新派发失败：' + message
    const ticket = this.service.tickets.ticket(ticketId)
    if (ticket && ticket.status === 'open') {
      const moved = this.service.tickets.transitionTicket(ticketId, 'blocked', {
        actor: 'router',
        executor: text(options.workerId) || ticket.executor || 'advisor',
        waitingOn: 'environment',
        blockedReason: reason,
        failure: { code: 'dispatch_failed', message, at: now() },
        reason: 'redispatch failed',
      })
      if (moved.ok) {
        this.v2.setTicketMeta(ticketId, { phase: 'blocked' })
        this.routerEvent({
          event: 'dispatch.blocked',
          ticketId,
          sessionId: text(options.workerId) || ticket.executor || 'advisor',
          actor: 'router',
          reason: 'redispatch failed',
          payload: { message, cause: text(failure && failure.code) || 'dispatch_failed' },
        })
        await this.notifyChat('ticket ' + ticketId + ' 重新派发失败，已暂停：' + message + '（检查 Worker/环境后用 chatbot_resume 重试）')
      } else {
        this.log('warn', 'could not block ticket ' + ticketId + ' after failed redispatch: ' + moved.code + ' ' + moved.message)
      }
    }
    const current = this.service.tickets.ticket(ticketId)
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
    const ticket = this.service.tickets.knownTicket(ticketId)
    if (!ticket) return { ok: false, code: 'ticket_missing', message: 'ticket not found: ' + ticketId }
    return { ok: true, ...this.ticketBundle(ticket) }
  }

  async ticketPlan(args, exec) {
    if (!this.advisorCaller(exec)) return { ok: false, code: 'forbidden', message: 'only an Advisor may plan' }
    const ticketId = text(args.ticketId)
    const ticket = this.service.tickets.ticket(ticketId)
    if (!ticket) return { ok: false, code: 'ticket_missing', message: 'ticket not found: ' + ticketId }
    if (ticket.status !== 'open') return { ok: false, code: 'ticket_not_open', message: 'ticket is ' + ticket.status }
    const summary = text(args.summary)
    if (!summary) return { ok: false, code: 'summary_required', message: 'summary must not be empty' }
    const requestedPolicy = text(args.escalationPolicy)
    const escalationPolicy = normalizeEscalationPolicy(requestedPolicy)
    if (requestedPolicy && !escalationPolicy) {
      return { ok: false, code: 'invalid_escalation_policy', message: 'escalationPolicy must be one of ' + ESCALATION_POLICIES.join(', ') }
    }
    // Pin lesson ids explicitly; only the id and a short scene are stored so the
    // WorkOrder does not duplicate the full text.
    const pinnedLessons = []
    for (const id of arrayOfText(args.lessons).slice(0, 5)) {
      const entry = this.lessons.get(id)
      if (!entry || entry.status !== 'active') return { ok: false, code: 'lesson_missing', message: 'lesson not found: ' + id }
      pinnedLessons.push({ id: entry.id, scenario: entry.scenario })
    }
    const ticketMeta = this.v2.ticketMeta(ticketId)
    const workOrder = {
      ticketId,
      summary,
      steps: arrayOfText(args.steps),
      acceptance: text(args.acceptance) || ticket.acceptance,
      artifacts: arrayOfText(args.artifacts),
      notes: text(args.notes),
      ...(pinnedLessons.length ? { lessons: pinnedLessons } : {}),
      ...(Array.isArray(ticketMeta.attachments) && ticketMeta.attachments.length ? { attachments: ticketMeta.attachments } : {}),
      ...(Array.isArray(ticketMeta.attachmentNotes) && ticketMeta.attachmentNotes.length ? { attachmentNotes: ticketMeta.attachmentNotes } : {}),
      by: String(exec.agent.id),
      createdAt: now(),
    }
    this.v2.setWorkOrder(ticketId, workOrder)
    const proposal = args.cognitionProposal && typeof args.cognitionProposal === 'object'
      ? this.cognition.propose({
        author: 'advisor',
        source: 'ticket_plan',
        ticketId,
        scope: text(args.cognitionProposal.scope) || 'global',
        text: text(args.cognitionProposal.text),
        evidence: arrayOfText(args.cognitionProposal.evidence),
      })
      : null
    this.v2.setTicketMeta(ticketId, {
      phase: 'planned',
      ...(escalationPolicy ? { escalationPolicy } : {}),
      ...(proposal ? { cognitionProposalId: proposal.id } : {}),
    })
    this.routerEvent({
      event: 'advisor.plan',
      ticketId,
      sessionId: String(exec.agent.id),
      actor: 'advisor',
      reason: 'ticket_plan',
      payload: { summary: clip(summary, 200), steps: workOrder.steps.length },
    })
    return { ok: true, ticketId, workOrder, ...(escalationPolicy ? { escalationPolicy } : {}), ...(proposal ? { cognitionProposal: proposal } : {}) }
  }


  /** Read-only lesson lookup for the Advisor; no writes, no hit counting. */
  async lessonSearch(args, exec) {
    if (!this.advisorCaller(exec)) return { ok: false, code: 'forbidden', message: 'only an Advisor may search lessons' }
    const limit = Number.isSafeInteger(args.limit) ? Math.max(1, Math.min(5, args.limit)) : 3
    const query = text(args.query)
    const workspace = text(args.workspace)
    const mode = text(args.mode)
    if (!query && !workspace && !mode) {
      const listed = this.lessons.list({ limit })
      return { ok: true, lessons: listed.lessons, total: listed.total, scanned: 0 }
    }
    const matched = this.lessons.match({ goal: query, workspace, mode, limit })
    return { ok: true, lessons: matched.lessons, total: matched.total, scanned: matched.scanned }
  }

  async lessonReview(args, exec) {
    if (!this.advisorCaller(exec)) return { ok: false, code: 'forbidden', message: 'only an Advisor may review lessons' }
    const action = text(args.action)
    const by = String(exec && exec.agent ? exec.agent.id : '')
    if (action === 'list') {
      const asked = text(args.status)
      const status = ['candidate', 'accepted', 'rejected'].includes(asked) ? asked : 'candidate'
      const items = this.v2.lessonCandidates({ status })
      return { ok: true, status, candidates: items.slice(-20), total: items.length }
    }
    const id = text(args.id)
    if (!id) return { ok: false, code: 'candidate_required', message: 'id is required for ' + action }
    const candidate = this.v2.lessonCandidate(id)
    if (!candidate) return { ok: false, code: 'candidate_missing', message: 'lesson candidate not found: ' + id }
    if (action === 'accept') {
      // Candidates carry ticketId/sessionId at the top level; the library keys
      // provenance under source.
      const result = this.lessons.accept({
        ...candidate,
        source: { ticketId: candidate.ticketId, sessionId: candidate.sessionId },
      })
      this.v2.updateLessonCandidate(id, { status: 'accepted', entryId: result.entry.id, reviewedAt: now(), by })
      return { ok: true, id, entryId: result.entry.id, deduped: result.deduped, entry: result.entry }
    }
    if (action === 'reject') {
      this.v2.updateLessonCandidate(id, { status: 'rejected', reviewedAt: now(), by })
      return { ok: true, id, rejected: true }
    }
    return { ok: false, code: 'invalid_action', message: "action must be 'list', 'accept' or 'reject'" }
  }

  /**
   * Lesson candidates in worker_report are inert: they land in the v2 sidecar
   * and only lesson_review can promote them into the library.
   */
  recordLessonCandidates(ticketId, workerId, reportId, raw) {
    if (!Array.isArray(raw) || raw.length === 0) return 0
    let added = 0
    for (const item of raw.slice(0, 5)) {
      if (!item || typeof item !== 'object') continue
      const scenario = text(item.scenario)
      const pitfall = text(item.pitfall)
      const approach = text(item.approach)
      if (!scenario || !pitfall || !approach) continue
      this.v2.addLessonCandidate({
        id: newId('cand_'),
        ticketId,
        sessionId: workerId,
        reportId,
        scenario,
        pitfall,
        approach,
        evidence: text(item.evidence),
        status: 'candidate',
        createdAt: now(),
      })
      try {
        const worker = this.v2.worker(workerId)
        this.cognition.propose({
          author: worker && worker.workerType === 'reflection' ? 'reflection' : 'worker',
          source: 'worker_report',
          ticketId,
          scope: 'global',
          text: scenario + ' → ' + pitfall + ' → ' + approach,
          evidence: [text(item.evidence), reportId].filter(Boolean),
        })
      } catch (error) {
        this.log('warn', 'could not propose cognition from report: ' + String(error && error.message ? error.message : error))
      }
      added += 1
    }
    return added
  }

  /**
   * Lessons for one dispatch: the WorkOrder can pin ids, otherwise the ticket's
   * own features are matched against the inverted index (max 3).
   */
  resolveLessonsForDispatch(ticket, workOrder, meta) {
    const pinned = Array.isArray(workOrder && workOrder.lessons)
      ? workOrder.lessons.map(item => text(item && item.id !== undefined ? item.id : item)).filter(Boolean)
      : []
    if (pinned.length) {
      const lessons = []
      for (const id of pinned.slice(0, 5)) {
        const entry = this.lessons.get(id)
        if (entry && entry.status === 'active') lessons.push(entry)
      }
      return { lessons, source: 'workOrder' }
    }
    const matched = this.lessons.match({
      goal: ticket.goal,
      workspace: meta && meta.projectCwd ? meta.projectCwd : '',
      mode: ticketKind(meta),
      limit: 3,
    })
    return { lessons: matched.lessons, source: matched.lessons.length ? 'match' : 'none' }
  }

  async ticketDispatch(args, exec) {
    if (!this.advisorCaller(exec)) return { ok: false, code: 'forbidden', message: 'only an Advisor may dispatch' }
    const ticketId = text(args.ticketId)
    if (!ticketId) return { ok: false, code: 'invalid_input', message: 'ticketId is required' }
    return await this.dispatchTicket(ticketId, text(args.workerSessionId))
  }

  dispatchWorkerSelection(ticketId, requestedWorkerId) {
    const meta = this.v2.ticketMeta(ticketId)
    // A tool-supplied id is an explicit reassignment, not an automatic fallback.
    // Otherwise the ticket's fixed binding wins over automatic selection.
    const workerId = text(requestedWorkerId) || text(meta.workerId)
    if (workerId) return { specified: true, workerId, workerSeq: meta.workerSeq }
    if (meta.workerSeq !== undefined && meta.workerSeq !== null) {
      if (!Number.isSafeInteger(meta.workerSeq) || meta.workerSeq < 1) {
        return { specified: true, workerSeq: meta.workerSeq,
          error: { ok: false, code: 'invalid_worker_selector', message: 'ticket workerSeq must be a positive integer' } }
      }
      const selected = this.findWorker({ seq: meta.workerSeq }, { workerType: meta.mode === 'reflection' ? 'reflection' : 'work' })
      if (selected.error) return { specified: true, workerSeq: meta.workerSeq, error: selected.error }
      // Legacy/externally supplied seq-only metadata is resolved once too.
      this.v2.setTicketMeta(ticketId, { workerId: selected.worker.sessionId })
      return { specified: true, workerId: selected.worker.sessionId, workerSeq: meta.workerSeq }
    }
    return { specified: false, workerId: '' }
  }

  async dispatchTicket(ticketId, requestedWorkerId, managerNote = '', { blockSpecifiedFailure = true, inboxSource, by } = {}) {
    if (this.dispatchingTickets.has(ticketId)) return { ok: false, code: 'dispatch_in_progress', message: 'ticket is already being dispatched', ticketId }
    const reservation = Symbol('dispatchTicket')
    this.dispatchingTickets.add(ticketId)
    try {
      const ticket = this.service.tickets.ticket(ticketId)
      if (!ticket) return { ok: false, code: 'ticket_missing', message: 'ticket not found: ' + ticketId }
      if (ticket.status !== 'open') return { ok: false, code: 'ticket_not_open', message: 'ticket is ' + ticket.status }
      const selected = this.dispatchWorkerSelection(ticketId, requestedWorkerId)
      const result = selected.error || await this.dispatchTicketReserved(ticketId, selected.workerId, managerNote, reservation, { inboxSource, by })
      const unavailable = ['worker_missing', 'worker_unusable', 'worker_kind_mismatch', 'worker_workspace_mismatch',
        'worker_busy', 'worker_unavailable', 'dispatch_failed', 'invalid_worker_selector'].includes(result.code)
      if (!result.ok && selected.specified && blockSpecifiedFailure && unavailable) {
        return await this.blockResumeWorker(ticketId, selected.workerId || '', result, {
          code: 'specified_worker_unavailable', event: 'dispatch.worker_unavailable', workerSeq: selected.workerSeq,
        })
      }
      return result
    } finally {
      this.dispatchingTickets.delete(ticketId)
      this.releaseWorkerReservations(reservation)
    }
  }

  async dispatchTicketReserved(ticketId, requestedWorkerId, managerNote, reservation, { inboxSource, by } = {}) {
    const ticket = this.service.tickets.ticket(ticketId)
    if (!ticket) return { ok: false, code: 'ticket_missing', message: 'ticket not found: ' + ticketId }
    if (ticket.status !== 'open') return { ok: false, code: 'ticket_not_open', message: 'ticket is ' + ticket.status }
    const workOrder = this.v2.workOrder(ticketId)
    if (!workOrder) return { ok: false, code: 'work_order_missing', message: 'call ticket_plan first' }
    const meta = this.v2.ticketMeta(ticketId)
    // reflection tickets go to a reflection Worker, everything else to a work
    // Worker. The two kinds are not interchangeable.
    const reflection = meta.mode === 'reflection'
    const wantedKind = reflection ? 'reflection' : 'work'
    // Routing context: user preferredTags (meta), Advisor routing and the
    // ticket's primary topic feed the deterministic affinity ranking. Explicit
    // worker selection still bypasses the tag rules, never the safety checks.
    const routingTags = mergeTags(meta.routingTags, workOrder.routing && workOrder.routing.tags)
    const requireTagMatch = meta.requireTagMatch === true || Boolean(workOrder.routing && workOrder.routing.requireTagMatch === true)
    const primaryTopicId = this.service.store.primaryTopicFor(ticketId)
    const routing = { ticketTags: routingTags, topicId: primaryTopicId, requireTagMatch }
    // Resolve before dispatch: pinned ids win, otherwise match the ticket's own
    // features. Nothing is scanned outside the index postings.
    const resolvedLessons = this.resolveLessonsForDispatch(ticket, workOrder, meta)
    const lessonIds = resolvedLessons.lessons.map(item => item.id)
    let worker
    try {
      const requested = text(requestedWorkerId)
      if (requested) {
        const existing = this.v2.worker(requested)
        if (!existing) return { ok: false, code: 'worker_missing', message: 'worker not found: ' + requested }
        if (this.archivedSessionIds().has(requested) || (existing.kind !== 'managed' && !isCoManaged(existing))
          || !['idle', 'working'].includes(existing.status) || this.stoppingWorkers.has(requested)) {
          return { ok: false, code: 'worker_unusable', message: 'original worker is archived or not reusable: ' + requested }
        }
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
        const workspaceOk = isCoManaged(existing)
          ? acceptsProjectCwd(existing, meta.projectCwd)
          : (meta.projectCwd ? existing.cwd === meta.projectCwd : !existing.projectCwd)
        if (!reflection && !workspaceOk) {
          return { ok: false, code: 'worker_workspace_mismatch', message: 'worker ' + requested + ' is rooted at ' + String(existing.cwd) }
        }
        if (existing.currentTicketId && existing.currentTicketId !== ticketId) {
          return { ok: false, code: 'worker_busy', message: 'worker is running ' + existing.currentTicketId }
        }
        if (!this.isWorkerSelectable(existing, { projectCwd: meta.projectCwd || null, workerType: wantedKind, automatic: false }) || !this.reserveWorker(requested, reservation)) {
          return { ok: false, code: 'worker_busy', message: 'worker is not idle/selectable: ' + requested }
        }
        const resolved = await this.service.resolve(requested)
        if ('error' in resolved) return { ok: false, code: 'worker_missing', message: resolved.error.message }
        const busy = await this.service.workerBusy(requested)
        if (busy.busy || busy.unknown || !this.isWorkerSelectable(this.v2.worker(requested), { projectCwd: meta.projectCwd || null, workerType: wantedKind, reservation, automatic: false })) {
          return { ok: false, code: 'worker_busy', message: 'worker has a live turn/queue or is no longer idle: ' + requested }
        }
        this.install(resolved.agent, 'worker')
        this.v2.clearWorkerStop(requested)
        worker = { sessionId: requested, meta: this.v2.worker(requested) }
      } else if (reflection) {
        worker = await this.ensureReflectionWorker('global', reservation, ticketId)
      } else {
        worker = await this.ensureWorker(meta.scope || 'global', meta.projectId || null, meta.projectCwd || undefined, ticketId, meta.workerPreset || null, reservation, routing)
      }
    } catch (error) {
      const message = String(error && error.message ? error.message : error)
      return { ok: false, code: 'worker_unavailable', message }
    }
    // Recheck after async resolution/creation; a stop may have cancelled this
    // ticket while we were awaiting the host. Claim before sending any prompt.
    if (ticket.status !== 'open') return { ok: false, code: 'ticket_not_open', message: 'ticket is ' + ticket.status, ticketId }
    if (!this.isWorkerSelectable(this.v2.worker(worker.sessionId), { projectCwd: meta.projectCwd || null, workerType: wantedKind, reservation, automatic: !text(requestedWorkerId), ticketTags: routingTags, requireTagMatch })) {
      return { ok: false, code: 'worker_busy', message: 'worker is no longer selectable', ticketId }
    }
    const requestId = HOST_REQUEST_PREFIX + randomUUID()
    const moved = this.service.tickets.transitionTicket(ticketId, 'working', {
      actor: 'router',
      executor: worker.sessionId,
      waitingOn: 'worker',
      attempt: { count: (ticket.attempt && ticket.attempt.count ? ticket.attempt.count : 0) + 1, lastRequestId: requestId, startedAt: now(), legacy: false },
      reason: 'dispatched to managed worker',
    })
    if (!moved.ok) return { ok: false, code: moved.code, message: moved.message, ticketId }
    this.v2.setTicketMeta(ticketId, { phase: 'working', workerId: worker.sessionId, usedLessons: lessonIds })
    const latestWorker = this.v2.worker(worker.sessionId) || {}
    const scored = scoreWorker(latestWorker, { ticketTags: routingTags, primaryTopicId, now: now() })
    const latestExplicitTags = Array.isArray(latestWorker.tags) ? latestWorker.tags : []
    this.v2.addWorker(worker.sessionId, {
      status: 'working', currentTicketId: ticketId, lastUsedAt: now(),
      autoTags: mergeTags(routingTags, latestWorker.autoTags || []).filter(tag => !latestExplicitTags.includes(tag)),
      ...(primaryTopicId ? { recentTopics: [primaryTopicId, ...(latestWorker.recentTopics || []).filter(id => id !== primaryTopicId)].slice(0, 5) } : {}),
    }, { trigger: 'ticket.dispatch' })
    // A co-managed session is also watched, so the Chat sees its replies
    // without polling. The watch is tagged with this ticket and removed on the
    // terminal state.
    this.attachTicketWatch(moved.ticket, this.v2.worker(worker.sessionId) || worker)
    this.routerEvent({
      event: 'dispatch.attempt',
      ticketId,
      sessionId: worker.sessionId,
      actor: 'router',
      reason: 'dispatched to managed worker',
      payload: {
        workerId: worker.sessionId,
        attemptCount: moved.ticket.attempt ? moved.ticket.attempt.count : 1,
        requestId,
        routing: {
          ticketTags: routingTags,
          topicId: primaryTopicId,
          selectedScore: scored.score,
          matchedExplicitTags: scored.matchedExplicitTags,
          matchedAutoTags: scored.matchedAutoTags,
          matchedTopic: scored.matchedTopic,
          createdNew: Boolean(worker.created),
        },
      },
    })
    try {
      const grantMoves = await this.service.grants.onTicketChanged(moved.ticket)
      for (const grant of grantMoves || []) {
        this.queueChatNotice('本票授权已自动重新应用到新 worker ' + worker.sessionId + '（ticket ' + ticketId + '，grantId ' + grant.grantId + '，原 TTL 不变）。')
      }
      const note = text(managerNote)
      const brief = dispatchBrief({ worker: this.v2.worker(worker.sessionId) || {}, ticket: moved.ticket, workOrder, lessons: resolvedLessons.lessons })
      if (inboxSource === 'resume' && note) {
        this.addManagerInbox(ticketId, worker.sessionId, note, by, 'resume')
        const delivered = await this.deliverSteerInbox(ticketId, worker.sessionId, 'resume-dispatch', 'immediate', {
          requestId, brief, dispatch: true,
        })
        if (!delivered) return { ok: false, code: 'steer_undelivered', ticketId, workerSessionId: worker.sessionId, status: 'blocked', message: 'resume reply could not be delivered' }
      } else {
        await this.promptSession(worker.sessionId, note ? brief + '\n\n[用户回复]\n' + note : brief, 'queue', requestId)
      }
      if (ticket.status === 'cancelled') {
        return { ok: false, code: 'ticket_not_working', message: 'ticket was stopped during dispatch', ticketId, status: ticket.status }
      }
      // Count a hit only after the brief actually went out.
      if (lessonIds.length) {
        this.lessons.bumpHits(lessonIds)
        this.routerEvent({
          event: 'lesson.injected',
          ticketId,
          sessionId: worker.sessionId,
          actor: 'router',
          reason: 'worker brief',
          payload: { lessonIds, source: resolvedLessons.source },
        })
      }
      return { ok: true, ticketId, workerSessionId: worker.sessionId, status: 'working', lessons: lessonIds, lessonsSource: resolvedLessons.source }
    } catch (error) {
      const message = String(error && error.message ? error.message : error)
      // A stop or report can win while prompt() is in flight. Do not rewrite
      // its state or release a newer assignment because this prompt failed late.
      if (ticket.status !== 'working' || String(ticket.executor) !== worker.sessionId) {
        return { ok: false, code: 'ticket_not_working', message, ticketId, status: ticket.status }
      }
      this.service.tickets.transitionTicket(ticketId, 'blocked', {
        actor: 'router',
        executor: worker.sessionId,
        waitingOn: 'environment',
        blockedReason: 'Worker 派发失败：' + message,
        reason: 'dispatch prompt failed',
      })
      this.v2.setTicketMeta(ticketId, { phase: 'blocked' })
      this.releaseWorkerForTicket(ticketId, 'dispatch.failed')
      this.routerEvent({
        event: 'dispatch.blocked',
        ticketId,
        sessionId: worker.sessionId,
        actor: 'router',
        reason: 'dispatch prompt failed',
        payload: { workerId: worker.sessionId, requestId, message },
      })
      return { ok: false, code: 'dispatch_failed', message, ticketId }
    }
  }

  async ticketBlock(args, exec) {
    if (!this.advisorCaller(exec)) return { ok: false, code: 'forbidden', message: 'only an Advisor may block a ticket' }
    const ticketId = text(args.ticketId)
    const ticket = this.service.tickets.ticket(ticketId)
    if (!ticket) return { ok: false, code: 'ticket_missing', message: 'ticket not found: ' + ticketId }
    if (ticket.status !== 'open') return { ok: false, code: 'ticket_not_open', message: 'ticket is ' + ticket.status }
    const reason = text(args.reason)
    if (!reason) return { ok: false, code: 'reason_required', message: 'reason must not be empty' }
    const question = text(args.question) || reason
    const moved = this.service.tickets.transitionTicket(ticketId, 'blocked', {
      actor: 'advisor',
      executor: 'advisor',
      waitingOn: 'user',
      blockedReason: reason,
      attention: { kind: 'question', question },
      reason: 'waiting on the user',
    })
    if (!moved.ok) return { ok: false, code: moved.code, message: moved.message }
    this.v2.setTicketMeta(ticketId, { phase: 'blocked' })
    await this.notifyChat('ticket ' + ticketId + ' 需要你确认：' + question + '（答复后用 chatbot_resume 继续）')
    return { ok: true, ticketId, status: 'blocked' }
  }

  /**
   * Research/knowledge path: the Advisor investigated read-only and answers the
   * user directly. The ticket goes open -> done in one atomic transition, so no
   * WorkOrder and no Worker are ever created for it.
   */

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

  completedReportFor(ticketId, workerId) {
    const ticket = this.service.tickets.ticket(ticketId)
    const startedAt = ticket && ticket.attempt ? Number(ticket.attempt.startedAt || 0) : 0
    return this.v2.reportsFor(ticketId, 100).reverse().find(report => report.status === 'done'
      && String(report.workerId) === String(workerId) && Number(report.at || 0) >= startedAt
      && text(report.summary) && arrayOfText(report.evidence).length) || null
  }

  async finalizeSavedDone(ticketId) {
    const ticket = this.service.tickets.ticket(ticketId)
    if (!ticket || TERMINAL.has(ticket.status)) return false
    const report = this.completedReportFor(ticketId, ticket.executor)
    if (!report) return false
    const resolved = await this.service.resolve(String(ticket.executor))
    if (resolved && !('error' in resolved)) {
      return await this.workerReport({ ticketId, status: 'done', summary: report.summary, evidence: report.evidence }, { agent: resolved.agent })
    }
    return false
  }

  async workerReport(args, exec) {
    if (!this.workerCaller(exec)) return { ok: false, code: 'forbidden', message: 'only a Worker may report' }
    const ticketId = text(args.ticketId)
    const ticket = this.service.tickets.ticket(ticketId)
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
    // Lesson proposals stay inert: they go to the v2 candidate list, and only
    // an Advisor lesson_review can promote them into the library.
    const lessonCandidates = this.recordLessonCandidates(ticketId, workerId, report.reportId, args.lessons)
    if (lessonCandidates) report.lessonCandidates = lessonCandidates
    this.v2.addReport(report)
    // A worker that can report has certainly begun executing. Confirm while the
    // ticket is still working (before any status branch transitions it), so the
    // 60s sweep can never park a ticket that is demonstrably alive.
    const attempt = ticket.attempt
    if (!approvalBlocked && attempt && attempt.lastRequestId && !attempt.confirmedAt) {
      try {
        this.service.tickets.confirmDispatchAttempt(ticketId, attempt.lastRequestId)
      } catch (error) {
        this.log('warn', 'could not confirm dispatch for ' + ticketId + ' from worker report: ' + String(error && error.message ? error.message : error))
      }
    }
    if (approvalBlocked && status === 'done') {
      // A valid completion report is durable evidence, not an approval timeout.
      // Reject obsolete requests rather than authorize any not-yet-run command.
      this.supersedeTicketApprovals(ticketId, { reason: 'worker reported done with evidence', outcome: 'rejected' })
      this.resumeAfterApproval(ticketId, 'completed work superseded obsolete approval')
    } else if (approvalBlocked) return this.approvalBlockedReport(ticket, { status, summary, question, report })
    if (status === 'progress') {
      this.service.tickets.updateTicket(ticketId, { progress: { lastPhase: summary.slice(0, 200), lastEventAt: now() } })
      return { ok: true, ticketId, status, report, lessonCandidates }
    }
    if (status === 'blocked') {
      const moved = this.service.tickets.transitionTicket(ticketId, 'blocked', {
        actor: 'worker',
        executor: workerId,
        waitingOn: 'user',
        blockedReason: summary || question,
        attention: { kind: 'question', question: question || summary },
        reason: 'worker needs the user',
      })
      if (!moved.ok) return { ok: false, code: moved.code, message: moved.message }
      this.v2.setTicketMeta(ticketId, { phase: 'blocked' })
      this.releaseWorkerForTicket(ticketId, 'worker.report.blocked')
      await this.notifyChat('ticket ' + ticketId + ' 被 Worker 暂停，需要你回答：' + (question || summary) + '（答复后用 chatbot_resume 继续）')
      return { ok: true, ticketId, status: 'blocked', report, lessonCandidates }
    }
    if (status === 'done') {
      const pendingBeforeDone = this.v2.pendingInbox(ticketId, workerId)
      if (pendingBeforeDone.length) {
        const delivered = await this.deliverSteerInbox(ticketId, workerId, 'done', 'done-retry')
        if (!delivered) {
          const current = this.service.tickets.ticket(ticketId)
          return { ok: false, code: 'steer_undelivered', message: 'pending manager inbox could not be delivered', ticketId, status: current?.status || ticket.status }
        }
      }
      this.supersedeTicketApprovals(ticketId, { reason: 'worker completion supersedes obsolete approval', outcome: 'rejected' })
      const moved = this.service.tickets.transitionTicket(ticketId, 'done', {
        actor: 'worker',
        executor: workerId,
        failure: null,
        resolution: { kind: 'done', summary, evidence },
        reason: 'worker reported done',
      })
      if (!moved.ok) return { ok: false, code: moved.code, message: moved.message }
      try { await this.service.grants.onTicketChanged(moved.ticket) } catch (error) {
        this.log('warn', 'could not restore grants for ' + ticketId + ': ' + String(error && error.message ? error.message : error))
      }
      this.v2.setTicketMeta(ticketId, { phase: 'done' })
      this.releaseWorkerForTicket(ticketId, 'ticket.done')
      this.learnCompletedTicket(workerId, ticketId)
      await this.notifyChat('ticket ' + ticketId + ' 已完成：' + summary
        + (evidence.length ? '\n证据：' + evidence.join('; ') : '')
        + (lessonCandidates ? '\n经验候选 ' + lessonCandidates + ' 条，待 Advisor 用 lesson_review 审阅（不会自动生效）。' : ''))
      return { ok: true, ticketId, status: 'done', report, lessonCandidates }
    }
    const moved = this.service.tickets.transitionTicket(ticketId, 'failed', {
      actor: 'worker',
      executor: workerId,
      failure: { code: 'worker_failed', message: summary },
      reason: 'worker reported failure',
    })
    if (!moved.ok) return { ok: false, code: moved.code, message: moved.message }
    this.v2.setTicketMeta(ticketId, { phase: 'failed' })
    await this.recordSteerUndelivered(ticketId, workerId, 'failed')
    this.releaseWorkerForTicket(ticketId, 'ticket.failed')
    await this.notifyChat('ticket ' + ticketId + ' 失败了：' + summary)
    return { ok: true, ticketId, status: 'failed', report, lessonCandidates }
  }

  /**
   * Absorb a completed ticket's routing tags and primary topic into the Worker's
   * soft hints. Explicit tags are never learned, so a tag cannot be both.
   */
  learnCompletedTicket(workerId, ticketId) {
    try {
      const worker = this.v2.worker(workerId)
      if (!worker) return
      const meta = this.v2.ticketMeta(ticketId)
      const workOrder = this.v2.workOrder(ticketId)
      const tags = mergeTags(meta.routingTags, workOrder && workOrder.routing ? workOrder.routing.tags : [])
      const explicit = Array.isArray(worker.tags) ? worker.tags : []
      const learned = tags.filter(tag => !explicit.includes(tag))
      const autoTags = mergeTags(learned, worker.autoTags || []).filter(tag => !explicit.includes(tag)).slice(0, AUTO_TAG_LIMIT)
      const primaryTopicId = this.service.store.primaryTopicFor(ticketId)
      const recentTopics = primaryTopicId
        ? [primaryTopicId, ...(worker.recentTopics || []).filter(id => id !== primaryTopicId)].slice(0, 5)
        : (worker.recentTopics || [])
      const changed = JSON.stringify(autoTags) !== JSON.stringify(worker.autoTags || [])
        || JSON.stringify(recentTopics) !== JSON.stringify(worker.recentTopics || [])
      if (!changed) return
      this.v2.addWorker(workerId, { autoTags, recentTopics }, { trigger: 'worker.learn.done' })
    } catch (error) {
      this.log('warn', 'could not learn from completed ticket ' + ticketId + ': ' + String(error && error.message ? error.message : error))
    }
  }

  /**
   * A report that arrives while the ticket is parked on an approval. The Worker
   * is alive, so progress is kept. Valid done reports are handled before this
   * branch and supersede obsolete requests without authorizing them. A failed
   * report stays parked for an explicit decision, never a fabricated timeout.
   */
  approvalBlockedReport(ticket, { status, summary, question, report }) {
    const ticketId = ticket.ticketId
    if (status === 'progress') {
      this.service.tickets.updateTicket(ticketId, { progress: { lastPhase: summary.slice(0, 200), lastEventAt: now() } })
      return { ok: true, ticketId, status: 'blocked', approvalPending: true, report, lessonCandidates: report.lessonCandidates || 0 }
    }
    if (status === 'blocked') {
      // Already parked on the approval; its attention outranks a new question.
      return { ok: true, ticketId, status: 'blocked', approvalPending: true, report }
    }
    // A report is not a synthetic authorization timeout.
    return { ok: false, code: 'approval_unresolved', status: 'blocked', ticketId, approvalPending: true, report }
  }

  status() {
    const tickets = this.v2.ticketMetas()
      .map(meta => {
        const ticket = this.service.tickets.ticket(meta.ticketId)
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
      chatSessionId: this.v2.chatSessionId,
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
    // Live direct chatter from a previous process is not replayed.
    this.resetDirectSendQueue()
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

  async bootstrapCognition() {
    this.cognition.ensure()
    const marker = join(this.cognition.base, '.bootstrapped')
    if (existsSync(marker)) return { bootstrapped: false }
    const read = path => {
      try { return readFileSync(path, 'utf8') } catch { return '' }
    }
    const principles = [
      '# Principles',
      '',
      '1. 全局唯一：只有一个阿汐，避免多头决策。',
      '2. 有始有终：任务要有结果、失败原因或卡点说明。',
      '3. 长期记忆：记住稳定偏好与项目认知，但不把对话原文当记忆。',
      '4. 定期反思：从复盘中提炼可复用经验。',
      '5. 兼容常规会话：无侵入地协管，不改用户会话上下文。',
      '',
      '边界：Sage 只维护记忆；Advisor 只出 WorkOrder；Router 是唯一派发入口；Worker 只执行。',
    ].join('\n')
    const architecture = read(join(this.workspaceRoot || '', 'docs/architecture.md')) || read('docs/architecture.md')
    const project = [
      '# dsh-ria',
      '',
      'Ria 是 DSH 上的超级助理：Chat / Router / Advisor / Worker 分层，ticket 是唯一耐久桥。',
      '',
      '## 架构（bootstrap 摘要）',
      architecture.slice(0, 1200) || '（architecture.md 不可读）',
    ].join('\n')
    const lessonsRaw = (() => {
      try { return JSON.parse(read(join(this.stateDir, 'lessons.json')) || '{}') } catch { return {} }
    })()
    const lessons = Array.isArray(lessonsRaw.entries) ? lessonsRaw.entries.slice(0, 10) : []
    // Bootstrap must not import the legacy memory.md: durable Chat memory lives
    // in cognition/chat/; bootstrap must not import legacy gateway memory.
    const prefs = '（无历史记忆；偏好待用户确认）'
    const decisions = lessons.length
      ? lessons.map(item => '- ' + [item.scenario, item.approach].filter(Boolean).join(' → ')).join('\n')
      : '- 认知库由 Sage 维护；初始版本来自 DESIGN.md 与现有文档。'
    const files = [
      ['principles.md', principles],
      ['projects/dsh-ria.md', project],
      ['chat/preferences.md', '# Preferences\n\n' + prefs],
      ['chat/agreements.md', '# Agreements\n\n- 用户通过 Chat 下达任务；Advisor/Worker 只接受 Ria 注入。'],
      ['chat/decisions.md', '# Decisions\n\n' + decisions],
    ]
    for (const [rel, body] of files) {
      if (!this.cognition.readIfExists(rel).trim()) this.cognition.write(rel, body, { reason: 'bootstrap', source: 'sage-bootstrap' })
    }
    this.cognition.write('.bootstrapped', new Date().toISOString() + '\n', { reason: 'bootstrap marker', source: 'sage-bootstrap' })
    this.routerEvent({ event: 'cognition.bootstrap', ticketId: null, sessionId: 'sage', actor: 'sage', reason: 'initial cognition', payload: { files: files.map(item => item[0]) } })
    return { bootstrapped: true, files: files.map(item => item[0]) }
  }

  async startup() {
    // Direct mode is memory-only by design; a fresh startup is always normal
    // Chat mode.
    this.direct = undefined
    this.cleanupDirectBacklog()
    // A grant applied to a Worker must not survive a restart silently. Restore
    // expired/closed grants before any new work starts; failures are retried
    // by GrantService and must not prevent the Chat from coming up.
    try {
      await this.service.grants.reconcile()
    } catch (error) {
      this.log('warn', 'grant reconcile on startup failed: ' + String(error && error.message ? error.message : error))
    }
    try {
      await this.ensureChat()
    } catch (error) {
      this.v2.recordError('chatbot.startup', error)
      this.log('error', 'Chat startup failed: ' + String(error && error.message ? error.message : error))
      return
    }
    try { await this.bootstrapCognition() } catch (error) {
      this.log('warn', 'cognition bootstrap failed: ' + String(error && error.message ? error.message : error))
    }
    // Stale bindings (deleted sessions) must not survive a restart and then win
    // a later selection only to fail the dispatch.
    try { await this.reconcileWorkerBindings() } catch (error) {
      this.log('warn', 'worker binding reconcile failed: ' + String(error && error.message ? error.message : error))
    }
    try { await this.reconcileWorkerStates() } catch (error) {
      this.log('warn', 'worker state reconcile failed: ' + String(error && error.message ? error.message : error))
    }
    try { await this.ensureSage() } catch (error) {
      this.log('warn', 'Sage startup failed (Chat/Router still work): ' + String(error && error.message ? error.message : error))
    }
    try {
      await this.renameRoleSessions()
    } catch (error) {
      this.log('warn', 'role-session rename on startup failed: ' + String(error && error.message ? error.message : error))
    }
    for (const meta of this.v2.ticketMetas()) {
      let ticket = this.service.tickets.ticket(meta.ticketId)
      if (!ticket) continue
      if (ticket.status === 'working') {
        const moved = this.service.tickets.transitionTicket(ticket.ticketId, 'blocked', {
          actor: 'router',
          executor: ticket.executor,
          waitingOn: 'environment',
          blockedReason: 'Ria 重启中断了这次执行',
          reason: 'startup recovery',
        })
        if (moved.ok) {
          this.v2.setTicketMeta(ticket.ticketId, { phase: 'blocked' })
          this.routerEvent({
            event: 'dispatch.blocked',
            ticketId: ticket.ticketId,
            sessionId: ticket.executor || 'self',
            actor: 'router',
            reason: 'startup recovery',
            payload: { workerId: ticket.executor || 'self', message: 'Ria 重启中断了这次执行' },
          })
          if (ticket.executor && ticket.executor !== 'self' && ticket.executor !== 'advisor') {
            this.releaseWorkerForTicket(ticket.ticketId, 'startup.interrupted')
          }
          await this.notifyChat('ticket ' + ticket.ticketId + ' 因 Ria 重启中断，已暂停；需要你决定是否继续（用 chatbot_resume 继续）。')
        }
        continue
      }
      // A crash between creating the intake ticket and routing it leaves an
      // intake ticket that no one owns. Open it and hand it back to the Advisor.
      if (ticket.status === 'intake' && meta.phase === 'advisor') {
        const opened = this.service.tickets.transitionTicket(ticket.ticketId, 'open', {
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
          const request = meta.requestId ? this.v2.request(meta.requestId) : null
          await this.createAdvisorForTicket(ticket, meta, request, '[Startup] 继续处理这张 ticket。')
        } catch (error) {
          this.log('warn', 'could not resume ' + ticket.ticketId + ' on startup: ' + String(error && error.message ? error.message : error))
        }
      }
    }
    this.notifyRestart()
  }
}
