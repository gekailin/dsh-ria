// Router/control-plane event stream.
//
// Append-only JSONL used for retrospective review of the dispatch chain. It is
// deliberately separate from ticket history (state snapshots) and audit.jsonl
// (approval/grant decisions): this file records the process events that led to
// a state change. No timers: rotation happens on append and prune runs once at
// startup.

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const ROUTER_EVENTS_FILE = 'router-events.jsonl'
export const ROUTER_EVENTS_MONTHLY_PREFIX = 'router-events-'
export const ROUTER_EVENTS_RETENTION_MONTHS = 12
export const ROUTER_EVENTS_MAX_BYTES = 64 * 1024 * 1024
export const ROUTER_EVENTS_MAX_QUERY_LIMIT = 500

const MONTHLY_PATTERN = /^router-events-(\d{4}-\d{2})\.jsonl$/

const text = value => typeof value === 'string' ? value.trim() : ''

export function routerEventMonth(at) {
  const date = new Date(Number.isFinite(at) ? at : Date.now())
  return date.getUTCFullYear() + '-' + String(date.getUTCMonth() + 1).padStart(2, '0')
}

function parseTime(value) {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value === 'number') return Number.isFinite(value) ? Math.trunc(value) : null
  const body = String(value).trim()
  if (!body) return undefined
  if (/^-?\d+$/.test(body)) return Number(body)
  const parsed = Date.parse(body)
  return Number.isFinite(parsed) ? parsed : null
}

function eventTypeMatches(type, patterns) {
  for (const pattern of patterns) {
    if (pattern.endsWith('*')) {
      if (type.startsWith(pattern.slice(0, -1))) return true
    } else if (type === pattern) {
      return true
    }
  }
  return false
}

function readLines(file) {
  try {
    return readFileSync(file, 'utf8').split('\n')
  } catch {
    return []
  }
}

/**
 * Durable append-only router event log.
 *
 * Files:
 *  - stateDir/router-events.jsonl            current month (hot)
 *  - stateDir/router-events-YYYY-MM.jsonl    rotated month
 *
 * The current file rotates when an append belongs to a new month or the file
 * exceeds maxBytes. Retention deletes monthly files older than the newest
 * retentionMonths months; prune() is called once at startup, never by a timer.
 */
export class RouterEventLog {
  constructor({ stateDir, now = Date.now, log = () => {}, maxBytes = ROUTER_EVENTS_MAX_BYTES, retentionMonths = ROUTER_EVENTS_RETENTION_MONTHS } = {}) {
    if (!stateDir) throw new Error('RouterEventLog requires stateDir')
    this.stateDir = stateDir
    this.now = now
    this.log = log
    this.maxBytes = maxBytes
    this.retentionMonths = retentionMonths
    this.file = join(stateDir, ROUTER_EVENTS_FILE)
    this.month = routerEventMonth(this.time())
    try {
      const stat = statSync(this.file)
      if (stat.size > 0) {
        // A restart after a month boundary must rotate the previous month's hot
        // file before the first append. mtime is a cheap and safe approximation.
        const fileMonth = routerEventMonth(stat.mtimeMs)
        if (fileMonth !== this.month) this.month = fileMonth
      }
    } catch {
      // No file yet: the current month is the event month.
    }
  }

  time() {
    return typeof this.now === 'function' ? this.now() : Number(this.now) || Date.now()
  }

  monthlyFile(month) {
    return join(this.stateDir, ROUTER_EVENTS_MONTHLY_PREFIX + month + '.jsonl')
  }

  monthlyFiles() {
    try {
      return readdirSync(this.stateDir)
        .filter(name => MONTHLY_PATTERN.test(name))
        .sort()
        .map(name => join(this.stateDir, name))
    } catch {
      return []
    }
  }

  /**
   * Append one event. Failures are logged, never thrown: observability must not
   * break dispatch or approval.
   */
  append(input = {}) {
    const ts = Number.isFinite(input.ts) ? input.ts : this.time()
    const record = {
      ts,
      event: text(input.event) || 'unknown',
      ticketId: text(input.ticketId) || null,
      sessionId: text(input.sessionId) || null,
      actor: text(input.actor) || 'router',
      reason: text(input.reason) || '',
      payload: input.payload && typeof input.payload === 'object' && !Array.isArray(input.payload) ? input.payload : null,
    }
    try {
      mkdirSync(this.stateDir, { recursive: true, mode: 0o700 })
      this.rotateIfNeeded(ts)
      appendFileSync(this.file, JSON.stringify(record) + '\n', { mode: 0o600 })
      return record
    } catch (error) {
      this.log('warn', 'could not append router event: ' + String(error && error.message ? error.message : error))
      return null
    }
  }

  /** Rotate the hot file when the month changed or the size cap is reached. */
  rotateIfNeeded(at = this.time()) {
    const month = routerEventMonth(at)
    let size = 0
    try { size = statSync(this.file).size } catch { size = 0 }
    if (month === this.month && size < this.maxBytes) return false
    if (size === 0) {
      this.month = month
      return false
    }
    const target = this.monthlyFile(this.month)
    try {
      mkdirSync(this.stateDir, { recursive: true, mode: 0o700 })
      if (existsSync(target)) {
        appendFileSync(target, readFileSync(this.file), { mode: 0o600 })
        writeFileSync(this.file, '', { mode: 0o600 })
      } else {
        renameSync(this.file, target)
      }
    } catch (error) {
      this.log('warn', 'could not rotate router events: ' + String(error && error.message ? error.message : error))
      return false
    }
    this.month = month
    return true
  }

  /** Rotate once, then drop monthly files beyond the retention window. */
  prune(at = this.time()) {
    let rotated = false
    try { rotated = this.rotateIfNeeded(at) } catch { rotated = false }
    const files = this.monthlyFiles()
    const months = files.map(file => {
      const match = MONTHLY_PATTERN.exec(file.slice(file.lastIndexOf('/') + 1))
      return match ? match[1] : ''
    }).filter(Boolean)
    months.sort()
    const stale = new Set(months.slice(0, Math.max(0, months.length - this.retentionMonths)))
    let pruned = 0
    for (const file of files) {
      const match = MONTHLY_PATTERN.exec(file.slice(file.lastIndexOf('/') + 1))
      if (!match || !stale.has(match[1])) continue
      try {
        unlinkSync(file)
        pruned += 1
      } catch {
        // Retention is best effort; a locked file is retried next startup.
      }
    }
    return { rotated, pruned }
  }

  /**
   * Read-only query over the hot and monthly files. Returns newest first.
   * limit is capped at ROUTER_EVENTS_MAX_QUERY_LIMIT.
   */
  query(input = {}) {
    const limit = Number.isSafeInteger(input.limit)
      ? Math.max(1, Math.min(ROUTER_EVENTS_MAX_QUERY_LIMIT, input.limit))
      : 100
    const offset = Number.isSafeInteger(input.offset) && input.offset > 0 ? input.offset : 0
    const ticketId = text(input.ticketId)
    const patterns = (Array.isArray(input.types) ? input.types : [input.type])
      .map(item => text(item))
      .filter(Boolean)
    const from = parseTime(input.from)
    const to = parseTime(input.to)
    if (from === null || to === null) {
      const error = new Error('from/to must be epoch milliseconds or an ISO 8601 timestamp')
      error.code = 'invalid_time'
      throw error
    }
    if (from !== undefined && to !== undefined && from > to) {
      const error = new Error('from must not be later than to')
      error.code = 'invalid_range'
      throw error
    }
    const files = [this.file, ...this.monthlyFiles()]
    const events = []
    let scanned = 0
    for (const file of files) {
      for (const line of readLines(file)) {
        if (!line.trim()) continue
        scanned += 1
        let event
        try { event = JSON.parse(line) } catch { continue }
        if (!event || typeof event !== 'object') continue
        if (ticketId && String(event.ticketId || '') !== ticketId) continue
        if (patterns.length && !eventTypeMatches(String(event.event || ''), patterns)) continue
        if (from !== undefined && !(Number(event.ts) >= from)) continue
        if (to !== undefined && !(Number(event.ts) <= to)) continue
        events.push(event)
      }
    }
    events.sort((left, right) => Number(right.ts || 0) - Number(left.ts || 0))
    const matched = events.length
    const page = events.slice(offset, offset + limit)
    return {
      events: page,
      total: matched,
      matched,
      hasMore: offset + page.length < matched,
      limit,
      offset,
      scanned,
    }
  }
}
