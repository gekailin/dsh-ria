import assert from 'node:assert/strict'
import { createFixture } from './support/ria-fixture.mjs'

async function setup() {
  const fixture = await createFixture({ state: true })
  const chat = fixture.service.controller.state.chatSessionId
  return { fixture, chat }
}

async function planAndDispatch(fixture, chat, goal = 'do the work') {
  const made = await fixture.callAs(chat, 'chat_request', { goal })
  assert.equal(made.ok, true)
  const advisor = fixture.service.controller.state.advisor('global').sessionId
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
  const { fixture, chat } = await setup()
  try {
    const { ticketId, workerId } = await planAndDispatch(fixture, chat)
    const blocked = await fixture.callAs(workerId, 'worker_report', {
      ticketId,
      status: 'blocked',
      summary: 'need a format decision',
      question: 'Markdown or PDF?',
    })
    assert.equal(blocked.ok, true)
    assert.equal(fixture.service.store.ticket(ticketId).status, 'blocked')
    const before = fixture.prompts.length
    const resumed = await fixture.callAs(chat, 'chat_resume', { ticketId, message: 'use Markdown' })
    assert.equal(resumed.ok, true)
    assert.equal(resumed.status, 'working')
    assert.equal(resumed.workerSessionId, workerId)
    const ticket = fixture.service.store.ticket(ticketId)
    assert.equal(ticket.status, 'working')
    assert.equal(ticket.executor, workerId)
    assert.equal(ticket.waitingOn, 'worker')
    const sent = promptTo(fixture, workerId, before)
    assert.ok(sent, 'resume must prompt the Worker')
    assert.match(sent.content[0].text, /\[Manager resume\]/)
    assert.match(sent.content[0].text, /use Markdown/)
    assert.deepEqual(fixture.service.controller.state.pendingInbox(ticketId, workerId), [])
    const delivered = fixture.service.controller.state.data.inbox.find(item => item.ticketId === ticketId)
    assert.equal(delivered.source, 'resume')
    assert.equal(delivered.deliveryMode, 'immediate')
    assert.ok(fixture.service.routerEvents.query({ ticketId }).events.some(event =>
      event.event === 'steer.delivered' && event.payload.deliveryMode === 'immediate' && event.payload.source === 'resume'))
    assert.equal(fixture.prompts.slice(before).filter(prompt => prompt.sessionId === workerId).length, 1)
  } finally {
    fixture.cleanup()
  }
}

// 2. The exact post-incident state: the ticket was reopened to open/planned but
// no dispatch followed. Resume must be idempotent there, and steer must point
// back at resume instead of being a dead end.
{
  const { fixture, chat } = await setup()
  try {
    const { ticketId, workerId } = await planAndDispatch(fixture, chat)
    fixture.service.controller.state.addWorker(workerId, { status: 'idle', currentTicketId: null })
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
    fixture.service.controller.state.setTicketMeta(ticketId, { phase: 'planned', workerId })

    const steer = await fixture.callAs(chat, 'chat_steer', { ticketId, message: 'still there?' })
    assert.equal(steer.ok, false)
    assert.equal(steer.code, 'ticket_not_working')
    assert.match(steer.hint, /chat_resume/)

    const before = fixture.prompts.length
    const resumed = await fixture.callAs(chat, 'chat_resume', { ticketId, message: 'continue' })
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
  const { fixture, chat } = await setup()
  try {
    const { ticketId, workerId } = await planAndDispatch(fixture, chat)
    const parked = fixture.service.store.transitionTicket(ticketId, 'blocked', {
      actor: 'host',
      executor: workerId,
      waitingOn: 'environment',
      blockedReason: '派发被接受但 60 秒内未开始执行',
      failure: { code: 'dispatch_unconfirmed', message: '派发被接受但 60 秒内未开始执行' },
      reason: 'test: sweep parked a live worker',
    })
    assert.equal(parked.ok, true)
    const worker = fixture.service.controller.state.worker(workerId)
    assert.equal(worker.status, 'working')
    assert.equal(worker.currentTicketId, ticketId)
    // A working binding alone is not a live turn: model the host running signal.
    fixture.setRunning(workerId, true)

    const before = fixture.prompts.length
    const resumed = await fixture.callAs(chat, 'chat_resume', { ticketId, message: 'continue please' })
    assert.equal(resumed.ok, true)
    assert.equal(resumed.status, 'working')
    assert.equal(resumed.rearmed, true)
    assert.equal(resumed.waitingOn, 'worker')
    const ticket = fixture.service.store.ticket(ticketId)
    assert.equal(ticket.status, 'working')
    assert.equal(ticket.executor, workerId)
    assert.equal(typeof ticket.attempt.confirmedAt, 'number')
    assert.equal(typeof ticket.attempt.rearmedAt, 'number')
    // Busy resume stays in Ria's durable inbox, never the host next-turn queue.
    assert.equal(promptTo(fixture, workerId, before), undefined)
    assert.equal(fixture.service.controller.state.pendingInbox(ticketId, workerId).length, 1)
    const decision = await fixture.emit('agent/pre-step',
      { agent: fixture.agentFor(workerId), turn: 1, step: 2 },
      async () => ({ kind: 'enter', messages: [] }))
    assert.equal(decision.messages.length, 1)
    assert.match(decision.messages[0].content[0].text, /\[Manager resume\]/)
    assert.match(decision.messages[0].content[0].text, /continue please/)
    assert.equal(decision.messages[0].source.form, 'steer')
    assert.equal(decision.messages[0].source.source, 'resume')
    assert.deepEqual(fixture.service.controller.state.pendingInbox(ticketId, workerId), [])
    assert.equal(fixture.service.controller.state.data.inbox.find(item => item.ticketId === ticketId).deliveryMode, 'pre-step')
    assert.ok(fixture.service.routerEvents.query({ ticketId }).events.some(event =>
      event.event === 'steer.delivered' && event.payload.deliveryMode === 'pre-step' && event.payload.source === 'resume'))
  } finally {
    fixture.cleanup()
  }
}

// 4. A missing bound Worker stops for the user; replacement creation is forbidden.
{
  const { fixture, chat } = await setup()
  try {
    const { ticketId, workerId } = await planAndDispatch(fixture, chat)
    const blocked = await fixture.callAs(workerId, 'worker_report', {
      ticketId,
      status: 'blocked',
      summary: 'need a decision',
      question: 'which one?',
    })
    assert.equal(blocked.ok, true)
    fixture.service.controller.state.removeWorker(workerId)
    const originalCreate = fixture.ctx.sessionController.create
    fixture.ctx.sessionController.create = async request => {
      if (!request.workspaceId) throw new Error('worker create failed for test')
      return await originalCreate(request)
    }
    const resumed = await fixture.callAs(chat, 'chat_resume', { ticketId, message: 'retry' })
    assert.equal(resumed.ok, false)
    assert.equal(resumed.code, 'resume_worker_unavailable')
    assert.equal(resumed.ticketId, ticketId)
    const ticket = fixture.service.store.ticket(ticketId)
    assert.equal(ticket.status, 'blocked')
    assert.equal(ticket.waitingOn, 'user')
    assert.equal(ticket.failure.code, 'resume_worker_unavailable')
    assert.match(ticket.failure.message, /worker not found/)
    assert.match(ticket.blockedReason, /换 worker \/ 重建 worker \/ 取消/)
    assert.notEqual(ticket.status, 'open')
  } finally {
    fixture.cleanup()
  }
}

// 5. Executor is authoritative even if stale metadata names a newer idle worker.
{
  const { fixture, chat } = await setup()
  try {
    const { ticketId, workerId } = await planAndDispatch(fixture, chat)
    await fixture.callAs(workerId, 'worker_report', { ticketId, status: 'blocked', summary: 'decision', question: 'continue?' })
    fixture.service.controller.turnStartedAt.set(workerId, Date.now())
    const other = await fixture.service.controller.ensureWorker('global')
    fixture.service.controller.turnStartedAt.delete(workerId)
    assert.notEqual(other.sessionId, workerId)
    fixture.service.controller.state.setTicketMeta(ticketId, { workerId: other.sessionId })
    const resumed = await fixture.callAs(chat, 'chat_resume', { ticketId })
    assert.equal(resumed.ok, true, JSON.stringify(resumed))
    assert.equal(resumed.workerSessionId, workerId)
    assert.equal(fixture.service.store.ticket(ticketId).executor, workerId)
    assert.equal(resumed.reassigned, undefined)
  } finally { fixture.cleanup() }
}

// 6. Unavailable/archived bound workers never fall back; user decides instead.
for (const unavailable of ['archived', 'missing', 'unresolvable']) {
  const { fixture, chat } = await setup()
  try {
    const { ticketId, workerId } = await planAndDispatch(fixture, chat)
    await fixture.callAs(workerId, 'worker_report', { ticketId, status: 'blocked', summary: 'decision', question: 'continue?' })
    if (unavailable === 'archived') fixture.archivedSessions.push(workerId)
    else if (unavailable === 'missing') fixture.service.controller.state.removeWorker(workerId)
    else {
      const resolve = fixture.ctx.sessionController.resolveAgent.bind(fixture.ctx.sessionController)
      fixture.ctx.sessionController.resolveAgent = id => id === workerId ? { error: { code: 'session/not-found', message: 'test unavailable' } } : resolve(id)
    }
    const beforeCreates = fixture.creates.length
    const beforeNotices = fixture.prompts.length
    const resumed = await fixture.callAs(chat, 'chat_resume', { ticketId })
    assert.equal(resumed.ok, false, JSON.stringify(resumed))
    assert.equal(resumed.code, 'resume_worker_unavailable')
    assert.equal(resumed.workerSessionId, workerId)
    assert.equal(fixture.service.store.ticket(ticketId).executor, workerId)
    assert.equal(fixture.service.store.ticket(ticketId).waitingOn, 'user')
    assert.equal(fixture.creates.length, beforeCreates, 'no replacement worker may be created')
    assert.match(resumed.message, /指定 worker.*不可用.*需要你决定/)
    assert.ok(fixture.prompts.slice(beforeNotices).some(item => item.sessionId === chat && item.content[0].text.includes('指定 worker')))
    assert.ok(fixture.service.routerEvents.query({ ticketId }).events.some(item => item.event === 'resume.worker_unavailable'))
  } finally { fixture.cleanup() }
}

// 7. A turn finishing after its blocked report remains on that same worker.
{
  const { fixture, chat } = await setup()
  try {
    const { ticketId, workerId } = await planAndDispatch(fixture, chat)
    fixture.service.controller.turnStartedAt.set(workerId, Date.now())
    await fixture.callAs(workerId, 'worker_report', { ticketId, status: 'blocked', summary: 'decision', question: 'continue?' })
    const resumed = await fixture.callAs(chat, 'chat_resume', { ticketId, message: 'continue' })
    assert.equal(resumed.ok, true, JSON.stringify(resumed))
    assert.equal(resumed.workerSessionId, workerId)
    assert.equal(resumed.rearmed, true)
    assert.equal(fixture.service.store.ticket(ticketId).executor, workerId)
  } finally { fixture.cleanup() }
}

// 8. An unbound planned ticket still selects a worker automatically.
{
  const { fixture, chat } = await setup()
  try {
    const made = await fixture.callAs(chat, 'chat_request', { goal: 'unbound planned ticket' })
    const advisor = fixture.service.controller.state.advisor('global').sessionId
    await fixture.callAs(advisor, 'ticket_plan', { ticketId: made.ticketId, summary: 'work' })
    fixture.service.store.transitionTicket(made.ticketId, 'blocked', { actor: 'router', executor: 'advisor', waitingOn: 'user', blockedReason: 'choose' })
    const resumed = await fixture.callAs(chat, 'chat_resume', { ticketId: made.ticketId })
    assert.equal(resumed.ok, true, JSON.stringify(resumed))
    assert.ok(resumed.workerSessionId)
    assert.equal(fixture.service.store.ticket(made.ticketId).executor, resumed.workerSessionId)
  } finally { fixture.cleanup() }
}

// 9. Explicit worker reassignment automatically reapplies the ticket grant before dispatch.
{
  const { fixture, chat } = await setup()
  try {
    const permissions = new Map()
    const sessionIds = new Map()
    const resolve = fixture.ctx.sessionController.resolveAgent.bind(fixture.ctx.sessionController)
    fixture.ctx.sessionController.resolveAgent = async id => {
      const resolved = await resolve(id)
      if (resolved.agent) {
        const agent = resolved.agent
        sessionIds.set(agent.session, String(id))
        if (!permissions.has(String(id))) permissions.set(String(id), { sandbox: 'workspace-write', approval: 'ask' })
        const append = agent.session.append.bind(agent.session)
        agent.session.append = (type, data) => {
          if (type === 'sandbox/mode') permissions.get(String(id)).sandbox = data.mode
          return append(type, data)
        }
      }
      return resolved
    }
    fixture.ctx.sandboxPolicy.resolve = ({ session }) => ({ mode: permissions.get(sessionIds.get(session)).sandbox })
    fixture.ctx.sandboxPolicy.overrideOf = session => permissions.get(sessionIds.get(session)).sandbox
    fixture.ctx.approval.effectivePolicy = session => permissions.get(sessionIds.get(session)).approval
    fixture.ctx.approval.overrideOf = session => permissions.get(sessionIds.get(session)).approval
    fixture.ctx.approval.setPolicy = (agent, value) => { permissions.get(String(agent.id)).approval = value }

    const { ticketId, workerId, advisor } = await planAndDispatch(fixture, chat)
    const granted = await fixture.callAs(chat, 'chat_grant', { action: 'set', ticketId,
      sandboxMode: 'danger-full-access', approvalPolicy: 'never', reason: 'explicit ticket grant', ttlSeconds: 60 })
    assert.equal(granted.ok, true, JSON.stringify(granted))
    assert.equal(granted.grant.ticketId, ticketId)
    await fixture.callAs(workerId, 'worker_report', { ticketId, status: 'blocked', summary: 'handoff', question: 'choose worker?' })
    fixture.service.controller.turnStartedAt.set(workerId, Date.now())
    const replacement = await fixture.service.controller.ensureWorker('global')
    fixture.service.controller.turnStartedAt.delete(workerId)
    // Explicitly dispatch a chosen replacement; resume itself must never choose it.
    fixture.service.store.transitionTicket(ticketId, 'open', { actor: 'router', executor: 'advisor', waitingOn: 'ria' })
    const sent = await fixture.callAs(advisor, 'ticket_dispatch', { ticketId, workerSessionId: replacement.sessionId })
    assert.equal(sent.ok, true, JSON.stringify(sent))
    const grant = fixture.service.grants.activeForTicket(ticketId, replacement.sessionId)[0]
    assert.equal(grant.grantId, granted.grant.grantId)
    assert.equal(grant.expiresAt, granted.grant.expiresAt)
    assert.equal(permissions.get(workerId).sandbox, 'workspace-write')
    assert.equal(permissions.get(replacement.sessionId).sandbox, 'danger-full-access')
    assert.equal(permissions.get(replacement.sessionId).approval, 'never')
    assert.ok(grant.scopeKey.startsWith('ticket:'))
    await fixture.callAs(chat, 'chat_grant', { action: 'reset', grantId: grant.grantId })
    assert.equal(permissions.get(replacement.sessionId).sandbox, 'workspace-write')
    assert.equal(permissions.get(replacement.sessionId).approval, 'ask')
  } finally { fixture.cleanup() }
}

console.log('state resume ok')

// Exercise shared inbox admission and the host next-turn semantics in npm test.
await import('./resume-inbox.mjs')
