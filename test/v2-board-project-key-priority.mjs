import assert from 'node:assert/strict'
import { createFixture } from './support/ria-fixture.mjs'
import { projectKey } from '../lib/v2/cognition.mjs'

// /board groups by ticket projectKey first; the executor cwd only fills the gap.
const workspace = '/tmp/ria-board-workspace-a'
const executorCwd = '/tmp/ria-board-executor-b'
const fixture = await createFixture({
  v2Default: true,
  extraSessions: [
    { sessionId: 'session-board-exec', cwd: executorCwd, running: false, blank: false, updatedAt: 10, projections: { values: { title: 'Executor B' } } },
  ],
})
try {
  const controller = fixture.service.v2
  const store = controller.v2
  const withProject = fixture.service.store.addTicket({ status: 'open', waitingOn: 'ria', executor: 'session-board-exec', goal: 'project ticket', acceptance: 'x' })
  const fallback = fixture.service.store.addTicket({ status: 'open', waitingOn: 'ria', executor: 'session-board-exec', goal: 'fallback ticket', acceptance: 'x' })
  controller.v2.setTicketMeta(withProject.ticketId, { projectCwd: workspace })

  const board = await fixture.service.boardData({})
  const expectedProject = projectKey(workspace)
  const expectedFallback = projectKey(executorCwd)
  assert.notEqual(expectedProject, expectedFallback)

  const projectView = board.tickets.find(ticket => ticket.ticketId === withProject.ticketId)
  const fallbackView = board.tickets.find(ticket => ticket.ticketId === fallback.ticketId)
  assert.equal(projectView.projectKey, expectedProject, 'ticket projectKey wins over executor cwd')
  assert.equal(projectView.projectCwd, workspace)
  assert.equal(fallbackView.projectKey, expectedFallback, 'executor cwd is the fallback')
  assert.equal(fallbackView.projectCwd, '')

  const projectColumn = board.projects.find(project => project.projectKey === expectedProject)
  const fallbackColumn = board.projects.find(project => project.projectKey === expectedFallback)
  assert.ok(projectColumn, 'ticket projectKey becomes a project column')
  assert.ok(fallbackColumn, 'executor cwd still yields a fallback column')
  assert.notEqual(projectColumn.projectId, fallbackColumn.projectId)
  assert.ok(projectColumn.topics.some(topic => topic.tickets.some(ticket => ticket.ticketId === withProject.ticketId)))
  assert.ok(fallbackColumn.topics.some(topic => topic.tickets.some(ticket => ticket.ticketId === fallback.ticketId)))

  // Badge source (project.projectKey) and grouping source are the same value.
  assert.equal(projectColumn.projectKey, projectView.projectKey)
  assert.equal(fallbackColumn.projectKey, fallbackView.projectKey)
  console.log('board projectKey priority ok')
} finally {
  fixture.cleanup()
}
