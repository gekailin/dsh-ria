// Compact, user-facing ticket status notices.
//
// Full reports stay in the ticket/report store. Notifications carry only a
// ticket suffix, an enumerated status and a one-sentence summary so a channel
// cannot accidentally dump evidence, goals, file lists or code blocks.

export const STATUS_NOTICE_MAX_CHARS = 120
export const STATUS_NOTICE_BLOCKED_MAX_CHARS = 240
export const STATUS_SUMMARY_MAX_CHARS = 30
export const STATUS_VALUES = Object.freeze(['done', 'blocked', 'failed', 'cancelled', 'working'])

const STATUS_SET = new Set(STATUS_VALUES)
const EMPTY_SUMMARY = '无摘要'
const ELLIPSIS = '…'

function oneLine(value) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim()
}

function clamp(value, max) {
  const chars = [...String(value)]
  if (chars.length <= max) return chars.join('')
  return chars.slice(0, Math.max(1, max - 1)).join('') + ELLIPSIS
}

function firstSentence(value) {
  const raw = String(value == null ? '' : value).trim()
  if (!raw) return ''
  const line = raw.split(/\r?\n/)[0]
  const index = line.search(/[。！？.!?]/u)
  return oneLine(index >= 0 ? line.slice(0, index) : line)
}

function shortTicketId(value) {
  const id = String(value == null ? '' : value)
  return id ? id.slice(-6) : '------'
}

/**
 * Format one status notice. The returned object intentionally has a closed
 * field set: ticketId (6-char suffix), status, summary, optional waitingOn and
 * the rendered text. Nothing from a report body/evidence can pass through.
 *
 * @param {{ticketId?: string, status?: string, summary?: string, waitingOn?: string, reason?: string}} input
 * @returns {{ticketId: string, status: string, summary: string, waitingOn?: string, text: string}}
 */
export function formatStatusNotice(input = {}) {
  const rawStatus = oneLine(input.status).toLowerCase()
  const status = STATUS_SET.has(rawStatus) ? rawStatus : 'failed'
  const ticketId = shortTicketId(input.ticketId)
  const summary = clamp(firstSentence(input.summary) || EMPTY_SUMMARY, STATUS_SUMMARY_MAX_CHARS)
  const notice = { ticketId, status, summary }
  let text = '#' + ticketId + ' ' + status + ' · ' + summary
  if (status === 'blocked') {
    const waitingOn = oneLine(input.waitingOn) || 'user'
    notice.waitingOn = waitingOn
    const reason = clamp(firstSentence(input.reason) || summary, 90)
    text += '\nblocked(waitingOn=' + waitingOn + ') · ' + reason
    text = clamp(text, STATUS_NOTICE_BLOCKED_MAX_CHARS)
  } else {
    text = clamp(text, STATUS_NOTICE_MAX_CHARS)
  }
  notice.text = text
  return notice
}
export const DEFAULT_RELAY_MAX_CHARS = 400
export const RELAY_REPORT_FIRST_MAX_CHARS = 200

export function normalizeRelayMaxChars(value) {
  const number = Number(value)
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : DEFAULT_RELAY_MAX_CHARS
}

/** Markdown headings, evidence labels, code fences, or 3+ blank-line paragraphs. */
export function isReportLike(text) {
  const value = String(text == null ? '' : text)
  if (/^#{1,6}\s/m.test(value)) return true
  if (/证据\s*[:：]/.test(value)) return true
  if (/```/.test(value)) return true
  const paragraphs = value.split(/\r?\n\s*\r?\n/).map(item => item.trim()).filter(Boolean)
  return paragraphs.length >= 3
}

function firstRelayParagraph(text) {
  const value = String(text == null ? '' : text).trim()
  if (!value) return ''
  const blocks = value.split(/\r?\n\s*\r?\n/).map(item => item.trim()).filter(Boolean)
  return blocks[0] || value
}

function clipChars(value, max) {
  const chars = [...String(value)]
  if (max <= 0) return ''
  if (chars.length <= max) return chars.join('')
  return chars.slice(0, Math.max(0, max - 1)).join('') + '…'
}

function relayHint(ticketId, report = false) {
  const suffix = ticketId ? String(ticketId).slice(-6) : ''
  const target = suffix ? '完整内容见工单 #' + suffix : '完整内容已记入会话记录'
  return report ? '（报告较长，已折叠；' + target + '）' : '…（' + target + '）'
}

/** Bound a relay body; caller adds 【协管·标题】 prefix outside this limit. */
export function formatRelayBody(text, maxChars = DEFAULT_RELAY_MAX_CHARS, { ticketId = null } = {}) {
  const value = String(text == null ? '' : text)
  const limit = normalizeRelayMaxChars(maxChars)
  if (limit === 0) return value
  if (!value.trim()) return value
  if (isReportLike(value)) {
    const hint = relayHint(ticketId, true)
    const first = clipChars(firstRelayParagraph(value), Math.min(RELAY_REPORT_FIRST_MAX_CHARS, Math.max(0, limit)))
    const status = value.match(/(?:^|\n)#{1,6}\s*(?:状态\s*[:：]?\s*)?(done|blocked|failed|cancelled|working)\b/i)
      || value.match(/(?:^|\n)状态\s*[:：]\s*(done|blocked|failed|cancelled|working)\b/i)
    let body = first
    if (status && !new RegExp(status[1], 'i').test(body)) body += '\n状态：' + status[1]
    const combined = body + '\n' + hint
    if ([...combined].length <= limit) return combined
    return clipChars(body, Math.max(0, limit - [...hint].length - 1)) + '\n' + hint
  }
  if ([...value].length <= limit) return value
  const hint = relayHint(ticketId, false)
  const head = Math.min(300, Math.max(0, limit - [...hint].length))
  return [...value].slice(0, head).join('') + hint
}
