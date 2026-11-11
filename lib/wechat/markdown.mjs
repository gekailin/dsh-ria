// Decide whether a Ria reply should be delivered to WeChat as a .md file.
//
// The rule is deliberately boring and configurable: long text, or Markdown that
// is painful to read in a chat bubble (fenced code, tables, many headings/links),
// is sent as a complete file instead of a truncated message.

export const DEFAULT_MARKDOWN_FILE_OPTIONS = Object.freeze({
  enabled: true,
  charThreshold: 800,
  codeBlock: true,
  table: true,
  headingCount: 4,
  linkCount: 6,
})

const integer = (value, fallback, min, max) => {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.floor(n)))
}

const bool = (value, fallback) => {
  if (value === undefined || value === null || value === '') return fallback
  if (typeof value === 'boolean') return value
  const text = String(value).trim().toLowerCase()
  if (['1', 'true', 'yes', 'on'].includes(text)) return true
  if (['0', 'false', 'no', 'off'].includes(text)) return false
  return fallback
}

/** Normalize plugin config / environment into a stable rule object. */
export function normalizeMarkdownFileOptions(input = {}, env = process.env) {
  const raw = input === false ? { enabled: false } : (input && typeof input === 'object' ? input : {})
  const fromEnv = (name, value) => value === undefined ? env[name] : value
  return {
    enabled: bool(fromEnv('DSH_RIA_MD_FILE', raw.enabled), DEFAULT_MARKDOWN_FILE_OPTIONS.enabled),
    charThreshold: integer(
      fromEnv('DSH_RIA_MD_THRESHOLD', raw.charThreshold),
      DEFAULT_MARKDOWN_FILE_OPTIONS.charThreshold,
      80,
      100000,
    ),
    codeBlock: bool(fromEnv('DSH_RIA_MD_CODE', raw.codeBlock), DEFAULT_MARKDOWN_FILE_OPTIONS.codeBlock),
    table: bool(fromEnv('DSH_RIA_MD_TABLE', raw.table), DEFAULT_MARKDOWN_FILE_OPTIONS.table),
    headingCount: integer(
      fromEnv('DSH_RIA_MD_HEADINGS', raw.headingCount),
      DEFAULT_MARKDOWN_FILE_OPTIONS.headingCount,
      1,
      50,
    ),
    linkCount: integer(
      fromEnv('DSH_RIA_MD_LINKS', raw.linkCount),
      DEFAULT_MARKDOWN_FILE_OPTIONS.linkCount,
      1,
      500,
    ),
  }
}

const FENCED_CODE = /(?:^|\n)(?:`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:\n(?:`{3,}|~{3,})[ \t]*(?=\n|$)|$)/m
const TABLE = /(?:^|\n)[ \t]*\|[^\n]*\|[ \t]*\n[ \t]*\|?[ \t]*:?-{3,}:?[ \t]*(?:\|[ \t]*:?-{3,}:?[ \t]*)+\|?[ \t]*(?=\n|$)/m
const HEADING = /^[ \t]{0,3}#{1,6}[ \t]+\S/gm
const LINK = /\[[^\]\n]+\]\([^\n)]+\)/g

const count = (text, pattern) => (text.match(pattern) || []).length

/**
 * Return { file, reasons, length, options }.
 * reasons: length | code-block | table | headings | links
 */
export function decideMarkdownFile(text, options = {}) {
  const value = String(text == null ? '' : text)
  const opts = normalizeMarkdownFileOptions(options)
  const reasons = []
  if (!opts.enabled) return { file: false, reasons, length: value.length, options: opts }
  if (value.length > opts.charThreshold) reasons.push('length')
  if (opts.codeBlock && FENCED_CODE.test(value)) reasons.push('code-block')
  if (opts.table && TABLE.test(value)) reasons.push('table')
  if (count(value, HEADING) >= opts.headingCount) reasons.push('headings')
  if (count(value, LINK) >= opts.linkCount) reasons.push('links')
  return { file: reasons.length > 0, reasons, length: value.length, options: opts }
}

/** Filename for a generated Markdown attachment, e.g. ria-1a2b3c4d-20261111-073015.md. */
export function markdownFileName(sessionId, date = new Date()) {
  const raw = String(sessionId || 'ria').replace(/^session-/, '')
  const short = (raw.slice(-8) || 'ria').replace(/[^A-Za-z0-9_-]/g, '')
  const p = (n) => String(n).padStart(2, '0')
  const stamp = '' + date.getFullYear() + p(date.getMonth() + 1) + p(date.getDate()) +
    '-' + p(date.getHours()) + p(date.getMinutes()) + p(date.getSeconds())
  return 'ria-' + (short || 'ria') + '-' + stamp + '.md'
}
