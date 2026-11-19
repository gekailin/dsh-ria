// Read-only model catalog support for the Chatbot's chatbot_models tool.
// The DSH llm registry is the source of truth; this module only normalizes its
// entries, applies the tool's filters, and supplies the last-resort bundled
// list used when the registry cannot be read at all.

export const MODEL_CATALOG_TTL_MS = 5 * 60_000

// Mirrors the official DeepSeek adapter's bundled entries, which the host uses
// when its remote /models listing fails. Kept small and static: this is a
// last-resort answer, not a second catalog that competes with the registry.
export const BUNDLED_MODEL_CATALOG = Object.freeze([
  {
    provider: 'deepseek',
    model: 'deepseek-flash',
    displayName: 'DeepSeek-V4.1-Flash',
    contextWindow: 1048576,
    source: 'bundled-fallback',
  },
  {
    provider: 'deepseek',
    model: 'deepseek-v4-pro',
    displayName: 'DeepSeek-V4-Pro',
    contextWindow: 1048576,
    source: 'bundled-fallback',
  },
])

const text = value => typeof value === 'string' ? value.trim() : ''

/** Copy the static fallback so callers can annotate/sort it without mutating the module. */
export function bundledModelCatalog() {
  return BUNDLED_MODEL_CATALOG.map(item => ({ ...item }))
}

/**
 * Normalize one registry model. The host's adapter API exposes id/name and may
 * expose contextWindow/maxTokens; numeric fields are copied only when present.
 */
export function normalizeModelEntry(provider, item, source = 'catalog') {
  const raw = item && typeof item === 'object' ? item : {}
  const id = text(raw.id) || text(raw.model)
  if (!id) return undefined
  const entry = {
    provider: text(raw.provider) || text(provider),
    model: id,
    displayName: text(raw.name) || text(raw.displayName) || id,
    source,
  }
  if (Number.isFinite(raw.contextWindow)) entry.contextWindow = raw.contextWindow
  const max = Number.isFinite(raw.maxOutput) ? raw.maxOutput : raw.maxTokens
  if (Number.isFinite(max)) entry.maxOutput = max
  return entry
}

/** Apply provider/query filters (case-insensitive substring over id and displayName). */
export function filterModelCatalog(models, { provider = '', query = '' } = {}) {
  const providerFilter = text(provider)
  const queryFilter = text(query).toLowerCase()
  return (Array.isArray(models) ? models : []).filter(item => {
    if (!item) return false
    if (providerFilter && String(item.provider || '') !== providerFilter) return false
    if (queryFilter) {
      const id = String(item.model || '').toLowerCase()
      const name = String(item.displayName || '').toLowerCase()
      if (!id.includes(queryFilter) && !name.includes(queryFilter)) return false
    }
    return true
  })
}
