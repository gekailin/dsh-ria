import { closeSync, copyFileSync, existsSync, fsyncSync, openSync, renameSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { RouterEventLog } from '../router-events.mjs'

export const LEGACY_TICKETS_LOG = 'tickets.log.jsonl'

const defaultLog = (level, message) => {
  try { console[level === 'warn' ? 'warn' : 'log']('[ria] ' + message) } catch { /* ignore */ }
}

function stamp(at) {
  return new Date(Number(at) || Date.now()).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')
}

function uniqueTarget(stateDir, at) {
  const base = join(stateDir, LEGACY_TICKETS_LOG + '.bak-' + stamp(at))
  let candidate = base
  let index = 1
  while (existsSync(candidate)) {
    candidate = base + '-' + index
    index += 1
  }
  return candidate
}

/**
 * One-shot, idempotent archive of the retired write-only tickets log.
 *
 * The file is never deleted silently: it is renamed to
 * tickets.log.jsonl.bak-<UTC timestamp>; an existing target gets a -N suffix.
 * On EXDEV, copy to a temporary target, fsync it, rename, then unlink the
 * source. Any failure leaves the source in place and only warns. The success
 * event is legacy.tickets_log.archived; an event failure cannot fail startup.
 */
export function archiveLegacyTicketsLog(stateDir, { now = Date.now, log = defaultLog } = {}) {
  const from = join(String(stateDir), LEGACY_TICKETS_LOG)
  if (!existsSync(from)) return { archived: false, reason: 'missing' }
  const to = uniqueTarget(stateDir, now())
  let bytes = 0
  try { bytes = statSync(from).size } catch { /* size is best effort */ }
  try {
    try {
      renameSync(from, to)
    } catch (error) {
      if (!error || error.code !== 'EXDEV') throw error
      const temporary = to + '.tmp-' + process.pid
      try {
        copyFileSync(from, temporary)
        const fd = openSync(temporary, 'r+')
        try { fsyncSync(fd) } finally { closeSync(fd) }
        renameSync(temporary, to)
        unlinkSync(from)
      } catch (fallbackError) {
        try { unlinkSync(temporary) } catch { /* best effort */ }
        throw fallbackError
      }
    }
  } catch (error) {
    try { log('warn', 'could not archive ' + LEGACY_TICKETS_LOG + ': ' + String(error && error.message ? error.message : error)) } catch { /* warn only */ }
    return { archived: false, from, error: String(error && error.message ? error.message : error) }
  }
  try {
    const events = new RouterEventLog({ stateDir: String(stateDir), log: (level, message) => log(level, message) })
    events.append({
      event: 'legacy.tickets_log.archived', ticketId: null, sessionId: '', actor: 'system',
      reason: 'retired write-only tickets log archived', payload: { from, to, bytes },
    })
  } catch (error) {
    try { log('warn', 'archived ' + LEGACY_TICKETS_LOG + ' but could not record legacy.tickets_log.archived: ' + String(error && error.message ? error.message : error)) } catch { /* warn only */ }
  }
  try { log('info', 'archived legacy ' + LEGACY_TICKETS_LOG + ' to ' + to) } catch { /* info only */ }
  return { archived: true, from, to, bytes }
}
