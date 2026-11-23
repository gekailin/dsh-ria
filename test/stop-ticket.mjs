import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createFixture } from './support/ria-fixture.mjs'

const eventsOf = stateDir => {
  try {
    return readFileSync(join(stateDir, 'router-events.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
  } catch { return [] }
}

// --- Hard abort path: DSH cancel() interrupts the running turn. ---
{
  const fixture = await createFixture({ stateDefault: true })
  try {
    const controller = fixture.service.controller
    const store = fixture.service.store
    const chat = controller.state.chatSessionId
    const worker = (await controller.ensureWorker('global')).sessionId
    controller.state.addWorker(worker, { status: 'idle', currentTicketId: null })
    const ticket = store.addTicket({ status: 'working', executor: worker, goal: 'stop me' })
    controller.state.setTicketMeta(ticket.ticketId, { phase: 'working', executorId: worker })
    controller.state.setWorkOrder(ticket.ticketId, { ticketId: ticket.ticketId, summary: 'plan', steps: ['long job'] })
    fixture.setRunning(worker, true)
    await fixture.callAs(chat, 'ria_chat_steer', { ticketId: ticket.ticketId, message: 'pending direction' })
    assert.equal(controller.state.pendingInbox(ticket.ticketId, worker).length, 1)

    // The guard rejects a non-Chat caller even if it reaches the method.
    const forbidden = await controller.chatStopTicket({ ticketId: ticket.ticketId, reason: 'nope' }, { agent: fixture.agentFor(worker) })
    assert.equal(forbidden.ok, false)
    assert.equal(forbidden.code, 'forbidden')
    assert.equal(store.ticket(ticket.ticketId).status, 'working')
    const stopped = await fixture.callAs(chat, 'ria_chat_stop_ticket', { ticketId: ticket.ticketId, reason: 'user changed their mind' })
    assert.equal(stopped.ok, true, JSON.stringify(stopped))
    assert.equal(stopped.hardAbort, true, JSON.stringify(stopped))
    assert.ok(stopped.message.includes('已立即停止'))
    const after = store.ticket(ticket.ticketId)
    assert.equal(after.status, 'cancelled')
    assert.equal(after.resolution.reason, 'user changed their mind')
    assert.equal(after.resolution.by, 'chat')
    assert.equal(controller.state.pendingInbox(ticket.ticketId, worker).length, 0)
    // A guard marker remains so a retained DSH queue cannot resume work.
    assert.equal(controller.state.workerStop(worker).ticketId, ticket.ticketId)
    assert.equal(controller.state.workerStop(worker).hardAbort, true)
    assert.equal(fixture.cancelCalls.length, 1)
    assert.equal(fixture.cancelCalls[0].sessionId, worker)
    const events = eventsOf(fixture.stateDir)
    const cancelled = events.filter(item => item.event === 'ticket.cancelled')
    assert.equal(cancelled.length, 1)
    assert.equal(cancelled[0].actor, 'chat')
    assert.equal(cancelled[0].payload.reason, 'user changed their mind')
    assert.equal(cancelled[0].payload.hardAbort, true)
    assert.ok(fixture.prompts.some(request => String(request.content[0].text).includes('已立即停止')))

    // A stopped ticket cannot receive another steer.
    const steer = await fixture.callAs(chat, 'ria_chat_steer', { ticketId: ticket.ticketId, message: 'late' })
    assert.equal(steer.ok, false)
    assert.equal(steer.code, 'ticket_closed')

    // Repeat stop is idempotent: ok, no second event, no second cancel call.
    const again = await fixture.callAs(chat, 'ria_chat_stop_ticket', { ticketId: ticket.ticketId, reason: 'again' })
    assert.equal(again.ok, true, JSON.stringify(again))
    assert.equal(again.idempotent, true)
    assert.equal(eventsOf(fixture.stateDir).filter(item => item.event === 'ticket.cancelled').length, 1)
    assert.equal(fixture.cancelCalls.length, 1)
    console.log('state stop hard abort ok')
  } finally {
    fixture.cleanup()
  }
}

// --- Soft stop path: no cancel API. The next pre-step ends the turn. ---
{
  const fixture = await createFixture({ stateDefault: true })
  try {
    const controller = fixture.service.controller
    const store = fixture.service.store
    const chat = controller.state.chatSessionId
    const worker = (await controller.ensureWorker('global')).sessionId
    controller.state.addWorker(worker, { status: 'idle', currentTicketId: null })
    delete fixture.ctx.sessionController.cancel
    const ticket = store.addTicket({ status: 'working', executor: worker, goal: 'soft stop' })
    controller.state.setTicketMeta(ticket.ticketId, { phase: 'working', executorId: worker })
    controller.state.setWorkOrder(ticket.ticketId, { ticketId: ticket.ticketId, summary: 'plan', steps: ['long job'] })
    fixture.setRunning(worker, true)
    const stopped = await fixture.callAs(chat, 'ria_chat_stop_ticket', { ticketId: ticket.ticketId, reason: 'deadline moved' })
    assert.equal(stopped.ok, true, JSON.stringify(stopped))
    assert.equal(stopped.hardAbort, false)
    assert.equal(stopped.abortAvailable, false)
    assert.ok(stopped.message.includes('已请求停止，当前步骤结束后生效'))
    assert.equal(store.ticket(ticket.ticketId).status, 'cancelled')
    const marker = controller.state.workerStop(worker)
    assert.ok(marker)
    assert.equal(marker.ticketId, ticket.ticketId)

    // The stop cleared the queue, and the normal steer entry point rejects a
    // closed ticket. A raw inbox row injected afterwards is never picked up by
    // the soft-stop pre-step.
    controller.state.addInbox({ id: 'inbox_late', ticketId: ticket.ticketId, executorId: worker, message: 'late direction', from: 'chat', at: Date.now() })
    const rejectedSteer = await fixture.callAs(chat, 'ria_chat_steer', { ticketId: ticket.ticketId, message: 'late' })
    assert.equal(rejectedSteer.ok, false)
    assert.equal(rejectedSteer.code, 'ticket_closed')

    const preStep = async () => fixture.emit(
      'agent/pre-step',
      { agent: fixture.agentFor(worker), turn: 3, step: 2 },
      async () => ({ kind: 'enter', messages: [] }),
    )
    const first = await preStep()
    assert.equal(first.kind, 'enter')
    assert.equal(first.messages.length, 1)
    assert.ok(first.messages[0].content[0].text.includes('终止说明'))
    assert.ok(first.messages[0].content[0].text.includes('ticket ' + ticket.ticketId))
    assert.ok(!first.messages[0].content[0].text.includes('late direction'))
    assert.equal(controller.state.pendingInbox(ticket.ticketId, worker).length, 1, 'soft stop does not consume steer')
    assert.ok(eventsOf(fixture.stateDir).some(item => item.event === 'worker.stop.enforced'
      && item.ticketId === ticket.ticketId
      && item.reason === 'cancelled-by-stop'
      && item.payload.mode === 'soft'))

    // If the worker keeps working anyway, the following boundary rejects the
    // step and clears the marker.
    const second = await preStep()
    assert.equal(second.kind, 'reject')
    assert.equal(second.reason, 'cancelled-by-stop')
    assert.equal(controller.state.workerStop(worker), null)
    console.log('state stop soft path ok')
  } finally {
    fixture.cleanup()
  }
}

// --- Idle worker: nothing to interrupt, no stale soft-stop marker. ---
{
  const fixture = await createFixture({ stateDefault: true })
  try {
    const controller = fixture.service.controller
    const store = fixture.service.store
    const chat = controller.state.chatSessionId
    const worker = (await controller.ensureWorker('global')).sessionId
    controller.state.addWorker(worker, { status: 'idle', currentTicketId: null })
    const ticket = store.addTicket({ status: 'working', executor: worker, goal: 'idle stop' })
    controller.state.setTicketMeta(ticket.ticketId, { phase: 'working', executorId: worker })
    const stopped = await fixture.callAs(chat, 'ria_chat_stop_ticket', { ticketId: ticket.ticketId, reason: 'cancel idle work' })
    assert.equal(stopped.ok, true, JSON.stringify(stopped))
    assert.equal(stopped.hardAbort, false)
    assert.equal(stopped.softStop, false)
    assert.ok(stopped.message.includes('已停止'))
    assert.equal(store.ticket(ticket.ticketId).status, 'cancelled')
    assert.equal(controller.state.workerStop(worker), null)
    console.log('state stop idle path ok')
  } finally {
    fixture.cleanup()
  }
}

// --- Done tickets are rejected and keep their status. ---
{
  const fixture = await createFixture({ stateDefault: true })
  try {
    const controller = fixture.service.controller
    const store = fixture.service.store
    const chat = controller.state.chatSessionId
    const worker = (await controller.ensureWorker('global')).sessionId
    controller.state.addWorker(worker, { status: 'idle', currentTicketId: null })
    const ticket = store.addTicket({ status: 'working', executor: worker, goal: 'already done' })
    controller.state.setTicketMeta(ticket.ticketId, { phase: 'working', executorId: worker })
    const done = await fixture.callAs(worker, 'ria_worker_report', { ticketId: ticket.ticketId, status: 'done', summary: 'finished', evidence: ['test'] })
    assert.equal(done.ok, true, JSON.stringify(done))
    const stopped = await fixture.callAs(chat, 'ria_chat_stop_ticket', { ticketId: ticket.ticketId, reason: 'too late' })
    assert.equal(stopped.ok, false)
    assert.equal(stopped.code, 'ticket_done')
    assert.equal(store.ticket(ticket.ticketId).status, 'done')
    assert.equal(eventsOf(fixture.stateDir).filter(item => item.event === 'ticket.cancelled').length, 0)
    console.log('state stop done rejection ok')
  } finally {
    fixture.cleanup()
  }
}
