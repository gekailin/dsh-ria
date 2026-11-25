import { AUTO_TAG_LEDGER_LIMIT, normalizeAutoTags } from './tags.mjs'

/**
 * Normalize the completion-derived part of an Executor record.
 *
 * This shape is the durable payload for co-managed Executors: their
 * `executors[]` record is filtered out of state.json, so autoTags, the ledger
 * and the completion timestamps must live in `coManagement[].stats` instead.
 * Managed Executors also use the same normalization when they are read back.
 */
export function normalizeExecutorStats(raw = {}) {
  const stats = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const ledger = Array.isArray(stats.autoTaggedTicketIds)
    ? [...new Set(stats.autoTaggedTicketIds.filter(value => typeof value === 'string' && value))]
    : []
  return {
    autoTags: normalizeAutoTags(stats.autoTags),
    autoTaggedTicketIds: ledger.slice(-AUTO_TAG_LEDGER_LIMIT),
    lastUsedAt: Number.isFinite(stats.lastUsedAt) ? stats.lastUsedAt : null,
    lastTurn: Number.isSafeInteger(stats.lastTurn) && stats.lastTurn >= 0 ? stats.lastTurn : 0,
  }
}

/** True when a raw stats object already carries Executor completion fields. */
export function hasExecutorStats(raw) {
  return Boolean(raw && typeof raw === 'object' && !Array.isArray(raw)
    && (Object.hasOwn(raw, 'autoTags')
      || Object.hasOwn(raw, 'autoTaggedTicketIds')
      || Object.hasOwn(raw, 'lastUsedAt')
      || Object.hasOwn(raw, 'lastTurn')))
}
