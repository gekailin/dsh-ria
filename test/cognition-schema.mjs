import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../lib/state/sqlite/db.mjs'
import { SCHEMA_VERSION } from '../lib/state/sqlite/schema.mjs'

const dir = mkdtempSync(join(tmpdir(), 'ria-cognition-schema-'))
const dbPath = join(dir, 'ria.sqlite')
try {
  let db = openDatabase(dbPath, { create: true })
  try {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name)
    for (const name of ['cognition_entries', 'cognition_projects', 'cognition_proposals', 'schema_migrations']) {
      assert.ok(tables.includes(name), name + ' table exists')
    }
    for (const retired of ['cognition_receipts', 'cognition_lesson_candidates', 'lessons']) {
      assert.equal(tables.includes(retired), false, retired + ' retired table must not exist')
    }
    const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all().map(row => row.name)
    for (const name of ['idx_cog_entries_scope_status', 'idx_cog_entries_status_updated', 'idx_cog_proposals_status_prio', 'idx_cog_proposals_ticket', 'idx_cog_proposals_target']) {
      assert.ok(indexes.includes(name), name + ' index exists')
    }
    assert.equal(Number(db.prepare('PRAGMA user_version').get().user_version), SCHEMA_VERSION)

    db.prepare('INSERT INTO cognition_projects(project_id,name,workspaces,overview,status,updated_at) VALUES(?,?,?,?,?,?)')
      .run('dsh-ria', 'DSH Ria', JSON.stringify(['/home/gkl/Desktop/vibe_proj/dsh-ria']), 'Ria cognition', 'active', 1)
    db.prepare('INSERT INTO cognition_entries(seq,id,scope,kind,status,tags,body,cause,sources,created_by,created_at,updated_at) VALUES(NULL,?,?,?,?,?,?,?,?,?,?,?)')
      .run('cog_1', 'project:dsh-ria', 'experience', 'active', JSON.stringify(['sqlite']), 'body', 'cause', JSON.stringify([{ type: 'file', ref: 'lib/state/sqlite/schema.mjs' }]), 'sage', 1, 1)
    db.prepare('INSERT INTO cognition_proposals(id,author,source,kind,scope,body,cause,sources,priority,status,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
      .run('prop_1', 'executor', 'ria_executor_report', 'add', 'global', 'body', '', '[]', 'normal', 'pending', 1)
    assert.equal(db.prepare('SELECT id FROM cognition_entries').get().id, 'cog_1')
    assert.equal(db.prepare('SELECT status FROM cognition_proposals').get().status, 'pending')
    assert.equal(Number(db.prepare('SELECT seq FROM cognition_entries').get().seq), 1)

    // CHECK constraints reject bogus status/kind.
    assert.throws(() => db.prepare("INSERT INTO cognition_entries(id,scope,kind,status,tags,body,cause,sources,created_by,created_at,updated_at) VALUES('cog_2','global','experience','bogus','[]','b','c','[]','sage',1,1)").run())
    assert.throws(() => db.prepare("INSERT INTO cognition_proposals(id,author,source,kind,scope,body,cause,sources,priority,status,created_at) VALUES('prop_bad','executor','t','bogus','global','b','','[]','normal','pending',1)").run())
  } finally { db.close() }

  // Existing DB with legacy cognition_receipts/lessons/cognition_lesson_candidates migrates cleanly.
  const legacyPath = join(dir, 'legacy.sqlite')
  db = openDatabase(legacyPath, { create: true })
  try {
    db.exec('DELETE FROM schema_migrations')
    db.exec(`CREATE TABLE cognition_receipts (
      proposal_id TEXT PRIMARY KEY, decision TEXT NOT NULL, rationale TEXT NOT NULL,
      decided_by TEXT NOT NULL, decided_at INTEGER NOT NULL,
      evidence_refs TEXT NOT NULL DEFAULT '[]', affected_entries TEXT NOT NULL DEFAULT '[]', created_at INTEGER NOT NULL
    )`)
    db.exec('CREATE TABLE lessons (id TEXT PRIMARY KEY)')
    db.exec('CREATE TABLE cognition_lesson_candidates (id TEXT PRIMARY KEY)')
    db.prepare('INSERT INTO cognition_proposals(id,author,source,kind,scope,body,cause,sources,priority,status,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
      .run('prop_old', 'executor', 'test', 'add', 'global', 'old', 'cause', '[]', 'normal', 'pending', 1)
    db.prepare('INSERT INTO cognition_receipts(proposal_id,decision,rationale,decided_by,decided_at,evidence_refs,affected_entries,created_at) VALUES(?,?,?,?,?,?,?,?)')
      .run('prop_old', 'accepted', 'verified', 'sage', 42, '[{"type":"file","ref":"a.mjs"}]', '["cog_9"]', 42)
  } finally { db.close() }

  db = openDatabase(legacyPath)
  try {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name)
    assert.equal(tables.includes('cognition_receipts'), false, 'migration drops cognition_receipts')
    assert.equal(tables.includes('lessons'), false, 'migration drops lessons')
    assert.equal(tables.includes('cognition_lesson_candidates'), false, 'migration drops cognition_lesson_candidates')
    const migrated = db.prepare('SELECT status,decided_by,decided_at,rationale FROM cognition_proposals WHERE id=?').get('prop_old')
    assert.equal(migrated.status, 'accepted')
    assert.equal(migrated.decided_by, 'sage')
    assert.equal(migrated.decided_at, 42)
    assert.equal(migrated.rationale, 'verified')
    const entryColumns = db.prepare('PRAGMA table_info(cognition_entries)').all().map(col => col.name)
    const proposalColumns = db.prepare('PRAGMA table_info(cognition_proposals)').all().map(col => col.name)
    for (const column of ['recorded', 'truncated']) assert.equal(entryColumns.includes(column), false, column + ' must be dropped')
    for (const column of ['evidence_refs', 'affected_entries']) assert.equal(proposalColumns.includes(column), false, column + ' must be dropped')
  } finally { db.close() }
  console.log('cognition schema slice ok')
} finally { rmSync(dir, { recursive: true, force: true }) }