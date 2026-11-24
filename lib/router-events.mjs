// Router/control-plane event stream.
//
// Append-only daily JSONL under stateDir/logs/YYYY-MM-DD/router-events.jsonl.
// Deliberately separate from ticket history (SQLite) and audit.jsonl
// (approval/grant decisions): this log records process events that led to a
// state change. Retention runs once at startup via prune(), never on a timer.

import { readFileSync } from 'node:fs'
import { appendDailyLog, dailyLogFile, listDailyLogFiles, pruneDailyLogs } from './shared/daily-log.mjs'

export const ROUTER_EVENTS_FILE = 'router-events.jsonl'
export const ROUTER_EVENTS_RETENTION_DAYS = 90
export const ROUTER_EVENTS_MAX_QUERY_LIMIT = 500

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
 * Durable append-only router event log partitioned by UTC date directory:
 *   stateDir/logs/YYYY-MM-DD/router-events.jsonl
 */
export class RouterEventLog {
  constructor({ stateDir, now = Date.now, log = () => {}, retentionDays = ROUTER_EVENTS_RETENTION_DAYS } = {}) {
    if (!stateDir) throw new Error('RouterEventLog requires stateDir')
    this.stateDir = stateDir
    this.now = now
    this.log = log
    this.retentionDays = Number.isFinite(retentionDays) && retentionDays >= 0 ? retentionDays : ROUTER_EVENTS_RETENTION_DAYS
  }

  time() {
    return typeof this.now === 'function' ? this.now() : Number(this.now) || Date.now()
  }

  fileFor(at = this.time()) {
    return dailyLogFile(this.stateDir, ROUTER_EVENTS_FILE, at)
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
      sessionId: input.sessionId === '' ? '' : (text(input.sessionId) || null),
      actor: text(input.actor) || 'router',
      reason: text(input.reason) || '',
      payload: input.payload && typeof input.payload === 'object' && !Array.isArray(input.payload) ? input.payload : null,
    }
    try {
      appendDailyLog(this.stateDir, ROUTER_EVENTS_FILE, record, { at: ts })
      return record
    } catch (error) {
      this.log('warn', 'could not append router event: ' + String(error && error.message ? error.message : error))
      return null
    }
  }

  /** Drop daily router-events.jsonl files beyond the retention window. */
  prune(at = this.time()) {
    const pruned = pruneDailyLogs(this.stateDir, {
      name: ROUTER_EVENTS_FILE,
      retentionDays: this.retentionDays,
      now: at,
      log: this.log,
    })
    return { rotated: false, pruned }
  }

  /**
   * Read-only query over daily files. Returns newest first.
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
    const files = listDailyLogFiles(this.stateDir, ROUTER_EVENTS_FILE).map(item => item.path)
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
