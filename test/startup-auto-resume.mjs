import assert from 'node:assert/strict'
import { createFixture } from './support/ria-fixture.mjs'

// Startup auto-resume: interrupted tickets get one automatic retry, persisted
// by meta.autoResumeCount; non-interrupted blocked tickets are untouched.

const fixture = await createFixture({ stateDefault: true })
try {
  await fixture.service.ensure()
  const controller = fixture.service.controller
  const store = fixture.service.store
  const executor = await controller.ensureExecutor('global')
  const ticket = store.addTicket({ status: 'working', executor, goal: 'auto resume probe', waitingOn: 'executor' })
  controller.state.setTicketMeta(ticket.ticketId, { phase: 'working', executorId: executor })
  controller.state.setWorkOrder(ticket.ticketId, {
    ticketId: ticket.ticketId, summary: 'resume probe', steps: ['do it'], acceptance: 'done',
  })
  controller.state.addExecutor(executor, { status: 'working', currentTicketId: ticket.ticketId })

  const nonInterrupted = store.addTicket({ status: 'blocked', executor, waitingOn: 'user', goal: 'needs user', blockedReason: 'question?' })
  controller.state.setTicketMeta(nonInterrupted.ticketId, { phase: 'blocked', executorId: executor })

  await controller.reconcileInterruptedWorkingTickets()
  const resumed = store.ticket(ticket.ticketId)
  assert.equal(resumed.status, 'working', 'interrupted ticket must auto-resume')
  assert.equal(controller.state.ticketMeta(ticket.ticketId).autoResumeCount, 1)
  const event = (name, id) => controller.service.routerEvents.query({ ticketId: id }).events.find(item => item.event === name)
  const auto = event('ticket.auto_resumed', ticket.ticketId)
  assert.ok(auto, 'ticket.auto_resumed must be emitted')
  assert.equal(auto.payload.ticketId, ticket.ticketId)
  assert.equal(auto.payload.attempt, 1)
  assert.equal(event('ticket.auto_resume.skipped', ticket.ticketId), undefined)

  // Non-interrupted blocked tickets are not touched.
  assert.equal(store.ticket(nonInterrupted.ticketId).status, 'blocked')
  assert.equal(store.ticket(nonInterrupted.ticketId).waitingOn, 'user')
  assert.equal(event('ticket.auto_resumed', nonInterrupted.ticketId), undefined)

  // A second startup sees autoResumeCount=1: it stays blocked and emits skipped.
  await controller.reconcileInterruptedWorkingTickets()
  const blockedAgain = store.ticket(ticket.ticketId)
  assert.equal(blockedAgain.status, 'blocked')
  assert.equal(blockedAgain.waitingOn, 'environment')
  assert.equal(controller.state.ticketMeta(ticket.ticketId).autoResumeCount, 1)
  const skipped = event('ticket.auto_resume.skipped', ticket.ticketId)
  assert.ok(skipped, 'second startup must emit ticket.auto_resume.skipped')
  assert.equal(skipped.payload.ticketId, ticket.ticketId)
  assert.equal(skipped.payload.reason, 'already_auto_resumed')
  assert.equal(controller.service.routerEvents.query({ ticketId: ticket.ticketId }).events
    .filter(item => item.event === 'ticket.auto_resumed').length, 1, 'never auto-resume twice')

  console.log('state startup auto resume ok')
} finally {
  fixture.cleanup()
}
