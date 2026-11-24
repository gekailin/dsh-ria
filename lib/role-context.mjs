// Append-only Router/Advisor context log for reflection review.
// One JSON object per line under stateDir/logs/YYYY-MM-DD/role-context.jsonl.
// Write order: build -> truncate -> redact -> hash -> append. Write failures
// never affect the control plane.
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { appendDailyLog, dailyLogFile, listDailyLogFiles, pruneDailyLogs, utcDayOf } from './shared/daily-log.mjs'

export const ROLE_CONTEXT_MAX_BYTES = 32 * 1024
export const ROLE_CONTEXT_RETENTION_DAYS = 14
export const ROLE_CONTEXT_FILE = 'role-context.jsonl'

const lastPrune = new Map()

const sha = value => createHash('sha256').update(JSON.stringify(value === undefined ? null : value)).digest('hex').slice(0, 16)

const redactText = value => String(value == null ? '' : value)
  .replace(/Bearer\s+[A-Za-z0-9._~+/=-]{6,}/gi, 'Bearer ***')
  .replace(/\b(?:sk-|ghp_|xox[bap]-)[A-Za-z0-9_-]{8,}/g, '***')
  .replace(/((?:"?(?:[A-Za-z0-9_]*(?:token|secret|password|passwd|api[_-]?key|cookie|authorization)[A-Za-z0-9_]*)"?\s*[:=]\s*))(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, '$1***')

function redactDeep(value) {
  if (typeof value === 'string') return redactText(value)
  if (Array.isArray(value)) return value.map(redactDeep)
  if (!value || typeof value !== 'object') return value
  const out = {}
  for (const [key, item] of Object.entries(value)) {
    out[key] = /token|secret|password|passwd|api[_-]?key|cookie|authorization/i.test(key) ? '***' : redactDeep(item)
  }
  return out
}

function truncateDeep(value, maxString, state) {
  if (typeof value === 'string') {
    const chars = [...value]
    if (chars.length <= maxString) return value
    state.truncated = true
    return chars.slice(0, maxString).join('') + '…'
  }
  if (Array.isArray(value)) return value.map(item => truncateDeep(item, maxString, state))
  if (!value || typeof value !== 'object') return value
  const out = {}
  for (const [key, item] of Object.entries(value)) out[key] = truncateDeep(item, maxString, state)
  return out
}

export const roleContextFile = (stateDir, at = Date.now()) => dailyLogFile(stateDir, ROLE_CONTEXT_FILE, at)

export function pruneRoleContextFiles(stateDir, { retentionDays = ROLE_CONTEXT_RETENTION_DAYS, now = Date.now(), log = console.warn } = {}) {
  return pruneDailyLogs(stateDir, {
    name: ROLE_CONTEXT_FILE,
    retentionDays,
    now,
    log: (_level, message) => { try { log(message) } catch {} },
  })
}

export function prepareRoleContext(record = {}, { maxBytes = ROLE_CONTEXT_MAX_BYTES } = {}) {
  const state = { truncated: false }
  const at = record.at === undefined ? Date.now() : record.at
  const rawInput = truncateDeep(record.input === undefined ? null : record.input, 12000, state)
  const rawOutput = truncateDeep(record.output === undefined ? null : record.output, 12000, state)
  const input = redactDeep(rawInput)
  const output = redactDeep(rawOutput)
  const prepared = {
    at: new Date(Number(at) || Date.now()).toISOString(),
    role: record.role === 'router' ? 'router' : 'advisor',
    ticketId: record.ticketId ? String(record.ticketId) : '',
    phase: record.phase ? String(record.phase) : '',
    model: record.model ? String(record.model) : '',
    durationMs: Number.isFinite(record.durationMs) ? Math.max(0, Math.round(record.durationMs)) : 0,
    attempt: Number.isInteger(record.attempt) && record.attempt > 0 ? record.attempt : 1,
    degraded: record.degraded === true,
    error: record.error ? redactText(String(record.error)) : null,
    input,
    output,
    inputHash: sha(input),
    outputHash: sha(output),
    truncated: state.truncated,
  }
  if (Buffer.byteLength(JSON.stringify(prepared), 'utf8') > maxBytes) {
    prepared.truncated = true
    prepared.input = truncateDeep(prepared.input, 4000, state)
    prepared.output = truncateDeep(prepared.output, 4000, state)
    prepared.inputHash = sha(prepared.input)
    prepared.outputHash = sha(prepared.output)
  }
  return prepared
}

export function appendRoleContext(stateDir, record = {}, { maxBytes = ROLE_CONTEXT_MAX_BYTES, retentionDays = ROLE_CONTEXT_RETENTION_DAYS, now = Date.now() } = {}) {
  const prepared = prepareRoleContext(record, { maxBytes })
  const dir = String(stateDir)
  appendDailyLog(dir, ROLE_CONTEXT_FILE, prepared, { at: prepared.at })
  const day = utcDayOf(now)
  if (lastPrune.get(dir) !== day) {
    lastPrune.set(dir, day)
    try { pruneRoleContextFiles(dir, { retentionDays, now }) } catch {}
  }
  return prepared
}

/** Fire-and-forget: callers must never await or fail because of logging. */
export function appendRoleContextAsync(stateDir, record = {}, options = {}) {
  try { return appendRoleContext(stateDir, record, options) } catch (error) {
    try { (options.log || console.warn)('role-context write failed: ' + String(error && error.message ? error.message : error)) } catch {}
    return null
  }
}

function readEntries(stateDir) {
  const entries = []
  for (const { path: file } of listDailyLogFiles(stateDir, ROLE_CONTEXT_FILE)) {
    let raw
    try { raw = readFileSync(file, 'utf8') } catch { continue }
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue
      try { entries.push(JSON.parse(line)) } catch {}
    }
  }
  return entries
}

function clipValue(value, max) {
  if (value === undefined || value === null) return null
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  if (text.length <= max) return text
  return text.slice(0, Math.max(0, max)) + '…'
}

/** Keep metadata and a readable output summary for one oversized entry. */
function compactRoleEntry(entry, maxChars) {
  const metadata = {
    at: entry.at, role: entry.role, ticketId: entry.ticketId, phase: entry.phase,
    model: entry.model, durationMs: entry.durationMs, attempt: entry.attempt,
    degraded: entry.degraded, error: entry.error,
    inputHash: entry.inputHash, outputHash: entry.outputHash,
  }
  const overhead = JSON.stringify({ ...metadata, input: null, output: null, truncated: true }).length
  if (overhead > maxChars) return null
  let cap = Math.max(0, Math.min(8000, maxChars - overhead - 32))
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const outputCap = Math.max(0, Math.min(cap, 4000))
    const inputCap = Math.max(0, Math.min(cap, 2000))
    const compact = {
      ...metadata,
      input: clipValue(entry.input, inputCap),
      output: clipValue(entry.output, outputCap),
      truncated: true,
    }
    if (JSON.stringify(compact).length <= maxChars) return compact
    cap = Math.floor(cap / 2)
  }
  return null
}

export function readRoleContext(stateDir, { role, since, ticketId, limit = 20, maxChars = 20000, now = Date.now() } = {}) {
  const wantedRole = role === 'router' || role === 'advisor' ? role : 'advisor'
  const lim = Math.max(1, Math.min(100, Number.isSafeInteger(Number(limit)) ? Number(limit) : 20))
  const budget = Math.max(1, Math.min(100000, Number.isFinite(Number(maxChars)) ? Number(maxChars) : 20000))
  let cutoff = Number(now) - ROLE_CONTEXT_RETENTION_DAYS * 24 * 60 * 60 * 1000
  if (typeof since === 'number' && Number.isFinite(since)) cutoff = Number(now) - since * 24 * 60 * 60 * 1000
  else if (typeof since === 'string' && since.trim()) {
    const parsed = Date.parse(since)
    if (Number.isFinite(parsed)) cutoff = parsed
  }
  const matching = readEntries(stateDir)
    .filter(entry => entry && entry.role === wantedRole)
    .filter(entry => !ticketId || String(entry.ticketId) === String(ticketId))
    .filter(entry => Number.isFinite(Date.parse(entry.at)) && Date.parse(entry.at) >= cutoff)
    .sort((left, right) => Date.parse(left.at) - Date.parse(right.at))
  const total = matching.length
  const entries = []
  let used = 0
  let dropped = 0
  let truncatedEntries = 0
  for (const entry of matching) {
    if (entries.length >= lim) { dropped += 1; continue }
    const remaining = budget - used
    const encoded = JSON.stringify(entry)
    if (encoded.length <= remaining) {
      entries.push(entry)
      used += encoded.length
      continue
    }
    const compact = compactRoleEntry(entry, remaining)
    if (!compact) { dropped += 1; continue }
    entries.push(compact)
    used += JSON.stringify(compact).length
    truncatedEntries += 1
  }
  const truncatedCount = truncatedEntries + dropped
  return {
    role: wantedRole, total, returned: entries.length, kept: entries.length,
    truncatedCount, truncatedEntries, dropped,
    truncated: truncatedCount > 0, maxChars: budget, entries,
  }
}
