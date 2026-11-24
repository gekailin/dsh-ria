import { projectKey } from './cognition.mjs'

const text = value => typeof value === 'string' ? value.trim() : ''
const charSlice = (value, max) => [...String(value == null ? '' : value)].slice(0, max).join('')

/**
 * Advisor experience retrieval.
 *
 * Ordering: SQLite searchEntries returns updated_at DESC/id ASC. Keep at most 5 entries
 * and truncate each text to 200 characters (code points, not bytes).
 */
export function selectAdvisorExperience({ cognition, workspace = '', topic = '', tags = [], goal = '', limit = 5, maxChars = 200 } = {}) {
  if (!cognition) return []
  const max = Math.min(5, Number.isSafeInteger(limit) ? Math.max(1, limit) : 5)
  const tagsList = Array.isArray(tags) ? tags.map(text).filter(Boolean).slice(0, 5) : []
  const query = [topic, goal].map(text).filter(Boolean).join(' ')
  const normalize = entry => ({
    id: text(entry.id),
    source: text(entry.source) || 'cognition',
    text: charSlice(text(entry.text), maxChars),
  })
  const scope = workspace ? 'project:' + projectKey(workspace) : ''
  let found = cognition.searchEntries({ ...(scope ? { scope } : {}), text: query, limit: 20 })
  if (!found.length && tagsList.length) found = cognition.searchEntries({ ...(scope ? { scope } : {}), tags: tagsList, limit: 20 })
  if (!found.length && query) found = cognition.searchEntries({ text: query, limit: 20 })
  return found.slice(0, max).map(entry => normalize({
    id: entry.id,
    source: entry.sources && entry.sources[0] && entry.sources[0].ref ? entry.sources[0].ref : 'cognition:' + entry.id,
    text: entry.body,
  }))
}
