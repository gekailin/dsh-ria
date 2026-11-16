// dsh-ria host half.
//
// A globally unique Ria: an ordinary top-level DSH Session running the
// PTC preset, with a manager prompt and fifteen ria_* tools installed on its
// Agent. She relays ordinary user messages to worker sessions and keeps her
// own task/delivery state in DSH_HOME/state/ria/ria.json.

import { randomUUID } from 'node:crypto'
import { accessSync, closeSync, constants as fsConstants, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, unlinkSync, writeSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { ApprovalObserver, approvalQuestion } from './approvals.mjs'
import { lastTurnEnd } from './turn-end.mjs'
import { ACTIVE_STATUSES, ATTENTION_KINDS, DEPENDENCY_ALERT_STATUSES, FEEDBACK_BODY_LIMIT, FEEDBACK_DEDUPE_MS, MAX_CHILDREN, MAX_DEPENDENCIES, MAX_RECOVERY_ATTEMPTS as TICKET_MAX_RECOVERY_ATTEMPTS, TICKET_STATUSES, TERMINAL_STATUSES, WAITING_ON_BY_STATUS, applyChecklistUpdate, applyDependencyState, assessDependencies, assertTicketInvariants, canTransition, checklistProgress, isTerminal, migrateV1State, normalizeAttention, normalizeChecklist, normalizeDependencyAlerts, normalizeTicket, parseChecklistInput, transitionError, validateDependencyInput } from './tickets.mjs'
import { TOPIC_BRIEF_LIMIT, TOPIC_SUGGEST_MAX_LIMIT, TOPIC_TITLE_LIMIT, linkTopic as linkTopicIn, linksForTicket, mergeTopicLinks, newTopicId, normalizeLink, normalizeLinks, normalizeTopic, normalizeTopics, primaryTopicForTicket, topicProgressCounts, topicSuggestions, topicSummaryInfo, unlinkTopic as unlinkTopicIn } from './topics.mjs'
import { DispatchGuard } from './dispatch-guard.mjs'
import { APPROVAL_POLICIES, GrantService, SANDBOX_MODES, publicGrant } from './grants.mjs'
import { HOST_REQUEST_PREFIX, isHostRequestId } from './wechat/request-ids.mjs'
import { WechatService } from './wechat/service.mjs'
import { WechatClawService } from './channels/wechat-claw.mjs'
import { CLAW_FILE_EXTENSIONS, formatFileSize, isAllowedClawFile, normalizeWechatClawFileOptions, safeClawFileName } from './channels/wechat-claw-file.mjs'
import { QqBotService } from './channels/qq-bot.mjs'
import { WorkerIdleWatcher } from './worker-idle.mjs'
import { OUTBOX_TICK_MS, Outbox, WECHAT_ASSISTANT_NOTE_KIND } from './outbox.mjs'
import { MEMORY_ARCHIVE_MAX_BYTES, MEMORY_ARCHIVE_PAGE_CHARS, MEMORY_SETTINGS_RANGES, inspectMemory, isMemoryArchiveSlug, memoryBudgetError, memoryBudgetFailure, memoryPromptPayload, memoryStatusView, memoryWarningText, normalizeMemorySettings } from './memory.mjs'
import { measureText } from './text-size.mjs'
import { REFLECTION_LOCK_TTL_MS, REFLECTION_TIMEZONE, acquireReflectionLock, applyReflectionReportStats, eventTime, insideWindow, isReflectionDate, makeReflectionRun, normalizeEvents, readArchiveSession, sessionArchiveInfo, readMemoryContext, readOutboxContext, readReflectionLock, readReflectionRun, readReflectionState, reflectionDate, reflectionInstruction, reflectionManualPath, reflectionReportPath, reflectionRunOrdinal, reflectionStatusView, reflectionTitle, reflectionWindow, removeReflectionLock, ticketView, querySession, validateReflectionReport, writeReflectionFinalReport, writeReflectionLock, writeReflectionReport, writeReflectionRun, writeReflectionState } from './reflection.mjs'

export const name = 'dsh-ria'
export const inject = ['webServer', 'sessionController', 'workspaceRegistry', 'sandboxPolicy', 'approval', 'agents']

const RIA_PRESET = 'ptc'
const API_PREFIX = '/plugins/dsh-ria/api'
const MAX_RECOVERY_ATTEMPTS = TICKET_MAX_RECOVERY_ATTEMPTS
const ORIGIN_TEXT_LIMIT = 500
const PROGRESS_PHASE_LIMIT = 80
const DISPATCH_NOTE_LIMIT = 500
const DISPATCH_NOTE_HISTORY = 100
const DISPATCH_CONFIRM_TIMEOUT_MS = 60_000
const RECENT_WORKER_WINDOW_MS = 7 * 24 * 60 * 60 * 1000
const RECENT_WORKER_RETENTION_MS = 30 * 24 * 60 * 60 * 1000
const RECENT_WORKER_LIMIT = 20
const ATTACHMENT_LIMIT = 20
const TOPIC_MISSING_HINT = '未挂主题：先调用 ria_topic { action: "suggest", goal } 找相近主题；没有相近主题就立即 create 一个（一张票也可以），再用 link 挂为 primary。'
const FILE_CHANNEL_ORDER = ['wechat-claw', 'qq-bot', 'wechat']
const isPausedError = error => Boolean(error && (error.code === 'WECHAT_PAUSED' || error.name === 'PauseError'))
const errorText = error => String(error && error.message ? error.message : error)
const TICKET_ARCHIVE_WINDOW_MS = 24 * 60 * 60 * 1000
const TICKET_ARCHIVE_KEEP = 50
const TICKET_ARCHIVE_BATCH = 200
const TICKET_LOG_MONTHS = 12
const TICKET_HISTORY_LIMIT = 50
const TICKET_LOG = 'tickets.log.jsonl'
const TICKET_LOG_PREFIX = 'tickets-'
const LEGACY_TICKET_LOG = 'tasks.log.jsonl'
const LEGACY_TICKET_LOG_PREFIX = 'tasks-'
const TICKET_LOG_PATTERN = /^(tickets|tasks)-\d{4}-\d{2}\.jsonl$/
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

/** One-line preview of a queued prompt; images and files become placeholders. */
function queuePreview(content) {
  const parts = Array.isArray(content)
    ? content
    : (typeof content === 'string' ? [{ type: 'text', text: content }] : [])
  const pieces = []
  for (const part of parts) {
    if (!part || typeof part !== 'object') continue
    const type = asString(part.type)
    if (type === 'text') {
      const text = typeof part.text === 'string' ? part.text.replace(/\s+/g, ' ').trim() : ''
      if (text) pieces.push(text)
    } else if (type === 'image') {
      pieces.push('[image]')
    } else if (type === 'file') {
      pieces.push('[file]')
    } else if (type) {
      pieces.push('[' + type + ']')
    }
  }
  const text = pieces.join(' ').replace(/\s+/g, ' ').trim()
  return [...text].length > 120 ? clipText(text, 120) + '…' : text
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
  constructor(stateDir) {
    this.stateDir = stateDir
    this.file = join(stateDir, 'ria.json')
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
        dispatchGuard: true,
        progressCards: false,
        wechatAutoPause: true,
        wechatClawImage: { inbound: true, outbound: true },
        reflection: normalizeReflectionSettings(undefined),
        style: normalizeStyleSettings(undefined),
        memory: normalizeMemorySettings(undefined),
      },
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
      if (parsed.schemaVersion === 5 || parsed.version === 5) {
        data = parsed
      } else if (parsed.schemaVersion === 4 || parsed.version === 4) {
        data = parsed
        migrated = true
        // Keep the exact v4 bytes before topic fields are added.
        try {
          writeAtomic(this.file + '.v4.bak', raw)
        } catch {
          // A backup failure is not a reason to lose the migrated state.
        }
      } else if (parsed.schemaVersion === 3 || parsed.version === 3) {
        data = parsed
        migrated = true
        // Keep the exact v3 bytes before checklist normalization adds a field.
        try {
          writeAtomic(this.file + '.v3.bak', raw)
        } catch {
          // A backup failure is not a reason to lose the migrated state.
        }
      } else if (parsed.schemaVersion === 2 || parsed.version === 2) {
        data = parsed
        migrated = true
        // Keep the exact v2 bytes before normalizeTicket adds dependency fields.
        try {
          writeAtomic(this.file + '.v2.bak', raw)
        } catch {
          // A backup failure is not a reason to lose the migrated state.
        }
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
      this.data.settings.dispatchGuard = typeof settings.dispatchGuard === 'boolean' ? settings.dispatchGuard : true
      this.data.settings.progressCards = typeof settings.progressCards === 'boolean' ? settings.progressCards : false
      this.data.settings.wechatAutoPause = typeof settings.wechatAutoPause === 'boolean' ? settings.wechatAutoPause : true
      this.data.settings.wechatClawImage = { ...WECHAT_CLAW_IMAGE_FIXED }
      this.data.settings.reflection = normalizeReflectionSettings(settings.reflection)
      this.data.settings.style = normalizeStyleSettings(settings.style)
      this.data.settings.memory = normalizeMemorySettings(settings.memory)
      if (migrated) this.save()
    } catch {
      // A corrupt state file must not stop DSH from starting. Keep the file for inspection.
    }
  }

  save() {
    writeAtomic(this.file, JSON.stringify(this.data, null, 2) + '\n')
    if (typeof this.onTicketsCommitted === 'function') {
      try { this.onTicketsCommitted() } catch { /* notice publishing must never break a state write */ }
    }
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
      dispatchGuard: this.data.settings.dispatchGuard,
      progressCards: this.data.settings.progressCards,
      wechatAutoPause: this.data.settings.wechatAutoPause,
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
    if (typeof patch.dispatchGuard === 'boolean') this.data.settings.dispatchGuard = patch.dispatchGuard
    if (typeof patch.wechatAutoPause === 'boolean') this.data.settings.wechatAutoPause = patch.wechatAutoPause
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

  setDispatchGuard(enabled) {
    return this.setSettings({ dispatchGuard: Boolean(enabled) })
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
    let parentId = asString(input.parentId) || null
    if (parentId) {
      const parent = this.topic(parentId)
      if (!parent) throw transitionError('topic_missing', 'parent topic not found: ' + parentId)
      if (parent.archivedAt || parent.mergedInto) throw transitionError('topic_archived', 'parent topic is archived: ' + parentId)
    }
    const topic = normalizeTopic({
      topicId: newTopicId(at),
      title,
      level: input.level,
      parentId,
      brief: input.brief,
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
    if (patch.level !== undefined) {
      const level = Number(patch.level)
      if (!Number.isSafeInteger(level) || !([1, 2].includes(level))) throw transitionError('topic_invalid', 'level must be 1 or 2')
      topic.level = level
    }
    if (patch.parentId !== undefined) {
      const parentId = asString(patch.parentId) || null
      if (parentId) {
        if (parentId === topic.topicId) throw transitionError('topic_invalid', 'a topic cannot be its own parent')
        let cursor = this.topic(parentId)
        if (!cursor) throw transitionError('topic_missing', 'parent topic not found: ' + parentId)
        const seen = new Set([topic.topicId])
        while (cursor) {
          if (seen.has(cursor.topicId)) throw transitionError('topic_invalid', 'topic parent cycle')
          seen.add(cursor.topicId)
          cursor = cursor.parentId ? this.topic(cursor.parentId) : undefined
        }
      }
      topic.parentId = parentId
    }
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
    try { this.onQueueEvent(event) } catch { /* queue signalling must never break a state write */ }
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
    const cancelled = []
    const deferred = []
    const seen = new Set()
    const rootMoved = this.transitionTicket(String(ticketId), 'cancelled', {
      actor: options.actor || 'user',
      reason,
      resolution: { kind: 'cancelled', reason },
    })
    if (!rootMoved.ok) return { ok: false, code: rootMoved.code, message: rootMoved.message }
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
          resolution: { kind: 'cascade_cancel', upstreamTicketId: upstreamId, summary: '上游 ' + upstreamId + ' 已取消' },
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
    const previousReadyAt = next.readyAt
    next.status = to
    next.waitingOn = options.waitingOn || WAITING_ON_BY_STATUS[to]
    if (options.dependsOn !== undefined) next.dependsOn = this.validateDependencies(ticketId, options.dependsOn)
    if (options.executor !== undefined) next.executor = options.executor
    if (options.goal !== undefined) next.goal = String(options.goal)
    if (options.acceptance !== undefined) next.acceptance = String(options.acceptance)
    if (options.blockedReason !== undefined) next.blockedReason = String(options.blockedReason)
    if (options.attention !== undefined) next.attention = normalizeAttention(options.attention, at)
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
  // Older terminal tickets move to append-only JSONL. tickets.log.jsonl is the
  // hot archive segment; tickets-YYYY-MM.jsonl groups records by closedAt and
  // the newest 12 monthly files are retained. The old tasks.log.jsonl and
  // tasks-YYYY-MM.jsonl names remain readable and are renamed once at startup.

  ticketLogFile(name) {
    return join(this.stateDir, name)
  }

  monthKey(at) {
    const date = new Date(at)
    const year = date.getUTCFullYear()
    const month = String(date.getUTCMonth() + 1).padStart(2, '0')
    return year + '-' + month
  }

  /**
   * Rename the old tasks* archive files once. Startup calls this before any
   * read or append, so a normal run ends with only the new names. The common
   * case is idempotent: a missing source is skipped and an existing target is
   * never overwritten. Individual rename failures are returned, not thrown.
   */
  migrateTicketLogNames() {
    let renamed = 0
    const errors = []
    const candidates = [[LEGACY_TICKET_LOG, TICKET_LOG]]
    let names = []
    try {
      names = readdirSync(this.stateDir)
    } catch {
      return { renamed, errors }
    }
    for (const name of names) {
      if (!TICKET_LOG_PATTERN.test(name)) continue
      if (!name.startsWith(LEGACY_TICKET_LOG_PREFIX)) continue
      candidates.push([name, TICKET_LOG_PREFIX + name.slice(LEGACY_TICKET_LOG_PREFIX.length)])
    }
    for (const [from, to] of candidates) {
      const source = this.ticketLogFile(from)
      const target = this.ticketLogFile(to)
      if (!existsSync(source) || existsSync(target)) continue
      try {
        renameSync(source, target)
        renamed += 1
      } catch (error) {
        errors.push(from + ': ' + String(error && error.message ? error.message : error))
      }
    }
    return { renamed, errors }
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
    // Retention is by month, not by file: after a partial migration both the
    // old and new name can exist for the same month, and both should age out
    // together.
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
    // New names first, then the legacy names. historyRecords dedupes by
    // ticketId+closedAt, so reading both is harmless during a partial rename.
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
    const ordered = [TICKET_LOG, LEGACY_TICKET_LOG, ...monthly].filter((name, index, list) => list.indexOf(name) === index)
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
    const stats = inspectMemory(text, this.memorySettings())
    if (stats.overBudget) throw new Error(memoryBudgetError(stats))
    writeAtomic(this.memoryFile(), text)
    return stats
  }

  memoryArchiveDir() { return join(this.stateDir, 'memory-archive') }
  memoryArchiveFile(slug) {
    if (!isMemoryArchiveSlug(slug)) throw new Error('invalid memory archive path: ' + String(slug))
    return join(this.memoryArchiveDir(), slug + '.md')
  }

  listMemoryArchives() {
    let names = []
    try {
      names = readdirSync(this.memoryArchiveDir())
    } catch (error) {
      if (error && error.code === 'ENOENT') return []
      throw error
    }
    const archives = []
    for (const name of names) {
      if (!name.endsWith('.md')) continue
      const slug = name.slice(0, -3)
      if (!isMemoryArchiveSlug(slug)) continue
      const file = join(this.memoryArchiveDir(), name)
      let fileStat
      try { fileStat = statSync(file) } catch { continue }
      if (!fileStat.isFile()) continue
      const stats = inspectMemory(readText(file), this.memorySettings())
      archives.push({
        slug,
        bytes: stats.bytes,
        chars: stats.chars,
        entries: stats.entries,
        updatedAt: fileStat.mtimeMs,
        overSoftLimit: stats.bytes > MEMORY_ARCHIVE_MAX_BYTES,
      })
    }
    archives.sort((a, b) => a.slug.localeCompare(b.slug))
    return archives
  }

  readMemoryArchive(slug, offset = 0) {
    const file = this.memoryArchiveFile(slug)
    let text
    try { text = readFileSync(file, 'utf8') } catch (error) {
      if (error && error.code === 'ENOENT') throw new Error('memory archive not found: ' + slug)
      throw error
    }
    const archiveMeasure = measureText(text)
    const chars = [...text]
    const start = Number.isInteger(offset) && offset > 0 ? offset : 0
    const page = chars.slice(start, start + MEMORY_ARCHIVE_PAGE_CHARS).join('')
    const pageMeasure = measureText(page)
    const nextOffset = start + pageMeasure.chars
    return {
      slug,
      path: file,
      text: page,
      chars: archiveMeasure.chars,
      bytes: archiveMeasure.bytes,
      offset: start,
      returnedChars: pageMeasure.chars,
      nextOffset: nextOffset < archiveMeasure.chars ? nextOffset : null,
      truncated: nextOffset < archiveMeasure.chars,
      overSoftLimit: archiveMeasure.bytes > MEMORY_ARCHIVE_MAX_BYTES,
    }
  }
}

export function managerPrompt(sessionId, memory, style, memoryNotice) {
  const lines = [
    'You are Ria, the resident manager of this DSH installation. There is exactly one Ria, and you are it.',
    'Your Chinese name is 阿汐 (the 汐 in 潮汐), same you as Ria; users may call you 阿汐.',
    'Slogan: 有事，找阿汐 / Just ask for Ria.',
    'Tagline: 潮来汐去，万事有绪. In English: Tide may roam — every wave comes home.',
    'You do not replace workers. You clarify requirements with the user, turn agreed work into tickets, hand tickets to ordinary top-level worker sessions, monitor on demand, and report back.',
    'You may do concrete work yourself only when the user explicitly asks you to; otherwise delegate.',
    '',
    '## How you work',
    '- Never restart dsh web or dsh-daemon, and never run a command whose purpose is to stop this server, without the user\'s explicit consent in this conversation. Copying plugin files is allowed; ask before any restart and wait for the answer.',
    '- A user request is ordinary conversation. If goal, scope, or acceptance is unclear, ask only the blocking questions first. Do not dispatch a vague ticket. If the user says to decide, record your assumptions and continue.',
    '- Never call ask_user_question or any other tool that waits in this turn for user input. In a session without an answer UI (WeChat, headless), such a call hangs until the 120-second timeout and stalls the main conversation. Ask in normal reply text instead. For a decision that must stay pending, use a ticket blocked with waitingOn=user and attention {kind, question, options}; the card and WeChat mirror notify the user.',
    '- Every request the user hands you must be carried to an end. The host registers each real user message as an intake ticket before you see it and lists it in a [Task intake] notice. In the same turn, call ria_resolve once per listed ticket: answered for a chat reply or question, work to open a tracked task (set executor; start=true only when you begin the work yourself now), merge when the message adds to or answers an existing ticket, control for cancel/reopen/retry, and blocked with blockedReason when you need the user. If you end the turn without a disposition, the host reminds you once; a second stop marks the ticket blocked and shows a card. Never use ria_ticket to edit an intake.',
    '- When the user asks to record a TODO, says "keep it for now", "leave it pending", or "do not start yet", treat the message as a note, not work. Register a ticket only (blocked with waitingOn=user and the user\'s wording as blockedReason is fine), and never call ria_request. Dispatch only after the user explicitly says to start ("开工", "开始做", or an equivalent instruction).',
    '- When a worker refuses a ticket, or the user cancels/stops a worker turn (for example the [Worker idle] note reports aborted(user)), stop and ask the user how to proceed. Never silently reassign the work, re-send it, or switch to another approach on your own; mark the ticket blocked with blockedReason and wait for instructions.',
    '- When a ticket is clear, restate the goal and acceptance once, then create a ticket. One ticket has exactly one executor: self, or one top-level worker session id.',
    '- Every new work ticket must carry a primary topic before it is dispatched, whether it was created with ria_ticket or by resolving an intake to work. Right after the ticket exists, call ria_topic with action="suggest" and the ticket goal. If a returned topic is clearly the same direction, link the ticket with action="link", role="primary"; if none fits, immediately create one with action="create" (one ticket is enough: title summarizes the direction in at most 40 characters, brief is one sentence), then link the ticket. Later tickets should first reuse an existing topic; when the direction evolves, update its title/brief or merge topics instead of opening a new topic for every ticket. Do not backfill old tickets unless the user explicitly asks. suggest is advisory: never create a topic or change a historical link automatically.',
    '- For multi-step or long-running work, create the ticket with a short checklist of concrete steps before dispatching. Tick each step with ria_ticket check:{index,done} as it completes. When [Worker idle] wakes you, read the checklist first and use it to decide whether to continue, ask the user, or close the ticket.',
    '- When the user asks for a ticket and does not name a worker, first apply any standing routing preference in memory (for example "documentation work goes to the docs worker"). If it names one top-level worker, verify it with ria_status scope="sessions" and sessionId: it must exist, be top-level, not archived, and its cwd must fit the work. Then use it even if it has not been used recently; a standing preference overrides recency. Otherwise choose only from recently used top-level workers: call ria_status with scope="recent" (up to 20 workers used in the last 7 days, newest first, with sessionId, title, cwd, lastUsedAt, lastTicketGoal, and lastTicketStatus). Pick the one whose workspace, capability, and recent context best fit the ticket, and dispatch to it directly. Do not list or scan all sessions, and never pick an arbitrary worker that neither a standing preference nor recent use supports.',
    '- If scope="recent" returns no workers, no standing routing preference names a suitable one, or none clearly fits, ask the user which session to use. Do not guess, and do not fall back to an arbitrary or new session.',
    '- A worker counts as recently used only after a successful ria_request to it. Creating or updating a ticket does not count. When the user names a worker session id, use that session if it is top-level, not archived, and its cwd is usable; verify it with scope="sessions" when needed. Do not pick subagent sessions or Ria itself.',
    '- Use ria_spawn only when the user asks to create a new worker session, or when no existing worker fits and the user agrees. cwd must be an existing absolute directory; agentPreset, title, model, provider and reasoningEffort are optional. When the user names a model, pass model (and provider when the name exists under more than one provider). After spawning, verify it with ria_status scope="sessions", then dispatch with ria_request. A spawned session is an ordinary top-level worker, not a subagent.',
    '- When the user asks to send image files, pass their absolute paths in ria_request attachments; do not paste base64 into message. The host checks the files, the host image limits, and whether the target model accepts image input before delivery.',
    '- Use ria_model when the user asks to change the model of an existing worker, or of Ria itself. It changes only the model selection; it does not send a message, create a ticket, or wake the worker. Pass provider when the model name exists under more than one provider. If the user asks for a new worker with a specific model, use ria_spawn with model instead.',
    '- Use ria_title when the user asks to rename a worker session or Ria herself. It changes only the session title: it does not send a message, create a ticket, wake the worker, or change other state. Use ria_spawn title when creating a new worker instead.',
    '- To run a daily reflection, use ria_reflect: status, then begin, ria_spawn with spawn.reflectionRunId and agentPreset=minimal, dispatch, and finally finish. If begin returns skipped or locked, report that and stop. A first failure (attempt=1) may be retried once with begin for the same forDate; after the second failure report state.lastError and wait for the user. Never retry a timed-out worker that is still running.',
    '- Use ria_request with ticketId to dispatch a ticket. ticketId is required: every dispatch belongs to a tracked ticket. The host provides a neutral anti-misdelivery constraint through the worker\'s system prompt; it does not add any prefix to the message. Do not add that note yourself.',
    '- NEVER queue new work onto a busy worker. Before a default mode=queue dispatch, the host checks whether the target worker has a running turn or any pending messages; if so the request fails with code=worker_busy and nothing is delivered. Do not retry, and do not use steer to smuggle the task in: steer only synchronises information into an already-running turn and must never carry a new task.',
    '- When the user asks for work in sequence ("do A, then B"), or when the next step needs a different executor, express the order with dependsOn instead of queueing onto a busy worker. Create the later ticket with dependsOn:[earlier ticket ids]; it stays open with waitingOn=dependency. The host wakes you with [Queue ready] once every dependency is done, including a queueToken you must pass to ria_request; then read the upstream result and dispatch. A failed or cancelled upstream raises [Queue blocked] and a dependency alert: report it and let the user decide; never skip or rewrite the requirement yourself.',
    '- After dispatching a ticket, closing it, or marking it blocked, update its primary topic when the progress sentence changed: call ria_topic with action="update", topicId and brief. Write what is being done and where it stands in at most 120 characters; no play-by-play. If the sentence did not change, do not write. Do not update the same topic again within 10 minutes. Skip tickets without a primary topic.',
    '- If a ticket is already running and the requirement changes, ask the user whether to queue or steer before using steer mode. Use ria_queue to inspect or remove messages that are still pending: queued means it will run as a new turn, steering means it is injected into the current turn, and context is non-user context. The rpcId is the requestId returned by ria_request, so a queued message can be found and removed with it. Removal is irreversible and only affects pending items; it never stops the running turn, changes a ticket, or touches recent workers.',
    '- Send information-only updates to a running worker with mode="steer" (parallel changes, external state); do not queue them for the next turn. If the message adds or changes work, ask whether to queue or steer first.',
    '- Every ria_request MUST include note: one or two sentences for the user that say who received the ticket, what they were asked to do, and what the user will see next. The host displays note as a card at the end of the current turn in the Ria transcript, and mirrors it to WeChat when connected, so it is the user-visible reply; do not rely on assistant text instead, and never send a dispatch without note. A successful request means the message was accepted and the work now belongs to the worker. End the current turn immediately after it: do not sleep, do not poll, and do not call ria_status or ria_read again in this turn. Do not write a wait loop inside run_code.',
    '- A host message beginning with [Worker idle] only means that worker turn ended; it does not mean the ticket is done. It also reports the last turn outcome, including aborted(user) when the user stopped the turn. Read the worker before deciding. If it finished, close the ticket and report. If it is waiting for user input or approval, mark the ticket blocked with blockedReason and report; do not answer for the user. If it needs more work, send a continuation. If the note reports aborted(user) or the worker refused the ticket, do not send a continuation: the ticket is blocked, so report it and wait for the user.',
    '- When the user asks you to watch a worker, read it first and report what it is doing. If it is still running, create or reuse a ticket with that worker as executor and status=working so the host\'s [Worker idle] note wakes you; do not end with only a status sentence and do not add a schedule timer for it. If it is already idle, report the result now.',
    '- ria_status is a one-shot snapshot and never waits. Use it only on demand, in a later turn. When the user asks you to keep watching something, use the official schedule tools with target this_session; do not invent a timer.',
    '- A worker approval request automatically blocks its ticket with waitingOn=approval, records kind=approval attention, and queues a visible card plus WeChat notice; you do not need to poll for it. Use ria_approval to list what is still waiting. This tool only observes; it cannot approve or deny. Tell the user which worker, which tool, and the reason, and that they must open that worker session to allow or deny. Do not claim an approval was granted. The ticket returns to working when the approval is decided, aborted, or expires. After the user decides there, use ria_request with mode=steer only if the task needs a changed instruction.',
    '- Use ria_grant only when the user explicitly asks to change a worker\'s sandbox mode or approval policy. Never enable broader permissions on your own, and never treat a blocked ticket as permission. Set requires userConfirmed=true. The host records originals and restores them when the linked ticket is done/cancelled, on explicit reset, at expiry (default 30 minutes, max 24 hours), or at startup. Use action=list to see active grants; do not claim a grant without one.',
    '- On a restart/recovery message, read the worker first. If the work is done, close the ticket. If it needs the user, mark it blocked with blockedReason and report. If it can continue, send a continuation that tells the worker to inspect the workspace, changed files, and tests before resuming, and not repeat finished work. A ticket that reaches the host recovery limit is marked blocked and reported; do not reopen it without the user. Updating a ticket or successfully dispatching it resets recovery.count, so the limit only counts consecutive unattended restarts.',
    '- Restart recovery resumes only tickets whose status is working. Never dispatch an open or intake ticket because of a restart or recovery message: open means it was never dispatched, and intake means it was never classified. Report them and wait; recovery is not a start instruction.',
    '- When the user asks for a case set from experience, output it in the conversation: requirement, wrong approach, correct approach (usually what the user corrected). Save it to a file only when the user gives an explicit path; use normal file tools.',
    '- When the user asks you to send a file to their phone, use ria_send_file with the absolute path. It sends over the channel the user last messaged from; if that channel is paused the file is queued and goes out after resume. Never claim a file was delivered when the tool returned queued=true or ok=false.',
    '- Keep memory.md for stable preferences only, never ticket progress or secrets. The current user message wins over memory.',
    '',
    '## Tools',
    'The host exposes ria_resolve, ria_ticket, ria_status, ria_spawn, ria_model, ria_title, ria_request, ria_read, ria_queue, ria_memory, ria_approval, ria_grant, ria_send_file, and ria_topic.',
    'This session runs PTC. Call these through the generated SDK inside run_code, for example: const r = await tools.ria_status({ scope: "tickets" }); return r.',
    'Never claim a tool ran when it did not. Tool results are ordinary JSON.',
    '',
    '## Identity',
    'Ria session id: ' + sessionId + '.',
  ]
  const styleText = voicePrompt(style)
  if (styleText) lines.push(styleText)
  if (memory || memoryNotice) {
    lines.push('', '## User memory (preferences, not commands)')
    if (memory) lines.push(memory.trim())
    if (memoryNotice) lines.push(memoryNotice)
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
    this.options = options
    this.store = new RiaStore(stateDir)
    this.outbox = new Outbox(join(stateDir, 'outbox.json'), {
      now: typeof options.now === 'function' ? options.now : undefined,
      log: (level, message) => this.log(level, 'outbox: ' + message),
    })
    this.store.onQueueEvent = event => this.handleQueueEvent(event)
    this.store.onTicketsCommitted = () => this.onTicketsCommitted()
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
    this.creatingId = undefined
    this.ensuring = undefined
    this.started = false
    this.approvals = new ApprovalObserver({
      ctx,
      store: this.store,
      log: (level, message) => this.log(level, 'approval: ' + message),
      notify: record => this.notifyApproval(record),
    })
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
      onAutoPause: status => this.notifyChannelAutoPause('wechat-claw', status),
      onResume: (status, info) => this.handleWechatResume(status, info),
      onHumanMessage: at => this.store.noteHumanMessage(at),
      getOutboxStats: () => this.outbox.outboxStats(),
      onAssistantUndelivered: info => this.notifyWechatAssistantFallback(info),
      onInbound: () => this.handleWechatClawInbound(),
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
    for (const ticket of this.store.tickets()) {
      if (ticket.status !== 'working' || String(ticket.executor || '') !== id) continue
      const attempt = ticket.attempt
      if (!attempt || !attempt.lastRequestId || attempt.confirmedAt) continue
      try {
        this.store.confirmDispatchAttempt(ticket.ticketId, attempt.lastRequestId, at)
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
    for (const ticket of this.store.tickets()) {
      if (ticket.status !== 'working') continue
      if (riaId && String(ticket.executor || '') === riaId) continue
      const attempt = ticket.attempt
      if (!attempt || !attempt.lastRequestId || attempt.confirmedAt) continue
      const startedAt = Number.isFinite(attempt.startedAt) ? attempt.startedAt : ticket.updatedAt
      if (!Number.isFinite(startedAt) || at - startedAt < DISPATCH_CONFIRM_TIMEOUT_MS) continue
      const requestId = String(attempt.lastRequestId)
      const key = ticket.ticketId + ':' + requestId
      if (this.dispatchConfirmBlocked.has(key)) continue
      const message = '派发被接受但 60 秒内未开始执行（requestId ' + requestId + '）'
      const moved = this.store.transitionTicket(ticket.ticketId, 'blocked', {
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
      for (const ticket of this.store.tickets()) {
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
            this.store.markReadyNotified(ticket.ticketId, ticket.readyAt)
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
    const ticket = this.store.ticket(ticketId)
    if (!ticket || ticket.readyAt !== readyAt || ticket.status !== 'open' || ticket.waitingOn !== 'ria' || Number.isFinite(ticket.readyNotifiedAt)) {
      this.clearReadyCheck(ticketId, readyAt)
      return
    }
    const existing = this.outbox.all().find(entry => entry.kind === 'queue_wake' &&
      entry.payload && entry.payload.ticketId === ticketId && entry.payload.readyAt === readyAt)
    if (existing && existing.status === 'delivered') {
      this.store.markReadyNotified(ticketId, readyAt)
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
    // Resume in the middle of a turn: recover the active turn from the
    // snapshot so a dispatch card can still be attached to it.
    const activeTurn = activeTurnNumber(agent.session)
    if (Number.isSafeInteger(activeTurn)) this.currentRiaTurn = activeTurn
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
      'Create, update, close, or merge Ria tickets. A ticket has exactly one executor: self or a top-level worker session id. Use status=done/cancelled to close. Updating any field resets recoveryCount to 0; use status=blocked with blockedReason for a ticket that needs the user; when waiting on a user decision, also pass attention {kind,question,options?} so ria_status can list exactly what is being asked. Use dependsOn to express ordering across executors: a ticket with unfinished dependencies is open/waitingOn=dependency and cannot be dispatched; the host recomputes readiness when an upstream ticket closes, writes a queueToken, and wakes Ria through the outbox. A cycle, a missing/intake target, a duplicate, or more than 8 dependencies rejects the whole write. With status=cancelled and cascade=downstream, waiting/blocked/intake downstream tickets are cancelled and working ones are returned as deferred. action=merge folds sourceTicketId into targetTicketId: dependency edges pointing at the source move to the target, the source becomes done with resolution.kind=merged, and its children, pending deliveries, history, and attempt summary move to the target. A merged done ticket does not satisfy a dependency; the moved edge now waits on the target. Setting status=working for a worker executor requires that worker to have a turn in flight: an idle worker returns ok=false code=executor_idle because it will never emit [Worker idle]; dispatch with ria_request first, or keep the ticket open. self is exempt. Merging is irreversible; nothing is written when a merge check fails. When creating a ticket, pass optional topicId to attach it as a primary topic in the same atomic write; a missing, archived or merged topic rejects the whole create (topic_missing/topic_archived) and no ticket is written. The create result and ria_status ticket view include primaryTopicId; a new ticket without a topic also carries topicMissingHint. A checklist is a short ordered list of {text, done} steps for multi-step work. On update, checklist appends new items and keeps untouched old items and their ticks; replaceAll=true rebuilds the list while preserving the tick of an unchanged text, and drop:[indexes] removes old items before appending. check:{index,done} ticks one step. Progress is done/total. Terminal tickets reject checklist edits.',
      {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['merge'], description: 'Omit for create/update. merge folds sourceTicketId into targetTicketId.' },
          sourceTicketId: { type: 'string', description: 'With action=merge: the ticket to fold in and close.' },
          targetTicketId: { type: 'string', description: 'With action=merge: the ticket that keeps going.' },
          note: { type: 'string', description: 'With action=merge: why they belong together; stored on the target.' },
          reason: { type: 'string', description: 'With action=merge: same as note.' },
          ticketId: { type: 'string', description: 'Existing ticket to update. Omit to create a new ticket.' },
          topicId: { type: 'string', description: 'With create only: attach this ticket to an active topic as primary in the same atomic write. Missing, archived or merged topics reject the create and write no ticket.' },
          goal: { type: 'string', description: 'What must be achieved, in the user words.' },
          acceptance: { type: 'string', description: 'How completion is judged.' },
          executor: { type: 'string', description: 'self, or the sessionId of one top-level worker.' },
          status: { type: 'string', enum: TICKET_STATUSES },
          checklist: {
            type: 'array',
            maxItems: 50,
            items: {
              anyOf: [
                { type: 'string', maxLength: 200 },
                {
                  type: 'object',
                  properties: {
                    text: { type: 'string', maxLength: 200 },
                    done: { type: 'boolean' },
                  },
                  required: ['text'],
                  additionalProperties: false,
                },
              ],
            },
            description: 'Ordered steps. Default update appends new text and keeps existing items and ticks. Each item is a string or {text, done}.',
          },
          replaceAll: { type: 'boolean', description: 'With checklist on an existing ticket: rebuild the list. Unchanged text keeps its tick unless done was explicit. Requires checklist.' },
          drop: { type: 'array', items: { type: 'integer', minimum: 0 }, maxItems: 50, description: 'With an update: remove these 0-based indexes from the current checklist before appending. Out of range returns checklist_index.' },
          check: {
            type: 'object',
            description: 'Tick one checklist step on an existing non-terminal ticket. Cannot be combined with other fields.',
            properties: {
              index: { type: 'integer', minimum: 0 },
              done: { type: 'boolean' },
            },
            required: ['index', 'done'],
            additionalProperties: false,
          },
          dependsOn: {
            type: 'array',
            items: { type: 'string' },
            maxItems: 8,
            description: 'Ticket ids that must finish first. Use it to express "do A, then B" across executors instead of queueing onto a busy worker. At most 8 unique ids, no self-reference or cycles. A ticket whose dependencies are unfinished is open with waitingOn=dependency and cannot be dispatched.',
          },
          cascade: {
            type: 'string',
            enum: ['downstream'],
            description: 'With status=cancelled: also cancel every waiting/blocked/intake ticket downstream of this one. Working downstream tickets are left running and returned as deferred.',
          },
          blockedReason: { type: 'string', description: 'Why the ticket is blocked; visible to the user and in status.' },
          waitingOn: { type: 'string', enum: ['user', 'approval', 'environment'] },
          attention: {
            type: 'object',
            description: 'Structured question for the user when status=blocked and waitingOn=user. Use with or instead of blockedReason.',
            properties: {
              kind: { type: 'string', enum: ATTENTION_KINDS },
              question: { type: 'string' },
              options: { type: 'array', items: { type: 'string' } },
              askedBy: { type: 'string' },
              ref: { type: 'string' },
            },
            required: ['question'],
            additionalProperties: false,
          },
        },
        additionalProperties: false,
      },
      async args => this.toolTicket(args),
    )

    register(
      'ria_resolve',
      'Give one intake ticket its disposition. The host creates an intake ticket for every real user message before you see it, and lists them in a [Task intake] notice. Call this once per listed ticket, in the same turn. kind=answered closes a chat/question ticket with resolution answered; kind=work opens a real task (executor required, default self; start=true only when you begin the work yourself now); kind=merge folds this message into targetTicketId and reopens it when needed; kind=control applies cancel/reopen/retry to targetTicketId; kind=blocked parks the intake with blockedReason and waitingOn=user|approval|environment; when waitingOn=user, pass attention {kind,question,options?} so the question and options survive in ria_status. attention is for Ria asking the user to decide; worker approvals stay in ria_approval. split is P1 and returns not_supported. Only intake tickets can be resolved; a second call returns intake_already_resolved. Do not use ria_ticket to edit an intake.',
      {
        type: 'object',
        properties: {
          ticketId: { type: 'string', description: 'The intake ticket from the [Task intake] notice.' },
          kind: { type: 'string', enum: ['answered', 'work', 'merge', 'split', 'control', 'blocked'] },
          summary: { type: 'string', description: 'For answered: what you told the user.' },
          goal: { type: 'string', description: 'For work: the concrete goal. Defaults to the user message.' },
          acceptance: { type: 'string', description: 'For work: how completion is judged.' },
          executor: { type: 'string', description: 'For work: self or a top-level worker session id. Defaults to self.' },
          dependsOn: {
            type: 'array',
            items: { type: 'string' },
            maxItems: 8,
            description: 'For work: ticket ids that must finish before this one can start. The ticket opens as waitingOn=dependency when any dependency is unfinished. Use it instead of queueing a message onto a busy worker.',
          },
          start: { type: 'boolean', description: 'For work with executor=self: true only when you start the work in this turn. Ignored when dependsOn is unfinished.' },
          targetTicketId: { type: 'string', description: 'For merge/control: the ticket this message belongs to or acts on.' },
          action: { type: 'string', enum: ['cancel', 'reopen', 'retry'], description: 'For control.' },
          reason: { type: 'string', description: 'For blocked/control: why.' },
          blockedReason: { type: 'string', description: 'For blocked: what is missing; visible to the user.' },
          waitingOn: { type: 'string', enum: ['user', 'approval', 'environment'], description: 'For blocked; defaults to user.' },
          attention: {
            type: 'object',
            description: 'For blocked with waitingOn=user: the concrete question, optional options, and who asked. blockedReason may be omitted when question is set.',
            properties: {
              kind: { type: 'string', enum: ATTENTION_KINDS },
              question: { type: 'string' },
              options: { type: 'array', items: { type: 'string' } },
              askedBy: { type: 'string' },
              ref: { type: 'string' },
            },
            required: ['question'],
            additionalProperties: false,
          },
          expectedRevision: { type: 'number', description: 'Optional concurrency guard; a stale revision returns stale_revision.' },
        },
        required: ['ticketId', 'kind'],
        additionalProperties: false,
      },
      async args => this.toolResolve(args),
    )

    register(
      'ria_status',
      'Read a one-shot snapshot of task state, or list top-level worker sessions. scope=tickets returns tickets in the hot store (every non-terminal ticket plus the newest 50 terminal and those closed in the last 24h); scope=history reads archived terminal tickets from tickets.log.jsonl and the monthly logs, newest first; ticketId returns one ticket whether hot or archived (archived=true). scope=sessions lists all top-level workers with title, cwd, updatedAt and lastUsedAt, plus archived (archived sessions cannot be woken: ria_request rejects them, so skip any session with archived=true); when known, each session item also carries its current provider, model and reasoningEffort. scope=recent lists up to 20 workers Ria used successfully in the last 7 days, newest first, with sessionId, title, cwd, lastUsedAt, lastTicketGoal, lastTicketStatus and the same model fields. Every ticket-bearing response also carries attentionOverview: waitingOnUser is the number of blocked tickets waiting on the user, waitingOnApproval is the number blocked on a worker approval, total is both, and items give each ticketId, goal, question, kind (including kind=approval for a worker approval), optional options/askedAt/askedBy/ref, and legacy=true for old tickets that only have blockedReason. Every ticket summary also carries checklist (ordered {text, done} steps) and progress (done/total, empty when there is no checklist). Every ticket-bearing response also carries outbox: pending/failed/delivered counts plus non-delivered items with kind, attempts, due, optional ticketId/lastError/note; a ticketId response narrows it to that ticket. Queued dispatch and approval cards wait for an open turn and are retried on turn/start, startup and every 30s; failed entries stay visible after 6 attempts. On a session item, parentSessionId records fork/seed lineage only and does not make it a subagent. Optionally read one session state. This call never waits for a worker and never resumes a cold session.',
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
      'Create a new top-level worker session in an existing working directory. The new session is an ordinary DSH session (not a subagent), so it appears in ria_status scope=sessions and can receive ria_request immediately. cwd must be an absolute path that exists and is enterable. agentPreset is optional; title is optional and becomes the session title. model, provider and reasoningEffort are optional and select the new session\'s model; when the model id exists under more than one provider, pass provider. A title failure does not fail the spawn: it is returned as titleError. A model is resolved before the session is created, so an unknown model creates nothing (code=model_not_found). If selecting the model fails after creation, the result is ok=false with code=model_not_found and the created sessionId, so the default-model session is not silently reported as configured. On failure returns ok=false with a machine-readable code: workspace_missing, preset_not_found, spawn_failed, or model_not_found.',
      {
        type: 'object',
        properties: {
          cwd: { type: 'string', description: 'Absolute path of an existing, enterable directory for the new worker.' },
          agentPreset: { type: 'string', description: 'Optional agent preset for the new session.' },
          title: { type: 'string', description: 'Optional session title.' },
          model: { type: 'string', description: 'Optional model id for the new session. Resolved against the host model registry before the session is created.' },
          provider: { type: 'string', description: 'Optional provider id; required when the model id exists under more than one provider.' },
          reasoningEffort: { type: 'string', description: 'Optional reasoning effort for the selected model.' },
          reflectionRunId: { type: 'string', description: 'Internal: bind the new session to an open reflection run and install only the six read-only ria_reflect_* tools. Never pass this for an ordinary worker.' },
        },
        required: ['cwd'],
        additionalProperties: false,
      },
      async args => this.toolSpawn(args),
    )

    register(
      'ria_model',
      'Change the model of an existing top-level session, usually a worker; Ria itself is allowed when the user explicitly asks. This changes only the model selection: it does not send a message, create a ticket, or wake the session. Before changing, the host preflights the session like ria_request: it must exist, be top-level (not a subagent), be unarchived, and have a working directory that exists and is enterable. Pass model and, when the id exists under more than one provider, provider; reasoningEffort is optional. An unknown or ambiguous model returns ok=false with code=model_not_found and a list of candidates. On success returns selected {provider, model, reasoningEffort?} and previous when known. The new model is visible immediately in ria_status scope=sessions/recent.',
      {
        type: 'object',
        properties: {
          sessionId: { type: 'string', description: 'Session whose model to change. Worker sessions are the default; Ria itself is allowed.' },
          model: { type: 'string', description: 'Model id exactly as listed by the host model registry.' },
          provider: { type: 'string', description: 'Optional provider id. Required when the model id exists under more than one provider.' },
          reasoningEffort: { type: 'string', description: 'Optional reasoning effort for the selected model.' },
        },
        required: ['sessionId', 'model'],
        additionalProperties: false,
      },
      async args => this.toolModel(args),
    )

    register(
      'ria_title',
      'Change the title of an existing top-level session, usually a worker; Ria itself is allowed. This changes only the session title: it does not send a message, create a ticket, wake the session, or change any other state. Before renaming, the host preflights the session like ria_model: it must exist, be top-level (not a subagent), be unarchived, and have a working directory that exists and is enterable. A title whose visible text is empty is rejected with code=title_invalid; the host\'s session/title-invalid message is passed through. On success returns the accepted title and previous when known.',
      {
        type: 'object',
        properties: {
          sessionId: { type: 'string', description: 'Session whose title to change. Worker sessions are the default; Ria itself is allowed.' },
          title: { type: 'string', description: 'New session title. It is normalized by the host; a title with no visible characters is invalid.' },
        },
        required: ['sessionId', 'title'],
        additionalProperties: false,
      },
      async args => this.toolTitle(args),
    )

    register(
      'ria_request',
      'Send a message to one or more top-level worker sessions. Before delivering, the host preflights every target: it must exist, be a top-level worker (not Ria, not a subagent), be unarchived, and have a working directory that exists and is enterable. For a default mode=queue dispatch the target must also be idle: a running turn or any pending queue/steering item makes it busy, and the request fails with code=worker_busy and nothing is delivered. Do not retry a busy target and do not use steer to hand over new work; express ordering with dependsOn on the later ticket, or wait for [Worker idle]. Image attachments are checked too: each absolute path must exist and be a supported image within the host limits, and the target model must accept image input. A target that fails is reported with ok=false plus a machine-readable code (session_missing, not_top_level, session_archived, workspace_missing, ticket_executor_mismatch, worker_busy, ticket_not_ready, ticket_blocked, steer_requires_running, attachment_missing, attachment_invalid, model_no_image) and a Chinese message naming the session; nothing is delivered, it is not recorded as recently used, and its task is not moved to working. Other targets are still attempted. A successful request records each target as recently used by Ria. ticketId is REQUIRED and selects the ticket this dispatch belongs to; its executor must equal every target. A ticket with unfinished dependencies (waitingOn=dependency) cannot be dispatched: ria_request returns ticket_not_ready. Once all dependencies are done the host sends [Queue ready] with a queueToken; pass that exact token or the request returns ticket_not_ready, which also protects against dispatching the same readiness twice. A blocked ticket (including waitingOn=approval or environment) is rejected with ticket_blocked and nothing is delivered; reopen it with ria_ticket before dispatching. note is REQUIRED: one or two user-facing sentences saying who received the ticket, what they were asked to do, and what the user will see next. The host shows note as a card at the end of the current turn in the Ria transcript without adding it to model context, and mirrors the same text to WeChat when connected, so note is the user-visible reply; do not rely on assistant text instead. A missing, blank, or over-500-character note is an error (maximum 500 characters) and nothing is delivered. The host relies on the worker\'s system prompt for the anti-misdelivery constraint and adds no message prefix. The call returns when the message is accepted, not when work finishes. If every target succeeds, it ends the current turn: do not sleep, poll, or call status/read afterward. mode=steer only synchronises information into an already-running turn; it must never be used to hand out a new task.',
      {
        type: 'object',
        properties: {
          targetSessionIds: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 32 },
          message: { type: 'string', description: 'Convenience text content. Ignored when content is provided.' },
          content: { type: 'array', items: { type: 'object', additionalProperties: true }, description: 'DSH prompt content parts: text, image (mediaType/data/name), or file (receiptId).' },
          attachments: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 20, description: 'Absolute paths of image files to attach after the text. Each file must be a supported image (png/jpeg/webp/gif) within the host image limits, and the target model must accept image input.' },
          ticketId: { type: 'string', description: 'Ticket this dispatch belongs to. Required; its executor must equal each target.' },
          note: { type: 'string', description: 'Required. One or two user-facing sentences shown as a card at the end of the current turn in the Ria transcript: who received the ticket, what they were asked to do, and what happens next. Maximum 500 characters; longer notes are rejected, not truncated.' },
          mode: { type: 'string', enum: ['queue', 'steer'], description: 'queue (default) starts a new turn and is rejected with worker_busy when the target is running or has pending messages; use dependsOn for ordering instead of queueing onto a busy worker. steer injects into the running turn for information sync only and must never be used to hand out new tasks; when the target has no running turn it fails with steer_requires_running instead of silently dropping the input, so use queue or wait.' },
          queueToken: {
            type: 'string',
            description: 'Required when the ticket has dependsOn and is already ready. Use the current queueToken from ria_status or the [Queue ready] notice; a stale token returns ticket_not_ready.',
          },
        },
        required: ['targetSessionIds', 'ticketId', 'note'],
        additionalProperties: false,
      },
      async (args, exec) => this.toolRequest(args, exec),
    )

    register(
      'ria_read',
      'Read the most recent messages of one session without resuming it. Returns user and assistant text, with image/file placeholders, lastTurn (the turn number and outcome of the last turn/end: completed, blocked, error, aborted(user), aborted(parent), aborted(hook), aborted(disposed); aborted(user) means the user manually stopped that turn), and queue: the same pending-item view as ria_queue list, or null for a cold session (no in-memory queue).',
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
      'ria_queue',
      'List or remove messages still pending for one top-level session. action=list returns running plus queue items with id, placement, optional rpcId and a short preview. placement=queued is a next-turn message; placement=steering is injected into the current running turn; placement=context is other non-user context. action=remove accepts itemId or rpcId; when both are given itemId wins. rpcId is the requestId returned by ria_request, which is the only handle Ria has for a queued follow-up. Removal is irreversible and only drops pending items: it never cancels the current turn, changes any ticket, or touches recently used workers. The target is preflighted like ria_request (exists, top-level, unarchived, usable cwd), so Ria itself and subagents are rejected. A missing item returns ok=false with code=queue_item_not_found; other host failures return queue_remove_failed with the reason. A cold session has no in-memory queue and returns queue=null from list.',
      {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['list', 'remove'] },
          sessionId: { type: 'string', description: 'Top-level worker session whose pending queue to read or change.' },
          itemId: { type: 'string', description: 'Queue item id to remove. Takes precedence over rpcId when both are given.' },
          rpcId: { type: 'string', description: 'requestId returned by ria_request; resolved to a queue item id before removal.' },
        },
        required: ['action', 'sessionId'],
        additionalProperties: false,
      },
      async (args, exec) => this.toolQueue(args, exec.signal),
    )

    register(
      'ria_approval',
      'List worker approval requests currently waiting, limited to workers with an active task. Each item carries approvalId, workerSessionId, ticketId, toolName, optional callId/reason, createdAt, expiresAt, and expiresInMs (remaining milliseconds). Capturing a request also moves its ticket to blocked with waitingOn=approval and kind=approval attention, and queues an approval_note card plus WeChat mirror. This tool is read-only: it never approves or denies, never answers for the UI, and never changes the approval result.',
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
      'Read or edit the global memory.md core, or read its non-injected archive. Use only for stable user preferences, never task progress or secrets. Core budgets are maxChars (code points), maxEntries (top-level "- " bullets), and maxEntryChars (one bullet). action=replace atomically replaces the whole file with exactly one of content (a string) or entries (array of {key?, text}); entries are written as top-level "- **key**: text" bullets. Any write over a budget is rejected, nothing is changed, and the result includes ok=false, code=memory_over_budget, a full message (current value/limit, longest entry key/chars, every over-limit key/chars, No changes were made.) and diagnostics with the same numbers. Near 90% the result carries an archive warning. read returns chars/bytes/entries plus limits. read scope=archive path=<slug> returns at most 4000 chars and nextOffset for continuation. action=list lists archive files. Archive content is never injected into the prompt.',
      {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['read', 'remember', 'forget', 'replace', 'list'] },
          scope: { type: 'string', enum: ['core', 'archive'], description: 'For read only; defaults to core. archive requires path.' },
          path: { type: 'string', description: 'Archive slug for read scope=archive, for example worker-lessons (without .md).' },
          offset: { type: 'integer', minimum: 0, description: 'Character offset for archive continuation.' },
          text: { type: 'string', description: 'Body for action=remember; one line, key optional.' },
          key: { type: 'string', description: 'Key for action=remember or forget; one line, no "*".' },
          content: { type: 'string', description: 'For action=replace: the complete new memory.md text, written verbatim. Mutually exclusive with entries.' },
          entries: {
            type: 'array',
            description: 'For action=replace: complete replacement entries. Mutually exclusive with content. Each entry becomes one top-level "- **key**: text" bullet (or "- text" without key) and must be one line.',
            items: {
              type: 'object',
              properties: {
                key: { type: 'string', description: 'Optional entry key; one line, no "*".' },
                text: { type: 'string', description: 'Entry body; one line, non-empty.' },
              },
              required: ['text'],
              additionalProperties: false,
            },
          },
        },
        required: ['action'],
        additionalProperties: false,
      },
      async args => this.toolMemory(args),
    )

    register(
      'ria_send_file',
      'Send one local file to the user over the most recently active mobile channel (WeChat Claw, QQ bot, or the WeChat file transfer helper). path must be an absolute path to an existing regular file; symlinks are resolved with realpath and the resolved file must stay inside a normal file. The extension must be on the transfer allowlist (pdf, doc/docx, xls/xlsx, ppt/pptx, zip/gz/tar/7z/rar, txt, md, csv, json, html, xml, yml/yaml, log, png/jpg/jpeg/gif/webp, svg) and the file must be within the channel limit (default 20 MB, configurable under channels.<id>.files.maxBytes). note is an optional sentence sent right after the file. The channel is chosen by its last inbound message, so the user must have messaged Ria on that channel first; if no channel has a reply target the call returns code=no_target and sends nothing. When that channel is paused the file is queued durably and the call returns queued=true; it is retried after the user resumes the channel, and a failed send is recorded in the channel status as lastFileSend instead of being swallowed. This tool sends a file only: it never creates a ticket, wakes a worker, or changes task state. Codes: path_required, path_not_absolute, file_not_found, file_not_regular, file_empty, file_unsupported, file_too_large, file_send_disabled, no_target, file_send_failed, file_queue_failed.',
      {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute path of the file to send.' },
          note: { type: 'string', maxLength: 500, description: 'Optional short sentence to send with the file. Maximum 500 characters.' },
        },
        required: ['path'],
        additionalProperties: false,
      },
      async (args, exec) => this.toolSendFile(args, exec),
    )

    register(
      'ria_topic',
      'Group tickets into topics (the board groups tickets by topic inside each project). action=create makes a topic (title required; brief, level 1|2 and parentId optional) and returns topicId. action=update changes title, brief, level or parentId on an existing topic; parent cycles are rejected. action=link attaches one existing ticket to a topic with role=primary|related (default primary); a ticket has at most one primary topic, so linking it as primary elsewhere automatically demotes the old primary to related. action=unlink removes one topic-ticket link. action=merge moves every link from sourceTopicId to targetTopicId and archives the source (mergedInto records the target). action=archive is allowed only when the topic has no unfinished linked ticket, otherwise it returns ok=false with code=topic_unfinished. action=list returns topics with per-topic ticket counts. action=suggest is read-only: it scores a goal (Han two-gram and Latin token overlap) against active topics (title, brief and linked ticket goals) and against hot tickets without an active primary topic, returning {topics:[{topicId,title,brief,counts,score}],tickets:[{ticketId,goal,status,score}]}, highest score first; it never creates a topic, links a ticket or reclassifies history. This tool only maintains topics and links: it never creates, dispatches or changes a ticket, never wakes a worker, and never reclassifies old tickets by itself. Codes: topic_invalid, topic_missing, topic_archived, topic_merged, topic_unfinished, ticket_missing, link_invalid.',
      {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['create', 'update', 'link', 'unlink', 'merge', 'archive', 'list', 'suggest'] },
          topicId: { type: 'string', description: 'Topic for update/link/unlink/archive.' },
          title: { type: 'string', description: 'Topic title for create/update. Maximum 200 characters.' },
          brief: { type: 'string', description: 'Optional one-paragraph topic brief shown on the topic card. Maximum 2000 characters. When omitted, the board builds a summary from the newest linked ticket, its status and the ticket counts.' },
          level: { type: 'number', enum: [1, 2], description: 'Topic level, default 1.' },
          parentId: { type: 'string', description: 'Optional parent topic id.' },
          ticketId: { type: 'string', description: 'Existing ticket for link/unlink.' },
          role: { type: 'string', enum: ['primary', 'related'], description: 'Link role, default primary. Only one primary topic per ticket.' },
          sourceTopicId: { type: 'string', description: 'Topic merged away.' },
          targetTopicId: { type: 'string', description: 'Topic that keeps the links.' },
          includeArchived: { type: 'boolean', description: 'With action=list, include archived and merged topics. Default false.' },
          goal: { type: 'string', description: 'With action=suggest: the new ticket goal to match. Required for suggest.' },
          limit: { type: 'integer', minimum: 1, maximum: 20, description: 'With action=suggest: maximum rows per list. Default 5.' },
        },
        required: ['action'],
        additionalProperties: false,
      },
      async args => this.toolTopic(args),
    )

    register(
      'ria_reflect',
      'Orchestrate one daily reflection run. Ria-only: workers never see this tool. action=status shows the current run and state without reading long files; action=begin checks lastCompletedDate, the lock and run.json, then returns the run, window, report path, instruction and spawn plan without creating a worker; action=dispatch sends that instruction to the session returned by ria_spawn with reflectionRunId and starts the deadline; action=finish validates the report front matter, writes the final report, overwrites durationMs/compressedBytesRead/decompressedBytesRead from the run timestamps and read stats, advances state.lastCompletedDate only for a complete report, releases the lock and answers only the intake bound at begin; action=abort releases the lock and writes no final report. Do not use this for ordinary work tickets.',
      {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['status', 'begin', 'dispatch', 'finish', 'abort'] },
          forDate: { type: 'string', description: 'YYYY-MM-DD in Asia/Shanghai. Defaults to today.' },
          trigger: { type: 'string', description: 'manual (default) or schedule.' },
          force: { type: 'boolean', description: 'Start a new run even when the same day is already complete.' },
          runId: { type: 'string' },
          sessionId: { type: 'string', description: 'Worker session returned by ria_spawn with reflectionRunId.' },
          status: { type: 'string', enum: ['complete', 'partial'], description: 'Required for finish.' },
          counts: { type: 'object', additionalProperties: true },
          degraded: { type: 'array', items: { type: 'string' } },
          reason: { type: 'string' },
          cancelled: { type: 'boolean' },
          model: { type: 'string' },
          provider: { type: 'string' },
          reasoningEffort: { type: 'string' },
        },
        required: ['action'],
        additionalProperties: false,
      },
      (args, exec) => this.toolReflect(args, exec),
    )

    const disposePrompt = agent.ctx.systemPrompt.section({
      name: 'ria-manager',
      order: 40,
      interpolate: false,
      text: () => {
        const memory = memoryPromptPayload(this.store.readMemory(), this.store.memorySettings())
        return managerPrompt(sessionId, memory.text, this.store.styleSettings(), memory.notice)
      },
    })
    if (typeof disposePrompt === 'function') this.disposers.push(disposePrompt)
    this.log('info', 'installed manager prompt and 15 tools on ' + sessionId)
  }

  async toolTicket(args, exec) {
    const signal = exec && exec.signal ? exec.signal : NEVER_ABORTED
    // Reopening an archived ticket: pull its snapshot back from the log first,
    // then let the transition table handle the terminal -> open edge.
    const ticketId = asString(args.ticketId)
    if (ticketId && args.status === 'open' && !this.store.ticket(ticketId)) {
      this.store.restoreArchivedTicket(ticketId)
    }
    if (args.cascade !== undefined) {
      if (args.cascade !== 'downstream') throw new Error('invalid cascade: ' + args.cascade)
      if (!ticketId) throw new Error('ticketId is required when cascade=downstream')
      if (args.status !== 'cancelled') throw new Error('cascade=downstream requires status=cancelled')
      const result = this.store.cascadeCancel(ticketId, { actor: 'ria', reason: asString(args.reason) || '用户取消' })
      if (!result.ok) return { ok: false, code: result.code, message: result.message, error: result.message }
      const cancelled = result.cancelled.map(id => {
        const ticket = this.store.ticket(id)
        return ticket ? ticketSummary(ticket) : { ticketId: id }
      })
      for (const id of result.cancelled) {
        const ticket = this.store.ticket(id)
        if (ticket) await this.grants.onTicketChanged(ticket)
      }
      return { ok: true, cancelled, deferred: result.deferred, reason: result.reason }
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
      if (args.topicId !== undefined) {
        const message = 'topicId is only accepted when creating a ticket'
        return { ok: false, code: 'topic_invalid', message, error: message }
      }
      const existing = this.store.ticket(ticketId)
      if (!existing) throw new Error('ticket not found: ' + ticketId)
      if (existing.status === 'intake') {
        throw transitionError('intake_requires_resolve', 'ticket ' + existing.ticketId + ' is an intake; give it a disposition with ria_resolve, not ria_ticket')
      }
      if (args.check !== undefined) {
        const otherFields = ['status', 'goal', 'acceptance', 'executor', 'blockedReason', 'waitingOn', 'attention', 'dependsOn', 'checklist', 'replaceAll', 'drop']
        if (otherFields.some(key => args[key] !== undefined)) {
          throw transitionError('checklist_invalid', 'check cannot be combined with other ticket fields')
        }
        if (isTerminal(existing.status)) {
          throw transitionError('checklist_invalid', 'ticket ' + existing.ticketId + ' is ' + existing.status + '; its checklist is final')
        }
        const check = args.check && typeof args.check === 'object' ? args.check : {}
        const list = normalizeChecklist(existing.checklist)
        if (!Number.isSafeInteger(check.index) || check.index < 0 || check.index >= list.length) {
          throw transitionError('checklist_index', 'checklist index out of range: ' + String(check.index))
        }
        if (typeof check.done !== 'boolean') throw transitionError('checklist_invalid', 'check.done must be a boolean')
        list[check.index] = { text: list[check.index].text, done: check.done }
        const checked = this.store.updateTicket(ticketId, {
          checklist: list,
          recovery: { count: 0, lastAt: now() },
        })
        return { ticket: ticketSummary(checked || existing) }
      }
      let current = existing
      if (args.status !== undefined) {
        if (!TICKET_STATUSES.includes(args.status)) throw new Error('invalid ticket status: ' + args.status)
      }
      // Validate and build the checklist before the status transition so a
      // ticket marked done can record the still-open steps in its resolution.
      let checklistPatch
      if (args.checklist !== undefined || args.replaceAll !== undefined || args.drop !== undefined) {
        if (args.replaceAll !== undefined && typeof args.replaceAll !== 'boolean') {
          throw transitionError('checklist_invalid', 'replaceAll must be a boolean')
        }
        if (args.replaceAll && args.checklist === undefined) {
          throw transitionError('checklist_invalid', 'replaceAll requires checklist')
        }
        // applyChecklistUpdate parses the raw input itself; pre-parsing would
        // turn every item into an explicit done:false and clear old ticks.
        const incoming = args.checklist === undefined ? [] : args.checklist
        checklistPatch = applyChecklistUpdate(current.checklist, incoming, {
          replaceAll: args.replaceAll === true,
          checklistProvided: args.checklist !== undefined,
          drop: args.drop,
        })
      }
      // A ticket that enters working must point at a worker with a turn in
      // flight. An idle worker emits no [Worker idle] event, so a tracking
      // ticket written as working would stick until restart reconciliation.
      // self is exempt: Ria writes that while working in its own turn.
      const targetStatus = args.status !== undefined ? args.status : current.status
      const targetExecutor = args.executor !== undefined ? asString(args.executor) : current.executor
      const willTransition = args.status !== undefined && args.status !== current.status
      const canEnterWorking = !willTransition || canTransition(current.status, args.status)
      if (targetStatus === 'working' && targetExecutor !== 'self' && canEnterWorking
          && (current.status !== 'working' || targetExecutor !== current.executor)) {
        const problem = await this.workingExecutorProblem(targetExecutor, signal)
        if (problem) return { ok: false, code: problem.code, message: problem.message, error: problem.message, ticket: ticketSummary(current) }
      }
      if (args.status !== undefined) {
        if (args.status !== current.status) {
          const options = { reason: 'ria_ticket update' }
          if (args.blockedReason !== undefined) options.blockedReason = String(args.blockedReason)
          else if (args.status === 'blocked' && args.attention && args.attention.question) options.blockedReason = String(args.attention.question)
          if (args.waitingOn !== undefined) options.waitingOn = String(args.waitingOn)
          if (args.attention !== undefined) options.attention = args.attention
          if (args.status === 'done') {
            const resolution = current.resolution && current.resolution.kind
              ? { ...current.resolution }
              : { kind: 'done', summary: current.goal || 'done' }
            const finalChecklist = normalizeChecklist(checklistPatch === undefined ? current.checklist : checklistPatch)
            const pending = finalChecklist.filter(item => !item.done)
            if (pending.length) {
              resolution.checklistPending = {
                total: finalChecklist.length,
                done: finalChecklist.length - pending.length,
                pending: pending.slice(0, 5).map(item => item.text),
              }
            } else if (resolution.checklistPending) {
              delete resolution.checklistPending
            }
            options.resolution = resolution
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
      if (args.attention !== undefined && current.status === 'blocked') patch.attention = args.attention
      if (args.dependsOn !== undefined) patch.dependsOn = args.dependsOn
      if (checklistPatch !== undefined) patch.checklist = checklistPatch
      const ticket = this.store.updateTicket(ticketId, patch) || current
      if (ticket.status === 'done' || ticket.status === 'cancelled') await this.grants.onTicketChanged(ticket)
      const result = { ticket: ticketSummary(ticket) }
      if (ticket.status === 'done') {
        const pending = normalizeChecklist(ticket.checklist).filter(item => !item.done)
        if (pending.length) {
          result.warning = '工单 ' + ticket.ticketId + ' 已完成，但清单还有 ' + pending.length + ' 项未勾选：'
            + pending.slice(0, 3).map(item => item.text).join('、')
            + (pending.length > 3 ? '…' : '')
        }
      }
      return result
    }
    const goal = asString(args.goal)
    const executor = asString(args.executor)
    if (!goal) throw new Error('goal is required when creating a ticket')
    if (!executor) throw new Error('executor is required when creating a ticket')
    const topicId = args.topicId === undefined ? '' : asString(args.topicId)
    if (args.topicId !== undefined && !topicId) {
      const message = 'topicId must not be empty'
      return { ok: false, code: 'topic_missing', message, error: message }
    }
    if (args.status !== undefined && !TICKET_STATUSES.includes(args.status)) throw new Error('invalid ticket status: ' + args.status)
    if ((args.status || 'open') === 'working') {
      const problem = await this.workingExecutorProblem(executor, signal)
      if (problem) return { ok: false, code: problem.code, message: problem.message, error: problem.message }
    }
    if (args.replaceAll !== undefined || args.drop !== undefined) {
      throw transitionError('checklist_invalid', 'replaceAll and drop only apply when updating a ticket')
    }
    const checklist = args.checklist !== undefined ? parseChecklistInput(args.checklist).map(item => ({ text: item.text, done: item.done })) : undefined
    const attention = args.attention !== undefined ? args.attention : undefined
    const blockedReason = args.blockedReason ? String(args.blockedReason) : (attention && attention.question ? String(attention.question) : '')
    let ticket
    try {
      ticket = this.store.addTicket({
        goal,
        acceptance: args.acceptance ? String(args.acceptance) : '',
        executor,
        status: args.status || 'open',
        blockedReason,
        attention,
        waitingOn: args.waitingOn,
        dependsOn: args.dependsOn,
        checklist,
        topicId: topicId || undefined,
      })
    } catch (error) {
      if (error && (error.code === 'topic_missing' || error.code === 'topic_archived')) {
        return { ok: false, code: error.code, message: error.message, error: error.message }
      }
      throw error
    }
    if (ticket.status === 'done' || ticket.status === 'cancelled') await this.grants.onTicketChanged(ticket)
    const primaryTopicId = this.store.primaryTopicFor(ticket.ticketId)
    const result = { ticket: { ...ticketSummary(ticket), primaryTopicId: primaryTopicId || null } }
    if (!primaryTopicId) result.topicMissingHint = TOPIC_MISSING_HINT
    return result
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
      dependsOn: args.dependsOn,
      start: args.start === true,
      targetTicketId: args.targetTicketId,
      action: args.action,
      reason: args.reason,
      blockedReason: args.blockedReason,
      waitingOn: args.waitingOn,
      attention: args.attention,
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
      return { code: 'not_top_level', message: 'executor ' + id + ' 是 Ria 自己，不能作为 worker；让 Ria 自己执行请传 executor: "self"。' }
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
    let reflection
    const reflectionRunId = asString(args.reflectionRunId)
    if (reflectionRunId) {
      reflection = this.reflections.get(reflectionRunId)
      if (!reflection) {
        const message = '反思运行不存在：' + reflectionRunId
        return { ok: false, code: 'reflection_run_missing', message, error: message }
      }
      if (reflection.status !== 'running' && reflection.status !== 'starting') {
        const message = '反思运行 ' + reflectionRunId + ' 已结束，不能创建读取 worker。'
        return { ok: false, code: 'run_closed', message, error: message }
      }
    }
    const agentPreset = asString(args.agentPreset)
    let modelSelection
    if (asString(args.model) || asString(args.provider) || asString(args.reasoningEffort)) {
      const resolved = await this.resolveModelRequest(args)
      if (!resolved.ok) return { ok: false, code: resolved.code, message: resolved.message, error: resolved.message }
      modelSelection = resolved.selection
    }
    const request = { cwd: target }
    if (agentPreset) request.agentPreset = agentPreset
    // The host accepts a caller-supplied sessionId. Binding before create is
    // what makes agent/created install the reflection tool set instead of the
    // Ria manager tools.
    const requestedId = reflection ? ('session-' + randomUUID()) : undefined
    if (requestedId) {
      request.sessionId = requestedId
      reflection.workerSessionId = requestedId
      this.reflectionBindings.set(requestedId, reflection.runId)
      if (!reflection.candidates.includes(requestedId)) reflection.candidates.push(requestedId)
      writeReflectionRun(reflection, this.stateDir)
    }
    let created
    try {
      created = await this.ctx.sessionController.create(request)
    } catch (error) {
      if (requestedId) {
        this.unbindReflectionSession(requestedId)
        reflection.candidates = reflection.candidates.filter(id => id !== requestedId)
        reflection.workerSessionId = null
        writeReflectionRun(reflection, this.stateDir)
      }
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
    if (reflection) {
      if (sessionId !== requestedId) {
        // Defensive: the host is expected to honour request.sessionId.
        this.log('warn', 'reflection spawn returned ' + sessionId + ' instead of ' + requestedId)
        if (requestedId) this.unbindReflectionSession(requestedId)
        this.reflectionBindings.set(sessionId, reflection.runId)
        reflection.candidates = reflection.candidates.filter(id => id !== requestedId)
        if (!reflection.candidates.includes(sessionId)) reflection.candidates.push(sessionId)
      }
      reflection.workerSessionId = sessionId
      // A reflection run stays starting until ria_reflect dispatch accepts the
      // instruction; the worker exists, but the 15-minute clock has not begun.
      writeReflectionRun(reflection, this.stateDir)
    }
    const result = { ok: true, sessionId, cwd: target }
    if (reflection) result.reflectionRunId = reflection.runId
    const attached = await this.attachWorkspaceSession(sessionId, target)
    if (attached.workspaceId) result.workspaceId = attached.workspaceId
    if (attached.workspaceError) result.workspaceError = attached.workspaceError
    if (agentPreset) result.agentPreset = agentPreset
    const wantedTitle = asString(args.title)
    if (wantedTitle) {
      const renamed = await this.renameSessionTitle(sessionId, wantedTitle)
      if (renamed.ok) result.title = renamed.title
      else result.titleError = renamed.message
    }
    if (modelSelection) {
      const applied = await this.applyModelSelection(sessionId, modelSelection)
      if (!applied.ok) {
        const message = '会话已创建（' + sessionId + '，cwd ' + target + '），但模型设置失败：' + applied.message + '。它仍使用默认模型；可用 ria_model 重试设置。'
        const failed = { ok: false, code: 'model_not_found', sessionId, cwd: target, message, error: message }
        if (result.workspaceId) failed.workspaceId = result.workspaceId
        if (result.workspaceError) failed.workspaceError = result.workspaceError
        if (result.agentPreset) failed.agentPreset = result.agentPreset
        if (result.title) failed.title = result.title
        if (result.titleError) failed.titleError = result.titleError
        return failed
      }
      result.selected = applied.selected
    }
    return result
  }

  async toolModel(args) {
    const sessionId = asString(args.sessionId)
    if (!sessionId) {
      const message = 'ria_model 需要 sessionId：要更改模型的会话 id。'
      return { ok: false, code: 'session_missing', message, error: message }
    }
    const problem = await this.sessionProblem(sessionId, { allowRia: true })
    if (problem.code) {
      return { ok: false, sessionId, code: problem.code, message: problem.message, error: problem.message }
    }
    const resolved = await this.resolveModelRequest(args)
    if (!resolved.ok) {
      return { ok: false, sessionId, code: resolved.code, message: resolved.message, error: resolved.message }
    }
    const previous = await this.modelForTarget(sessionId)
    const applied = await this.applyModelSelection(sessionId, resolved.selection)
    if (!applied.ok) {
      return { ok: false, sessionId, code: applied.code, message: applied.message, error: applied.message }
    }
    const response = { ok: true, sessionId, selected: applied.selected }
    const previousView = this.selectionView(previous)
    if (previousView) response.previous = previousView
    return response
  }

  async toolTitle(args) {
    const sessionId = asString(args.sessionId)
    if (!sessionId) {
      const message = 'ria_title 需要 sessionId：要改名的会话 id。'
      return { ok: false, code: 'session_missing', message, error: message }
    }
    const title = asString(args.title)
    if (!title) {
      const message = 'ria_title 需要 title：新的会话名不能为空，也不能只包含空白字符。'
      return { ok: false, sessionId, code: 'title_invalid', message, error: message }
    }
    const problem = await this.sessionProblem(sessionId, { allowRia: true })
    if (problem.code) {
      return { ok: false, sessionId, code: problem.code, message: problem.message, error: problem.message }
    }
    const previous = sessionTitle(problem.summary)
    const renamed = await this.renameSessionTitle(sessionId, title)
    if (!renamed.ok) {
      return { ok: false, sessionId, code: renamed.code, message: renamed.message, error: renamed.message }
    }
    const response = { ok: true, sessionId, title: renamed.title }
    if (previous) response.previous = previous
    return response
  }

  /**
   * Rename one session and normalize the host failure. Shared by ria_title and
   * ria_spawn's optional title, so both use the same title-invalid mapping.
   */
  async renameSessionTitle(sessionId, title) {
    const wanted = asString(title)
    if (!wanted) {
      return { ok: false, code: 'title_invalid', message: '标题不能为空：只包含空白字符的标题不会生效。' }
    }
    try {
      const renamed = await this.ctx.sessionController.rename({ sessionId, title: wanted })
      const accepted = renamed && typeof renamed.title === 'string' && renamed.title ? renamed.title : wanted
      return { ok: true, title: accepted }
    } catch (error) {
      const message = String(error && error.message ? error.message : error)
      const code = error && error.code === 'session/title-invalid' ? 'title_invalid' : 'title_failed'
      return { ok: false, code, message }
    }
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

  /** Normalize a model selection without leaking undefined fields. */
  selectionView(current) {
    if (!current || !current.provider || !current.model) return undefined
    const view = { provider: String(current.provider), model: String(current.model) }
    if (current.reasoningEffort !== undefined && current.reasoningEffort !== null && current.reasoningEffort !== '') {
      view.reasoningEffort = String(current.reasoningEffort)
    }
    return view
  }

  /** The model selection recorded on a session list projection, if known. */
  sessionModel(summary) {
    const selection = summary && summary.projections && summary.projections.values
      ? summary.projections.values.modelSelection
      : undefined
    return this.selectionView(selection && (selection.next || selection.lastUsed))
  }

  /**
   * Base preflight shared by model changes: the session must exist, be
   * top-level, be unarchived, and have a usable working directory. It mirrors
   * the ria_request preflight; options.allowRia lets ria_model target Ria
   * itself, which ria_request must never do.
   */
  async sessionProblem(sessionId, options = {}) {
    const id = String(sessionId)
    const riaId = this.store.riaSessionId
    if (riaId && id === riaId && !options.allowRia) {
      return { code: 'not_top_level', message: '会话 ' + id + ' 是 Ria 自己，不是 worker' }
    }
    let items = options.items
    if (!items) {
      try {
        items = await this.listSessions(options.signal)
      } catch (error) {
        return { code: 'session_missing', message: '无法列出会话：' + String(error && error.message ? error.message : error) }
      }
    }
    const summary = items.find(item => String(item.sessionId) === id)
    if (!summary) return { code: 'session_missing', message: '会话不存在：' + id }
    if (summary.origin === 'subagent') return { code: 'not_top_level', message: '会话 ' + id + ' 是 subagent 子会话' }
    const archived = options.archived || this.archivedSessions()
    if (archived.has(id)) return { code: 'session_archived', message: '会话 ' + id + ' 已归档，不能唤醒或更改模型' }
    const problem = this.workspaceProblem(summary.cwd)
    if (problem) return { code: 'workspace_missing', message: '会话 ' + id + ' 无法运行：' + problem }
    return { summary }
  }

  /**
   * Resolve { model, provider?, reasoningEffort? } against the host model
   * registry. Without a provider the model id must be unique across all
   * providers; guessing could select the wrong route.
   */
  async resolveModelRequest(args = {}) {
    const model = asString(args.model)
    const provider = asString(args.provider)
    const reasoningEffort = asString(args.reasoningEffort)
    if (!model) {
      const message = '需要 model：要选择的模型 id。'
      return { ok: false, code: 'model_not_found', message }
    }
    const llm = typeof this.ctx.get === 'function' ? this.ctx.get('llm') : undefined
    if (!llm || typeof llm.listProviders !== 'function' || typeof llm.listModels !== 'function') {
      const message = '当前宿主没有可用的模型注册表（llm.listProviders/listModels），无法解析模型 ' + model + '。'
      return { ok: false, code: 'model_not_found', message }
    }
    let providers
    try {
      providers = await llm.listProviders()
    } catch (error) {
      const message = '无法读取模型 provider 列表：' + String(error && error.message ? error.message : error)
      return { ok: false, code: 'model_not_found', message }
    }
    const models = []
    const failures = []
    for (const entry of Array.isArray(providers) ? providers : []) {
      const pid = asString(entry && entry.id)
      if (!pid) continue
      try {
        const list = await llm.listModels(pid)
        for (const item of Array.isArray(list) ? list : []) {
          const id = asString(item && item.id)
          if (id) models.push({ provider: pid, model: id })
        }
      } catch (error) {
        failures.push(pid + '（' + String(error && error.message ? error.message : error) + '）')
      }
    }
    if (!provider && failures.length) {
      const message = '无法确认模型 ' + model + ' 的 provider 唯一性；部分 provider 读取失败：' + failures.join('；') + '。请显式传 provider 或稍后重试。'
      return { ok: false, code: 'model_not_found', message }
    }
    const matches = models.filter(item => item.model === model && (!provider || item.provider === provider))
    if (!matches.length) {
      const wanted = provider ? provider + '/' + model : model
      const sample = models.slice(0, 12).map(item => item.provider + '/' + item.model)
      let message = '找不到模型 ' + wanted + '。'
      if (failures.length) message += '部分 provider 读取失败：' + failures.join('；') + '。'
      if (sample.length) message += '可用模型：' + sample.join(', ') + (models.length > sample.length ? ' 等' : '') + '。'
      return { ok: false, code: 'model_not_found', message }
    }
    if (matches.length > 1) {
      const routes = matches.map(item => item.provider + '/' + item.model)
      const message = '模型 ' + model + ' 在多个 provider 下存在，请显式传 provider：' + routes.join(', ') + '。'
      return { ok: false, code: 'model_not_found', message }
    }
    const selection = { provider: matches[0].provider, model }
    if (reasoningEffort) selection.reasoningEffort = reasoningEffort
    return { ok: true, selection }
  }

  /** Apply a resolved selection and return the host's canonical selection. */
  async applyModelSelection(sessionId, selection) {
    const id = String(sessionId)
    try {
      const result = await this.ctx.sessionController.selectModel({ sessionId: id, ...selection })
      const selected = result && result.selected ? result.selected : selection
      return { ok: true, selected: this.selectionView(selected) || selection }
    } catch (error) {
      const detail = String(error && error.message ? error.message : error)
      const message = '无法把会话 ' + id + ' 的模型设为 ' + selection.provider + '/' + selection.model + '：' + detail
      return { ok: false, code: 'model_not_found', message }
    }
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
    let topicId = ''
    let projectId = ''
    let textWithSource = ''
    if (source === 'workspace') {
      projectId = asString(body.projectId)
      if (!projectId) throw transitionError('project_required', 'projectId is required')
      const projectTitle = (asString(body.projectTitle) || projectId).replace(/\s+/g, ' ').trim()
      textWithSource = '【看板 · 工作区】' + projectTitle + ' ' + text
    } else {
      topicId = asString(body.topicId)
      if (!topicId) throw transitionError('topic_required', 'topicId is required')
      if (topicId.startsWith('unclassified:')) throw transitionError('topic_unclassified', 'cannot ask from the unclassified bucket')
      const topic = this.store.topic(topicId)
      if (!topic) throw transitionError('topic_missing', 'topic not found: ' + topicId)
      if (topic.unclassified) throw transitionError('topic_unclassified', 'cannot ask from the unclassified bucket')
      if (topic.archivedAt || topic.mergedInto) throw transitionError('topic_archived', 'topic is archived or merged: ' + topicId)
      const child = topic.level === 2 ? '（子主题）' : ''
      textWithSource = '【看板 · 主题卡】【' + topic.title + '】' + child + text
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
    const lanes = new Map()
    const laneFor = executor => {
      const id = String(executor || '')
      const riaId = this.store.riaSessionId || ''
      if (!id) return { id: 'unassigned', label: '未分配', kind: 'unassigned' }
      if (id === riaId || id === 'self') return { id: 'ria', label: 'Ria · 管家', kind: 'ria' }
      const summary = sessions.get(id)
      const workspace = workspaceBySession.get(id)
      if (workspace) {
        return {
          id: 'workspace:' + workspace.id,
          label: workspace.title || basename(workspace.path || '') || id,
          kind: 'workspace',
          cwd: workspace.path || '',
          sessionId: id,
        }
      }
      const cwd = summary && typeof summary.cwd === 'string' ? summary.cwd : ''
      if (cwd) {
        return { id: 'path:' + cwd, label: basename(cwd) || cwd, kind: 'path', cwd, sessionId: id }
      }
      if (summary) {
        return { id: 'session:' + id, label: sessionTitle(summary) || id, kind: 'session', sessionId: id }
      }
      return { id: 'unassigned', label: '未分配', kind: 'unassigned' }
    }

    // The board spans the hot store and the archive. A ticket in the hot store
    // wins over an older archive record; an archived ticket is normalised with
    // the same shape so the client needs no second code path.
    const byId = new Map()
    for (const record of this.store.historyRecords()) {
      const ticket = normalizeTicket(record.ticket)
      if (!ticket.ticketId) continue
      const known = byId.get(ticket.ticketId)
      if (!known || (ticket.closedAt || 0) > (known.closedAt || 0)) byId.set(ticket.ticketId, ticket)
    }
    for (const ticket of this.store.tickets()) byId.set(ticket.ticketId, ticket)
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
      const queue = this.store.queueInfo(ticket)
      const lane = laneFor(ticket.executor)
      const summary = sessions.get(String(ticket.executor || ''))
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
        archived: !this.store.ticket(ticket.ticketId),
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
    const projectForLane = lane => {
      if (!projectMap.has(lane.id)) {
        projectMap.set(lane.id, {
          projectId: lane.id,
          id: lane.id,
          title: lane.label,
          label: lane.label,
          kind: lane.kind,
          cwd: lane.cwd || '',
          sessionId: lane.sessionId || null,
          counts: { total: 0, active: 0, terminal: 0, blocked: 0, working: 0, topics: 0, topicsActive: 0, topicsBlocked: 0 },
          lastUpdatedAt: 0,
          topics: [],
        })
      }
      return projectMap.get(lane.id)
    }
    for (const view of allViews) {
      const project = projectForLane(laneFor(view.executor))
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
      const project = projectForLane(projectLane ? projectLane.lane : { id: 'unassigned', label: '未分配', kind: 'unassigned' })
      return {
        topicId: topic.topicId,
        title: topic.title,
        level: topic.level,
        parentId: topic.parentId || null,
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
      const lane = laneFor(view.executor)
      if (!unclassifiedByProject.has(lane.id)) unclassifiedByProject.set(lane.id, [])
      unclassifiedByProject.get(lane.id).push(view)
    }
    for (const [laneId, views] of unclassifiedByProject) {
      const project = projectForLane(laneFor(views[0].executor))
      const card = topicCard({ topicId: null, title: '未分类', level: 1, brief: '', unclassified: true, updatedAt: 0, createdAt: 0 }, views)
      card.topicId = 'unclassified:' + laneId
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
      const card = cardByTopicId.get(primaryId || ('unclassified:' + lane.id))
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
        archived: view.archived,
        readyAt: view.readyAt,
        queueState: view.queueState,
        queueText: view.queueText,
        laneId: lane.id,
        laneLabel: lane.label,
        primaryTopicId: primaryId,
        projectId: card ? card.projectId : lane.id,
        projectTitle: card ? card.projectTitle : lane.label,
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
      ? { topicId: raw, title: '未分类', level: 1, brief: '', unclassified: true, archived: false }
      : this.store.topic(raw)
    if (!topic) return { ok: false, code: 'topic_missing', message: 'topic not found: ' + raw }
    const items = await this.listSessions()
    const sessions = new Map(items.map(item => [String(item.sessionId), item]))
    const archived = this.archivedSessions()
    const byId = new Map()
    for (const record of this.store.historyRecords()) {
      const ticket = normalizeTicket(record.ticket)
      if (!ticket.ticketId) continue
      const known = byId.get(ticket.ticketId)
      if (!known || (ticket.closedAt || 0) > (known.closedAt || 0)) byId.set(ticket.ticketId, ticket)
    }
    for (const ticket of this.store.tickets()) byId.set(ticket.ticketId, ticket)
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
      const queue = this.store.queueInfo(ticket)
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
        archived: !this.store.ticket(ticket.ticketId),
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
    const tickets = this.store.tickets()
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
    const intakes = this.store.intakesForTurn(this.currentRiaTurn)
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
    const intake = this.store.ticket(ticketId)
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
    const resolved = this.store.resolveIntake(ticketId, disposition)
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

  settingsPayload() {
    const settings = this.store.settings()
    settings.style = { ...settings.style, effectiveText: voicePrompt(settings.style) }
    settings.reflectionStatus = this.reflectionStatusSummary()
    settings.memoryStatus = memoryStatusView(this.store.readMemory(), settings.memory)
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

  async toolReflect(args, exec) {
    const signal = exec && exec.signal ? exec.signal : NEVER_ABORTED
    const action = asString(args.action)
    if (action === 'status') return this.toolReflectStatus(signal)
    if (action === 'begin') return this.toolReflectBegin(args, signal)
    if (action === 'dispatch') return this.toolReflectDispatch(args, signal)
    if (action === 'finish') return this.toolReflectFinish(args, signal)
    if (action === 'abort') return this.toolReflectAbort(args)
    return this.reflectionInvalid('action must be status, begin, dispatch, finish or abort')
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
    return this.store.tickets()
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
    const hot = this.store.tickets()
    let list
    if (scope === 'open') {
      list = hot.filter(ticket => !isTerminal(ticket.status))
    } else if (scope === 'history') {
      list = hot.filter(ticket => isTerminal(ticket))
      const seen = new Set(list.map(ticket => ticket.ticketId))
      for (const record of this.store.historyRecords()) {
        const ticket = normalizeTicket(record.ticket)
        if (ticket.ticketId && !seen.has(ticket.ticketId)) {
          seen.add(ticket.ticketId)
          list.push(ticket)
        }
      }
    } else {
      const byId = new Map()
      for (const record of this.store.historyRecords()) {
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
      memoryChars: measureText(this.store.readMemory()).chars,
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
      'Read one small context slice for this run: memory (Ria memory.md, at most 4KB), outbox (at most 50 recent or undelivered entries), or schedule (today returns an empty view because scheduled reflection runs are not wired yet). Text is redacted before it leaves the tool. Read-only.',
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

  summaryWithQueue(ticket) {
    return { ...ticketSummary(ticket), ...this.store.queueInfo(ticket), primaryTopicId: this.store.primaryTopicFor(ticket.ticketId) }
  }

  async toolStatus(args, signal) {
    const wechatAutoPause = this.store.settings().wechatAutoPause
    if (args.ticketId) {
      const id = asString(args.ticketId)
      const hot = this.store.ticket(id)
      if (hot) return { scope: 'ticket', wechatAutoPause, ticket: this.summaryWithQueue(hot), archived: false, attentionOverview: this.attentionOverview(), outbox: this.outboxSummary(id) }
      const archived = this.store.findArchivedTicket(id)
      if (archived) return { scope: 'ticket', wechatAutoPause, ticket: { ...ticketSummary(archived), primaryTopicId: this.store.primaryTopicFor(id) }, archived: true, attentionOverview: this.attentionOverview(), outbox: this.outboxSummary(id) }
      return { scope: 'ticket', wechatAutoPause, ticket: null, archived: false, found: false, attentionOverview: this.attentionOverview(), outbox: this.outboxSummary(id) }
    }
    if (args.scope === 'history' && !args.sessionId) {
      return {
        scope: 'history',
        wechatAutoPause,
        tickets: this.store.historyTickets(args.limit),
        archived: true,
        attentionOverview: this.attentionOverview(),
        outbox: this.outboxSummary(),
      }
    }
    const scope = args.scope === 'recent' && !args.sessionId
      ? 'recent'
      : (args.scope === 'sessions' || args.sessionId ? 'sessions' : 'tickets')
    if (scope === 'tickets') {
      return {
        scope,
        wechatAutoPause,
        riaSessionId: this.store.riaSessionId || null,
        tickets: this.store.tickets().map(ticket => this.summaryWithQueue(ticket)),
        queue: this.store.queueOverview(),
        attentionOverview: this.attentionOverview(),
        outbox: this.outboxSummary(),
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
      const model = this.sessionModel(summary)
      if (model) {
        item.provider = model.provider
        item.model = model.model
        if (model.reasoningEffort) item.reasoningEffort = model.reasoningEffort
      }
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
        wechatAutoPause,
        windowDays: RECENT_WORKER_WINDOW_MS / 86400000,
        limit: RECENT_WORKER_LIMIT,
        workers,
        attentionOverview: this.attentionOverview(),
        outbox: this.outboxSummary(),
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
      return { scope, wechatAutoPause, session: found, state, attentionOverview: this.attentionOverview(), outbox: this.outboxSummary(), pendingDeliveries: this.store.deliveries().length }
    }
    return { scope, wechatAutoPause, sessions, attentionOverview: this.attentionOverview(), outbox: this.outboxSummary(), pendingDeliveries: this.store.deliveries().length }
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
  async workingExecutorProblem(executor, signal = NEVER_ABORTED) {
    const id = String(executor)
    if (!id || id === 'self') return undefined
    const state = await this.workerBusy(id, signal)
    if (state.running) return undefined
    if (state.unknown) {
      const message = '无法读取 worker ' + id + ' 的运行状态，不能确认它在跑；未把工单置为 working。请稍后重试，或改用 status=open。'
      return { code: 'executor_state_unknown', message }
    }
    const message = 'worker ' + id + ' 当前没有运行中的 turn，不能把工单置为 working；请先用 ria_request 派发，或改用 status=open。'
    return { code: 'executor_idle', message }
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
    const ticketId = asString(args.ticketId)
    if (!ticketId) throw new Error('ticketId is required')
    const ticket = this.store.ticket(ticketId)
    if (!ticket) throw new Error('ticket not found: ' + ticketId)
    if (isTerminal(ticket.status)) throw new Error('ticket is closed: ' + ticketId)
    // A blocked ticket is parked, not dispatchable. The ticket state machine
    // has no blocked -> working edge (lib/tickets.mjs), so delivering first and
    // transitioning afterwards would send the message and then fail. Reject
    // before any note, dependency, attachment, or delivery work. This covers
    // waitingOn=approval and environment too: an approval reopens by itself
    // when the decision lands, and an environment block must be reopened
    // explicitly, so neither should race a new dispatch.
    if (ticket.status === 'blocked') {
      const waitingOn = ticket.waitingOn || 'user'
      const blockedReason = ticket.blockedReason || '未记录原因'
      const message = '工单 ' + ticketId + ' 处于 blocked（waitingOn=' + waitingOn + '）：' + blockedReason + '。未投递。请先用 ria_ticket 把工单改回 open 再派发。'
      const results = targets.map(target => ({
        targetSessionId: target,
        ok: false,
        code: 'ticket_blocked',
        message,
        error: message,
        ticketId,
        waitingOn,
        blockedReason,
      }))
      return {
        ok: false,
        code: 'ticket_blocked',
        ticketId,
        waitingOn,
        blockedReason,
        message,
        error: message,
        results,
        pendingDeliveries: this.store.deliveries().length,
      }
    }
    const note = this.dispatchNote(args)

    // A ticket gated on dependencies may only be dispatched once every
    // upstream ticket is done, and the caller must prove it saw the current
    // ready event. The token is derived from ticketId:readyAt:revision so a
    // repeated wake cannot dispatch the same ticket twice.
    if (ticket.dependsOn.length) {
      const info = this.store.queueInfo(ticket)
      if (ticket.status === 'open' && ticket.waitingOn === 'dependency') {
        const message = '工单 ' + ticketId + ' 还没就绪：' + info.queueText + '。未投递。'
        return { ok: false, code: 'ticket_not_ready', ticketId, queueState: info.queueState, queueText: info.queueText, message, error: message }
      }
      if (ticket.status === 'open') {
        const expected = this.store.queueTokenFor(ticket)
        const provided = asString(args.queueToken)
        if (!expected || provided !== expected) {
          const message = provided
            ? '工单 ' + ticketId + ' 的 queueToken 已过期；请重新读取 ria_status 或用最新的 [Queue ready] 通知。未投递。'
            : '工单 ' + ticketId + ' 有依赖，派发时必须带 queueToken（见 ria_status 或 [Queue ready] 通知）。未投递。'
          return { ok: false, code: 'ticket_not_ready', ticketId, queueState: info.queueState, queueText: info.queueText, message, error: message }
        }
      } else if (ticket.status === 'working' && asString(args.queueToken)) {
        const message = '工单 ' + ticketId + ' 已经在 working，这次 queueToken 对应的 ready 事件已经派发过。未投递。'
        return { ok: false, code: 'ticket_not_ready', ticketId, queueState: info.queueState, queueText: info.queueText, message, error: message }
      }
    }

    const items = await this.listSessions(signal)
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
      const problem = await this.sessionProblem(target, { items, archived })
      if (problem.code) {
        reject(target, problem.code, problem.message + '。未投递。')
        continue
      }
      if (ticket.executor !== target) {
        reject(target, 'ticket_executor_mismatch', '工单 ' + ticketId + ' 的 executor 是 ' + ticket.executor + '，不是目标会话 ' + target + '。未投递。')
        continue
      }
      const busy = await this.workerBusy(target, signal)
      if (mode === 'queue') {
        if (busy.busy) {
          const message = '目标 worker ' + target + ' 正在运行或已有排队消息（running=' + busy.running + '，排队 ' + busy.queued + ' 条），不能用 queue 模式再排队。不要给忙碌 worker 排队：改用 dependsOn 表达先后顺序，或只用 mode=steer 做信息同步。未投递。'
          reject(target, 'worker_busy', message)
          continue
        }
      } else if (busy.unknown || !busy.running) {
        // Steer injects input into the turn that is executing right now. DSH's
        // sessionController.steer has no running-state precheck
        // (dsh-api-session-controller/lib/index.js:857), so an idle target
        // would accept the call and silently lose the message. Refuse it here;
        // a busy-but-running worker (queued > 0) is still a valid steer target.
        const state = busy.unknown ? '无法读取运行状态' : '当前没有运行中的 turn（running=false）'
        const message = '目标 worker ' + target + ' ' + state + '，不能用 mode=steer 注入：消息会被静默丢掉。未投递。请改用 mode=queue，或等这轮结束再发。'
        reject(target, 'steer_requires_running', message)
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
      const pending = this.registerDispatch(delivery)
      try {
        await this.ctx.sessionController.prompt({ requestId, sessionId: target, mode, content }, signal)
        this.store.removeDelivery(delivery.deliveryId)
        const moved = this.store.transitionTicket(ticket.ticketId, 'working', {
          attempt: this.dispatchAttempt(pending),
          reason: 'dispatch accepted',
        })
        this.forgetDispatch(requestId)
        if (!moved.ok) throw transitionError(moved.code, moved.message)
        moved.ticket.recovery = { ...moved.ticket.recovery, count: 0 }
        try {
          this.store.touchWorker(target, ticketId, moved && moved.ticket)
        } catch (error) {
          this.log('warn', 'could not record recent worker ' + target + ': ' + String(error && error.message ? error.message : error))
        }
        results.push({ targetSessionId: target, ok: true, requestId, ticketId })
      } catch (error) {
        this.forgetDispatch(requestId)
        results.push({ targetSessionId: target, ok: false, requestId, ticketId, error: String(error && error.message ? error.message : error) })
      }
    }
    if (results.some(item => item.ok)) {
      const failedTargets = results.filter(item => !item.ok).map(item => item.targetSessionId)
      const visibleNote = failedTargets.length ? note + '\n未投递的目标：' + failedTargets.join(', ') + '。请查看工具结果处理失败。' : note
      const noteId = this.appendDispatchNote(exec.agent, visibleNote, ticketId)
      if (noteId) this.notifyDispatchNote(visibleNote, true, ticketId, noteId)
      void this.pumpOutbox('request')
      if (!failedTargets.length) exec.concludeTurn()
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
  activeFileChannel() {
    const candidates = []
    for (const channel of FILE_CHANNEL_ORDER) {
      const service = this.channelFileService(channel)
      if (!service || !this.channelFileHasTarget(channel)) continue
      const last = channel === 'wechat' ? this.wechat.lastInboundAt : service.lastInboundAt
      candidates.push({ channel, last: Number.isFinite(last) ? last : 0, order: FILE_CHANNEL_ORDER.indexOf(channel) })
    }
    if (!candidates.length) return undefined
    candidates.sort((a, b) => b.last - a.last || a.order - b.order)
    return candidates[0]
  }

  channelFileIsPaused(channel) {
    return Boolean(this.channelPauseState(channel).paused)
  }

  queueChannelFile({ channel, path, name, bytes, note }, reason) {
    try {
      const queued = this.outbox.enqueue({
        kind: 'channel_file_send',
        dedupeKey: 'channel_file:' + randomUUID(),
        payload: { channel, path, name, bytes, note },
      })
      void this.pumpOutbox('file-queued')
      return {
        ok: true,
        queued: true,
        channel,
        name,
        bytes,
        path,
        entryId: queued.entry.id,
        message: reason + '文件已排队，恢复推送后自动发送。',
      }
    } catch (error) {
      return {
        ok: false,
        code: 'file_queue_failed',
        channel,
        name,
        bytes,
        path,
        message: '文件排队失败：' + errorText(error),
        error: errorText(error),
      }
    }
  }

  async toolSendFile(args, exec) {
    const requested = asString(args.path)
    if (!requested) return { ok: false, code: 'path_required', message: 'path 必填，且必须是绝对路径。', error: 'path is required' }
    if (!isAbsolute(requested)) {
      return { ok: false, code: 'path_not_absolute', path: requested, message: 'path 必须是绝对路径。', error: 'path must be absolute' }
    }
    let real
    try {
      real = realpathSync(requested)
    } catch (error) {
      return { ok: false, code: 'file_not_found', path: requested, message: '文件不存在：' + requested, error: errorText(error) }
    }
    let stats
    try {
      stats = statSync(real)
    } catch (error) {
      return { ok: false, code: 'file_not_found', path: real, message: '无法读取文件：' + real, error: errorText(error) }
    }
    if (!stats.isFile()) {
      return { ok: false, code: 'file_not_regular', path: real, message: '不是一个普通文件：' + real, error: 'not a regular file' }
    }
    if (!stats.size) {
      return { ok: false, code: 'file_empty', path: real, message: '文件是空的：' + real, error: 'empty file' }
    }
    const name = safeClawFileName(basename(real))
    if (!isAllowedClawFile(name)) {
      return {
        ok: false,
        code: 'file_unsupported',
        path: real,
        name,
        message: '不支持的文件类型：' + (name.split('.').pop() || '(无扩展名)') + '。允许：' + CLAW_FILE_EXTENSIONS.join(', '),
        error: 'unsupported file type',
      }
    }
    const target = this.activeFileChannel()
    if (!target) {
      return {
        ok: false,
        code: 'no_target',
        path: real,
        name,
        bytes: stats.size,
        message: '没有可用的手机通道：请先在微信或 QQ 给 Ria 发一条消息，再发送文件。',
        error: 'no active channel',
      }
    }
    const options = this.channelFileOptions(target.channel)
    if (!options.enabled) {
      return { ok: false, code: 'file_send_disabled', channel: target.channel, path: real, name, message: '当前通道的文件发送已关闭。', error: 'file sending disabled' }
    }
    if (stats.size > options.maxBytes) {
      return {
        ok: false,
        code: 'file_too_large',
        channel: target.channel,
        path: real,
        name,
        bytes: stats.size,
        message: '文件 ' + name + '（' + formatFileSize(stats.size) + '）超过 ' + formatFileSize(options.maxBytes) + ' 上限。',
        error: 'file too large',
      }
    }
    const note = asString(args.note)
    if (this.channelFileIsPaused(target.channel)) {
      return this.queueChannelFile({ channel: target.channel, path: real, name, bytes: stats.size, note }, target.channel + ' 推送已暂停，')
    }
    let buffer
    try {
      buffer = readFileSync(real)
    } catch (error) {
      return { ok: false, code: 'file_read_failed', path: real, name, message: '读取文件失败：' + errorText(error), error: errorText(error) }
    }
    const service = this.channelFileService(target.channel)
    try {
      await service.sendFile(name, buffer)
    } catch (error) {
      if (isPausedError(error)) {
        return this.queueChannelFile({ channel: target.channel, path: real, name, bytes: stats.size, note }, target.channel + ' 推送已暂停，')
      }
      const code = (error && error.code) || 'file_send_failed'
      const reason = errorText(error)
      const record = service.recordFileSend({
        delivered: false,
        name,
        bytes: stats.size,
        path: real,
        code,
        error: reason,
        ret: error && error.ret,
        errmsg: error && error.errmsg,
      })
      return {
        ok: false,
        code: 'file_send_failed',
        channel: target.channel,
        name,
        bytes: stats.size,
        path: real,
        message: '文件发送失败：' + reason,
        error: reason,
        lastFileSend: record,
      }
    }
    const record = service.recordFileSend({ delivered: true, name, bytes: stats.size, path: real })
    const result = {
      ok: true,
      delivered: true,
      channel: target.channel,
      name,
      bytes: stats.size,
      path: real,
      lastFileSend: record,
    }
    if (note) {
      try {
        const sent = await service.sendNote('📎 ' + note)
        if (sent === false) result.noteError = '通道未接受说明文字'
      } catch (error) {
        result.noteError = errorText(error)
      }
    }
    return result
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
   * A fresh Claw inbound message can carry a fresh context_token. Re-arm the
   * fallback replies that failed on the old token without spending attempts.
   */
  async handleWechatClawInbound() {
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
   * Queue both the local approval card and its WeChat mirror. The local card
   * waits for an open Ria turn; the WeChat message can go out immediately.
   * Deduplication is keyed by the approval id, which is unique per request.
   */
  notifyApproval(record) {
    const note = approvalQuestion(record)
    const noteId = newId('note_')
    const payload = {
      approvalId: record.approvalId,
      ticketId: record.ticketId,
      workerSessionId: record.workerSessionId,
      toolName: record.toolName,
      note,
      noteId,
    }
    if (record.reason) payload.reason = record.reason
    try {
      this.outbox.enqueue({ kind: 'approval_note', dedupeKey: record.approvalId, payload })
      this.outbox.enqueue({ kind: 'wechat_approval_note', dedupeKey: record.approvalId, payload })
    } catch (error) {
      this.log('warn', 'could not queue approval note: ' + String(error && error.message ? error.message : error))
    }
    void this.pumpOutbox('approval')
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
            if (item.kind === 'queue_wake') this.store.markReadyNotified(item.payload.ticketId, item.payload.readyAt)
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
    const ticket = this.store.ticket(asString(payload.ticketId))
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
      const ticket = this.store.ticket(asString(entry.payload && entry.payload.ticketId))
      if (!ticket) continue
      items.push({ ticket, info: this.store.queueInfo(ticket) })
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
    try {
      result.queue = (await this.readQueue(sessionId, signal)).queue
    } catch (error) {
      result.queue = null
      result.queueError = String(error && error.message ? error.message : error)
    }
    return result
  }

  /** Pending queue view shared by ria_read and ria_queue list. */
  queueView(raw) {
    if (!Array.isArray(raw)) return null
    return raw.map(item => {
      const view = { id: String(item.id), placement: asString(item.placement) || 'unknown' }
      if (item.rpcId) view.rpcId = String(item.rpcId)
      view.preview = queuePreview(item.content)
      return view
    })
  }

  /**
   * Read the pending in-memory queue. A cold session has no queue, so raw is
   * null; callers must distinguish that from an empty live queue.
   */
  async readQueue(sessionId, signal) {
    const state = await this.ctx.sessionController.state({ sessionId: String(sessionId) }, signal)
    const raw = Array.isArray(state && state.queue) ? state.queue : null
    return { running: Boolean(state && state.running), raw, queue: this.queueView(raw) }
  }

  async toolQueue(args, signal) {
    const action = args.action === undefined ? 'list' : args.action
    if (action !== 'list' && action !== 'remove') throw new Error('unknown queue action: ' + String(action))
    const sessionId = asString(args.sessionId)
    if (!sessionId) throw new Error('sessionId is required')
    const problem = await this.sessionProblem(sessionId, { signal })
    if (problem.code) return { ok: false, sessionId, code: problem.code, message: problem.message, error: problem.message }

    let viewed
    try {
      viewed = await this.readQueue(sessionId, signal)
    } catch (error) {
      const message = '无法读取会话 ' + sessionId + ' 的队列：' + String(error && error.message ? error.message : error)
      return { ok: false, sessionId, code: 'queue_read_failed', message, error: message }
    }
    if (action === 'list') return { ok: true, sessionId, running: viewed.running, queue: viewed.queue }

    const itemId = asString(args.itemId)
    const rpcId = asString(args.rpcId)
    if (!itemId && !rpcId) throw new Error('remove requires itemId or rpcId')
    const findItem = raw => {
      if (!Array.isArray(raw)) return null
      if (itemId) return raw.find(item => String(item.id) === itemId) || null
      return raw.find(item => item.rpcId && String(item.rpcId) === rpcId) || null
    }
    let item = findItem(viewed.raw)
    // rpcId is the only handle Ria has for a queued follow-up. A cold session
    // has no in-memory queue, so wake it once and read the restored queue.
    if (!item && !itemId && viewed.raw === null) {
      try {
        await this.ctx.sessionController.resolveAgent(sessionId)
        viewed = await this.readQueue(sessionId, signal)
        item = findItem(viewed.raw)
      } catch (error) {
        this.log('warn', 'could not resolve ' + sessionId + ' to find queued rpcId ' + rpcId + ': ' + String(error && error.message ? error.message : error))
      }
    }
    const targetId = itemId || (item ? String(item.id) : '')
    // A live queue that does not contain the requested item is authoritative;
    // only a cold session may hand an itemId straight to the host.
    if (!targetId || (viewed.raw !== null && !item)) {
      const wanted = itemId ? 'itemId ' + itemId : 'rpcId ' + rpcId
      const message = '会话 ' + sessionId + ' 的待处理队列里找不到 ' + wanted + '。'
      return { ok: false, sessionId, code: 'queue_item_not_found', message, error: message }
    }

    try {
      const outcome = await this.ctx.sessionController.updateQueue({ sessionId, itemId: targetId, action: { kind: 'remove' } })
      if (outcome && outcome.accepted === false) throw new Error('host did not accept the removal')
    } catch (error) {
      const detail = String(error && error.message ? error.message : error)
      const code = error && typeof error === 'object' ? error.code : undefined
      if (code === 'session/queue-item-not-found') {
        const message = '会话 ' + sessionId + ' 的待处理队列里已经没有条目 ' + targetId + '。'
        return { ok: false, sessionId, code: 'queue_item_not_found', message, error: message }
      }
      const message = '无法撤回会话 ' + sessionId + ' 的待处理条目 ' + targetId + '：' + detail
      return { ok: false, sessionId, code: 'queue_remove_failed', message, error: message }
    }
    return {
      ok: true,
      sessionId,
      removed: {
        id: targetId,
        placement: item ? (asString(item.placement) || null) : null,
        preview: item ? queuePreview(item.content) : null,
      },
    }
  }

  async toolTopic(args) {
    const action = asString(args.action) || 'list'
    try {
      if (action === 'create') {
        const topic = this.store.addTopic({
          title: args.title,
          brief: args.brief,
          level: args.level,
          parentId: args.parentId,
        })
        return { ok: true, topic }
      }
      if (action === 'update') {
        const topicId = asString(args.topicId)
        if (!topicId) throw transitionError('topic_missing', 'topicId is required for update')
        const patch = {}
        if (args.title !== undefined) patch.title = args.title
        if (args.brief !== undefined) patch.brief = args.brief
        if (args.level !== undefined) patch.level = args.level
        if (args.parentId !== undefined) patch.parentId = args.parentId
        if (!Object.keys(patch).length) throw transitionError('topic_invalid', 'update needs title, brief, level or parentId')
        return { ok: true, topic: this.store.updateTopic(topicId, patch) }
      }
      if (action === 'link') {
        const topicId = asString(args.topicId)
        const ticketId = asString(args.ticketId)
        if (!topicId) throw transitionError('topic_missing', 'topicId is required for link')
        if (!ticketId) throw transitionError('ticket_missing', 'ticketId is required for link')
        const role = args.role === 'related' ? 'related' : 'primary'
        const result = this.store.linkTicket(topicId, ticketId, role)
        return { ok: true, ...result }
      }
      if (action === 'unlink') {
        const topicId = asString(args.topicId)
        const ticketId = asString(args.ticketId)
        if (!topicId) throw transitionError('topic_missing', 'topicId is required for unlink')
        if (!ticketId) throw transitionError('ticket_missing', 'ticketId is required for unlink')
        return { ok: true, ...this.store.unlinkTicket(topicId, ticketId) }
      }
      if (action === 'merge') {
        const sourceTopicId = asString(args.sourceTopicId)
        const targetTopicId = asString(args.targetTopicId)
        if (!sourceTopicId) throw transitionError('topic_missing', 'sourceTopicId is required for merge')
        if (!targetTopicId) throw transitionError('topic_missing', 'targetTopicId is required for merge')
        return { ok: true, ...this.store.mergeTopic(sourceTopicId, targetTopicId) }
      }
      if (action === 'archive') {
        const topicId = asString(args.topicId)
        if (!topicId) throw transitionError('topic_missing', 'topicId is required for archive')
        return { ok: true, topic: this.store.archiveTopic(topicId) }
      }
      if (action === 'suggest') {
        const goal = asString(args.goal)
        if (!goal) throw transitionError('topic_invalid', 'goal is required for suggest')
        const limit = args.limit === undefined ? undefined : Number(args.limit)
        if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1 || limit > TOPIC_SUGGEST_MAX_LIMIT)) {
          throw transitionError('topic_invalid', 'suggest limit must be an integer between 1 and ' + TOPIC_SUGGEST_MAX_LIMIT)
        }
        const topics = this.store.topics()
        const links = this.store.links()
        const hotTickets = this.store.tickets()
        const knownById = new Map()
        for (const ticket of hotTickets) knownById.set(ticket.ticketId, ticket)
        for (const topic of topics) {
          for (const link of this.store.topicLinks(topic.topicId)) {
            if (knownById.has(link.ticketId)) continue
            const ticket = this.store.knownTicket(link.ticketId)
            if (ticket) knownById.set(ticket.ticketId, ticket)
          }
        }
        return {
          ok: true,
          ...topicSuggestions({
            goal,
            limit,
            topics,
            links,
            tickets: hotTickets,
            knownTickets: [...knownById.values()],
          }),
        }
      }
      if (action !== 'list') throw transitionError('topic_invalid', 'unknown topic action: ' + action)
      const includeArchived = args.includeArchived === true
      const topics = this.store.topics()
        .filter(topic => includeArchived || (!topic.archivedAt && !topic.mergedInto))
        .map(topic => {
          const counts = { total: 0, open: 0, working: 0, blocked: 0, done: 0 }
          for (const link of this.store.topicLinks(topic.topicId)) {
            const ticket = this.store.knownTicket(link.ticketId)
            if (!ticket) continue
            counts.total += 1
            if (isTerminal(ticket.status)) counts.done += 1
            else if (ticket.status === 'working') counts.working += 1
            else if (ticket.status === 'blocked') counts.blocked += 1
            else counts.open += 1
          }
          return { ...topic, counts }
        })
      return { ok: true, topics, count: topics.length }
    } catch (error) {
      if (!error || !error.code) throw error
      return { ok: false, code: error.code, message: error.message, error: error.message }
    }
  }

  async toolApproval(args) {
    const action = args.action === undefined ? 'list' : args.action
    if (action !== 'list') throw new Error('unknown approval action: ' + String(action))
    const at = now()
    const pending = this.approvals.list().map(item => ({ ...item, expiresInMs: Math.max(0, item.expiresAt - at) }))
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
    const settings = this.store.memorySettings()
    const invalid = message => ({ ok: false, code: 'invalid_argument', message, error: message })
    const budgetFailure = text => {
      const stats = inspectMemory(text, settings)
      return stats.overBudget ? memoryBudgetFailure(stats) : null
    }
    const replacementText = () => {
      const hasContent = Object.prototype.hasOwnProperty.call(args, 'content') && args.content !== undefined
      const hasEntries = Object.prototype.hasOwnProperty.call(args, 'entries') && args.entries !== undefined
      if (hasContent === hasEntries) return { error: 'replace needs exactly one of content or entries' }
      if (hasContent) {
        if (typeof args.content !== 'string') return { error: 'content must be a string' }
        return { text: args.content }
      }
      if (!Array.isArray(args.entries)) return { error: 'entries must be an array' }
      const lines = []
      for (let index = 0; index < args.entries.length; index += 1) {
        const entry = args.entries[index]
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
          return { error: 'entries[' + index + '] must be an object' }
        }
        const key = entry.key === undefined || entry.key === null ? '' : entry.key
        if (typeof key !== 'string') return { error: 'entries[' + index + '].key must be a string' }
        if (typeof entry.text !== 'string') return { error: 'entries[' + index + '].text must be a string' }
        if (/[\r\n]/.test(key)) return { error: 'entries[' + index + '].key must be one line' }
        if (/[\r\n]/.test(entry.text)) return { error: 'entries[' + index + '].text must be one line; use content for multi-line formatting' }
        const label = key.trim()
        const text = entry.text.trim()
        if (label.includes('*')) return { error: 'entries[' + index + '].key must not contain "*"' }
        if (!text) return { error: 'entries[' + index + '].text must not be empty' }
        lines.push(label ? '- **' + label + '**: ' + text : '- ' + text)
      }
      return { text: lines.length ? lines.join('\n') + '\n' : '' }
    }
    if (action === 'read') {
      const scope = args.scope === undefined ? 'core' : args.scope
      if (scope === 'archive') {
        const slug = asString(args.path)
        if (!slug) throw new Error('path is required for read scope=archive')
        const offset = args.offset === undefined ? 0 : args.offset
        if (!Number.isInteger(offset) || offset < 0) throw new Error('offset must be a non-negative integer')
        return { ok: true, scope: 'archive', ...this.store.readMemoryArchive(slug, offset) }
      }
      if (scope !== 'core') throw new Error('unknown memory scope: ' + String(scope))
      const text = this.store.readMemory()
      return {
        ok: true,
        scope: 'core',
        text,
        ...memoryStatusView(text, settings),
        archives: this.store.listMemoryArchives(),
      }
    }
    if (action === 'list') {
      const archives = this.store.listMemoryArchives()
      return { ok: true, archives, count: archives.length }
    }
    if (action === 'remember') {
      const text = asString(args.text)
      if (!text) throw new Error('text is required for remember')
      const key = asString(args.key)
      const line = key ? '- **' + key + '**: ' + text : '- ' + text
      let current = this.store.readMemory()
      if (current && !current.endsWith('\n')) current += '\n'
      const candidate = current + line + '\n'
      const failed = budgetFailure(candidate)
      if (failed) return failed
      const written = this.store.writeMemory(candidate)
      const warning = memoryWarningText(written)
      return { ok: true, ...memoryStatusView(this.store.readMemory(), settings), ...(warning ? { warning } : {}) }
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
      if (!removed) {
        return { ok: true, removed: 0, ...memoryStatusView(current, settings) }
      }
      const candidate = kept.join('\n')
      const failed = budgetFailure(candidate)
      if (failed) return failed
      const written = this.store.writeMemory(candidate)
      const warning = memoryWarningText(written)
      return { ok: true, removed, ...memoryStatusView(this.store.readMemory(), settings), ...(warning ? { warning } : {}) }
    }
    if (action === 'replace') {
      const parsed = replacementText()
      if (parsed.error) return invalid(parsed.error)
      const failed = budgetFailure(parsed.text)
      if (failed) return failed
      const written = this.store.writeMemory(parsed.text)
      const warning = memoryWarningText(written)
      return {
        ok: true,
        action: 'replace',
        ...memoryStatusView(this.store.readMemory(), settings),
        ...(warning ? { warning } : {}),
        archives: this.store.listMemoryArchives(),
      }
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
    for (const ticket of this.store.tickets()) {
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
          const ticket = this.store.ticket(ticketId)
          if (ticket && (ticket.status === 'open' || ticket.status === 'working')) {
            const moved = this.store.transitionTicket(ticket.ticketId, 'working', { attempt: this.dispatchAttempt(pendingDispatch) })
            if (moved.ok) moved.ticket.recovery = { ...moved.ticket.recovery, count: 0 }
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
      const ticket = this.store.ticket(ticketId)
      if (!ticket) return
      if (ticket.status === 'forked') {
        for (const childId of ticket.childTicketIds) visit(childId)
        return
      }
      if (ticket.status === 'open' && ticket.waitingOn === 'dependency') return
      if (['intake', 'open', 'working'].includes(ticket.status)) units.push(ticket)
    }
    for (const ticket of this.store.tickets()) {
      if (!ticket.parentTicketId) visit(ticket.ticketId)
    }
    return units
  }

  /**
   * Approvals live only in memory, so every restart starts with an empty
   * approval queue. A ticket left blocked on an approval that no longer exists
   * would stay blocked forever; return it to working before recovery runs.
   */
  reconcileApprovalTickets() {
    const pending = new Set(this.approvals.list().map(item => item.approvalId))
    const stale = this.store.tickets().filter(ticket => ticket.status === 'blocked' && ticket.waitingOn === 'approval')
    let recovered = 0
    for (const ticket of stale) {
      const ref = ticket.attention && ticket.attention.ref
      if (ref && pending.has(ref)) continue
      const reason = 'approval queue is empty after restart'
      const opened = this.store.transitionTicket(ticket.ticketId, 'open', { actor: 'system', reason })
      if (!opened || opened.ok === false) {
        this.log('warn', 'could not reopen ' + ticket.ticketId + ' after a lost approval: ' + String(opened && opened.message ? opened.message : 'unknown error'))
        continue
      }
      const attempt = opened.ticket && opened.ticket.attempt
      const options = { actor: 'system', reason, waitingOn: 'worker' }
      if (!attempt || !attempt.lastRequestId) options.attempt = { legacy: true }
      const working = this.store.transitionTicket(ticket.ticketId, 'working', options)
      if (!working || working.ok === false) {
        this.log('warn', 'could not return ' + ticket.ticketId + ' to working after a lost approval: ' + String(working && working.message ? working.message : 'unknown error'))
        continue
      }
      recovered += 1
    }
    if (recovered) this.log('info', 'recovered ' + recovered + ' ticket(s) left blocked on approvals after restart')
  }

  /**
   * Stop recovering one ticket: park it as blocked, write the failure code, and
   * emit the one-shot recovery_exhausted feedback. A blocked ticket is no
   * longer a recovery unit, so this happens exactly once.
   */
  async blockForRecovery(ticket, agent) {
    const body = '工单 ' + ticket.ticketId + ' 自动恢复已达上限（' + MAX_RECOVERY_ATTEMPTS + '/' + MAX_RECOVERY_ATTEMPTS + '），已停止自动推进；需要用户手动处理。'
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
    const noteId = this.appendDispatchNote(agent, body, ticket.ticketId)
    if (noteId) this.notifyDispatchNote(body, true, ticket.ticketId, noteId)
    void this.pumpOutbox('recovery')
  }

  async startup() {
    if (this.started) return
    this.started = true
    try {
      const logMigration = this.store.migrateTicketLogNames()
      if (logMigration.renamed) this.log('info', 'renamed ' + logMigration.renamed + ' legacy ticket log file(s)')
      for (const error of logMigration.errors) this.log('warn', 'could not rename a legacy ticket log: ' + error)
      const archived = this.store.archiveClosedTickets()
      if (archived.archived) this.log('info', 'archived ' + archived.archived + ' closed ticket(s)')
      if (archived.error) this.log('warn', 'could not archive closed tickets: ' + archived.error)
      await this.grants.reconcile()
      try {
        this.reconcileApprovalTickets()
      } catch (error) {
        this.log('warn', 'approval reconciliation failed: ' + String(error && error.message ? error.message : error))
      }
      try {
        await this.reconcileWorkspaceSessions()
      } catch (error) {
        this.log('warn', 'workspace reconciliation failed: ' + String(error && error.message ? error.message : error))
      }
      let dependencies = { ready: [], waiting: [], alerts: [], invalid: [] }
      this.dependencyReconciling = true
      try {
        dependencies = this.store.reconcileDependencies({ bootId: newId('boot_') })
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
        attentionOverview: this.attentionOverview(),
        outbox: this.outboxSummary(),
        pendingDeliveries: this.store.deliveries().length,
        grants: this.grants.list(),
        workerIdleNotifications: this.workerIdle.options,
        wechatClawAssistant: this.wechatClaw ? this.wechatClaw.lastAssistantForward || null : null,
        settings: this.store.settings(),
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
        if ('dispatchGuard' in body) {
          if (typeof body.dispatchGuard !== 'boolean') {
            jsonSend(res, 400, { error: 'body.dispatchGuard must be a boolean' })
            return
          }
          patch.dispatchGuard = body.dispatchGuard
        }
        if ('wechatAutoPause' in body) {
          if (typeof body.wechatAutoPause !== 'boolean') {
            jsonSend(res, 400, { error: 'body.wechatAutoPause must be a boolean' })
            return
          }
          patch.wechatAutoPause = body.wechatAutoPause
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
          jsonSend(res, 400, { error: 'body.dispatchGuard, body.wechatAutoPause, body.memory, body.reflection or body.style must be provided' })
          return
        }
        if (patch.reflection) {
          const result = await this.applyReflectionSettings(patch.reflection)
          if (!result.ok) {
            jsonSend(res, 500, { error: result.error, settings: result.settings })
            return
          }
          const other = {}
          if ('dispatchGuard' in patch) other.dispatchGuard = patch.dispatchGuard
          if ('wechatAutoPause' in patch) other.wechatAutoPause = patch.wechatAutoPause
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
  service.startOutbox()
  ctx.effect(() => () => service.shutdownOutbox(), 'dsh-ria: outbox')
  service.wechat.start(1200)
  service.wechatClaw.start(1600)
  service.qqBot.start(2000)
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
