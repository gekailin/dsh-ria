import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createFixture } from './support/ria-fixture.mjs'

const fixture = await createFixture()

function get(path) {
  const route = fixture.routes.find(item => item.path === '/plugins/dsh-ria/api')
  assert.ok(route, 'API route registered')
  const req = new EventEmitter()
  req.method = 'GET'
  req.url = path
  req.headers = { host: '127.0.0.1:3080' }
  const res = {
    statusCode: 0,
    headers: {},
    setHeader(name, value) { this.headers[name] = value },
    end(body) { this.body = body; this.done(body) },
  }
  const done = new Promise(resolve => { res.done = resolve })
  route.handler(req, res)
  return done.then(body => ({ status: res.statusCode, body: JSON.parse(body) }))
}

try {
  const upstream = await fixture.call('ria_ticket', { goal: 'write the draft', executor: 'session-worker' })
  const downstream = await fixture.call('ria_ticket', {
    goal: 'edit the draft',
    executor: 'session-worker',
    dependsOn: [upstream.ticket.ticketId],
  })
  const blocked = await fixture.call('ria_ticket', {
    goal: 'needs a decision',
    executor: 'session-worker',
    status: 'blocked',
    blockedReason: 'waiting for user',
  })
  const orphan = await fixture.call('ria_ticket', { goal: 'old ghost worker', executor: 'session-ghost' })
  const selfTicket = await fixture.call('ria_ticket', { goal: 'Ria handles this itself', executor: 'self' })

  const response = await get('/plugins/dsh-ria/api/board')
  assert.equal(response.status, 200)
  const board = response.body
  assert.equal(board.ok, true)
  assert.equal(board.riaSessionId, fixture.service.store.riaSessionId)
  assert.equal(board.counts.total, 5)
  assert.equal(board.counts.active, 5)
  assert.equal(board.counts.blocked, 1)

  const byId = new Map(board.tickets.map(ticket => [ticket.ticketId, ticket]))
  assert.equal(byId.get(upstream.ticket.ticketId).status, 'open')
  assert.equal(byId.get(downstream.ticket.ticketId).queueState, 'waiting_dependency')
  assert.deepEqual(byId.get(downstream.ticket.ticketId).dependsOn, [upstream.ticket.ticketId])
  assert.equal(byId.get(blocked.ticket.ticketId).status, 'blocked')
  assert.equal(byId.get(blocked.ticket.ticketId).blockedReason, 'waiting for user')
  assert.equal(byId.get(upstream.ticket.ticketId).executorTitle, 'Worker One')
  assert.ok(byId.get(upstream.ticket.ticketId).laneId.startsWith('path:'))

  const self = byId.get(selfTicket.ticket.ticketId)
  assert.equal(self.executor, 'self')
  assert.equal(self.laneId, 'ria')
  assert.equal(self.executorTitle, 'Ria')
  assert.equal(self.executorMissing, false)

  const ghost = byId.get(orphan.ticket.ticketId)
  assert.equal(ghost.executorMissing, true)
  assert.equal(ghost.laneId, 'unassigned')
  assert.equal(ghost.laneLabel, '未分配')

  const lanes = board.lanes.map(lane => lane.id)
  assert.ok(lanes.includes('unassigned'))
  assert.equal(board.lanes.find(lane => lane.id === 'unassigned').total, 1)

  // Broken workspace metadata must not take the endpoint down.
  const original = fixture.ctx.workspaceRegistry.list
  fixture.ctx.workspaceRegistry.list = () => { throw new Error('registry offline') }
  const tolerant = await fixture.service.boardData()
  assert.equal(tolerant.ok, true)
  assert.equal(tolerant.counts.total, 5)
  fixture.ctx.workspaceRegistry.list = original

  // An archived executor is still drawn, but flagged so the UI can say so.
  const archivedFixture = await createFixture({ archivedSessionIds: ['session-worker'] })
  try {
    await archivedFixture.call('ria_ticket', { goal: 'archived worker', executor: 'session-worker' })
    const archivedBoard = await archivedFixture.service.boardData()
    assert.equal(archivedBoard.tickets[0].executorArchived, true)
  } finally {
    archivedFixture.cleanup()
  }

  console.log('board ok')
} finally {
  fixture.cleanup()
}
