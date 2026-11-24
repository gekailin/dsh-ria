import { realpathSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { openDatabase, transaction } from '../state/sqlite/db.mjs'
import { tokenize } from '../shared/text.mjs'

const MAX_TOTAL = 6000
const MAX_DIGEST = 1600
const text = value => typeof value === 'string' ? value.trim() : ''
const clip = (value, max) => {
  const s = String(value == null ? '' : value)
  return s.length > max ? s.slice(0, max) + '\n…（截断）' : s
}

export function projectKey(workspace) {
  const raw = text(workspace)
  if (!raw) return 'global'
  let real = resolve(raw)
  try { real = realpathSync(real) } catch { /* keep resolved path */ }
  const base = real.split(sep).filter(Boolean).pop() || 'project'
  const slug = base.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'project'
  return slug + '-' + createHash('sha1').update(real).digest('hex').slice(0, 8)
}

export function normalizeCognitionSettings(value) {
  const raw = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  return { ...(raw.voice !== undefined ? { voice: raw.voice } : {}) }
}

/** Normalize the proposal author to the documented source vocabulary. */
export function normalizeProposalAuthor(value, { warn = null } = {}) {
  const raw = typeof value === 'string' ? value.trim() : ''
  if (raw === 'reflection' || raw === 'sage' || raw === 'user' || raw === 'advisor') return raw
  if (raw.startsWith('executor:') && raw.slice('executor:'.length).trim()) return 'executor:' + raw.slice('executor:'.length).trim()
  try { if (typeof warn === 'function') warn('unknown proposal author "' + raw + '"; using reflection') } catch { /* warn only */ }
  return 'reflection'
}

const COGNITION_STATUS = new Set(['active', 'disputed', 'retired'])
const COGNITION_KIND = new Set(['preference', 'agreement', 'overview', 'experience'])
const PROPOSAL_STATUS = new Set(['accepted', 'rejected', 'deferred', 'merged'])
const normalizeProposalStatus = value => value === 'denied' ? 'rejected' : value
const SOURCE_TYPE = new Set(['ticket', 'session', 'commit', 'file', 'reflection', 'user'])
const VALID_SCOPE = /^(?:global|principle|user:(?:preference|agreement)|(?:project|domain):[a-z0-9][a-z0-9._-]{0,63})$/

export function isValidScope(scope) {
  return VALID_SCOPE.test(String(scope || '').trim())
}

const entryError = (field, message) => ({ ok: false, code: 'cognition_invalid', field, message })
const entryText = value => typeof value === 'string' ? value : ''
const entryLength = value => [...String(value)].length
function sourcesOf(row) {
  try { const value = JSON.parse(row && row.sources ? row.sources : '[]'); return Array.isArray(value) ? value : [] } catch { return [] }
}

function evidenceRefsOf(row) {
  return sourcesOf(row).slice(0, 20).map(source => ({
    type: entryText(source && source.type).trim() || 'file',
    ref: entryText(source && source.ref).trim(),
    ...(Number.isFinite(source && source.at) ? { at: source.at } : {}),
  })).filter(source => source.ref)
}

function affectedEntriesOf(row) {
  const target = entryText(row && row.target_entry_id).trim()
  return target ? [target] : []
}

function normalizeEntryInput(raw = {}) {
  const scope = entryText(raw.scope).trim()
  const body = entryText(raw.body)
  const cause = entryText(raw.cause)
  const tags = Array.isArray(raw.tags) ? raw.tags.map(value => entryText(value).trim()).filter(Boolean).slice(0, 12) : []
  const sources = Array.isArray(raw.sources) ? raw.sources : null
  if (!scope) return entryError('scope', 'scope is required')
  if (!isValidScope(scope)) return entryError('scope', 'scope must be global, principle, user:preference, user:agreement, project:<slug>, or domain:<slug>')
  if (!body.trim()) return entryError('body', 'body is required')
  if (entryLength(body) > 250) return entryError('body', 'body must be <= 250 characters')
  if (!cause.trim()) return entryError('cause', 'cause is required')
  if (entryLength(cause) > 600) return entryError('cause', 'cause must be <= 600 characters')
  if (!sources || sources.length === 0) return entryError('sources', 'sources must contain at least one pointer')
  const normalizedSources = []
  for (const source of sources.slice(0, 10)) {
    if (!source || typeof source !== 'object' || Array.isArray(source)) return entryError('sources', 'each source must be an object')
    const type = entryText(source.type).trim()
    const ref = entryText(source.ref).trim()
    if (!SOURCE_TYPE.has(type)) return entryError('sources', 'source.type must be one of ' + [...SOURCE_TYPE].join(', '))
    if (!ref) return entryError('sources', 'source.ref is required')
    normalizedSources.push({ type, ref, ...(entryText(source.detail).trim() ? { detail: entryText(source.detail).trim() } : {}), ...(Number.isFinite(source.at) ? { at: source.at } : {}) })
  }
  const id = entryText(raw.id).trim()
  if (id && !/^cog_\d+$/.test(id)) return entryError('id', 'id must match cog_<numeric>')
  if (raw.status !== undefined && !COGNITION_STATUS.has(raw.status)) return entryError('status', 'status must be active, disputed or retired')
  if (raw.kind !== undefined && !COGNITION_KIND.has(raw.kind)) return entryError('kind', 'kind must be preference, agreement, overview or experience')
  return { ok: true, value: {
    scope, body, cause, tags, sources: normalizedSources,
    kind: raw.kind || 'experience', status: raw.status || 'active',
    id,
  } }
}

export class CognitionStore {
  constructor({ stateDir, dbPath = null, db = null, log = () => {}, audit = () => {} } = {}) {
    if (!stateDir) throw new Error('CognitionStore requires stateDir')
    this.stateDir = stateDir
    this.base = join(stateDir, 'cognition')
    this.dbPath = dbPath || join(stateDir, 'ria.sqlite')
    this.db = db || null
    this.ownsDb = !db
    this.dbFailed = false
    this.dbError = null
    this.log = log
    this.audit = audit
  }

  /** SQLite is the only cognition store; no file fallback exists. */
  openDb() {
    if (this.db) return this.db
    if (this.dbFailed) return null
    try {
      this.db = openDatabase(this.dbPath)
      this.ownsDb = true
      return this.db
    } catch (error) {
      this.dbFailed = true
      this.dbError = { code: 'cognition_db_unavailable', message: 'cognition database unavailable: ' + this.dbPath + ' (' + String(error && error.message ? error.message : error) + ')' }
      this.log('warn', this.dbError.message)
      return null
    }
  }

  close() {
    if (!this.db) return false
    const db = this.db
    this.db = null
    if (this.ownsDb) {
      try { db.close() } catch { /* already closed */ }
      return true
    }
    return false
  }

  warnBackend(action, error) {
    this.log('warn', 'cognition sqlite ' + action + ' failed: ' + String(error && error.message ? error.message : error))
  }

  proposalRow(row) {
    if (!row) return null
    return {
      id: row.id, author: row.author || 'reflection', source: row.source, kind: row.kind, scope: row.scope,
      targetEntryId: row.target_entry_id || null, ticketId: row.ticket_id || null,
      body: row.body, cause: row.cause || '', sources: sourcesOf(row),
      priority: row.priority, status: normalizeProposalStatus(row.status),
      decidedBy: row.decided_by || null, decidedAt: row.decided_at || null,
      rationale: row.rationale || null,
      evidenceRefs: evidenceRefsOf(row),
      affectedEntries: affectedEntriesOf(row),
      createdAt: row.created_at,
    }
  }

  /** Project a decided cognition_proposals row into the receipt view. */
  receiptFromProposal(row) {
    if (!row) return null
    const decision = normalizeProposalStatus(row.status)
    if (!PROPOSAL_STATUS.has(decision)) return null
    return {
      proposalId: row.id,
      decision,
      rationale: row.rationale || '',
      decidedBy: row.decided_by || '',
      decidedAt: row.decided_at || null,
      evidenceRefs: evidenceRefsOf(row),
      affectedEntries: affectedEntriesOf(row),
    }
  }

  getReceipt(proposalId) {
    const id = entryText(proposalId).trim()
    if (!id) return null
    const db = this.openDb()
    if (!db) return null
    try { return this.receiptFromProposal(db.prepare('SELECT * FROM cognition_proposals WHERE id=?').get(id)) } catch (error) {
      this.warnBackend('getReceipt', error)
      return null
    }
  }

  getProposal(id) {
    const wanted = entryText(id).trim()
    if (!wanted) return null
    const db = this.openDb()
    if (!db) return null
    try {
      return this.proposalRow(db.prepare('SELECT * FROM cognition_proposals WHERE id=?').get(wanted))
    } catch (error) {
      this.warnBackend('getProposal', error)
      return null
    }
  }

  /**
   * One-way, idempotent compatibility migration: denied -> rejected.
   */
  migrateProposalStatuses() {
    const db = this.openDb()
    if (!db) return { migrated: 0, ids: [] }
    try {
      const rows = db.prepare("SELECT id FROM cognition_proposals WHERE status='denied' ORDER BY id").all()
      const ids = []
      for (const row of rows) {
        db.prepare("UPDATE cognition_proposals SET status='rejected' WHERE id=? AND status='denied'").run(row.id)
        ids.push(row.id)
        this.audit({ event: 'cognition.status.migrated', proposalId: row.id, from: 'denied', to: 'rejected' })
      }
      return { migrated: ids.length, ids }
    } catch (error) {
      this.warnBackend('migrateProposalStatuses', error)
      return { migrated: 0, ids: [] }
    }
  }

  entryRow(row) {
    if (!row) return null
    return {
      seq: row.seq, id: row.id, scope: row.scope, kind: row.kind, status: row.status,
      tags: JSON.parse(row.tags || '[]'), body: row.body, cause: row.cause,
      sources: sourcesOf(row), supersededBy: row.superseded_by || null,
      disputeReason: row.dispute_reason || null, createdBy: row.created_by,
      createdAt: row.created_at, updatedAt: row.updated_at, verifiedAt: row.verified_at || null,
    }
  }

  getEntry(id) {
    const wanted = entryText(id).trim()
    if (!wanted) return null
    const db = this.openDb()
    if (!db) return null
    try {
      return this.entryRow(db.prepare('SELECT * FROM cognition_entries WHERE id=?').get(wanted))
    } catch (error) {
      this.warnBackend('getEntry', error)
      return null
    }
  }

  /** Entry write primitive used by upsertEntry and accepted-proposal decisions. */
  writeEntry(db, value, now = Date.now()) {
    const tags = JSON.stringify(value.tags)
    const sources = JSON.stringify(value.sources)
    if (value.id) {
      const existing = db.prepare('SELECT * FROM cognition_entries WHERE id=?').get(value.id)
      if (!existing) return { ok: false, code: 'cognition_missing', message: 'entry not found: ' + value.id }
      const same = existing.scope === value.scope && existing.kind === value.kind && existing.status === value.status
        && existing.tags === tags && existing.body === value.body && existing.cause === value.cause && existing.sources === sources
      if (same) return { ok: true, entry: this.entryRow(existing), idempotent: true }
      db.prepare('UPDATE cognition_entries SET scope=?,kind=?,status=?,tags=?,body=?,cause=?,sources=?,updated_at=? WHERE id=?')
        .run(value.scope, value.kind, value.status, tags, value.body, value.cause, sources, now, value.id)
      return { ok: true, entry: this.entryRow(db.prepare('SELECT * FROM cognition_entries WHERE id=?').get(value.id)), idempotent: false }
    }
    const temporary = 'cog_tmp_' + randomUUID().replace(/-/g, '')
    const info = db.prepare('INSERT INTO cognition_entries(id,scope,kind,status,tags,body,cause,sources,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
      .run(temporary, value.scope, value.kind, value.status, tags, value.body, value.cause, sources, 'sage', now, now)
    const seq = Number(info.lastInsertRowid)
    const id = 'cog_' + seq
    db.prepare('UPDATE cognition_entries SET id=? WHERE seq=?').run(id, seq)
    return { ok: true, entry: this.entryRow(db.prepare('SELECT * FROM cognition_entries WHERE id=?').get(id)), created: true }
  }

  upsertEntry(input = {}) {
    const valid = normalizeEntryInput(input)
    if (!valid.ok) return valid
    const db = this.openDb()
    if (!db) return { ok: false, code: 'cognition_db_unavailable', message: 'cognition database unavailable: ' + this.dbPath }
    try {
      return transaction(db, () => this.writeEntry(db, valid.value, Date.now()))
    } catch (error) {
      this.warnBackend('upsertEntry', error)
      return { ok: false, code: 'cognition_db_error', message: String(error && error.message ? error.message : error) }
    }
  }

  searchEntries({ scopes, scope, tag, text: query, tags, limit = 8 } = {}) {
    const db = this.openDb()
    if (!db) return []
    try {
      const where = ["status IN ('active','disputed')"]
      const params = []
      const scopeList = Array.isArray(scopes) ? scopes.map(value => entryText(value).trim()).filter(Boolean) : []
      const singleScope = entryText(scope).trim()
      if (scopeList.length) { where.push('scope IN (' + scopeList.map(() => '?').join(',') + ')'); params.push(...scopeList) }
      else if (singleScope) { where.push('scope=?'); params.push(singleScope) }
      const wantedTags = Array.isArray(tags) ? tags.map(text).filter(Boolean) : (entryText(tag).trim() ? [entryText(tag).trim()] : [])
      for (const wanted of wantedTags) {
        where.push('EXISTS (SELECT 1 FROM json_each(cognition_entries.tags) WHERE value=?)')
        params.push(wanted)
      }
      const rows = db.prepare('SELECT * FROM cognition_entries WHERE ' + where.join(' AND ')).all(...params).map(row => this.entryRow(row))
      const cleanToken = token => token.replace(/[._#-]+$/g, '')
      const tokens = new Set([...tokenize(entryText(query))].map(cleanToken).filter(Boolean))
      const scored = rows.map(entry => {
        const haystack = new Set([...tokenize((entry.body || '') + ' ' + (entry.cause || '') + ' ' + entry.tags.join(' '))].map(cleanToken).filter(Boolean))
        let score = 0
        for (const token of tokens) if (haystack.has(token)) score += 1
        const tagHits = wantedTags.filter(t => entry.tags.includes(t)).length
        if (tagHits) score += tagHits * 2
        if (tokens.size && score === 0) return null
        if (String(entry.scope).startsWith('project:')) score += 0.5
        return { entry, score }
      }).filter(Boolean)
      scored.sort((a, b) => b.score - a.score || (String(a.entry.scope).startsWith('project:') ? -1 : 0) - (String(b.entry.scope).startsWith('project:') ? -1 : 0) || b.entry.updatedAt - a.entry.updatedAt || String(a.entry.id).localeCompare(String(b.entry.id)))
      const max = Number.isSafeInteger(limit) ? Math.max(1, Math.min(50, limit)) : 8
      return scored.slice(0, max).map(item => item.entry)
    } catch (error) {
      this.warnBackend('searchEntries', error)
      return []
    }
  }

  setEntryStatus(id, { status, reason = '', supersededBy = null } = {}) {
    const entryId = entryText(id).trim()
    const next = entryText(status).trim()
    if (!entryId) return { ok: false, code: 'cognition_invalid', field: 'id', message: 'id is required' }
    if (!COGNITION_STATUS.has(next)) return { ok: false, code: 'cognition_invalid', field: 'status', message: 'status must be active, disputed or retired' }
    const db = this.openDb()
    if (!db) return { ok: false, code: 'cognition_db_unavailable', message: 'cognition database unavailable: ' + this.dbPath }
    const now = Date.now()
    try {
      const info = db.prepare('UPDATE cognition_entries SET status=?,dispute_reason=?,superseded_by=?,updated_at=?,verified_at=? WHERE id=?')
        .run(next, next === 'active' ? null : text(reason), text(supersededBy) || null, now, next === 'active' ? now : null, entryId)
      if (!info.changes) return { ok: false, code: 'cognition_missing', message: 'entry not found: ' + entryId }
      return { ok: true, entry: this.getEntry(entryId) }
    } catch (error) {
      this.warnBackend('setEntryStatus', error)
      return { ok: false, code: 'cognition_db_error', message: String(error && error.message ? error.message : error) }
    }
  }

  upsertProject({ projectId, name, workspaces = [], overview = '', status = 'active' } = {}) {
    const id = entryText(projectId).trim()
    const title = entryText(name).trim()
    if (!id || !title) return { ok: false, code: 'cognition_invalid', field: !id ? 'projectId' : 'name', message: 'projectId and name are required' }
    if (!Array.isArray(workspaces) || workspaces.some(path => typeof path !== 'string' || !path.startsWith('/'))) return { ok: false, code: 'cognition_invalid', field: 'workspaces', message: 'workspaces must be absolute paths' }
    const body = String(overview || '')
    if ([...body].length > 1500) return { ok: false, code: 'cognition_invalid', field: 'overview', message: 'overview must be <= 1500 characters' }
    const db = this.openDb()
    if (!db) return { ok: false, code: 'cognition_db_unavailable', message: 'cognition database unavailable: ' + this.dbPath }
    try {
      const now = Date.now()
      db.prepare('INSERT INTO cognition_projects(project_id,name,workspaces,overview,status,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(project_id) DO UPDATE SET name=excluded.name,workspaces=excluded.workspaces,overview=excluded.overview,status=excluded.status,updated_at=excluded.updated_at')
        .run(id, title, JSON.stringify(workspaces), body, text(status) || 'active', now)
      return { ok: true, project: { projectId: id, name: title, workspaces, overview: body, status: text(status) || 'active', updatedAt: now } }
    } catch (error) {
      this.warnBackend('upsertProject', error)
      return { ok: false, code: 'cognition_db_error', message: String(error && error.message ? error.message : error) }
    }
  }

  summary() {
    const db = this.openDb()
    if (!db) return { ok: false, code: 'cognition_db_unavailable', message: 'cognition database unavailable: ' + this.dbPath }
    const rows = db.prepare('SELECT scope,status,COUNT(*) n FROM cognition_entries GROUP BY scope,status').all()
    const byScope = {}
    for (const row of rows) { byScope[row.scope] = byScope[row.scope] || {}; byScope[row.scope][row.status] = Number(row.n) }
    const projects = this.listProjects({ status: 'active' })
    const pending = Number(db.prepare("SELECT COUNT(*) n FROM cognition_proposals WHERE status='pending'").get().n)
    const disputed = db.prepare("SELECT id FROM cognition_entries WHERE status='disputed' ORDER BY id").all().map(row => row.id)
    return { ok: true, byScope, projects: projects.length, pendingProposals: pending, disputedEntries: disputed }
  }

  listProjects({ status = 'active', limit = 100 } = {}) {
    const db = this.openDb()
    if (!db) return []
    const max = Number.isSafeInteger(limit) ? Math.max(1, Math.min(200, limit)) : 100
    try {
      const rows = db.prepare('SELECT project_id,name,workspaces,overview,status,updated_at FROM cognition_projects WHERE status=? ORDER BY project_id LIMIT ?').all(text(status) || 'active', max)
      return rows.map(row => ({ projectId: row.project_id, name: row.name, workspaces: JSON.parse(row.workspaces || '[]'), overview: row.overview || '', status: row.status, updatedAt: row.updated_at }))
    } catch (error) {
      this.warnBackend('listProjects', error)
      return []
    }
  }

  resolveProjectsForWorkspace(workspacePath) {
    const target = entryText(workspacePath).trim()
    if (!target) return []
    const db = this.openDb()
    if (!db) return []
    let normalized
    try { normalized = realpathSync(resolve(target)) } catch { normalized = resolve(target) }
    try {
      const rows = db.prepare("SELECT project_id,name,workspaces,overview,status FROM cognition_projects WHERE status='active' ORDER BY project_id").all()
      return rows.filter(row => {
        let spaces = []
        try { spaces = JSON.parse(row.workspaces || '[]') } catch { return false }
        return Array.isArray(spaces) && spaces.some(space => {
          const raw = entryText(space).trim()
          if (!raw) return false
          let candidate
          try { candidate = realpathSync(resolve(raw)) } catch { candidate = resolve(raw) }
          return normalized === candidate || normalized.startsWith(candidate.endsWith(sep) ? candidate : candidate + sep)
        })
      }).map(row => ({ projectId: row.project_id, name: row.name, workspaces: JSON.parse(row.workspaces || '[]'), overview: row.overview || '', status: row.status }))
    } catch (error) {
      this.warnBackend('resolveProjectsForWorkspace', error)
      return []
    }
  }

  decideProposal(proposalId, { decision, decidedBy, rationale, targetEntryId, entry } = {}) {
    const id = entryText(proposalId).trim()
    const state = entryText(decision).trim()
    const who = entryText(decidedBy).trim()
    const why = entryText(rationale).trim()
    const target = entryText(targetEntryId).trim()
    if (!id) return { ok: false, code: 'proposal_id_required', message: 'proposalId is required' }
    if (!PROPOSAL_STATUS.has(state)) return { ok: false, code: 'proposal_decision_invalid', message: 'decision must be accepted, rejected, deferred or merged' }
    if (!who) return { ok: false, code: 'proposal_decider_required', message: 'decidedBy is required' }
    if (!why) return { ok: false, code: 'proposal_rationale_required', message: 'rationale is required' }
    if (state === 'merged' && !target) return { ok: false, code: 'proposal_target_required', message: 'targetEntryId is required for merged' }
    const normalizedEntry = entry ? normalizeEntryInput(entry) : null
    if (normalizedEntry && !normalizedEntry.ok) return normalizedEntry
    const db = this.openDb()
    if (!db) return { ok: false, code: 'cognition_db_unavailable', message: 'cognition database unavailable: ' + this.dbPath }
    try {
      const result = transaction(db, () => {
        const current = db.prepare('SELECT * FROM cognition_proposals WHERE id=?').get(id)
        if (!current) return { ok: false, code: 'proposal_missing', message: 'proposal not found: ' + id }
        const currentStatus = normalizeProposalStatus(current.status)
        if (currentStatus === state) {
          return { ok: true, proposal: this.proposalRow(current), receipt: this.receiptFromProposal(current), idempotent: true }
        }
        if (currentStatus !== 'pending') {
          return { ok: false, code: 'proposal_conflict', message: 'proposal already decided as ' + currentStatus, currentStatus }
        }
        if (state === 'merged') {
          const targetRow = db.prepare('SELECT id FROM cognition_entries WHERE id=?').get(target)
          if (!targetRow) return { ok: false, code: 'proposal_target_missing', message: 'target entry not found: ' + target, targetEntryId: target }
        }
        const at = Date.now()
        let writtenEntry = null
        if (state === 'accepted' && normalizedEntry) {
          const writeResult = this.writeEntry(db, normalizedEntry.value, at)
          if (!writeResult.ok) return writeResult
          writtenEntry = writeResult.entry
        }
        const linkedTarget = state === 'merged' ? target : (writtenEntry ? writtenEntry.id : (current.target_entry_id || null))
        db.prepare('UPDATE cognition_proposals SET status=?,target_entry_id=?,decided_by=?,decided_at=?,rationale=? WHERE id=?')
          .run(state, linkedTarget, who, at, why, id)
        const updated = db.prepare('SELECT * FROM cognition_proposals WHERE id=?').get(id)
        const receipt = this.receiptFromProposal(updated)
        return { ok: true, proposal: this.proposalRow(updated), receipt, ...(writtenEntry ? { entry: writtenEntry } : {}), idempotent: false }
      })
      if (result.ok && !result.idempotent) {
        if (!result.receipt || result.receipt.evidenceRefs.length === 0) this.log('warn', 'cognition receipt for ' + id + ' has no evidenceRefs')
        try { this.audit({ event: 'cognition.receipt.written', proposalId: id, decision: state, decidedBy: who, receipt: result.receipt }) } catch (error) { this.log('warn', 'could not audit cognition receipt: ' + String(error && error.message ? error.message : error)) }
        try { this.audit({ event: 'cognition.proposal.decided', proposalId: id, decision: state, decidedBy: who, targetEntryId: result.proposal ? result.proposal.targetEntryId : null }) } catch (error) { this.log('warn', 'could not audit cognition proposal decision: ' + String(error && error.message ? error.message : error)) }
      }
      return result
    } catch (error) {
      this.warnBackend('decideProposal', error)
      return { ok: false, code: 'cognition_db_error', message: String(error && error.message ? error.message : error) }
    }
  }

  principlesSummary(maxChars = 1500) {
    const principles = this.searchEntries({ scopes: ['principle'], limit: 20 })
    if (!principles.length) return ''
    return clip(principles.map(item => '- [' + item.id + '] ' + item.body).join('\n'), maxChars)
  }

  retrieve({ workspace, goal, tags = [] } = {}) {
    const db = this.openDb()
    const key = projectKey(workspace)
    if (!db) return { snapshot: '', files: [], degraded: true, code: 'cognition_db_unavailable', budget: { total: MAX_TOTAL }, projectKey: key, goal: text(goal) }
    const projects = this.resolveProjectsForWorkspace(workspace)
    const scopes = [...projects.map(project => 'project:' + project.projectId), 'global', 'principle', ...(Array.isArray(tags) ? tags.map(tag => 'domain:' + text(tag)).filter(Boolean) : [])]
    const principles = this.searchEntries({ scopes: ['principle'], limit: 20 })
    const candidates = this.searchEntries({ scopes, text: entryText(goal), tags, limit: 8 })
    const sections = []
    if (principles.length) sections.push('[Principles]\n' + clip(principles.map(item => '- [' + item.id + '] ' + item.body).join('\n'), 1500))
    if (projects.length) sections.push('[Project Overview]\n' + clip(projects.map(project => '- ' + project.name + ' (' + project.projectId + ') | workspaces: ' + project.workspaces.join(', ') + ' | ' + project.overview).join('\n'), 2000))
    if (candidates.length) sections.push('[Candidate Experience]\n' + clip(candidates.map(item => '- [' + item.id + '] (' + item.scope + ') ' + item.body + (item.cause ? ' — ' + item.cause : '') + (item.status === 'disputed' ? ' [待核实]' : '')).join('\n'), 2500))
    let snapshot = sections.join('\n\n')
    if (snapshot.length > MAX_TOTAL) snapshot = snapshot.slice(0, MAX_TOTAL) + '\n…（认知快照已截断）'
    return { snapshot, files: projects.map(project => 'project:' + project.projectId), degraded: false, budget: { total: MAX_TOTAL }, projectKey: key, goal: text(goal) }
  }

  /**
   * Chat memory digest bounded by MAX_DIGEST including the truncation marker.
   */
  chatDigest() {
    const db = this.openDb()
    if (!db) return { text: '', degraded: true, truncated: false, code: 'cognition_db_unavailable' }
    try {
      const rows = db.prepare("SELECT id,body FROM cognition_entries WHERE status='active' AND scope IN ('user:preference','user:agreement') ORDER BY updated_at DESC, id ASC").all()
      if (!rows.length) return { text: '', degraded: false, truncated: false }
      const full = '长期记忆，仅供参考，当前用户消息优先。\n' + rows.map(row => '- [' + row.id + '] ' + String(row.body).replace(/\s+/g, ' ').trim()).join('\n')
      if (full.length <= MAX_DIGEST) return { text: full, degraded: false, truncated: false }
      const marker = '\n…（已截断）'
      return { text: full.slice(0, MAX_DIGEST - marker.length) + marker, degraded: false, truncated: true }
    } catch (error) {
      this.warnBackend('chatDigest', error)
      return { text: '', degraded: true, truncated: false, code: 'cognition_db_error' }
    }
  }

  normalizeProposalScope(rawScope) {
    const raw = text(rawScope)
    if (!raw) return 'global'
    if (isValidScope(raw)) return raw
    if (raw.startsWith('/')) {
      const matched = this.resolveProjectsForWorkspace(raw)
      if (matched.length) return 'project:' + matched[0].projectId
    }
    const slug = raw.toLowerCase().replace(/^project:/, '').split('/')[0].replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')
    if (slug && this.listProjects({ status: 'active' }).some(p => p.projectId === slug)) return 'project:' + slug
    return raw
  }

  propose({ author, source, kind = 'add', targetEntryId = null, ticketId = '', scope = 'global', body: proposalBody, text: bodyText, cause = '', sources = [], evidence = [], priority = 'normal' } = {}) {
    const who = normalizeProposalAuthor(author, { warn: message => this.log('warn', message) })
    const proposalKind = text(kind) || 'add'
    if (!['add', 'correct', 'retire'].includes(proposalKind)) throw Object.assign(new Error('kind must be add, correct or retire'), { code: 'proposal_kind_invalid' })
    const target = text(targetEntryId)
    if (target && !/^cog_\d+$/.test(target)) throw Object.assign(new Error('targetEntryId must match cog_<numeric>'), { code: 'proposal_target_invalid' })
    const body = text(proposalBody ?? bodyText)
    if (!body) throw Object.assign(new Error('proposal text is required'), { code: 'proposal_empty' })
    const rawSources = Array.isArray(sources) && sources.length
      ? sources
      : (Array.isArray(evidence) ? evidence.map(ref => ({ type: 'file', ref: String(ref) })) : [])
    const normalizedSources = rawSources.slice(0, 10).map(source => {
      if (typeof source === 'string') return { type: 'file', ref: source }
      const type = text(source && source.type) || 'file'
      const ref = text(source && source.ref)
      return { type, ref, ...(Number.isFinite(source && source.at) ? { at: source.at } : {}) }
    }).filter(source => source.ref)
    const id = 'prop_' + Date.now().toString(36) + '_' + randomUUID().replace(/-/g, '').slice(0, 8)
    const db = this.openDb()
    if (!db) throw Object.assign(new Error('cognition database unavailable: ' + this.dbPath), { code: 'cognition_db_unavailable' })
    const resolvedScope = this.normalizeProposalScope(scope)
    const resolvedPriority = who === 'user' ? 'high' : (['high', 'normal', 'low'].includes(text(priority)) ? text(priority) : 'normal')
    const at = Date.now()
    db.prepare('INSERT INTO cognition_proposals(id,author,source,kind,scope,target_entry_id,ticket_id,body,cause,sources,priority,status,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(id, who, text(source) || who, proposalKind, resolvedScope, target || null, text(ticketId) || null, body, text(cause), JSON.stringify(normalizedSources), resolvedPriority, 'pending', at)
    const proposal = this.proposalRow(db.prepare('SELECT * FROM cognition_proposals WHERE id=?').get(id))
    proposal.text = proposal.body
    proposal.evidence = normalizedSources.map(source => source.ref)
    this.audit({ event: 'cognition.proposal', proposalId: id, author: proposal.author, scope: proposal.scope, priority: proposal.priority, ticketId: proposal.ticketId })
    return proposal
  }

  listProposals() {
    const db = this.openDb()
    if (!db) return []
    try {
      return db.prepare("SELECT * FROM cognition_proposals WHERE status='pending' ORDER BY CASE priority WHEN 'high' THEN 0 ELSE 1 END, created_at DESC, id ASC").all().map(row => this.proposalRow(row))
    } catch (error) {
      this.warnBackend('listProposals', error)
      return []
    }
  }
}
