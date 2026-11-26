// Board/topic UI policy for the completed segment. The server computes this
// with its own wall clock; the client only renders the resulting counts/window.
export const COMPLETED_RECENT_WINDOW_MS = 24 * 60 * 60 * 1000
// One limit for all three topic-card groups (待执行 / 执行中 / 已完成).
// The 24h window below is a separate filter for the completed group only.
export const BOARD_TOPIC_GROUP_LIMIT = 3
export const COMPLETED_RECENT_EMPTY_TEXT = '近 24h 无完成'

/**
 * Select the recent completed segment without mutating the input.
 * closedAt exactly at now-window is included; older/future/invalid values are
 * handled deterministically. Tie-break is ticketId ascending for stability.
 */
export function selectRecentCompleted(completedWorkOrders, now = Date.now()) {
  const list = (Array.isArray(completedWorkOrders) ? completedWorkOrders : [])
    .filter(item => item && Number.isFinite(Number(item.closedAt)))
    .slice()
  const cutoff = Number(now) - COMPLETED_RECENT_WINDOW_MS
  const recent = list
    .filter(item => Number(item.closedAt) >= cutoff)
    .sort((left, right) => Number(right.closedAt) - Number(left.closedAt)
      || String(left.ticketId || '').localeCompare(String(right.ticketId || '')))
  return {
    shown: recent.slice(0, BOARD_TOPIC_GROUP_LIMIT),
    totalCount: list.length,
    recentCount: recent.length,
    hasRecent: recent.length > 0,
  }
}
