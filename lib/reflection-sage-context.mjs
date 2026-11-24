// Read-only Sage context for a reflection run: SQLite cognition snapshot,
// pending proposals, decision history and a metadata-only Sage activity summary.
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { openDatabase } from './state/sqlite/db.mjs'

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
    counts: {
      total: activity.length,
      turns: activity.filter(e => /turn\//.test(String(e.type || e.event))).length,
      writes: activity.filter(e => /tool\/.*(sage|write)/i.test(String(e.type || e.event || '')) || /memory|cognition/i.test(String(e.type || e.event || ''))).length,
      decisions: activity.filter(e => /proposal|decision|approve|reject/i.test(String(e.type || e.event || ''))).length,
      replies: activity.filter(e => /assistant|reply/i.test(String(e.type || e.event))).length,
    },
  }
  if (!sageSessionId) sageActivity.note = 'Sage session id unavailable; activity not read'
  return sageActivity
}

function emptyContext({ sinceInfo, budget, events, sageSessionId }) {
  return applyBudget({
    since: new Date(sinceInfo.at).toISOString(), sinceSource: sinceInfo.source,
    maxChars: budget,
    cognitionSnapshot: { files: [], totalFiles: 0, preferences: [], projects: [], disputedEntries: [] },
    pendingProposals: { items: [], total: 0 },
    decisionHistory: {
      items: [], total: 0, recorded: '无记录', warnings: [],
      note: 'SQLite 中没有结局记录',
      suggestedFields: ['status', 'decidedBy', 'decidedAt', 'rationale'],
    },
    sageActivity: buildSageActivity(events, sageSessionId),
    truncated: false,
    counts: { files: 0, entries: 0, pendingProposals: 0, decisionHistory: 0, sageEvents: (Array.isArray(events) ? events : []).length },
  }, budget)
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
      const warning = status === 'accepted' && /暂缓|待定|defer|pending/i.test(text(row.body))
        ? 'accepted proposal text contains deferred/pending wording'
        : null
      return {
        id: row.id, status,
        at: new Date(decidedAt || now).toISOString(),
        decidedBy: row.decided_by || null,
        decidedAt: new Date(decidedAt || now).toISOString(),
        rationale: row.rationale || null,
        title: clip(norm(row.body), 120),
        recorded: (!row.decided_by || !decidedAt || !row.rationale) ? 'partial' : 'complete',
        ...(warning ? { warning } : {}),
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
      warnings: history.filter(item => item.warning).map(item => ({ id: item.id, warning: item.warning })),
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
  const dbPath = join(String(stateDir || ''), 'ria.sqlite')
  if (!existsSync(dbPath)) return emptyContext({ sinceInfo, budget, events, sageSessionId })
  const db = openDatabase(dbPath, { readOnly: true })
  try {
    return buildSqliteContext(db, { sinceInfo, budget, events, sageSessionId, now })
  } finally {
    db.close()
  }
}
