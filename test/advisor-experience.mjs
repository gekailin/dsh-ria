import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
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
  const key = projectKey(workspace)
  const dbPath = join(fixture.stateDir, 'experience.sqlite')
  const db = openDatabase(dbPath, { create: true })
  try {
    const insert = db.prepare('INSERT INTO cognition_entries(id,scope,kind,status,tags,body,cause,sources,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
    for (let index = 1; index <= 6; index += 1) {
      insert.run('cog_exp' + index, 'project:' + key, 'experience', 'active', '[]', 'sqlite experience ' + index + ' ' + 'long '.repeat(60), 'cause', JSON.stringify([{ type: 'file', ref: 'db' }]), 'sage', index, index)
    }
  } finally { db.close() }
  controller.cognition = new CognitionStore({ stateDir: fixture.stateDir, dbPath })
  const ticket = store.addTicket({ status: 'open', waitingOn: 'ria', executor: 'advisor', goal: 'sqlite experience', acceptance: 'x' })
  state.setTicketMeta(ticket.ticketId, { projectCwd: workspace })
  const meta = state.ticketMeta(ticket.ticketId)
  const resolved = controller.resolveLessonsForDispatch(ticket, { summary: 'work', steps: ['do'] }, meta)
  assert.equal(resolved.lessons.length, 5, 'at most five experiences')
  assert.equal(resolved.source, 'cognition.sqlite')
  for (const lesson of resolved.lessons) {
    assert.ok(lesson.id)
    assert.ok(lesson.source)
    assert.ok([...lesson.text].length <= 200)
  }
  const persisted = controller.persistWorkOrder(ticket.ticketId, { summary: 'experience work', steps: ['do it'], acceptance: 'x' })
  assert.equal(persisted.ok, true, JSON.stringify(persisted))
  assert.equal(persisted.workOrder.lessons.length, 5)
  const advisorInput = buildAdvisorPlanInput({ ticket, request: null, meta, snapshot: { snapshot: 'snapshot' }, experience: resolved.lessons })
  assert.ok(advisorInput.includes('[相关历史经验'))
  assert.ok(advisorInput.includes('cog_exp'))
  controller.cognition.db.close()
  console.log('advisor experience wiring ok')
} finally { fixture.cleanup() }
