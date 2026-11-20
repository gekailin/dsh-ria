import assert from 'node:assert/strict'
import { createFixture } from './support/ria-fixture.mjs'

const flush = () => new Promise(resolve => setTimeout(resolve, 0))

const fixture = await createFixture({ stateDefault: true })
try {
  const controller = fixture.service.controller
  const store = fixture.service.store
  const notices = []
  const eventsFor = ticketId => fixture.service.routerEvents.query({ ticketId, limit: 100 }).events
  controller.notifyChat = async message => { notices.push(message); return true }

  const makeTicket = () => store.addTicket({
    status: 'open', waitingOn: 'ria', executor: 'session-worker-x',
    goal: 'notice edge test', acceptance: 'x',
  })
  const block = ticket => store.transitionTicket(ticket.ticketId, 'blocked', {
    actor: 'router', executor: 'session-worker-x', waitingOn: 'user',
    blockedReason: '问题', attention: { kind: 'question', question: '确认？' }, reason: 'test block',
  })

  // 1) One blocked edge -> exactly one delivery.
  const one = makeTicket()
  assert.equal(block(one).ok, true)
  await flush()
  assert.equal(notices.length, 1, 'one edge = one notice')
  const delivered = eventsFor(one.ticketId).find(event => event.event === 'notice.delivered')
  assert.ok(delivered)
  assert.equal(delivered.payload.edge, 'blocked.user')
  assert.equal(typeof delivered.payload.queuedAt, 'number')
  assert.equal(typeof delivered.payload.deliveredAt, 'number')

  // 2) blocked -> open -> blocked = two edges, two notices.
  assert.equal(store.transitionTicket(one.ticketId, 'open', { actor: 'user', waitingOn: 'ria', reason: 'answered' }).ok, true)
  assert.equal(block(one).ok, true)
  await flush()
  assert.equal(notices.length, 2, 'two edges = two notices')

  // 3) Enqueued then resumed before delivery -> zero delivery.
  const beforeDrain = notices.length
  const originalDrain = controller.drainPendingNotices
  controller.drainPendingNotices = async () => {}
  const pendingTicket = makeTicket()
  assert.equal(block(pendingTicket).ok, true)
  assert.equal(store.transitionTicket(pendingTicket.ticketId, 'open', { actor: 'user', waitingOn: 'ria', reason: 'resumed before delivery' }).ok, true)
  controller.drainPendingNotices = originalDrain
  await controller.drainPendingNotices()
  assert.equal(notices.length, beforeDrain, 'resume before delivery drops the tick')
  const dropped = eventsFor(pendingTicket.ticketId).find(event => event.event === 'notice.dropped')
  assert.ok(dropped)
  assert.equal(dropped.payload.reason, 'already_resumed')
  assert.equal(dropped.payload.edge, 'blocked.user')
  assert.equal(typeof dropped.payload.observedStatus, 'string')
  assert.equal(typeof dropped.payload.observedRevision, 'number')
  assert.equal(typeof dropped.payload.queuedAt, 'number')
  assert.equal(typeof dropped.payload.droppedAt, 'number')

  // 4) Approval pending check: asked edge delivers once; resolved drops later ticks.
  const approvalTicket = store.addTicket({
    status: 'blocked', waitingOn: 'approval', executor: 'session-worker-x',
    goal: 'approval notice', acceptance: 'x', blockedReason: '等待审批',
    attention: { kind: 'approval', question: '等待审批', ref: 'approval-test' },
  })
  controller.pendingApprovals.set('approval-test', {
    ticketId: approvalTicket.ticketId, sessionId: 'session-worker-x', toolName: 'bash',
    reason: 'test approval', riskLabel: { text: 'risk:high' }, policy: 'auto-low', askedAt: Date.now(),
  })
  controller.emitTicketNotice(approvalTicket, 'approval.asked', { approvalId: 'approval-test' })
  await flush()
  assert.equal(notices.length, beforeDrain + 1, 'pending approval edge delivers once')
  controller.pendingApprovals.delete('approval-test')
  controller.emitTicketNotice(approvalTicket, 'approval.asked', { approvalId: 'approval-test' })
  await flush()
  assert.equal(notices.length, beforeDrain + 1, 'resolved approval tick is dropped')
  const approvalDropped = eventsFor(approvalTicket.ticketId).find(event => event.event === 'notice.dropped' && event.payload.reason === 'approval_resolved')
  assert.ok(approvalDropped)
  assert.equal(approvalDropped.payload.edge, 'approval.asked')

  // 5) workerReport(blocked) itself does not add a second notice.
  const reportFixture = await createFixture({ stateDefault: true })
  try {
    const c = reportFixture.service.controller
    const s = reportFixture.service.store
    const chat = c.state.chatSessionId
    const request = await reportFixture.callAs(chat, 'ria_chat_request', { goal: 'report blocked', acceptance: 'x' })
    const advisor = c.advisor('global').sessionId
    await reportFixture.callAs(advisor, 'ria_ticket_plan', { ticketId: request.ticketId, summary: 'x', steps: ['x'] })
    const dispatched = await reportFixture.callAs(advisor, 'ria_ticket_dispatch', { ticketId: request.ticketId })
    assert.equal(dispatched.ok, true, JSON.stringify(dispatched))
    const reportNotices = []
    c.notifyChat = async message => { reportNotices.push(message); return true }
    const report = await reportFixture.callAs(dispatched.workerSessionId, 'ria_worker_report', {
      ticketId: request.ticketId, status: 'blocked', summary: 'need answer',
    })
    assert.equal(report.ok, true, JSON.stringify(report))
    await flush()
    assert.equal(reportNotices.length, 1, 'workerReport blocked adds no extra notice')
    assert.equal(s.ticket(request.ticketId).status, 'blocked')
  } finally { reportFixture.cleanup() }

  console.log('ticket notice edges ok')
} finally {
  fixture.cleanup()
}
