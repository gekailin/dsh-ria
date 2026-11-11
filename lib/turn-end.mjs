// Reading the reason a worker's last turn ended.
//
// DSH appends one `turn/end` event per turn with `data.reason`:
//   { kind: 'completed' } | { kind: 'blocked' } | { kind: 'max-tokens' }
//   | { kind: 'error', error: { message, code } }
//   | { kind: 'aborted', reason: { kind: 'user' | 'parent' | 'hook' | 'disposed' } }
// (dsh-agent-loop/lib/index.js, abortedCancelCause()).
// Only `aborted(user)` means the user manually stopped the turn; the other
// aborted causes belong to shutdown/parent/hook and must not be treated as a
// user decision.

function eventsOf(source) {
  if (!source) return []
  if (Array.isArray(source)) return source
  if (typeof source.snapshotEvents === 'function') {
    try {
      const events = source.snapshotEvents()
      return Array.isArray(events) ? events : []
    } catch {
      return []
    }
  }
  return []
}

export function turnEndOutcome(reason) {
  const kind = reason && reason.kind
  if (kind === 'aborted') {
    const by = reason.reason && reason.reason.kind
    return by ? 'aborted(' + by + ')' : 'aborted'
  }
  return typeof kind === 'string' && kind ? kind : 'unknown'
}

export function lastTurnEnd(source) {
  const records = eventsOf(source)
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const raw = records[index]
    // sessionController.events() pages wire records as { type: 'event', event }.
    const record = raw && raw.type === 'event' && raw.event ? raw.event : raw
    if (!record || record.type !== 'turn/end') continue
    const data = record.data && typeof record.data === 'object' ? record.data : {}
    const result = { outcome: turnEndOutcome(data.reason) }
    if (Number.isSafeInteger(data.turn)) result.turn = data.turn
    return result
  }
  return undefined
}

export function isUserCancelled(lastTurn) {
  return Boolean(lastTurn && lastTurn.outcome === 'aborted(user)')
}
