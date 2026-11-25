import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createFixture } from './support/ria-fixture.mjs'

const fixture = await createFixture({ stateDefault: true })
try {
  const controller = fixture.service.controller
  const chat = fixture.service.controller.state.chatSessionId
  const executor = (await controller.ensureExecutor('global')).sessionId
  controller.state.addExecutor(executor, { status: 'idle', currentTicketId: null })
  const ticket = fixture.service.store.addTicket({ status: 'working', executor: executor, goal: 'steer test' })
  controller.state.setTicketMeta(ticket.ticketId, { phase: 'working', executorId: executor })
  controller.state.setWorkOrder(ticket.ticketId, { ticketId: ticket.ticketId, summary: 'plan', steps: ['do it'], acceptance: 'ok' })
  const events = () => fixture.service.routerEvents.query({ limit: 200 }).events

  // Idle direct delivery marks the inbox entry delivered.
  const queued = await fixture.callAs(chat, 'ria_chat_steer', { ticketId: ticket.ticketId, message: 'check this' })
  assert.equal(queued.ok, true, JSON.stringify(queued))
  assert.equal(controller.state.pendingInbox(ticket.ticketId, executor).length, 0)
  assert.ok(events().some(item => item.event === 'steer.queued' && item.payload.summary === 'check this'))
  assert.ok(events().some(item => item.event === 'steer.delivered' && item.payload.deliveryMode === 'immediate' && item.payload.source === 'steer'))

  // A steer after the last step boundary is consumed by an extra prompt at done.
  await fixture.callAs(chat, 'ria_chat_steer', { ticketId: ticket.ticketId, message: 'late instruction' })
  const done = await fixture.callAs(executor, 'ria_executor_report', { ticketId: ticket.ticketId, status: 'done', summary: 'finished', evidence: ['test'] })
  assert.equal(done.ok, true, JSON.stringify(done))
  assert.equal(fixture.service.store.ticket(ticket.ticketId).status, 'done')
  assert.equal(controller.state.pendingInbox(ticket.ticketId, executor).length, 0)

  // A steer pending at turn/end defers settlement and completes inside the
  // same ticket; the second turn/end then settles the original done report.
  const second = fixture.service.store.addTicket({ status: 'working', executor: executor, goal: 'steer deferred' })
  controller.state.setTicketMeta(second.ticketId, { phase: 'working', executorId: executor })
  controller.state.setWorkOrder(second.ticketId, { ticketId: second.ticketId, summary: 'plan', steps: ['do it'] })
  fixture.setRunning(executor, true)
  await fixture.callAs(chat, 'ria_chat_steer', { ticketId: second.ticketId, message: 'still in this ticket' })
  const firstDone = await fixture.callAs(executor, 'ria_executor_report', { ticketId: second.ticketId, status: 'done', summary: 'finished', evidence: ['test'] })
  assert.equal(firstDone.ok, true, JSON.stringify(firstDone))
  assert.equal(fixture.service.store.ticket(second.ticketId).status, 'working', 'pending steer defers done settlement')
  assert.equal(controller.state.pendingInbox(second.ticketId, executor).length, 1)
  assert.ok(events().some(item => item.event === 'steer.settlement.deferred' && item.ticketId === second.ticketId))
  const decision = await fixture.emit('agent/pre-step', { agent: fixture.agentFor(executor), turn: 1, step: 2 },
    async () => ({ kind: 'enter', messages: [] }))
  assert.match(decision.messages[0].content[0].text, /still in this ticket/)
  assert.equal(controller.state.pendingInbox(second.ticketId, executor).length, 0, 'steer consumed inside the ticket')
  fixture.setRunning(executor, false)
  controller.onSessionEvent({ header: { id: executor } }, { type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } })
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(fixture.service.store.ticket(second.ticketId).status, 'done', 'second turn/end settles done after steer')

  // Resume rearm prompt failure records undelivered without silent loss.
  const third = fixture.service.store.addTicket({ status: 'working', executor: executor, goal: 'rearm failure' })
  controller.state.setTicketMeta(third.ticketId, { phase: 'working', executorId: executor })
  fixture.setPromptFailure(new Error('cannot wake'))
  const rearmed = await controller.rearmWorkingTicket(third.ticketId, executor, 'resume msg', 'chat')
  assert.equal(rearmed.ok, false)
  assert.equal(rearmed.code, 'steer_undelivered')
  assert.equal(fixture.service.store.ticket(third.ticketId).status, 'blocked')
  assert.ok(events().some(item => item.event === 'steer.undelivered' && item.ticketId === third.ticketId && item.payload.trigger === 'resume-rearm'))
  fixture.setPromptFailure(undefined)

  // Empty inbox done path remains unchanged.
  const fourth = fixture.service.store.addTicket({ status: 'working', executor: executor, goal: 'empty inbox' })
  controller.state.setTicketMeta(fourth.ticketId, { phase: 'working', executorId: executor })
  const emptyDone = await fixture.callAs(executor, 'ria_executor_report', { ticketId: fourth.ticketId, status: 'done', summary: 'finished', evidence: ['test'] })
  assert.equal(emptyDone.ok, true)
  assert.equal(fixture.service.store.ticket(fourth.ticketId).status, 'done')

  console.log('state steer inbox ok')
} finally {
  fixture.cleanup()
}
