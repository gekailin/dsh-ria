// Small, dependency-free primitives shared by the control-plane modules that
// were split out of controller.mjs. Moved verbatim; no behaviour change.

// How many stale Worker bindings one selection may skip before a new Worker is
// created. A stale binding is removed as soon as it fails to resolve.
export const WORKER_RESELECT_LIMIT = 3

// Presets a managed Worker may be created with. DSH offers no preset catalog to
// enumerate, so this is the deployment's allow-list; the default (ptc) is what
// the code has always used.
export const WORKER_PRESET_WHITELIST = ['ptc', 'standard', 'minimal']

export const CHAT_IMAGE_LIMIT = 5

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
