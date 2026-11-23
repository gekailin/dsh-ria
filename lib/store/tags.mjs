// Tag normalization for the state Executor routing layer.
//
// All tags that enter the system (user, Advisor, or auto-learned) go through
// normalizeTags so routing comparisons are deterministic. The later, more
// specific executor model allows up to 12 explicit tags; callers that need the
// softer auto-tag budget pass AUTO_TAG_LIMIT explicitly.

export const TAG_LIMIT = 12
export const AUTO_TAG_LIMIT = 8
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
