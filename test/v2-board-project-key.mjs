import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createFixture } from './support/ria-fixture.mjs'
import { projectKey } from '../lib/v2/cognition.mjs'

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
