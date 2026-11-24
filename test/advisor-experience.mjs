import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { createFixture } from './support/ria-fixture.mjs'
import { buildAdvisorPlanInput, parseAdvisorOutput } from '../lib/core/advisor.mjs'
import { dispatchBrief } from '../lib/roles/co-managed.mjs'
import { CognitionStore } from '../lib/roles/cognition.mjs'
import { selectAdvisorExperience } from '../lib/roles/cognition-experience.mjs'
import { openDatabase } from '../lib/state/sqlite/db.mjs'

const fixture = await createFixture({ stateDefault: true })
try {
  const controller = fixture.service.controller
  const store = fixture.service.store
  const state = controller.state
  const workspace = join(fixture.stateDir, 'workspace')
  mkdirSync(workspace, { recursive: true })
  const key = 'dsh-ria'
  const dbPath = join(fixture.stateDir, 'experience.sqlite')
  const db = openDatabase(dbPath, { create: true })
  try {
    db.prepare('INSERT INTO cognition_projects(project_id,name,workspaces,overview,status,updated_at) VALUES(?,?,?,?,?,?)').run(key, 'DSH Ria', JSON.stringify([workspace]), 'project', 'active', 1)
    const insert = db.prepare('INSERT INTO cognition_entries(id,scope,kind,status,tags,body,cause,sources,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
    for (let index = 1; index <= 6; index += 1) {
      insert.run('cog_exp' + index, 'project:' + key, 'experience', 'active', '[]', 'sqlite experience ' + index + ' ' + 'long '.repeat(60), 'cause', JSON.stringify([{ type: 'file', ref: 'db' }]), 'sage', index, index)
    }
  } finally { db.close() }
  controller.cognition = new CognitionStore({ stateDir: fixture.stateDir, dbPath })
  const ticket = store.addTicket({ status: 'open', waitingOn: 'ria', executor: 'advisor', goal: 'sqlite experience', acceptance: 'x' })
  state.setTicketMeta(ticket.ticketId, { projectCwd: workspace })
  const meta = state.ticketMeta(ticket.ticketId)
  const candidates = selectAdvisorExperience({ cognition: controller.cognition, workspace, goal: 'sqlite experience', tags: [] })
  assert.ok(candidates.length > 0 && candidates.length <= 5, 'at most five experience candidates: ' + candidates.length)
  for (const lesson of candidates) {
    assert.ok(lesson.id)
    assert.ok(lesson.text)
    assert.ok([...lesson.text].length <= 200)
  }
  const selected = candidates.map(item => ({ id: item.id, guidance: item.text }))
  const resolved = controller.resolveLessonsForDispatch(ticket, { summary: 'work', steps: ['do'], experience: selected }, meta)
  assert.equal(resolved.lessons.length, Math.min(4, candidates.length))
  assert.equal(resolved.source, 'advisor.selected')
  const persisted = controller.persistWorkOrder(ticket.ticketId, { summary: 'experience work', steps: ['do it'], acceptance: 'x', experience: selected })
  assert.equal(persisted.ok, true, JSON.stringify(persisted))
  assert.equal(persisted.workOrder.experience.length, candidates.length)
  assert.equal(controller.resolveLessonsForDispatch(ticket, { summary: 'work', steps: ['do'], experience: persisted.workOrder.experience }, meta).lessons.length, Math.min(4, candidates.length))
  const advisorInput = buildAdvisorPlanInput({ ticket, request: null, meta, snapshot: { snapshot: 'snapshot' }, experience: candidates })
  assert.ok(advisorInput.includes('[相关历史经验'))
  assert.ok(advisorInput.includes('cog_exp'))
  const parsed = parseAdvisorOutput(JSON.stringify({ action: 'plan', workOrder: { summary: 'x', steps: ['y'], experience: [{ id: 'cog_1', guidance: 'guide one' }, { id: 'bad', guidance: 'drop' }] } }))
  assert.equal(parsed.ok, true)
  assert.deepEqual(parsed.workOrder.experience, [{ id: 'cog_1', guidance: 'guide one' }])
  const brief = dispatchBrief({ executor: {}, ticket, workOrder: { summary: 'x', steps: ['y'] }, lessons: resolved.lessons })
  assert.ok(brief.includes('[相关历史经验（必读）]'))
  assert.ok(brief.includes('cog_exp'))
  controller.cognition.db.close()
  console.log('advisor experience wiring ok')
} finally { fixture.cleanup() }
