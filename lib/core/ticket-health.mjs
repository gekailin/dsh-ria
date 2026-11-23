// Per-ticket health for the Chat's status views.
//
// A working ticket is only healthy while its Executor turn is open and that
// session keeps producing events. The 2026-11 failures ended a turn with
// reason.kind=error (LLM idle timeout) while the ticket stayed working forever;
// `turn/end` now parks that ticket, and these fields make the same condition
// visible on demand instead of only in logs.
//
// The Executor session is the real source of progress: a Executor running 25 steps
// does not call ria_executor_report between milestones, so the ticket record alone
// looks frozen while the session is perfectly alive. The session event time is
// therefore checked first; the ticket-record rule is the degraded path for when
// no session activity is known (no live turn projection, or a fresh process
// that has not seen an event yet).
//
// The rule is deliberately one pure function: ria_chat_status (ticket view) and
// ria_chat_executor_config get must report the same numbers for the same ticket.
// No timers, no IO.

/** Age in minutes above which a working ticket's own record is stale. */
export const STUCK_LAST_EVENT_MINUTES = 10
/** Age in minutes above which a working ticket's Executor session is silent. */
export const STUCK_SESSION_EVENT_MINUTES = 15

/**
 * Epoch ms of the ticket's last record update, or null when it never had one.
 * Every store write bumps updatedAt, so the newest of progress.lastEventAt and
 * updatedAt is the real record time; taking progress alone would report a
 * freshly re-dispatched ticket as old when it carries a previous attempt's
 * progress record. This is the degraded path, not the primary signal.
 */
export function ticketLastEventAt(ticket) {
  if (!ticket || typeof ticket !== 'object') return null
  const progressAt = ticket.progress && Number.isFinite(ticket.progress.lastEventAt) ? ticket.progress.lastEventAt : 0
  const updatedAt = Number.isFinite(ticket.updatedAt) && ticket.updatedAt > 0 ? ticket.updatedAt : 0
  const at = Math.max(progressAt, updatedAt)
  if (at > 0) return at
  // createdAt only for a ticket that has never been written since creation.
  return Number.isFinite(ticket.createdAt) && ticket.createdAt > 0 ? ticket.createdAt : null
}

// Round a minute value up to one decimal so a value just over the threshold
// still reads as larger than the threshold ("10.1 分钟" for 10 分零 1 秒).
function formatAge(minutes) {
  return Number((Math.ceil(minutes * 10) / 10).toFixed(1)) + ' 分钟'
}

// Local wall clock, minute precision: enough to locate the gap in a log.
function formatClock(epochMs) {
  const date = new Date(epochMs)
  const pad = value => String(value).padStart(2, '0')
  return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate())
    + ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes())
}

const positiveMinutes = value => (Number.isFinite(value) && value > 0 ? value : null)

/**
 * Health fields shared by every ticket projection.
 *
 * @param {object} ticket stored ticket (status/executor/progress/updatedAt)
 * @param {object} options
 * @param {boolean} options.activeTurn this ticket's executor has an unclosed turn
 * @param {number} options.now epoch ms used for the age calculation
 * @param {number} options.thresholdMinutes ticket-record threshold (default 10)
 * @param {number} options.sessionLastEventAt epoch ms of the executor session's last event, when known
 * @param {number} options.sessionThresholdMinutes session-silence threshold (default 15)
 * @returns {{activeTurn: boolean, lastEventAgeMinutes: number|null, sessionLastEventAgeMinutes: number|null, stuckSuspect: boolean, stuckReason: string|null}}
 */
export function computeTicketHealth(ticket, options = {}) {
  const activeTurn = Boolean(options.activeTurn)
  const at = Number.isFinite(options.now) ? options.now : Date.now()
  const thresholdMinutes = positiveMinutes(options.thresholdMinutes) || STUCK_LAST_EVENT_MINUTES
  const sessionThresholdMinutes = positiveMinutes(options.sessionThresholdMinutes) || STUCK_SESSION_EVENT_MINUTES
  const lastEventAt = ticketLastEventAt(ticket)
  const lastEventAgeMinutes = lastEventAt === null ? null : Math.max(0, (at - lastEventAt) / 60000)
  // Only a real epoch timestamp counts as session activity; 0/undefined/NaN mean
  // "unknown" and select the degraded ticket-record path.
  const sessionLastEventAt = Number.isFinite(options.sessionLastEventAt) && options.sessionLastEventAt > 0
    ? options.sessionLastEventAt
    : null
  const sessionLastEventAgeMinutes = sessionLastEventAt === null ? null : Math.max(0, (at - sessionLastEventAt) / 60000)
  const reasons = []
  // Only a working ticket can be silently stuck: blocked waitingOn already says
  // who/what it waits for, and terminal/queued tickets are not being executed.
  if (ticket && ticket.status === 'working') {
    if (!activeTurn) reasons.push('working 但没有活跃 turn')
    const recordStale = lastEventAgeMinutes !== null && lastEventAgeMinutes > thresholdMinutes
    if (sessionLastEventAgeMinutes !== null) {
      // Primary rule: the session is what advances. Both the session and the
      // ticket record must look stale before calling it stuck; a busy turn with
      // steps but no ria_executor_report is healthy.
      if (sessionLastEventAgeMinutes > sessionThresholdMinutes && recordStale) {
        reasons.push('会话无事件 ' + formatAge(sessionLastEventAgeMinutes)
          + '（最后事件 ' + formatClock(sessionLastEventAt) + '，阈值 ' + sessionThresholdMinutes + ' 分钟）；'
          + '工单记录无更新 ' + formatAge(lastEventAgeMinutes)
          + '（最后更新 ' + formatClock(lastEventAt) + '，阈值 ' + thresholdMinutes + ' 分钟）')
      }
    } else if (recordStale) {
      // Degraded path, unchanged semantics: no session activity is known, so
      // the ticket record alone decides (old 10-minute rule).
      reasons.push('工单记录无更新 ' + formatAge(lastEventAgeMinutes)
        + '（最后更新 ' + formatClock(lastEventAt) + '，阈值 ' + thresholdMinutes + ' 分钟）')
    }
  }
  return {
    activeTurn,
    lastEventAgeMinutes,
    sessionLastEventAgeMinutes,
    stuckSuspect: reasons.length > 0,
    stuckReason: reasons.length > 0 ? reasons.join('；') : null,
  }
}
