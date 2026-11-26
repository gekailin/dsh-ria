// Small, dependency-free primitives shared by the control-plane modules that
// were split out of controller.mjs. Moved verbatim; no behaviour change.

// How many stale Executor bindings one selection may skip before a new Executor is
// created. A stale binding is removed as soon as it fails to resolve.
export const EXECUTOR_RESELECT_LIMIT = 3

// Presets a managed Executor may be created with. DSH offers no preset catalog to
// enumerate, so this is the deployment's allow-list; the default (ptc) is what
// the code has always used.
export const EXECUTOR_PRESET_WHITELIST = ['ptc', 'standard', 'minimal']

export const CHAT_IMAGE_LIMIT = 5

// ria_chat_send_file accepts at most three local files per call.
export const CHAT_FILE_LIMIT = 3

// Review-critical event types for ria_session_events. Any event whose type also
// contains "error" is treated as review-critical even when it is not listed
// here (external/plugin events are not part of the host vocabulary).
export const REVIEW_EVENT_TYPES = [
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
export const SENSITIVE_KEY = /token|secret|password|passwd|api[-_]?key|authorization|cookie|credential/i
const AUTH_PAIR = /(authorization\s*[:=]\s*)(?:bearer\s+)?(?:"[^"]*"|'[^']*'|[^\s&;,]+)/gi
const SECRET_PAIR = /((?:access[_-]?token|refresh[_-]?token|token|api[_-]?key|apikey|secret|password|passwd|cookie|credential)\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s&;,]+)/gi

export function redactSecrets(value) {
  return String(value == null ? '' : value)
    .replace(AUTH_PAIR, '$1[redacted]')
    .replace(SECRET_PAIR, '$1***')
}

export const text = value => typeof value === 'string' ? value.trim() : ''

export const now = () => Date.now()

/** Collapse to one line and clip hard; the ellipsis counts toward the limit. */
export function clipText(value, limit) {
  const body = String(value == null ? '' : value).replace(/\s+/g, ' ').trim()
  if (body.length <= limit) return body
  return limit <= 1 ? '…' : body.slice(0, limit - 1) + '…'
}

/**
 * Structure-preserving truncation for prompt blocks that contain paragraphs
 * and Markdown list items. Unlike clipText, it never collapses whitespace.
 * Over-limit text is cut at the latest paragraph/sentence/line boundary before
 * the limit and ends with a single ellipsis; the ellipsis counts toward limit.
 */
export function clipStructuredText(value, limit) {
  if (!Number.isFinite(limit) || limit <= 0) return ''
  const body = String(value == null ? '' : value).replace(/^\s+|\s+$/g, '')
  if (!body) return ''
  const chars = Array.from(body)
  if (chars.length <= limit) return body
  if (limit <= 1) return '…'
  const max = limit - 1
  const head = chars.slice(0, max).join('')
  const boundary = (needle, include) => {
    const index = head.lastIndexOf(needle)
    return index < 0 ? -1 : index + include
  }
  // Use the latest structure boundary that fits: paragraph, line/list,
  // sentence, then whitespace. Keep the boundary character itself.
  const candidates = [
    boundary('\n\n', 2),
    boundary('\n', 1),
    Math.max(
      boundary('。', 1), boundary('！', 1), boundary('？', 1),
      boundary('.', 1), boundary('!', 1), boundary('?', 1), boundary('；', 1), boundary(';', 1),
    ),
    boundary(' ', 1),
  ]
  const cut = Math.max(...candidates) > 0 ? Math.max(...candidates) : max
  return head.slice(0, cut).replace(/\s+$/g, '') + '…'
}
