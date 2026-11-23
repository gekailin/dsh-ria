// One-version read compatibility for the worker -> executor rename.
//
// The legacy names are assembled from fragments so later mechanical renames
// cannot rewrite the compatibility literals themselves.
const LEGACY_WORKER = 'wor' + 'ker'

export const LEGACY_EXECUTOR_KEYS = Object.freeze({
  [LEGACY_WORKER + 's']: 'executors',
  [LEGACY_WORKER + 'Id']: 'executorId',
  [LEGACY_WORKER + 'Seq']: 'executorSeq',
  [LEGACY_WORKER + 'Label']: 'executorLabel',
  [LEGACY_WORKER + 'Type']: 'executorType',
})

const LEGACY_RECORD_KEYS = Object.freeze(Object.fromEntries(
  Object.entries(LEGACY_EXECUTOR_KEYS).filter(([legacy]) => legacy !== LEGACY_WORKER + 's'),
))

/** Deep-rename known legacy keys, preferring a new key when both are present. */
export function renameLegacyKeys(value) {
  if (Array.isArray(value)) return value.map(renameLegacyKeys)
  if (!value || typeof value !== 'object') return value
  const output = {}
  for (const [key, item] of Object.entries(value)) {
    const replacement = LEGACY_EXECUTOR_KEYS[key]
    if (replacement) {
      if (!Object.hasOwn(value, replacement)) output[replacement] = renameLegacyKeys(item)
      continue
    }
    output[key] = renameLegacyKeys(item)
  }
  return output
}

/** True when any legacy key is present at any depth. */
export function hasLegacyKeys(value) {
  if (Array.isArray(value)) return value.some(hasLegacyKeys)
  if (!value || typeof value !== 'object') return false
  for (const [key, item] of Object.entries(value)) {
    if (Object.hasOwn(LEGACY_EXECUTOR_KEYS, key)) return true
    if (hasLegacyKeys(item)) return true
  }
  return false
}

/** Normalize one worker/executor record in place and return it. */
export function normalizeLegacyRecord(record, warn = () => {}) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return record
  for (const [legacy, replacement] of Object.entries(LEGACY_RECORD_KEYS)) {
    if (record[replacement] === undefined && record[legacy] !== undefined) {
      record[replacement] = record[legacy]
      warn()
    }
    if (Object.hasOwn(record, legacy)) delete record[legacy]
  }
  return record
}
