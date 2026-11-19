import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createFixture } from './support/ria-fixture.mjs'

// Steer is injected at the turn's step boundary: after the current tool call
// returns and before the next model step starts. No worker_checkpoint or done
// report is needed, and nothing reaches into a running tool.
const fixture = await createFixture({ v2Default: true })
try {
  const controller = fixture.service.v2
  const store = fixture.service.store
  const chatbot = controller.v2.chatbotSessionId
  const worker = (await controller.ensureWorker('global')).sessionId
  controller.v2.addWorker(worker, { status: 'idle', currentTicketId: null })
  const events = () => {
    try {
      return readFileSync(join(fixture.stateDir, 'router-events.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
    } catch { return [] }
  }
  const newTicket = goal => {
    const ticket = store.addTicket({ status: 'working', executor: worker, goal })
    controller.v2.setTicketMeta(ticket.ticketId, { phase: 'working', workerId: worker })
    controller.v2.setWorkOrder(ticket.ticketId, { ticketId: ticket.ticketId, summary: 'plan', steps: ['do it'], acceptance: 'ok' })
    return ticket
  }
  const preStep = async (baseMessages = [], turn = 7, step = 2) => fixture.emit(
    'agent/pre-step',
    { agent: fixture.agentFor(worker), turn, step },
    async () => ({ kind: 'enter', messages: baseMessages }),
  )

  // 1. A steer written mid-turn is consumed at the very next pre-step.
  const first = newTicket('pre-step delivery')
  fixture.setRunning(worker, true)
  const before = fixture.prompts.length
  await fixture.callAs(chatbot, 'chatbot_steer', { ticketId: first.ticketId, message: 'use staging from now on' })
  assert.equal(controller.v2.pendingInbox(first.ticketId, worker).length, 1)
  // Mid-tool: no prompt, no steer, no interruption.
  assert.equal(fixture.prompts.length, before)
  assert.equal(fixture.steered.length, 0)
  const decision = await preStep()
  assert.equal(decision.kind, 'enter')
  assert.equal(decision.messages.length, 1, 'exactly one merged host message')
  const injected = decision.messages[0]
  assert.equal(injected.source.form, 'steer')
  assert.equal(injected.source.source, 'steer')
  assert.equal(injected.source.ticketId, first.ticketId)
  assert.ok(injected.source.inboxId)
  assert.ok(injected.content[0].text.includes('use staging from now on'))
  assert.equal(controller.v2.pendingInbox(first.ticketId, worker).length, 0)
  assert.ok(events().some(item => item.event === 'steer.delivered'
    && item.ticketId === first.ticketId
    && item.payload.deliveryMode === 'pre-step'
    && item.payload.inboxIds.length === 1))
  assert.equal(fixture.prompts.length, before, 'pre-step delivery does not prompt the worker')

  // 2. A batch is merged into one message, at most 3 per step.
  const second = newTicket('batch merge')
  fixture.setRunning(worker, true)
  for (const message of ['one', 'two', 'three', 'four']) {
    await fixture.callAs(chatbot, 'chatbot_steer', { ticketId: second.ticketId, message })
  }
  assert.equal(controller.v2.pendingInbox(second.ticketId, worker).length, 4)
  const batch = await preStep()
  assert.equal(batch.messages.length, 1)
  assert.equal(batch.messages[0].source.inboxIds.length, 3)
  assert.ok(batch.messages[0].content[0].text.includes('one'))
  assert.ok(batch.messages[0].content[0].text.includes('three'))
  assert.ok(!batch.messages[0].content[0].text.includes('four'))
  assert.equal(controller.v2.pendingInbox(second.ticketId, worker).length, 1)
  const next = await preStep()
  assert.equal(next.messages[0].source.inboxIds.length, 1)
  assert.ok(next.messages[0].content[0].text.includes('four'))
  assert.equal(controller.v2.pendingInbox(second.ticketId, worker).length, 0)

  // 3. Nothing is injected while a tool is still running: the inbox survives
  //    until a pre-step boundary is reached, and no steer API is used.
  const third = newTicket('tool boundary')
  fixture.setRunning(worker, true)
  await fixture.callAs(chatbot, 'chatbot_steer', { ticketId: third.ticketId, message: 'after the tool' })
  const promptsDuringTool = fixture.prompts.length
  const steeredDuringTool = fixture.steered.length
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(controller.v2.pendingInbox(third.ticketId, worker).length, 1, 'kept while the tool runs')
  assert.equal(fixture.prompts.length, promptsDuringTool)
  assert.equal(fixture.steered.length, steeredDuringTool)
  const afterTool = await preStep()
  assert.ok(afterTool.messages[0].content[0].text.includes('after the tool'))

  // 4. The checkpoint path reports deliveryMode=checkpoint.
  const fourth = newTicket('checkpoint delivery')
  fixture.setRunning(worker, true)
  await fixture.callAs(chatbot, 'chatbot_steer', { ticketId: fourth.ticketId, message: 'read at checkpoint' })
  const checkpoint = await fixture.callAs(worker, 'worker_checkpoint', { ticketId: fourth.ticketId })
  assert.equal(checkpoint.ok, true)
  assert.equal(checkpoint.messages.length, 1)
  assert.equal(controller.v2.pendingInbox(fourth.ticketId, worker).length, 0)
  assert.ok(events().some(item => item.event === 'steer.delivered'
    && item.ticketId === fourth.ticketId
    && item.payload.deliveryMode === 'checkpoint'))

  // 5. A whole turn that never reaches a boundary still retries before done.
  const fifth = newTicket('done retry')
  fixture.setRunning(worker, true)
  await fixture.callAs(chatbot, 'chatbot_steer', { ticketId: fifth.ticketId, message: 'never consumed' })
  const done = await fixture.callAs(worker, 'worker_report', { ticketId: fifth.ticketId, status: 'done', summary: 'finished', evidence: ['test'] })
  assert.equal(done.ok, true, JSON.stringify(done))
  assert.equal(store.ticket(fifth.ticketId).status, 'done')
  assert.equal(controller.v2.pendingInbox(fifth.ticketId, worker).length, 0)
  assert.ok(events().some(item => item.event === 'steer.delivered'
    && item.ticketId === fifth.ticketId
    && item.payload.deliveryMode === 'done-retry'))

  console.log('v2 steer pre-step ok')
} finally {
  fixture.cleanup()
}
