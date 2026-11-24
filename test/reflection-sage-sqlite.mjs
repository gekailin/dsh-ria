import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readSageContext } from '../lib/reflection-sage-context.mjs'
import { CognitionStore } from '../lib/roles/cognition.mjs'
import { openDatabase } from '../lib/state/sqlite/db.mjs'

const root = mkdtempSync(join(tmpdir(), 'ria-reflection-sqlite-'))
try {
  const stateDir = join(root, 'sqlite')
  mkdirSync(stateDir, { recursive: true })
  const dbPath = join(stateDir, 'ria.sqlite')
  const db = openDatabase(dbPath, { create: true })
  try {
    const insertEntry = db.prepare('INSERT INTO cognition_entries(id,scope,kind,status,tags,body,cause,sources,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
    insertEntry.run('cog_1', 'user:preference', 'preference', 'active', '[]', 'Prefer concise reports', 'user asked repeatedly', '[]', 'sage', 10, 20)
    insertEntry.run('cog_2', 'project:dsh-ria', 'experience', 'active', '["sqlite"]', 'Use SQLite for cognition', 'file retrieval failed', '[]', 'sage', 10, 20)
    insertEntry.run('cog_3', 'project:dsh-ria', 'experience', 'disputed', '[]', 'Disputed entry', 'needs evidence', '[]', 'sage', 10, 20)
    db.prepare('INSERT INTO cognition_projects(project_id,name,workspaces,overview,status,updated_at) VALUES(?,?,?,?,?,?)').run('dsh-ria', 'DSH Ria', JSON.stringify(['/tmp/dsh-ria']), 'overview', 'active', 1)
    const insertProposal = db.prepare('INSERT INTO cognition_proposals(id,author,source,kind,scope,body,cause,sources,priority,status,decided_by,decided_at,rationale,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
    insertProposal.run('prop_pending', 'executor', 'test', 'add', 'global', 'pending body', '', '[]', 'normal', 'pending', null, null, null, 30)
    insertProposal.run('prop_accepted', 'executor', 'test', 'add', 'global', 'accepted body', '', '[]', 'normal', 'accepted', 'sage', 40, 'ok', 20)
    insertProposal.run('prop_merged', 'executor', 'test', 'merge', 'global', 'merged body', '', '[]', 'normal', 'merged', 'sage', 41, 'merge', 21)
  } finally { db.close() }
  const cognition = new CognitionStore({ stateDir, backend: 'sqlite', dbPath })
  const snapshot = readSageContext(stateDir, { since: 0, now: Date.parse('2026-11-24T00:00:00Z'), cognition })
  assert.ok(snapshot.cognitionSnapshot.preferences.some(item => item.id === 'cog_1'), 'sqlite snapshot contains preferences')
  assert.ok(snapshot.cognitionSnapshot.files.length >= 1)
  assert.ok(snapshot.cognitionSnapshot.projects.some(item => item.projectId === 'dsh-ria'))
  assert.ok(snapshot.cognitionSnapshot.disputedEntries.some(item => item.id === 'cog_3'))
  assert.ok(snapshot.pendingProposals.items.some(item => item.id === 'prop_pending'))
  assert.ok(snapshot.decisionHistory.items.some(item => item.id === 'prop_accepted' && item.status === 'accepted'))
  assert.ok(snapshot.decisionHistory.items.some(item => item.id === 'prop_merged' && item.status === 'merged'))
  cognition.db.close()

  // File fallback remains the original path and includes preferences.md.
  const fileDir = join(root, 'file')
  mkdirSync(join(fileDir, 'cognition', 'chat'), { recursive: true })
  writeFileSync(join(fileDir, 'cognition', 'chat', 'preferences.md'), '# Preferences\n\n## 2026-11-23 preference\nprefer concise reports\n')
  const fileSnapshot = readSageContext(fileDir, { since: '2026-11-22T00:00:00Z', now: Date.parse('2026-11-23T12:00:00Z') })
  assert.ok(fileSnapshot.cognitionSnapshot.files.some(file => file.file === 'chat/preferences.md'))

  // SQLite unavailable: hard cognition_db_unavailable, no file fallback.
  const warnings = []
  const missing = new CognitionStore({ stateDir: fileDir, dbPath: join(fileDir, 'missing.sqlite'), log: (level, message) => warnings.push({ level, message }) })
  assert.throws(
    () => readSageContext(fileDir, { since: '2026-11-22T00:00:00Z', now: Date.parse('2026-11-23T12:00:00Z'), cognition: missing, log: (level, message) => warnings.push({ level, message }) }),
    error => error && error.code === 'cognition_db_unavailable',
  )
  assert.equal(warnings.some(item => item.level === 'warn'), true)
  console.log('reflection sqlite context ok')
} finally { rmSync(root, { recursive: true, force: true }) }
