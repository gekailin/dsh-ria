import assert from 'node:assert/strict'
import { createFixture } from './support/ria-fixture.mjs'
import { readReflectionState, writeReflectionState } from '../lib/reflection.mjs'

const reflectionPlan = async (fixture, controller) => {
  const chat = controller.state.chatSessionId
  const request = await controller.requestTicket({ goal: 'reflect on recent work', acceptance: 'report' }, { agent: { id: chat } }, { mode: 'reflection' })
  assert.equal(request.ok, true, JSON.stringify(request))
  const advisor = controller.advisor('global').sessionId
  const plan = await fixture.callAs(advisor, 'ria_ticket_plan', {
    ticketId: request.ticketId,
    summary: 'read evidence and write a retrospective',
    steps: ['ria_reflect_status', 'ria_reflect_read_context', 'ria_reflect_report'],
  })
  assert.equal(plan.ok, true, JSON.stringify(plan))
  return { request, advisor }
}

// 1) Reflection tickets must ignore requireTagMatch with an untagged pool;
// ensureReflectionWorker creates an untagged reflection Worker.
{
  const fixture = await createFixture({ stateDefault: true })
  try {
    const controller = fixture.service.controller
    const { request, advisor } = await reflectionPlan(fixture, controller)
    controller.state.setTicketMeta(request.ticketId, { routingTags: ['reflect'], requireTagMatch: true })
    const dispatched = await fixture.callAs(advisor, 'ria_ticket_dispatch', { ticketId: request.ticketId })
    assert.equal(dispatched.ok, true, JSON.stringify(dispatched))
    assert.equal(controller.state.worker(dispatched.workerSessionId).workerType, 'reflection')
    assert.deepEqual(controller.state.worker(dispatched.workerSessionId).tags || [], [])
  } finally { fixture.cleanup() }
}

// 2) The same requirement with a tagged reflection Worker already in the pool.
{
  const fixture = await createFixture({
    stateDefault: true,
    extraSessions: [{
      sessionId: 'session-reflect-tagged', running: false, blank: false, agentAvailable: true,
      updatedAt: 10, cwd: '/tmp/ria-reflect-tagged', projections: { values: { title: 'Tagged Reflection' } },
    }],
  })
  try {
    const controller = fixture.service.controller
    controller.state.addWorker('session-reflect-tagged', {
      kind: 'managed', workerType: 'reflection', status: 'idle', scope: 'global',
      cwd: '/tmp/ria-reflect-tagged', tags: ['reflect'], allowAutoDispatch: true,
    })
    const { request, advisor } = await reflectionPlan(fixture, controller)
    controller.state.setTicketMeta(request.ticketId, { routingTags: ['reflect'], requireTagMatch: true })
    const dispatched = await fixture.callAs(advisor, 'ria_ticket_dispatch', { ticketId: request.ticketId })
    assert.equal(dispatched.ok, true, JSON.stringify(dispatched))
    assert.equal(dispatched.workerSessionId, 'session-reflect-tagged')
  } finally { fixture.cleanup() }
}

// 3) A prompt failure parks the reflection ticket, writes failure/event and
// clears reflections/state.json.activeRunId.
{
  const fixture = await createFixture({ stateDefault: true })
  try {
    const controller = fixture.service.controller
    const { request, advisor } = await reflectionPlan(fixture, controller)
    const before = readReflectionState(fixture.stateDir)
    writeReflectionState(fixture.stateDir, {
      ...before, activeRunId: request.ticketId, lastRunId: request.ticketId,
      lastStatus: 'running', lastAttemptAt: Date.now(), lastError: null,
    })
    const events = []
    const originalEvent = controller.routerEvent.bind(controller)
    controller.routerEvent = event => { events.push(event); originalEvent(event) }
    controller.promptSession = async () => { throw new Error('prompt transport down') }
    const dispatched = await fixture.callAs(advisor, 'ria_ticket_dispatch', { ticketId: request.ticketId })
    assert.equal(dispatched.ok, false)
    assert.equal(dispatched.code, 'dispatch_failed')
    const ticket = fixture.service.tickets.ticket(request.ticketId)
    assert.equal(ticket.status, 'blocked')
    assert.equal(ticket.waitingOn, 'environment')
    assert.equal(ticket.failure.code, 'dispatch_failed')
    assert.match(ticket.failure.message, /prompt transport down/)
    assert.match(ticket.blockedReason, /prompt transport down/)
    const blocked = events.find(event => event.event === 'dispatch.blocked' && event.ticketId === request.ticketId)
    assert.ok(blocked, 'expected dispatch.blocked event')
    assert.equal(blocked.payload.code, 'dispatch_failed')
    assert.match(blocked.payload.message, /prompt transport down/)
    const state = readReflectionState(fixture.stateDir)
    assert.equal(state.activeRunId, null)
    assert.match(String(state.lastError), /prompt transport down/)
  } finally { fixture.cleanup() }
}

// 4) A worker that passed candidate selection but fails the final recheck must
// produce dispatch.blocked with code/message instead of silently returning.
{
  const fixture = await createFixture({ stateDefault: true })
  try {
    const controller = fixture.service.controller
    const chat = controller.state.chatSessionId
    const request = await controller.requestTicket({ goal: 'final recheck failure', acceptance: 'x' }, { agent: { id: chat } }, { mode: 'work' })
    assert.equal(request.ok, true, JSON.stringify(request))
    const advisor = controller.advisor('global').sessionId
    const plan = await fixture.callAs(advisor, 'ria_ticket_plan', { ticketId: request.ticketId, summary: 'work', steps: ['work'] })
    assert.equal(plan.ok, true, JSON.stringify(plan))
    const idle = await controller.ensureWorker('global')
    controller.ensureWorker = async () => {
      controller.state.addWorker(idle.sessionId, { status: 'working', currentTicketId: 'ticket_other' })
      return idle
    }
    const events = []
    const originalEvent = controller.routerEvent.bind(controller)
    controller.routerEvent = event => { events.push(event); originalEvent(event) }
    const dispatched = await fixture.callAs(advisor, 'ria_ticket_dispatch', { ticketId: request.ticketId })
    assert.equal(dispatched.ok, false)
    assert.equal(dispatched.code, 'dispatch_recheck_failed')
    const ticket = fixture.service.tickets.ticket(request.ticketId)
    assert.equal(ticket.status, 'blocked')
    assert.equal(ticket.waitingOn, 'environment')
    assert.equal(ticket.failure.code, 'dispatch_recheck_failed')
    const blocked = events.find(event => event.event === 'dispatch.blocked' && event.ticketId === request.ticketId)
    assert.ok(blocked, 'expected dispatch.blocked for final recheck failure')
    assert.equal(blocked.payload.code, 'dispatch_recheck_failed')
    assert.match(blocked.payload.message, /no longer selectable/)
  } finally { fixture.cleanup() }
}

console.log('reflection dispatch and failure parking ok')
