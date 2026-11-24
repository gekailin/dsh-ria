import assert from 'node:assert/strict'
import { createFixture } from './support/ria-fixture.mjs'

const fixture = await createFixture({ stateDefault: true })
try {
  const controller = fixture.service.controller
  const sage = (await controller.ensureSage()).sessionId
  const entry = await fixture.callAs(sage, 'ria_sage_write', {
    action: 'upsert_entry',
    entry: { scope: 'project:dsh-ria', body: 'structured entry', cause: 'test', sources: [{ type: 'file', ref: 'test' }] },
  })
  assert.equal(entry.ok, true, JSON.stringify(entry))
  const id = entry.entry.id
  const summary = await fixture.callAs(sage, 'ria_sage_read', { view: 'summary' })
  assert.equal(summary.ok, true)
  assert.equal(summary.pendingProposals, 0)
  assert.ok(summary.byScope['project:dsh-ria'])
  const project = await fixture.callAs(sage, 'ria_sage_write', {
    action: 'upsert_project',
    project: { projectId: 'dsh-ria', name: 'DSH Ria', workspaces: ['/tmp/dsh-ria'], overview: 'overview' },
  })
  assert.equal(project.ok, true, JSON.stringify(project))
  const projects = await fixture.callAs(sage, 'ria_sage_read', { view: 'projects' })
  assert.ok(projects.projects.some(item => item.projectId === 'dsh-ria'))
  const disputed = await fixture.callAs(sage, 'ria_sage_write', { action: 'set_status', id, status: 'disputed', reason: 'needs evidence' })
  assert.equal(disputed.ok, true, JSON.stringify(disputed))
  assert.equal(disputed.entry.status, 'disputed')
  const read = await fixture.callAs(sage, 'ria_sage_read', { view: 'entry', id })
  assert.equal(read.entry.status, 'disputed')
  const bad = await fixture.callAs(sage, 'ria_sage_write', { action: 'set_status', id, status: 'bogus' })
  assert.equal(bad.code, 'invalid_argument')
  console.log('sage management ok')
} finally { fixture.cleanup() }
