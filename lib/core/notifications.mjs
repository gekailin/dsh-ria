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
