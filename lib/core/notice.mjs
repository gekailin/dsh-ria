// Structured user-facing notices: ONE object is the source of truth, and every
// string a channel shows is derived from it by renderNotice().
//
// Why: notices used to be hand-built strings at ~20 call sites. Information
// (most importantly the complete ticket id) could be lost in formatting,
// clamping or re-wording, and there was no single place to inspect or test the
// shape. Constructors now call makeNotice() and never concatenate notice text;
// renderNotice() owns emoji, "#tail（full id）", status, clipping and the
// head-preserving clamp.
//
// Purity rules:
//  - a notice is plain JSON (string/number/boolean/null/array/object), so an
//    outbox entry or a router event can persist it verbatim;
//  - the short ticket tail is derived inside renderNotice from the COMPLETE
//    ticketId; constructors never pass a short id or pre-rendered text;
//  - there is no text→object parser and no legacy-text fallback table.

/** Every notice kind this build can render. */
export const KINDS = Object.freeze([
  'ticket.working',
  'ticket.done',
  'ticket.blocked',
  'ticket.failed',
  'ticket.cancelled',
  'approval.requested',
  'session.approval',
  'decision.needed',
  'approval.followup',
  'grant.auto_allowed',
  'grant.applied',
  'grant.reattached',
  'ticket.steer_undelivered',
  'ticket.stopped',
  'session.blocked_reminder',
  'session.abnormal_end',
  'relay.hint',
  'restart',
  'reflection',
  'channel.pause',
  'channel.degraded',
])

const KIND_SET = new Set(KINDS)
const TICKET_STATUSES = new Set(['done', 'blocked', 'failed', 'cancelled', 'working'])
const EMPTY_SUMMARY = '无摘要'
const ELLIPSIS = '…'

/** Required non-empty fields per kind; validation is explicit, never silent. */
const REQUIRED = Object.freeze({
  'ticket.working': ['ticketId'],
  'ticket.done': ['ticketId'],
  'ticket.blocked': ['ticketId'],
  'ticket.failed': ['ticketId'],
  'ticket.cancelled': ['ticketId'],
  'approval.requested': ['ticketId', 'tool'],
  'session.approval': ['sessionId', 'tool'],
  'decision.needed': ['ticketId'],
  'approval.followup': ['ticketId', 'outcome'],
  'grant.auto_allowed': ['scope'],
  'grant.applied': ['grantId', 'phase'],
  'grant.reattached': ['ticketId', 'grantId', 'executorId'],
  'ticket.steer_undelivered': ['ticketId'],
  'ticket.stopped': ['ticketId', 'mode'],
  'session.blocked_reminder': ['sessionId', 'waiting'],
  'session.abnormal_end': ['sessionId'],
  'relay.hint': [],
  restart: ['prevPid', 'newPid', 'reason'],
  reflection: [],
  'channel.pause': ['channel'],
  'channel.degraded': ['channel'],
})

/** Auto-pause copy per channel (moved here so the pause notice is object-first). */
export const PAUSE_NOTICE_COPY = Object.freeze({
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

const oneLine = value => String(value == null ? '' : value).replace(/\s+/g, ' ').trim()

function clamp(value, max) {
  const chars = [...String(value)]
  if (chars.length <= max) return chars.join('')
  return chars.slice(0, Math.max(1, max - 1)).join('') + ELLIPSIS
}

/** Clamp without ever cutting the head (ticket reference + status). */
function clampKeepingHead(value, max, head) {
  const chars = [...String(value)]
  if (chars.length <= max) return chars.join('')
  const cut = Math.max(head, Math.max(1, max - 1))
  if (chars.length <= cut) return chars.join('')
  return chars.slice(0, cut).join('') + ELLIPSIS
}

function firstSentence(value) {
  const raw = String(value == null ? '' : value).trim()
  if (!raw) return ''
  const line = raw.split(/\r?\n/)[0]
  const index = line.search(/[。！？.!?]/u)
  return oneLine(index >= 0 ? line.slice(0, index) : line)
}

function clock(ms) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).format(new Date(Number(ms) || Date.now())) + ' +08:00'
}

/**
 * The single ticket reference: the short tail is derived HERE from the complete
 * id. Constructors pass the full id only.
 * @param {string} value - complete ticket id.
 * @returns {string} "#<tail>（<full id>）", or "#------" when absent.
 */
export function formatTicketRef(value) {
  const id = String(value == null ? '' : value).trim()
  if (!id) return '#------'
  return '#' + id.slice(-6) + '（' + id + '）'
}

function sessionShortId(value) {
  return String(value == null ? '' : value).replace(/^session-/, '').slice(0, 6)
}

function assertJsonValue(value, path) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('notice field ' + path + ' must be a finite number')
    return
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertJsonValue(item, path + '[' + index + ']'))
    return
  }
  if (typeof value === 'object') {
    const proto = Object.getPrototypeOf(value)
    if (proto !== Object.prototype && proto !== null) {
      throw new Error('notice field ' + path + ' must be a plain JSON object')
    }
    for (const [key, item] of Object.entries(value)) {
      if (item === undefined) throw new Error('notice field ' + path + '.' + key + ' is undefined')
      assertJsonValue(item, path + '.' + key)
    }
    return
  }
  throw new Error('notice field ' + path + ' is not JSON-serializable: ' + typeof value)
}

function deepFreeze(value) {
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) deepFreeze(item)
    Object.freeze(value)
  }
  return value
}

/**
 * Build the single source of truth for one notice.
 * @param {object} input - { kind, ...fields }; kind must be in KINDS.
 * @returns {object} frozen plain-JSON notice.
 * @throws when the kind is unknown, a required field is missing, or a value is not plain JSON.
 */
export function makeNotice(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('notice must be a plain object')
  const kind = typeof input.kind === 'string' ? input.kind : ''
  if (!KIND_SET.has(kind)) throw new Error('unknown notice kind: ' + JSON.stringify(kind))
  for (const field of REQUIRED[kind] || []) {
    const value = input[field]
    const present = typeof value === 'string'
      ? value.trim() !== ''
      : value !== undefined && value !== null
    if (!present) throw new Error('notice ' + kind + ' requires field ' + field)
  }
  const at = Number.isFinite(input.at) ? Math.trunc(input.at) : Date.now()
  const candidate = { ...input, kind, v: 1, at }
  assertJsonValue(candidate, 'notice')
  // Round-trip through JSON so the stored value is exactly what a persistence
  // layer would read back (no Dates, no prototypes, no undefined).
  return deepFreeze(JSON.parse(JSON.stringify(candidate)))
}

/** Whether a value is a notice produced by makeNotice(). */
export function isNotice(value) {
  return Boolean(value && typeof value === 'object' && typeof value.kind === 'string' && KIND_SET.has(value.kind))
}

/**
 * Normalize a delivery argument for callers that only want the text: a notice
 * renders, a plain string passes through (legacy non-notice lines).
 * @param {object|string} value - notice or text.
 * @returns {string} channel text.
 */
export function noticeText(value) {
  return isNotice(value) ? renderNotice(value) : String(value == null ? '' : value)
}

function renderTicketStatus(n) {
  const status = TICKET_STATUSES.has(n.status) ? n.status : 'failed'
  const ref = formatTicketRef(n.ticketId)
  const summary = clamp(firstSentence(n.summary) || EMPTY_SUMMARY, 30)
  const head = ref + ' ' + status + ' · '
  let text = head + summary
  if (status === 'blocked') {
    const waitingOn = oneLine(n.waitingOn) || 'user'
    const reason = clamp(firstSentence(n.reason) || summary, 90)
    text += '\nblocked(waitingOn=' + waitingOn + ') · ' + reason
    const cap = Number.isSafeInteger(n.maxChars) && n.maxChars > 0 ? n.maxChars : 240
    return clampKeepingHead(text, cap, head.length)
  }
  const cap = Number.isSafeInteger(n.maxChars) && n.maxChars > 0 ? n.maxChars : 120
  return clampKeepingHead(text, cap, head.length)
}

/**
 * Render one notice into the exact channel text. This is the ONLY place that
 * knows emoji, reference formatting, clipping and clamp order.
 * @param {object} notice - a makeNotice() value.
 * @returns {string} the text for Chat/Claw/QQ.
 */
export function renderNotice(notice) {
  if (!notice || typeof notice !== 'object') throw new TypeError('renderNotice expects a notice object')
  const n = notice
  switch (n.kind) {
    case 'ticket.working':
    case 'ticket.done':
    case 'ticket.blocked':
    case 'ticket.failed':
    case 'ticket.cancelled':
      return renderTicketStatus(n)
    case 'approval.requested': {
      const reason = [
        n.reason ? oneLine(n.reason) : '未说明',
        '请求于 ' + clock(n.askedAt),
        'risk:' + String(n.risk || 'unknown').replace(/^risk:/, ''),
        'policy:' + String(n.policy || 'unknown'),
      ].join(' · ')
      return renderTicketStatus({
        kind: 'ticket.blocked',
        ticketId: n.ticketId,
        status: 'blocked',
        summary: '待审批：' + String(n.tool || 'unknown'),
        waitingOn: 'approval',
        reason,
        maxChars: n.maxChars,
      })
    }
    case 'session.approval': {
      const ticket = n.ticketId ? 'ticket ' + String(n.ticketId) : (String(n.role || 'session') + ' session ' + String(n.sessionId))
      return '🔔 #' + String(n.sessionId) + ' 等待审批：' + clamp(String(n.tool || 'unknown'), 40)
        + '（' + clamp(String(n.reason || '未说明'), 80) + '） · 受影响：' + ticket
    }
    case 'decision.needed':
      return '🔔 #工单 需要你决定：' + formatTicketRef(n.ticketId) + ' · ' + clamp(oneLine(n.question) || '有工单等你决定', 40)
    case 'approval.followup': {
      if (n.outcome === 'resumed') return 'ticket ' + String(n.ticketId) + ' 审批通过，已回到 working，Executor 继续执行。'
      if (n.outcome === 'restore_failed') return 'ticket ' + String(n.ticketId) + ' 审批通过，但恢复到 working 失败（' + String(n.code || 'unknown') + '）；请用 ria_chat_resume 处理。'
      return 'ticket ' + String(n.ticketId) + ' 审批被' + String(n.label || '取消') + '：' + String(n.message || '')
        + '，工单停在 blocked(waitingOn=approval)，可用 ria_chat_resume 重试。'
    }
    case 'grant.auto_allowed': {
      if (n.scope === 'watch') {
        const reasons = Array.isArray(n.reasons) ? n.reasons : []
        return '【协管·' + String(n.title || '') + '】已自动放行低风险提权：工具 ' + String(n.tool || 'unknown')
          + '（原因：' + reasons.join('；') + '）。'
      }
      const level = n.level === 'medium' ? '中风险' : '低风险'
      return '已自动放行' + level + '提权：' + String(n.who || '') + ' 工具 ' + String(n.toolLabel || n.tool || 'unknown')
        + '「' + String(n.what || '') + '」；判为 ' + String(n.risk || '') + '（策略 ' + String(n.policy || '')
        + '，来源 ' + String(n.policySource || '') + '）。'
    }
    case 'grant.applied': {
      const items = (Array.isArray(n.items) ? n.items : []).map(item =>
        typeof item === 'string' ? item : '工具 ' + String(item && item.tool || 'unknown')
          + (item && item.ticketId ? '（ticket ' + String(item.ticketId) + '）' : ''))
      if (n.phase === 'unresolved') {
        return '授权已生效（grantId ' + String(n.grantId) + '），但此前挂起的请求无法直接放行，请 Executor 重试或在必要时 resume：'
          + items.join('；') + '。'
      }
      return '授权已生效，并已放行此前挂起的请求（grantId ' + String(n.grantId) + '）：' + items.join('；') + '。'
    }
    case 'grant.reattached':
      return '本票授权已自动重新应用到新 executor ' + String(n.executorId) + '（ticket ' + String(n.ticketId)
        + '，grantId ' + String(n.grantId) + '，原 TTL 不变）。'
    case 'ticket.steer_undelivered':
      return '工单 ' + String(n.ticketId) + ' 的 steer 未投递：' + String(n.detail || n.reason || 'unknown')
        + '。已丢弃，不重开旧单，也不会串到其它工单。'
    case 'ticket.stopped': {
      const bound = n.bound === true
      const message = n.mode === 'hard'
        ? '已立即停止：ticket ' + String(n.ticketId) + ' 已取消，Executor 当前回合已中断。'
        : n.mode === 'soft'
          ? '已请求停止，当前步骤结束后生效：ticket ' + String(n.ticketId) + ' 已取消，Executor 会在下一步开始前收到终止说明并结束回合。'
          : '已停止：ticket ' + String(n.ticketId) + ' 已取消' + (bound ? '（Executor 当前没有运行中的步骤）。' : '（没有绑定 Executor）。')
      return '⛔ ' + message + ' 原因：' + String(n.reason || '')
    }
    case 'session.blocked_reminder': {
      const span = Number.isFinite(n.elapsedSeconds) && n.elapsedSeconds >= 0 ? '，本轮已运行 ' + n.elapsedSeconds + 's' : ''
      if (n.waiting === 'approval') {
        return '「' + clamp(oneLine(n.title) || '(untitled)', 24) + '」在等审批：'
          + clamp(oneLine(n.tool) || 'unknown', 24) + '（' + clamp(oneLine(n.reason) || '未说明', 24) + '）' + span
          + '。去该会话处理，Ria 不代答。'
      }
      return '「' + clamp(oneLine(n.title) || '(untitled)', 24) + '」在等回答：'
        + clamp(oneLine(n.question) || '（未提供问题）', 40) + span + '。去该会话回答。'
    }
    case 'session.abnormal_end':
      return '🔔 #会话 异常结束：' + sessionShortId(n.sessionId) + ' · ' + String(n.reason || 'unknown')
    case 'relay.hint': {
      const full = String(n.ticketId == null ? '' : n.ticketId).trim()
      const target = full ? '完整内容见工单 ' + full : '完整内容已记入会话记录'
      return n.report ? '（报告较长，已折叠；' + target + '）' : '…（' + target + '）'
    }
    case 'restart': {
      const label = n.reason === 'abnormal_exit' ? '异常退出' : '正常重启'
      const recovered = Number.isSafeInteger(n.recoveredTickets) && n.recoveredTickets > 0 ? n.recoveredTickets : 0
      const seconds = Number.isFinite(n.startupMs) && n.startupMs >= 0 ? (n.startupMs / 1000).toFixed(1) : '0.0'
      return '🔔 Ria 已重启（PID ' + String(n.prevPid) + ' → ' + String(n.newPid) + '，' + label
        + '） · 恢复工单 ' + recovered + ' 张 · 启动耗时 ' + seconds + ' s'
    }
    case 'reflection':
      return '🔔 定期反思：' + clamp(oneLine(n.summary) || '已完成', 120)
    case 'channel.pause': {
      const copy = PAUSE_NOTICE_COPY[n.channel] || PAUSE_NOTICE_COPY.wechat
      const detail = oneLine(n.reason) || copy.defaultReason
      return '🌊 Ria 已自动暂停' + copy.push + '（原因：' + detail + '）。回一条' + copy.reply
        + '即可恢复；也可在 Ria 设置里关掉「自动暂停」。'
    }
    case 'channel.degraded':
      // Event-only by design (cog_257): rendered for diagnostics, never pushed.
      return '🔇 通道降级：' + String(n.channel || 'unknown') + ' · ' + String(n.code || 'degraded')
        + (Number.isFinite(n.ret) ? '（ret=' + n.ret + '）' : '')
    default:
      throw new Error('notice kind has no renderer: ' + JSON.stringify(n.kind))
  }
}

/** Auto-pause text helper kept for the channel pause path (now object-derived). */
export function channelPauseNoticeText(channel, reason) {
  return renderNotice(makeNotice({ kind: 'channel.pause', channel: String(channel || 'wechat'), reason: reason == null ? '' : String(reason) }))
}
