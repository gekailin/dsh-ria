import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../lib/state/sqlite/db.mjs'
import { SCHEMA_VERSION } from '../lib/state/sqlite/schema.mjs'

// Phase 1 minimum slice: additive, idempotent cognition tables. This test does
// not exercise CognitionStore; it locks the storage contract only.
const dir = mkdtempSync(join(tmpdir(), 'ria-cognition-schema-'))
const dbPath = join(dir, 'ria.sqlite')
try {
  let db = openDatabase(dbPath, { create: true })
  try {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name)
    for (const name of ['cognition_entries', 'cognition_projects', 'cognition_proposals', 'cognition_receipts']) assert.ok(tables.includes(name), name + ' table exists')
    const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all().map(row => row.name)
    for (const name of ['idx_cog_entries_scope_status', 'idx_cog_entries_status_updated', 'idx_cog_proposals_status_prio']) assert.ok(indexes.includes(name), name + ' index exists')
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
  } finally { db.close() }

  // Existing DB with the old schema gets the new tables on the next writable open.
  db = openDatabase(dbPath)
  try {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name)
    for (const name of ['cognition_entries', 'cognition_projects', 'cognition_proposals']) assert.ok(tables.includes(name))
    assert.equal(Number(db.prepare('PRAGMA user_version').get().user_version), SCHEMA_VERSION)
  } finally { db.close() }
  console.log('cognition schema slice ok')
} finally { rmSync(dir, { recursive: true, force: true }) }
