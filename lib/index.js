// dsh-ria host half.
//
// v2 (the default): a Chat session faces the user, a Global Advisor turns a
// ticket into a WorkOrder, a deterministic Router writes ticket state, and
// managed Worker sessions execute one ticket at a time. Tickets are the durable
// bridge. State lives in DSH_HOME/state/ria: ria.json for tickets and
// deliveries, v2.json for Chat/Advisor/worker bindings and reports.
//
// The legacy one-PTC-Ria manager (the fifteen ria_* tools and { v2: false })
// is gone: every role, tool surface and state path below is v2 only.

import { randomUUID } from 'node:crypto'
import { accessSync, closeSync, constants as fsConstants, fsyncSync, openSync, readFileSync, readdirSync, statSync, unlinkSync, writeSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { lastTurnEnd } from './turn-end.mjs'
import { ACTIVE_STATUSES, FEEDBACK_BODY_LIMIT, FEEDBACK_DEDUPE_MS, MAX_CHILDREN, MAX_RECOVERY_ATTEMPTS as TICKET_MAX_RECOVERY_ATTEMPTS, TICKET_STATUSES, TERMINAL_STATUSES, WAITING_ON_BY_STATUS, applyDependencyState, assessDependencies, assertTicketInvariants, canTransition, checklistCloseCheck, checklistPendingSummary, checklistProgress, isTerminal, normalizeAttention, normalizeChecklist, normalizeTicket, transitionError, validateDependencyInput } from './tickets.mjs'
import { TOPIC_BRIEF_LIMIT, TOPIC_TITLE_LIMIT, linkTopic as linkTopicIn, linksForTicket, mergeTopicLinks, newTopicId, normalizeLinks, normalizeProjectKey, normalizeTopic, normalizeTopicTags, normalizeTopics, primaryTopicForTicket, topicProgressCounts, topicSummaryInfo, unlinkTopic as unlinkTopicIn } from './topics.mjs'
import { GrantService } from './grants.mjs'
import { HOST_REQUEST_PREFIX, isHostRequestId } from './wechat/request-ids.mjs'
import { WechatService } from './wechat/service.mjs'
import { WechatClawService } from './channels/wechat-claw.mjs'
import { formatFileSize, normalizeWechatClawFileOptions, safeClawFileName } from './channels/wechat-claw-file.mjs'
import { QqBotService } from './channels/qq-bot.mjs'
import { OUTBOX_TICK_MS, Outbox, WECHAT_ASSISTANT_NOTE_KIND } from './outbox.mjs'
import { MEMORY_SETTINGS_RANGES, memoryStatusView, normalizeMemorySettings } from './memory.mjs'
import { measureText } from './shared/text.mjs'
import { ensureDir, writeAtomic } from './shared/fs.mjs'
import { routeWithLlm } from './router/index.mjs'
import { V2Controller } from './core/controller.mjs'
import { projectKey } from './roles/cognition.mjs'
import { StateWriter } from './state/writer.mjs'
import { TicketRepository } from './state/tickets-repository.mjs'
import { SqliteTicketRuntime, resolveStorageMode } from './state/sqlite/runtime.mjs'
import { writeMirrorSnapshot } from './state/sqlite/mirror.mjs'
import { transaction as sqliteTransaction } from './state/sqlite/db.mjs'
import { DEFAULT_ESCALATION_POLICY, normalizeEscalationPolicy } from './core/risk.mjs'
import { RouterEventLog } from './router-events.mjs'
import { REFLECTION_LOCK_TTL_MS, REFLECTION_WATCH_TOPIC_ID, acquireReflectionLock, applyReflectionReportStats, eventTime, insideWindow, isReflectionDate, makeReflectionRun, normalizeEvents, readArchiveSession, sessionArchiveInfo, readMemoryContext, readOutboxContext, readReflectionLock, readReflectionRun, readReflectionState, reflectionDate, reflectionInstruction, reflectionManualPath, reflectionReportPath, reflectionRunOrdinal, reflectionStatusView, reflectionTitle, reflectionWindow, removeReflectionLock, ticketView, querySession, validateReflectionReport, writeReflectionFinalReport, writeReflectionLock, writeReflectionReport, writeReflectionRun, writeReflectionState } from './reflection.mjs'

export const name = 'dsh-ria'
export const inject = ['webServer', 'sessionController', 'workspaceRegistry', 'sandboxPolicy', 'approval', 'agents']

const RIA_PRESET = 'ptc'
const API_PREFIX = '/plugins/dsh-ria/api'
const MAX_RECOVERY_ATTEMPTS = TICKET_MAX_RECOVERY_ATTEMPTS
const DISPATCH_NOTE_HISTORY = 100
const DISPATCH_CONFIRM_TIMEOUT_MS = 60_000
const RECENT_WORKER_WINDOW_MS = 7 * 24 * 60 * 60 * 1000
const RECENT_WORKER_RETENTION_MS = 30 * 24 * 60 * 60 * 1000
const isPausedError = error => Boolean(error && (error.code === 'WECHAT_PAUSED' || error.name === 'PauseError'))
const errorText = error => String(error && error.message ? error.message : error)
const TICKET_ARCHIVE_WINDOW_MS = 24 * 60 * 60 * 1000
const TICKET_ARCHIVE_KEEP = 50
const TICKET_ARCHIVE_BATCH = 200
const TICKET_LOG_MONTHS = 12
const TICKET_HISTORY_LIMIT = 50
const TICKET_LOG = 'tickets.log.jsonl'
const TICKET_LOG_PREFIX = 'tickets-'
const TICKET_LOG_PATTERN = /^tickets-\d{4}-\d{2}\.jsonl$/
// sessionController.state() calls signal.throwIfAborted() unconditionally, so a
// missing signal crashes rather than meaning "no cancellation".
const NEVER_ABORTED = new AbortController().signal
// One durable outbox key per readiness. Boot wakes add a boot id so a restart
// can re-announce an undispatched ticket without colliding with its old wake.
const queueWakeDedupeKey = (ticketId, readyAt, bootId) => {
  const base = 'queue_wake:' + String(ticketId) + ':' + readyAt
  return bootId ? base + ':boot:' + String(bootId) : base
}
// Two one-shot checks after a risky commit: enough to catch a turn that was
// still running, short enough that a lost wake is not silent for minutes.
const READY_VERIFY_DELAYS_MS = [2000, 10000]
// A board prompt is a chat message, not a ticket: keep it short enough that Ria
// can read the whole note in one turn and the board input stays a single line.
const BOARD_ASK_TEXT_LIMIT = 1000
// WeChat Claw image transfer is always on. The field stays in persisted state so
// older ria.json files still load, but stored false values and PATCHes are ignored.
const WECHAT_CLAW_IMAGE_FIXED = Object.freeze({ inbound: true, outbound: true })
const REFLECTION_SETTINGS_DEFAULTS = Object.freeze({
  enabled: false,
  cadence: 'daily',
  time: '23:40',
  weekday: 1,
  model: null,
  provider: null,
  reasoningEffort: null,
})
const REFLECTION_TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/
const REFLECTION_WEEKDAYS = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU']
const REFLECTION_SCHEDULE_TITLE = 'Ria: 定期反思'
const REFLECTION_SCHEDULE_PROMPT = '这是 Ria 的定期反思提醒。请用 ria_reflect status → begin(trigger="schedule", forDate 取 occurrence_at 在 Asia/Shanghai 的日期) → dispatch → finish 跑一次反思；没有可反思内容也要如实 finish。'
const REFLECTION_CATCHUP_TITLE_PREFIX = 'Ria: 反思补跑 '
const REFLECTION_CATCHUP_PROMPT = date => '[REFLECTION CATCHUP] forDate=' + date + ' — 请用 ria_reflect status/begin(trigger="schedule")/dispatch/finish 补跑这次定期反思；如果已经完成或已有运行，报告状态并停止。'
const REFLECTION_DAY_MS = 24 * 60 * 60 * 1000

export const STYLE_SETTINGS_DEFAULTS = Object.freeze({
  enabled: false,
  preset: 'concise',
  custom: '',
})
export const STYLE_PRESETS = Object.freeze(['concise', 'warm', 'formal', 'playful'])
const STYLE_CUSTOM_LIMIT = 300
export const STYLE_PRESET_PROMPTS = Object.freeze({
  concise: [
    '能一句不两句：先给结论，再列依据；不铺陈背景，不写起承转合，数字和结果放前面，像一条刚发出的快讯，能删的词都删。',
    '例：三个都跑完了。BA 那条判死，原因是对应不可用；mosaic 等你选方向。',
    '反例：经过一轮排查和讨论，我们目前已经完成了三项工作，具体情况如下所述。',
  ].join('\n'),
  warm: [
    '多一句人味：先接住对方的处境，再讲事情；允许一个温和的语气词，但仍不灌水，结论和数字照给，像同事在旁边说话。',
    '例：三个都跑完了～ BA 那条结论不太好，不过原因查清了；mosaic 还差你定个方向。',
    '反例：系统显示任务已结束，请自行查看详情，如有疑问请提交工单处理。',
  ].join('\n'),
  formal: [
    '汇报口吻：术语精确，称呼用「您」，不用语气词；先陈述事实，再说明立场，事实、结论与待定项分开写，不替对方下判断，每一句都要能对外引用。',
    '例：三项均已完成。BA 结论为负面，原因是对应不可用；mosaic 待您确定方向。',
    '反例：这事儿差不多成了，您放心，后面应该没啥大问题。',
  ].join('\n'),
  playful: [
    '轻松一点：允许打一个比方或开一句玩笑，但不丢数字与结论；节奏可以跳，信息必须落地，别为了好玩绕弯子。',
    '例：三个都跑完了——BA 那条撞了墙，原因是对应不可用；mosaic 还等你指个方向。',
    '反例：本段工作已按要求完成，如有问题请随时告知，我们会持续跟进。',
  ].join('\n'),
})
const STYLE_BOUNDARIES = Object.freeze([
  '这套风格只作用于你写给用户的自然语言：对话回复、ria_request 的 note 卡片、摘要与报告的正文。',
  '不改变：工具调用与参数、术语约定（工单/字段名）、必报项（数字、commit、路径、卡点、下一步、待用户拍板的问题）、note ≤500 字、安全与重启规则。',
  '风格是包装层，内容契约优先：不为简短省略必报项，不为语气添加无信息客套。',
])

function styleCustomLength(value) {
  return Array.from(String(value === null || value === undefined ? '' : value)).length
}

/** Normalise the three stored style fields; unknown fields and invalid values never persist. */
export function normalizeStyleSettings(value) {
  const raw = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  const preset = STYLE_PRESETS.includes(raw.preset) ? raw.preset : STYLE_SETTINGS_DEFAULTS.preset
  const custom = Array.from(String(raw.custom === null || raw.custom === undefined ? '' : raw.custom)).slice(0, STYLE_CUSTOM_LIMIT).join('')
  return {
    enabled: raw.enabled === true,
    preset,
    custom,
  }
}

/** The complete Voice section, or '' when the style is off. This is the only source of the text. */
export function voicePrompt(value) {
  const style = normalizeStyleSettings(value)
  if (!style.enabled) return ''
  const lines = [
    '',
    '## Voice',
    STYLE_PRESET_PROMPTS[style.preset],
    '边界（固定写死，与预设无关）：',
    ...STYLE_BOUNDARIES.map(line => '- ' + line),
  ]
  if (style.custom) {
    lines.push('', '用户在预设之上追加的要求（冲突时以内容契约为先）：' + style.custom)
  }
  return lines.join('\n')
}

/** Keep unknown reflection fields while normalising the fields the plugin owns. */
function normalizeReflectionSettings(value) {
  const raw = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  const next = { ...REFLECTION_SETTINGS_DEFAULTS, ...raw }
  next.enabled = raw.enabled === true
  next.cadence = raw.cadence === 'weekly' ? 'weekly' : 'daily'
  next.time = typeof raw.time === 'string' && REFLECTION_TIME_PATTERN.test(raw.time) ? raw.time : REFLECTION_SETTINGS_DEFAULTS.time
  next.weekday = Number.isInteger(raw.weekday) && raw.weekday >= 1 && raw.weekday <= 7 ? raw.weekday : REFLECTION_SETTINGS_DEFAULTS.weekday
  next.model = typeof raw.model === 'string' && raw.model ? raw.model : null
  next.provider = typeof raw.provider === 'string' && raw.provider ? raw.provider : null
  next.reasoningEffort = typeof raw.reasoningEffort === 'string' && raw.reasoningEffort ? raw.reasoningEffort : null
  return next
}

/**
 * Optional approval shortcut for managed Workers. Disabled by default. v2 owns
 * its own risk policy (lib/core/risk.mjs); this whitelist is independent of the
 * host approval UI and applies to automatic decisions only.
 */
export function normalizeApprovalAutoAllow(value) {
  const raw = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  const tools = Array.isArray(raw.tools)
    ? [...new Set(raw.tools.map(item => (typeof item === 'string' ? item.trim() : '')).filter(Boolean))].slice(0, 20)
    : []
  return { enabled: raw.enabled === true, tools }
}

/** Asia/Shanghai has no DST, so a fixed +08:00 shift is exact. */
function shanghaiDateParts(ms) {
  const shifted = new Date(ms + 8 * 60 * 60 * 1000)
  const weekday = shifted.getUTCDay() === 0 ? 7 : shifted.getUTCDay()
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    weekday,
  }
}

function shanghaiDayNumber(parts) {
  return Date.UTC(parts.year, parts.month - 1, parts.day) / REFLECTION_DAY_MS
}

function shanghaiDayFromNumber(dayNumber) {
  const date = new Date(dayNumber * REFLECTION_DAY_MS)
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() }
}

function reflectionOccurrenceAt(parts, time) {
  const [hour, minute] = String(time).split(':').map(Number)
  return Date.UTC(parts.year, parts.month - 1, parts.day, hour - 8, minute, 0, 0)
}

function reflectionOccurrenceOffset(settings, at, direction) {
  const parts = shanghaiDateParts(at)
  const day = shanghaiDayNumber(parts)
  if (settings.cadence !== 'weekly') {
    let candidate = reflectionOccurrenceAt(parts, settings.time)
    if (direction > 0) return candidate > at ? candidate : candidate + REFLECTION_DAY_MS
    return candidate <= at ? candidate : candidate - REFLECTION_DAY_MS
  }
  const delta = direction > 0
    ? (settings.weekday - parts.weekday + 7) % 7
    : (parts.weekday - settings.weekday + 7) % 7
  let candidate = reflectionOccurrenceAt(shanghaiDayFromNumber(day + direction * delta), settings.time)
  if (direction > 0) {
    if (candidate <= at) candidate = reflectionOccurrenceAt(shanghaiDayFromNumber(day + delta + 7), settings.time)
  } else if (candidate > at) {
    candidate = reflectionOccurrenceAt(shanghaiDayFromNumber(day - delta - 7), settings.time)
  }
  return candidate
}

function nextReflectionOccurrence(settings, at = now()) {
  return reflectionOccurrenceOffset(settings, at, 1)
}

function previousReflectionOccurrence(settings, at = now()) {
  return reflectionOccurrenceOffset(settings, at, -1)
}

function reflectionRrule(settings, at = now()) {
  const occurrence = nextReflectionOccurrence(settings, at)
  const parts = shanghaiDateParts(occurrence)
  const hour = String(settings.time).slice(0, 2)
  const minute = String(settings.time).slice(3, 5)
  const pad = value => String(value).padStart(2, '0')
  const start = String(parts.year) + pad(parts.month) + pad(parts.day) + 'T' + hour + minute + '00'
  const rule = settings.cadence === 'weekly'
    ? 'FREQ=WEEKLY;BYDAY=' + REFLECTION_WEEKDAYS[settings.weekday - 1]
    : 'FREQ=DAILY'
  return 'DTSTART;TZID=Asia/Shanghai:' + start + '\nRRULE:' + rule
}

function recoveryLimitReason() {
  return '自动恢复已达上限（' + MAX_RECOVERY_ATTEMPTS + '/' + MAX_RECOVERY_ATTEMPTS + '），需要用户手动处理'
}
const dshHome = () => process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')
const now = () => Date.now()
const newId = prefix => prefix + now().toString(36) + '_' + randomUUID().replace(/-/g, '').slice(0, 10)
const asString = value => typeof value === 'string' ? value.trim() : ''

/** The auto-pause notice names the paused channel and the message that paused it. */
const PAUSE_NOTICE_COPY = Object.freeze({
  wechat: {
    push: '微信「文件传输助手」推送',
    reply: '微信「文件传输助手」消息',
    defaultReason: '非微信通道消息',
  },
  'wechat-claw': {
    push: '微信 Claw 推送',
    reply: '微信 Claw 消息',
    defaultReason: '非微信 Claw 通道消息',
  },
  'qq-bot': {
    push: ' QQ 推送',
    reply: ' QQ 消息',
    defaultReason: '非 QQ 通道消息',
  },
})
function channelPauseNoticeText(channel, reason) {
  const copy = PAUSE_NOTICE_COPY[channel] || PAUSE_NOTICE_COPY.wechat
  const detail = asString(reason) || copy.defaultReason
  return '🌊 Ria 已自动暂停' + copy.push + '（原因：' + detail + '）。回一条' + copy.reply + '即可恢复；也可在 Ria 设置里关掉「自动暂停」。'
}
function wechatPauseNoticeText(reason) {
  return channelPauseNoticeText('wechat', reason)
}
const WECHAT_AUTO_PAUSE_NOTICE = wechatPauseNoticeText('非微信通道消息')

function clipText(text, limit) {
  const chars = [...String(text)]
  return chars.length > limit ? chars.slice(0, limit).join('') : String(text)
}

/**
 * Tool outputs cross the host's lossless-JSON boundary. Reflection views build
 * optional fields as undefined, which makes the host reject the whole result.
 * Strip those keys and array holes once at the tool boundary so every reflect
 * tool stays safe as new fields are added.
 */
function losslessToolValue(value) {
  if (Array.isArray(value)) {
    const list = []
    for (const item of value) {
      const cleaned = losslessToolValue(item)
      if (cleaned !== undefined) list.push(cleaned)
    }
    return list
  }
  if (value && typeof value === 'object') {
    const proto = Object.getPrototypeOf(value)
    if (proto !== Object.prototype && proto !== null) return null
    const record = {}
    for (const [key, item] of Object.entries(value)) {
      if (item === undefined) continue
      const cleaned = losslessToolValue(item)
      if (cleaned !== undefined) record[key] = cleaned
    }
    return record
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null
    return Object.is(value, -0) ? 0 : value
  }
  if (typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint') return undefined
  return value
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

function readText(file) {
  try {
    return readFileSync(file, 'utf8')
  } catch (error) {
    if (error && error.code === 'ENOENT') return ''
    throw error
  }
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


/**
 * The last assistant reply of a worker's final turn. The detail panel reads
 * this lazily; it never changes the board payload or the ticket schema.
 */
function lastAssistantResult(records) {
  const list = Array.isArray(records) ? records : []
  const lastTurn = lastTurnEnd(list)
  const turn = lastTurn && Number.isSafeInteger(lastTurn.turn) ? lastTurn.turn : undefined
  let found
  for (let index = list.length - 1; index >= 0; index -= 1) {
    const raw = list[index]
    const event = raw && raw.type === 'event' && raw.event && typeof raw.event === 'object' ? raw.event : raw
    if (!event || event.type !== 'assistant/message') continue
    const data = event.data && typeof event.data === 'object' ? event.data : {}
    const recordTurn = Number.isSafeInteger(data.turn) ? data.turn : undefined
    if (turn !== undefined && recordTurn !== undefined && recordTurn !== turn) continue
    const content = data.message && data.message.content ? data.message.content : data.content
    const text = textOfContent(content).trim()
    if (!text) continue
    found = {
      text,
      turn: recordTurn,
      at: typeof event.at === 'number' ? event.at : (typeof event.time === 'number' ? event.time : undefined),
    }
    break
  }
  if (!found) return null
  const chars = [...found.text]
  const result = { text: chars.length > 4000 ? clipText(found.text, 4000) + '…' : found.text }
  if (found.turn !== undefined) result.turn = found.turn
  else if (turn !== undefined) result.turn = turn
  if (found.at !== undefined) result.at = found.at
  if (lastTurn && lastTurn.outcome) result.outcome = lastTurn.outcome
  return result
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
    attention: ticket.attention || null,
    parentTicketId: ticket.parentTicketId || null,
    childTicketIds: Array.isArray(ticket.childTicketIds) ? [...ticket.childTicketIds] : [],
    resolution: ticket.resolution || null,
    failure: ticket.failure || null,
    attempts: Array.isArray(ticket.attempts) ? ticket.attempts.length : 0,
    createdAt: ticket.createdAt,
    updatedAt: ticket.updatedAt,
    closedAt: ticket.closedAt || null,
    recoveryCount: ticket.recovery ? ticket.recovery.count : 0,
    dependsOn: Array.isArray(ticket.dependsOn) ? [...ticket.dependsOn] : [],
    checklist: normalizeChecklist(ticket.checklist),
    progress: checklistProgress(ticket.checklist).text,
    readyAt: Number.isFinite(ticket.readyAt) ? ticket.readyAt : null,
    readyNotifiedAt: Number.isFinite(ticket.readyNotifiedAt) ? ticket.readyNotifiedAt : null,
    dependencyAlerts: Array.isArray(ticket.dependencyAlerts) ? ticket.dependencyAlerts.map(alert => ({ ...alert })) : [],
    revision: ticket.revision,
  }
}

function sessionTitle(summary) {
  const title = summary && summary.projections && summary.projections.values
    ? summary.projections.values.title
    : undefined
  return typeof title === 'string' ? title.trim() : ''
}

/**
 * The turn that is still open in this session, or null after its turn/end.
 * Used by the outbox: a dispatch card may only be attached to an open turn, so
 * a queued note waits for the next one instead of being recorded against a
 * finished turn where no client would show it.
 */
/** Stable identity of one dispatch confirmation: ticket, text and turn. */
function sideEffectKey(ticketId, note, turn) {
  return {
    ticketId: ticketId ? String(ticketId) : '',
    note: typeof note === 'string' ? note : String(note == null ? '' : note),
    turn: Number.isSafeInteger(turn) ? turn : null,
  }
}

function activeTurnNumber(session) {
  if (!session || typeof session.snapshotEvents !== 'function') return null
  let events
  try { events = session.snapshotEvents() } catch { return null }
  if (!Array.isArray(events)) return null
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (!event) continue
    if (event.type === 'turn/end') return null
    if (event.type === 'turn/start') {
      return Number.isSafeInteger(event.data && event.data.turn) ? event.data.turn : null
    }
  }
  return null
}

export class RiaStore {
  constructor(stateDir, options = {}) {
    this.stateDir = stateDir
    this.file = join(stateDir, 'ria.json')
    // storage=sqlite keeps the DB authoritative; the JSON file is only a mirror.
    this.runtime = options.runtime || null
    this.storage = this.runtime ? 'sqlite' : 'json'
    this.data = {
      schemaVersion: 5,
      version: 5,
      riaSessionId: undefined,
      riaPreset: undefined,
      createdAt: undefined,
      tickets: [],
      topics: [],
      links: [],
      ticketFeedback: [],
      deliveries: [],
      grants: [],
      recentWorkers: {},
      // Epoch ms of the newest real human message on any channel (web, WeChat,
      // Claw or QQ). Channel resumes use it as the replay anchor.
      lastHumanMessageAt: 0,
      settings: {
        progressCards: false,
        wechatAutoPause: true,
        approvalAutomation: true,
        // v2 keeps its own whitelist; legacy approvalAutomation stays untouched.
        approvalAutoAllow: normalizeApprovalAutoAllow(undefined),
        // Block direct user messages to Advisor/Worker sessions; they only accept Ria prompts.
        blockDirectUserMessages: true,
        // Per-request escalation policy for v2: strict | auto-low | auto-low-medium.
        escalationPolicy: DEFAULT_ESCALATION_POLICY,
        wechatClawImage: { inbound: true, outbound: true },
        reflection: normalizeReflectionSettings(undefined),
        style: normalizeStyleSettings(undefined),
        memory: normalizeMemorySettings(undefined),
      },
    }
    this.load()
    if (this.runtime) {
      this.hydrateFromSqlite()
      this.runtime.attachStore(this)
    }
  }

  hydrateFromSqlite() {
    const raw = this.runtime.hotTickets()
    // Normalize known fields without discarding extension fields or rewriting
    // committed append-only history. Hydration changes are committed, not just
    // blessed by adopting the normalized in-memory signature.
    const tickets = raw.map(item => {
      const normalized = normalizeTicket(item)
      return normalized ? { ...item, ...normalized, history: item.history || [] } : null
    }).filter(Boolean)
    this.runtime.adopt(raw)
    this.runtime.persist(tickets)
    this.data.tickets = tickets
  }

  load() {
    ensureDir(this.stateDir)
    const raw = readText(this.file)
    if (!raw.trim()) return
    try {
      const parsed = JSON.parse(raw)
      if (!parsed || typeof parsed !== 'object') return
      const data = parsed
      this.data.schemaVersion = 5
      this.data.version = 5
      this.data.riaSessionId = typeof data.riaSessionId === 'string' ? data.riaSessionId : undefined
      this.data.riaPreset = typeof data.riaPreset === 'string' ? data.riaPreset : undefined
      this.data.createdAt = Number.isFinite(data.createdAt) ? data.createdAt : undefined
      this.data.tickets = Array.isArray(data.tickets)
        ? data.tickets.map(item => normalizeTicket(item)).filter(Boolean)
        : []
      this.data.topics = normalizeTopics(data.topics)
      this.data.links = normalizeLinks(data.links)
      this.data.ticketFeedback = Array.isArray(data.ticketFeedback)
        ? data.ticketFeedback.filter(item => item && typeof item === 'object' && typeof item.feedbackId === 'string' && typeof item.kind === 'string')
        : []
      this.data.deliveries = Array.isArray(data.deliveries) ? data.deliveries.filter(item => item && typeof item.deliveryId === 'string') : []
      this.data.grants = Array.isArray(data.grants) ? data.grants.filter(item => item && typeof item.grantId === 'string') : []
      this.data.lastHumanMessageAt = Number.isFinite(data.lastHumanMessageAt) && data.lastHumanMessageAt > 0
        ? data.lastHumanMessageAt
        : 0
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
      this.data.settings.progressCards = typeof settings.progressCards === 'boolean' ? settings.progressCards : false
      this.data.settings.wechatAutoPause = typeof settings.wechatAutoPause === 'boolean' ? settings.wechatAutoPause : true
      this.data.settings.approvalAutomation = typeof settings.approvalAutomation === 'boolean' ? settings.approvalAutomation : true
      this.data.settings.approvalAutoAllow = normalizeApprovalAutoAllow(settings.approvalAutoAllow)
      this.data.settings.blockDirectUserMessages = typeof settings.blockDirectUserMessages === 'boolean' ? settings.blockDirectUserMessages : true
      this.data.settings.escalationPolicy = normalizeEscalationPolicy(settings.escalationPolicy) || DEFAULT_ESCALATION_POLICY
      this.data.settings.wechatClawImage = { ...WECHAT_CLAW_IMAGE_FIXED }
      this.data.settings.reflection = normalizeReflectionSettings(settings.reflection)
      this.data.settings.style = normalizeStyleSettings(settings.style)
      this.data.settings.memory = normalizeMemorySettings(settings.memory)
    } catch {
      // A corrupt state file must not stop DSH from starting. Keep the file for inspection.
    }
  }

  save() {
    if (this.runtime) {
      // The DB row is written inside the caller's writer transaction; the JSON
      // file is only a debounced mirror written after COMMIT, never on the hot path.
      this.runtime.stageStoreSave()
      this.postCommit(() => this.runtime.scheduleMirror(), 'sqlite.mirror')
      this.postCommit(() => {
        if (typeof this.onStateSaved === 'function') this.onStateSaved()
        else this.notifyTicketsCommitted()
      }, 'sqlite.saved')
      return
    }
    writeAtomic(this.file, JSON.stringify(this.data, null, 2) + '\n')
    if (typeof this.onStateSaved === 'function') this.onStateSaved()
    else this.notifyTicketsCommitted()
  }

  notifyTicketsCommitted() {
    try { if (typeof this.onTicketsCommitted === 'function') this.onTicketsCommitted() } catch { /* notification is best effort */ }
  }

  postCommit(callback, key) {
    const notify = () => {
      if (typeof this.afterCommit === 'function') this.afterCommit(callback, key)
      else callback()
    }
    if (this.runtime) this.runtime.afterCommit(notify, key)
    else notify()
  }

  get riaSessionId() { return this.data.riaSessionId }
  get riaPreset() { return this.data.riaPreset }
  get lastHumanMessageAt() { return this.data.lastHumanMessageAt || 0 }

  /**
   * Remember when a real user last spoke, whichever channel carried it.
   * Channels race with their own resume callbacks, so this is monotonic: an
   * older observation never moves the anchor backwards.
   */
  noteHumanMessage(at = Date.now()) {
    const value = Number.isFinite(at) && at > 0 ? at : Date.now()
    if (value <= (this.data.lastHumanMessageAt || 0)) return this.data.lastHumanMessageAt || 0
    this.data.lastHumanMessageAt = value
    this.save()
    return value
  }

  settings() {
    return {
      progressCards: this.data.settings.progressCards,
      wechatAutoPause: this.data.settings.wechatAutoPause,
      approvalAutomation: this.data.settings.approvalAutomation,
      approvalAutoAllow: normalizeApprovalAutoAllow(this.data.settings.approvalAutoAllow),
      blockDirectUserMessages: this.data.settings.blockDirectUserMessages !== false,
      escalationPolicy: normalizeEscalationPolicy(this.data.settings.escalationPolicy) || DEFAULT_ESCALATION_POLICY,
      wechatClawImage: { ...WECHAT_CLAW_IMAGE_FIXED },
      reflection: normalizeReflectionSettings(this.data.settings.reflection),
      style: normalizeStyleSettings(this.data.settings.style),
      memory: normalizeMemorySettings(this.data.settings.memory),
    }
  }

  reflectionSettings() {
    return this.settings().reflection
  }

  styleSettings() {
    return this.settings().style
  }

  memorySettings() {
    return this.settings().memory
  }

  setSettings(patch = {}) {
    if (typeof patch.wechatAutoPause === 'boolean') this.data.settings.wechatAutoPause = patch.wechatAutoPause
    if (typeof patch.approvalAutomation === 'boolean') this.data.settings.approvalAutomation = patch.approvalAutomation
    if (patch.approvalAutoAllow && typeof patch.approvalAutoAllow === 'object' && !Array.isArray(patch.approvalAutoAllow)) {
      this.data.settings.approvalAutoAllow = normalizeApprovalAutoAllow({
        ...this.data.settings.approvalAutoAllow,
        ...patch.approvalAutoAllow,
      })
    }
    if (typeof patch.blockDirectUserMessages === 'boolean') this.data.settings.blockDirectUserMessages = patch.blockDirectUserMessages
    const escalationPolicy = normalizeEscalationPolicy(patch.escalationPolicy)
    if (escalationPolicy) this.data.settings.escalationPolicy = escalationPolicy
    // wechatClawImage is fixed on; the field is persisted for compatibility only.
    this.data.settings.wechatClawImage = { ...WECHAT_CLAW_IMAGE_FIXED }
    if (patch.reflection && typeof patch.reflection === 'object' && !Array.isArray(patch.reflection)) {
      this.data.settings.reflection = normalizeReflectionSettings({
        ...this.data.settings.reflection,
        ...patch.reflection,
      })
    }
    if (patch.style && typeof patch.style === 'object' && !Array.isArray(patch.style)) {
      this.data.settings.style = normalizeStyleSettings({
        ...this.data.settings.style,
        ...patch.style,
      })
    }
    if (patch.memory && typeof patch.memory === 'object' && !Array.isArray(patch.memory)) {
      this.data.settings.memory = normalizeMemorySettings({
        ...this.data.settings.memory,
        ...patch.memory,
      })
    }
    this.save()
    return this.settings()
  }

  topics() {
    return this.data.topics.map(topic => ({ ...topic }))
  }

  links() {
    return this.data.links.map(link => ({ ...link }))
  }

  topic(topicId) {
    const id = String(topicId || '')
    return this.data.topics.find(topic => topic.topicId === id)
  }

  topicLinks(topicId) {
    return this.data.links.filter(link => link.topicId === String(topicId || ''))
  }

  ticketLinks(ticketId) {
    return linksForTicket(this.data.links, String(ticketId || ''))
  }

  primaryTopicFor(ticketId) {
    const link = primaryTopicForTicket(this.data.links, String(ticketId || ''))
    return link ? link.topicId : null
  }

  knownTicket(ticketId) {
    const id = String(ticketId || '')
    if (!id) return undefined
    return this.ticket(id) || this.findArchivedTicket(id)
  }

  addTopic(input = {}) {
    const at = now()
    const title = [...asString(input.title)].slice(0, TOPIC_TITLE_LIMIT).join('')
    if (!title) throw transitionError('topic_invalid', 'topic title must not be empty')
    const requestedId = asString(input.topicId)
    if (requestedId && this.topic(requestedId)) throw transitionError('topic_exists', 'topic already exists: ' + requestedId)
    const topic = normalizeTopic({
      topicId: requestedId || newTopicId(at),
      projectKey: input.projectKey,
      title,
      brief: input.brief,
      tags: input.tags,
      createdAt: at,
      updatedAt: at,
    }, at)
    this.data.topics.push(topic)
    this.save()
    return { ...topic }
  }

  updateTopic(topicId, patch = {}) {
    const topic = this.topic(topicId)
    if (!topic) throw transitionError('topic_missing', 'topic not found: ' + String(topicId))
    if (topic.archivedAt) throw transitionError('topic_archived', 'topic is archived: ' + topic.topicId)
    if (topic.mergedInto) throw transitionError('topic_merged', 'topic was merged into ' + topic.mergedInto)
    const at = now()
    if (patch.title !== undefined) {
      const title = [...asString(patch.title)].slice(0, TOPIC_TITLE_LIMIT).join('')
      if (!title) throw transitionError('topic_invalid', 'topic title must not be empty')
      topic.title = title
    }
    if (patch.brief !== undefined) {
      topic.brief = [...(typeof patch.brief === 'string' ? patch.brief.trim() : '')].slice(0, TOPIC_BRIEF_LIMIT).join('')
    }
    if (patch.projectKey !== undefined) {
      topic.projectKey = normalizeProjectKey(patch.projectKey)
    }
    if (patch.tags !== undefined) topic.tags = normalizeTopicTags(patch.tags)
    topic.updatedAt = at
    this.save()
    return { ...topic }
  }

  linkTicket(topicId, ticketId, role = 'primary') {
    const topic = this.topic(topicId)
    if (!topic) throw transitionError('topic_missing', 'topic not found: ' + String(topicId))
    if (topic.archivedAt) throw transitionError('topic_archived', 'topic is archived: ' + topic.topicId)
    if (topic.mergedInto) throw transitionError('topic_merged', 'topic was merged into ' + topic.mergedInto)
    const ticket = this.knownTicket(ticketId)
    if (!ticket) throw transitionError('ticket_missing', 'ticket not found: ' + String(ticketId))
    const at = now()
    const result = linkTopicIn(this.data.links, topic.topicId, ticket.ticketId, role, at)
    this.data.links = result.links
    topic.updatedAt = Math.max(topic.updatedAt, at)
    this.save()
    return { topic: { ...topic }, ticketId: ticket.ticketId, role: role === 'primary' ? 'primary' : 'related', demotedTopicId: result.demoted || null }
  }

  unlinkTicket(topicId, ticketId) {
    const topic = this.topic(topicId)
    if (!topic) throw transitionError('topic_missing', 'topic not found: ' + String(topicId))
    if (topic.archivedAt) throw transitionError('topic_archived', 'topic is archived: ' + topic.topicId)
    const id = String(ticketId || '')
    const before = this.data.links.length
    this.data.links = unlinkTopicIn(this.data.links, topic.topicId, id)
    if (this.data.links.length === before) return { removed: false }
    topic.updatedAt = now()
    this.save()
    return { removed: true }
  }

  mergeTopic(sourceTopicId, targetTopicId) {
    const source = this.topic(sourceTopicId)
    const target = this.topic(targetTopicId)
    if (!source) throw transitionError('topic_missing', 'topic not found: ' + String(sourceTopicId))
    if (!target) throw transitionError('topic_missing', 'topic not found: ' + String(targetTopicId))
    if (source.topicId === target.topicId) throw transitionError('topic_invalid', 'a topic cannot merge into itself')
    if (source.archivedAt || source.mergedInto) throw transitionError('topic_archived', 'source topic is already closed: ' + source.topicId)
    if (target.archivedAt || target.mergedInto) throw transitionError('topic_archived', 'target topic is closed: ' + target.topicId)
    const at = now()
    const result = mergeTopicLinks(this.data.links, source.topicId, target.topicId, at)
    this.data.links = result.links
    source.mergedInto = target.topicId
    source.archivedAt = at
    source.updatedAt = at
    target.updatedAt = at
    this.save()
    return { sourceTopicId: source.topicId, targetTopicId: target.topicId, moved: result.moved }
  }

  archiveTopic(topicId) {
    const topic = this.topic(topicId)
    if (!topic) throw transitionError('topic_missing', 'topic not found: ' + String(topicId))
    if (topic.archivedAt || topic.mergedInto) throw transitionError('topic_archived', 'topic is already archived: ' + topic.topicId)
    const unfinished = this.topicLinks(topic.topicId)
      .map(link => this.knownTicket(link.ticketId))
      .filter(ticket => ticket && !isTerminal(ticket.status))
    if (unfinished.length) {
      throw transitionError('topic_unfinished', 'topic still has ' + unfinished.length + ' unfinished ticket(s): ' + unfinished.slice(0, 5).map(ticket => ticket.ticketId).join(', '))
    }
    const at = now()
    topic.archivedAt = at
    topic.updatedAt = at
    this.save()
    return { ...topic }
  }


  setRia(sessionId, preset) {
    this.data.riaSessionId = sessionId
    this.data.riaPreset = preset
    this.data.createdAt = this.data.createdAt || now()
    this.save()
  }

  clearRia() {
    if (this.data.riaSessionId === undefined && this.data.riaPreset === undefined) return
    this.data.riaSessionId = undefined
    this.data.riaPreset = undefined
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
    const noteId = asString(input.noteId) || newId('note_')
    if (!Array.isArray(this.data.dispatchNotes)) this.data.dispatchNotes = []
    // The outbox retries after a crash. Re-recording the same noteId must not
    // duplicate the card in the transcript.
    const existing = this.data.dispatchNotes.find(item => item && item.noteId === noteId)
    if (existing) return existing
    const record = {
      noteId,
      sessionId,
      turn,
      note,
      kind: input.kind === 'approval' ? 'approval' : 'dispatch',
      isTicket: Boolean(input.isTicket),
      at: now(),
    }
    if (typeof input.ticketId === 'string' && input.ticketId) record.ticketId = input.ticketId
    this.data.dispatchNotes.push(record)
    if (this.data.dispatchNotes.length > DISPATCH_NOTE_HISTORY) {
      this.data.dispatchNotes.splice(0, this.data.dispatchNotes.length - DISPATCH_NOTE_HISTORY)
    }
    this.save()
    return record
  }

  dispatchNotes(sessionId) {
    const id = String(sessionId)
    const notes = Array.isArray(this.data.dispatchNotes) ? this.data.dispatchNotes : []
    return notes
      .filter(item => item.sessionId === id && Number.isSafeInteger(item.turn))
      .map(item => {
        const result = {
          noteId: item.noteId,
          sessionId: item.sessionId,
          turn: item.turn,
          note: item.note,
          kind: item.kind === 'approval' ? 'approval' : 'dispatch',
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
   * Resolve a dependency target from the hot store first, then the archived
   * log. Archived tickets are terminal, so they can satisfy a dependency but
   * never wait on one.
   */
  dependencyTarget(ticketId) {
    const id = String(ticketId || '')
    if (!id) return undefined
    const hot = this.ticket(id)
    if (hot) return hot
    const archived = this.findArchivedTicket(id)
    return archived ? { ...archived, archived: true } : undefined
  }

  dependencyAssessment(ticket) {
    return assessDependencies(ticket, id => this.dependencyTarget(id))
  }

  validateDependencies(ticketId, raw) {
    return validateDependencyInput(ticketId, raw, id => this.dependencyTarget(id))
  }

  queueTokenFor(ticket) {
    if (!ticket || !Array.isArray(ticket.dependsOn) || ticket.dependsOn.length === 0) return null
    if (ticket.status !== 'open' || ticket.waitingOn !== 'ria' || !Number.isFinite(ticket.readyAt)) return null
    return ticket.ticketId + ':' + ticket.readyAt + ':' + ticket.revision
  }


  markReadyNotified(ticketId, readyAt) {
    const ticket = this.ticket(String(ticketId))
    if (!ticket) return undefined
    if (!Number.isFinite(readyAt) || ticket.readyAt !== readyAt) return ticket
    ticket.readyNotifiedAt = now()
    this.save()
    return ticket
  }

  queueInfo(ticket) {
    const assessment = this.dependencyAssessment(ticket)
    const blockedBy = assessment.items
      .filter(item => item.status !== 'done')
      .map(item => ({
        ticketId: item.ticketId,
        goal: item.goal,
        status: item.status,
        executor: item.executor,
        archived: Boolean(item.archived),
      }))
    let queueState
    if (ticket.status === 'working') queueState = 'dispatched'
    else if (ticket.status === 'blocked') queueState = 'blocked'
    else if (ticket.status !== 'open') queueState = 'none'
    else if (assessment.alerts.length > 0) queueState = 'dependency_alert'
    else if (ticket.waitingOn === 'dependency') queueState = 'waiting_dependency'
    else queueState = 'ready'
    let queueText
    if (queueState === 'waiting_dependency') {
      const unanswered = blockedBy.map(item => item.goal || item.ticketId).join('、')
      queueText = '排队中：等 ' + (unanswered || '上游工单')
    } else if (queueState === 'ready') {
      queueText = ticket.dependsOn.length ? '已就绪：依赖都已完成' : '已就绪：可以派发'
    } else if (queueState === 'dependency_alert') {
      const failed = assessment.alerts.map(alert => alert.ticketId + '（' + alert.status + '）').join('、')
      queueText = '依赖失败，等待处理：' + failed
    } else if (queueState === 'dispatched') {
      queueText = '已派发，等待 worker 完成'
    } else if (queueState === 'blocked') {
      queueText = '已阻塞：' + (ticket.blockedReason || '需要用户处理')
    } else {
      queueText = ''
    }
    return {
      queueState,
      queueText,
      queueToken: this.queueTokenFor(ticket),
      blockedBy,
      readyAt: Number.isFinite(ticket.readyAt) ? ticket.readyAt : null,
      readyNotifiedAt: Number.isFinite(ticket.readyNotifiedAt) ? ticket.readyNotifiedAt : null,
      dependencyAlerts: assessment.alerts.map(alert => ({ ...alert })),
    }
  }

  emitQueueEvent(event) {
    if (typeof this.onQueueEvent !== 'function') return
    this.postCommit(() => {
      try { this.onQueueEvent(event) } catch { /* queue signalling must never break a committed write */ }
    })
  }

  /**
   * Recompute one ticket's dependency gate (T29/T30/T32/T33/T34) and emit the
   * queue signal when it crosses a boundary. Ready is only reported once per
   * readyAt; forceWake is used by the boot reconciler with a boot-scoped
   * dedupe key.
   */
  syncTicketDependencies(ticketId, options = {}) {
    const ticket = this.ticket(String(ticketId))
    if (!ticket) return undefined
    const at = Number.isFinite(options.at) ? options.at : now()
    const beforeReadyAt = ticket.readyAt
    const beforeAlerts = (ticket.dependencyAlerts || []).map(alert => alert.ticketId + ':' + alert.status).join(',')
    const assessment = this.dependencyAssessment(ticket)
    const snapshot = JSON.parse(JSON.stringify(ticket))
    const changed = applyDependencyState(ticket, assessment, at)
    if (changed) {
      ticket.revision += 1
      ticket.updatedAt = at
      try {
        assertTicketInvariants(ticket, this.data.tickets, at)
      } catch {
        // Leave the ticket untouched rather than persisting an invalid gate.
        Object.assign(ticket, snapshot)
        return { ticket, changed: false, assessment }
      }
      this.save()
    }
    const afterAlerts = (ticket.dependencyAlerts || []).map(alert => alert.ticketId + ':' + alert.status).join(',')
    if (ticket.status !== 'open' || !ticket.dependsOn.length) {
      if (beforeReadyAt !== null) this.emitQueueEvent({ kind: 'invalidate', ticketId: ticket.ticketId, readyAt: beforeReadyAt, at })
      if (beforeAlerts) this.emitQueueEvent({ kind: 'invalidate', ticketId: ticket.ticketId, at })
      return { ticket, changed, assessment }
    }
    if (ticket.waitingOn === 'dependency') {
      if (beforeReadyAt !== null) this.emitQueueEvent({ kind: 'invalidate', ticketId: ticket.ticketId, readyAt: beforeReadyAt, at })
      if (afterAlerts && afterAlerts !== beforeAlerts) {
        this.emitQueueEvent({
          kind: 'blocked',
          ticketId: ticket.ticketId,
          readyAt: ticket.readyAt,
          revision: ticket.revision,
          at,
          alerts: ticket.dependencyAlerts.map(alert => ({ ...alert })),
        })
      }
    } else if (ticket.waitingOn === 'ria' && assessment.ready) {
      // A ready ticket that was never notified has to be announced again even
      // though readyAt was written earlier; the outbox dedupe key keeps that
      // retry idempotent.
      if (beforeReadyAt === null || options.forceWake === true || ticket.readyNotifiedAt === null) {
        this.emitQueueEvent({
          kind: 'ready',
          ticketId: ticket.ticketId,
          readyAt: ticket.readyAt,
          revision: ticket.revision,
          at,
          bootId: options.bootId,
          queueToken: this.queueTokenFor(ticket),
          dependsOn: [...ticket.dependsOn],
        })
      }
    }
    if (changed) this.syncDependents(ticket.ticketId, { at })
    return { ticket, changed, assessment }
  }

  /** Re-evaluate every hot ticket that directly depends on the changed one. */
  syncDependents(sourceTicketId, options = {}) {
    const id = String(sourceTicketId || '')
    if (!id) return []
    const affected = this.data.tickets.filter(ticket => ticket.status === 'open' && ticket.dependsOn.includes(id))
    const results = []
    for (const ticket of affected) {
      const result = this.syncTicketDependencies(ticket.ticketId, { at: options.at, bootId: options.bootId })
      if (result) results.push(result)
    }
    return results
  }

  /**
   * Boot-time dependency reconciliation. Missing or structurally invalid edges
   * park the ticket for the user; valid edges cross T29/T30/T33; every ready
   * ticket gets one boot-scoped wake so a wake lost to a crash is re-delivered.
   */
  reconcileDependencies(options = {}) {
    const at = Number.isFinite(options.at) ? options.at : now()
    const bootId = options.bootId ? String(options.bootId) : ('boot_' + at.toString(36))
    const invalid = []
    for (const ticket of [...this.data.tickets]) {
      if (!Array.isArray(ticket.dependsOn) || ticket.dependsOn.length === 0) continue
      if (isTerminal(ticket.status)) continue
      try {
        this.validateDependencies(ticket.ticketId, ticket.dependsOn)
      } catch (error) {
        if (ticket.status === 'open') {
          const moved = this.transitionTicket(ticket.ticketId, 'blocked', {
            actor: 'system',
            waitingOn: 'user',
            blockedReason: '依赖数据无效：' + (error.message || error.code),
            reason: 'dependency reconcile',
          })
          if (moved.ok) {
            invalid.push({ ticketId: ticket.ticketId, code: error.code || 'dependency_invalid', message: error.message })
            continue
          }
        }
        invalid.push({ ticketId: ticket.ticketId, code: error.code || 'dependency_invalid', message: error.message })
      }
    }
    const ready = []
    const waiting = []
    const alerts = []
    for (const ticket of this.data.tickets) {
      if (!Array.isArray(ticket.dependsOn) || ticket.dependsOn.length === 0) continue
      if (ticket.status !== 'open') continue
      const result = this.syncTicketDependencies(ticket.ticketId, { at, bootId, forceWake: true })
      if (!result) continue
      if (ticket.waitingOn === 'dependency') {
        if (ticket.dependencyAlerts.length) alerts.push(ticket.ticketId)
        else waiting.push(ticket.ticketId)
      } else if (ticket.waitingOn === 'ria') {
        ready.push(ticket.ticketId)
      }
    }
    return { at, bootId, invalid, ready, waiting, alerts }
  }

  queueOverview() {
    const items = this.data.tickets
      .filter(ticket => !isTerminal(ticket.status) && ticket.dependsOn.length > 0)
      .map(ticket => ({ ...ticketSummary(ticket), ...this.queueInfo(ticket) }))
      .sort((a, b) => {
        const rank = { ready: 0, dependency_alert: 1, waiting_dependency: 2, dispatched: 3, blocked: 4 }
        const delta = (rank[a.queueState] ?? 5) - (rank[b.queueState] ?? 5)
        if (delta) return delta
        return (b.readyAt || b.updatedAt || 0) - (a.readyAt || a.updatedAt || 0)
      })
    return {
      waiting: items.filter(item => item.queueState === 'waiting_dependency').length,
      ready: items.filter(item => item.queueState === 'ready').length,
      alerts: items.filter(item => item.queueState === 'dependency_alert').length,
      items,
    }
  }

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
    const restore = (code, message, extra) => {
      this.data = snapshot
      try { this.save() } catch { /* keep the in-memory state authoritative */ }
      return { ok: false, code, message, ...(extra || {}) }
    }
    const source = this.ticket(ticketId)
    if (!source) return { ok: false, code: 'ticket_missing', message: 'ticket not found: ' + ticketId }
    if (source.status !== 'intake') {
      return { ok: false, code: 'intake_already_resolved', message: 'ticket ' + ticketId + ' is already ' + source.status }
    }
    const kind = asString(disposition.kind)
    const at = now()
    const text = source.origin && source.origin.text ? source.origin.text : source.goal
    const waiver = asString(disposition.waiver)
    const fallbackSummary = '已回复：' + clipText(text, 80)
    const finish = (to, options) => {
      const moved = this.transitionTicket(ticketId, to, { actor: 'ria', ...options, executor: options && options.executor !== undefined ? options.executor : (source.executor || 'self') })
      if (!moved.ok) return restore(moved.code, moved.message, moved.checklistPending ? { checklistPending: moved.checklistPending } : undefined)
      return { ok: true, ticket: moved.ticket }
    }

    if (kind === 'answered') {
      const summary = asString(disposition.summary) || fallbackSummary
      return finish('done', { resolution: { kind: 'answered', summary, ...(waiver ? { waiver } : {}) } })
    }

    if (kind === 'work') {
      const goal = asString(disposition.goal) || source.goal
      const acceptance = disposition.acceptance !== undefined ? String(disposition.acceptance) : source.acceptance
      const executor = asString(disposition.executor) || 'self'
      let dependsOn
      try {
        dependsOn = disposition.dependsOn !== undefined ? this.validateDependencies(ticketId, disposition.dependsOn) : undefined
      } catch (error) {
        return restore(error.code || 'dependency_invalid', error.message)
      }
      if (executor === 'self' && disposition.start === true && !(dependsOn && dependsOn.length)) {
        return finish('working', {
          goal,
          acceptance,
          executor: 'self',
          waitingOn: 'ria',
          attempt: { count: 1, lastRequestId: null, startedAt: at, legacy: true },
        })
      }
      return finish('open', { goal, acceptance, executor, dependsOn, waitingOn: 'ria' })
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
        resolution: { kind: 'merged', summary: '已并入 ' + targetId, mergedInto: targetId, ...(waiver ? { waiver } : {}) },
      })
      if (!merged.ok) return restore(merged.code, merged.message, merged.checklistPending ? { checklistPending: merged.checklistPending } : undefined)
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
          const moved = this.transitionTicket(targetId, 'cancelled', {
            actor: 'user',
            resolution: { kind: 'control', reason, ...(waiver ? { waiver } : {}) },
          })
          if (!moved.ok) return restore(moved.code, moved.message, moved.checklistPending ? { checklistPending: moved.checklistPending } : undefined)
        }
      } else if (isTerminal(target.status) || target.status === 'blocked') {
        const moved = this.transitionTicket(targetId, 'open', { actor: 'user', reason: 'user asked to ' + action })
        if (!moved.ok) return restore(moved.code, moved.message)
      }
      const summary = '控制指令 ' + action + ' 已作用于 ' + targetId
      return finish('done', { resolution: { kind: 'control', action, targetTicketId: targetId, summary } })
    }

    if (kind === 'blocked') {
      const waitingOn = asString(disposition.waitingOn) || 'user'
      if (!['user', 'approval', 'environment'].includes(waitingOn)) {
        return { ok: false, code: 'invalid_waiting_on', message: 'blocked waitingOn must be user, approval, or environment' }
      }
      const attention = waitingOn === 'user' ? disposition.attention : undefined
      const question = attention && typeof attention === 'object' && !Array.isArray(attention) && typeof attention.question === 'string' ? attention.question.trim() : ''
      const blockedReason = asString(disposition.blockedReason) || asString(disposition.reason) || question
      if (!blockedReason) return { ok: false, code: 'blocked_reason_required', message: 'blocked needs blockedReason' }
      return finish('blocked', { blockedReason, waitingOn, attention })
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
    if (sourceId === targetId) return { ok: false, code: 'merge_self', message: '不能把工单合并到自己' }
    if (!source) return { ok: false, code: 'ticket_missing', message: 'source ticket not found: ' + sourceId }
    if (!target) return { ok: false, code: 'ticket_missing', message: 'target ticket not found: ' + targetId }
    if (source.resolution && source.resolution.kind === 'merged') {
      return { ok: false, code: 'merge_irreversible', message: '工单 ' + sourceId + ' 已经被合并，不能再合并' }
    }
    if (isTerminal(source.status)) return { ok: false, code: 'source_closed', message: '源工单 ' + sourceId + ' 已收敛（' + source.status + '）' }
    if (isTerminal(target.status)) return { ok: false, code: 'target_closed', message: '目标工单 ' + targetId + ' 已收敛（' + target.status + '）' }
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
      return { ok: false, code: 'merge_cycle', message: '源工单与目标工单在同一父子链上，合并会形成环' }
    }
    if (source.parentTicketId && target.parentTicketId && source.rootTicketId !== target.rootTicketId) {
      return { ok: false, code: 'merge_root_mismatch', message: '两个工单属于不同任务树，不能直接合并' }
    }
    const children = source.childTicketIds.map(id => this.ticket(id)).filter(Boolean)
    const activeChildren = children.filter(child => !isTerminal(child.status))
    if (activeChildren.length > 0 && target.executor) {
      return { ok: false, code: 'target_busy', message: '源工单还有未收敛的子工单，目标工单有 executor；请先把目标工单变成容器' }
    }
    const combined = new Set([...target.childTicketIds, ...source.childTicketIds])
    if (combined.size > MAX_CHILDREN) {
      return { ok: false, code: 'target_busy', message: '目标工单的子工单会超过 ' + MAX_CHILDREN + ' 个' }
    }
    const snapshot = JSON.parse(JSON.stringify(this.data))
    const restore = (code, message, extra) => {
      this.data = snapshot
      try { this.save() } catch { /* keep the in-memory state authoritative */ }
      return { ok: false, code, message, ...(extra || {}) }
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
    // Checklist items describe the source's own steps, not the target's. The
    // target keeps its checklist untouched; merging never appends source items.
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

    // Dependency edges move before the source converges (P0-8). Downstream
    // tickets that waited on the source now wait on the target; the source's own
    // upstream edges only gate a target that has not started yet. A merged done
    // ticket never satisfies a dependency by itself, because these edges no
    // longer point at it.
    const targetStarted = Boolean(target.attempt && target.attempt.lastRequestId)
    const movedEdges = []
    if (!targetStarted && source.dependsOn.length > 0) {
      const mergedDeps = [...new Set([...target.dependsOn, ...source.dependsOn])].filter(id => id !== targetId)
      if (mergedDeps.length !== target.dependsOn.length || mergedDeps.some((id, index) => id !== target.dependsOn[index])) {
        target.dependsOn = mergedDeps
        target.revision += 1
        target.updatedAt = at
        movedEdges.push(targetId)
      }
    }
    for (const dependent of this.data.tickets) {
      if (dependent.ticketId === sourceId || !dependent.dependsOn.includes(sourceId)) continue
      const nextDeps = [...new Set(dependent.dependsOn.map(id => id === sourceId ? targetId : id))].filter(id => id !== dependent.ticketId)
      dependent.dependsOn = nextDeps
      dependent.revision += 1
      dependent.updatedAt = at
      movedEdges.push(dependent.ticketId)
    }
    for (const ticketId of movedEdges) {
      const ticket = this.ticket(ticketId)
      if (ticket && ticket.status === 'open') applyDependencyState(ticket, this.dependencyAssessment(ticket), at)
      try {
        assertTicketInvariants(ticket, this.data.tickets, at)
      } catch (error) {
        return restore(error.code || 'dependency_invalid', error.message)
      }
    }

    const targetBody = clipText('用户把「' + source.goal + '」并入本任务：' + (options.reason || ''), 500)
    const sourceBody = clipText('已并入 ' + targetId + '，后续进展以目标工单为准', 500)
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
        ...(asString(options.waiver) ? { waiver: asString(options.waiver) } : {}),
      },
    })
    if (!merged.ok) {
      return restore(merged.code, merged.message, merged.checklistPending ? { checklistPending: merged.checklistPending } : undefined)
    }
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
      movedDependencies: movedEdges,
    }
  }

  // The design document calls this mergeTask; keep the old name working while
  // the public tool surface is renamed.
  mergeTask(sourceId, targetId, options = {}) {
    return this.mergeTicket(sourceId, targetId, options)
  }

  /**
   * Cancel one ticket and everything downstream of it (T35). Waiting tickets
   * are cancelled with resolution.kind='cascade_cancel'; a working downstream
   * ticket is deferred because its worker already owns the work. Terminal
   * tickets are skipped.
   */
  cascadeCancel(ticketId, options = {}) {
    const root = this.ticket(String(ticketId))
    if (!root) return { ok: false, code: 'ticket_missing', message: 'ticket not found: ' + ticketId }
    if (isTerminal(root.status)) return { ok: false, code: 'ticket_closed', message: 'ticket ' + ticketId + ' is already ' + root.status }
    const reason = asString(options.reason) || '上游工单被取消'
    const waiver = asString(options.waiver)
    const cancelled = []
    const deferred = []
    const seen = new Set()
    const rootMoved = this.transitionTicket(String(ticketId), 'cancelled', {
      actor: options.actor || 'user',
      reason,
      resolution: { kind: 'cancelled', reason, ...(waiver ? { waiver } : {}) },
    })
    if (!rootMoved.ok) {
      return {
        ok: false,
        code: rootMoved.code,
        message: rootMoved.message,
        ...(rootMoved.checklistPending ? { checklistPending: rootMoved.checklistPending } : {}),
      }
    }
    cancelled.push(String(ticketId))
    seen.add(String(ticketId))
    const visit = (id, upstreamId) => {
      if (seen.has(id)) return
      seen.add(id)
      const ticket = this.ticket(id)
      if (!ticket) return
      if (['open', 'blocked', 'intake'].includes(ticket.status)) {
        const moved = this.transitionTicket(id, 'cancelled', {
          actor: options.actor || 'user',
          reason: 'cascade from ' + upstreamId,
          resolution: { kind: 'cascade_cancel', upstreamTicketId: upstreamId, summary: '上游 ' + upstreamId + ' 已取消', ...(waiver ? { waiver } : {}) },
        })
        if (moved.ok) cancelled.push(id)
      } else if (!isTerminal(ticket.status)) {
        deferred.push({ ticketId: id, status: ticket.status, executor: ticket.executor || null })
      }
      const downstream = this.data.tickets
        .filter(item => item.ticketId !== id)
        .filter(item => item.dependsOn.includes(id) || item.childTicketIds.includes(id))
      for (const item of downstream) visit(item.ticketId, id)
    }
    const roots = this.data.tickets
      .filter(item => item.ticketId !== String(ticketId))
      .filter(item => item.dependsOn.includes(String(ticketId)) || item.childTicketIds.includes(String(ticketId)))
    for (const item of roots) visit(item.ticketId, String(ticketId))
    this.save()
    return { ok: true, cancelled, deferred, reason }
  }

  addTicket(input) {
    const at = now()
    const status = input.status || 'open'
    if (!TICKET_STATUSES.includes(status)) throw transitionError('invalid_status', 'invalid ticket status: ' + status)
    // Resolve the primary topic before any other write. A missing, archived or
    // merged topic rejects the whole create, so a ticket can never be written
    // first and left unlinked.
    const topicId = asString(input.topicId)
    let topic = null
    if (topicId) {
      topic = this.topic(topicId)
      if (!topic) throw transitionError('topic_missing', 'topic not found: ' + topicId)
      if (topic.archivedAt || topic.mergedInto) throw transitionError('topic_archived', 'topic is archived or merged: ' + topicId)
    }
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
      checklist: input.checklist,
      fork: input.fork,
      blockedReason: input.blockedReason || '',
      attention: input.attention,
      resolution: input.resolution,
      failure: input.failure,
      createdAt: at,
      updatedAt: at,
      closedAt: isTerminal(status) ? at : null,
    }, at)
    if (!ticket) throw transitionError('invalid_ticket', 'could not create a ticket')
    const close = checklistCloseCheck(ticket, ticket.status, ticket.resolution)
    if (!close.ok) throw transitionError(close.code, close.message, { checklistPending: close.checklistPending })
    if (close.waiver) {
      ticket.resolution = {
        ...(ticket.resolution || {}),
        waiver: close.waiver,
        checklistPending: close.checklistPending,
        waivedAt: at,
        waivedBy: 'ria',
      }
    }
    if (input.dependsOn !== undefined) ticket.dependsOn = this.validateDependencies(ticket.ticketId, input.dependsOn)
    if (ticket.status === 'open') applyDependencyState(ticket, this.dependencyAssessment(ticket), at)
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
    if (topic) {
      const linked = linkTopicIn(this.data.links, topic.topicId, ticket.ticketId, 'primary', at)
      this.data.links = linked.links
      topic.updatedAt = at
    }
    this.save()
    if (ticket.status === 'open' && ticket.dependsOn.length) {
      this.syncTicketDependencies(ticket.ticketId, { at, forceWake: true })
    }
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
    if (patch.attention !== undefined) next.attention = normalizeAttention(patch.attention)
    // A blocked ticket keeps its status while the reason for stopping changes
    // (a denied approval is not a status transition). failed still requires it.
    if (patch.failure !== undefined) {
      if (patch.failure === null) next.failure = null
      else if (patch.failure && typeof patch.failure === 'object' && !Array.isArray(patch.failure)) next.failure = JSON.parse(JSON.stringify(patch.failure))
      else throw transitionError('invalid_failure', 'failure must be an object or null')
    }
    if (patch.progress !== undefined) next.progress = { ...next.progress, ...patch.progress }
    if (patch.recovery !== undefined) next.recovery = { ...next.recovery, ...patch.recovery }
    if (patch.dependsOn !== undefined) next.dependsOn = this.validateDependencies(ticketId, patch.dependsOn)
    if (patch.checklist !== undefined) next.checklist = normalizeChecklist(patch.checklist)
    const at = now()
    if (next.status === 'open') applyDependencyState(next, this.dependencyAssessment(next), at)
    next.revision += 1
    next.updatedAt = at
    assertTicketInvariants(next, this.data.tickets, at)
    Object.assign(ticket, next)
    this.save()
    if (patch.dependsOn !== undefined) {
      this.syncTicketDependencies(ticketId, { at, forceWake: true })
      this.syncDependents(ticketId, { at })
    }
    return ticket
  }

  /**
   * Record that the worker opened a turn for a dispatch. This is deliberately
   * narrower than updateTicket: only the matching working attempt can be
   * confirmed, so a late event cannot touch a newer dispatch.
   */
  confirmDispatchAttempt(ticketId, requestId, at = now()) {
    const ticket = this.ticket(ticketId)
    if (!ticket || ticket.status !== 'working' || !ticket.attempt) return false
    if (String(ticket.attempt.lastRequestId || '') !== String(requestId || '')) return false
    if (ticket.attempt.confirmedAt) return true
    ticket.attempt = { ...ticket.attempt, confirmedAt: at }
    ticket.revision += 1
    ticket.updatedAt = at
    this.save()
    return true
  }

  emitRouterEvent(event) {
    this.postCommit(() => {
      try { if (typeof this.onRouterEvent === 'function') this.onRouterEvent(event) } catch { /* observability is best effort */ }
    })
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
    // Callers that already recorded the same logical instant (e.g. failure.at
    // written from a turn event) pass it in so a transition and its failure
    // share one timestamp instead of racing the clock by a millisecond.
    const at = Number.isFinite(options.at) ? options.at : now()
    const next = JSON.parse(JSON.stringify(ticket))
    const from = next.status
    const previousReadyAt = next.readyAt
    next.status = to
    next.waitingOn = options.waitingOn || WAITING_ON_BY_STATUS[to]
    if (options.dependsOn !== undefined) next.dependsOn = this.validateDependencies(ticketId, options.dependsOn)
    if (options.executor !== undefined) next.executor = options.executor
    if (options.goal !== undefined) next.goal = String(options.goal)
    if (options.acceptance !== undefined) next.acceptance = String(options.acceptance)
    if (options.blockedReason !== undefined) next.blockedReason = String(options.blockedReason)
    if (options.attention !== undefined) next.attention = normalizeAttention(options.attention, at)
    if (options.checklist !== undefined) next.checklist = normalizeChecklist(options.checklist)
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
    if (next.status !== 'blocked' || !['user', 'approval'].includes(next.waitingOn)) next.attention = null
    if (isTerminal(from) && to === 'open') {
      next.closedAt = null
      next.failure = null
      next.resolution = null
      next.reopenCount += 1
      next.readyAt = null
      next.readyNotifiedAt = null
    }
    if (to !== 'open') {
      next.readyAt = null
      next.readyNotifiedAt = null
      next.dependencyAlerts = []
    } else {
      applyDependencyState(next, this.dependencyAssessment(next), at)
    }
    const close = checklistCloseCheck(next, to, next.resolution)
    if (!close.ok) {
      return { ok: false, code: close.code, message: close.message, checklistPending: close.checklistPending, ticket }
    }
    if (close.waiver) {
      const base = next.resolution && typeof next.resolution === 'object' && !Array.isArray(next.resolution) ? next.resolution : {}
      next.resolution = {
        ...base,
        waiver: close.waiver,
        checklistPending: close.checklistPending,
        waivedAt: at,
        waivedBy: options.actor || 'ria',
      }
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
    // ticket.state is emitted from this single write entry, after the commit,
    // so every transition (resume, block, done, archive-related) is covered.
    this.emitRouterEvent({
      event: 'ticket.state',
      ticketId,
      sessionId: String(ticket.executor || '').startsWith('session-') ? ticket.executor : null,
      actor: options.actor || 'ria',
      reason: options.reason || '',
      payload: { from, to, waitingOn: ticket.waitingOn },
    })
    // Managed Worker ownership follows every committed transition, including
    // cancellation/merge paths that do not go through worker_report.
    this.postCommit(() => {
      try { if (typeof this.onTicketTransition === 'function') this.onTicketTransition(ticket, { from, to, reason: options.reason || '' }) } catch { /* lifecycle is post-commit */ }
    })
    if (to !== 'open' && ticket.dependsOn.length) {
      this.emitQueueEvent({ kind: 'invalidate', ticketId: ticket.ticketId, readyAt: previousReadyAt, at })
    }
    if (ticket.dependsOn.length) this.syncTicketDependencies(ticketId, { at, forceWake: to === 'open' })
    this.syncDependents(ticketId, { at })
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
    const parentPending = checklistPendingSummary(parent.checklist)
    const autoWaiver = parentPending.pendingCount
      ? '所有子工单已收敛，自动关闭父工单；' + parentPending.pendingCount + '/' + parentPending.total + ' 项 checklist 未完成'
      : ''
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
        resolution: {
          kind: 'control',
          reason: cancelled + '/' + total + ' 个子任务被取消，' + count('done') + ' 个完成',
          ...(autoWaiver ? { waiver: autoWaiver } : {}),
        },
      })
      return moved.ok ? moved.ticket : parent
    }
    const moved = this.transitionTicket(parentId, 'done', {
      actor: 'system',
      reason: 'all children done',
      executor: parent.executor || 'self',
      resolution: { kind: 'done', summary: '所有子任务完成（' + total + ' 个）', ...(autoWaiver ? { waiver: autoWaiver } : {}) },
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
  // Older terminal tickets move to append-only JSONL. tickets.log.jsonl is the
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
    const checklist = normalizeChecklist(ticket.checklist)
    const pendingChecklist = checklist.filter(item => !item.done).map(item => item.text)
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
      checklist: {
        total: checklist.length,
        done: checklist.length - pendingChecklist.length,
        pending: pendingChecklist.slice(0, 5),
      },
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
    if (this.runtime) {
      // storage=sqlite: archived_at marks the row, the ticket leaves memory.
      this.runtime.archive(overflow, at)
      const movedIds = new Set(overflow.map(ticket => ticket.ticketId))
      this.data.tickets = this.data.tickets.filter(ticket => !movedIds.has(ticket.ticketId))
      this.save()
      return { archived: movedIds.size }
    }
    const records = overflow.map(ticket => this.archiveRecord(ticket))
    try {
      this.appendArchiveLines(this.ticketLogFile(TICKET_LOG), records)
      const byMonth = new Map()
      for (const record of records) {
        const key = this.monthKey(record.closedAt || record.updatedAt || at)
        const list = byMonth.get(key) || []
        list.push(record)
        byMonth.set(key, list)
      }
      for (const [month, list] of byMonth) {
        this.appendArchiveLines(this.ticketLogFile(TICKET_LOG_PREFIX + month + '.jsonl'), list)
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
    const months = [...new Set(files
      .filter(name => TICKET_LOG_PATTERN.test(name))
      .map(name => name.slice(name.indexOf('-') + 1, name.length - '.jsonl'.length)))]
      .sort()
    const stale = new Set(months.slice(0, Math.max(0, months.length - TICKET_LOG_MONTHS)))
    for (const name of files) {
      if (!TICKET_LOG_PATTERN.test(name)) continue
      const month = name.slice(name.indexOf('-') + 1, name.length - '.jsonl'.length)
      if (!stale.has(month)) continue
      try {
        unlinkSync(this.ticketLogFile(name))
      } catch {
        // Retention is best effort; a locked file is retried next time.
      }
    }
  }

  archiveFiles() {
    const monthly = (() => {
      try {
        return readdirSync(this.stateDir)
          .filter(name => TICKET_LOG_PATTERN.test(name))
          .sort()
          .reverse()
      } catch {
        return []
      }
    })()
    const ordered = [TICKET_LOG, ...monthly].filter((name, index, list) => list.indexOf(name) === index)
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
    if (this.runtime) return this.runtime.archivedRecords()
    // One ticket can be archived again after a reopen, so dedupe an archive
    // event by ticketId+closedAt instead of dropping every later closure.
    const seen = new Set()
    const records = []
    for (const file of this.archiveFiles()) {
      for (const record of this.readArchiveFile(file)) {
        const key = record.ticket.ticketId + '\u0000' + String(record.closedAt || record.ticket.closedAt || '')
        if (seen.has(key)) continue
        seen.add(key)
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
    // historyRecords is newest-first, so a reopened-and-rearchived ticket
    // resolves to its latest closure rather than an older file.
    for (const record of this.historyRecords()) {
      if (record.ticket.ticketId === id) return normalizeTicket(record.ticket)
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
    if (this.runtime) this.runtime.restore(ticketId)
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

}

/** The "storage" field of the JSON file decides the mode across restarts. */
function jsonSend(res, status, value) {
  const body = JSON.stringify(value)
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.setHeader('x-content-type-options', 'nosniff')
  res.end(body)
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

function sameOrigin(req) {
  const origin = req.headers.origin
  if (!origin) return true
  const host = req.headers.host
  if (!host) return false
  return origin === 'http://' + host || origin === 'https://' + host
}

function declaredStorage(stateDir) {
  try {
    const parsed = JSON.parse(readText(join(stateDir, 'ria.json')))
    return parsed && typeof parsed.storage === 'string' ? parsed.storage : ''
  } catch { return '' }
}

export class RiaService {
  constructor(ctx, stateDir, options = {}) {
    this.ctx = ctx
    this.stateDir = stateDir
    this.options = options
    // storage defaults to json; DSH_RIA_STORAGE (or the mirrored "storage" field)
    // switches tickets to the SQLite authority. A missing DB fails closed.
    this.storage = resolveStorageMode({ env: process.env, state: { storage: options.storage || declaredStorage(stateDir) } })
    this.runtime = this.storage === 'sqlite'
      ? new SqliteTicketRuntime({ stateDir, exportMirror: (snapshot, guard) => this.exportTicketMirror(snapshot, guard),
        log: (level, message) => this.log(level, message) })
      : null
    this.store = new RiaStore(stateDir, { runtime: this.runtime })
    this.writer = new StateWriter({
      transaction: task => this.tickets ? this.tickets.transaction(task) : task(),
      onError: error => this.log('warn', 'post-commit notification failed: ' + String(error && error.message ? error.message : error)),
    })
    this.tickets = new TicketRepository(this.store, this.writer, {
      transaction: task => this.runtime ? sqliteTransaction(this.runtime.db, task) : task(),
    })
    // Process-level event stream for the dispatch chain; ticket.state is fed by
    // RiaStore.transitionTicket through onRouterEvent below.
    this.routerEvents = new RouterEventLog({
      stateDir,
      log: (level, message) => this.log(level, 'router-events: ' + message),
    })
    this.store.onRouterEvent = event => this.routerEvents.append(event)
    this.outbox = new Outbox(join(stateDir, 'outbox.json'), {
      now: typeof options.now === 'function' ? options.now : undefined,
      log: (level, message) => this.log(level, 'outbox: ' + message),
    })
    this.store.onQueueEvent = event => this.handleQueueEvent(event)
    this.store.onTicketsCommitted = () => this.onTicketsCommitted()
    this.store.onTicketTransition = (ticket, transition) => {
      try { if (this.v2) this.v2.onTicketTransition(ticket, transition) } catch (error) {
        this.log('warn', 'worker lifecycle update failed for ' + ticket.ticketId + ': ' + String(error && error.message ? error.message : error))
      }
    }
    // Browsers cannot see the host event bus, so the board overlay subscribes
    // to a same-origin SSE stream. Every committed store write bumps the
    // revision; the client coalesces the resulting events before refetching.
    this.boardStreams = new Set()
    this.boardRevision = 0
    this.boardChangedAt = 0
    this.readyChecks = new Map()
    this.publishingReady = false
    this.dependencyReconciling = false
    this.queuePumpSuspended = true
    this.currentRiaTurn = undefined
    this.pumping = undefined
    this.pumpAgain = false
    this.outboxTimer = undefined
    this.dispatchPending = new Map()
    this.dispatchConfirmBlocked = new Set()
    this.installed = new WeakSet()
    this.disposers = []
    this.reflections = new Map()
    this.reflectionBindings = new Map()
    this.reflectionInstalled = new WeakSet()
    this.reflectionDisposers = new Map()
    this.reflectionSeenRefs = new Map()
    this.reflectionActivity = new Map()
    this.reflectionScheduleError = null
    this.schedule = undefined
    if (typeof ctx.inject === 'function') {
      this.scheduleFiber = ctx.inject(['schedule'], scheduleCtx => {
        const schedule = typeof scheduleCtx.get === 'function' ? scheduleCtx.get('schedule') : scheduleCtx.schedule
        this.schedule = schedule
        if (typeof scheduleCtx.effect === 'function') {
          scheduleCtx.effect(() => () => {
            if (this.schedule === schedule) this.schedule = undefined
          }, 'dsh-ria: reflection schedule')
        }
      })
    }
    // Router preview is optional. Capture the host llm service when present
    // without making it a hard dependency of the existing Ria plugin.
    this.routerLlm = undefined
    this.routerLlmFiber = undefined
    if (typeof ctx.inject === 'function') {
      this.routerLlmFiber = ctx.inject(['llm'], llmCtx => {
        const llm = typeof llmCtx.get === 'function' ? llmCtx.get('llm') : llmCtx.llm
        this.routerLlm = llm
        if (typeof llmCtx.effect === 'function') {
          llmCtx.effect(() => () => {
            if (this.routerLlm === llm) this.routerLlm = undefined
          }, 'dsh-ria: router llm')
        }
      })
    }
    this.creatingId = undefined
    this.ensuring = undefined
    this.started = false
    this.grants = new GrantService({
      ctx,
      store: this.store,
      stateDir,
      isWorker: sessionId => this.isWorker(sessionId),
      log: (level, message) => this.log(level, 'grant: ' + message),
    })
    // currentRiaTurn is set by turn/start and cleared by turn/end for Ria's
    // own session only. It is the same signal the outbox uses to decide
    // whether a note can join the active turn.
    const isRiaBusy = () => Number.isSafeInteger(this.currentRiaTurn)
    this.wechat = new WechatService({
      ctx,
      stateDir,
      ensureRia: () => this.ensure().then(result => result.sessionId),
      getRiaId: () => this.store.riaSessionId,
      log: (level, message) => this.log(level, 'wechat: ' + message),
      isRiaBusy,
      markdownFile: options.markdownFile,
      wechatImage: options.wechatImage,
      imageBufferOptions: () => this.options.channels?.wechat?.imageBuffer,
      onChannelEvent: event => this.routerEvent(event),
      autoPauseEnabled: () => this.store.settings().wechatAutoPause,
      onAutoPause: status => this.notifyWechatAutoPause(status),
      onResume: (status, info) => this.handleWechatResume(status, info),
      onHumanMessage: at => this.store.noteHumanMessage(at),
      getOutboxStats: () => this.outbox.outboxStats(),
    })
    this.wechatClaw = new WechatClawService({
      ctx,
      stateDir,
      ensureRia: () => this.ensure().then(result => result.sessionId),
      getRiaId: () => this.store.riaSessionId,
      log: (level, message) => this.log(level, 'wechat-claw: ' + message),
      isRiaBusy,
      imageOptions: () => this.store.settings().wechatClawImage,
      fileOptions: () => this.channelFileOptions('wechat-claw'),
      imageBufferOptions: () => this.options.channels?.['wechat-claw']?.imageBuffer,
      onChannelEvent: event => this.routerEvent(event),
      onAutoPause: status => this.notifyChannelAutoPause('wechat-claw', status),
      onResume: (status, info) => this.handleWechatResume(status, info),
      onHumanMessage: at => this.store.noteHumanMessage(at),
      getOutboxStats: () => this.outbox.outboxStats(),
      onAssistantUndelivered: info => this.notifyWechatAssistantFallback(info),
      onInbound: () => this.handleWechatClawInbound(),
      // Direct mode never silences the Chat; it only labels its text 【Ria】.
      isDirectActive: () => Boolean(this.v2 && typeof this.v2.directInfo === 'function' && this.v2.directInfo().active),
      directRelay: (content, sessionId) => this.v2 ? this.v2.directRelay(content, sessionId) : false,
      typingOptions: () => {
        const channels = options.channels && typeof options.channels === 'object' ? options.channels : {}
        const claw = channels['wechat-claw']
        return claw && typeof claw === 'object' ? claw.typing : undefined
      },
    })
    this.qqBot = new QqBotService({
      ctx,
      stateDir,
      ensureRia: () => this.ensure().then(result => result.sessionId),
      getRiaId: () => this.store.riaSessionId,
      log: (level, message) => this.log(level, 'qq-bot: ' + message),
      isRiaBusy,
      onAutoPause: status => this.notifyChannelAutoPause('qq-bot', status),
      onHumanMessage: at => this.store.noteHumanMessage(at),
      typingOptions: () => {
        const channels = options.channels && typeof options.channels === 'object' ? options.channels : {}
        const qq = channels['qq-bot']
        return qq && typeof qq === 'object' ? qq.typing : undefined
      },
    })
    // v2 is opt-in at construction so direct RiaService users keep the legacy
    // manager unless apply() enables it. Tickets stay in RiaStore either way.
    this.v2 = options.v2 === true ? new V2Controller(this) : null
  }

  /** Read-only export mirror: the JSON file never feeds reads in sqlite mode. */
  exportTicketMirror(snapshot = this.runtime?.mirrorSnapshot(), guard = {}) {
    if (!this.runtime) return false
    return writeMirrorSnapshot({ stateDir: this.stateDir, snapshot, ...guard })
  }

  flushStorage() {
    if (!this.runtime) return false
    return this.runtime.flush()
  }

  closeStorage() {
    if (!this.runtime) return
    this.runtime.close()
  }

  log(level, message) {
    const logger = this.ctx.logger
    if (!logger || typeof logger[level] !== 'function') return
    logger[level]('dsh-ria: %s', message)
  }

  /** Fire-and-forget router event; observability never breaks control flow. */
  routerEvent(event) {
    try {
      if (this.routerEvents) this.routerEvents.append(event)
    } catch (error) {
      this.log('warn', 'could not append router event: ' + String(error && error.message ? error.message : error))
    }
  }

  subscribe() {
    return this.ctx.on('session/event', (session, event) => this.onSessionEvent(session, event))
  }

  /**
   * A real user message is the only safe anchor for a phone-channel resume.
   * Host-injected notices ([Worker idle], [Task intake], queue wakes, scheduled
   * reminders) carry host_ request ids and must never move it.
   */
  noteHumanMessageFromEvent(event) {
    const messages = []
    if (event.type === 'user/message') {
      messages.push(event.data && event.data.message ? event.data.message : event.data)
    } else if (event.type === 'agent/inbox/spliced') {
      const inserted = event.data && Array.isArray(event.data.inserted) ? event.data.inserted : []
      messages.push(...inserted)
    }
    let noted = 0
    for (const message of messages) {
      const source = message && message.source
      if (!source || source.kind !== 'user') continue
      const rpcId = typeof message.rpcId === 'string'
        ? message.rpcId
        : (typeof source.rpcId === 'string' ? source.rpcId : '')
      if (!rpcId || isHostRequestId(rpcId)) continue
      const at = Number.isFinite(message.time) ? message.time : (eventTime(event) || now())
      this.store.noteHumanMessage(at)
      noted += 1
    }
    return noted
  }

  onSessionEvent(session, event) {
    if (this.v2 && this.v2.onSessionEvent(session, event)) return
    const riaId = this.store.riaSessionId
    if (!riaId || !session || !event) return
    const header = session.header
    const id = header && header.id !== undefined
      ? String(header.id)
      : (session.id !== undefined ? String(session.id) : '')
    if (event.type === 'turn/start' && id !== String(riaId)) {
      this.confirmWorkerTurnStart(id)
      return
    }
    if (id !== String(riaId)) return
    if (event.type === 'user/message' || event.type === 'agent/inbox/spliced') {
      this.noteHumanMessageFromEvent(event)
    }
    if (event.type === 'turn/start') {
      const turn = event.data && event.data.turn
      if (Number.isSafeInteger(turn)) this.currentRiaTurn = turn
      // A note queued while no turn was active can now be attached to this one.
      void this.pumpOutbox('turn-start')
      return
    }
    // Only abnormal turn ends need host-side cleanup. Completed turns have
    // already been resolved by ria_resolve; intakes survive a crash and are
    // picked up by the next startup instead.
    if (event.type === 'turn/end') {
      const turn = event.data && event.data.turn
      if (!Number.isSafeInteger(turn) || this.currentRiaTurn === turn) this.currentRiaTurn = undefined
      this.closeIntakesForTurn(event.data)
      // Queue signals are prompts, not cards: they must not interleave with the
      // turn that just ended, so they wait for this boundary. Publish first so
      // a wake lost while the turn was running is rebuilt from state.
      this.publishReadyNotices()
      void this.pumpOutbox('turn-end')
    }
  }

  /**
   * Register a dispatch before prompt() is awaited. The worker can open its
   * turn before prompt() resolves, so the turn/start would otherwise be lost.
   */
  registerDispatch(delivery) {
    if (!delivery || !delivery.requestId) return undefined
    const pending = {
      requestId: String(delivery.requestId),
      deliveryId: delivery.deliveryId,
      ticketId: delivery.ticketId || delivery.taskId || '',
      targetSessionId: String(delivery.targetSessionId),
      mode: delivery.mode || 'queue',
      registeredAt: now(),
      confirmedAt: undefined,
    }
    this.dispatchPending.set(pending.requestId, pending)
    return pending
  }

  /** Build the attempt record for a dispatch, preserving an early turn/start. */
  dispatchAttempt(pending) {
    const attempt = { lastRequestId: pending.requestId, startedAt: pending.registeredAt, legacy: false }
    if (pending.mode === 'steer') {
      // Steer injects into the running turn and never emits a new turn/start.
      attempt.confirmedAt = pending.registeredAt
      attempt.immediate = true
    } else if (pending.confirmedAt) {
      attempt.confirmedAt = pending.confirmedAt
    }
    return attempt
  }

  forgetDispatch(requestId) {
    if (requestId) this.dispatchPending.delete(String(requestId))
  }

  /** A worker turn/start confirms every dispatch waiting on that session. */
  confirmWorkerTurnStart(sessionId) {
    const id = String(sessionId || '')
    if (!id || id === String(this.store.riaSessionId || '')) return
    const at = now()
    for (const pending of this.dispatchPending.values()) {
      if (pending.targetSessionId === id && !pending.confirmedAt) pending.confirmedAt = at
    }
    for (const ticket of this.tickets.tickets()) {
      if (ticket.status !== 'working' || String(ticket.executor || '') !== id) continue
      const attempt = ticket.attempt
      if (!attempt || !attempt.lastRequestId || attempt.confirmedAt) continue
      try {
        const confirmed = this.tickets.confirmDispatchAttempt(ticket.ticketId, attempt.lastRequestId, at)
        if (confirmed) {
          this.routerEvent({
            event: 'dispatch.confirmed',
            ticketId: ticket.ticketId,
            sessionId: id,
            actor: 'router',
            reason: 'worker turn/start',
            payload: { workerId: id, requestId: String(attempt.lastRequestId) },
          })
        }
      } catch (error) {
        this.log('warn', 'could not confirm dispatch for ' + ticket.ticketId + ': ' + String(error && error.message ? error.message : error))
      }
    }
  }

  /**
   * Park a working ticket whose dispatch was accepted but whose worker never
   * opened a turn. This is deliberately driven by durable timestamps, not by a
   * single setTimeout, so a restart still catches an expired dispatch.
   */
  reconcileDispatchConfirmations(reason = 'tick') {
    const riaId = String(this.store.riaSessionId || '')
    const at = now()
    let blocked = 0
    for (const ticket of this.tickets.tickets()) {
      if (ticket.status !== 'working') continue
      if (riaId && String(ticket.executor || '') === riaId) continue
      const attempt = ticket.attempt
      if (!attempt || !attempt.lastRequestId || attempt.confirmedAt) continue
      const startedAt = Number.isFinite(attempt.startedAt) ? attempt.startedAt : ticket.updatedAt
      if (!Number.isFinite(startedAt) || at - startedAt < DISPATCH_CONFIRM_TIMEOUT_MS) continue
      // One-time evidence check, not a watcher: a durable progress record that
      // is at least as new as the dispatch proves the worker did start. This
      // covers lost turn/start events and older builds that never confirmed
      // from v2 events. Genuinely silent dispatches still fall through to the
      // timeout below.
      if (ticket.progress && Number.isFinite(ticket.progress.lastEventAt) && ticket.progress.lastEventAt >= startedAt) {
        try {
          if (this.tickets.confirmDispatchAttempt(ticket.ticketId, attempt.lastRequestId, at)) continue
        } catch (error) {
          this.log('warn', 'could not confirm dispatch for ' + ticket.ticketId + ' from progress: ' + String(error && error.message ? error.message : error))
        }
      }
      const requestId = String(attempt.lastRequestId)
      const key = ticket.ticketId + ':' + requestId
      if (this.dispatchConfirmBlocked.has(key)) continue
      const message = '派发被接受但 60 秒内未开始执行（requestId ' + requestId + '）'
      const moved = this.tickets.transitionTicket(ticket.ticketId, 'blocked', {
        actor: 'host',
        reason: 'dispatch was not confirmed by a worker turn',
        waitingOn: 'environment',
        executor: ticket.executor || 'self',
        blockedReason: message,
        failure: { code: 'dispatch_unconfirmed', message, at },
      })
      if (!moved.ok) {
        this.log('warn', 'could not block unconfirmed dispatch ' + ticket.ticketId + ': ' + moved.code + ' ' + moved.message)
        continue
      }
      this.dispatchConfirmBlocked.add(key)
      blocked += 1
      this.routerEvent({
        event: 'dispatch.blocked',
        ticketId: ticket.ticketId,
        sessionId: ticket.executor || 'self',
        actor: 'router',
        reason: 'dispatch was not confirmed by a worker turn',
        payload: { workerId: ticket.executor || 'self', requestId, message, source: reason },
      })
      this.log('warn', 'dispatch for ' + ticket.ticketId + ' was not confirmed by ' + (ticket.executor || 'worker') + ' within ' + DISPATCH_CONFIRM_TIMEOUT_MS + 'ms (' + reason + ', requestId ' + requestId + ')')
      const note = '⚠️ 工单 ' + ticket.ticketId + ' 已派发给 worker ' + (ticket.executor || '未知') + '，但 60 秒内没有开始执行。可能已归档、队列卡住或会话异常。requestId=' + requestId + '，worker=' + (ticket.executor || '未知') + '。已把工单标为 blocked（waitingOn=environment），请检查后重新派发或把它改回 open。'
      try {
        const noteId = newId('note_')
        const queued = this.outbox.enqueue({
          kind: 'dispatch_unconfirmed',
          dedupeKey: 'dispatch_unconfirmed:' + ticket.ticketId + ':' + requestId,
          payload: { noteId, sessionId: riaId, note, isTicket: true, ticketId: ticket.ticketId },
        })
        const effective = queued && queued.entry && queued.entry.payload && queued.entry.payload.noteId ? queued.entry.payload.noteId : noteId
        this.notifyDispatchNote(note, true, ticket.ticketId, effective)
      } catch (error) {
        this.log('warn', 'could not queue dispatch-unconfirmed alert for ' + ticket.ticketId + ': ' + String(error && error.message ? error.message : error))
      }
    }
    return blocked
  }

  /** The store calls this at the end of every committed state write. */
  onTicketsCommitted() {
    // Broadcast before the ready-notice guard: dependency reconciliation may
    // skip intermediate wakes, but an open board still needs the new counts.
    this.publishBoardChange()
    // reconcileDependencies emits a boot-scoped wake for each ticket it makes
    // ready. Publishing from the intermediate saves would enqueue a second,
    // no-boot wake for the same readiness; startup publishes once afterwards.
    if (this.dependencyReconciling) return
    try {
      this.publishReadyNotices()
    } catch (error) {
      this.log('warn', 'ready notice publish failed: ' + String(error && error.message ? error.message : error))
    }
  }

  /**
   * Tell every open board that committed ticket/topic state has changed. The
   * payload is deliberately small; the client refetches /board after a short
   * debounce, which also collapses a burst of writes into one request.
   */
  publishBoardChange() {
    this.boardRevision += 1
    this.boardChangedAt = Date.now()
    if (this.boardStreams.size === 0) return
    const payload = 'event: board\ndata: ' + JSON.stringify({
      revision: this.boardRevision,
      at: this.boardChangedAt,
    }) + '\n\n'
    for (const stream of [...this.boardStreams]) {
      try {
        if (!stream.res.writableEnded) stream.res.write(payload)
      } catch (error) {
        this.closeBoardStream(stream)
      }
    }
  }

  /** Open one long-lived same-origin SSE response for board revisions. */
  openBoardStream(req, res) {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })
    if (typeof res.flushHeaders === 'function') res.flushHeaders()
    res.write('retry: 3000\n\n')
    res.write('event: ready\ndata: ' + JSON.stringify({
      revision: this.boardRevision,
      at: this.boardChangedAt,
    }) + '\n\n')
    const stream = { req, res, heartbeat: undefined, closed: false }
    const close = () => this.closeBoardStream(stream)
    if (typeof res.on === 'function') res.on('close', close)
    if (req && typeof req.on === 'function') req.on('aborted', close)
    stream.heartbeat = setInterval(() => {
      try {
        if (!res.writableEnded) res.write(': ping\n\n')
      } catch (error) {
        close()
      }
    }, 25000)
    if (stream.heartbeat && typeof stream.heartbeat.unref === 'function') stream.heartbeat.unref()
    this.boardStreams.add(stream)
  }

  closeBoardStream(stream) {
    if (!stream || stream.closed) return
    stream.closed = true
    if (stream.heartbeat) clearInterval(stream.heartbeat)
    this.boardStreams.delete(stream)
    try {
      if (!stream.res.writableEnded) stream.res.end()
    } catch { /* client already gone */ }
  }

  shutdownBoardStreams() {
    for (const stream of [...this.boardStreams]) this.closeBoardStream(stream)
  }

  /**
   * State is the source of truth for readiness. A ready ticket whose
   * readyNotifiedAt is still null has never reached Ria: the callback may not
   * have been wired, its enqueue may have been lost, or delivery may have
   * failed. Rebuild the wake from committed state and pump. Returns how many
   * wakes were newly enqueued. This is idempotent and is called from the store
   * commit hook, startup, and Ria turn end.
   */
  publishReadyNotices(options = {}) {
    if (this.publishingReady) return 0
    const onlyTicketId = typeof options.ticketId === 'string' ? options.ticketId : ''
    this.publishingReady = true
    try {
      let enqueued = 0
      let candidates = 0
      for (const ticket of this.tickets.tickets()) {
        if (onlyTicketId && ticket.ticketId !== onlyTicketId) continue
        if (ticket.status !== 'open' || ticket.waitingOn !== 'ria') continue
        if (!Number.isFinite(ticket.readyAt) || Number.isFinite(ticket.readyNotifiedAt)) continue
        if (!Array.isArray(ticket.dependsOn) || ticket.dependsOn.length === 0) continue
        candidates += 1
        const existing = this.outbox.all().find(entry => entry.kind === 'queue_wake' &&
          entry.payload && entry.payload.ticketId === ticket.ticketId && entry.payload.readyAt === ticket.readyAt)
        if (existing) {
          // The wake was accepted but the notified stamp did not persist. Mark it
          // rather than delivering the same readiness twice.
          if (existing.status === 'delivered') {
            this.tickets.markReadyNotified(ticket.ticketId, ticket.readyAt)
            this.log('warn', 'queue wake for ' + ticket.ticketId + ' was delivered but not stamped; marked readyNotifiedAt (readyAt=' + ticket.readyAt + ')')
          } else {
            this.scheduleReadyCheck(ticket.ticketId, ticket.readyAt)
          }
          continue
        }
        this.outbox.enqueue({
          kind: 'queue_wake',
          dedupeKey: queueWakeDedupeKey(ticket.ticketId, ticket.readyAt, null),
          payload: { ticketId: ticket.ticketId, readyAt: ticket.readyAt, bootId: null },
        })
        enqueued += 1
        const age = Math.max(0, now() - ticket.readyAt)
        this.log('warn', 'queue wake for ' + ticket.ticketId + ' was missing; published from state (readyAt=' + ticket.readyAt + ', age=' + age + 'ms)')
        this.scheduleReadyCheck(ticket.ticketId, ticket.readyAt)
      }
      if (candidates && !this.queuePumpSuspended) void this.pumpOutbox('ready-publish')
      return enqueued
    } finally {
      this.publishingReady = false
    }
  }

  /**
   * Short-lived verification for one readiness. Two one-shot timers only; each
   * pass looks at one ticket and its wake, never the whole table.
   */
  scheduleReadyCheck(ticketId, readyAt) {
    const id = String(ticketId || '')
    if (!id || !Number.isFinite(readyAt)) return
    const current = this.readyChecks.get(id)
    if (current && current.readyAt === readyAt) return
    if (current) this.clearReadyCheck(id, current.readyAt)
    const record = { readyAt, timers: new Set() }
    this.readyChecks.set(id, record)
    for (const delay of READY_VERIFY_DELAYS_MS) {
      const timer = setTimeout(() => {
        record.timers.delete(timer)
        try {
          this.verifyReadyNotice(id, readyAt)
        } catch (error) {
          this.log('warn', 'ready notice verification failed for ' + id + ': ' + String(error && error.message ? error.message : error))
        } finally {
          if (record.timers.size === 0 && this.readyChecks.get(id) === record) this.readyChecks.delete(id)
        }
      }, delay)
      if (typeof timer.unref === 'function') timer.unref()
      record.timers.add(timer)
    }
  }

  clearReadyCheck(ticketId, readyAt) {
    const id = String(ticketId || '')
    const record = this.readyChecks.get(id)
    if (!record || record.readyAt !== readyAt) return
    for (const timer of record.timers) clearTimeout(timer)
    this.readyChecks.delete(id)
  }

  verifyReadyNotice(ticketId, readyAt) {
    const ticket = this.tickets.ticket(ticketId)
    if (!ticket || ticket.readyAt !== readyAt || ticket.status !== 'open' || ticket.waitingOn !== 'ria' || Number.isFinite(ticket.readyNotifiedAt)) {
      this.clearReadyCheck(ticketId, readyAt)
      return
    }
    const existing = this.outbox.all().find(entry => entry.kind === 'queue_wake' &&
      entry.payload && entry.payload.ticketId === ticketId && entry.payload.readyAt === readyAt)
    if (existing && existing.status === 'delivered') {
      this.tickets.markReadyNotified(ticketId, readyAt)
      this.log('warn', 'queue wake for ' + ticketId + ' was delivered but not stamped; marked readyNotifiedAt (readyAt=' + readyAt + ')')
      this.clearReadyCheck(ticketId, readyAt)
      return
    }
    this.publishReadyNotices({ ticketId })
  }

  /** Turn store dependency transitions into durable queue signals. */
  handleQueueEvent(event) {
    if (!event || typeof event !== 'object' || typeof event.ticketId !== 'string' || !event.ticketId) return
    const ticketId = event.ticketId
    if (event.kind === 'ready') {
      const readyAt = Number.isFinite(event.readyAt) ? event.readyAt : null
      if (readyAt === null) return
      const dedupeKey = queueWakeDedupeKey(ticketId, readyAt, event.bootId)
      this.outbox.enqueue({
        kind: 'queue_wake',
        dedupeKey,
        payload: { ticketId, readyAt, bootId: event.bootId || null },
      })
      if (!this.queuePumpSuspended) void this.pumpOutbox('queue-ready')
      return
    }
    if (event.kind === 'blocked') {
      const alerts = Array.isArray(event.alerts) ? event.alerts : []
      const signature = alerts.map(alert => alert.ticketId + ':' + alert.status).join(',')
      if (!signature) return
      this.outbox.enqueue({
        kind: 'queue_blocked',
        dedupeKey: 'queue_blocked:' + ticketId + ':' + signature,
        payload: { ticketId, alerts },
      })
      if (!this.queuePumpSuspended) void this.pumpOutbox('queue-blocked')
      return
    }
    if (event.kind === 'invalidate') {
      // Drop only the wake for the readiness being invalidated. A newer wake
      // (different readyAt) is still valid and must survive a stale event.
      // With no readyAt the invalidation is unqualified and clears every wake
      // for this ticket. The next publish point restores anything still due.
      const readyAt = Number.isFinite(event.readyAt) ? event.readyAt : null
      this.outbox.removeWhere(entry => entry.kind === 'queue_wake' && entry.payload && entry.payload.ticketId === ticketId &&
        (readyAt === null || entry.payload.readyAt === readyAt))
      this.outbox.removeWhere(entry => entry.kind === 'queue_blocked' && entry.payload && entry.payload.ticketId === ticketId)
    }
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

  subscribeV2() {
    const disposePreStep = this.ctx.on('agent/pre-step', (payload, next) => this.v2.onPreStep(payload, next))
    // Read-only notices for ordinary sessions parked on an approval/question.
    // The controller prepends these waterfalls and always delegates with next().
    const disposeBlockedNotices = this.v2.subscribeBlockedNotices()
    return () => {
      try { disposePreStep() } catch { /* already removed */ }
      try { disposeBlockedNotices() } catch { /* already removed */ }
    }
  }

  async onPreStep(payload, next) {
    if (this.v2) return await this.v2.onPreStep(payload, next)
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
        captured = this.tickets.captureIntake({
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
    const candidates = this.tickets.intakeCandidates(ids)
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
    if (this.v2) return
    if (!this.isRiaAgent(payload && payload.agent)) return
    const signal = payload.signal
    if (signal && signal.aborted) return
    const turn = payload.turn
    const intakes = this.tickets.intakesForTurn(turn)
    if (intakes.length === 0) return
    const fresh = intakes.filter(ticket => ticket.nudgeCount === 0)
    if (fresh.length > 0) {
      for (const ticket of fresh) {
        try { this.tickets.bumpNudge(ticket.ticketId) } catch (error) {
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
      const moved = this.tickets.transitionTicket(ticket.ticketId, 'blocked', {
        actor: 'host',
        blockedReason: 'Ria 未在 turn 内给出归宿（已提醒一次）',
        waitingOn: 'user',
        executor: ticket.executor || 'self',
      })
      if (!moved.ok) {
        this.log('warn', 'could not block unresolved intake ' + ticket.ticketId + ': ' + moved.code)
        continue
      }
      const noteId = this.appendDispatchNote(payload.agent, body, ticket.ticketId, turn)
      if (noteId) this.notifyDispatchNote(body, true, ticket.ticketId, noteId)
    }
    void this.pumpOutbox('turn-stopping')
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
    const intakes = this.tickets.intakesForTurn(turn)
    if (intakes.length === 0) return
    for (const ticket of intakes) {
      if (kind === 'aborted' && cancelKind === 'user') {
        this.tickets.transitionTicket(ticket.ticketId, 'cancelled', {
          actor: 'user',
          executor: ticket.executor || 'self',
          resolution: { kind: 'aborted', reason: '用户中止了这一轮' },
        })
      } else if (kind === 'error') {
        const body = '这一轮异常结束，用户消息没有归宿，已标记 blocked：' + clipText(ticket.goal, 120)
        this.store.addFeedback({ ticketId: ticket.ticketId, kind: 'blocked', code: 'turn_failed', body, card: true, mirror: true, turn, at: now() })
        this.tickets.transitionTicket(ticket.ticketId, 'blocked', {
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
    if (this.v2) {
      if (this.v2.onAgentCreated(agent)) return
      // In v2 the legacy ria_* manager tools must never be installed, including
      // on a stale Ria session id left in ria.json from a previous install.
      if (this.reflectionBindings.has(id)) {
        try {
          this.installReflectionTools(agent, this.reflectionBindings.get(id))
        } catch (error) {
          this.log('error', 'could not install reflection tools on ' + id + ': ' + String(error && error.message ? error.message : error))
        }
      }
      return
    }
    // A reflection worker is created through ria_spawn with its binding already
    // in place. It gets the six read-only reflect tools and never the ria_*
    // manager tools, even while a normal Ria spawn is in flight.
    if (this.reflectionBindings.has(id)) {
      try {
        this.installReflectionTools(agent, this.reflectionBindings.get(id))
      } catch (error) {
        this.log('error', 'could not install reflection tools on ' + id + ': ' + String(error && error.message ? error.message : error))
      }
      return
    }
    if (id !== this.store.riaSessionId && id !== this.creatingId) return
    // v1 manager tools were removed; v2 installs its own role tools.
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

  /**
   * A board prompt is an ordinary user message from the board, not a ticket.
   * It names the topic the person was looking at, then goes through Ria's normal
   * queue: if she is mid-turn it waits instead of interrupting her. No worker is
   * selected, no ticket is written, and no dispatch record is created.
   */
  async askBoardTopic(body = {}) {
    const text = asString(body.text)
    if (!text) throw transitionError('text_empty', '消息不能为空')
    if ([...text].length > BOARD_ASK_TEXT_LIMIT) throw transitionError('text_too_long', '消息不能超过 ' + BOARD_ASK_TEXT_LIMIT + ' 字')
    const source = asString(body.source) || (asString(body.projectId) ? 'workspace' : 'card')
    if (source !== 'workspace' && source !== 'card') throw transitionError('source_invalid', 'source must be workspace or card')
    // The header is one line, so keep a pasted title from pushing the body to
    // a second line of its own. The body starts on the next line.
    const headerLabel = value => String(value || '').replace(/\s+/g, ' ').trim()
    let topicId = ''
    let projectId = ''
    let textWithSource = ''
    if (source === 'workspace') {
      projectId = asString(body.projectId)
      if (!projectId) throw transitionError('project_required', 'projectId is required')
      const projectTitle = headerLabel(body.projectTitle) || projectId
      textWithSource = '[来自看板 / ' + projectTitle + ']\n' + text
    } else {
      topicId = asString(body.topicId)
      if (!topicId) throw transitionError('topic_required', 'topicId is required')
      if (topicId.startsWith('unclassified:')) throw transitionError('topic_unclassified', 'cannot ask from the unclassified bucket')
      const topic = this.store.topic(topicId)
      if (!topic) throw transitionError('topic_missing', 'topic not found: ' + topicId)
      if (topic.unclassified) throw transitionError('topic_unclassified', 'cannot ask from the unclassified bucket')
      if (topic.archivedAt || topic.mergedInto) throw transitionError('topic_archived', 'topic is archived or merged: ' + topicId)
      const topicTitle = headerLabel(topic.title) || topicId
      // The board already knows which project a topic card sits in; using the
      // title it sends avoids re-deriving the project from the ticket.
      const projectTitle = headerLabel(body.projectTitle) || headerLabel(body.projectId) || '未分配'
      textWithSource = '[来自看板 / ' + projectTitle + ' / ' + topicTitle + ']\n' + text
    }
    const { sessionId } = await this.ensure()
    if (!sessionId) throw new Error('Ria is not registered yet')
    try {
      await this.ctx.sessionController.prompt({
        requestId: newId(HOST_REQUEST_PREFIX),
        sessionId,
        mode: 'queue',
        content: [{ type: 'text', text: textWithSource }],
      }, NEVER_ABORTED)
    } catch (error) {
      throw transitionError('ask_failed', '没能把消息发给 Ria：' + String(error && error.message ? error.message : error))
    }
    return projectId
      ? { ok: true, projectId, source, sessionId }
      : { ok: true, topicId, source, sessionId }
  }

  async listSessions(signal) {
    const page = await this.ctx.sessionController.list({}, signal)
    return Array.isArray(page && page.items) ? page.items : []
  }

  /**
   * The live ticket first, then the newest archived record with the same id.
   * The board merges both the same way; the detail endpoint must agree with
   * the card the user clicked, including after archival.
   */
  findBoardTicket(ticketId) {
    const id = asString(ticketId)
    if (!id) return undefined
    const hot = this.tickets.ticket(id)
    if (hot) return hot
    let found
    for (const record of this.tickets.historyRecords()) {
      const ticket = normalizeTicket(record.ticket)
      if (!ticket || ticket.ticketId !== id) continue
      if (!found || (ticket.closedAt || 0) > (found.closedAt || 0)) found = ticket
    }
    return found
  }

  /**
   * Last-result projection for the ticket detail panel. The board payload
   * stays unchanged: this is fetched only when the panel opens. A missing
   * worker session, an archived one, or a read failure degrades to a null
   * lastResult so the client can fall back to resolution/goal instead.
   */
  async boardTicketDetail(ticketId) {
    const ticket = this.findBoardTicket(ticketId)
    if (!ticket) return { ok: false, code: 'ticket_missing', message: 'ticket not found: ' + asString(ticketId) }
    const result = {
      ok: true,
      ticketId: ticket.ticketId,
      resolution: ticket.resolution || null,
      lastResult: null,
    }
    const executor = asString(ticket.executor)
    if (!executor || executor === 'self' || executor === this.store.riaSessionId) return result
    let records = []
    try {
      const resolved = await this.ctx.sessionController.resolveAgent(executor)
      if (!('error' in resolved)) {
        const events = resolved.agent.session.snapshotEvents()
        records = Array.isArray(events) ? events : []
      } else if (resolved.error.code === 'session/not-found') {
        if (typeof this.ctx.sessionController.events !== 'function') return result
        const page = await this.ctx.sessionController.events({ address: { kind: 'session', sessionId: executor }, maxMessages: 200 }, NEVER_ABORTED)
        records = Array.isArray(page && page.records) ? page.records : []
      } else {
        return result
      }
    } catch (error) {
      result.error = String(error && error.message ? error.message : error)
      return result
    }
    result.lastResult = lastAssistantResult(records)
    return result
  }

  /**
   * Read-only projection for the board UI. Session metadata turns a ticket's
   * executor into a lane label, while the ticket keeps its own timestamps so
   * the client can derive a quantile pseudo-time axis without a second call.
   * A missing or archived session only downgrades its lane; it never throws.
   */
  async boardData(options = {}) {
    const limit = Math.max(1, Math.min(200, Number.isSafeInteger(options.limit) ? options.limit : 60))
    const before = Number.isFinite(options.before) ? options.before : null
    const items = await this.listSessions()
    const sessions = new Map(items.map(item => [String(item.sessionId), item]))
    const archived = this.archivedSessions()
    let workspaces = []
    try {
      workspaces = typeof this.ctx.workspaceRegistry.list === 'function' ? this.ctx.workspaceRegistry.list() : []
    } catch (error) {
      this.log('warn', 'could not read workspaces for the board: ' + String(error && error.message ? error.message : error))
    }
    const workspaceBySession = new Map()
    for (const workspace of Array.isArray(workspaces) ? workspaces : []) {
      for (const sessionId of Array.isArray(workspace.sessionIds) ? workspace.sessionIds : []) {
        workspaceBySession.set(String(sessionId), workspace)
      }
    }
    const projectKeyOf = cwd => {
      try { return cwd ? projectKey(cwd) : null } catch { return null }
    }
    const metaFor = ticketId => {
      try { return this.v2 && this.v2.v2 ? this.v2.v2.ticketMeta(ticketId) : null } catch { return null }
    }
    const workerIdentity = executor => {
      const id = String(executor || '')
      if (!id || !this.v2 || !this.v2.v2) return { tags: [], roleNote: '', dedicated: false }
      const worker = this.v2.v2.worker(id)
      return worker
        ? { tags: Array.isArray(worker.tags) ? worker.tags.slice() : [], roleNote: worker.roleNote || '', dedicated: worker.dedicated === true }
        : { tags: [], roleNote: '', dedicated: false }
    }
    const lanes = new Map()
    const laneFor = executor => {
      const id = String(executor || '')
      const riaId = this.store.riaSessionId || ''
      if (!id) return { id: 'unassigned', label: '未分配', kind: 'unassigned', projectKey: null }
      if (id === riaId || id === 'self') return { id: 'ria', label: 'Ria · 管家', kind: 'ria', projectKey: null }
      const summary = sessions.get(id)
      const workspace = workspaceBySession.get(id)
      if (workspace) {
        return {
          id: 'workspace:' + workspace.id,
          label: workspace.title || basename(workspace.path || '') || id,
          kind: 'workspace',
          cwd: workspace.path || '',
          sessionId: id,
          projectKey: projectKeyOf(workspace.path),
        }
      }
      const cwd = summary && typeof summary.cwd === 'string' ? summary.cwd : ''
      if (cwd) {
        return { id: 'path:' + cwd, label: basename(cwd) || cwd, kind: 'path', cwd, sessionId: id, projectKey: projectKeyOf(cwd) }
      }
      if (summary) {
        return { id: 'session:' + id, label: sessionTitle(summary) || id, kind: 'session', sessionId: id, projectKey: null }
      }
      return { id: 'unassigned', label: '未分配', kind: 'unassigned', projectKey: null }
    }

    // The board spans the hot store and the archive. A ticket in the hot store
    // wins over an older archive record; an archived ticket is normalised with
    // the same shape so the client needs no second code path.
    const byId = new Map()
    for (const record of this.tickets.historyRecords()) {
      const ticket = normalizeTicket(record.ticket)
      if (!ticket.ticketId) continue
      const known = byId.get(ticket.ticketId)
      if (!known || (ticket.closedAt || 0) > (known.closedAt || 0)) byId.set(ticket.ticketId, ticket)
    }
    for (const ticket of this.tickets.tickets()) byId.set(ticket.ticketId, ticket)
    const all = [...byId.values()]
    const dependents = new Map()
    for (const ticket of all) {
      for (const dependency of Array.isArray(ticket.dependsOn) ? ticket.dependsOn : []) {
        dependents.set(dependency, (dependents.get(dependency) || 0) + 1)
      }
    }
    const ordered = all.sort((left, right) => (left.createdAt || 0) - (right.createdAt || 0))
    const filtered = before === null ? ordered : ordered.filter(ticket => (ticket.createdAt || 0) < before)
    const startIndex = Math.max(0, filtered.length - limit)
    const page = filtered.slice(startIndex)
    const hasMore = startIndex > 0
    const nextBefore = hasMore && page.length ? (page[0].createdAt || 0) : null

    for (const ticket of page) {
      const lane = laneFor(ticket.executor)
      if (!lanes.has(lane.id)) lanes.set(lane.id, { ...lane, active: 0, total: 0, lastActivityAt: 0 })
      const laneEntry = lanes.get(lane.id)
      laneEntry.total += 1
      if (ACTIVE_STATUSES.includes(ticket.status)) laneEntry.active += 1
      laneEntry.lastActivityAt = Math.max(laneEntry.lastActivityAt, ticket.updatedAt || ticket.createdAt || 0)
    }
    const ticketView = ticket => {
      const queue = this.tickets.queueInfo(ticket)
      const lane = laneFor(ticket.executor)
      const summary = sessions.get(String(ticket.executor || ''))
      const meta = metaFor(ticket.ticketId)
      const ticketCwd = meta && typeof meta.projectCwd === 'string' ? meta.projectCwd : ''
      const identity = workerIdentity(ticket.executor)
      // self and Ria share a lane; the card needs Ria's display name even
      // when the summary is unavailable.
      const riaExecutor = lane.kind === 'ria'
      return {
        ticketId: ticket.ticketId,
        goal: ticket.goal,
        acceptance: ticket.acceptance || '',
        status: ticket.status,
        waitingOn: ticket.waitingOn,
        blockedReason: ticket.blockedReason || '',
        attention: ticket.attention || null,
        dependsOn: Array.isArray(ticket.dependsOn) ? [...ticket.dependsOn] : [],
        dependentCount: dependents.get(ticket.ticketId) || 0,
        checklist: normalizeChecklist(ticket.checklist),
        progress: checklistProgress(ticket.checklist).text,
        executor: ticket.executor || 'self',
        executorTitle: riaExecutor ? 'Ria' : (sessionTitle(summary) || ''),
        executorCwd: (summary && typeof summary.cwd === 'string' ? summary.cwd : lane.cwd) || '',
        executorArchived: archived.has(String(ticket.executor || '')),
        executorMissing: !summary && !riaExecutor,
        executorTags: identity.tags,
        executorRoleNote: identity.roleNote,
        executorDedicated: identity.dedicated,
        projectKey: normalizeProjectKey(projectKeyOf(ticketCwd)) || normalizeProjectKey(lane.projectKey),
        projectCwd: ticketCwd,
        projectTitle: ticketCwd ? (basename(ticketCwd) || ticketCwd) : (lane.label || ''),
        archived: !this.tickets.ticket(ticket.ticketId),
        laneId: lane.id,
        laneLabel: lane.label,
        primaryTopicId: this.store.primaryTopicFor(ticket.ticketId),
        createdAt: ticket.createdAt,
        updatedAt: ticket.updatedAt,
        closedAt: ticket.closedAt || null,
        readyAt: Number.isFinite(ticket.readyAt) ? ticket.readyAt : null,
        queueState: queue.queueState,
        queueText: queue.queueText,
      }
    }
    const allViews = all.map(ticketView)
    const tickets = page.map(ticketView)
    // Topics are the board's primary grouping. A ticket belongs to exactly one
    // topic card: its primary link. Related links stay visible on the topic
    // page but do not duplicate the ticket across cards. Tickets without a
    // primary link form one synthetic unclassified topic per project.
    const allViewByTicket = new Map(allViews.map(view => [view.ticketId, view]))
    const topicById = new Map(this.store.topics().map(topic => [topic.topicId, topic]))
    const linkedPrimary = new Map()
    for (const link of this.store.links()) {
      if (link.role !== 'primary') continue
      const topic = topicById.get(link.topicId)
      if (!topic || topic.mergedInto) continue
      const view = allViewByTicket.get(link.ticketId)
      if (!view) continue
      if (!linkedPrimary.has(topic.topicId)) linkedPrimary.set(topic.topicId, [])
      linkedPrimary.get(topic.topicId).push(view)
    }
    const projectMap = new Map()
    // Group key priority: the ticket/topic projectKey; the executor lane's
    // cwd-derived projectKey is only a fallback for legacy tickets without one.
    const projectForGroup = (projectKeyValue, lane, extra = {}) => {
      const key = projectKeyValue ? 'project:' + projectKeyValue : lane.id
      if (!projectMap.has(key)) {
        projectMap.set(key, {
          projectId: key,
          id: key,
          projectKey: projectKeyValue || null,
          title: extra.title || lane.label,
          label: extra.label || extra.title || lane.label,
          kind: projectKeyValue ? 'project' : lane.kind,
          cwd: extra.cwd !== undefined ? extra.cwd : (lane.cwd || ''),
          sessionId: lane.sessionId || null,
          counts: { total: 0, active: 0, terminal: 0, blocked: 0, working: 0, topics: 0, topicsActive: 0, topicsBlocked: 0 },
          lastUpdatedAt: 0,
          topics: [],
        })
      }
      return projectMap.get(key)
    }
    const projectForLane = lane => projectForGroup(normalizeProjectKey(lane.projectKey), lane)
    const projectForView = view => {
      const lane = laneFor(view.executor)
      return projectForGroup(normalizeProjectKey(view.projectKey), lane, {
        title: view.projectTitle || lane.label,
        cwd: view.projectCwd || lane.cwd || '',
      })
    }
    const groupKeyForView = view => view.projectKey ? 'project:' + view.projectKey : laneFor(view.executor).id
    for (const view of allViews) {
      const project = projectForView(view)
      project.counts.total += 1
      if (ACTIVE_STATUSES.includes(view.status)) project.counts.active += 1
      if (TERMINAL_STATUSES.includes(view.status)) project.counts.terminal += 1
      if (view.status === 'blocked') project.counts.blocked += 1
      if (view.status === 'working') project.counts.working += 1
      project.lastUpdatedAt = Math.max(project.lastUpdatedAt, view.updatedAt || view.createdAt || 0)
    }
    projectForLane({ id: 'unassigned', label: '未分配', kind: 'unassigned' })

    const topicCard = (topic, views) => {
      const pending = views
        .filter(view => !TERMINAL_STATUSES.includes(view.status) && view.status !== 'working')
        .sort((left, right) => (right.updatedAt || 0) - (left.updatedAt || 0))
      const working = views
        .filter(view => view.status === 'working')
        .sort((left, right) => (right.updatedAt || 0) - (left.updatedAt || 0))
      const counts = topicProgressCounts(views)
      const summary = topicSummaryInfo(topic, views)
      let lastUpdatedAt = topic.updatedAt || topic.createdAt || 0
      for (const view of views) {
        lastUpdatedAt = Math.max(lastUpdatedAt, view.updatedAt || view.createdAt || 0)
      }
      const laneCounts = new Map()
      for (const view of views) {
        const lane = laneFor(view.executor)
        const entry = laneCounts.get(lane.id) || { lane, count: 0, lastUpdatedAt: 0 }
        entry.count += 1
        entry.lastUpdatedAt = Math.max(entry.lastUpdatedAt, view.updatedAt || 0)
        laneCounts.set(lane.id, entry)
      }
      const projectLane = [...laneCounts.values()].sort((left, right) => {
        if (right.count !== left.count) return right.count - left.count
        if (right.lastUpdatedAt !== left.lastUpdatedAt) return right.lastUpdatedAt - left.lastUpdatedAt
        return String(left.lane.label).localeCompare(String(right.lane.label), 'zh-Hans-CN')
      })[0]
      const topicKeyFromViews = views.map(view => normalizeProjectKey(view.projectKey)).find(Boolean) || null
      const topicKey = normalizeProjectKey(topic.projectKey) || topicKeyFromViews
      let project
      if (topicKey) {
        const anchor = views.find(view => normalizeProjectKey(view.projectKey) === topicKey)
        const anchorLane = anchor ? laneFor(anchor.executor) : { id: 'unassigned', label: topicKey, kind: 'project', cwd: '' }
        project = projectForGroup(topicKey, anchorLane, {
          title: anchor ? (anchor.projectTitle || topicKey) : topicKey,
          cwd: anchor ? (anchor.projectCwd || '') : '',
        })
      } else {
        project = projectForLane(projectLane ? projectLane.lane : { id: 'unassigned', label: '未分配', kind: 'unassigned' })
      }
      return {
        topicId: topic.topicId,
        projectKey: normalizeProjectKey(topic.projectKey),
        title: topic.title,
        tags: normalizeTopicTags(topic.tags),
        brief: summary.text,
        summaryAuto: summary.auto,
        archived: Boolean(topic.archivedAt),
        unclassified: Boolean(topic.unclassified),
        projectId: project.projectId,
        projectTitle: project.title,
        counts,
        lastUpdatedAt,
        tickets: pending.slice(0, 6),
        working: working.slice(0, 6),
        done: counts.done,
      }
    }

    for (const [topicId, views] of linkedPrimary) {
      const topic = topicById.get(topicId)
      if (!topic) continue
      const card = topicCard(topic, views)
      projectMap.get(card.projectId).topics.push(card)
    }
    const noPrimary = allViews.filter(view => {
      const topicId = view.primaryTopicId
      if (!topicId) return true
      const topic = topicById.get(topicId)
      return !topic || Boolean(topic.mergedInto)
    })
    const unclassifiedByProject = new Map()
    for (const view of noPrimary) {
      const key = groupKeyForView(view)
      if (!unclassifiedByProject.has(key)) unclassifiedByProject.set(key, [])
      unclassifiedByProject.get(key).push(view)
    }
    for (const [groupKey, views] of unclassifiedByProject) {
      const project = projectForView(views[0])
      const card = topicCard({ topicId: null, title: '未分类', brief: '', tags: [], unclassified: true, updatedAt: 0, createdAt: 0 }, views)
      card.topicId = 'unclassified:' + groupKey
      project.topics.push(card)
    }
    for (const project of projectMap.values()) {
      project.topics.sort((left, right) => (right.lastUpdatedAt || 0) - (left.lastUpdatedAt || 0))
      project.counts.topics = project.topics.length
      project.counts.total = project.topics.reduce((sum, topic) => sum + Number((topic.counts && topic.counts.total) || 0), 0)
      project.counts.topicsActive = project.topics.filter(topic => Number((topic.counts && topic.counts.working) || 0) > 0).length
      project.counts.topicsBlocked = project.topics.filter(topic => Number((topic.counts && topic.counts.blocked) || 0) > 0).length
    }
    const projects = [...projectMap.values()]
      .filter(project => project.topics.length > 0)
      .sort((left, right) => {
        if (right.counts.active !== left.counts.active) return right.counts.active - left.counts.active
        if (right.lastUpdatedAt !== left.lastUpdatedAt) return right.lastUpdatedAt - left.lastUpdatedAt
        return String(left.title).localeCompare(String(right.title), 'zh-Hans-CN')
      })
    const laneList = [...lanes.values()].sort((left, right) => {
      if (right.active !== left.active) return right.active - left.active
      if (right.lastActivityAt !== left.lastActivityAt) return right.lastActivityAt - left.lastActivityAt
      return String(left.label).localeCompare(String(right.label), 'zh-Hans-CN')
    })
    const counts = {
      total: ordered.length,
      active: ordered.filter(ticket => ACTIVE_STATUSES.includes(ticket.status)).length,
      terminal: ordered.filter(ticket => TERMINAL_STATUSES.includes(ticket.status)).length,
      blocked: ordered.filter(ticket => ticket.status === 'blocked').length,
      working: ordered.filter(ticket => ticket.status === 'working').length,
      projects: projects.length,
      topics: projects.reduce((sum, project) => sum + project.counts.topics, 0),
      topicsActive: projects.reduce((sum, project) => sum + project.counts.topicsActive, 0),
      topicsBlocked: projects.reduce((sum, project) => sum + project.counts.topicsBlocked, 0),
    }
    // The board cards only carry the first few tickets per section, so the
    // client cannot search completed tickets or the seventh pending ticket.
    // This compact index is a read-only projection of every ticket; it is not
    // rendered as a card and does not change page.tickets.
    const cardByTopicId = new Map()
    for (const project of projects) {
      for (const card of project.topics) cardByTopicId.set(card.topicId, card)
    }
    const searchIndex = allViews.map(view => {
      const lane = laneFor(view.executor)
      const primary = view.primaryTopicId ? topicById.get(view.primaryTopicId) : null
      const primaryId = primary && !primary.mergedInto ? primary.topicId : ''
      const groupKey = groupKeyForView(view)
      const card = cardByTopicId.get(primaryId || ('unclassified:' + groupKey))
      return {
        ticketId: view.ticketId,
        goal: view.goal,
        acceptance: view.acceptance,
        status: view.status,
        createdAt: view.createdAt,
        updatedAt: view.updatedAt,
        closedAt: view.closedAt,
        waitingOn: view.waitingOn,
        blockedReason: view.blockedReason,
        attention: view.attention,
        dependsOn: view.dependsOn,
        dependentCount: view.dependentCount,
        checklist: view.checklist,
        progress: view.progress,
        executor: view.executor,
        executorTitle: view.executorTitle,
        executorCwd: view.executorCwd,
        executorArchived: view.executorArchived,
        executorMissing: view.executorMissing,
        executorTags: view.executorTags,
        projectKey: view.projectKey,
        archived: view.archived,
        readyAt: view.readyAt,
        queueState: view.queueState,
        queueText: view.queueText,
        laneId: lane.id,
        laneLabel: lane.label,
        primaryTopicId: primaryId,
        projectId: card ? card.projectId : groupKey,
        projectTitle: card ? card.projectTitle : projectForView(view).title,
        topicId: card ? card.topicId : '',
        topicTitle: card ? card.title : '未分类',
        topicBrief: card ? card.brief : '',
        unclassified: card ? Boolean(card.unclassified) : true,
      }
    }).sort((left, right) => (right.updatedAt || 0) - (left.updatedAt || 0))
    return {
      ok: true,
      generatedAt: Date.now(),
      riaSessionId: this.store.riaSessionId || null,
      counts,
      page: {
        limit,
        before,
        returned: tickets.length,
        total: ordered.length,
        hasMore,
        nextBefore,
      },
      lanes: laneList,
      projects,
      tickets,
      searchIndex,
    }
  }
  /**
   * Everything a topic page needs: all linked tickets (including completed and
   * related links), newest first, plus dependency edges. Cross-topic
   * dependencies carry the other topic's title so the UI can point at it.
   */
  async boardTopic(topicId) {
    const raw = String(topicId || '')
    if (!raw) return { ok: false, code: 'topic_missing', message: 'topicId is required' }
    const unclassified = raw.startsWith('unclassified:')
    const topic = unclassified
      ? { topicId: raw, title: '未分类', brief: '', tags: [], unclassified: true, archived: false }
      : this.store.topic(raw)
    if (!topic) return { ok: false, code: 'topic_missing', message: 'topic not found: ' + raw }
    const items = await this.listSessions()
    const sessions = new Map(items.map(item => [String(item.sessionId), item]))
    const archived = this.archivedSessions()
    const byId = new Map()
    for (const record of this.tickets.historyRecords()) {
      const ticket = normalizeTicket(record.ticket)
      if (!ticket.ticketId) continue
      const known = byId.get(ticket.ticketId)
      if (!known || (ticket.closedAt || 0) > (known.closedAt || 0)) byId.set(ticket.ticketId, ticket)
    }
    for (const ticket of this.tickets.tickets()) byId.set(ticket.ticketId, ticket)
    const roleByTicket = new Map()
    if (!unclassified) {
      for (const link of this.store.topicLinks(topic.topicId)) roleByTicket.set(link.ticketId, link.role)
    }
    const chosen = []
    for (const ticket of byId.values()) {
      const primary = this.store.primaryTopicFor(ticket.ticketId)
      const belongs = unclassified ? !primary : roleByTicket.has(ticket.ticketId)
      if (!belongs) continue
      chosen.push(ticket)
    }
    const ids = new Set(chosen.map(ticket => ticket.ticketId))
    const topicLabel = id => {
      const linked = this.store.primaryTopicFor(id)
      const found = linked ? this.store.topic(linked) : undefined
      return found ? { topicId: found.topicId, topicTitle: found.title, topicUnclassified: false } : { topicId: null, topicTitle: '未分类', topicUnclassified: true }
    }
    const view = ticket => {
      const riaId = this.store.riaSessionId || ''
      const executor = ticket.executor || 'self'
      const riaExecutor = executor === 'self' || (riaId && executor === riaId)
      const summary = sessions.get(String(executor))
      const queue = this.tickets.queueInfo(ticket)
      return {
        ticketId: ticket.ticketId,
        goal: ticket.goal,
        status: ticket.status,
        role: roleByTicket.get(ticket.ticketId) || 'primary',
        waitingOn: ticket.waitingOn,
        blockedReason: ticket.blockedReason || '',
        attention: ticket.attention || null,
        dependsOn: Array.isArray(ticket.dependsOn) ? [...ticket.dependsOn] : [],
        checklist: normalizeChecklist(ticket.checklist),
        progress: checklistProgress(ticket.checklist).text,
        executor,
        executorTitle: riaExecutor ? 'Ria' : (sessionTitle(summary) || ''),
        executorArchived: archived.has(String(executor)),
        executorMissing: !summary && !riaExecutor,
        archived: !this.tickets.ticket(ticket.ticketId),
        primaryTopicId: this.store.primaryTopicFor(ticket.ticketId),
        createdAt: ticket.createdAt,
        updatedAt: ticket.updatedAt,
        closedAt: ticket.closedAt || null,
        queueState: queue.queueState,
        queueText: queue.queueText,
      }
    }
    const tickets = chosen
      .sort((left, right) => (right.updatedAt || 0) - (left.updatedAt || 0))
      .map(view)
    const inside = []
    const outside = []
    for (const ticket of tickets) {
      for (const dependency of ticket.dependsOn) {
        if (ids.has(dependency)) {
          inside.push({ from: dependency, to: ticket.ticketId })
          continue
        }
        const other = topicLabel(dependency)
        if (other.topicId === topic.topicId) continue
        outside.push({ ticketId: ticket.ticketId, dependsOn: dependency, ...other })
      }
    }
    const counts = { total: tickets.length, open: 0, working: 0, blocked: 0, done: 0 }
    for (const ticket of tickets) {
      if (ticket.status === 'working') counts.working += 1
      else if (ticket.status === 'blocked') {
        counts.blocked += 1
        counts.open += 1
      } else if (TERMINAL_STATUSES.includes(ticket.status)) counts.done += 1
      else counts.open += 1
    }
    return { ok: true, topic, counts, tickets, edges: { inside, outside } }
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

  /**
   * One compact view of everything Ria needs the user to decide. Legacy
   * blocked tickets without structured attention are included; their
   * blockedReason is the question.
   */
  attentionOverview() {
    const tickets = this.tickets.tickets()
      .filter(ticket => ticket.status === 'blocked' && (ticket.waitingOn === 'user' || ticket.waitingOn === 'approval'))
    const items = tickets.map(ticket => {
      const attention = ticket.attention
      const item = {
        ticketId: ticket.ticketId,
        goal: ticket.goal,
        question: attention ? attention.question : ticket.blockedReason,
        kind: attention ? attention.kind : (ticket.waitingOn === 'approval' ? 'approval' : 'question'),
        legacy: !attention,
      }
      if (attention && Array.isArray(attention.options) && attention.options.length) item.options = [...attention.options]
      if (attention) {
        item.askedAt = attention.askedAt
        item.askedBy = attention.askedBy
        if (attention.ref) item.ref = attention.ref
      }
      return item
    })
    return {
      waitingOnUser: tickets.filter(ticket => ticket.waitingOn === 'user').length,
      waitingOnApproval: tickets.filter(ticket => ticket.waitingOn === 'approval').length,
      total: items.length,
      items,
    }
  }

  /**
   * Pending and failed side effects. ticketId narrows the view to one task so a
   * blocked dispatch can be diagnosed without scanning the whole queue.
   */
  outboxSummary(ticketId) {
    return this.outbox.summary({ ticketId: ticketId ? String(ticketId) : undefined })
  }

  /**
   * Open one reflection run in memory and persist its run.json. The orchestration
   * layer (not built in this phase) owns deadlines and finalisation; the six
   * read-only tools only need a running run and a bound worker session.
   */
  openReflectionRun(input = {}) {
    const next = { ...input }
    if (!Number.isSafeInteger(next.ordinal) || next.ordinal < 1) {
      const forDate = String(next.forDate || reflectionDate(Number.isFinite(next.createdAt) ? next.createdAt : Date.now()))
      next.ordinal = reflectionRunOrdinal(this.stateDir, forDate)
    }
    const run = makeReflectionRun(next, { stateDir: this.stateDir })
    run.status = 'running'
    this.reflections.set(run.runId, run)
    writeReflectionRun(run, this.stateDir)
    return run
  }

  reflectionRunById(runId) {
    const id = String(runId || '')
    if (!id) return undefined
    let run = this.reflections.get(id)
    if (!run) {
      const stored = readReflectionRun(this.stateDir, id)
      if (stored) {
        run = stored
        this.reflections.set(id, run)
      }
    }
    return run
  }

  reflectionRunSummary(run) {
    if (!run) return null
    return {
      runId: run.runId,
      forDate: run.forDate,
      ordinal: run.ordinal || 1,
      title: run.title || reflectionTitle(run.forDate, run.ordinal || 1),
      trigger: run.trigger,
      attempt: run.attempt,
      status: run.status,
      workerSessionId: run.workerSessionId || null,
      reportPath: run.reportFinal,
      partialPath: run.reportPartial,
      deadlineAt: run.deadlineAt || null,
      error: run.error || null,
    }
  }

  async reflectionCandidates(signal) {
    const items = await this.listSessions(signal)
    const ids = []
    for (const item of items) {
      if (!item || item.origin === 'subagent') continue
      const id = String(item.sessionId || '')
      if (id && !ids.includes(id)) ids.push(id)
    }
    return ids
  }

  /**
   * Pick the intake ticket that asked for this reflection. A turn may contain
   * several intakes; only a reflection-shaped or forDate-shaped one is bound.
   * Never fall back to "the only intake": it may belong to unrelated work.
   */
  reflectionIntakeCandidate(forDate) {
    if (!Number.isSafeInteger(this.currentRiaTurn)) return undefined
    const intakes = this.tickets.intakesForTurn(this.currentRiaTurn)
    if (!Array.isArray(intakes) || !intakes.length) return undefined
    const textOf = ticket => [ticket.goal, ticket.origin && ticket.origin.text, ticket.acceptance].filter(Boolean).join(' ')
    const reflectionLike = intakes.filter(ticket => /反思|反省|reflection/i.test(textOf(ticket)))
    if (reflectionLike.length) return reflectionLike[0]
    if (forDate) {
      const dateLike = intakes.filter(ticket => textOf(ticket).includes(forDate))
      if (dateLike.length) return dateLike[0]
    }
    return undefined
  }

  reflectionIntakeMatches(run, intake) {
    const text = [intake.goal, intake.origin && intake.origin.text, intake.acceptance].filter(Boolean).join(' ')
    if (/反思|反省|reflection/i.test(text)) return true
    return Boolean(run && run.forDate && text.includes(run.forDate))
  }

  reflectionStats(run) {
    const current = run && run.stats && typeof run.stats === 'object' ? run.stats : {}
    const number = value => Number.isFinite(value) && value >= 0 ? value : 0
    const stats = {
      compressedBytesRead: number(current.compressedBytesRead),
      decompressedBytesRead: number(current.decompressedBytesRead),
      readCalls: number(current.readCalls),
    }
    if (run && typeof run === 'object') run.stats = stats
    return stats
  }

  /**
   * Answer or block only the intake bound at begin. The binding is durable in
   * run.json, so a later finish cannot mistake another intake in the turn for
   * the reflection's own. Returns null when the run has no captured intake.
   */
  settleReflectionIntake(run, disposition) {
    const ticketId = run && run.intakeTicketId ? String(run.intakeTicketId) : ''
    if (!ticketId) return null
    const warnIntake = message => {
      if (run && run.runId) {
        run.intakeWarning = message
        try {
          writeReflectionRun(run, this.stateDir)
        } catch (error) {
          this.log('warn', 'could not persist reflection intake warning: ' + String(error && error.message ? error.message : error))
        }
      }
      return message
    }
    const intake = this.tickets.ticket(ticketId)
    if (!intake) {
      return { ticketId, status: 'missing', code: 'intake_missing', warning: warnIntake('未关闭工单 ' + ticketId + '：工单已不存在。') }
    }
    if (intake.status !== 'intake') {
      return { ticketId, status: intake.status }
    }
    if (!this.reflectionIntakeMatches(run, intake)) {
      return {
        ticketId,
        status: intake.status,
        code: 'intake_unrelated',
        warning: warnIntake('未关闭工单 ' + ticketId + '：它的目标与本次反思不相关。'),
      }
    }
    const resolved = this.tickets.resolveIntake(ticketId, disposition)
    if (!resolved.ok) {
      this.log('warn', 'could not settle reflection intake ' + ticketId + ': ' + resolved.code)
      return { ticketId, status: 'failed', code: resolved.code, message: resolved.message }
    }
    if (run && run.runId) {
      run.intakeDisposition = disposition.kind
      writeReflectionRun(run, this.stateDir)
    }
    return { ticketId, status: resolved.ticket ? resolved.ticket.status : 'done' }
  }

  reflectionAcceptedIntake(run) {
    return this.settleReflectionIntake(run, {
      kind: 'answered',
      summary: '定期反思已受理，报告完成后另行通知',
    })
  }

  reflectionFailureIntake(run) {
    return this.settleReflectionIntake(run, {
      kind: 'blocked',
      waitingOn: 'user',
      blockedReason: '反思失败：' + String(run && run.error ? run.error : '没有产出报告'),
      attention: {
        kind: 'reflection_failed',
        question: '反思失败了，要现在重试还是明天再说？',
        options: ['现在重试', '明天再说'],
      },
    })
  }

  async endReflectionRun(run, status, error, busy) {
    if (!run) return undefined
    const at = now()
    run.status = status
    run.closedAt = at
    if (error) run.error = String(error)
    if (Array.isArray(run.attempts) && run.attempts.length) {
      const last = run.attempts[run.attempts.length - 1]
      last.outcome = status
      last.endedAt = at
      if (error) last.error = String(error)
      if (busy && busy.running === true) last.workerRunning = true
    }
    writeReflectionRun(run, this.stateDir)
    removeReflectionLock(this.stateDir, run.runId)
    const state = readReflectionState(this.stateDir)
    if (state.activeRunId === run.runId) state.activeRunId = null
    state.lastRunId = run.runId
    state.lastStatus = status
    state.lastAttemptAt = at
    state.lastError = error ? String(error) : null
    writeReflectionState(this.stateDir, state)
    for (const [sessionId, bound] of [...this.reflectionBindings]) {
      if (bound === run.runId) this.unbindReflectionSession(sessionId)
    }
    this.reflectionSeenRefs.delete(run.runId)
    this.reflectionActivity.delete(run.runId)
    await this.closeReflectionWatch(run, status === 'cancelled' || status === 'aborted' ? 'cancelled' : 'failed', {
      reason: error || status,
    })
    return run
  }

  /**
   * Evaluate the active run. A live run stays locked. A run whose 20-minute
   * lock expired while its worker is idle and no report exists is abandoned so
   * the next begin can take over. An expired dispatched run with a still-running
   * worker becomes timed_out; an idle dispatched worker with no report becomes
   * failed. Nothing here starts a retry; begin decides that.
   */
  async reflectionActive(signal = NEVER_ABORTED) {
    const state = readReflectionState(this.stateDir)
    const lock = readReflectionLock(this.stateDir)
    let run
    if (state.activeRunId) run = this.reflectionRunById(state.activeRunId)
    if (!run && lock) run = this.reflectionRunById(lock.runId)
    if (!run) {
      if (lock) {
        const started = Number(lock.startedAt) || 0
        if (started && now() < started + REFLECTION_LOCK_TTL_MS) return { run: null, lock, live: true, busy: { running: false, unknown: true, queued: 0 }, partial: false }
        removeReflectionLock(this.stateDir)
      }
      return { run: null, lock: null, live: false, busy: null, partial: false }
    }
    if (!['starting', 'running'].includes(run.status)) {
      if (lock && lock.runId === run.runId) removeReflectionLock(this.stateDir, run.runId)
      if (state.activeRunId === run.runId) {
        state.activeRunId = null
        writeReflectionState(this.stateDir, state)
      }
      return { run, lock, live: false, busy: null, partial: false }
    }
    const busy = run.workerSessionId
      ? await this.workerBusy(run.workerSessionId, signal)
      : { running: false, unknown: true, queued: 0 }
    const partial = existsSync(run.reportPartial)
    const deadline = Number(run.deadlineAt) || 0
    const at = now()
    const lockStarted = Number(lock && lock.runId === run.runId && lock.startedAt) || Number(run.createdAt) || 0
    if (!busy.running && !partial && lockStarted && at >= lockStarted + REFLECTION_LOCK_TTL_MS) {
      await this.endReflectionRun(run, 'abandoned', '反思运行锁已过期，worker 已空闲且没有产出报告', busy)
      return { run, lock, live: false, busy, partial, ended: 'abandoned' }
    }
    if (run.dispatchedAt && deadline > 0 && at >= deadline) {
      if (busy.running) {
        await this.endReflectionRun(run, 'timed_out', '反思 worker 超过 15 分钟仍在运行', busy)
        return { run, lock, live: false, busy, partial, ended: 'timed_out' }
      }
      if (partial) return { run, lock, live: true, busy, partial }
      if (busy.unknown) {
        const started = Number(lock && lock.startedAt) || 0
        if (!started || at < started + REFLECTION_LOCK_TTL_MS) return { run, lock, live: true, busy, partial }
      }
      await this.endReflectionRun(run, 'failed', '反思 worker 在截止时间前没有产出报告', busy)
      return { run, lock, live: false, busy, partial, ended: 'failed' }
    }
    return { run, lock, live: true, busy, partial }
  }

  reflectionSettingsView() {
    return {
      ...this.store.reflectionSettings(),
      implemented: true,
      scheduleAvailable: Boolean(this.schedule),
    }
  }

  /** Chat durable memory text, sourced from cognition/chat/ only. */
  chatMemoryText() {
    const cognition = this.v2 && this.v2.cognition
    if (!cognition) return ''
    const parts = []
    for (const name of ['chat/preferences.md', 'chat/agreements.md', 'chat/decisions.md']) {
      try {
        const content = cognition.readIfExists(name).trim()
        if (content) parts.push(content)
      } catch { /* a missing/unreadable file is just absent memory */ }
    }
    return parts.join('\n\n')
  }

  settingsPayload() {
    const settings = this.store.settings()
    settings.style = { ...settings.style, effectiveText: voicePrompt(settings.style) }
    settings.reflectionStatus = this.reflectionStatusSummary()
    settings.memoryStatus = memoryStatusView(this.chatMemoryText(), settings.memory)
    return settings
  }

  reflectionScheduleView() {
    const state = readReflectionState(this.stateDir)
    return {
      id: state.scheduleId || null,
      available: Boolean(this.schedule),
      error: this.reflectionScheduleError || null,
    }
  }

  reflectionStatusSummary() {
    const state = readReflectionState(this.stateDir)
    const lock = readReflectionLock(this.stateDir)
    const runId = state.activeRunId || (lock && lock.runId) || null
    const run = runId ? this.reflectionRunById(runId) : null
    return {
      lastCompletedDate: state.lastCompletedDate || null,
      lastStatus: state.lastStatus || null,
      lastError: state.lastError || null,
      activeRunId: runId,
      workerSessionId: run && run.workerSessionId ? run.workerSessionId : (lock && lock.runId === runId ? lock.workerSessionId || null : null),
      scheduleId: state.scheduleId || null,
      enabled: this.store.reflectionSettings().enabled,
      scheduleAvailable: Boolean(this.schedule),
      scheduleError: this.reflectionScheduleError || null,
    }
  }

  async reflectionScheduleItems() {
    if (!this.schedule) return []
    const page = await this.schedule.list({ limit: 500 })
    if (!page || !Array.isArray(page.items)) throw new Error('schedule list returned no items')
    return page.items
  }

  async ensureReflectionSchedule(reason = 'settings') {
    const settings = this.store.reflectionSettings()
    if (!settings.enabled) return { ok: true, disabled: true }
    if (!this.schedule) {
      this.reflectionScheduleError = '宿主没有 schedule 服务，无法创建自动反思计划；设置已保存。'
      return { ok: false, code: 'schedule_unavailable', message: this.reflectionScheduleError }
    }
    try {
      const info = await this.ensure()
      const sessionId = info.sessionId
      const rrule = reflectionRrule(settings, now())
      const timing = { kind: 'rrule', rrule }
      const target = { kind: 'session', sessionId }
      const items = await this.reflectionScheduleItems()
      const mine = items.filter(item => item && item.title === REFLECTION_SCHEDULE_TITLE)
      const state = readReflectionState(this.stateDir)
      let chosen = state.scheduleId ? mine.find(item => item.id === state.scheduleId) : undefined
      if (!chosen && mine.length) chosen = mine[0]
      for (const item of mine) {
        if (chosen && item.id === chosen.id) continue
        try {
          await this.schedule.edit({ id: item.id, action: 'delete' })
        } catch (error) {
          this.log('warn', 'could not delete a duplicate reflection schedule: ' + String(error && error.message ? error.message : error))
        }
      }
      let entry
      if (chosen) {
        entry = await this.schedule.edit({
          id: chosen.id,
          action: 'update',
          patch: {
            title: REFLECTION_SCHEDULE_TITLE,
            prompt: REFLECTION_SCHEDULE_PROMPT,
            timing,
            target,
            active: true,
          },
        })
      } else {
        entry = await this.schedule.create({
          title: REFLECTION_SCHEDULE_TITLE,
          prompt: REFLECTION_SCHEDULE_PROMPT,
          timing,
          target,
        })
      }
      if (entry && entry.code) throw new Error(entry.code)
      const scheduleId = entry && entry.id ? entry.id : (chosen && chosen.id)
      if (!scheduleId) throw new Error('schedule service returned no id')
      if (state.scheduleId !== scheduleId) {
        // Re-read before writing: a reflection may finish while we edit the
        // schedule, and the stale copy would roll back lastCompletedDate.
        const latest = readReflectionState(this.stateDir)
        if (latest.scheduleId !== scheduleId) {
          latest.scheduleId = scheduleId
          writeReflectionState(this.stateDir, latest)
        }
      }
      this.reflectionScheduleError = null
      this.log('info', 'reflection schedule ' + (chosen ? 'updated' : 'created') + ' (' + reason + '): ' + scheduleId)
      return { ok: true, scheduleId, created: !chosen }
    } catch (error) {
      this.reflectionScheduleError = '无法维护自动反思计划：' + String(error && error.message ? error.message : error)
      this.log('warn', this.reflectionScheduleError)
      return { ok: false, code: 'schedule_failed', message: this.reflectionScheduleError }
    }
  }

  async disableReflectionSchedule() {
    const state = readReflectionState(this.stateDir)
    if (!state.scheduleId) {
      this.reflectionScheduleError = null
      return { ok: true, disabled: true }
    }
    if (!this.schedule) {
      this.reflectionScheduleError = '宿主没有 schedule 服务，无法暂停自动反思计划。'
      return { ok: false, code: 'schedule_unavailable', message: this.reflectionScheduleError }
    }
    try {
      const entry = await this.schedule.edit({ id: state.scheduleId, action: 'update', patch: { active: false } })
      if (entry && entry.code === 'schedule_not_found') {
        const latest = readReflectionState(this.stateDir)
        latest.scheduleId = null
        writeReflectionState(this.stateDir, latest)
        this.reflectionScheduleError = null
        return { ok: true, missing: true }
      }
      if (entry && entry.code) throw new Error(entry.code)
      this.reflectionScheduleError = null
      return { ok: true, scheduleId: state.scheduleId }
    } catch (error) {
      this.reflectionScheduleError = '无法暂停自动反思计划：' + String(error && error.message ? error.message : error)
      this.log('warn', this.reflectionScheduleError)
      return { ok: false, code: 'schedule_failed', message: this.reflectionScheduleError }
    }
  }

  /**
   * Save reflection settings and make the schedule follow them. A host schedule
   * failure rolls enabled back to false; a missing schedule service keeps the
   * settings and reports why the schedule could not be maintained.
   */
  async applyReflectionSettings(patch) {
    const previous = this.store.reflectionSettings()
    const next = normalizeReflectionSettings({ ...previous, ...(patch || {}) })
    this.store.setSettings({ reflection: next })
    let warning
    if (next.enabled) {
      const result = await this.ensureReflectionSchedule('settings')
      if (!result.ok) {
        if (result.code === 'schedule_unavailable') {
          warning = result.message
        } else {
          this.store.setSettings({ reflection: { ...next, enabled: false } })
          return { ok: false, error: result.message, settings: this.settingsPayload() }
        }
      }
    } else {
      const result = await this.disableReflectionSchedule()
      if (!result.ok) warning = result.message
    }
    return { ok: true, settings: this.settingsPayload(), ...(warning ? { warning } : {}) }
  }

  /**
   * Startup catch-up: a missed current/last cadence occurrence gets one reminder.
   * The state marker is written only after the reminder exists, so a crash before
   * that point retries on the next start instead of silently losing the catch-up.
   */
  async reflectionStartupCheck() {
    const settings = this.store.reflectionSettings()
    const state = readReflectionState(this.stateDir)
    if (!settings.enabled) {
      if (state.scheduleId && this.schedule) await this.disableReflectionSchedule()
      return
    }
    if (this.schedule) {
      const ensured = await this.ensureReflectionSchedule('startup')
      if (!ensured.ok && ensured.code !== 'schedule_unavailable') this.log('warn', ensured.message)
    }
    let active
    try {
      active = await this.reflectionActive(NEVER_ABORTED)
    } catch (error) {
      this.log('warn', 'could not inspect the reflection run at startup: ' + String(error && error.message ? error.message : error))
      return
    }
    if (active.live) return
    const occurrence = previousReflectionOccurrence(settings, now())
    if (!Number.isFinite(occurrence)) return
    const forDate = reflectionDate(occurrence)
    if (state.lastCompletedDate && state.lastCompletedDate >= forDate) return
    if (state.lastReminderForDate === forDate) return
    const prompt = REFLECTION_CATCHUP_PROMPT(forDate)
    const info = await this.ensure()
    if (this.schedule) {
      const title = REFLECTION_CATCHUP_TITLE_PREFIX + forDate
      const items = await this.reflectionScheduleItems()
      const existing = items.find(item => item && item.title === title)
      if (!existing) {
        await this.schedule.create({
          title,
          prompt,
          timing: { kind: 'after', after_seconds: 90 },
          target: { kind: 'session', sessionId: info.sessionId },
        })
      }
      this.log('info', 'reflection catch-up scheduled for ' + forDate)
    } else {
      await this.ctx.sessionController.prompt({
        requestId: newId(HOST_REQUEST_PREFIX),
        sessionId: info.sessionId,
        mode: 'queue',
        content: [{ type: 'text', text: prompt }],
      }, NEVER_ABORTED)
      this.log('info', 'reflection catch-up queued for ' + forDate)
    }
    // Re-read the state: ensureReflectionSchedule above may have written the
    // scheduleId, and writing this stale copy would erase it.
    const latest = readReflectionState(this.stateDir)
    latest.lastReminderForDate = forDate
    latest.lastReminderAt = now()
    writeReflectionState(this.stateDir, latest)
  }

  async toolReflectStatus(signal) {
    const active = await this.reflectionActive(signal)
    const state = readReflectionState(this.stateDir)
    let run = active && active.run ? active.run : null
    if (!run && state.lastRunId) run = this.reflectionRunById(state.lastRunId)
    return {
      ok: true,
      state,
      run: this.reflectionRunSummary(run),
      lock: active && active.lock ? active.lock : null,
      schedule: this.reflectionScheduleView(),
      settings: this.reflectionSettingsView(),
    }
  }

  async toolReflectBegin(args, signal) {
    const at = now()
    const forDate = asString(args.forDate) || reflectionDate(at)
    if (!isReflectionDate(forDate)) return this.reflectionInvalid('forDate must be YYYY-MM-DD')
    const trigger = asString(args.trigger) || 'manual'
    if (!['manual', 'schedule'].includes(trigger)) return this.reflectionInvalid('trigger must be manual or schedule')
    const force = args.force === true
    const intakeCandidate = this.reflectionIntakeCandidate(forDate)
    const intakeShell = { forDate, intakeTicketId: intakeCandidate ? intakeCandidate.ticketId : null }
    let state = readReflectionState(this.stateDir)

    if (!force && state.lastCompletedDate && state.lastCompletedDate >= forDate) {
      const intake = this.reflectionAcceptedIntake(intakeShell)
      return {
        ok: true,
        locked: false,
        skipped: 'completed',
        forDate,
        runId: state.lastRunId,
        lastCompletedDate: state.lastCompletedDate,
        intake,
      }
    }

    const active = await this.reflectionActive(signal)
    if (active.live) {
      const intake = this.reflectionAcceptedIntake(active.run || intakeShell)
      return {
        ok: true,
        locked: true,
        forDate,
        runId: active.run ? active.run.runId : (active.lock && active.lock.runId) || null,
        activeRun: this.reflectionRunSummary(active.run),
        intake,
      }
    }

    state = readReflectionState(this.stateDir)
    const blockedStatus = ['failed', 'timed_out', 'cancelled', 'partial'].includes(state.lastStatus)
    if (!force && blockedStatus) {
      const previous = state.lastRunId ? this.reflectionRunById(state.lastRunId) : null
      const sameDate = previous ? previous.forDate === forDate : true
      const attempts = previous && Array.isArray(previous.attempts) ? previous.attempts.length : 2
      if (sameDate && (state.lastStatus !== 'failed' || attempts >= 2)) {
        const intake = this.reflectionAcceptedIntake(intakeShell)
        return {
          ok: true,
          locked: false,
          skipped: state.lastStatus,
          forDate,
          runId: state.lastRunId,
          lastCompletedDate: state.lastCompletedDate,
          intake,
        }
      }
    }

    let attempt = 1
    let previous = null
    if (!force && state.lastStatus === 'failed' && state.lastRunId) {
      const candidate = this.reflectionRunById(state.lastRunId)
      const priorAttempts = candidate && Array.isArray(candidate.attempts) ? candidate.attempts.length : 0
      if (candidate && candidate.forDate === forDate && priorAttempts < 2) {
        previous = candidate
        attempt = Number(candidate.attempt || 1) + 1
      }
    }

    const window = reflectionWindow(forDate, forDate === reflectionDate(at) ? at : undefined)
    const candidates = await this.reflectionCandidates(signal)
    const ordinal = reflectionRunOrdinal(this.stateDir, forDate)
    const run = makeReflectionRun({
      forDate,
      ordinal,
      trigger,
      attempt,
      windowStart: window.start,
      windowEnd: window.end,
      createdAt: at,
      candidates,
      attempts: previous && Array.isArray(previous.attempts) ? previous.attempts : [],
      intakeTicketId: intakeCandidate ? intakeCandidate.ticketId : null,
      status: 'starting',
    }, { stateDir: this.stateDir, now: () => at })
    if (force && existsSync(run.reportFinal)) run.reportFinal = reflectionManualPath(this.stateDir, forDate, at)
    run.attempts.push({ attempt, runId: run.runId, startedAt: at, workerSessionId: null, outcome: null })
    const acquired = acquireReflectionLock(this.stateDir, run)
    if (!acquired.ok) {
      const intake = this.reflectionAcceptedIntake(intakeShell)
      return {
        ok: true,
        locked: true,
        forDate,
        runId: acquired.lock ? acquired.lock.runId : null,
        activeRun: acquired.lock || null,
        intake,
      }
    }
    this.reflections.set(run.runId, run)
    try {
      writeReflectionRun(run, this.stateDir)
      state = readReflectionState(this.stateDir)
      state.activeRunId = run.runId
      state.lastRunId = run.runId
      state.lastStatus = 'starting'
      state.lastAttemptAt = at
      state.lastError = null
      writeReflectionState(this.stateDir, state)
    } catch (error) {
      removeReflectionLock(this.stateDir, run.runId)
      this.reflections.delete(run.runId)
      this.reflectionActivity.delete(run.runId)
      throw error
    }
    const intake = this.reflectionAcceptedIntake(run)
    const spawn = {
      title: run.title,
      cwd: this.stateDir,
      agentPreset: 'minimal',
      reflectionRunId: run.runId,
    }
    const reflection = this.store.reflectionSettings()
    for (const key of ['model', 'provider', 'reasoningEffort']) {
      // The saved reflection settings override whatever model Ria would
      // otherwise inherit for this run.
      const value = asString(reflection[key]) || asString(args[key])
      if (value) spawn[key] = value
    }
    return {
      ok: true,
      locked: false,
      runId: run.runId,
      forDate,
      ordinal: run.ordinal,
      title: run.title,
      window: { from: new Date(run.windowStart).toISOString(), to: new Date(run.windowEnd).toISOString() },
      reportPath: run.reportFinal,
      plannedReportPath: run.reportFinal,
      instruction: reflectionInstruction(run),
      spawn,
      attempt: run.attempt,
      intake,
    }
  }

  /**
   * The monitoring topic is fixed so every reflection watch ticket lands in
   * the same place. Create it on demand (the live state already has it), and
   * degrade to no watch ticket if it cannot be used.
   */
  ensureReflectionWatchTopic() {
    const existing = this.store.topic(REFLECTION_WATCH_TOPIC_ID)
    if (existing) {
      if (existing.archivedAt || existing.mergedInto) return undefined
      return existing.topicId
    }
    try {
      const topic = this.store.addTopic({ topicId: REFLECTION_WATCH_TOPIC_ID, title: '记忆与反思' })
      return topic.topicId
    } catch (error) {
      this.log('warn', 'could not create the reflection watch topic: ' + String(error && error.message ? error.message : error))
      return undefined
    }
  }

  /**
   * Give every dispatched reflection a durable monitoring ticket. The ticket
   * is the host-side record that the run is still being watched; finish closes
   * it with the report path, abort cancels it, and a failed run blocks it so
   * the board shows why the report never arrived.
   */
  ensureReflectionWatch(run) {
    if (!run || !run.runId) return undefined
    const existingId = asString(run.watchTicketId)
    if (existingId) {
      const existing = this.tickets.ticket(existingId)
      if (existing) return existing
    }
    const workerSessionId = asString(run.workerSessionId)
    if (!workerSessionId) {
      this.log('warn', 'reflection ' + run.runId + ' has no worker session; no watch ticket created')
      return undefined
    }
    const topicId = this.ensureReflectionWatchTopic()
    try {
      const ticket = this.tickets.addTicket({
        goal: '反思 ' + run.forDate + ' 运行监控',
        acceptance: '反思报告完成并写入最终报告',
        executor: workerSessionId,
        status: 'working',
        topicId,
        origin: {
          kind: 'reflection-watch',
          text: '反思 ' + run.forDate + ' 运行监控（' + run.runId + '）',
          sessionId: workerSessionId,
        },
      })
      run.watchTicketId = ticket.ticketId
      run.watchCreatedAt = ticket.createdAt
      writeReflectionRun(run, this.stateDir)
      return ticket
    } catch (error) {
      this.log('warn', 'could not create the reflection watch ticket for ' + run.runId + ': ' + String(error && error.message ? error.message : error))
      return undefined
    }
  }

  async closeReflectionWatch(run, outcome, detail = {}) {
    const ticketId = asString(run && run.watchTicketId)
    if (!ticketId) return undefined
    const ticket = this.tickets.ticket(ticketId)
    if (!ticket || isTerminal(ticket.status)) return ticket
    const at = now()
    let to
    let options
    if (outcome === 'done') {
      to = 'done'
      options = {
        actor: 'system',
        reason: 'reflection report finished',
        resolution: {
          kind: 'reflection',
          summary: '反思 ' + run.forDate + ' 已完成',
          reportPath: detail.reportPath || run.reportFinal || '',
          bytes: Number.isFinite(detail.bytes) ? detail.bytes : 0,
          status: run.status,
          runId: run.runId,
          warnings: Array.isArray(detail.warnings) ? detail.warnings.slice() : [],
        },
      }
    } else if (outcome === 'cancelled') {
      to = 'cancelled'
      options = {
        actor: 'system',
        reason: 'reflection cancelled',
        resolution: {
          kind: 'reflection_cancelled',
          reason: detail.reason || run.error || '反思已取消',
          status: run.status,
          runId: run.runId,
        },
      }
    } else {
      to = 'blocked'
      const reason = detail.reason || run.error || '反思失败'
      options = {
        actor: 'system',
        reason: 'reflection failed',
        waitingOn: 'user',
        blockedReason: '反思运行监控：' + reason,
        resolution: { kind: 'reflection_failed', reason, status: run.status, runId: run.runId },
        failure: { code: 'reflection_failed', message: reason, at },
      }
    }
    const moved = this.tickets.transitionTicket(ticketId, to, options)
    if (!moved.ok) {
      this.log('warn', 'could not close reflection watch ticket ' + ticketId + ': ' + moved.code + ' ' + moved.message)
      return undefined
    }
    run.watchClosedAt = at
    try {
      writeReflectionRun(run, this.stateDir)
    } catch (error) {
      this.log('warn', 'could not persist the reflection watch state: ' + String(error && error.message ? error.message : error))
    }
    try {
      await this.grants.onTicketChanged(moved.ticket)
    } catch (error) {
      this.log('warn', 'could not update grants for the reflection watch ticket: ' + String(error && error.message ? error.message : error))
    }
    return moved.ticket
  }

  async toolReflectDispatch(args, signal) {
    const runId = asString(args.runId)
    const sessionId = asString(args.sessionId)
    if (!runId) return this.reflectionInvalid('runId is required')
    if (!sessionId) return this.reflectionInvalid('sessionId is required')
    const run = this.reflectionRunById(runId)
    if (!run) return { ok: false, code: 'run_missing', message: '反思运行不存在：' + runId }
    if (run.status !== 'starting') return { ok: false, code: 'run_not_starting', message: '反思运行 ' + runId + ' 当前是 ' + run.status + '，只有 starting 可以 dispatch。' }
    if (this.reflectionBindings.get(sessionId) !== run.runId) {
      return { ok: false, code: 'session_not_bound', message: '会话 ' + sessionId + ' 不是这次反思运行绑定的 worker。' }
    }
    const at = now()
    run.status = 'running'
    run.workerSessionId = sessionId
    run.dispatchedAt = at
    run.deadlineAt = at + 15 * 60 * 1000
    if (Array.isArray(run.attempts) && run.attempts.length) {
      const last = run.attempts[run.attempts.length - 1]
      last.workerSessionId = sessionId
      last.dispatchedAt = at
    }
    writeReflectionRun(run, this.stateDir)
    const lock = readReflectionLock(this.stateDir)
    if (lock && lock.runId === run.runId) {
      lock.workerSessionId = sessionId
      lock.deadlineAt = run.deadlineAt
      writeReflectionLock(this.stateDir, lock)
    }
    this.ensureReflectionWatch(run)
    try {
      await this.ctx.sessionController.prompt({
        requestId: newId('refl_'),
        sessionId,
        mode: 'queue',
        content: [{ type: 'text', text: reflectionInstruction(run) }],
      }, signal)
    } catch (error) {
      const message = String(error && error.message ? error.message : error)
      await this.endReflectionRun(run, 'failed', 'dispatch failed: ' + message)
      const intake = this.reflectionFailureIntake(run)
      return { ok: false, code: 'dispatch_failed', message, error: message, runId, attempts: run.attempts, intake }
    }
    const state = readReflectionState(this.stateDir)
    state.activeRunId = run.runId
    state.lastRunId = run.runId
    state.lastStatus = 'running'
    state.lastAttemptAt = at
    state.lastError = null
    writeReflectionState(this.stateDir, state)
    return { ok: true, runId, sessionId, dispatchedAt: at, deadlineAt: run.deadlineAt }
  }

  async toolReflectFinish(args, signal) {
    const runId = asString(args.runId)
    if (!runId) return this.reflectionInvalid('runId is required')
    const status = asString(args.status)
    if (!['complete', 'partial'].includes(status)) return this.reflectionInvalid('status must be complete or partial')
    const run = this.reflectionRunById(runId)
    if (!run) return { ok: false, code: 'run_missing', message: '反思运行不存在：' + runId }
    if (run.status !== 'running') return { ok: false, code: 'run_not_running', message: '反思运行 ' + runId + ' 当前是 ' + run.status + '，不能 finish。' }
    let markdown
    try {
      markdown = readFileSync(run.reportPartial, 'utf8')
    } catch (error) {
      const message = '没有找到反思草稿：' + run.reportPartial
      await this.endReflectionRun(run, 'failed', message)
      const intake = this.reflectionFailureIntake(run)
      return { ok: false, code: 'report_missing', message, error: message, runId, attempts: run.attempts, intake }
    }
    const checked = validateReflectionReport({ run, markdown, status })
    if (!checked.ok) {
      await this.endReflectionRun(run, 'failed', checked.message)
      const intake = this.reflectionFailureIntake(run)
      return { ok: false, code: checked.code, message: checked.message, error: checked.message, runId, attempts: run.attempts, intake }
    }
    const warnings = checked.warnings ? checked.warnings.slice() : []
    if (warnings.length) {
      run.warnings = warnings.slice()
      for (const warning of warnings) this.log('warn', 'reflection ' + run.runId + ': ' + warning)
    } else {
      delete run.warnings
    }
    const at = now()
    // Cost fields belong to the host. Overwrite whatever the model wrote.
    const stats = this.reflectionStats(run)
    const startedAt = Number.isFinite(run.dispatchedAt) ? run.dispatchedAt : run.createdAt
    stats.durationMs = Math.max(0, at - (Number.isFinite(startedAt) ? startedAt : at))
    markdown = applyReflectionReportStats(markdown, stats)
    let final = reflectionReportPath(run, status)
    if (existsSync(final)) final = reflectionManualPath(this.stateDir, run.forDate, at)
    const written = writeReflectionFinalReport(markdown, final)
    run.status = status === 'complete' ? 'completed' : 'partial'
    run.reportFinal = final
    run.closedAt = at
    run.error = null
    if (Array.isArray(run.attempts) && run.attempts.length) {
      const last = run.attempts[run.attempts.length - 1]
      last.outcome = status
      last.endedAt = at
      last.reportPath = final
    }
    writeReflectionRun(run, this.stateDir)
    removeReflectionLock(this.stateDir, run.runId)
    const state = readReflectionState(this.stateDir)
    if (state.activeRunId === run.runId) state.activeRunId = null
    state.lastRunId = run.runId
    state.lastStatus = run.status
    state.lastAttemptAt = at
    state.lastError = null
    if (status === 'complete') {
      if (!state.lastCompletedDate || run.forDate > state.lastCompletedDate) state.lastCompletedDate = run.forDate
    } else if (!state.lastPartialDate || run.forDate > state.lastPartialDate) {
      state.lastPartialDate = run.forDate
    }
    writeReflectionState(this.stateDir, state)
    for (const [sessionId, bound] of [...this.reflectionBindings]) {
      if (bound === run.runId) this.unbindReflectionSession(sessionId)
    }
    this.reflectionSeenRefs.delete(run.runId)
    this.reflectionActivity.delete(run.runId)
    await this.closeReflectionWatch(run, 'done', { reportPath: written.path, bytes: written.bytes, warnings })
    const intake = this.settleReflectionIntake(run, {
      kind: 'answered',
      summary: '定期反思完成，报告：' + final,
    })
    if (intake && intake.warning && !warnings.includes(intake.warning)) {
      warnings.push(intake.warning)
      run.warnings = warnings.slice()
      try {
        writeReflectionRun(run, this.stateDir)
      } catch (error) {
        this.log('warn', 'could not persist reflection warning: ' + String(error && error.message ? error.message : error))
      }
    }
    return { ok: true, runId, reportPath: written.path, bytes: written.bytes, lastCompletedDate: state.lastCompletedDate, warnings, intake }
  }

  async toolReflectAbort(args) {
    const runId = asString(args.runId)
    if (!runId) return this.reflectionInvalid('runId is required')
    const run = this.reflectionRunById(runId)
    if (!run) return { ok: false, code: 'run_missing', message: '反思运行不存在：' + runId }
    if (!['starting', 'running'].includes(run.status)) {
      return { ok: false, code: 'run_closed', message: '反思运行 ' + runId + ' 已经结束。' }
    }
    const reason = asString(args.reason) || 'aborted by Ria'
    const status = args.cancelled === true ? 'cancelled' : 'aborted'
    await this.endReflectionRun(run, status, reason)
    const intake = this.settleReflectionIntake(run, { kind: 'answered', summary: '定期反思已取消：' + reason })
    return { ok: true, runId, status, reason, intake }
  }

  toolReflectValidate(args) {
    const runId = asString(args.runId)
    if (!runId) return this.reflectionInvalid('runId is required')
    const run = this.reflectionRunById(runId)
    if (!run) return { ok: false, code: 'run_missing', message: '反思运行不存在：' + runId }
    if (run.status !== 'running') return { ok: false, code: 'run_not_running', message: '反思运行 ' + runId + ' 当前是 ' + run.status + '，不能 validate。' }
    const status = asString(args.status)
    if (!['complete', 'partial'].includes(status)) return this.reflectionInvalid('status must be complete or partial')
    const markdown = asString(args.markdown)
    if (!markdown.trim()) return this.reflectionInvalid('markdown is required')
    return validateReflectionReport({ run, markdown, status })
  }

  async toolReflect(args, exec) {
    const signal = exec && exec.signal ? exec.signal : NEVER_ABORTED
    const action = asString(args.action)
    if (action === 'status') return this.toolReflectStatus(signal)
    if (action === 'begin') return this.toolReflectBegin(args, signal)
    if (action === 'dispatch') return this.toolReflectDispatch(args, signal)
    if (action === 'finish') return this.toolReflectFinish(args, signal)
    if (action === 'validate') return this.toolReflectValidate(args)
    if (action === 'abort') return this.toolReflectAbort(args)
    return this.reflectionInvalid('action must be status, begin, dispatch, finish, validate or abort')
  }

  reflectionRunFor(sessionId, runId) {
    const run = this.reflections.get(String(runId))
    if (!run || run.status !== 'running') return undefined
    if (this.reflectionBindings.get(String(sessionId)) !== run.runId) return undefined
    return run
  }

  bindReflectionSession(sessionId, runId) {
    const run = this.reflections.get(String(runId))
    if (!run || run.status !== 'running') return false
    this.reflectionBindings.set(String(sessionId), run.runId)
    if (!run.candidates.includes(String(sessionId))) run.candidates.push(String(sessionId))
    writeReflectionRun(run, this.stateDir)
    return true
  }

  unbindReflectionSession(sessionId) {
    const id = String(sessionId)
    const runId = this.reflectionBindings.get(id)
    if (!runId) return
    this.reflectionBindings.delete(id)
    const disposers = this.reflectionDisposers.get(id)
    this.reflectionDisposers.delete(id)
    if (Array.isArray(disposers)) {
      for (const dispose of disposers) {
        try { dispose() } catch (error) {
          this.log('warn', 'could not dispose reflection tools for ' + id + ': ' + String(error && error.message ? error.message : error))
        }
      }
    }
  }

  /** Finish or abort a run: persist the terminal state, then remove the tools. */
  closeReflectionRun(runId, status = 'completed', error) {
    const run = this.reflections.get(String(runId))
    if (!run) return undefined
    run.status = status
    run.closedAt = now()
    if (error) run.error = String(error)
    writeReflectionRun(run, this.stateDir)
    for (const [sessionId, bound] of [...this.reflectionBindings]) {
      if (bound === run.runId) this.unbindReflectionSession(sessionId)
    }
    this.reflectionSeenRefs.delete(run.runId)
    this.reflectionActivity.delete(run.runId)
    return run
  }

  reflectionSeenFor(runId, sessionId) {
    let bySession = this.reflectionSeenRefs.get(runId)
    if (!bySession) {
      bySession = new Map()
      this.reflectionSeenRefs.set(runId, bySession)
    }
    let seen = bySession.get(sessionId)
    if (!seen) {
      seen = new Set()
      bySession.set(sessionId, seen)
    }
    return seen
  }

  reflectionToolResult(value) {
    const result = value && typeof value === 'object' ? value : { ok: false, code: 'tool_failed', message: 'reflection tool returned no result' }
    return losslessToolValue(result)
  }

  reflectionInvalid(message) {
    return { ok: false, code: 'invalid_argument', message, error: message }
  }

  reflectionClosed() {
    const message = '反思运行已结束，读取工具不再可用。'
    return { ok: false, code: 'run_closed', message, error: message }
  }

  /**
   * load events without resuming a cold session. Live snapshots are fullest;
   * sessionController.events is the normal cold path. The raw archive is a
   * fallback for a window older than the host's page, and is never rewritten.
   */
  async reflectionSessionEvents(sessionId, run, signal, options = {}) {
    let records = []
    let source = 'events'
    try {
      const resolved = await this.ctx.sessionController.resolveAgent(sessionId)
      if (!('error' in resolved)) {
        const events = resolved.agent.session.snapshotEvents()
        records = Array.isArray(events) ? events : []
        source = 'live'
      }
    } catch {
      // A cold session is expected; continue with events().
    }
    if (!records.length) {
      try {
        const page = await this.ctx.sessionController.events({ address: { kind: 'session', sessionId }, maxMessages: 5000 }, signal)
        records = Array.isArray(page && page.records) ? page.records : []
        source = 'events'
      } catch (error) {
        this.log('warn', 'reflection could not page events for ' + sessionId + ': ' + String(error && error.message ? error.message : error))
      }
    }
    let events = normalizeEvents(records)
    let corruptFrames = 0
    let compressedBytes = 0
    let decompressedBytes = 0
    const archive = () => {
      const read = readArchiveSession(sessionId)
      compressedBytes = read.compressedBytes || 0
      decompressedBytes = read.decompressedBytes || 0
      if (read.events.length) {
        events = read.events
        corruptFrames = read.corruptFrames
        source = 'archive'
      }
    }
    if (!events.length) archive()
    // The host's event page may start after the reflection window. If the
    // earliest page event is later than the window start, the raw log is the
    // only way to see the beginning of the day.
    if (source !== 'archive' && events.length && Number.isFinite(run.windowStart)) {
      const times = events.map(event => event.time || event.at || (event.data && event.data.time)).filter(Number.isFinite)
      const earliest = times.length ? Math.min(...times) : undefined
      if (earliest !== undefined && earliest > run.windowStart) {
        // Activity checks already know a page event is in the window. Only a
        // page that starts after the window needs the archive fallback.
        const windowHit = options.windowOnly && events.some(event => {
          const at = eventTime(event)
          return Number.isFinite(at) && at >= run.windowStart && at < run.windowEnd
        })
        if (!windowHit) archive()
      }
    }
    if (source !== 'archive') decompressedBytes = events.length ? Buffer.byteLength(JSON.stringify(events)) : 0
    return { events, source, corruptFrames, compressedBytes, decompressedBytes }
  }

  reflectionTicketIds(executor) {
    return this.tickets.tickets()
      .filter(ticket => ticket.executor === executor)
      .sort((a, b) => (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0))
      .slice(0, 20)
      .map(ticket => ticket.ticketId)
  }

  reflectionActivityFor(run) {
    let cache = this.reflectionActivity.get(run.runId)
    if (!cache) {
      cache = new Map()
      this.reflectionActivity.set(run.runId, cache)
    }
    return cache
  }

  async reflectionSessionActive(run, sessionId, running = false) {
    const cache = this.reflectionActivityFor(run)
    const key = String(sessionId)
    if (cache.has(key)) return cache.get(key)
    let active = false
    try {
      // A persisted log is only appended to. If its mtime is older than the
      // window start, it cannot contain a window event, so skip decompression.
      // Running sessions may have unflushed events; always inspect them.
      if (!running && Number.isFinite(run.windowStart)) {
        const info = sessionArchiveInfo(key)
        if (Number.isFinite(info.mtimeMs) && info.mtimeMs < run.windowStart) {
          cache.set(key, false)
          return false
        }
      }
      const loaded = await this.reflectionSessionEvents(key, run, undefined, { windowOnly: true })
      active = loaded.events.some(event => {
        const at = eventTime(event)
        return Number.isFinite(at) && at >= run.windowStart && at < run.windowEnd
      })
    } catch (error) {
      this.log('warn', 'reflection could not inspect ' + key + ': ' + String(error && error.message ? error.message : error))
    }
    cache.set(key, active)
    return active
  }

  async reflectionSessions(run, scope, limit) {
    const items = await this.listSessions()
    const byId = new Map(items.map(item => [String(item.sessionId), item]))
    const view = sessionId => {
      const summary = byId.get(String(sessionId))
      const used = this.store.recentWorker(sessionId)
      const item = {
        sessionId: String(sessionId),
        title: sessionTitle(summary),
        running: Boolean(summary && summary.running),
        blank: Boolean(summary && summary.blank),
        ticketIds: this.reflectionTicketIds(String(sessionId)),
      }
      if (used && used.lastUsedAt) item.lastUsedAt = used.lastUsedAt
      return item
    }
    const cap = Math.max(1, Math.min(50, Number.isSafeInteger(limit) ? limit : 50))
    if (scope === 'recent') {
      const cutoff = now() - RECENT_WORKER_WINDOW_MS
      const records = Object.entries(this.store.recentWorkers())
        .filter(([sessionId, record]) => record && record.lastUsedAt >= cutoff && byId.has(sessionId))
        .sort((a, b) => b[1].lastUsedAt - a[1].lastUsedAt)
      const selected = records.slice(0, Math.min(20, cap))
      return {
        scope: 'recent',
        sessions: selected.map(([sessionId]) => view(sessionId)),
        total: records.length,
        truncated: records.length > selected.length,
      }
    }
    const all = (run.candidates || []).map(String)
    if (scope === 'all') {
      return {
        scope: 'all',
        sessions: all.slice(0, cap).map(view),
        total: all.length,
        truncated: all.length > cap,
      }
    }
    const sessions = []
    let index = 0
    for (; index < all.length; index += 1) {
      if (sessions.length >= cap) break
      const summary = byId.get(all[index])
      if (await this.reflectionSessionActive(run, all[index], Boolean(summary && summary.running))) sessions.push(view(all[index]))
    }
    return {
      scope: 'candidates',
      sessions,
      total: all.length,
      truncated: index < all.length && sessions.length >= cap,
    }
  }

  reflectionTickets(run, args) {
    const scope = args.scope === 'open' || args.scope === 'history' ? args.scope : 'window'
    const limit = Math.max(1, Math.min(200, Number.isSafeInteger(args.limit) ? args.limit : 80))
    const detail = args.detail === 'full' ? 'full' : 'summary'
    const hot = this.tickets.tickets()
    let list
    if (scope === 'open') {
      list = hot.filter(ticket => !isTerminal(ticket.status))
    } else if (scope === 'history') {
      list = hot.filter(ticket => isTerminal(ticket))
      const seen = new Set(list.map(ticket => ticket.ticketId))
      for (const record of this.tickets.historyRecords()) {
        const ticket = normalizeTicket(record.ticket)
        if (ticket.ticketId && !seen.has(ticket.ticketId)) {
          seen.add(ticket.ticketId)
          list.push(ticket)
        }
      }
    } else {
      const byId = new Map()
      for (const record of this.tickets.historyRecords()) {
        const ticket = normalizeTicket(record.ticket)
        if (!ticket.ticketId) continue
        const known = byId.get(ticket.ticketId)
        if (!known || (ticket.closedAt || 0) > (known.closedAt || 0)) byId.set(ticket.ticketId, ticket)
      }
      for (const ticket of hot) byId.set(ticket.ticketId, ticket)
      list = [...byId.values()].filter(ticket => insideWindow(ticket, run))
    }
    if (typeof args.status === 'string' && args.status) list = list.filter(ticket => ticket.status === args.status)
    if (typeof args.executor === 'string' && args.executor) list = list.filter(ticket => ticket.executor === args.executor)
    list.sort((a, b) => (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0))
    return { detail, tickets: list.slice(0, limit).map(ticket => ticketView(ticket, { detail })), total: list.length, truncated: list.length > limit }
  }

  async toolReflectSessionStatus(sessionId, runId, args = {}) {
    const run = this.reflectionRunFor(sessionId, runId)
    if (!run) return this.reflectionClosed()
    const scope = args && args.scope === 'all' ? 'all' : 'candidates'
    const listing = await this.reflectionSessions(run, scope, 50)
      .catch(() => ({ sessions: [], total: (run.candidates || []).length, truncated: false }))
    return reflectionStatusView(run, {
      candidates: listing.sessions,
      candidateTotal: listing.total,
      candidatesTruncated: listing.truncated,
      memoryChars: measureText(this.chatMemoryText()).chars,
    })
  }

  async toolReflectReadTickets(sessionId, runId, args) {
    const run = this.reflectionRunFor(sessionId, runId)
    if (!run) return this.reflectionClosed()
    return this.reflectionTickets(run, args)
  }

  async toolReflectReadSessions(sessionId, runId, args) {
    const run = this.reflectionRunFor(sessionId, runId)
    if (!run) return this.reflectionClosed()
    const scope = args.scope === 'recent' ? 'recent' : (args.scope === 'all' ? 'all' : 'candidates')
    const limit = Math.max(1, Math.min(50, Number.isSafeInteger(args.limit) ? args.limit : 50))
    return this.reflectionSessions(run, scope, limit)
  }

  async toolReflectReadSession(sessionId, runId, args, signal) {
    const run = this.reflectionRunFor(sessionId, runId)
    if (!run) return this.reflectionClosed()
    const target = asString(args.sessionId)
    if (!target) return this.reflectionInvalid('ria_reflect_read_session 需要 sessionId。')
    if (!run.candidates.includes(target)) {
      const message = '会话 ' + target + ' 不在本次反思的候选会话中。'
      return { ok: false, code: 'session_not_allowed', message, error: message }
    }
    const loaded = await this.reflectionSessionEvents(target, run, signal)
    const stats = this.reflectionStats(run)
    stats.readCalls += 1
    stats.compressedBytesRead += loaded.compressedBytes || 0
    stats.decompressedBytesRead += loaded.decompressedBytes || 0
    try {
      writeReflectionRun(run, this.stateDir)
    } catch (error) {
      this.log('warn', 'could not persist reflection read stats: ' + String(error && error.message ? error.message : error))
    }
    const result = querySession({
      run,
      events: loaded.events,
      source: loaded.source,
      corruptFrames: loaded.corruptFrames,
      mode: args.mode,
      from: args.from,
      to: args.to,
      refs: args.refs,
      tailTurns: args.tailTurns,
      maxMessages: args.maxMessages,
      maxChars: args.maxChars,
      seenRefs: this.reflectionSeenFor(run.runId, target),
    })
    return result
  }

  toolReflectReadContext(sessionId, runId, args) {
    const run = this.reflectionRunFor(sessionId, runId)
    if (!run) return this.reflectionClosed()
    const kind = args.kind === 'outbox' || args.kind === 'schedule' ? args.kind : 'memory'
    if (kind === 'memory') return readMemoryContext(this.stateDir)
    if (kind === 'outbox') return readOutboxContext(this.outbox.all(), run)
    // Today's orchestration does not create scheduled reflection runs. Keep the
    // tool shape stable and return an empty view instead of inventing data.
    return { text: '', bytes: 0, truncated: false }
  }

  toolReflectReport(sessionId, runId, args) {
    const run = this.reflectionRunFor(sessionId, runId)
    if (!run) return this.reflectionClosed()
    const allowed = new Set(['markdown', 'status', 'counts', 'degraded'])
    const extra = Object.keys(args).filter(key => !allowed.has(key))
    if (extra.length) return this.reflectionInvalid('ria_reflect_report 不接受参数：' + extra.join(', '))
    const result = writeReflectionReport({ run, markdown: args.markdown, status: args.status, counts: args.counts, degraded: args.degraded })
    if (result.ok) {
      this.log('info', 'reflection ' + run.runId + ' wrote ' + result.path + ' (' + result.bytes + ' bytes)')
    }
    return result
  }

  installReflectionTools(agent, runId) {
    if (this.reflectionInstalled.has(agent)) return
    const run = this.reflections.get(String(runId))
    if (!run || (run.status !== 'running' && run.status !== 'starting')) return
    this.reflectionInstalled.add(agent)
    const sessionId = String(agent.id)
    const disposers = []
    const register = (toolName, description, parameters, execute) => {
      const dispose = agent.ctx.tools.register({
        name: toolName,
        description,
        parameters,
        output: {
          schema: { type: 'object', additionalProperties: true },
          render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
        },
        execute: async (args, exec) => this.reflectionToolResult(await execute(args && typeof args === 'object' ? args : {}, exec)),
      })
      if (typeof dispose === 'function') disposers.push(dispose)
    }

    register(
      'ria_reflect_status',
      'Read the state of this reflection run: runId, forDate, the run window, deadline and remaining time, candidate sessions, limits, memory size, partial report path and state. scope=candidates (default) lists only sessions with at least one event inside the run window; scope=all lists every candidate regardless of activity. Either list is capped at 50; candidateTotal counts all candidates before activity filtering and candidatesTruncated marks a cap. Read-only. After the run finishes or aborts every reflect tool returns run_closed.',
      {
        type: 'object',
        properties: {
          scope: { type: 'string', enum: ['candidates', 'all'] },
        },
        additionalProperties: false,
      },
      args => this.toolReflectSessionStatus(sessionId, runId, args),
    )

    register(
      'ria_reflect_read_tickets',
      'Read tickets for this reflection run. scope=window (default) covers the hot store plus archived history touched inside the run window; scope=open covers non-terminal tickets only; scope=history covers terminal tickets. Optional status and executor filters. limit is 1-200 (default 80). detail=summary (default) returns only ticketId, goal, status, waitingOn, executor and updatedAt; detail=full adds acceptance, attention, resolution, failure, dependencies, checklist and all timestamps, with goal/acceptance/reason/checklist text shortened to 500 characters. total is the matched count before limit. Read-only.',
      {
        type: 'object',
        properties: {
          scope: { type: 'string', enum: ['window', 'open', 'history'] },
          status: { type: 'string', enum: TICKET_STATUSES },
          executor: { type: 'string', description: 'Exact executor session id, or self.' },
          detail: { type: 'string', enum: ['summary', 'full'] },
          limit: { type: 'number', minimum: 1, maximum: 200 },
        },
        additionalProperties: false,
      },
      args => this.toolReflectReadTickets(sessionId, runId, args),
    )

    register(
      'ria_reflect_read_sessions',
      'List candidate sessions for this run. scope=candidates (default) returns only sessions with at least one event inside the run window; scope=all returns every candidate regardless of activity; scope=recent returns recently used workers from the last 7 days. limit is 1-50 (default 50). For candidates and all, total is the candidate universe (including inactive sessions); for recent, total is the matching workers before the limit. truncated marks a list cut by the limit. Each item includes sessionId, title, running, blank, optional lastUsedAt and ticketIds. Read-only; it never resolves, resumes or appends to a session.',
      {
        type: 'object',
        properties: {
          scope: { type: 'string', enum: ['candidates', 'all', 'recent'] },
          limit: { type: 'number', minimum: 1, maximum: 50 },
        },
        additionalProperties: false,
      },
      args => this.toolReflectReadSessions(sessionId, runId, args),
    )

    register(
      'ria_reflect_read_session',
      'Read one candidate session without resuming it. mode=summary (default) keeps user messages, the last assistant text per turn, and folded tool/thinking briefs; refs on those items can be expanded later with mode=full. mode=full returns raw events and requires refs or from/to. from/to are ISO 8601 times with a timezone or 0-based event indexes, left-closed/right-open, and must use the same type. refs accepts 1-50 refs returned earlier by summary for this session and cannot be combined with from/to. tailTurns (1-50, summary only) returns the last N distinct turns inside the run window and cannot be combined with refs or from/to; priority is latest events first, while the returned messages stay in chronological order. maxMessages defaults 50/20 (summary/full), maxChars 10000/40000. Bad archive frames are skipped and counted in corruptFrames; the log is never rewritten. Only sessions in this run candidates are allowed.',
      {
        type: 'object',
        properties: {
          sessionId: { type: 'string' },
          mode: { type: 'string', enum: ['summary', 'full'] },
          from: { anyOf: [{ type: 'string' }, { type: 'number' }] },
          to: { anyOf: [{ type: 'string' }, { type: 'number' }] },
          refs: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 50 },
          tailTurns: { type: 'number', minimum: 1, maximum: 50 },
          maxMessages: { type: 'number', minimum: 1, maximum: 200 },
          maxChars: { type: 'number', minimum: 1, maximum: 40000 },
        },
        required: ['sessionId'],
        additionalProperties: false,
      },
      (args, exec) => this.toolReflectReadSession(sessionId, runId, args, exec.signal),
    )

    register(
      'ria_reflect_read_context',
      'Read one small context slice for this run: memory (cognition/chat: preferences.md, agreements.md, decisions.md; at most 4KB), outbox (at most 50 recent or undelivered entries), or schedule (today returns an empty view because scheduled reflection runs are not wired yet). Text is redacted before it leaves the tool. Read-only.',
      {
        type: 'object',
        properties: { kind: { type: 'string', enum: ['memory', 'outbox', 'schedule'] } },
        required: ['kind'],
        additionalProperties: false,
      },
      args => this.toolReflectReadContext(sessionId, runId, args),
    )

    register(
      'ria_reflect_report',
      'Write the partial reflection report for this run to runs/<runId>/report.partial.md. markdown is required and at most 30KB; status is complete or partial; counts is an object; degraded is an optional array of strings. The write is atomic and private (0600). This tool accepts no path, runId or sessionId parameter. Read-only tools remain available until the orchestration closes the run.',
      {
        type: 'object',
        properties: {
          markdown: { type: 'string' },
          status: { type: 'string', enum: ['complete', 'partial'] },
          counts: { type: 'object', additionalProperties: true },
          degraded: { type: 'array', items: { type: 'string' } },
        },
        required: ['markdown', 'status', 'counts'],
        additionalProperties: false,
      },
      args => this.toolReflectReport(sessionId, runId, args),
    )
    this.reflectionDisposers.set(sessionId, disposers)
    // The reflection worker must never inherit preset tools: no shell, no file
    // writes, no MCP, no network. The six tools above are scoped registrations
    // and survive the restriction; every global/preset tool is refused.
    if (!agent.ctx.tools || typeof agent.ctx.tools.restrict !== 'function') {
      throw new Error('reflection worker cannot be restricted to read-only tools')
    }
    agent.ctx.tools.restrict({ allow: [] })
  }


  /**
   * A worker is busy when its current turn is running or it already has queued
   * or steering input. Dispatching another queue item would silently push the
   * new task behind work Ria never saw, so the request is refused instead of
   * accepted and hidden in the inbox.
   */
  async workerBusy(sessionId, signal = NEVER_ABORTED) {
    let state
    try {
      state = await this.ctx.sessionController.state({ sessionId }, signal)
    } catch (error) {
      this.log('warn', 'could not read worker state for ' + sessionId + ': ' + String(error && error.message ? error.message : error))
      return { busy: false, unknown: true, running: false, queued: 0 }
    }
    const running = Boolean(state && state.running === true)
    const queued = state && Array.isArray(state.queue) ? state.queue.length : 0
    return { busy: running || queued > 0, running, queued }
  }

  /**
   * Guard the manual working edge for a worker executor. A worker only emits
   * [Worker idle] after a turn it actually ran has ended; if Ria sets a ticket
   * to working while the worker is idle, no such event can ever arrive and the
   * ticket would stick until restart reconciliation. Internal dispatch paths
   * (ria_request, delivery replay) write working only after prompt() accepts,
   * so they do not call this guard. self is exempt because Ria writes working
   * from inside its own turn.
   */

  /**
   * Queue the turn-tail dispatch card. Nothing is written to the transcript
   * here: the outbox pump attaches it when a turn is open, and keeps it queued
   * until one is. The returned noteId deduplicates the local card and links the
   * WeChat mirror. Remote delivery is at-least-once: a crash after sending but
   * before marking delivered can duplicate the mirror.
   */
  appendDispatchNote(agent, note, ticketId, turnOverride) {
    const riaId = this.store.riaSessionId
    if (!agent || String(agent.id) !== String(riaId)) {
      this.log('warn', 'could not queue dispatch note: not on Ria')
      return undefined
    }
    const turn = Number.isSafeInteger(turnOverride) ? turnOverride : this.currentRiaTurn
    if (Number.isSafeInteger(turn)) this.currentRiaTurn = turn
    const noteId = newId('note_')
    const payload = { noteId, sessionId: riaId, note, isTicket: true }
    if (Number.isSafeInteger(turn)) payload.turn = turn
    if (ticketId) payload.ticketId = String(ticketId)
    try {
      // The key is the logical confirmation, not this attempt's random id: a
      // repeated call with the same ticket, text and turn reuses the queued
      // entry instead of showing the card twice.
      const queued = this.outbox.enqueue({ kind: 'dispatch_note', dedupeKey: sideEffectKey(ticketId, note, turn), payload })
      return queued.entry.payload.noteId || noteId
    } catch (error) {
      this.log('warn', 'could not queue dispatch note: ' + String(error && error.message ? error.message : error))
      return undefined
    }
  }

  /**
   * A WeChat-side channel just resumed. Reconcile the queued phone notifications
   * against lastHumanMessageAt, the newest real human message on any channel:
   * older entries are silently retired, newer ones are replayed in event-time
   * order. The resume time itself is not an anchor; it says nothing about what
   * the user has already read. No fold summary is generated.
   */
  handleWechatResume(status, info = {}) {
    const at = now()
    const anchor = this.store.lastHumanMessageAt
    // Live direct chatter is never replayed after a reconnect, and a long pause
    // may have queued many assistant fallbacks; fold the backlog first.
    try { this.v2?.resetDirectSendQueue?.() } catch { /* v1 has no direct mode */ }
    this.collapseAssistantBacklog(5)
    let result
    try {
      result = this.outbox.resumeChannelBacklog(anchor, at)
    } catch (error) {
      this.log('warn', 'could not reconcile queued WeChat notifications: ' + String(error && error.message ? error.message : error))
      return { suppressed: 0, replay: 0 }
    }
    this.log('info', 'WeChat resumed via ' + String((status && status.id) || 'wechat')
      + '; anchor=' + (anchor || 0) + ' suppressed=' + result.suppressed + ' replay=' + result.replay)
    if (result.replay > 0) void this.pumpOutbox('wechat-resume')
    return result
  }

  /**
   * WeChat-side destinations for dispatch/approval notes: the legacy
   * "file transfer helper" connection and the WeChat Claw bot. QQ is not a
   * WeChat target. The most recently active channel goes first; equal times
   * keep the legacy channel ahead (stable sort).
   */
  wechatNoteChannels() {
    const channels = []
    if (this.wechat) channels.push({ name: 'wechat', service: this.wechat })
    if (this.wechatClaw) channels.push({ name: 'wechat-claw', service: this.wechatClaw })
    channels.sort((a, b) => (Number(b.service.lastInboundAt) || 0) - (Number(a.service.lastInboundAt) || 0))
    return channels
  }

  /**
   * Deliver one WeChat note to the first channel that can send it. A paused,
   * disconnected or targetless channel returns {deferred:true}, which keeps the
   * outbox entry pending without spending an attempt. A real send error is
   * remembered and thrown only if no channel accepted the note.
   */
  async deliverWechatNote(kind, payload) {
    let failure
    for (const channel of this.wechatNoteChannels()) {
      let sent
      try {
        if (kind === 'dispatch') {
          sent = await channel.service.sendDispatchNote(payload.note, { isTask: payload.isTicket !== false, durable: true })
        } else if (kind === 'approval') {
          sent = await channel.service.sendApprovalNote(payload.note, { durable: true })
        } else if (kind === 'pause') {
          sent = await channel.service.sendPauseNotice(payload.text, { durable: true })
        } else if (kind === 'fold') {
          sent = await channel.service.sendRecoveryNotice(payload.text, { durable: true })
        } else {
          throw new Error('unknown WeChat note kind: ' + String(kind))
        }
      } catch (error) {
        this.log('warn', 'WeChat ' + kind + ' note failed on ' + channel.name + ': ' + String(error && error.message ? error.message : error))
        if (!failure) failure = error
        continue
      }
      if (sent && sent.deferred) continue
      if (sent === true) {
        this.log('info', 'WeChat ' + kind + ' note sent via ' + channel.name)
        return true
      }
      if (!failure) failure = new Error('WeChat ' + channel.name + ' did not accept the ' + kind + ' note')
    }
    if (failure) throw failure
    return { deferred: true }
  }

  /**
   * Queue the WeChat mirror. A failure is retried by the outbox instead of being
   * dropped; the dispatch itself never depends on WeChat being connected.
   */
  notifyDispatchNote(note, isTicket, ticketId, noteId) {
    const id = noteId || newId('note_')
    const linked = this.outbox.all().find(entry => entry.kind === 'dispatch_note' && entry.payload && entry.payload.noteId === id)
    const turn = linked && Number.isSafeInteger(linked.payload.turn) ? linked.payload.turn : undefined
    const payload = { note, isTicket: Boolean(isTicket), noteId: id }
    if (ticketId) payload.ticketId = String(ticketId)
    try {
      this.outbox.enqueue({ kind: 'wechat_dispatch_note', dedupeKey: sideEffectKey(ticketId, note, turn), payload })
    } catch (error) {
      this.log('warn', 'could not queue WeChat dispatch note: ' + String(error && error.message ? error.message : error))
    }
  }

  /**
   * The service that must receive the pause notice for this channel, but only
   * when that channel can actually reply. A disconnected channel (or a Claw/QQ
   * channel that has never seen a peer) must not accumulate notices.
   */
  /** Effective file-transfer options for one channel. */
  channelFileOptions(channel) {
    const channels = this.options && this.options.channels && typeof this.options.channels === 'object' ? this.options.channels : {}
    const config = channels[channel]
    return normalizeWechatClawFileOptions(config && config.files)
  }

  /** A connected service that can send a file, or undefined. */
  channelFileService(channel) {
    if (channel === 'wechat') return this.wechat && this.wechat.outbound ? this.wechat : undefined
    if (channel === 'wechat-claw') return this.wechatClaw && this.wechatClaw.session ? this.wechatClaw : undefined
    if (channel === 'qq-bot') return this.qqBot && this.qqBot.session ? this.qqBot : undefined
    return undefined
  }

  /** Whether the channel has a reply target right now. */
  channelFileHasTarget(channel) {
    if (channel === 'wechat') return Boolean(this.wechat && this.wechat.outbound)
    if (channel === 'wechat-claw') return Boolean(this.wechatClaw && this.wechatClaw.noteTarget())
    if (channel === 'qq-bot') return Boolean(this.qqBot && this.qqBot.noteTarget())
    return false
  }

  /** Most recently active channel that can receive a file. */

  channelFileIsPaused(channel) {
    return Boolean(this.channelPauseState(channel).paused)
  }


  async deliverChannelFile(payload, entry) {
    const channel = asString(payload.channel)
    const service = this.channelFileService(channel)
    if (!service) {
      if (entry && Number.isFinite(entry.createdAt) && now() - entry.createdAt > 24 * 60 * 60 * 1000) {
        throw new Error(channel + ' 超过 24 小时未连接，文件不再重试')
      }
      return { deferred: true }
    }
    if (!this.channelFileHasTarget(channel)) return { deferred: true }
    if (this.channelFileIsPaused(channel)) return { deferred: true }
    const options = this.channelFileOptions(channel)
    if (!options.enabled) throw new Error('当前通道的文件发送已关闭')
    const path = asString(payload.path)
    const name = safeClawFileName(asString(payload.name) || basename(path))
    let stats
    try {
      stats = statSync(path)
    } catch (error) {
      throw new Error('文件已不存在：' + path)
    }
    if (!stats.isFile() || !stats.size) throw new Error('文件不可用：' + path)
    if (stats.size > options.maxBytes) throw new Error('文件超过 ' + formatFileSize(options.maxBytes) + ' 上限')
    const buffer = readFileSync(path)
    try {
      await service.sendFile(name, buffer)
    } catch (error) {
      if (isPausedError(error)) return { deferred: true }
      service.recordFileSend({
        delivered: false,
        name,
        bytes: stats.size,
        path,
        code: (error && error.code) || 'file_send_failed',
        error: errorText(error),
        ret: error && error.ret,
        errmsg: error && error.errmsg,
      })
      throw error
    }
    service.recordFileSend({ delivered: true, name, bytes: stats.size, path })
    const note = asString(payload.note)
    if (note) {
      try {
        await service.sendNote('📎 ' + note)
      } catch (error) {
        this.log('warn', 'file note failed after delivering ' + name + ': ' + errorText(error))
      }
    }
    return true
  }

  channelPauseService(channel) {
    if (channel === 'wechat') return this.wechat && this.wechat.outbound ? this.wechat : undefined
    if (channel === 'wechat-claw') return this.wechatClaw && this.wechatClaw.noteTarget() ? this.wechatClaw : undefined
    if (channel === 'qq-bot') return this.qqBot && this.qqBot.noteTarget() ? this.qqBot : undefined
    return undefined
  }

  channelPauseState(channel) {
    if (channel === 'wechat') {
      const state = this.wechat ? this.wechat.state : undefined
      return {
        paused: Boolean(state && state.paused),
        pausedAt: state && state.data && typeof state.data.pausedAt === 'string' ? state.data.pausedAt : '',
      }
    }
    const service = channel === 'wechat-claw' ? this.wechatClaw : (channel === 'qq-bot' ? this.qqBot : undefined)
    return {
      paused: Boolean(service && service.paused),
      pausedAt: service && typeof service.pausedAt === 'string' ? service.pausedAt : '',
    }
  }

  /**
   * Queue exactly one notice on the channel that was just paused. The dedupe
   * key includes the channel and the pause timestamp, so replaying the same
   * transition after a restart reuses the delivered record. Manual pauses and
   * repeated automatic pauses are ignored here; the services only call this on
   * the first transition, and the timestamp stays stable for repeats.
   */
  notifyChannelAutoPause(channel, status) {
    if (!status || status.paused !== true || status.pausedBy !== 'channel') return false
    if (!this.channelPauseService(channel)) {
      this.log('info', 'no connected target for the ' + channel + ' auto-pause notice; skipped')
      return false
    }
    const pausedAt = typeof status.pausedAt === 'string' ? status.pausedAt : ''
    if (!pausedAt) {
      this.log('warn', 'could not queue ' + channel + ' auto-pause notice: pausedAt is missing')
      return false
    }
    const pausedMs = Date.parse(pausedAt)
    try {
      this.outbox.enqueue({
        kind: 'channel_pause_notice',
        dedupeKey: channel + ':' + pausedAt,
        ...(Number.isFinite(pausedMs) ? { eventAt: pausedMs } : {}),
        payload: {
          channel,
          text: channelPauseNoticeText(channel, status.pauseReason),
          pausedAt,
          pauseReason: status.pauseReason || '',
        },
      })
    } catch (error) {
      this.log('warn', 'could not queue ' + channel + ' auto-pause notice: ' + String(error && error.message ? error.message : error))
      return false
    }
    void this.pumpOutbox('auto-pause')
    return true
  }

  notifyWechatAutoPause(status) {
    return this.notifyChannelAutoPause('wechat', status)
  }

  /**
   * Deliver a pause notice only to its own channel. If the channel has resumed
   * (or re-paused with a different timestamp) while the entry sat in the
   * outbox, drop it instead of delivering a stale notice. A deferred reply
   * target is also dropped: keeping it would make it appear after the user has
   * already resumed the channel.
   */
  async deliverChannelPauseNotice(payload) {
    const channel = asString(payload.channel)
    const service = this.channelPauseService(channel)
    if (!service) {
      this.log('info', 'dropped ' + channel + ' auto-pause notice: channel is not connected')
      return true
    }
    const pausedAt = asString(payload.pausedAt)
    const current = this.channelPauseState(channel)
    if (!current.paused || current.pausedAt !== pausedAt) {
      this.log('info', 'dropped stale ' + channel + ' auto-pause notice')
      return true
    }
    const text = asString(payload.text) || channelPauseNoticeText(channel, payload.pauseReason)
    const sent = await service.sendPauseNotice(text, { durable: true })
    if (sent && sent.deferred) {
      this.log('info', 'dropped ' + channel + ' auto-pause notice: no reply target')
      return true
    }
    if (sent !== true) throw new Error(channel + ' did not accept the auto-pause notice')
    this.log('info', channel + ' auto-pause notice sent')
    return true
  }

  /**
   * An assistant reply could not be delivered on WeChat Claw (paused, no
   * connection, or a send failure). Keep a durable copy so the user is not left
   * with only the dispatch card. Only channels that have actually received a
   * message are eligible; otherwise every pre-connection reply would pile up.
   */
  notifyWechatAssistantFallback(info) {
    const claw = this.wechatClaw
    const text = info && typeof info.text === 'string' ? info.text : ''
    if (!claw || !text.trim()) return false
    if (!claw.lastInboundAt && !claw.pausedAt && !claw.peer) {
      this.log('info', 'WeChat Claw has never received a message; skipped assistant fallback')
      return false
    }
    const chars = [...text]
    const clipped = chars.length > 24000
      ? chars.slice(0, 24000).join('') + '\n…（补发内容已截断，完整内容见 Ria 会话）'
      : text
    const sessionId = this.store.riaSessionId || 'ria'
    // The assistant event's causal time, not the time the send was attempted.
    // Without it a resume replay would order the text after cards it preceded.
    const fallbackAt = asString(info.at)
    const parsedAt = fallbackAt ? Date.parse(fallbackAt) : NaN
    const eventAt = Number.isFinite(info.eventAt) && info.eventAt > 0
      ? info.eventAt
      : (Number.isFinite(parsedAt) ? parsedAt : now())
    const key = Number.isFinite(info.eventSeq)
      ? sessionId + ':' + info.eventSeq
      : sessionId + ':' + eventAt + ':' + chars.length
    const payload = {
      text: clipped,
      reason: asString(info.reason),
      chars: chars.length,
      at: fallbackAt || new Date(eventAt).toISOString(),
      eventAt,
      truncated: clipped !== text,
    }
    if (Number.isFinite(info.eventSeq)) payload.eventSeq = info.eventSeq
    try {
      const queued = this.outbox.enqueue({
        kind: WECHAT_ASSISTANT_NOTE_KIND,
        dedupeKey: 'assistant:' + key,
        payload,
        eventAt,
      })
      this.log('info', 'queued WeChat Claw assistant fallback (' + payload.reason + ', ' + chars.length + ' chars)')
      void this.pumpOutbox('wechat-assistant-fallback')
      return Boolean(queued.entry)
    } catch (error) {
      this.log('warn', 'could not queue WeChat Claw assistant fallback: ' + String(error && error.message ? error.message : error))
      return false
    }
  }

  /**
   * Keep at most `max` recent assistant fallbacks pending and fold the older
   * ones into one summary line. This is the "安静很久突然刷屏" guard: the user
   * still learns something is missing, without a burst of stale replies.
   */
  collapseAssistantBacklog(max = 5) {
    let pending
    try {
      pending = this.outbox.all().filter(entry => entry.kind === WECHAT_ASSISTANT_NOTE_KIND && entry.status === 'pending')
    } catch (error) {
      this.log('warn', 'could not inspect assistant fallback backlog: ' + String(error && error.message ? error.message : error))
      return 0
    }
    if (pending.length <= max) return 0
    const sorted = pending.slice().sort((left, right) =>
      (Number(left.eventAt) || 0) - (Number(right.eventAt) || 0) || (left.createdAt || 0) - (right.createdAt || 0))
    const drop = sorted.slice(0, sorted.length - max)
    const ids = new Set(drop.map(item => item.id))
    let removed = 0
    try {
      removed = this.outbox.removeWhere(entry => ids.has(entry.id))
    } catch (error) {
      this.log('warn', 'could not fold assistant fallback backlog: ' + String(error && error.message ? error.message : error))
      return 0
    }
    if (!removed) return 0
    const summary = '另有 ' + removed + ' 条较早的补发消息未送达，完整内容见 Ria 会话。'
    try {
      this.outbox.enqueue({
        kind: WECHAT_ASSISTANT_NOTE_KIND,
        dedupeKey: 'assistant-backlog-summary:' + now(),
        payload: { text: summary, reason: 'summary', chars: [...summary].length, at: new Date().toISOString(), truncated: false },
        eventAt: now(),
      })
    } catch (error) {
      this.log('warn', 'could not enqueue the assistant backlog summary: ' + String(error && error.message ? error.message : error))
    }
    this.log('info', 'folded ' + removed + ' older assistant fallback(s) into one summary')
    return removed
  }

  /**
   * A fresh Claw inbound message can carry a fresh context_token. Re-arm the
   * fallback replies that failed on the old token without spending attempts.
   */
  async handleWechatClawInbound() {
    // A fresh inbound token is a recovery window: fold any backlog before the
    // re-arm so the user never gets a silent-then-flood replay.
    this.collapseAssistantBacklog(5)
    let changed = 0
    try {
      changed = this.outbox.retryWhere(entry => entry.kind === WECHAT_ASSISTANT_NOTE_KIND)
    } catch (error) {
      this.log('warn', 'could not re-arm WeChat Claw assistant fallbacks: ' + String(error && error.message ? error.message : error))
      return 0
    }
    if (!changed) return 0
    this.log('info', 're-armed ' + changed + ' WeChat Claw assistant fallback(s) after inbound')
    await this.pumpOutbox('wechat-claw-inbound')
    return changed
  }

  /**
   * Serialize pumps so two triggers cannot deliver the same entry twice. A
   * trigger that arrives during a pump (for example turn/start while the
   * startup pump is waiting on WeChat) makes the current pump run one more
   * pass, so a newly opened turn gets its queued card immediately.
   */
  pumpOutbox(reason) {
    if (this.pumping) {
      this.pumpAgain = true
      return this.pumping
    }
    const run = (async () => {
      try {
        do {
          this.pumpAgain = false
          await this.doPumpOutbox(reason)
        } while (this.pumpAgain)
      } catch (error) {
        this.log('warn', 'outbox pump failed: ' + String(error && error.message ? error.message : error))
      }
    })()
    this.pumping = run.finally(() => {
      this.pumping = undefined
      // A trigger can land after the loop checked pumpAgain but before this
      // callback runs; hand it a fresh pump instead of losing it until tick.
      if (this.pumpAgain) {
        this.pumpAgain = false
        void this.pumpOutbox('follow-up')
      }
    })
    return this.pumping
  }

  async doPumpOutbox(reason) {
    // Reuse the existing 30s outbox tick: it is already durable, unref'd, and
    // wakes often enough for a 60s confirmation deadline without another timer.
    try {
      this.reconcileDispatchConfirmations(reason)
    } catch (error) {
      this.log('warn', 'dispatch confirmation scan failed: ' + String(error && error.message ? error.message : error))
    }
    const at = now()
    const due = this.outbox.due(at)
    if (!due.length) {
      this.outbox.prune(at)
      return
    }
    const handled = new Set()
    for (const entry of due) {
      if (handled.has(entry.id)) continue
      // A dispatch/approval card is only meaningful inside an open turn. Leave
      // the entry pending; turn/start pumps again. Queue signals start their own
      // turn, so they wait for the current turn to end instead.
      if ((entry.kind === 'dispatch_note' || entry.kind === 'approval_note' || entry.kind === 'dispatch_unconfirmed') && !Number.isSafeInteger(this.currentRiaTurn)) continue
      if ((entry.kind === 'queue_wake' || entry.kind === 'queue_blocked') && Number.isSafeInteger(this.currentRiaTurn)) {
        // The wake is queued but cannot be delivered until this turn ends. The
        // one-shot checks catch the case where the turn-end hook is also lost.
        if (entry.kind === 'queue_wake' && entry.payload) this.scheduleReadyCheck(entry.payload.ticketId, entry.payload.readyAt)
        continue
      }
      if (entry.kind === 'queue_wake' || entry.kind === 'queue_blocked') {
        // One prompt carries every ready (or blocked) ticket due in this pump.
        const batch = due.filter(item => item.kind === entry.kind && !handled.has(item.id))
        for (const item of batch) handled.add(item.id)
        const live = batch.filter(item => this.queueEntryIsCurrent(item))
        for (const stale of batch) {
          if (!live.includes(stale)) this.outbox.markDelivered(stale.id, now())
        }
        if (!live.length) continue
        try {
          await this.deliverQueueEntries(entry.kind, live)
          for (const item of live) {
            this.outbox.markDelivered(item.id, now())
            if (item.kind === 'queue_wake') this.tickets.markReadyNotified(item.payload.ticketId, item.payload.readyAt)
          }
        } catch (error) {
          const message = String(error && error.message ? error.message : error)
          for (const item of live) {
            this.outbox.markFailed(item.id, error, now())
            if (item.kind === 'queue_wake' && item.payload) this.scheduleReadyCheck(item.payload.ticketId, item.payload.readyAt)
          }
          this.log('warn', 'outbox ' + entry.kind + ' batch failed (' + reason + '): ' + message)
        }
        continue
      }
      try {
        const outcome = await this.deliverOutboxEntry(entry)
        if (outcome && outcome.deferred) continue
        this.outbox.markDelivered(entry.id, now())
      } catch (error) {
        const message = String(error && error.message ? error.message : error)
        this.outbox.markFailed(entry.id, error, now())
        this.log('warn', 'outbox ' + entry.kind + ' ' + entry.id + ' failed (' + reason + '): ' + message)
      }
    }
    this.outbox.prune(now())
  }

  queueEntryIsCurrent(entry) {
    const payload = entry.payload || {}
    const ticket = this.tickets.ticket(asString(payload.ticketId))
    if (!ticket || ticket.status !== 'open') return false
    if (entry.kind === 'queue_wake') {
      return ticket.waitingOn === 'ria' && Number.isFinite(ticket.readyAt) && ticket.readyAt === payload.readyAt
    }
    if (entry.kind === 'queue_blocked') {
      return ticket.waitingOn === 'dependency' && Array.isArray(ticket.dependencyAlerts) && ticket.dependencyAlerts.length > 0
    }
    return false
  }

  /**
   * Deliver one merged queue notice. The token shown to Ria is computed from the
   * ticket's current revision, not the revision captured when the wake was
   * enqueued, so an unrelated check-in cannot leave Ria holding a stale token.
   */
  async deliverQueueEntries(kind, entries, signal = NEVER_ABORTED) {
    const items = []
    for (const entry of entries) {
      const ticket = this.tickets.ticket(asString(entry.payload && entry.payload.ticketId))
      if (!ticket) continue
      items.push({ ticket, info: this.tickets.queueInfo(ticket) })
    }
    if (!items.length) return
    let sessionId = this.store.riaSessionId
    if (!sessionId) {
      const info = await this.ensure()
      sessionId = info.sessionId
    }
    if (!sessionId) throw new Error('Ria is not registered yet')
    const lines = []
    if (kind === 'queue_wake') {
      lines.push('[Queue ready] 以下工单的依赖都已完成，可以派发：')
      for (const item of items) {
        lines.push('- ticketId=' + item.ticket.ticketId +
          ' | goal=' + item.ticket.goal +
          ' | executor=' + (item.ticket.executor || 'self') +
          ' | queueToken=' + item.info.queueToken)
      }
      lines.push('')
      lines.push('用 ria_request 派发并带上 queueToken。若目标 worker 正在跑 turn，不要用 queue 模式排队：改用 dependsOn 表达先后，或只用 steer 同步信息。')
    } else {
      lines.push('[Queue blocked] 以下工单的上游失败或取消了，先向用户报告并询问怎么处理：')
      for (const item of items) {
        const parts = item.info.dependencyAlerts.map(alert => alert.ticketId + '（' + alert.status + '）')
        lines.push('- ticketId=' + item.ticket.ticketId +
          ' | goal=' + item.ticket.goal +
          ' | blockedBy=' + (parts.join('、') || '上游'))
      }
      lines.push('')
      lines.push('不要自行跳过或改写需求；向用户说明上游状态，让用户决定重试、跳过、取消还是改需求。')
    }
    const content = [{ type: 'text', text: lines.join('\n') }]
    // The outbox pump is not tied to any one caller's cancellation scope, but
    // sessionController.prompt() dereferences its signal unconditionally.
    await this.ctx.sessionController.prompt({ requestId: newId(HOST_REQUEST_PREFIX), sessionId, mode: 'queue', content }, signal)
  }

  async deliverOutboxEntry(entry) {
    const payload = entry.payload || {}
    if (entry.kind === 'dispatch_note' || entry.kind === 'approval_note' || entry.kind === 'dispatch_unconfirmed') {
      const approval = entry.kind === 'approval_note'
      const riaId = this.store.riaSessionId
      if (!riaId) throw new Error('Ria is not registered yet')
      const record = this.store.recordDispatchNote({
        noteId: payload.noteId || entry.id,
        sessionId: riaId,
        turn: this.currentRiaTurn,
        note: payload.note,
        kind: approval ? 'approval' : 'dispatch',
        isTicket: approval ? false : payload.isTicket !== false,
        ticketId: payload.ticketId,
      })
      if (!record) throw new Error('dispatch note was rejected by the store')
      return
    }
    if (entry.kind === 'wechat_dispatch_note') {
      return this.deliverWechatNote('dispatch', payload)
    }
    if (entry.kind === 'wechat_approval_note') {
      return this.deliverWechatNote('approval', payload)
    }
    if (entry.kind === 'channel_pause_notice') {
      return this.deliverChannelPauseNotice(payload)
    }
    if (entry.kind === 'channel_file_send') {
      return this.deliverChannelFile(payload, entry)
    }
    // Older builds queued a WeChat-only pause notice. Keep delivering those
    // entries, but new pauses use channel_pause_notice so they never route to a
    // different channel than the one that was paused.
    if (entry.kind === 'wechat_pause_notice') {
      const text = typeof payload.text === 'string' && payload.text.trim() ? payload.text : WECHAT_AUTO_PAUSE_NOTICE
      return this.deliverWechatNote('pause', { text })
    }
    if (entry.kind === 'wechat_fold_notice') {
      const count = Number.isSafeInteger(payload.count) && payload.count > 0 ? payload.count : 0
      const text = typeof payload.text === 'string' && payload.text.trim()
        ? payload.text
        : '恢复推送：刚才 ' + count + ' 条任务通知已折叠'
      return this.deliverWechatNote('fold', { text, count })
    }
    if (entry.kind === WECHAT_ASSISTANT_NOTE_KIND) {
      const text = typeof payload.text === 'string' ? payload.text : ''
      if (!text.trim()) return
      if (!this.wechatClaw) throw new Error('WeChat Claw is not available')
      const sent = await this.wechatClaw.sendAssistantNote(text, { durable: true })
      if (sent && sent.deferred) return { deferred: true }
      if (sent !== true) throw new Error('WeChat Claw did not accept the assistant fallback')
      return
    }
    throw new Error('unknown outbox entry kind: ' + String(entry.kind))
  }

  startOutbox() {
    if (this.outboxTimer) return
    this.outboxTimer = setInterval(() => { void this.pumpOutbox('tick') }, OUTBOX_TICK_MS)
    if (this.outboxTimer.unref) this.outboxTimer.unref()
  }

  shutdownOutbox() {
    if (this.outboxTimer) {
      clearInterval(this.outboxTimer)
      this.outboxTimer = undefined
    }
    for (const [ticketId, record] of this.readyChecks) this.clearReadyCheck(ticketId, record.readyAt)
    this.readyChecks.clear()
  }


  async resolve(id) {
    return this.ctx.sessionController.resolveAgent(id)
  }

  async ensure() {
    if (this.v2) return await this.v2.ensureChat()
    if (this.ensuring) return this.ensuring
    this.ensuring = this.doEnsure().finally(() => { this.ensuring = undefined })
    return this.ensuring
  }

  async workspaceForPath(path, title) {
    const registry = this.ctx.workspaceRegistry
    if (!registry || typeof registry.create !== 'function') {
      throw new Error('the Workspace registry is unavailable')
    }
    return await registry.create(path, title || basename(path) || path)
  }

  async ensureWorkspace() {
    try {
      return await this.workspaceForPath(this.stateDir, 'Ria')
    } catch (error) {
      throw new Error('the Workspace registry is unavailable, so Ria cannot be opened as a normal session: ' + String(error && error.message ? error.message : error))
    }
  }

  /**
   * Attach a new worker to the Workspace that owns its cwd. Workspace
   * membership is a display/organization concern, not a precondition for the
   * session to run, so a failure here must never fail the spawn: report it in
   * the tool result and keep the session usable.
   */
  async attachWorkspaceSession(sessionId, cwd) {
    let workspace
    try {
      workspace = await this.workspaceForPath(cwd)
    } catch (error) {
      const message = String(error && error.message ? error.message : error)
      this.log('warn', 'could not resolve workspace for ' + cwd + ': ' + message)
      return { workspaceError: message }
    }
    const workspaceId = String(workspace.id)
    try {
      await workspace.attachSession(sessionId)
      return { workspaceId }
    } catch (error) {
      const message = String(error && error.message ? error.message : error)
      this.log('warn', 'session ' + sessionId + ' was not attached to workspace ' + workspaceId + ': ' + message)
      return { workspaceId, workspaceError: message }
    }
  }

  /**
   * Startup reconciliation for workers Ria knows about but which the Workspace
   * registry never adopted. The host only bootstraps cwd ownership when its
   * durable state is first initialized, so sessions created during a later run
   * (before dsh-ria attached them itself) can stay orphaned forever. Reattach
   * only candidates Ria has actually used, and never let one bad cwd stop the
   * rest of startup.
   */
  async reconcileWorkspaceSessions() {
    const registry = this.ctx.workspaceRegistry
    if (!registry || typeof registry.create !== 'function' || typeof registry.list !== 'function') return 0
    const candidates = new Set(Object.keys(this.store.recentWorkers()))
    for (const delivery of this.store.deliveries()) {
      if (delivery && delivery.targetSessionId) candidates.add(String(delivery.targetSessionId))
    }
    for (const ticket of this.tickets.tickets()) {
      if (ticket.executor && ticket.executor !== 'self') candidates.add(String(ticket.executor))
    }
    if (!candidates.size) return 0
    const archived = this.archivedSessions()
    let items
    try {
      items = await this.listSessions()
    } catch (error) {
      this.log('warn', 'workspace reconciliation could not list sessions: ' + String(error && error.message ? error.message : error))
      return 0
    }
    const accounted = new Set()
    for (const workspace of registry.list()) {
      for (const sessionId of workspace.sessionIds || []) accounted.add(String(sessionId))
    }
    let attached = 0
    for (const item of items) {
      const sessionId = String(item.sessionId)
      if (!candidates.has(sessionId) || accounted.has(sessionId)) continue
      if (sessionId === String(this.store.riaSessionId)) continue
      if (item.origin === 'subagent' || archived.has(sessionId)) continue
      const cwd = asString(item.cwd)
      if (!cwd || !isAbsolute(cwd)) continue
      if (this.workspaceProblem(cwd)) continue
      try {
        const workspace = await this.workspaceForPath(cwd)
        await workspace.attachSession(sessionId)
        accounted.add(sessionId)
        attached += 1
      } catch (error) {
        this.log('warn', 'workspace reconciliation could not attach ' + sessionId + ': ' + String(error && error.message ? error.message : error))
      }
    }
    if (attached) this.log('info', 'attached ' + attached + ' session(s) to their workspaces')
    return attached
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
      const pendingDispatch = this.registerDispatch(delivery)
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
          const ticket = this.tickets.ticket(ticketId)
          if (ticket && (ticket.status === 'open' || ticket.status === 'working')) {
            this.tickets.transitionTicket(ticket.ticketId, 'working', {
              attempt: this.dispatchAttempt(pendingDispatch), recovery: { count: 0 },
            })
          }
        }
        this.forgetDispatch(delivery.requestId)
      } catch (error) {
        this.forgetDispatch(delivery.requestId)
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
      const ticket = this.tickets.ticket(ticketId)
      if (!ticket) return
      // A reflection watch ticket is a passive host record; restarting must not
      // mistake it for work that needs a worker resumed.
      if (ticket.origin && ticket.origin.kind === 'reflection-watch') return
      if (ticket.status === 'forked') {
        for (const childId of ticket.childTicketIds) visit(childId)
        return
      }
      if (ticket.status === 'open' && ticket.waitingOn === 'dependency') return
      if (['intake', 'open', 'working'].includes(ticket.status)) units.push(ticket)
    }
    for (const ticket of this.tickets.tickets()) {
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
    const body = '工单 ' + ticket.ticketId + ' 自动恢复已达上限（' + MAX_RECOVERY_ATTEMPTS + '/' + MAX_RECOVERY_ATTEMPTS + '），已停止自动推进；需要用户手动处理。'
    const moved = this.tickets.transitionTicket(ticket.ticketId, 'blocked', {
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
    const noteId = this.appendDispatchNote(agent, body, ticket.ticketId)
    if (noteId) this.notifyDispatchNote(body, true, ticket.ticketId, noteId)
    void this.pumpOutbox('recovery')
  }

  async startup() {
    // One-shot retention/rotation at boot; append() rotates on month/size change.
    try {
      const events = this.routerEvents.prune()
      if (events.pruned) this.log('info', 'pruned ' + events.pruned + ' old router event file(s)')
      if (events.rotated) this.log('info', 'rotated the router event log at startup')
    } catch (error) {
      this.log('warn', 'router event prune failed: ' + String(error && error.message ? error.message : error))
    }
    if (this.v2) return await this.v2.startup()
    if (this.started) return
    this.started = true
    try {
      const archived = this.tickets.archiveClosedTickets()
      if (archived.archived) this.log('info', 'archived ' + archived.archived + ' closed ticket(s)')
      if (archived.error) this.log('warn', 'could not archive closed tickets: ' + archived.error)
      await this.grants.reconcile()
      try {
        await this.reconcileWorkspaceSessions()
      } catch (error) {
        this.log('warn', 'workspace reconciliation failed: ' + String(error && error.message ? error.message : error))
      }
      let dependencies = { ready: [], waiting: [], alerts: [], invalid: [] }
      this.dependencyReconciling = true
      try {
        dependencies = this.tickets.reconcileDependencies({ bootId: newId('boot_') })
      } catch (error) {
        this.log('warn', 'dependency reconciliation failed: ' + String(error && error.message ? error.message : error))
      } finally {
        this.dependencyReconciling = false
      }
      try {
        const blocked = this.reconcileDispatchConfirmations('startup')
        if (blocked) this.log('warn', 'blocked ' + blocked + ' dispatch(es) that never opened a worker turn before this restart')
      } catch (error) {
        this.log('warn', 'dispatch confirmation recovery failed: ' + String(error && error.message ? error.message : error))
      }
      try {
        this.publishReadyNotices()
      } catch (error) {
        this.log('warn', 'ready notice publish failed at startup: ' + String(error && error.message ? error.message : error))
      }
      // Ready tickets are woken by the queue outbox, not listed as recovery
      // units; otherwise Ria would hear about the same ticket twice.
      const collectUnits = () => this.recoveryUnits().filter(ticket => !(ticket.status === 'open' && ticket.readyAt))
      const initialUnits = collectUnits()
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
        const units = collectUnits()
        const exhausted = units.filter(ticket => (ticket.recovery && ticket.recovery.count || 0) >= MAX_RECOVERY_ATTEMPTS)
        const candidates = units.filter(ticket => (ticket.recovery && ticket.recovery.count || 0) < MAX_RECOVERY_ATTEMPTS)
        if (!candidates.length && !exhausted.length) return
        const riaInfo = await this.ensure()
        const resolved = await this.resolve(riaInfo.sessionId)
        const riaAgent = 'agent' in resolved ? resolved.agent : undefined
        for (const ticket of exhausted) await this.blockForRecovery(ticket, riaAgent)
        if (!candidates.length) return
        const lines = ['DSH 刚刚重启。以下工单还没有收敛，请逐条处理；不要重复已完成的部分。']
        const detailed = candidates.slice(0, 10)
        for (const ticket of detailed) {
          const next = this.tickets.bumpRecovery(ticket.ticketId)
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
            this.tickets.bumpRecovery(ticket.ticketId)
            lines.push('- ticketId=' + ticket.ticketId + ' | goal=' + ticket.goal)
          }
        }
        const queueParts = []
        if (dependencies.waiting.length) queueParts.push('排队中 ' + dependencies.waiting.length + ' 个（等上游完成）')
        if (dependencies.ready.length) queueParts.push('已就绪 ' + dependencies.ready.length + ' 个')
        if (dependencies.alerts.length) queueParts.push('依赖告警 ' + dependencies.alerts.length + ' 个')
        if (dependencies.invalid.length) queueParts.push('依赖数据无效 ' + dependencies.invalid.length + ' 个')
        if (queueParts.length) {
          lines.push('')
          lines.push('排队：' + queueParts.join('，') + '。不逐条列出；用 ria_status scope=tickets 查看 queueToken、blockedBy 与 queueText。')
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
    } finally {
      // Queue wakes enqueued during reconciliation are delivered here, after
      // the recovery prompt has been queued, so Ria sees one coherent story.
      this.queuePumpSuspended = false
      await this.pumpOutbox('startup')
      try {
        await this.reflectionStartupCheck()
      } catch (error) {
        this.log('warn', 'reflection startup check failed: ' + String(error && error.message ? error.message : error))
      }
    }
  }

  async notifyStartupFailure(message) {
    const text = [
      'DSH 启动恢复失败，需要用户处理。',
      '错误：' + message,
      '未完成的工单可能仍停留在原状态，自动恢复没有完成。请检查 Ria 的工单列表并手动处理。',
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

  async routerScore(body) {
    const llm = this.routerLlm || (this.ctx && this.ctx.llm)
    if (!llm) {
      throw Object.assign(new Error('llm service unavailable'), { code: 'llm_unavailable' })
    }
    const mode = body && body.mode
    if (mode !== 'project' && mode !== 'session') {
      throw Object.assign(new Error('mode must be project or session'), { code: 'invalid_mode' })
    }
    const request = asString(body.request)
    if (!request) {
      throw Object.assign(new Error('request is required'), { code: 'request_required' })
    }
    const provider = asString(body.provider) || asString(process.env.RIA_ROUTER_PROVIDER)
    const model = asString(body.model) || asString(process.env.RIA_ROUTER_MODEL)
    if (!provider || !model) {
      throw Object.assign(new Error('provider and model are required'), { code: 'model_required' })
    }
    const numberOption = (value, fallback) => {
      if (value === undefined || value === null) return fallback
      const number = Number(value)
      return Number.isFinite(number) ? number : fallback
    }
    const options = {
      maxTokens: numberOption(body.maxTokens, 1000),
      temperature: numberOption(body.temperature, 0),
      timeoutMs: numberOption(body.timeoutMs, 120000),
      threshold: numberOption(body.threshold, 5),
      strong: numberOption(body.strong, 7),
      margin: numberOption(body.margin, 1),
      newSessionPenalty: numberOption(body.newSessionPenalty, 0.5),
    }
    const candidates = body.candidates === undefined ? undefined : body.candidates
    return routeWithLlm({ llm, provider, model, mode, request, candidates, options })
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
    if (req.method === 'GET' && url.pathname === API_PREFIX + '/events') {
      const numberParam = name => {
        const raw = url.searchParams.get(name)
        if (raw === null || raw === '') return undefined
        const value = Number(raw)
        return Number.isFinite(value) ? value : undefined
      }
      const result = this.queryRouterEvents({
        ticketId: url.searchParams.get('ticketId') || undefined,
        type: url.searchParams.get('type') || undefined,
        from: url.searchParams.get('from') || undefined,
        to: url.searchParams.get('to') || undefined,
        limit: numberParam('limit'),
        offset: numberParam('offset'),
      })
      jsonSend(res, result.ok === false ? 400 : 200, result)
      return
    }
    if (req.method === 'GET' && url.pathname.endsWith('/state')) {
      jsonSend(res, 200, {
        riaSessionId: this.store.riaSessionId || null,
        tickets: this.tickets.tickets().map(ticketSummary),
        attentionOverview: this.attentionOverview(),
        outbox: this.outboxSummary(),
        pendingDeliveries: this.store.deliveries().length,
        grants: this.grants.list(),
        wechatClawAssistant: this.wechatClaw ? this.wechatClaw.lastAssistantForward || null : null,
        settings: this.store.settings(),
        v2: this.v2 ? this.v2.status() : null,
      })
      return
    }
    if (req.method === 'POST' && url.pathname.endsWith('/ask')) {
      readBody(req).then(async raw => {
        let body
        try {
          body = JSON.parse(raw || '{}')
        } catch {
          jsonSend(res, 400, { error: 'body must be JSON' })
          return
        }
        if (!body || typeof body !== 'object' || Array.isArray(body)) {
          jsonSend(res, 400, { error: 'body must be a JSON object' })
          return
        }
        try {
          const result = await this.askBoardTopic(body)
          jsonSend(res, 200, result)
        } catch (error) {
          const code = String(error && error.code ? error.code : '')
          const status = code === 'topic_missing' ? 404 : (code === 'ask_failed' ? 502 : (code ? 400 : 500))
          jsonSend(res, status, {
            error: String(error && error.message ? error.message : error),
            code: code || 'ask_failed',
          })
        }
      }).catch(error => jsonSend(res, 400, { error: String(error && error.message ? error.message : error) }))
      return
    }
    // Read-only Router preview. It scores candidates and returns the decision;
    // it never creates a ticket/session or changes existing Ria state.
    if (req.method === 'POST' && url.pathname.endsWith('/router/score')) {
      readBody(req).then(async raw => {
        let body
        try {
          body = JSON.parse(raw || '{}')
        } catch {
          jsonSend(res, 400, { error: 'body must be JSON' })
          return
        }
        if (!body || typeof body !== 'object' || Array.isArray(body)) {
          jsonSend(res, 400, { error: 'body must be a JSON object' })
          return
        }
        try {
          const result = await this.routerScore(body)
          jsonSend(res, 200, result)
        } catch (error) {
          const code = String(error && error.code ? error.code : '')
          const status = code === 'llm_unavailable'
            ? 503
            : (code === 'model_required' || code === 'invalid_mode' || code === 'request_required' || code === 'invalid_candidates' || code === 'invalid_model_output')
              ? 400
              : 502
          jsonSend(res, status, {
            error: String(error && error.message ? error.message : error),
            code: code || 'router_score_failed',
          })
        }
      }).catch(error => jsonSend(res, 400, { error: String(error && error.message ? error.message : error) }))
      return
    }
    if (req.method === 'GET' && url.pathname.endsWith('/board/events')) {
      this.openBoardStream(req, res)
      return
    }
    if (req.method === 'GET' && url.pathname.endsWith('/board/topic')) {
      const topicId = asString(url.searchParams.get('topicId'))
      if (!topicId) {
        jsonSend(res, 400, { error: 'topicId is required' })
        return
      }
      this.boardTopic(topicId)
        .then(data => jsonSend(res, data.ok === false ? 404 : 200, data))
        .catch(error => jsonSend(res, 500, { error: String(error && error.message ? error.message : error) }))
      return
    }
    if (req.method === 'GET' && url.pathname.endsWith('/board/ticket')) {
      const ticketId = asString(url.searchParams.get('ticketId'))
      if (!ticketId) {
        jsonSend(res, 400, { error: 'ticketId is required' })
        return
      }
      this.boardTicketDetail(ticketId)
        .then(data => jsonSend(res, data.ok === false ? 404 : 200, data))
        .catch(error => jsonSend(res, 500, { error: String(error && error.message ? error.message : error) }))
      return
    }
    if (req.method === 'GET' && url.pathname.endsWith('/board')) {
      const rawLimit = url.searchParams.get('limit')
      const rawBefore = url.searchParams.get('before')
      const limit = rawLimit === null ? 60 : Number(rawLimit)
      const before = rawBefore === null ? undefined : Number(rawBefore)
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200 || (before !== undefined && !Number.isFinite(before))) {
        jsonSend(res, 400, { error: 'limit must be 1-200 and before must be a timestamp' })
        return
      }
      this.boardData({ limit, before })
        .then(data => jsonSend(res, 200, data))
        .catch(error => jsonSend(res, 500, { error: String(error && error.message ? error.message : error) }))
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
      jsonSend(res, 200, this.settingsPayload())
      return
    }
    if (req.method === 'POST' && url.pathname.endsWith('/settings')) {
      readBody(req).then(async raw => {
        let body
        try {
          body = JSON.parse(raw || '{}')
        } catch {
          jsonSend(res, 400, { error: 'body must be JSON' })
          return
        }
        if (!body || typeof body !== 'object' || Array.isArray(body)) {
          jsonSend(res, 400, { error: 'body must be a JSON object' })
          return
        }
        const patch = {}
        if ('wechatAutoPause' in body) {
          if (typeof body.wechatAutoPause !== 'boolean') {
            jsonSend(res, 400, { error: 'body.wechatAutoPause must be a boolean' })
            return
          }
          patch.wechatAutoPause = body.wechatAutoPause
        }
        if ('approvalAutomation' in body) {
          if (typeof body.approvalAutomation !== 'boolean') {
            jsonSend(res, 400, { error: 'body.approvalAutomation must be a boolean' })
            return
          }
          patch.approvalAutomation = body.approvalAutomation
        }
        if ('approvalAutoAllow' in body) {
          const allow = body.approvalAutoAllow
          if (!allow || typeof allow !== 'object' || Array.isArray(allow)) {
            jsonSend(res, 400, { error: 'body.approvalAutoAllow must be a JSON object' })
            return
          }
          const nextAllow = {}
          if ('enabled' in allow) {
            if (typeof allow.enabled !== 'boolean') {
              jsonSend(res, 400, { error: 'body.approvalAutoAllow.enabled must be a boolean' })
              return
            }
            nextAllow.enabled = allow.enabled
          }
          if ('tools' in allow) {
            if (!Array.isArray(allow.tools) || allow.tools.some(item => typeof item !== 'string')) {
              jsonSend(res, 400, { error: 'body.approvalAutoAllow.tools must be an array of tool names' })
              return
            }
            nextAllow.tools = allow.tools
          }
          patch.approvalAutoAllow = nextAllow
        }
        if ('blockDirectUserMessages' in body) {
          if (typeof body.blockDirectUserMessages !== 'boolean') {
            jsonSend(res, 400, { error: 'body.blockDirectUserMessages must be a boolean' })
            return
          }
          patch.blockDirectUserMessages = body.blockDirectUserMessages
        }
        if ('escalationPolicy' in body) {
          const policy = normalizeEscalationPolicy(body.escalationPolicy)
          if (!policy) {
            jsonSend(res, 400, { error: 'body.escalationPolicy must be strict, auto-low or auto-low-medium' })
            return
          }
          patch.escalationPolicy = policy
        }
        if ('memory' in body) {
          const memory = body.memory
          if (!memory || typeof memory !== 'object' || Array.isArray(memory)) {
            jsonSend(res, 400, { error: 'body.memory must be a JSON object' })
            return
          }
          const nextMemory = {}
          for (const key of Object.keys(MEMORY_SETTINGS_RANGES)) {
            if (!(key in memory)) continue
            const range = MEMORY_SETTINGS_RANGES[key]
            if (!Number.isInteger(memory[key]) || memory[key] < range.min || memory[key] > range.max) {
              jsonSend(res, 400, { error: 'body.memory.' + key + ' must be an integer from ' + range.min + ' to ' + range.max })
              return
            }
            nextMemory[key] = memory[key]
          }
          if (!Object.keys(nextMemory).length) {
            jsonSend(res, 400, { error: 'body.memory must include maxChars, maxEntries or maxEntryChars' })
            return
          }
          patch.memory = nextMemory
        }
        if ('reflection' in body) {
          const reflection = body.reflection
          if (!reflection || typeof reflection !== 'object' || Array.isArray(reflection)) {
            jsonSend(res, 400, { error: 'body.reflection must be a JSON object' })
            return
          }
          if ('enabled' in reflection && typeof reflection.enabled !== 'boolean') {
            jsonSend(res, 400, { error: 'body.reflection.enabled must be a boolean' })
            return
          }
          if ('cadence' in reflection && !['daily', 'weekly'].includes(reflection.cadence)) {
            jsonSend(res, 400, { error: 'body.reflection.cadence must be daily or weekly' })
            return
          }
          if ('time' in reflection && (typeof reflection.time !== 'string' || !REFLECTION_TIME_PATTERN.test(reflection.time))) {
            jsonSend(res, 400, { error: 'body.reflection.time must be HH:MM in 24-hour time' })
            return
          }
          if ('weekday' in reflection && (!Number.isInteger(reflection.weekday) || reflection.weekday < 1 || reflection.weekday > 7)) {
            jsonSend(res, 400, { error: 'body.reflection.weekday must be an integer from 1 to 7' })
            return
          }
          for (const key of ['model', 'provider', 'reasoningEffort']) {
            if (key in reflection && reflection[key] !== null && (typeof reflection[key] !== 'string' || !reflection[key])) {
              jsonSend(res, 400, { error: 'body.reflection.' + key + ' must be a non-empty string or null' })
              return
            }
          }
          patch.reflection = reflection
        }
        if ('style' in body) {
          const style = body.style
          if (!style || typeof style !== 'object' || Array.isArray(style)) {
            jsonSend(res, 400, { error: 'body.style must be a JSON object' })
            return
          }
          const nextStyle = {}
          if ('enabled' in style) {
            if (typeof style.enabled !== 'boolean') {
              jsonSend(res, 400, { error: 'body.style.enabled must be a boolean' })
              return
            }
            nextStyle.enabled = style.enabled
          }
          if ('preset' in style) {
            if (!STYLE_PRESETS.includes(style.preset)) {
              jsonSend(res, 400, { error: 'body.style.preset must be one of ' + STYLE_PRESETS.join(', ') })
              return
            }
            nextStyle.preset = style.preset
          }
          if ('custom' in style) {
            if (typeof style.custom !== 'string') {
              jsonSend(res, 400, { error: 'body.style.custom must be a string' })
              return
            }
            if (styleCustomLength(style.custom) > STYLE_CUSTOM_LIMIT) {
              jsonSend(res, 400, { error: 'body.style.custom must be at most 300 characters' })
              return
            }
            nextStyle.custom = style.custom
          }
          if (Object.keys(nextStyle).length) patch.style = nextStyle
        }
        // wechatClawImage is fixed on. Older clients may still PATCH it; accept
        // and ignore the field instead of failing their save.
        const ignoredClawImage = 'wechatClawImage' in body
        if (!Object.keys(patch).length) {
          if (ignoredClawImage) {
            jsonSend(res, 200, this.settingsPayload())
            return
          }
          jsonSend(res, 400, { error: 'body.wechatAutoPause, body.approvalAutomation, body.escalationPolicy, body.memory, body.reflection or body.style must be provided' })
          return
        }
        if (patch.reflection) {
          const result = await this.applyReflectionSettings(patch.reflection)
          if (!result.ok) {
            jsonSend(res, 500, { error: result.error, settings: result.settings })
            return
          }
          const other = {}
          if ('wechatAutoPause' in patch) other.wechatAutoPause = patch.wechatAutoPause
          if ('approvalAutomation' in patch) other.approvalAutomation = patch.approvalAutomation
          if ('style' in patch) other.style = patch.style
          if ('memory' in patch) other.memory = patch.memory
          if (Object.keys(other).length) this.store.setSettings(other)
          const payload = this.settingsPayload()
          if (result.warning) payload.warning = result.warning
          jsonSend(res, 200, payload)
          return
        }
        this.store.setSettings(patch)
        jsonSend(res, 200, this.settingsPayload())
      }).catch(error => jsonSend(res, 400, { error: String(error && error.message ? error.message : error) }))
      return
    }
    if (req.method === 'GET' && url.pathname.endsWith('/reflection/status')) {
      const status = this.reflectionStatusSummary()
      jsonSend(res, 200, {
        lastCompletedDate: status.lastCompletedDate,
        lastStatus: status.lastStatus,
        lastError: status.lastError,
        activeRunId: status.activeRunId,
        workerSessionId: status.workerSessionId,
        scheduleId: status.scheduleId,
      })
      return
    }
    if (req.method === 'POST' && url.pathname.endsWith('/reflection/run')) {
      readBody(req).then(async raw => {
        let body = {}
        try {
          body = JSON.parse(raw || '{}')
        } catch {
          jsonSend(res, 400, { error: 'body must be JSON' })
          return
        }
        if (!body || typeof body !== 'object' || Array.isArray(body)) {
          jsonSend(res, 400, { error: 'body must be a JSON object' })
          return
        }
        if ('force' in body && typeof body.force !== 'boolean') {
          jsonSend(res, 400, { error: 'body.force must be a boolean' })
          return
        }
        const forDate = 'forDate' in body ? asString(body.forDate) : reflectionDate(now())
        if (!isReflectionDate(forDate)) {
          jsonSend(res, 400, { error: 'body.forDate must be YYYY-MM-DD' })
          return
        }
        const force = body.force === true
        const active = await this.reflectionActive(NEVER_ABORTED)
        if (active.live) {
          jsonSend(res, 409, { error: 'a reflection run is already active', runId: active.run ? active.run.runId : (active.lock && active.lock.runId) || null })
          return
        }
        const info = await this.ensure()
        const text = '[REFLECTION MANUAL] forDate=' + forDate + ' force=' + String(force) + ' — 请用 ria_reflect status/begin/dispatch/finish 跑一次反思'
        await this.ctx.sessionController.prompt({
          requestId: newId(HOST_REQUEST_PREFIX),
          sessionId: info.sessionId,
          mode: 'queue',
          content: [{ type: 'text', text }],
        }, NEVER_ABORTED)
        jsonSend(res, 202, { queued: true, forDate })
      }).catch(error => jsonSend(res, 500, { error: String(error && error.message ? error.message : error) }))
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
    if (req.method === 'GET' && url.pathname.endsWith('/channels/status')) {
      jsonSend(res, 200, {
        ok: true,
        channels: {
          wechat: this.wechat.statusView(),
          'wechat-claw': this.wechatClaw.statusView(),
          'qq-bot': this.qqBot.statusView(),
        },
      })
      return
    }
    const channelRoute = url.pathname.match(/\/channels\/(wechat|wechat-claw|qq-bot)\/(status|login|logout|start|pause)$/)
    if (channelRoute) {
      const channel = channelRoute[1] === 'wechat'
        ? this.wechat
        : channelRoute[1] === 'wechat-claw' ? this.wechatClaw : this.qqBot
      const action = channelRoute[2]
      if (req.method === 'GET' && action === 'status') {
        jsonSend(res, 200, channel.statusView())
        return
      }
      if (req.method === 'POST' && action === 'pause') {
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
          jsonSend(res, 200, channel.setPaused(body.paused, { by: 'manual', reason }))
        }).catch(error => jsonSend(res, 400, { error: String(error && error.message ? error.message : error) }))
        return
      }
      if (req.method === 'POST' && (action === 'login' || action === 'logout' || action === 'start')) {
        readBody(req).then(async () => {
          try {
            if (action === 'login') jsonSend(res, 200, await channel.startLogin())
            else if (action === 'logout') jsonSend(res, 200, await channel.logout())
            else jsonSend(res, 200, await channel.startFromCreds())
          } catch (error) {
            jsonSend(res, 500, { error: String(error && error.message ? error.message : error) })
          }
        }).catch(error => jsonSend(res, 400, { error: String(error && error.message ? error.message : error) }))
        return
      }
      jsonSend(res, 405, { error: 'method not allowed' })
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
  // v2 is the only supported plugin mode. RiaService still accepts the flag
  // for direct unit fixtures, but the plugin entry point never starts v1.
  const service = new RiaService(ctx, stateDir, { ...raw, v2: true })
  ctx.on('agent/created', ({ agent }) => { service.onAgentCreated(agent) })
  const disposeSessionEvents = service.subscribe()
  ctx.effect(() => () => {
    try { disposeSessionEvents() } catch { /* already removed */ }
  }, 'dsh-ria: ticket recovery tracking')
  const disposeV2 = service.subscribeV2()
  ctx.effect(() => () => {
    try { disposeV2() } catch { /* already removed */ }
  }, 'dsh-ria: v2 role restrictions')
  const disposeWechatEvents = service.wechat.subscribe()
  ctx.effect(() => () => {
    try { disposeWechatEvents() } catch { /* already removed */ }
    void service.wechat.shutdown()
  }, 'dsh-ria: wechat')
  const disposeWechatClawEvents = service.wechatClaw.subscribe()
  ctx.effect(() => () => {
    try { disposeWechatClawEvents() } catch { /* already removed */ }
    void service.wechatClaw.shutdown()
  }, 'dsh-ria: wechat claw')
  const disposeQqBotEvents = service.qqBot.subscribe()
  ctx.effect(() => () => {
    try { disposeQqBotEvents() } catch { /* already removed */ }
    void service.qqBot.shutdown()
  }, 'dsh-ria: qq bot')
  ctx.effect(() => () => service.grants.shutdown(), 'dsh-ria: grants')
  service.wechat.start(1200)
  service.wechatClaw.start(1600)
  service.qqBot.start(2000)
  ctx.effect(() => () => {
    for (const dispose of service.disposers.splice(0)) {
      try { dispose() } catch { /* agent disposal already removed it */ }
    }
  }, 'dsh-ria: tools')
  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: API_PREFIX, handler: (req, res) => service.httpHandler(req, res) }), 'dsh-ria: http api')
  ctx.effect(() => () => service.shutdownBoardStreams(), 'dsh-ria: board events')
  const timer = setTimeout(() => { void service.startup() }, 1500)
  if (timer.unref) timer.unref()
  ctx.effect(() => () => clearTimeout(timer), 'dsh-ria: startup recovery')
  ctx.logger.info('dsh-ria ready: stateDir=%s', stateDir)
  return service
}
