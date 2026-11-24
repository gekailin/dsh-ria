// Read-only Sage context for a reflection run: cognition snapshot, pending
// proposals, decision history and a metadata-only Sage activity summary.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const text = value => String(value == null ? '' : value)
const clip = (value, n) => [...text(value)].slice(0, n).join('')
const norm = value => text(value).replace(/\s+/g, ' ').trim()

function parseSince(raw, now) {
  if (raw === undefined || raw === null || raw === '') return { at: now - 24 * 60 * 60 * 1000, source: 'fallback_24h' }
  if (raw === 'last_reflection') return { at: now - 24 * 60 * 60 * 1000, source: 'fallback_24h_no_last_reflection' }
  if (typeof raw === 'number' && Number.isFinite(raw)) return { at: raw, source: 'explicit' }
  const parsed = Date.parse(String(raw))
  if (Number.isFinite(parsed)) return { at: parsed, source: 'explicit' }
  return { at: now - 24 * 60 * 60 * 1000, source: 'fallback_invalid' }
}

function entryDate(section, fallback) {
  const m = String(section).match(/20\d\d[-/]\d\d[-/]\d\d(?:[T ][0-9:.+Z-]+)?/)
  if (!m) return fallback
  const at = Date.parse(m[0].replace(/\//g, '-'))
  return Number.isFinite(at) ? at : fallback
}

function entriesOf(file) {
  const body = readFileSync(file, 'utf8')
  const mtime = statSync(file).mtimeMs
  const parts = body.split(/^(?=#{1,6}\s+)/m).filter(part => {
    const trimmed = String(part || '').trim()
    return trimmed && !(/^#\s/.test(trimmed) && trimmed.split('\n').length === 1)
  })
  if (!parts.length) return [{ anchor: file.split('/').pop(), at: mtime, summary: clip(norm(body), 200) }]
  return parts.map(part => {
    const first = part.split('\n')[0].replace(/^#{1,6}\s*/, '').trim()
    return { anchor: clip(first || file.split('/').pop(), 120), at: entryDate(part, mtime), summary: clip(norm(part.slice(first.length)), 200) }
  })
}

function readProposals(dir) {
  if (!existsSync(dir)) return []
  const out = []
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) continue
    try { out.push(JSON.parse(readFileSync(join(dir, name), 'utf8'))) } catch {}
  }
  return out
}

function applyBudget(result, maxChars) {
  let json = JSON.stringify(result)
  while (json.length > maxChars && (result.cognitionSnapshot.files.length || result.pendingProposals.items.length || result.decisionHistory.items.length || result.sageActivity.items.length)) {
    if (result.sageActivity.items.length) result.sageActivity.items.pop()
    else if (result.decisionHistory.items.length) result.decisionHistory.items.pop()
    else if (result.pendingProposals.items.length) result.pendingProposals.items.pop()
    else result.cognitionSnapshot.files.pop()
    result.truncated = true
    json = JSON.stringify(result)
  }
  return result
}

function buildSageActivity(events, sageSessionId) {
  const activity = Array.isArray(events) ? events : []
  const sageActivity = {
    sessionId: sageSessionId || '', available: Boolean(sageSessionId),
    items: activity.slice(0, 200).map(event => ({ type: text(event.type || event.event || 'unknown'), at: event.at || event.time || null })),
    counts: { total: activity.length, turns: activity.filter(e => /turn\//.test(String(e.type || e.event))).length, writes: activity.filter(e => /tool\/.*(sage|write)/i.test(String(e.type || e.event || '')) || /memory|cognition/i.test(String(e.type || e.event || ''))).length, decisions: activity.filter(e => /proposal|decision|approve|reject/i.test(String(e.type || e.event || ''))).length, replies: activity.filter(e => /assistant|reply/i.test(String(e.type || e.event))).length },
  }
  if (!sageSessionId) sageActivity.note = 'Sage session id unavailable; activity not read'
  return sageActivity
}

function buildSqliteContext(db, { sinceInfo, budget, events, sageSessionId, now }) {
  const entries = db.prepare('SELECT id,scope,status,body,cause,tags,updated_at,sources FROM cognition_entries ORDER BY updated_at DESC, id ASC').all()
  const entryItems = entries.filter(row => Number(row.updated_at) >= sinceInfo.at)
  const byScope = new Map()
  for (const row of entryItems) {
    const list = byScope.get(row.scope) || []
    list.push({ anchor: row.id, at: new Date(Number(row.updated_at) || now).toISOString(), summary: clip(norm(row.body), 200) })
    byScope.set(row.scope, list)
  }
  const files = [...byScope.entries()].map(([scope, items]) => ({
    file: 'cognition_entries/' + scope, entries: items.length,
    latest: Math.max(...items.map(item => Date.parse(item.at))), items,
  }))
  const preferences = entries.filter(row => row.scope === 'user:preference' && row.status === 'active').map(row => ({
    id: row.id, scope: row.scope, status: row.status, body: row.body, cause: row.cause,
    sources: JSON.parse(row.sources || '[]'),
  }))
  const proposals = db.prepare('SELECT * FROM cognition_proposals ORDER BY created_at DESC, id ASC').all()
  const normalizeStatus = status => status === 'denied' ? 'rejected' : status
  const pending = proposals.filter(row => row.status === 'pending' && Number(row.created_at) >= sinceInfo.at)
    .slice(0, 50).map(row => ({
      id: row.id, title: clip(norm(row.body), 120), scope: row.scope || 'global',
      at: new Date(Number(row.created_at) || now).toISOString(), file: 'cognition_proposals/' + row.id,
    }))
  const terminal = new Set(['accepted', 'rejected', 'deferred', 'merged'])
  const history = proposals.filter(row => terminal.has(normalizeStatus(row.status)) && Number(row.decided_at) >= sinceInfo.at)
    .map(row => {
      const status = normalizeStatus(row.status)
      const decidedAt = Number(row.decided_at) || null
      return {
        id: row.id, status,
        at: new Date(decidedAt || now).toISOString(),
        decidedBy: row.decided_by || null,
        decidedAt: new Date(decidedAt || now).toISOString(),
        rationale: row.rationale || null,
        title: clip(norm(row.body), 120),
        recorded: (!row.decided_by || !decidedAt || !row.rationale) ? 'partial' : 'complete',
      }
    }).slice(0, 20)
  const projects = db.prepare("SELECT project_id,name,workspaces,overview,status,updated_at FROM cognition_projects WHERE status='active' ORDER BY project_id").all().map(row => ({ projectId: row.project_id, name: row.name, workspaces: JSON.parse(row.workspaces || '[]'), overview: row.overview || '', status: row.status, updatedAt: row.updated_at }))
  const disputedEntries = entries.filter(row => row.status === 'disputed').map(row => ({ id: row.id, scope: row.scope, body: row.body, cause: row.cause, sources: JSON.parse(row.sources || '[]') }))
  const result = {
    since: new Date(sinceInfo.at).toISOString(), sinceSource: sinceInfo.source,
    maxChars: budget,
    cognitionSnapshot: { files, totalFiles: files.length, preferences, projects, disputedEntries },
    pendingProposals: { items: pending, total: pending.length },
    decisionHistory: {
      items: history, total: history.length,
      recorded: history.length ? (history.every(item => item.recorded === 'complete') ? 'complete' : 'partial') : '无记录',
      warnings: [],
      note: history.length ? 'accepted/rejected/deferred/merged from cognition SQLite; missing legacy fields are read as null with recorded=partial' : 'SQLite 中没有结局记录',
      suggestedFields: ['status', 'decidedBy', 'decidedAt', 'rationale'],
    },
    sageActivity: buildSageActivity(events, sageSessionId),
    truncated: false,
    counts: {
      files: files.length,
      entries: files.reduce((n, f) => n + f.items.length, 0),
      pendingProposals: pending.length,
      decisionHistory: history.length,
      sageEvents: (Array.isArray(events) ? events : []).length,
    },
  }
  return applyBudget(result, budget)
}

export function readSageContext(stateDir, { since, maxChars = 20000, now = Date.now(), events = [], sageSessionId = '', cognition = null, log = null } = {}) {
  const sinceInfo = parseSince(since, now)
  const budget = Number.isFinite(maxChars) && maxChars > 0 ? Math.floor(maxChars) : 20000
  if (cognition) {
    const db = cognition.openDb()
    if (!db) {
      const error = Object.assign(new Error(cognition.dbError?.message || 'cognition database unavailable'), { code: 'cognition_db_unavailable' })
      try { (log || console.warn)('warn', error.message) } catch {}
      throw error
    }
    return buildSqliteContext(db, { sinceInfo, budget, events, sageSessionId, now })
  }
  const cognitionDir = join(stateDir, 'cognition')
  const files = []
  const candidates = [
    ['principles.md', join(cognitionDir, 'principles.md')],
  ]
  const chatDir = join(cognitionDir, 'chat')
  if (existsSync(chatDir)) {
    for (const name of readdirSync(chatDir).filter(name => name.endsWith('.md')).sort()) {
      candidates.push(['chat/' + name, join(chatDir, name)])
    }
  }
  for (const [name, file] of candidates) {
    if (!existsSync(file)) continue
    const entries = entriesOf(file).map(entry => ({ ...entry, file: name }))
    const changed = entries.filter(entry => entry.at >= sinceInfo.at)
    if (changed.length) files.push({ file: name, entries: changed.length, latest: Math.max(...changed.map(e => e.at)), items: changed.map(entry => ({ anchor: entry.anchor, at: new Date(entry.at).toISOString(), summary: entry.summary })) })
  }
  const proposals = readProposals(join(cognitionDir, 'proposals'))
  const pending = proposals.filter(item => item && item.status === 'pending' && Number(item.createdAt) >= sinceInfo.at)
    .sort((a, b) => Number(b.createdAt) - Number(a.createdAt))
    .slice(0, 50)
    .map(item => ({ id: item.id, title: clip(norm(item.text), 120), scope: item.scope || 'global', at: new Date(Number(item.createdAt) || now).toISOString(), file: 'cognition/proposals/' + item.id + '.json' }))
  const decisionStatus = item => item && item.status === 'accepted' ? 'accepted'
    : item && item.status === 'deferred' ? 'deferred'
      : item && (item.status === 'denied' || item.status === 'rejected') ? 'denied' : null
  const history = proposals.map(item => {
    const status = decisionStatus(item)
    if (!status) return null
    const decidedAt = Number(item.decidedAt || item.reviewedAt || item.at || item.createdAt) || null
    if (!decidedAt || decidedAt < sinceInfo.at) return null
    const decidedBy = item.decidedBy || item.reviewedBy || null
    const rationale = item.rationale || item.reason || null
    const partial = !decidedBy || !decidedAt || !rationale
    // Validation only: accepted text that still says deferred/pending is
    // suspicious, but we never rewrite the proposal file.
    const warning = status === 'accepted' && /暂缓|待定|defer|pending/i.test(text(item.text))
      ? 'accepted proposal text contains deferred/pending wording'
      : null
    return {
      id: item.id, status,
      at: new Date(decidedAt).toISOString(),
      decidedBy, decidedAt: new Date(decidedAt).toISOString(), rationale,
      title: clip(norm(item.text), 120),
      recorded: partial ? 'partial' : 'complete',
      ...(warning ? { warning } : {}),
    }
  }).filter(Boolean)
    .sort((a, b) => Date.parse(b.decidedAt) - Date.parse(a.decidedAt))
    .slice(0, 20)
  const activity = Array.isArray(events) ? events : []
  const sageActivity = {
    sessionId: sageSessionId || '', available: Boolean(sageSessionId),
    items: activity.slice(0, 200).map(event => ({ type: text(event.type || event.event || 'unknown'), at: event.at || event.time || null })),
    counts: { total: activity.length, turns: activity.filter(e => /turn\//.test(String(e.type || e.event))).length, writes: activity.filter(e => /tool\/.*(sage|write)/i.test(String(e.type || e.event || '')) || /memory|cognition/i.test(String(e.type || e.event || ''))).length, decisions: activity.filter(e => /proposal|decision|approve|reject/i.test(String(e.type || e.event || ''))).length, replies: activity.filter(e => /assistant|reply/i.test(String(e.type || e.event))).length },
  }
  if (!sageSessionId) sageActivity.note = 'Sage session id unavailable; activity not read'
  const result = {
    since: new Date(sinceInfo.at).toISOString(), sinceSource: sinceInfo.source,
    maxChars: budget,
    cognitionSnapshot: { files, totalFiles: files.length },
    pendingProposals: { items: pending, total: pending.length },
    decisionHistory: {
      items: history, total: history.length,
      recorded: history.length ? (history.every(item => item.recorded === 'complete') ? 'complete' : 'partial') : '无记录',
      warnings: history.filter(item => item.warning).map(item => ({ id: item.id, warning: item.warning })),
      note: history.length ? 'accepted/deferred/denied; missing legacy fields are read as null with recorded=partial' : '现有 proposal 存储没有结局记录',
      suggestedFields: ['status', 'decidedBy', 'decidedAt', 'rationale'],
    },
    sageActivity,
    truncated: false,
    counts: {
      files: files.length,
      entries: files.reduce((n, f) => n + f.items.length, 0),
      pendingProposals: pending.length,
      decisionHistory: history.length,
      sageEvents: activity.length,
    },
  }
  return applyBudget(result, budget)
}
