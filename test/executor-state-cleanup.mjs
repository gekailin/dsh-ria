import assert from 'node:assert/strict'
import { createFixture } from './support/ria-fixture.mjs'

// Executor runtime state: a turn that ended must leave the row idle/null, a
// startup pass must heal historical dirty pointers, and an automatic dispatch
// that loses its final recheck must retry once with that Executor excluded.

const tick = () => new Promise(resolve => setTimeout(resolve, 0))

async function plannedTicket(fixture) {
  const controller = fixture.service.controller
  const chat = controller.state.chatSessionId
  const request = await fixture.callAs(chat, 'ria_chat_request', { goal: 'executor state cleanup probe' })
  assert.equal(request.ok, true, JSON.stringify(request))
  const advisor = controller.advisor('global').sessionId
  const plan = await fixture.callAs(advisor, 'ria_ticket_plan', { ticketId: request.ticketId, summary: 'work', steps: ['step'] })
  assert.equal(plan.ok, true, JSON.stringify(plan))
  return { ticketId: request.ticketId, advisor, chat, controller }
}

async function setupExecutor(fixture, { ticketStatus = 'working', reason = { kind: 'completed' } } = {}) {
  const controller = fixture.service.controller
  const executor = await controller.ensureExecutor('global')
  const ticket = fixture.service.store.addTicket({
    status: ticketStatus, waitingOn: ticketStatus === 'done' ? 'none' : 'executor', executor: executor.sessionId,
    goal: 'owned by an executor', acceptance: 'x',
  })
  controller.state.addExecutor(executor.sessionId, { status: 'working', currentTicketId: ticket.ticketId })
  controller.state.requestExecutorStop(executor.sessionId, { ticketId: ticket.ticketId, reason: 'test marker' })
  controller.turnStartedAt.set(executor.sessionId, Date.now())
  return { controller, executor, ticket, reason }
}

// 1) A completed turn with only a progress report keeps the ticket working, but
// the executor row is no longer busy: idle, no current ticket, no turn marker,
// no stop marker and no manager inbox.
{
  const fixture = await createFixture({ state: true })
  try {
    const { controller, executor, ticket } = await setupExecutor(fixture)
    controller.state.addReport({
      reportId: 'report_progress_cleanup', ticketId: ticket.ticketId, executorId: executor.sessionId,
      status: 'progress', summary: 'still working', evidence: [], question: '', at: Date.now(),
    })
    const consumed = controller.onSessionEvent({ header: { id: executor.sessionId } }, {
      type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } },
    })
    assert.equal(consumed, true)
    await tick()
    const row = controller.state.executor(executor.sessionId)
    assert.equal(row.status, 'idle', 'turn/end resets status')
    assert.equal(row.currentTicketId, null, 'turn/end clears currentTicketId')
    assert.equal(controller.turnStartedAt.has(executor.sessionId), false, 'turn/end clears the active-turn marker')
    assert.equal(controller.state.executorStop(executor.sessionId), null, 'turn/end clears stopRequest')
    assert.deepEqual(controller.state.pendingInbox(ticket.ticketId, executor.sessionId), [], 'turn/end leaves no inbox queue')
    assert.equal(fixture.service.store.ticket(ticket.ticketId).status, 'blocked', 'no report/text settles empty_turn')
    console.log('executor turn/end cleanup ok')
  } finally { fixture.cleanup() }
}

// 2) Abort and tool-error turn endings clean the same runtime fields.
for (const [kind, expected, reason] of [
  ['aborted', 'blocked', { kind: 'aborted', reason: { kind: 'user' } }],
  ['error', 'failed', { kind: 'error', message: 'tool exploded' }],
]) {
  const fixture = await createFixture({ state: true })
  try {
    const { controller, executor, ticket } = await setupExecutor(fixture)
    controller.onSessionEvent({ header: { id: executor.sessionId } }, {
      type: 'turn/end', data: { turn: 2, reason },
    })
    await tick()
    const row = controller.state.executor(executor.sessionId)
    assert.equal(row.status, 'idle', kind + ' resets status')
    assert.equal(row.currentTicketId, null, kind + ' clears currentTicketId')
    assert.equal(controller.turnStartedAt.has(executor.sessionId), false, kind + ' clears active turn')
    assert.equal(controller.state.executorStop(executor.sessionId), null, kind + ' clears stopRequest')
    assert.equal(fixture.service.store.ticket(ticket.ticketId).status, expected)
    console.log('executor ' + kind + ' cleanup ok')
  } finally { fixture.cleanup() }
}

// 3) A closed Session clears the binding even when the ticket settlement is
// forced to no-op (ticket already terminal).
{
  const fixture = await createFixture({ state: true })
  try {
    const { controller, executor, ticket } = await setupExecutor(fixture, { ticketStatus: 'done' })
    controller.onSessionEvent({ header: { id: executor.sessionId } }, { type: 'session/ended', data: { reason: { kind: 'disposed' } } })
    await tick()
    const row = controller.state.executor(executor.sessionId)
    assert.equal(row.status, 'idle')
    assert.equal(row.currentTicketId, null)
    assert.equal(controller.turnStartedAt.has(executor.sessionId), false)
    console.log('executor session closed cleanup ok')
  } finally { fixture.cleanup() }
}

// 4) Startup reconcile: working without a ticket and host idle -> idle; a dirty
// currentTicketId pointing at a terminal/missing ticket -> cleared for any
// status; both passes are idempotent.
{
  const fixture = await createFixture({ state: true })
  try {
    const controller = fixture.service.controller
    const working = await controller.ensureExecutor('global')
    controller.state.addExecutor(working.sessionId, { status: 'working', currentTicketId: null })
    fixture.setRunning(working.sessionId, false)
    assert.equal(await controller.reconcileExecutorStates(), 1, 'working + no ticket repaired')
    assert.equal(controller.state.executor(working.sessionId).status, 'idle')
    assert.equal(await controller.reconcileExecutorStates(), 0, 'second reconcile is a no-op')

    const terminalTicket = fixture.service.store.addTicket({ status: 'done', goal: 'closed', acceptance: 'x', executor: working.sessionId })
    controller.state.addExecutor(working.sessionId, { status: 'idle', currentTicketId: terminalTicket.ticketId })
    controller.state.requestExecutorStop(working.sessionId, { ticketId: terminalTicket.ticketId, reason: 'stale' })
    // The dirty currentTicketId makes the first Executor non-selectable, so this
    // call creates a distinct second Executor.
    const missing = await controller.ensureExecutor('global')
    assert.notEqual(missing.sessionId, working.sessionId)
    controller.state.addExecutor(missing.sessionId, { status: 'working', currentTicketId: 'ticket_missing_probe' })
    const repaired = await controller.reconcileExecutorStates()
    assert.ok(repaired >= 2, 'dirty pointers repaired: ' + repaired)
    for (const id of [working.sessionId, missing.sessionId]) {
      const row = controller.state.executor(id)
      assert.equal(row.status, 'idle', 'dirty pointer resets status: ' + id)
      assert.equal(row.currentTicketId, null, 'dirty pointer cleared: ' + id)
      assert.equal(controller.state.executorStop(id), null, 'same-ticket stop cleared: ' + id)
    }
    assert.equal(await controller.reconcileExecutorStates(), 0, 'dirty-pointer repair is idempotent')

    // A stale stopRequest on a healthy row is cleared without touching the row.
    controller.state.requestExecutorStop(working.sessionId, { ticketId: terminalTicket.ticketId, reason: 'orphan stop' })
    assert.equal(await controller.reconcileExecutorStates(), 1, 'orphan stop marker repaired')
    assert.equal(controller.state.executorStop(working.sessionId), null)
    assert.equal(controller.state.executor(working.sessionId).status, 'idle')
    assert.equal(await controller.reconcileExecutorStates(), 0, 'orphan-stop repair is idempotent')
    console.log('executor startup reconcile ok')
  } finally { fixture.cleanup() }
}

// 5) Reconcile must never rewrite a coManagement registration.
{
  const fixture = await createFixture({
    state: true,
    extraSessions: [{ sessionId: 'session-cm-cleanup', running: false, blank: false, updatedAt: 1, cwd: '/work/cm', projections: { values: { title: 'CM Cleanup' } } }],
  })
  try {
    const controller = fixture.service.controller
    const chat = controller.state.chatSessionId
    const added = await fixture.callAs(chat, 'ria_chat_co_manage', { action: 'add', sessionId: 'session-cm-cleanup' })
    assert.equal(added.ok, true, JSON.stringify(added))
    const before = JSON.stringify(controller.state.data.coManagement)
    const stale = fixture.service.store.addTicket({ status: 'cancelled', goal: 'cancelled', acceptance: 'x', executor: 'session-cm-cleanup' })
    controller.state.addExecutor('session-cm-cleanup', { status: 'idle', currentTicketId: stale.ticketId })
    await controller.reconcileExecutorStates()
    assert.equal(controller.state.executor('session-cm-cleanup').currentTicketId, null)
    assert.equal(JSON.stringify(controller.state.data.coManagement), before, 'coManagement registration is untouched')
    assert.ok(controller.coManagement.active('session-cm-cleanup'))
    console.log('executor reconcile keeps coManagement ok')
  } finally { fixture.cleanup() }
}

// 6) Automatic dispatch retries once after dispatch_recheck_failed, excluding
// the Executor that lost the race. The retry runs the real selection path.
{
  const fixture = await createFixture({ state: true })
  try {
    const { ticketId, controller } = await plannedTicket(fixture)
    const first = await controller.ensureExecutor('global')
    const second = await controller.ensureExecutor('global', null, undefined, null, null, null, { avoidExecutorIds: new Set([first.sessionId]) })
    assert.notEqual(second.sessionId, first.sessionId)
    const avoided = await controller.ensureExecutor('global', null, undefined, null, null, null, { avoidExecutorIds: new Set([first.sessionId]) })
    assert.equal(avoided.sessionId, second.sessionId, 'avoid set excludes the first candidate')
    let calls = 0
    let retryOptions = null
    const original = controller.dispatchTicketReserved.bind(controller)
    controller.dispatchTicketReserved = async (id, requested, note, reservation, options = {}) => {
      calls += 1
      if (calls === 1) return { ok: false, code: 'dispatch_recheck_failed', message: 'race', ticketId: id, executorSessionId: first.sessionId }
      retryOptions = options
      return await original(id, requested, note, reservation, options)
    }
    try {
      const result = await controller.dispatchTicket(ticketId, '')
      assert.equal(result.ok, true, JSON.stringify(result))
      assert.equal(result.retriedAfterRecheck, true)
      assert.equal(calls, 2, 'exactly one retry')
      assert.ok(retryOptions.avoidExecutorIds instanceof Set)
      assert.ok(retryOptions.avoidExecutorIds.has(first.sessionId))
      assert.notEqual(result.executorSessionId, first.sessionId)
      const events = fixture.service.routerEvents.query({ ticketId, limit: 100 }).events
      assert.ok(events.some(event => event.event === 'dispatch.recheck.retry' && event.payload.avoidedExecutorIds.includes(first.sessionId)))
      console.log('executor dispatch recheck retry ok')
    } finally {
      controller.dispatchTicketReserved = original
    }
  } finally { fixture.cleanup() }
}
