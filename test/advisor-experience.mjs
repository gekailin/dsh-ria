import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createFixture } from './support/ria-fixture.mjs'
import { buildAdvisorPlanInput } from '../lib/core/advisor.mjs'
import { CognitionStore, projectKey } from '../lib/roles/cognition.mjs'
import { openDatabase } from '../lib/state/sqlite/db.mjs'

const fixture = await createFixture({ stateDefault: true })
try {
  const controller = fixture.service.controller
  const store = fixture.service.store
  const state = controller.state
  const workspace = join(fixture.stateDir, 'workspace')
  mkdirSync(workspace, { recursive: true })
  controller.cognition.ensure()
  const key = projectKey(workspace)
  const lines = [
    '# Project experiences',
    '- sqlite experience one with a source',
    '- sqlite experience two',
    '- sqlite experience three',
    '- sqlite experience four',
    '- sqlite experience five',
    '- sqlite experience six',
    '- ' + 'long '.repeat(80),
  ]
  writeFileSync(join(fixture.stateDir, 'cognition', 'projects', key + '.md'), lines.join('\n') + '\n')
  const ticket = store.addTicket({ status: 'open', waitingOn: 'ria', executor: 'advisor', goal: 'sqlite experience', acceptance: 'x' })
  state.setTicketMeta(ticket.ticketId, { projectCwd: workspace })
  const meta = state.ticketMeta(ticket.ticketId)
  let dbReads = 0
  controller.cognition.searchEntries = () => { dbReads += 1; return [] }
  const resolved = controller.resolveLessonsForDispatch(ticket, { summary: 'work', steps: ['do'] }, meta)
  assert.equal(resolved.lessons.length, 5, 'at most five experiences')
  assert.equal(dbReads, 0, 'backend=file does not call searchEntries')
  for (const lesson of resolved.lessons) {
    assert.ok(lesson.id)
    assert.ok(lesson.source)
    assert.ok([...lesson.text].length <= 200)
  }
  const persisted = controller.persistWorkOrder(ticket.ticketId, { summary: 'experience work', steps: ['do it'], acceptance: 'x' })
  assert.equal(persisted.ok, true, JSON.stringify(persisted))
  assert.equal(persisted.workOrder.lessons.length, 5)
  assert.ok(persisted.workOrder.lessons.every(item => item.id && item.source && [...item.text].length <= 200))
  const advisorInput = buildAdvisorPlanInput({ ticket, request: null, meta, snapshot: { snapshot: 'snapshot' }, experience: resolved.lessons })
  assert.ok(advisorInput.includes('[相关历史经验'))
  assert.ok(advisorInput.includes('[file:projects/') || advisorInput.includes('projects/'))

  // SQLite-backed retrieval.
  const dbPath = join(fixture.stateDir, 'experience.sqlite')
  const db = openDatabase(dbPath, { create: true })
  try {
    db.prepare('INSERT INTO cognition_projects(project_id,name,workspaces,overview,status,updated_at) VALUES(?,?,?,?,?,?)')
      .run(key, 'Workspace', JSON.stringify([workspace]), 'overview', 'active', 1)
    const insert = db.prepare('INSERT INTO cognition_entries(id,scope,kind,status,tags,body,cause,sources,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
    insert.run('cog_exp', 'project:' + key, 'experience', 'active', '[]', 'sqlite experience from db', 'cause', JSON.stringify([{ type: 'file', ref: 'db' }]), 'sage', 1, 1)
  } finally { db.close() }
  controller.cognition = new CognitionStore({ stateDir: fixture.stateDir, backend: 'sqlite', dbPath })
  const sqliteResolved = controller.resolveLessonsForDispatch(ticket, { summary: 'work', steps: ['do'] }, meta)
  assert.ok(sqliteResolved.lessons.some(item => item.id === 'cog_exp'))
  controller.cognition.db.close()
  console.log('advisor experience wiring ok')
} finally { fixture.cleanup() }
