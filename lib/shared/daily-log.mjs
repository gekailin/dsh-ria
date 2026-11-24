// Unified daily log directory layout under stateDir/logs/YYYY-MM-DD/.
// All pure logs (router-events.jsonl, role-context.jsonl, audit.jsonl) share
// this date-partitioned layout so backup and retention are uniform.
import { appendFileSync, existsSync, mkdirSync, readdirSync, rmdirSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'

export const LOGS_DIR = 'logs'
export const DATE_DIR_PATTERN = /^\d{4}-\d{2}-\d{2}$/

export const DEFAULT_RETENTION_DAYS = Object.freeze({
  'role-context.jsonl': 14,
  'router-events.jsonl': 90,
  'audit.jsonl': 365,
})

export function utcDayOf(at = Date.now()) {
  const ms = typeof at === 'string' && !/^\d+$/.test(at) ? Date.parse(at) : Number(at)
  return new Date(Number.isFinite(ms) ? ms : Date.now()).toISOString().slice(0, 10)
}

export function dailyLogDir(stateDir, at = Date.now()) {
  return join(String(stateDir), LOGS_DIR, utcDayOf(at))
}

export function dailyLogFile(stateDir, name, at = Date.now()) {
  return join(dailyLogDir(stateDir, at), String(name))
}

export function appendDailyLog(stateDir, name, record, { at = Date.now(), mode = 0o600 } = {}) {
  const dir = dailyLogDir(stateDir, at)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const file = join(dir, String(name))
  const line = typeof record === 'string' ? record : JSON.stringify(record)
  appendFileSync(file, line.endsWith('\n') ? line : line + '\n', { mode })
  return file
}

/**
 * List daily log files matching `name` in chronological (oldest-first) order.
 */
export function listDailyLogFiles(stateDir, name) {
  const root = join(String(stateDir), LOGS_DIR)
  if (!existsSync(root)) return []
  const files = []
  try {
    for (const day of readdirSync(root).filter(d => DATE_DIR_PATTERN.test(d)).sort()) {
      const candidate = join(root, day, String(name))
      if (existsSync(candidate)) files.push({ day, path: candidate })
    }
  } catch { /* ignore unreadable logs dir */ }
  return files
}

/**
 * Prune expired daily log files for one log name (or all configured names) and
 * remove any empty date directories left behind.
 */
export function pruneDailyLogs(stateDir, { name = null, retentionDays = null, now = Date.now(), log = () => {} } = {}) {
  const root = join(String(stateDir), LOGS_DIR)
  if (!existsSync(root)) return 0
  const rules = name
    ? { [String(name)]: Number.isFinite(retentionDays) && retentionDays >= 0 ? retentionDays : (DEFAULT_RETENTION_DAYS[name] ?? 30) }
    : { ...DEFAULT_RETENTION_DAYS }
  let removed = 0
  let days = []
  try { days = readdirSync(root).filter(d => DATE_DIR_PATTERN.test(d)).sort() } catch { return 0 }
  for (const day of days) {
    const dir = join(root, day)
    const dayMs = Date.parse(day + 'T23:59:59.999Z')
    for (const [fileName, keepDays] of Object.entries(rules)) {
      const file = join(dir, fileName)
      if (!existsSync(file)) continue
      const cutoff = Number(now) - keepDays * 24 * 60 * 60 * 1000
      try {
        const refMs = Number.isFinite(dayMs) ? dayMs : statSync(file).mtimeMs
        if (refMs < cutoff) {
          unlinkSync(file)
          removed += 1
        }
      } catch (error) {
        try { log('warn', 'daily log prune failed for ' + file + ': ' + String(error && error.message ? error.message : error)) } catch {}
      }
    }
    try {
      if (readdirSync(dir).length === 0) rmdirSync(dir)
    } catch { /* ignore non-empty or busy dir */ }
  }
  return removed
}
