import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createFixture } from './support/ria-fixture.mjs'

const fixture = await createFixture({ v2Default: true })
try {
  const controller = fixture.service.v2
  const chatbot = fixture.service.v2.v2.chatbotSessionId
  const worker = (await controller.ensureWorker('global')).sessionId
  controller.v2.addWorker(worker, { status: 'idle', currentTicketId: null })
  const ticket = fixture.service.store.addTicket({ status: 'working', executor: worker, goal: 'steer test' })
  controller.v2.setTicketMeta(ticket.ticketId, { phase: 'working', workerId: worker })
  controller.v2.setWorkOrder(ticket.ticketId, { ticketId: ticket.ticketId, summary: 'plan', steps: ['do it'], acceptance: 'ok' })
  const events = () => {
    try {
      return readFileSync(join(fixture.stateDir, 'router-events.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
    } catch { return [] }
  }

  // Idle direct delivery marks the inbox entry delivered.
  const queued = await fixture.callAs(chatbot, 'chatbot_steer', { ticketId: ticket.ticketId, message: 'check this' })
  assert.equal(queued.ok, true, JSON.stringify(queued))
  assert.equal(controller.v2.pendingInbox(ticket.ticketId, worker).length, 0)
  assert.ok(events().some(item => item.event === 'steer.queued' && item.payload.summary === 'check this'))
  assert.ok(events().some(item => item.event === 'steer.delivered' && item.payload.deliveryMode === 'immediate' && item.payload.source === 'steer'))

  // A steer after the last checkpoint is consumed by an extra prompt at done.
  await fixture.callAs(chatbot, 'chatbot_steer', { ticketId: ticket.ticketId, message: 'late instruction' })
  const done = await fixture.callAs(worker, 'worker_report', { ticketId: ticket.ticketId, status: 'done', summary: 'finished', evidence: ['test'] })
  assert.equal(done.ok, true, JSON.stringify(done))
  assert.equal(fixture.service.store.ticket(ticket.ticketId).status, 'done')
  assert.equal(controller.v2.pendingInbox(ticket.ticketId, worker).length, 0)

  // A failed delivery at done parks the ticket and emits undelivered.
  const second = fixture.service.store.addTicket({ status: 'working', executor: worker, goal: 'steer failure' })
  controller.v2.setTicketMeta(second.ticketId, { phase: 'working', workerId: worker })
  controller.v2.setWorkOrder(second.ticketId, { ticketId: second.ticketId, summary: 'plan', steps: ['do it'] })
  fixture.setRunning(worker, true)
  await fixture.callAs(chatbot, 'chatbot_steer', { ticketId: second.ticketId, message: 'never delivered' })
  fixture.setPromptFailure(new Error('worker unavailable'))
  const failedDone = await fixture.callAs(worker, 'worker_report', { ticketId: second.ticketId, status: 'done', summary: 'finished', evidence: ['test'] })
  assert.equal(failedDone.ok, false)
  assert.equal(failedDone.code, 'steer_undelivered')
  assert.equal(fixture.service.store.ticket(second.ticketId).status, 'blocked')
  assert.ok(events().some(item => item.event === 'steer.undelivered' && item.ticketId === second.ticketId && item.payload.trigger === 'done'))
  fixture.setPromptFailure(undefined)
  fixture.setRunning(worker, false)

  // Resume rearm prompt failure records undelivered without silent loss.
  const third = fixture.service.store.addTicket({ status: 'working', executor: worker, goal: 'rearm failure' })
  controller.v2.setTicketMeta(third.ticketId, { phase: 'working', workerId: worker })
  fixture.setPromptFailure(new Error('cannot wake'))
  const rearmed = await controller.rearmWorkingTicket(third.ticketId, worker, 'resume msg', 'chatbot')
  assert.equal(rearmed.ok, false)
  assert.equal(rearmed.code, 'steer_undelivered')
  assert.equal(fixture.service.store.ticket(third.ticketId).status, 'blocked')
  assert.ok(events().some(item => item.event === 'steer.undelivered' && item.ticketId === third.ticketId && item.payload.trigger === 'resume-rearm'))
  fixture.setPromptFailure(undefined)

  // Empty inbox done path remains unchanged.
  const fourth = fixture.service.store.addTicket({ status: 'working', executor: worker, goal: 'empty inbox' })
  controller.v2.setTicketMeta(fourth.ticketId, { phase: 'working', workerId: worker })
  const emptyDone = await fixture.callAs(worker, 'worker_report', { ticketId: fourth.ticketId, status: 'done', summary: 'finished', evidence: ['test'] })
  assert.equal(emptyDone.ok, true)
  assert.equal(fixture.service.store.ticket(fourth.ticketId).status, 'done')

  console.log('v2 steer inbox ok')
} finally {
  fixture.cleanup()
}
