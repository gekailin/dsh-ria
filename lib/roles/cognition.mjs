import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { writeAtomic as atomicWrite } from '../shared/fs.mjs'
import { join, relative, resolve, sep } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { openDatabase, transaction } from '../state/sqlite/db.mjs'
import { tokenize } from '../store/lessons.mjs'

const MAX_READ = 64 * 1024
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

const entryError = (field, message) => ({ ok: false, code: 'cognition_invalid', field, message })
const entryText = value => typeof value === 'string' ? value : ''
const entryLength = value => [...String(value)].length

function normalizeEntryInput(raw = {}) {
  const scope = entryText(raw.scope).trim()
  const body = entryText(raw.body)
  const cause = entryText(raw.cause)
  const tags = Array.isArray(raw.tags) ? raw.tags.map(value => entryText(value).trim()).filter(Boolean).slice(0, 12) : []
  const sources = Array.isArray(raw.sources) ? raw.sources : null
  if (!scope) return entryError('scope', 'scope is required')
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
  constructor({ stateDir, dbPath = null, log = () => {}, audit = () => {} } = {}) {
    if (!stateDir) throw new Error('CognitionStore requires stateDir')
    this.stateDir = stateDir
    this.base = join(stateDir, 'cognition')
    this.dbPath = dbPath || join(stateDir, 'ria.sqlite')
    this.db = null
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
      return this.db
    } catch (error) {
      this.dbFailed = true
      this.dbError = { code: 'cognition_db_unavailable', message: 'cognition database unavailable: ' + this.dbPath + ' (' + String(error && error.message ? error.message : error) + ')' }
      this.log('warn', this.dbError.message)
      return null
    }
  }

  warnBackend(action, error) {
    this.log('warn', 'cognition sqlite ' + action + ' failed: ' + String(error && error.message ? error.message : error))
  }

  proposalRow(row) {
    if (!row) return null
    return {
      id: row.id, author: row.author || 'reflection', source: row.source, kind: row.kind, scope: row.scope,
      targetEntryId: row.target_entry_id || null, ticketId: row.ticket_id || null,
      body: row.body, cause: row.cause || '', sources: JSON.parse(row.sources || '[]'),
      priority: row.priority, status: normalizeProposalStatus(row.status),
      decidedBy: row.decided_by || null, decidedAt: row.decided_at || null,
      rationale: row.rationale || null, createdAt: row.created_at,
    }
  }

  receiptRow(row) {
    if (!row) return null
    return {
      proposalId: row.proposal_id, decision: row.decision, rationale: row.rationale,
      decidedBy: row.decided_by, decidedAt: row.decided_at,
      evidenceRefs: JSON.parse(row.evidence_refs || '[]'),
      affectedEntries: JSON.parse(row.affected_entries || '[]'),
    }
  }

  getReceipt(proposalId) {
    const id = entryText(proposalId).trim()
    if (!id) return null
    const db = this.openDb()
    if (!db) return null
    try { return this.receiptRow(db.prepare('SELECT * FROM cognition_receipts WHERE proposal_id=?').get(id)) } catch (error) {
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
   * One-way, idempotent Phase-1.2 compatibility migration: denied -> rejected.
   * Each row actually changed produces one cognition.status.migrated event;
   * a second run finds no denied rows and emits nothing.
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
      recorded: row.recorded || null, truncated: Boolean(row.truncated),
      sources: JSON.parse(row.sources || '[]'), supersededBy: row.superseded_by || null,
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
    const existing = value.id ? db.prepare('SELECT * FROM cognition_entries WHERE id=?').get(value.id) : null
    if (existing) {
      const same = existing.scope === value.scope && existing.kind === value.kind && existing.status === value.status
        && existing.tags === tags && existing.body === value.body && existing.cause === value.cause && existing.sources === sources
      if (same) return { ok: true, entry: this.entryRow(existing), idempotent: true }
      db.prepare('UPDATE cognition_entries SET scope=?,kind=?,status=?,tags=?,body=?,cause=?,sources=?,updated_at=? WHERE id=?')
        .run(value.scope, value.kind, value.status, tags, value.body, value.cause, sources, now, value.id)
      return { ok: true, entry: this.entryRow(db.prepare('SELECT * FROM cognition_entries WHERE id=?').get(value.id)), idempotent: false }
    }
    if (value.id) {
      db.prepare('INSERT INTO cognition_entries(id,scope,kind,status,tags,body,cause,sources,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
        .run(value.id, value.scope, value.kind, value.status, tags, value.body, value.cause, sources, 'sage', now, now)
      return { ok: true, entry: this.entryRow(db.prepare('SELECT * FROM cognition_entries WHERE id=?').get(value.id)), created: true }
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
      for (const wanted of wantedTags) { where.push('tags LIKE ?'); params.push('%"' + wanted + '"%') }
      const rows = db.prepare('SELECT * FROM cognition_entries WHERE ' + where.join(' AND ')).all(...params).map(row => this.entryRow(row))
      const cleanToken = token => token.replace(/[._#-]+$/g, '')
      const tokens = new Set([...tokenize(entryText(query))].map(cleanToken).filter(Boolean))
      const scored = rows.map(entry => {
        const haystack = new Set([...tokenize(entry.body + ' ' + entry.cause + ' ' + entry.tags.join(' '))].map(cleanToken).filter(Boolean))
        let score = 0
        for (const token of tokens) if (haystack.has(token)) score += 1
        const tagHits = wantedTags.filter(tag => entry.tags.includes(tag)).length
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

  listProjects({ status = 'active' } = {}) {
    const db = this.openDb()
    if (!db) return []
    try {
      const rows = db.prepare('SELECT project_id,name,workspaces,overview,status,updated_at FROM cognition_projects WHERE status=? ORDER BY project_id LIMIT 10').all(text(status) || 'active')
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
          return { ok: true, proposal: this.proposalRow(current), receipt: this.getReceipt(id), idempotent: true }
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
          writtenEntry = this.writeEntry(db, normalizedEntry.value, at).entry
        }
        db.prepare('UPDATE cognition_proposals SET status=?,target_entry_id=?,decided_by=?,decided_at=?,rationale=? WHERE id=?')
          .run(state, state === 'merged' ? target : null, who, at, why, id)
        let evidenceRefs = []
        try {
          const sources = JSON.parse(current.sources || '[]')
          evidenceRefs = (Array.isArray(sources) ? sources : []).slice(0, 20).map(source => ({
            type: entryText(source && source.type).trim() || 'file',
            ref: entryText(source && source.ref).trim(),
            ...(Number.isFinite(source && source.at) ? { at: source.at } : {}),
          })).filter(source => source.ref)
        } catch { evidenceRefs = [] }
        const affectedEntries = state === 'merged' ? [target] : (writtenEntry ? [writtenEntry.id] : [])
        const receipt = {
          proposalId: id, decision: state, rationale: why, decidedBy: who, decidedAt: at,
          evidenceRefs, affectedEntries,
        }
        db.prepare('INSERT INTO cognition_receipts(proposal_id,decision,rationale,decided_by,decided_at,evidence_refs,affected_entries,created_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(proposal_id) DO UPDATE SET decision=excluded.decision,rationale=excluded.rationale,decided_by=excluded.decided_by,decided_at=excluded.decided_at,evidence_refs=excluded.evidence_refs,affected_entries=excluded.affected_entries')
          .run(id, state, why, who, at, JSON.stringify(evidenceRefs), JSON.stringify(affectedEntries), at)
        return { ok: true, proposal: this.proposalRow(db.prepare('SELECT * FROM cognition_proposals WHERE id=?').get(id)), receipt, ...(writtenEntry ? { entry: writtenEntry } : {}), idempotent: false }
      })
      if (result.ok && !result.idempotent) {
        if (!result.receipt || result.receipt.evidenceRefs.length === 0) this.log('warn', 'cognition receipt for ' + id + ' has no evidenceRefs')
        try { this.audit({ event: 'cognition.receipt.written', proposalId: id, decision: state, decidedBy: who, receipt: result.receipt }) } catch (error) { this.log('warn', 'could not audit cognition receipt: ' + String(error && error.message ? error.message : error)) }
        try { this.audit({ event: 'cognition.proposal.decided', proposalId: id, decision: state, decidedBy: who, targetEntryId: state === 'merged' ? target : null }) } catch (error) { this.log('warn', 'could not audit cognition proposal decision: ' + String(error && error.message ? error.message : error)) }
      }
      return result
    } catch (error) {
      this.warnBackend('decideProposal', error)
      return { ok: false, code: 'cognition_db_error', message: String(error && error.message ? error.message : error) }
    }
  }

  ensure() {
    mkdirSync(this.base, { recursive: true, mode: 0o700 })
    for (const dir of ['projects', 'chat', 'proposals']) mkdirSync(join(this.base, dir), { recursive: true, mode: 0o700 })
    let created = false
    for (const file of ['principles.md', 'INDEX.md', 'chat/preferences.md', 'chat/agreements.md', 'chat/decisions.md']) {
      const path = join(this.base, file)
      if (!existsSync(path)) {
        atomicWrite(path, '')
        created = true
      }
    }
    if (created || !existsSync(join(this.base, 'INDEX.md'))) this.updateIndex()
    return this
  }

  safePath(relPath) {
    const raw = String(relPath == null ? '' : relPath).trim()
    if (!raw || raw.startsWith('/') || raw.includes('\u0000')) throw Object.assign(new Error('invalid cognition path'), { code: 'cognition_path_invalid' })
    const full = resolve(this.base, raw)
    const rel = relative(this.base, full)
    if (!rel || rel.startsWith('..') || rel.includes('..' + sep) || rel.startsWith(sep)) {
      throw Object.assign(new Error('cognition path escapes the store'), { code: 'cognition_path_invalid' })
    }
    return full
  }

  read(relPath = 'INDEX.md') {
    const full = this.safePath(relPath)
    if (!existsSync(full)) throw Object.assign(new Error('cognition file not found: ' + relPath), { code: 'cognition_missing' })
    const content = readFileSync(full, 'utf8')
    return content.length > MAX_READ ? content.slice(0, MAX_READ) : content
  }

  write(relPath, content, { mode = 'replace', reason = '', source = 'sage' } = {}) {
    const rel = String(relPath || '').trim()
    if (rel === 'INDEX.md' || rel.startsWith('proposals/')) throw Object.assign(new Error('INDEX.md and proposals/ are managed'), { code: 'cognition_path_reserved' })
    const full = this.safePath(rel)
    const body = String(content == null ? '' : content)
    if (body.length > MAX_READ) throw Object.assign(new Error('cognition file too large'), { code: 'cognition_too_large' })
    let next = body
    if (mode === 'append') {
      const previous = existsSync(full) ? readFileSync(full, 'utf8') : ''
      next = previous + (previous && !previous.endsWith('\n') ? '\n' : '') + body
      if (next.length > MAX_READ) throw Object.assign(new Error('cognition file too large after append'), { code: 'cognition_too_large' })
    }
    atomicWrite(full, next)
    const before = this.indexVersion()
    this.updateIndex()
    const version = this.indexVersion()
    this.audit({ event: 'cognition.write', path: rel, mode, reason: text(reason), source: text(source) || 'sage', bytes: Buffer.byteLength(next) })
    if (version !== before) {
      const changedAt = new Date().toISOString()
      const changedFiles = [rel, 'INDEX.md']
      this.audit({ event: 'cognition.index.changed', payload: { version, changedFiles, timestamp: changedAt } })
      try { if (typeof this.onIndexChanged === 'function') this.onIndexChanged({ version, changedFiles, timestamp: changedAt }) } catch { /* notification never blocks writes */ }
    }
    return { ok: true, path: rel, bytes: Buffer.byteLength(next), mode }
  }

  listFiles(dir = this.base, prefix = '') {
    const out = []
    for (const name of readdirSync(dir).sort()) {
      if (name === 'INDEX.md' || name.startsWith('.')) continue
      const full = join(dir, name)
      const rel = prefix ? prefix + '/' + name : name
      const stat = statSync(full)
      if (stat.isDirectory()) {
        if (name === 'proposals') continue
        out.push(...this.listFiles(full, rel))
      } else if (stat.isFile()) out.push({ path: rel, bytes: stat.size, updatedAt: stat.mtimeMs })
    }
    return out
  }

  updateIndex() {
    mkdirSync(this.base, { recursive: true, mode: 0o700 })
    const files = this.listFiles()
    const lessonsFile = join(this.stateDir, 'lessons.json')
    if (existsSync(lessonsFile)) {
      try {
        const stat = statSync(lessonsFile)
        files.push({ path: 'lessons.json (external)', bytes: stat.size, updatedAt: stat.mtimeMs })
      } catch { /* ignore */ }
    }
    const lines = ['# Cognition Index', '', 'Sage-owned memory. Advisors read snapshots; Chat reads a digest.', '', '| File | Bytes | Updated |', '|---|---:|---|']
    for (const file of files) lines.push('| ' + file.path + ' | ' + file.bytes + ' | ' + new Date(file.updatedAt || Date.now()).toISOString() + ' |')
    atomicWrite(join(this.base, 'INDEX.md'), lines.join('\n') + '\n')
  }

  readIfExists(relPath) {
    try { return this.read(relPath) } catch { return '' }
  }

  retrieve({ workspace, goal, tags = [], lessons = [] } = {}) {
    const db = this.openDb()
    const key = projectKey(workspace)
    if (!db) return { snapshot: '', files: [], degraded: true, code: 'cognition_db_unavailable', budget: { total: MAX_TOTAL }, projectKey: key, goal: text(goal) }
    const projects = this.resolveProjectsForWorkspace(workspace)
    const scopes = [...projects.map(project => 'project:' + project.projectId), 'global', 'principle', ...(Array.isArray(tags) ? tags.map(tag => 'domain:' + text(tag)).filter(Boolean) : [])]
    const principles = this.searchEntries({ scopes: ['principle'], limit: 20 })
    const candidates = this.searchEntries({ scopes, text: entryText(goal), tags, limit: 8 })
    let principlesFallback = ''
    if (!principles.length) {
      try { principlesFallback = String(this.readIfExists('principles.md') || '').trim() } catch { /* DB is authoritative; a missing file is empty */ }
    }
    const sections = []
    if (principles.length) sections.push('[Principles]\n' + clip(principles.map(item => '- [' + item.id + '] ' + item.body).join('\n'), 1500))
    else if (principlesFallback) sections.push('[Principles]\n' + clip(principlesFallback, 1500))
    if (projects.length) sections.push('[Project Overview]\n' + clip(projects.map(project => '- ' + project.name + ' (' + project.projectId + ') | workspaces: ' + project.workspaces.join(', ') + ' | ' + project.overview).join('\n'), 2000))
    if (candidates.length) sections.push('[Candidate Experience]\n' + clip(candidates.map(item => '- [' + item.id + '] (' + item.scope + ') ' + item.body + (item.cause ? ' — ' + item.cause : '') + (item.status === 'disputed' ? ' [待核实]' : '')).join('\n'), 2500))
    let snapshot = sections.join('\n\n')
    if (snapshot.length > MAX_TOTAL) snapshot = snapshot.slice(0, MAX_TOTAL) + '\n…（认知快照已截断）'
    return { snapshot, files: projects.map(project => 'project:' + project.projectId), degraded: false, budget: { total: MAX_TOTAL }, projectKey: key, goal: text(goal) }
  }

  /**
   * Chat memory digest. The text is bounded by MAX_DIGEST including the
   * truncation marker, and degraded reports a file that was missing or
   * unreadable (the caller renders a placeholder instead of failing the turn).
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

  indexVersion() {
    try {
      return createHash('sha256').update(this.readIfExists('INDEX.md')).digest('hex').slice(0, 16)
    } catch { return '' }
  }

  indexDigest() {
    this.ensure()
    return clip(this.readIfExists('INDEX.md'), MAX_DIGEST)
  }

  sageIndexSnapshot(maxChars = 2000) {
    this.ensure()
    const entries = []
    for (const file of this.listFiles()) {
      let summary = ''
      let version = ''
      try {
        const content = this.readIfExists(file.path)
        const first = content.split('\n').map(line => line.trim()).find(line => line && !line.startsWith('#')) || ''
        summary = clip(first, 160)
        version = createHash('sha1').update(content).digest('hex').slice(0, 8)
      } catch { /* keep empty summary */ }
      entries.push({ path: file.path, summary, version, updatedAt: file.updatedAt })
    }
    const render = detailed => {
      const lines = ['[cognition INDEX 快照]', 'INDEX 可能滞后；以实际文件为准，需要最新内容用 ria_sage_read。']
      for (const entry of entries) {
        if (!detailed) lines.push('- ' + entry.path)
        else lines.push('- ' + entry.path + ' — ' + (entry.summary || '（无摘要）') + ' (v:' + (entry.version || '?') + ', ' + new Date(entry.updatedAt || Date.now()).toISOString() + ')')
      }
      return lines.join('\n')
    }
    let text = render(true)
    if (text.length > maxChars) text = render(false)
    if (text.length > maxChars) text = clip(text, maxChars)
    return { text, truncated: text.length > maxChars, files: entries.map(item => item.path) }
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
    const at = Date.now()
    db.prepare('INSERT INTO cognition_proposals(id,author,source,kind,scope,target_entry_id,ticket_id,body,cause,sources,priority,status,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(id, who, text(source) || who, proposalKind, text(scope) || 'global', target || null, text(ticketId) || null, body, text(cause), JSON.stringify(normalizedSources), who === 'user' ? 'high' : (text(priority) || 'normal'), 'pending', at)
    const proposal = this.proposalRow(db.prepare('SELECT * FROM cognition_proposals WHERE id=?').get(id))
    proposal.text = proposal.body
    proposal.evidence = normalizedSources.map(source => source.ref)
    this.audit({ event: 'cognition.proposal', proposalId: id, author: proposal.author, scope: proposal.scope, priority: proposal.priority, ticketId: proposal.ticketId })
    return proposal
  }

  listProposals() {
    const db = this.openDb()
    if (db) {
      try {
        return db.prepare("SELECT * FROM cognition_proposals WHERE status='pending' ORDER BY CASE priority WHEN 'high' THEN 0 ELSE 1 END, created_at DESC, id ASC").all().map(row => this.proposalRow(row))
      } catch (error) { this.warnBackend('listProposals', error) }
    }
    // Legacy proposal files remain a read-only compatibility source; entries
    // themselves never fall back to Markdown.
    this.ensure()
    const dir = join(this.base, 'proposals')
    const out = []
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.json')) continue
      try {
        const item = JSON.parse(readFileSync(join(dir, name), 'utf8'))
        if (item && item.status === 'pending') out.push({ ...item, author: item.author || 'reflection' })
      } catch { /* ignore corrupt */ }
    }
    return out.sort((a, b) => (a.priority === 'high' ? -1 : 0) - (b.priority === 'high' ? -1 : 0) || b.createdAt - a.createdAt)
  }

  resolveProposal(id, status = 'accepted') {
    const full = join(this.base, 'proposals', String(id) + '.json')
    if (!existsSync(full)) throw Object.assign(new Error('proposal not found'), { code: 'proposal_missing' })
    const item = JSON.parse(readFileSync(full, 'utf8'))
    item.status = status
    item.reviewedAt = Date.now()
    atomicWrite(full, JSON.stringify(item, null, 2) + '\n')
    this.audit({ event: 'cognition.proposal-' + status, proposalId: item.id, author: item.author })
    return item
  }
}
