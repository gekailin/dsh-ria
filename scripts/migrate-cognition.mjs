#!/usr/bin/env node
// Phase 3 cognition migration: Markdown/proposals -> cognition SQLite.
//
// Default is dry-run. --apply backs up cognition/ + SQLite before writing.
// Stable entry id = cog_md_<sha256(scope + NUL + normalized body)[0..24]>;
// proposals keep their existing id (or a path/content hash when absent).
// Existing ids are never overwritten, so repeated --apply is idempotent and
// rollback only deletes rows inserted by the recorded migration run.

import { createHash, randomUUID } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { openDatabase, transaction } from '../lib/state/sqlite/db.mjs'

const sha = value => createHash('sha256').update(String(value)).digest('hex')
const text = value => typeof value === 'string' ? value.trim() : ''
const normalizeBody = value => text(value).replace(/\s+/g, ' ').toLowerCase()
const stamp = at => new Date(Number(at) || Date.now()).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')
const ENTRY_LIMIT = 250
const CAUSE_LIMIT = 600
const PROPOSAL_STATUS = new Set(['accepted', 'rejected', 'deferred', 'merged', 'pending'])

function parseArgs(argv = []) {
  const out = { stateDir: process.env.RIA_STATE_DIR || join(homedir(), '.dsh', 'state', 'ria'), sample: 10, mode: 'dry-run' }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--apply') out.mode = 'apply'
    else if (arg === '--rollback') out.mode = 'rollback'
    else if (arg === '--dry-run') out.mode = 'dry-run'
    else if (arg === '--state-dir') out.stateDir = argv[++index]
    else if (arg === '--cognition-dir') out.cognitionDir = argv[++index]
    else if (arg === '--db') out.dbPath = argv[++index]
    else if (arg === '--sample') out.sample = Number(argv[++index])
    else if (arg === '--strict') out.strict = true
    else throw new Error('Unknown argument: ' + arg)
  }
  out.stateDir = resolve(out.stateDir)
  out.cognitionDir = out.cognitionDir ? resolve(out.cognitionDir) : join(out.stateDir, 'cognition')
  out.dbPath = out.dbPath ? resolve(out.dbPath) : join(out.stateDir, 'ria.sqlite')
  out.sample = Number.isSafeInteger(out.sample) && out.sample > 0 ? Math.min(50, out.sample) : 10
  return out
}

function scopeFor(rel) {
  if (rel === 'chat/preferences.md') return 'user:preference'
  if (rel === 'chat/agreements.md') return 'user:agreement'
  if (rel === 'chat/decisions.md' || rel === 'principles.md' || rel === 'chat/principles.md') return 'global'
  if (rel.startsWith('projects/') && rel.endsWith('.md')) return 'project:' + rel.slice('projects/'.length, -3)
  return 'global'
}

function kindFor(scope) {
  if (scope === 'user:preference') return 'preference'
  if (scope === 'user:agreement') return 'agreement'
  return 'experience'
}

function sectionsOf(lines) {
  const starts = []
  for (let index = 0; index < lines.length; index += 1) {
    if (/^#{1,6}\s+/.test(lines[index])) starts.push(index)
  }
  if (!starts.length) return [{ start: 0, end: lines.length, heading: '', line: 1 }]
  return starts.map((start, index) => ({
    start, end: index + 1 < starts.length ? starts[index + 1] : lines.length,
    heading: lines[start].replace(/^#{1,6}\s+/, '').trim(), line: start + 1,
  }))
}

function readMarkdownEntries(file, cognitionDir, { strict = false } = {}) {
  const rel = relative(cognitionDir, file).split(sep).join('/')
  const lines = readFileSync(file, 'utf8').split(/\r?\n/)
  const mtime = statSync(file).mtimeMs
  const entries = []
  const skipped = []
  for (const section of sectionsOf(lines)) {
    const bodyLines = []
    const causeLines = []
    const extraSources = []
    for (const line of lines.slice(section.start + (section.heading ? 1 : 0), section.end)) {
      const cause = line.match(/^(?:-\s*)?(?:原因|背景|为什么|cause|坑)\s*[:：]\s*(.+)$/i)
      const practice = line.match(/^(?:-\s*)?(?:做法|建议改法)\s*[:：]\s*(.+)$/i)
      const ticket = line.match(/^(?:-\s*)?(?:来源工单|source ticket)\s*[:：]\s*(.+)$/i)
      const evidence = /^(?:-\s*)?(?:证据|evidence)\s*[:：]/i.test(line)
      if (/^<!--.*-->$/.test(line.trim())) continue
      if (cause) causeLines.push(cause[1].trim())
      else if (practice) bodyLines.push(practice[1].trim())
      else if (ticket) extraSources.push({ type: 'ticket', ref: ticket[1].trim() })
      else if (!evidence) bodyLines.push(line)
    }
    let body = bodyLines.join('\n').trim()
    let cause = causeLines.join(' ').trim()
    let truncated = false
    const scope = scopeFor(rel)
    const at = Number.isFinite(Date.parse(String(section.heading).match(/(20\d\d[-/]\d{1,2}[-/]\d{1,2})/)?.[1]?.replace(/\//g, '-') || ''))
      ? Date.parse(String(section.heading).match(/(20\d\d[-/]\d{1,2}[-/]\d{1,2})/)[1].replace(/\//g, '-'))
      : mtime
    if (!body) {
      // A bare document title is not a cognition entry; do not count it as a
      // skipped candidate. Only a real section with no body is unimportable.
      if (section.start === 0 && /^#\s/.test(lines[section.start] || '')) continue
      skipped.push({ kind: 'entry', file: rel, line: section.line, missing: ['body'], reason: 'body_empty' })
      continue
    }
    if ([...body].length > ENTRY_LIMIT) {
      if (strict) {
        skipped.push({ kind: 'entry', file: rel, line: section.line, missing: ['body'], reason: 'body_too_long' })
        continue
      }
      body = [...body].slice(0, ENTRY_LIMIT).join('')
      truncated = true
    }
    // Cause is optional in lenient mode: use an explicit cause first, then the
    // section heading as derived context; otherwise persist null + partial.
    if (!cause && !strict && section.heading && !/^(preferences|agreements|decisions|principles|todos?)$/i.test(section.heading)) {
      cause = '来自小节：' + section.heading
    }
    if (!cause && strict) {
      skipped.push({ kind: 'entry', file: rel, line: section.line, missing: ['cause'], reason: 'four_elements_incomplete' })
      continue
    }
    if (cause && [...cause].length > CAUSE_LIMIT) cause = [...cause].slice(0, CAUSE_LIMIT).join('')
    if (!cause) cause = null
    const sources = [{ type: 'file', ref: rel + ':' + section.line, at: Number.isFinite(at) ? at : mtime }, ...extraSources]
    // A file + line + mtime source is always available as the fallback.
    if (!sources.length) sources.push({ type: 'file', ref: rel + ':' + section.line, at: mtime })
    const recorded = cause ? 'complete' : 'partial'
    const id = 'cog_md_' + sha(scope + '\u0000' + normalizeBody(body)).slice(0, 24)
    entries.push({
      id, scope, kind: kindFor(scope), status: 'active', tags: [], body, cause, recorded, truncated,
      sources, createdAt: at, updatedAt: at, raw: { file: rel, line: section.line },
    })
  }
  return { entries, skipped }
}

function walkJson(dir) {
  if (!existsSync(dir)) return []
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walkJson(full))
    else if (entry.name.endsWith('.json')) out.push(full)
  }
  return out.sort()
}

function readProposals(cognitionDir) {
  const proposals = []
  const skipped = []
  const seen = new Set()
  for (const file of walkJson(join(cognitionDir, 'proposals'))) {
    const rel = relative(cognitionDir, file).split(sep).join('/')
    let raw
    try { raw = JSON.parse(readFileSync(file, 'utf8')) } catch { skipped.push({ kind: 'proposal', file: rel, reason: 'invalid_json' }); continue }
    const id = text(raw.id)
    const body = text(raw.body || raw.text || raw.title)
    const status = text(raw.status)
    const mapped = status === 'denied' ? 'rejected' : status
    if (!id || !body) { skipped.push({ kind: 'proposal', file: rel, id, missing: [!id ? 'id' : null, !body ? 'body' : null].filter(Boolean), reason: 'required_fields_missing' }); continue }
    if (!PROPOSAL_STATUS.has(mapped)) { skipped.push({ kind: 'proposal', file: rel, id, reason: 'unknown_status:' + status }); continue }
    if (seen.has(id)) { skipped.push({ kind: 'proposal', file: rel, id, reason: 'duplicate_id' }); continue }
    seen.add(id)
    const sources = Array.isArray(raw.sources) ? raw.sources : (Array.isArray(raw.evidence) ? raw.evidence.map(ref => ({ type: 'file', ref: String(ref) })) : [])
    proposals.push({
      id, author: text(raw.author) || 'reflection', source: text(raw.source) || 'cognition/proposals',
      kind: text(raw.kind) || 'add', scope: text(raw.scope) || 'global', targetEntryId: text(raw.targetEntryId) || null,
      ticketId: text(raw.ticketId) || null, body, cause: text(raw.cause) || '',
      sources, priority: text(raw.priority) || 'normal', status: mapped,
      decidedBy: text(raw.decidedBy || raw.reviewedBy) || null,
      decidedAt: Number.isFinite(raw.decidedAt || raw.reviewedAt) ? Number(raw.decidedAt || raw.reviewedAt) : null,
      rationale: text(raw.rationale || raw.reason) || null,
      createdAt: Number(raw.createdAt || raw.at) || statSync(file).mtimeMs,
      recorded: text(raw.decidedBy || raw.reviewedBy) ? 'complete' : 'partial',
      raw: { file: rel },
    })
  }
  return { proposals, skipped }
}

function buildPlan(options) {
  if (!existsSync(options.cognitionDir)) throw Object.assign(new Error('cognition directory not found: ' + options.cognitionDir), { code: 'cognition_missing' })
  const entry = { entries: [], skipped: [] }
  const candidates = [
    join(options.cognitionDir, 'principles.md'),
    ...['preferences', 'agreements', 'decisions', 'principles'].map(name => join(options.cognitionDir, 'chat', name + '.md')),
  ]
  try {
    for (const name of readdirSync(join(options.cognitionDir, 'chat'))) if (name.endsWith('.md')) candidates.push(join(options.cognitionDir, 'chat', name))
  } catch {}
  try {
    for (const name of readdirSync(join(options.cognitionDir, 'projects'))) if (name.endsWith('.md')) candidates.push(join(options.cognitionDir, 'projects', name))
  } catch {}
  const seenFiles = new Set()
  for (const file of candidates) {
    if (!existsSync(file) || seenFiles.has(file)) continue
    seenFiles.add(file)
    const parsed = readMarkdownEntries(file, options.cognitionDir, { strict: options.strict === true })
    entry.entries.push(...parsed.entries)
    entry.skipped.push(...parsed.skipped)
  }
  const proposals = readProposals(options.cognitionDir)
  return { entries: entry.entries, proposals: proposals.proposals, skipped: [...entry.skipped, ...proposals.skipped], entrySkipped: entry.skipped }
}

function readSettings(stateDir) {
  try { return JSON.parse(readFileSync(join(stateDir, 'ria.json'), 'utf8')) } catch { return {} }
}

function ensureEntriesSchema(db) {
  const info = db.prepare('PRAGMA table_info(cognition_entries)').all()
  if (!info.length) return
  const byName = new Map(info.map(row => [row.name, row]))
  const cause = byName.get('cause')
  const needs = !cause || Number(cause.notnull) === 1 || !byName.has('recorded') || !byName.has('truncated')
  if (!needs) return
  const old = 'cognition_entries_migration_old'
  db.exec('BEGIN')
  try {
    db.exec('ALTER TABLE cognition_entries RENAME TO ' + old)
    db.exec(`CREATE TABLE cognition_entries (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE,
      scope TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'experience',
      status TEXT NOT NULL DEFAULT 'active',
      tags TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(tags)),
      body TEXT NOT NULL,
      cause TEXT,
      recorded TEXT,
      truncated INTEGER NOT NULL DEFAULT 0,
      sources TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(sources)),
      superseded_by TEXT,
      dispute_reason TEXT,
      created_by TEXT NOT NULL DEFAULT 'sage',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      verified_at INTEGER,
      migrated_at INTEGER,
      migration_run_id TEXT
    )`)
    const select = [
      'seq', 'id', 'scope', 'kind', 'status', 'tags', 'body',
      byName.has('cause') ? 'cause' : 'NULL',
      byName.has('recorded') ? 'recorded' : 'NULL',
      byName.has('truncated') ? 'truncated' : '0',
      'sources', 'superseded_by', 'dispute_reason', 'created_by', 'created_at', 'updated_at', 'verified_at',
      byName.has('migrated_at') ? 'migrated_at' : 'NULL',
      byName.has('migration_run_id') ? 'migration_run_id' : 'NULL',
    ].join(',')
    db.exec('INSERT INTO cognition_entries(seq,id,scope,kind,status,tags,body,cause,recorded,truncated,sources,superseded_by,dispute_reason,created_by,created_at,updated_at,verified_at,migrated_at,migration_run_id) SELECT ' + select + ' FROM ' + old)
    db.exec('DROP TABLE ' + old)
    db.exec('CREATE INDEX IF NOT EXISTS idx_cog_entries_scope_status ON cognition_entries(scope, status)')
    db.exec('CREATE INDEX IF NOT EXISTS idx_cog_entries_status_updated ON cognition_entries(status, updated_at)')
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

function ensureMigrationColumns(db) {
  ensureEntriesSchema(db)
  for (const table of ['cognition_entries', 'cognition_proposals']) {
    const cols = db.prepare('PRAGMA table_info(' + table + ')').all().map(row => row.name)
    if (!cols.includes('migrated_at')) db.exec('ALTER TABLE ' + table + ' ADD COLUMN migrated_at INTEGER')
    if (!cols.includes('migration_run_id')) db.exec('ALTER TABLE ' + table + ' ADD COLUMN migration_run_id TEXT')
  }
}

function backup(options, runId, now) {
  const base = join(options.stateDir, 'cognition.bak-' + stamp(now))
  let root = base
  for (let suffix = 1; existsSync(root) && suffix < 100; suffix += 1) root = base + '-' + suffix
  mkdirSync(root, { recursive: true })
  const destination = join(root, 'cognition')
  if (existsSync(options.cognitionDir)) cpSync(options.cognitionDir, destination, { recursive: true })
  else mkdirSync(destination, { recursive: true })
  if (!existsSync(options.dbPath)) throw Object.assign(new Error('SQLite DB not found: ' + options.dbPath), { code: 'sqlite_missing' })
  const db = openDatabase(options.dbPath)
  try { db.exec("VACUUM INTO '" + join(root, 'ria.sqlite').replace(/'/g, "''") + "'") } finally { db.close() }
  const manifest = { runId, createdAt: now, stateDir: options.stateDir, cognitionDir: options.cognitionDir, dbPath: options.dbPath, backup: root }
  writeFileSync(join(root, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
  return { root, manifest }
}

function count(db) {
  const table = name => Number(db.prepare('SELECT COUNT(*) n FROM ' + name).get().n)
  return { entries: table('cognition_entries'), proposals: table('cognition_proposals'), receipts: table('cognition_receipts') }
}

function applyPlan(options, plan, now = Date.now()) {
  const runId = 'cogmig_' + stamp(now) + '_' + randomUUID().replace(/-/g, '').slice(0, 8)
  const backupInfo = backup(options, runId, now)
  const db = openDatabase(options.dbPath)
  try {
    ensureMigrationColumns(db)
    const before = count(db)
    let imported = 0
    let existing = 0
    const insertEntry = db.prepare(`INSERT INTO cognition_entries(id,scope,kind,status,tags,body,cause,recorded,truncated,sources,created_by,created_at,updated_at,migrated_at,migration_run_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    const insertProposal = db.prepare(`INSERT INTO cognition_proposals(id,author,source,kind,scope,target_entry_id,ticket_id,body,cause,sources,priority,status,decided_by,decided_at,rationale,created_at,migrated_at,migration_run_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    transaction(db, () => {
      for (const item of plan.entries) {
        if (db.prepare('SELECT 1 FROM cognition_entries WHERE id=?').get(item.id)) { existing += 1; continue }
        insertEntry.run(item.id, item.scope, item.kind, item.status, JSON.stringify(item.tags), item.body, item.cause,
          item.recorded || 'complete', item.truncated ? 1 : 0, JSON.stringify(item.sources), 'migration', item.createdAt, now, now, runId)
        imported += 1
      }
      for (const item of plan.proposals) {
        if (db.prepare('SELECT 1 FROM cognition_proposals WHERE id=?').get(item.id)) { existing += 1; continue }
        insertProposal.run(item.id, item.author, item.source, item.kind, item.scope, item.targetEntryId, item.ticketId,
          item.body, item.cause, JSON.stringify(item.sources), item.priority, item.status, item.decidedBy, item.decidedAt,
          item.rationale, item.createdAt, now, runId)
        imported += 1
      }
    })
    const after = count(db)
    return { runId, backup: backupInfo.root, before, after, imported, existing, skipped: plan.skipped, plan }
  } finally { db.close() }
}

function sampleVerify(options, plan, result) {
  const db = openDatabase(options.dbPath, { readOnly: true })
  try {
    const sampleEntries = plan.entries.slice(0, Math.min(options.sample, plan.entries.length))
    const diffs = []
    for (const source of sampleEntries) {
      const row = db.prepare('SELECT scope,body,cause,recorded,truncated,sources FROM cognition_entries WHERE id=?').get(source.id)
      if (!row) { diffs.push({ kind: 'entry', id: source.id, reason: 'missing' }); continue }
      const sources = JSON.parse(row.sources || '[]')
      if (row.scope !== source.scope || row.body !== source.body || row.cause !== source.cause || row.recorded !== source.recorded || Boolean(row.truncated) !== Boolean(source.truncated) || sources[0]?.ref !== source.sources[0]?.ref) {
        diffs.push({ kind: 'entry', id: source.id, expected: source, actual: row })
      }
    }
    const sampleProposals = plan.proposals.slice(0, Math.min(5, plan.proposals.length))
    for (const source of sampleProposals) {
      const row = db.prepare('SELECT status,decided_by,decided_at,rationale FROM cognition_proposals WHERE id=?').get(source.id)
      if (!row) { diffs.push({ kind: 'proposal', id: source.id, reason: 'missing' }); continue }
      if (row.status !== source.status || row.decided_by !== source.decidedBy || row.decided_at !== source.decidedAt) {
        diffs.push({ kind: 'proposal', id: source.id, expected: source, actual: row })
      }
    }
    return { sampleEntries: sampleEntries.length, sampleProposals: sampleProposals.length, diffs }
  } finally { db.close() }
}

function latestBackup(stateDir) {
  const dirs = existsSync(stateDir) ? readdirSync(stateDir).filter(name => name.startsWith('cognition.bak-')).sort().reverse() : []
  for (const name of dirs) {
    const root = join(stateDir, name)
    try { return { root, manifest: JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8')) } } catch {}
  }
  return null
}

function rollback(options) {
  const dirs = existsSync(options.stateDir) ? readdirSync(options.stateDir).filter(name => name.startsWith('cognition.bak-')).sort().reverse() : []
  if (!dirs.length) throw Object.assign(new Error('no cognition backup found'), { code: 'backup_missing' })
  const db = openDatabase(options.dbPath)
  try {
    ensureMigrationColumns(db)
    let found = null
    let fallback = null
    for (const name of dirs) {
      const root = join(options.stateDir, name)
      try {
        const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'))
        if (!fallback) fallback = { root, manifest }
        const rows = Number(db.prepare('SELECT COUNT(*) n FROM cognition_entries WHERE migration_run_id=?').get(manifest.runId).n)
          + Number(db.prepare('SELECT COUNT(*) n FROM cognition_proposals WHERE migration_run_id=?').get(manifest.runId).n)
        if (rows > 0) { found = { root, manifest }; break }
      } catch {}
    }
    found = found || fallback
    if (!found) throw Object.assign(new Error('no usable cognition backup found'), { code: 'backup_missing' })
    const deletedEntries = db.prepare('DELETE FROM cognition_entries WHERE migration_run_id=?').run(found.manifest.runId).changes
    const deletedProposals = db.prepare('DELETE FROM cognition_proposals WHERE migration_run_id=?').run(found.manifest.runId).changes
    const backupCognition = join(found.root, 'cognition')
    if (existsSync(backupCognition)) {
      rmSync(options.cognitionDir, { recursive: true, force: true })
      cpSync(backupCognition, options.cognitionDir, { recursive: true })
    }
    return { runId: found.manifest.runId, backup: found.root, deletedEntries: Number(deletedEntries), deletedProposals: Number(deletedProposals), counts: count(db) }
  } finally { db.close() }
}

function entryStats(plan) {
  const complete = plan.entries.filter(item => item.recorded !== 'partial').length
  const partial = plan.entries.filter(item => item.recorded === 'partial').length
  const truncated = plan.entries.filter(item => item.truncated === true).length
  const entrySkipped = Array.isArray(plan.entrySkipped) ? plan.entrySkipped.length : plan.skipped.filter(item => item.kind === 'entry').length
  const total = plan.entries.length + entrySkipped
  return {
    imported: complete, importedPart: partial, truncated,
    importedTotal: plan.entries.length, entrySkipped,
    coverage: total ? Math.round((plan.entries.length / total) * 1000) / 10 : 100,
  }
}

export function migrate(options, { log = () => {} } = {}) {
  const plan = buildPlan(options)
  const stats = entryStats(plan)
  const settingsBefore = readSettings(options.stateDir)
  const backendBefore = settingsBefore.settings?.cognition?.backend || 'file'
  if (options.mode === 'rollback') return { ok: true, mode: 'rollback', ...rollback(options), backend: backendBefore }
  if (options.mode === 'apply') {
    const applied = applyPlan(options, plan)
    const sampling = sampleVerify(options, plan, applied)
    const settingsAfter = readSettings(options.stateDir)
    return {
      ok: sampling.diffs.length === 0, mode: 'apply', stateDir: options.stateDir, cognitionDir: options.cognitionDir,
      dbPath: options.dbPath, backup: applied.backup, runId: applied.runId,
      counts: {
        imported: applied.imported, existing: applied.existing, skipped: applied.skipped.length,
        imported_complete: stats.imported, imported_partial: stats.importedPart, truncated: stats.truncated, coverage: stats.coverage,
        entries: applied.after.entries, proposals: applied.after.proposals,
        receiptsBefore: applied.before.receipts, receiptsAfter: applied.after.receipts,
      },
      skipped: applied.skipped, recordedPartial: plan.proposals.filter(item => item.recorded === 'partial').map(item => item.id),
      recordedPartialEntries: plan.entries.filter(item => item.recorded === 'partial').map(item => item.id),
      strict: options.strict === true,
      sampling, backendBefore, backendAfter: settingsAfter.settings?.cognition?.backend || 'file',
      samples: {
        entries: plan.entries.slice(0, 3), proposals: plan.proposals.slice(0, 3),
        imported: plan.entries.filter(item => item.recorded !== 'partial' && !item.truncated).slice(0, 3),
        imported_partial: plan.entries.filter(item => item.recorded === 'partial').slice(0, 3),
        truncated: plan.entries.filter(item => item.truncated === true).slice(0, 3),
        skipped: applied.skipped.slice(0, 3),
      },
    }
  }
  return {
    ok: true, mode: 'dry-run', stateDir: options.stateDir, cognitionDir: options.cognitionDir, dbPath: options.dbPath,
    counts: {
      plannedEntries: plan.entries.length, plannedProposals: plan.proposals.length, skipped: plan.skipped.length,
      imported: stats.imported, imported_partial: stats.importedPart, truncated: stats.truncated,
      imported_total: stats.importedTotal, entry_skipped: stats.entrySkipped, coverage: stats.coverage, existing: 0,
    },
    skipped: plan.skipped, recordedPartial: plan.proposals.filter(item => item.recorded === 'partial').map(item => item.id),
    recordedPartialEntries: plan.entries.filter(item => item.recorded === 'partial').map(item => item.id),
    strict: options.strict === true,
    samples: {
      entries: plan.entries.slice(0, 3), proposals: plan.proposals.slice(0, 3),
      imported: plan.entries.filter(item => item.recorded !== 'partial' && !item.truncated).slice(0, 3),
      imported_partial: plan.entries.filter(item => item.recorded === 'partial').slice(0, 3),
      truncated: plan.entries.filter(item => item.truncated === true).slice(0, 3),
      skipped: plan.skipped.slice(0, 3),
    },
    backendBefore, backendAfter: backendBefore,
  }
}

export function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv)
  const result = migrate(options)
  console.log(JSON.stringify(result, null, 2))
  return result.ok ? 0 : 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { process.exitCode = main() } catch (error) { console.error(JSON.stringify({ ok: false, code: error.code || 'migration_failed', message: String(error && error.message ? error.message : error) }, null, 2)); process.exitCode = 1 }
}
