import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CognitionStore, normalizeCognitionSettings } from '../lib/roles/cognition.mjs'
import { openDatabase } from '../lib/state/sqlite/db.mjs'
import { RiaStore } from '../lib/index.js'

const dir = mkdtempSync(join(tmpdir(), 'ria-cognition-sqlite-'))
const projectDir = join(dir, 'workspace', 'dsh-ria')
const otherDir = join(dir, 'workspace', 'other')
mkdirSync(projectDir, { recursive: true })
mkdirSync(otherDir, { recursive: true })
const dbPath = join(dir, 'ria.sqlite')
const db = openDatabase(dbPath, { create: true })
try {
  const insertProject = db.prepare('INSERT INTO cognition_projects(project_id,name,workspaces,overview,status,updated_at) VALUES(?,?,?,?,?,?)')
  insertProject.run('dsh-ria', 'DSH Ria', JSON.stringify([projectDir]), 'Ria project', 'active', 1)
  insertProject.run('other', 'Other', JSON.stringify([otherDir]), 'Other project', 'active', 1)
  const insertProposal = db.prepare('INSERT INTO cognition_proposals(id,author,source,kind,scope,body,cause,sources,priority,status,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
  insertProposal.run('prop_accept', 'executor', 'test', 'add', 'global', 'body', '', '[]', 'normal', 'pending', 1)
  insertProposal.run('prop_defer', 'executor', 'test', 'add', 'global', 'body', '', '[]', 'normal', 'pending', 1)
  insertProposal.run('prop_deny', 'executor', 'test', 'add', 'global', 'body', '', '[]', 'normal', 'pending', 1)
  insertProposal.run('prop_legacy', 'executor', 'test', 'add', 'global', 'body', '', '[]', 'normal', 'denied', 1)
  insertProposal.run('prop_merge', 'executor', 'test', 'add', 'global', 'body', '', '[]', 'normal', 'pending', 1)
} finally { db.close() }

const warnings = []
try {
  assert.deepEqual(normalizeCognitionSettings(undefined), {})
  assert.deepEqual(normalizeCognitionSettings({ backend: 'sqlite' }), {})
  assert.deepEqual(normalizeCognitionSettings({ backend: 'nope', voice: 'brief' }), { voice: 'brief' })
  const settingsStore = new RiaStore(join(dir, 'settings'))
  assert.equal(Object.hasOwn(settingsStore.settings(), 'cognition'), false)
  settingsStore.setSettings({ cognition: { backend: 'sqlite' } })
  assert.equal(Object.hasOwn(settingsStore.settings(), 'cognition'), false)

  const audits = []
  const store = new CognitionStore({ stateDir: dir, backend: 'sqlite', dbPath, log: (level, message) => warnings.push({ level, message }), audit: event => audits.push(event) })
  const entry = {
    scope: 'project:dsh-ria', body: 'Use SQLite for cognition', cause: 'Markdown retrieval was brittle.',
    tags: ['sqlite', 'cognition'], sources: [{ type: 'file', ref: 'lib/roles/cognition.mjs' }],
  }
  const created = store.upsertEntry(entry)
  assert.equal(created.ok, true, JSON.stringify(created))
  assert.match(created.entry.id, /^cog_\d+$/)
  assert.equal(created.created, true)
  assert.equal(store.getEntry(created.entry.id).body, entry.body)
  const implicit = new CognitionStore({ stateDir: dir, dbPath })
  assert.equal(implicit.getEntry(created.entry.id).body, entry.body, 'no backend config still uses SQLite')
  implicit.db.close()
  const createdAgain = store.upsertEntry({ id: created.entry.id, ...entry })
  assert.equal(createdAgain.ok, true)
  assert.equal(createdAgain.idempotent, true)
  assert.equal(createdAgain.entry.updatedAt, created.entry.updatedAt, 'same key + same content keeps updatedAt')
  const updated = store.upsertEntry({ id: created.entry.id, ...entry, body: 'Use SQLite for cognition now' })
  assert.equal(updated.ok, true)
  assert.equal(updated.idempotent, false)
  assert.equal(store.getEntry(created.entry.id).body, 'Use SQLite for cognition now')

  assert.equal(store.searchEntries({ scope: 'project:dsh-ria' }).some(item => item.id === created.entry.id), true)
  assert.equal(store.searchEntries({ tag: 'sqlite' }).some(item => item.id === created.entry.id), true)
  assert.equal(store.searchEntries({ text: 'brittle' }).some(item => item.id === created.entry.id), true)
  assert.deepEqual(store.searchEntries({ text: 'no-such-text' }), [])

  assert.deepEqual(store.resolveProjectsForWorkspace(projectDir).map(item => item.projectId), ['dsh-ria'])
  assert.deepEqual(store.resolveProjectsForWorkspace(join(projectDir, 'nested')).map(item => item.projectId), ['dsh-ria'])
  assert.deepEqual(store.resolveProjectsForWorkspace(join(dir, 'missing')), [])

  const accepted = store.decideProposal('prop_accept', { decision: 'accepted', decidedBy: 'sage', rationale: 'validated' })
  assert.equal(accepted.ok, true, JSON.stringify(accepted))
  assert.equal(accepted.proposal.status, 'accepted')
  assert.equal(accepted.proposal.decidedBy, 'sage')
  assert.equal(accepted.proposal.rationale, 'validated')
  const acceptedAgain = store.decideProposal('prop_accept', { decision: 'accepted', decidedBy: 'sage', rationale: 'validated again' })
  assert.equal(acceptedAgain.ok, true)
  assert.equal(acceptedAgain.idempotent, true)
  assert.equal(acceptedAgain.proposal.decidedAt, accepted.proposal.decidedAt)
  const conflict = store.decideProposal('prop_accept', { decision: 'deferred', decidedBy: 'sage', rationale: 'changed mind' })
  assert.equal(conflict.ok, false)
  assert.equal(conflict.code, 'proposal_conflict')
  assert.equal(store.decideProposal('prop_defer', { decision: 'deferred', decidedBy: 'sage', rationale: 'later' }).proposal.status, 'deferred')
  assert.equal(store.decideProposal('prop_deny', { decision: 'rejected', decidedBy: 'sage', rationale: 'not useful' }).proposal.status, 'rejected')

  // merged requires an existing target entry id.
  const missingTarget = store.decideProposal('prop_merge', { decision: 'merged', decidedBy: 'sage', rationale: 'merge', targetEntryId: 'cog_missing' })
  assert.equal(missingTarget.ok, false)
  assert.equal(missingTarget.code, 'proposal_target_missing')
  const merged = store.decideProposal('prop_merge', { decision: 'merged', decidedBy: 'sage', rationale: 'merge', targetEntryId: created.entry.id })
  assert.equal(merged.ok, true, JSON.stringify(merged))
  assert.equal(merged.proposal.status, 'merged')
  assert.equal(merged.proposal.targetEntryId, created.entry.id)

  // Old denied rows read as rejected, migration is one-shot and audited.
  const legacy = store.getProposal('prop_legacy')
  assert.equal(legacy.status, 'rejected')
  const migrated = store.migrateProposalStatuses()
  assert.deepEqual(migrated.ids, ['prop_legacy'])
  assert.equal(audits.filter(event => event.event === 'cognition.status.migrated').length, 1)
  assert.equal(store.migrateProposalStatuses().migrated, 0)
  assert.equal(audits.filter(event => event.event === 'cognition.status.migrated').length, 1)

  const count = store.searchEntries({}).length
  for (const missing of [
    { ...entry, scope: '' }, { ...entry, body: '' }, { ...entry, cause: '' }, { ...entry, sources: [] },
    { ...entry, sources: [{ type: 'unknown', ref: 'x' }] },
  ]) {
    const invalid = store.upsertEntry(missing)
    assert.equal(invalid.ok, false)
    assert.equal(invalid.code, 'cognition_invalid')
    assert.ok(invalid.field)
  }
  assert.equal(store.searchEntries({}).length, count, 'invalid entries are not written')
  store.db.close()

  // No backend configuration: SQLite is the only store; missing DB is a hard error.
  const missingDb = join(dir, 'missing.sqlite')
  const unavailable = new CognitionStore({ stateDir: dir, dbPath: missingDb, log: (level, message) => warnings.push({ level, message }) })
  assert.equal(unavailable.getEntry('cog_1'), null)
  assert.equal(unavailable.upsertEntry(entry).code, 'cognition_db_unavailable')
  assert.deepEqual(unavailable.searchEntries({}), [])
  assert.equal(unavailable.dbError.code, 'cognition_db_unavailable')
  assert.equal(existsSync(missingDb), false, 'no SQLite file is created on open failure')
  console.log('cognition sqlite backend ok')
} finally { rmSync(dir, { recursive: true, force: true }) }
