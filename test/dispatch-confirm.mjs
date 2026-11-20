import assert from 'node:assert/strict'
import { createFixture } from './support/ria-fixture.mjs'

const unconfirmed = service => service.outbox.all().filter(entry => entry.kind === 'dispatch_unconfirmed')

async function setup() {
  const fixture = await createFixture({ state: true })
  const chat = fixture.service.controller.state.chatSessionId
  return { fixture, chat }
}

// Dispatch through the real state path (ria_chat_request -> ria_ticket_plan ->
// ria_ticket_dispatch) so the attempt record is exactly the one production writes.
async function dispatch(fixture, chat, goal = 'ship the thing') {
  const made = await fixture.callAs(chat, 'ria_chat_request', { goal })
  assert.equal(made.ok, true)
  const advisor = fixture.service.controller.advisor('global').sessionId
  const plan = await fixture.callAs(advisor, 'ria_ticket_plan', { ticketId: made.ticketId, summary: 'do the work' })
  assert.equal(plan.ok, true)
  const sent = await fixture.callAs(advisor, 'ria_ticket_dispatch', { ticketId: made.ticketId })
  assert.equal(sent.ok, true)
  return { ticketId: made.ticketId, workerId: sent.workerSessionId }
}

function expire(fixture, ticketId) {
  const ticket = fixture.service.store.ticket(ticketId)
  ticket.attempt.startedAt = Date.now() - 61_000
  fixture.service.store.save()
  return ticket
}

// 1. The real confirmation signal is the worker turn/start. state handles that
// event itself; it must confirm the attempt instead of only returning true and
// letting the legacy hook skip. An expired attempt that really started must
// never be parked as dispatch_unconfirmed.
{
  const { fixture, chat } = await setup()
  try {
    const { ticketId, workerId } = await dispatch(fixture, chat)
    const ticket = expire(fixture, ticketId)
    assert.equal(ticket.attempt.confirmedAt, undefined)
    fixture.service.onSessionEvent(
      { header: { id: workerId } },
      { type: 'turn/start', data: { turn: 2 } },
    )
    assert.equal(typeof ticket.attempt.confirmedAt, 'number')
    assert.equal(fixture.service.reconcileDispatchConfirmations('test'), 0)
    assert.equal(fixture.service.store.ticket(ticketId).status, 'working')
    assert.equal(unconfirmed(fixture.service).length, 0)
  } finally {
    fixture.cleanup()
  }
}

// 2. A ria_worker_report(progress) is equally hard evidence: those events can be
// observed without a turn/start, and the report path must confirm before the
// sweep runs. The reconcile scan also treats an existing progress record as
// one-time evidence, covering a lost confirmation from an older build.
{
  const { fixture, chat } = await setup()
  try {
    const { ticketId, workerId } = await dispatch(fixture, chat)
    const reported = await fixture.callAs(workerId, 'ria_worker_report', {
      ticketId,
      status: 'progress',
      summary: 'baseline checked',
      next: 'edit the code',
    })
    assert.equal(reported.ok, true)
    let ticket = fixture.service.store.ticket(ticketId)
    assert.equal(typeof ticket.attempt.confirmedAt, 'number')
    assert.equal(expire(fixture, ticketId).status, 'working')

    // Simulate a lost/older confirmation: the durable progress record is the
    // fallback evidence, so the scan confirms instead of blocking.
    delete ticket.attempt.confirmedAt
    fixture.service.store.save()
    assert.equal(ticket.progress.lastEventAt >= ticket.attempt.startedAt, true)
    assert.equal(fixture.service.reconcileDispatchConfirmations('test'), 0)
    ticket = fixture.service.store.ticket(ticketId)
    assert.equal(ticket.status, 'working')
    assert.equal(typeof ticket.attempt.confirmedAt, 'number')
    assert.equal(unconfirmed(fixture.service).length, 0)
  } finally {
    fixture.cleanup()
  }
}

// 3. A dispatch that really never started must still be caught: no turn/start,
// no report, no progress -> blocked(environment) with a readable reason and the
// durable local alert.
{
  const { fixture, chat } = await setup()
  try {
    const { ticketId } = await dispatch(fixture, chat)
    expire(fixture, ticketId)
    assert.equal(fixture.service.reconcileDispatchConfirmations('test'), 1)
    const ticket = fixture.service.store.ticket(ticketId)
    assert.equal(ticket.status, 'blocked')
    assert.equal(ticket.waitingOn, 'environment')
    assert.equal(ticket.failure.code, 'dispatch_unconfirmed')
    assert.match(ticket.blockedReason, /60 秒内未开始执行/)
    assert.ok(ticket.blockedReason.includes(ticket.attempt.lastRequestId))
    const alerts = unconfirmed(fixture.service)
    assert.equal(alerts.length, 1)
    assert.equal(alerts[0].payload.ticketId, ticketId)
    assert.ok(alerts[0].payload.note.includes(ticket.attempt.lastRequestId))
    // The same expired attempt must never alert twice.
    assert.equal(fixture.service.reconcileDispatchConfirmations('test'), 0)
    assert.equal(unconfirmed(fixture.service).length, 1)
  } finally {
    fixture.cleanup()
  }
}

console.log('state dispatch confirm ok')
