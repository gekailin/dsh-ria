// Tag normalization for the state Executor routing layer.
//
// All tags that enter the system (user, Advisor, or auto-learned) go through
// normalizeTags so routing comparisons are deterministic. The later, more
// specific executor model allows up to 12 explicit tags; callers that need the
// softer auto-tag budget pass AUTO_TAG_LIMIT explicitly.

export const TAG_LIMIT = 12
// Completed-ticket learning keeps a tag -> lastTurn map; the physical cap is
// 100 entries and eviction is deterministic (oldest turn, then tag).
export const AUTO_TAG_LIMIT = 100
// A learned tag participates in routing only while
// currentTurn - lastTurn <= this threshold. Aging never deletes the entry.
export const AUTO_TAG_TURN_THRESHOLD = 30
// The idempotency ledger only needs to be long enough to stop accidental
// replay of recent completions; it is not a routing input.
export const AUTO_TAG_LEDGER_LIMIT = 200
export const TAG_LENGTH_LIMIT = 32
export const TAG_PATTERN = /^[a-z0-9\u4e00-\u9fff._-]+$/

function normalizeOne(value) {
  if (typeof value !== 'string') return ''
  const tag = value
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9\u4e00-\u9fff._-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
  if (!tag || [...tag].length > TAG_LENGTH_LIMIT) return ''
  return tag
}

/**
 * Normalize a tag list: lowercase, trim, whitespace/underscore to hyphen,
 * keep [a-z0-9\u4e00-\u9fff._-], length 1..32, dedupe in input order, cap.
 * Returns [] for anything that is not an array.
 */
export function normalizeTags(input, max = TAG_LIMIT) {
  if (!Array.isArray(input)) return []
  const limit = Number.isSafeInteger(max) && max >= 0 ? max : TAG_LIMIT
  const out = []
  const seen = new Set()
  for (const raw of input) {
    const tag = normalizeOne(raw)
    if (!tag || seen.has(tag)) continue
    seen.add(tag)
    out.push(tag)
    if (out.length >= limit) break
  }
  return out
}

/** Resolve a configured turn threshold; invalid values fall back to the default. */
export function normalizeAutoTagTurnThreshold(value, fallback = AUTO_TAG_TURN_THRESHOLD) {
  const number = Number(value)
  return Number.isSafeInteger(number) && number >= 0 ? number : fallback
}

/**
 * Normalize the learned autoTag map to { [tag]: lastTurn }. Legacy arrays are
 * converted with lastTurn=0; missing/invalid turns become 0. The 100-entry cap
 * evicts the smallest lastTurn first, then the lexicographically smaller tag.
 */
export function normalizeAutoTags(input) {
  const out = {}
  if (Array.isArray(input)) {
    for (const tag of normalizeTags(input, AUTO_TAG_LIMIT)) out[tag] = 0
  } else if (input && typeof input === 'object') {
    for (const [rawTag, rawTurn] of Object.entries(input)) {
      const tag = normalizeOne(rawTag)
      if (!tag) continue
      const turn = Number.isSafeInteger(Number(rawTurn)) && Number(rawTurn) >= 0 ? Number(rawTurn) : 0
      if (!Object.hasOwn(out, tag) || turn > out[tag]) out[tag] = turn
    }
  }
  const entries = Object.entries(out).sort((left, right) => left[1] - right[1] || left[0].localeCompare(right[0]))
  return Object.fromEntries(entries.slice(-AUTO_TAG_LIMIT))
}

/** Keys of a normalized autoTag map, for vocabulary/display surfaces. */
export function autoTagKeys(input) {
  return Object.keys(normalizeAutoTags(input))
}

/** Only tags still inside the turn window participate in routing/scoring. */
export function activeAutoTags(input, currentTurn = 0, threshold = AUTO_TAG_TURN_THRESHOLD) {
  const at = Number.isSafeInteger(Number(currentTurn)) && Number(currentTurn) >= 0 ? Number(currentTurn) : 0
  const limit = normalizeAutoTagTurnThreshold(threshold)
  return Object.entries(normalizeAutoTags(input))
    .filter(([, lastTurn]) => at - lastTurn <= limit)
    .map(([tag]) => tag)
}

/** Merge lists and normalize once, preserving the first occurrence order. */
export function mergeTags(...lists) {
  const merged = []
  for (const list of lists) {
    if (!Array.isArray(list)) continue
    for (const tag of list) merged.push(tag)
  }
  return normalizeTags(merged, TAG_LIMIT)
}

export function hasTagIntersection(left, right) {
  const a = Array.isArray(left) ? left : []
  const b = new Set(Array.isArray(right) ? right : [])
  return a.some(tag => b.has(tag))
}

export function intersectTags(left, right) {
  const b = new Set(Array.isArray(right) ? right : [])
  return (Array.isArray(left) ? left : []).filter(tag => b.has(tag))
}
