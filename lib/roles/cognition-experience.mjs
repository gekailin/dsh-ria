import { projectKey } from './cognition.mjs'

const text = value => typeof value === 'string' ? value.trim() : ''
const charSlice = (value, max) => [...String(value == null ? '' : value)].slice(0, max).join('')

/**
 * Advisor experience retrieval.
 *
 * Ordering: SQLite searchEntries already returns updated_at DESC/id ASC; file
 * fallback keeps project file order then chat file order. Keep at most 5 entries
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
  if (cognition.backend === 'sqlite') {
    const scope = workspace ? 'project:' + projectKey(workspace) : ''
    let found = cognition.searchEntries({ ...(scope ? { scope } : {}), text: query, limit: 20 })
    if (!found.length && tagsList.length) found = cognition.searchEntries({ ...(scope ? { scope } : {}), tags: tagsList, limit: 20 })
    if (!found.length && query) found = cognition.searchEntries({ text: query, limit: 20 })
    if (found.length) return found.slice(0, max).map(entry => normalize({
      id: entry.id,
      source: entry.sources && entry.sources[0] && entry.sources[0].ref ? entry.sources[0].ref : 'cognition:' + entry.id,
      text: entry.body,
    }))
    if (!cognition.dbFailed) return []
  }
  // File fallback: no DB calls; backend=file never enters the sqlite branch.
  const key = workspace ? projectKey(workspace) : 'global'
  const files = [
    'projects/' + key + '.md',
    'projects/dsh-ria.md',
    'chat/preferences.md',
    'chat/agreements.md',
    'chat/decisions.md',
  ]
  const tokens = [...tagsList, ...query.split(/\s+/)].map(value => value.toLowerCase()).filter(Boolean)
  const out = []
  const seen = new Set()
  for (const file of files) {
    let body = ''
    try { body = cognition.readIfExists(file) } catch { body = '' }
    if (!body || seen.has(file)) continue
    seen.add(file)
    const lines = body.split(/\r?\n/)
    for (let index = 0; index < lines.length; index += 1) {
      const raw = lines[index].replace(/^\s*(?:[-*]|\d+[.)])\s+/, '').trim()
      if (!raw || raw.startsWith('#')) continue
      if (tokens.length && !tokens.some(token => raw.toLowerCase().includes(token))) continue
      out.push({ id: 'file:' + file + ':' + (index + 1), source: file + ':' + (index + 1), text: charSlice(raw, maxChars) })
      if (out.length >= max) return out
    }
  }
  return out
}
