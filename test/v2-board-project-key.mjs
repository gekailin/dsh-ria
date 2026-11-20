import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createFixture } from './support/ria-fixture.mjs'
import { projectKey } from '../lib/roles/cognition.mjs'

// /board groups by projectKey and exposes Worker identity tags.
const workspace = '/tmp/ria-board-project-key-test'
const fixture = await createFixture({
  v2Default: true,
  extraSessions: [
    { sessionId: 'session-board-a', cwd: workspace, running: false, blank: false, updatedAt: 10, projections: { values: { title: 'Board A' } } },
    { sessionId: 'session-board-b', cwd: workspace, running: false, blank: false, updatedAt: 20, projections: { values: { title: 'Board B' } } },
  ],
})
try {
  const controller = fixture.service.v2
  const store = controller.v2
  store.addWorker('session-board-a', {
    kind: 'managed', workerType: 'work', cwd: workspace, status: 'idle',
    tags: ['frontend', 'board'], roleNote: '看板 UI', dedicated: true,
  })
  store.addWorker('session-board-b', { kind: 'managed', workerType: 'work', cwd: workspace, status: 'idle' })
  const first = fixture.service.store.addTicket({ status: 'open', waitingOn: 'ria', executor: 'session-board-a', goal: 'board a work', acceptance: 'x' })
  const second = fixture.service.store.addTicket({ status: 'open', waitingOn: 'ria', executor: 'session-board-b', goal: 'board b work', acceptance: 'x' })
  controller.v2.setTicketMeta(first.ticketId, { projectCwd: workspace })
  controller.v2.setTicketMeta(second.ticketId, { projectCwd: workspace })

  const board = await fixture.service.boardData({})
  const expectedKey = projectKey(workspace)
  const matching = board.projects.filter(project => project.projectKey === expectedKey)
  assert.equal(matching.length, 1, 'two executor lanes in one workspace merge into one projectKey project')
  assert.equal(matching[0].projectKey, expectedKey)

  const view = board.tickets.find(ticket => ticket.ticketId === first.ticketId)
  assert.ok(view)
  assert.equal(view.projectKey, expectedKey)
  assert.equal(view.projectTitle, 'ria-board-project-key-test')
  assert.deepEqual(view.executorTags, ['frontend', 'board'])
  assert.equal(view.executorRoleNote, '看板 UI')
  assert.equal(view.executorDedicated, true)
  const plain = board.tickets.find(ticket => ticket.ticketId === second.ticketId)
  assert.deepEqual(plain.executorTags, [])
  // The compact search index carries the same routing identity.
  const indexed = board.searchIndex.find(item => item.ticketId === first.ticketId)
  assert.equal(indexed.projectKey, expectedKey)
  assert.deepEqual(indexed.executorTags, ['frontend', 'board'])

  // UI hooks: a projectKey badge and a worker tags row in the ticket dialog.
  const client = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  assert.ok(client.includes('data-ria-project-key'))
  assert.ok(client.includes('executorTags'))
  console.log('v2 board projectKey ok')
} finally {
  fixture.cleanup()
}

// projectKey priority: ticket meta.projectCwd wins; executor cwd is only the fallback.
{
  const priorityWorkspace = '/tmp/ria-board-workspace-a'
  const executorCwd = '/tmp/ria-board-executor-b'
  const priorityFixture = await createFixture({
    v2Default: true,
    extraSessions: [
      { sessionId: 'session-board-exec', cwd: executorCwd, running: false, blank: false, updatedAt: 10, projections: { values: { title: 'Executor B' } } },
    ],
  })
  try {
    const controller = priorityFixture.service.v2
    const withProject = priorityFixture.service.store.addTicket({ status: 'open', waitingOn: 'ria', executor: 'session-board-exec', goal: 'project ticket', acceptance: 'x' })
    const fallback = priorityFixture.service.store.addTicket({ status: 'open', waitingOn: 'ria', executor: 'session-board-exec', goal: 'fallback ticket', acceptance: 'x' })
    controller.v2.setTicketMeta(withProject.ticketId, { projectCwd: priorityWorkspace })

    const board = await priorityFixture.service.boardData({})
    const expectedProject = projectKey(priorityWorkspace)
    const expectedFallback = projectKey(executorCwd)
    assert.notEqual(expectedProject, expectedFallback)

    const projectView = board.tickets.find(ticket => ticket.ticketId === withProject.ticketId)
    const fallbackView = board.tickets.find(ticket => ticket.ticketId === fallback.ticketId)
    assert.equal(projectView.projectKey, expectedProject, 'ticket projectKey wins over executor cwd')
    assert.equal(projectView.projectCwd, priorityWorkspace)
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
    priorityFixture.cleanup()
  }
}

