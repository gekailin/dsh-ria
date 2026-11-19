import assert from 'node:assert/strict'
import { createFixture } from './support/ria-fixture.mjs'

async function setup() {
  const fixture = await createFixture({ v2: true })
  const chatbot = fixture.service.v2.v2.chatbotSessionId
  return { fixture, chatbot }
}

async function planAndDispatch(fixture, chatbot, goal = 'do the work') {
  const made = await fixture.callAs(chatbot, 'chatbot_request', { goal })
  assert.equal(made.ok, true)
  const advisor = fixture.service.v2.v2.advisor('global').sessionId
  const plan = await fixture.callAs(advisor, 'ticket_plan', { ticketId: made.ticketId, summary: 'execute the work order' })
  assert.equal(plan.ok, true)
  const sent = await fixture.callAs(advisor, 'ticket_dispatch', { ticketId: made.ticketId })
  assert.equal(sent.ok, true)
  return { ticketId: made.ticketId, workerId: sent.workerSessionId, advisor }
}

function promptTo(fixture, sessionId, after) {
  return fixture.prompts.slice(after).find(item => item.sessionId === sessionId)
}

// 1. Normal blocked resume: the Worker is idle, so resume must dispatch it
// again in the same call, with the user's answer travelling on that dispatch.
{
  const { fixture, chatbot } = await setup()
  try {
    const { ticketId, workerId } = await planAndDispatch(fixture, chatbot)
    const blocked = await fixture.callAs(workerId, 'worker_report', {
      ticketId,
      status: 'blocked',
      summary: 'need a format decision',
      question: 'Markdown or PDF?',
    })
    assert.equal(blocked.ok, true)
    assert.equal(fixture.service.store.ticket(ticketId).status, 'blocked')
    const before = fixture.prompts.length
    const resumed = await fixture.callAs(chatbot, 'chatbot_resume', { ticketId, message: 'use Markdown' })
    assert.equal(resumed.ok, true)
    assert.equal(resumed.status, 'working')
    assert.equal(resumed.workerSessionId, workerId)
    const ticket = fixture.service.store.ticket(ticketId)
    assert.equal(ticket.status, 'working')
    assert.equal(ticket.executor, workerId)
    assert.equal(ticket.waitingOn, 'worker')
    const sent = promptTo(fixture, workerId, before)
    assert.ok(sent, 'resume must prompt the Worker')
    assert.match(sent.content[0].text, /\[用户回复\]/)
    assert.match(sent.content[0].text, /use Markdown/)
    assert.deepEqual(
      fixture.service.v2.v2.pendingInbox(ticketId, workerId).map(item => item.message),
      ['use Markdown'],
    )
  } finally {
    fixture.cleanup()
  }
}

// 2. The exact post-incident state: the ticket was reopened to open/planned but
// no dispatch followed. Resume must be idempotent there, and steer must point
// back at resume instead of being a dead end.
{
  const { fixture, chatbot } = await setup()
  try {
    const { ticketId, workerId } = await planAndDispatch(fixture, chatbot)
    fixture.service.v2.v2.addWorker(workerId, { status: 'idle', currentTicketId: null })
    const parked = fixture.service.store.transitionTicket(ticketId, 'blocked', {
      actor: 'host',
      executor: workerId,
      waitingOn: 'environment',
      blockedReason: 'stuck before redispatch',
      failure: { code: 'dispatch_unconfirmed', message: 'stuck before redispatch' },
      reason: 'test setup',
    })
    assert.equal(parked.ok, true)
    const reopened = fixture.service.store.transitionTicket(ticketId, 'open', {
      actor: 'router',
      executor: 'advisor',
      waitingOn: 'ria',
      reason: 'test: reopened without a dispatch',
    })
    assert.equal(reopened.ok, true)
    fixture.service.v2.v2.setTicketMeta(ticketId, { phase: 'planned', workerId })

    const steer = await fixture.callAs(chatbot, 'chatbot_steer', { ticketId, message: 'still there?' })
    assert.equal(steer.ok, false)
    assert.equal(steer.code, 'ticket_not_working')
    assert.match(steer.hint, /chatbot_resume/)

    const before = fixture.prompts.length
    const resumed = await fixture.callAs(chatbot, 'chatbot_resume', { ticketId, message: 'continue' })
    assert.equal(resumed.ok, true)
    assert.equal(resumed.redispatch, true)
    assert.equal(resumed.status, 'working')
    assert.equal(resumed.workerSessionId, workerId)
    const ticket = fixture.service.store.ticket(ticketId)
    assert.equal(ticket.status, 'working')
    assert.equal(ticket.executor, workerId)
    const sent = promptTo(fixture, workerId, before)
    assert.ok(sent, 'an open/planned stuck ticket must be dispatched by resume')
    assert.match(sent.content[0].text, /continue/)
  } finally {
    fixture.cleanup()
  }
}

// 3. Same-ticket worker busy: the Worker is still executing this very ticket,
// so resume must not fail with worker_busy. It restores the ticket to working,
// queues the user's reply, and reports success.
{
  const { fixture, chatbot } = await setup()
  try {
    const { ticketId, workerId } = await planAndDispatch(fixture, chatbot)
    const parked = fixture.service.store.transitionTicket(ticketId, 'blocked', {
      actor: 'host',
      executor: workerId,
      waitingOn: 'environment',
      blockedReason: '派发被接受但 60 秒内未开始执行',
      failure: { code: 'dispatch_unconfirmed', message: '派发被接受但 60 秒内未开始执行' },
      reason: 'test: sweep parked a live worker',
    })
    assert.equal(parked.ok, true)
    const worker = fixture.service.v2.v2.worker(workerId)
    assert.equal(worker.status, 'working')
    assert.equal(worker.currentTicketId, ticketId)

    const before = fixture.prompts.length
    const resumed = await fixture.callAs(chatbot, 'chatbot_resume', { ticketId, message: 'continue please' })
    assert.equal(resumed.ok, true)
    assert.equal(resumed.status, 'working')
    assert.equal(resumed.rearmed, true)
    assert.equal(resumed.waitingOn, 'worker')
    const ticket = fixture.service.store.ticket(ticketId)
    assert.equal(ticket.status, 'working')
    assert.equal(ticket.executor, workerId)
    assert.equal(typeof ticket.attempt.confirmedAt, 'number')
    assert.equal(typeof ticket.attempt.rearmedAt, 'number')
    // The resume reply was handed to the busy worker and marked delivered, so
    // it is no longer pending for the next checkpoint.
    assert.deepEqual(fixture.service.v2.v2.pendingInbox(ticketId, workerId), [])
    assert.equal(fixture.service.v2.v2.data.inbox.find(item => item.ticketId === ticketId).deliveredAt > 0, true)
    const wake = promptTo(fixture, workerId, before)
    assert.ok(wake, 'the busy worker must receive the user reply')
    assert.match(wake.content[0].text, /\[Manager resume\]/)
    assert.match(wake.content[0].text, /continue please/)
    assert.equal(wake.mode, 'queue')
  } finally {
    fixture.cleanup()
  }
}

// 4. Exhausted redispatch: the named Worker is gone and creating a replacement
// fails. The ticket must end blocked with a durable failure, never stay
// open/planned.
{
  const { fixture, chatbot } = await setup()
  try {
    const { ticketId, workerId } = await planAndDispatch(fixture, chatbot)
    const blocked = await fixture.callAs(workerId, 'worker_report', {
      ticketId,
      status: 'blocked',
      summary: 'need a decision',
      question: 'which one?',
    })
    assert.equal(blocked.ok, true)
    fixture.service.v2.v2.removeWorker(workerId)
    const originalCreate = fixture.ctx.sessionController.create
    fixture.ctx.sessionController.create = async request => {
      if (!request.workspaceId) throw new Error('worker create failed for test')
      return await originalCreate(request)
    }
    const resumed = await fixture.callAs(chatbot, 'chatbot_resume', { ticketId, message: 'retry' })
    assert.equal(resumed.ok, false)
    assert.equal(resumed.code, 'dispatch_failed')
    assert.equal(resumed.ticketId, ticketId)
    const ticket = fixture.service.store.ticket(ticketId)
    assert.equal(ticket.status, 'blocked')
    assert.equal(ticket.waitingOn, 'environment')
    assert.equal(ticket.failure.code, 'dispatch_failed')
    assert.match(ticket.failure.message, /worker create failed/)
    assert.match(ticket.blockedReason, /重新派发失败/)
    assert.notEqual(ticket.status, 'open')
  } finally {
    fixture.cleanup()
  }
}

console.log('v2 resume ok')
