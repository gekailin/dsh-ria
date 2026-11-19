// Per-ticket health for the Chatbot's status views.
//
// A working ticket is only healthy while its Worker turn is open. The 2026-11
// failures ended a turn with reason.kind=error (LLM idle timeout) while the
// ticket stayed working forever; `turn/end` now parks that ticket, and these
// fields make the same condition visible on demand instead of only in logs.
//
// The rule is deliberately one pure function: chatbot_status (ticket view) and
// chatbot_worker_config get must report the same numbers for the same ticket.
// No timers, no IO.

/** Age in minutes above which a working ticket is treated as stuck. */
export const STUCK_LAST_EVENT_MINUTES = 10

/**
 * Epoch ms of the ticket's last event, or null when the ticket never had one.
 * Every store write bumps updatedAt, so the newest of progress.lastEventAt and
 * updatedAt is the real activity time; taking progress alone would report a
 * freshly re-dispatched ticket as old when it carries a previous attempt's
 * progress record.
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

/**
 * Health fields shared by every ticket projection.
 *
 * @param {object} ticket stored ticket (status/executor/progress/updatedAt)
 * @param {object} options
 * @param {boolean} options.activeTurn this ticket's executor has an unclosed turn
 * @param {number} options.now epoch ms used for the age calculation
 * @param {number} options.thresholdMinutes age above which a working ticket is stuck
 * @returns {{activeTurn: boolean, lastEventAgeMinutes: number|null, stuckSuspect: boolean, stuckReason: string|null}}
 */
export function computeTicketHealth(ticket, options = {}) {
  const activeTurn = Boolean(options.activeTurn)
  const at = Number.isFinite(options.now) ? options.now : Date.now()
  const thresholdMinutes = Number.isFinite(options.thresholdMinutes) && options.thresholdMinutes > 0
    ? options.thresholdMinutes
    : STUCK_LAST_EVENT_MINUTES
  const lastEventAt = ticketLastEventAt(ticket)
  const lastEventAgeMinutes = lastEventAt === null ? null : Math.max(0, (at - lastEventAt) / 60000)
  const reasons = []
  // Only a working ticket can be silently stuck: blocked waitingOn already says
  // who/what it waits for, and terminal/queued tickets are not being executed.
  if (ticket && ticket.status === 'working') {
    if (!activeTurn) reasons.push('working 但没有活跃 turn')
    if (lastEventAgeMinutes !== null && lastEventAgeMinutes > thresholdMinutes) {
      reasons.push(activeTurn
        ? '回合未闭合且长时间无事件'
        : '最后一个事件已过去 ' + formatAge(lastEventAgeMinutes) + '（阈值 ' + thresholdMinutes + ' 分钟）')
    }
  }
  return {
    activeTurn,
    lastEventAgeMinutes,
    stuckSuspect: reasons.length > 0,
    stuckReason: reasons.length > 0 ? reasons.join('；') : null,
  }
}
