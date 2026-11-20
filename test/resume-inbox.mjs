import assert from 'node:assert/strict'
import { createFixture } from './support/ria-fixture.mjs'

// Model host queue semantics explicitly: queue prompts sent to a running Worker
// are next-turn items, NOT inputs to its current step. Production resume must
// avoid that path and remain in the same durable inbox used by steer.
let scenarios = 0
const deliveryModes = ['immediate', 'pre-step', 'done-retry']
const observedModes = new Set()
const run = async (name, body) => {
  const fixture = await createFixture({ state: true })
  const controller = fixture.service.controller
  const chatbot = controller.state.chatSessionId
  const host = { running: false, nextTurn: [], inputs: [], attempts: [] }
  const worker = (await controller.ensureWorker('global')).sessionId
  controller.state.addWorker(worker, { status: 'idle', currentTicketId: null })
  const ticket = fixture.service.store.addTicket({ status: 'working', executor: worker, goal: name })
  const ticketId = ticket.ticketId
  controller.state.setTicketMeta(ticketId, { phase: 'working', workerId: worker })
  controller.state.setWorkOrder(ticketId, { ticketId, summary: 'mock inbox delivery', steps: ['consume messages'], acceptance: 'inbox empty' })
  const originalPrompt = fixture.ctx.sessionController.prompt.bind(fixture.ctx.sessionController)
  fixture.ctx.sessionController.prompt = async (request, signal) => {
    if (request.sessionId === worker) {
      host.attempts.push(request)
      const target = host.running ? host.nextTurn : host.inputs
      target.push(request)
    }
    return originalPrompt(request, signal)
  }
  const running = value => {
    host.running = value
    fixture.setRunning(worker, value)
    if (value) controller.turnStartedAt.set(worker, Date.now())
    else controller.turnStartedAt.delete(worker)
  }
  const park = () => {
    const moved = fixture.service.store.transitionTicket(ticketId, 'blocked', {
      actor: 'worker', executor: worker, waitingOn: 'user', blockedReason: 'mock decision', reason: 'test park',
    })
    assert.equal(moved.ok, true)
  }
  const resume = message => fixture.callAs(chatbot, 'chatbot_resume', { ticketId, message })
  const steer = message => fixture.callAs(chatbot, 'chatbot_steer', { ticketId, message })
  const step = async () => fixture.emit('agent/pre-step', { agent: fixture.agentFor(worker), turn: 1, step: 2 },
    async () => ({ kind: 'enter', messages: [] }))
  const events = () => fixture.service.routerEvents.query({ ticketId }).events
  const inbox = () => controller.state.pendingInbox(ticketId, worker)
  const context = { fixture, controller, chatbot, worker, ticketId, host, running, park, resume, steer, step, events, inbox }
  try {
    await body(context)
    const delivered = events().filter(event => event.event === 'steer.delivered')
    const deliveredIds = delivered.flatMap(event => {
      assert.ok(deliveryModes.includes(event.payload.deliveryMode), 'only the three automatic delivery modes may consume inbox messages')
      observedModes.add(event.payload.deliveryMode)
      return event.payload.inboxIds
    })
    assert.equal(deliveredIds.length, new Set(deliveredIds).size, 'no inbox message may be delivered twice')
    scenarios++
    console.log('PASS resume/steer inbox: ' + name)
  } finally { fixture.cleanup() }
}

await run('idle resume is consumed immediately once, with no host next-turn item', async h => {
  h.park()
  h.running(false)
  h.controller.state.addWorker(h.worker, { status: 'idle', currentTicketId: null })
  const result = await h.resume('resume-immediate-token')
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(result.deliveryMode, 'immediate')
  assert.equal(h.host.inputs.length, 1)
  assert.match(h.host.inputs[0].content[0].text, /resume-immediate-token/)
  assert.match(h.host.inputs[0].content[0].text, /\[Worker brief\]/)
  assert.deepEqual(h.host.nextTurn, [])
  assert.deepEqual(h.inbox(), [])
  assert.ok(h.events().some(event => event.event === 'steer.delivered' && event.payload.deliveryMode === 'immediate' && event.payload.source === 'resume'))
  // A following boundary or done cannot replay the already consumed reply.
  assert.deepEqual((await h.step()).messages, [])
  const done = await h.fixture.callAs(h.worker, 'worker_report', { ticketId: h.ticketId, status: 'done', summary: 'consumed', evidence: ['mock input'] })
  assert.equal(done.ok, true)
  assert.equal(h.host.inputs.length, 1)
})

await run('busy resume and steer share the very next pre-step input', async h => {
  h.running(true)
  h.park()
  const resumed = await h.resume('resume-pre-step-token')
  assert.equal(resumed.ok, true, JSON.stringify(resumed))
  assert.equal(resumed.deliveryMode, 'pre-step')
  const steered = await h.steer('steer-pre-step-token')
  assert.equal(steered.ok, true)
  assert.equal(h.inbox().length, 2)
  assert.deepEqual(h.host.nextTurn, [])
  assert.equal(h.host.attempts.length, 0, 'no busy queue prompt is allowed')
  const decision = await h.step()
  assert.equal(decision.messages.length, 1)
  const message = decision.messages[0]
  assert.equal(message.source.form, 'steer')
  assert.equal(message.source.source, 'mixed')
  assert.deepEqual(message.source.sources, ['resume', 'steer'])
  assert.match(message.content[0].text, /resume-pre-step-token/)
  assert.match(message.content[0].text, /steer-pre-step-token/)
  assert.deepEqual(h.inbox(), [])
  const delivered = h.events().find(event => event.event === 'steer.delivered')
  assert.equal(delivered.payload.deliveryMode, 'pre-step')
  assert.deepEqual(delivered.payload.messages.map(item => item.source), ['resume', 'steer'])
  assert.ok(delivered.payload.messages.every(item => item.workerId === h.worker && item.ticketId === h.ticketId))
  assert.deepEqual((await h.step()).messages, [])
  assert.equal(h.host.attempts.length, 0)
})

await run('done with unconsumed resume prompts one additional turn and consumes it', async h => {
  h.running(true)
  h.park()
  assert.equal((await h.resume('resume-done-token')).ok, true)
  assert.equal(h.inbox().length, 1)
  const done = await h.fixture.callAs(h.worker, 'worker_report', { ticketId: h.ticketId, status: 'done', summary: 'first turn finished', evidence: ['test'] })
  assert.equal(done.ok, true, JSON.stringify(done))
  assert.equal(h.host.nextTurn.length, 1)
  assert.match(h.host.nextTurn[0].content[0].text, /resume-done-token/)
  h.running(false)
  h.host.inputs.push(...h.host.nextTurn.splice(0))
  assert.equal(h.host.inputs.length, 1)
  assert.deepEqual(h.host.nextTurn, [])
  assert.deepEqual(h.inbox(), [])
  assert.ok(h.events().some(event => event.event === 'steer.delivered' && event.payload.deliveryMode === 'done-retry' && event.payload.source === 'resume'))
})

await run('completed turn without done drains remaining resume as done-retry', async h => {
  h.running(true)
  h.park()
  assert.equal((await h.resume('resume-turn-end-token')).ok, true)
  h.running(false)
  h.controller.onSessionEvent({ header: { id: h.worker } }, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  // Await the actual shared delivery rather than a real timeout/polling loop.
  const pendingDelivery = h.controller.steerDeliveryLocks.get(h.worker)
  if (pendingDelivery) await pendingDelivery
  assert.equal(h.host.inputs.length, 1)
  assert.match(h.host.inputs[0].content[0].text, /resume-turn-end-token/)
  assert.deepEqual(h.inbox(), [])
  assert.ok(h.events().some(event => event.event === 'steer.delivered' && event.reason === 'turn-end' && event.payload.deliveryMode === 'done-retry'))
  assert.equal(h.fixture.service.store.ticket(h.ticketId).status, 'working')
})

await run('done-retry exhaustion blocks and notifies, without losing resume', async h => {
  h.running(true)
  h.park()
  await h.resume('undelivered-resume-token')
  const attempts = []
  const original = h.fixture.ctx.sessionController.prompt.bind(h.fixture.ctx.sessionController)
  h.fixture.ctx.sessionController.prompt = async (request, signal) => {
    if (request.sessionId === h.worker) { attempts.push(request); throw new Error('mock worker unavailable') }
    return original(request, signal)
  }
  const done = await h.fixture.callAs(h.worker, 'worker_report', { ticketId: h.ticketId, status: 'done', summary: 'finish', evidence: ['test'] })
  assert.equal(done.ok, false)
  assert.equal(done.code, 'steer_undelivered')
  assert.equal(attempts.length, 2, 'reuse STEER_MAX_DELIVERY_ATTEMPTS=2')
  assert.equal(attempts[0].requestId, attempts[1].requestId)
  assert.deepEqual(attempts[0].content, attempts[1].content)
  assert.equal(h.fixture.service.store.ticket(h.ticketId).status, 'blocked')
  assert.equal(h.fixture.service.store.ticket(h.ticketId).waitingOn, 'user')
  assert.equal(h.inbox().length, 1)
  assert.ok(h.events().some(event => event.event === 'steer.undelivered' && event.payload.attempts === 2 && event.payload.source === 'resume'))
  assert.ok(h.fixture.prompts.some(prompt => prompt.sessionId === h.chatbot && prompt.content[0].text.includes('指令没送到')))
})

await run('idle resume exhaustion uses the same blocked/undelivered mechanism', async h => {
  h.park()
  h.running(false)
  h.controller.state.addWorker(h.worker, { status: 'idle', currentTicketId: null })
  const original = h.fixture.ctx.sessionController.prompt.bind(h.fixture.ctx.sessionController)
  let attempts = 0
  h.fixture.ctx.sessionController.prompt = async (request, signal) => {
    if (request.sessionId === h.worker) { attempts++; throw new Error('mock idle unavailable') }
    return original(request, signal)
  }
  const resumed = await h.resume('idle-failure-token')
  assert.equal(resumed.ok, false)
  assert.equal(resumed.code, 'steer_undelivered')
  assert.equal(attempts, 2)
  assert.equal(h.fixture.service.store.ticket(h.ticketId).status, 'blocked')
  assert.equal(h.fixture.service.store.ticket(h.ticketId).waitingOn, 'user')
  assert.equal(h.inbox().length, 1)
  assert.ok(h.events().some(event => event.event === 'steer.undelivered' && event.payload.source === 'resume'))
  assert.ok(h.fixture.prompts.some(prompt => prompt.sessionId === h.chatbot && prompt.content[0].text.includes('指令没送到')))
})

await run('in-flight immediate admission is not injected again at pre-step', async h => {
  const original = h.fixture.ctx.sessionController.prompt.bind(h.fixture.ctx.sessionController)
  let release
  let entered
  const gate = new Promise(resolve => { release = resolve })
  const admitting = new Promise(resolve => { entered = resolve })
  h.fixture.ctx.sessionController.prompt = async (request, signal) => {
    if (request.sessionId === h.worker) {
      entered()
      await gate
    }
    return original(request, signal)
  }
  const sending = h.steer('in-flight-token')
  await admitting
  assert.equal(h.inbox().length, 1)
  assert.deepEqual((await h.step()).messages, [])
  release()
  assert.equal((await sending).ok, true)
  assert.deepEqual(h.inbox(), [])
  assert.equal(h.host.attempts.length, 1)
  assert.equal(h.events().filter(event => event.event === 'steer.delivered').length, 1)
})

await run('pre-step consuming during asynchronous idle probe is not replayed', async h => {
  const original = h.fixture.ctx.sessionController.state.bind(h.fixture.ctx.sessionController)
  let injected = false
  h.fixture.ctx.sessionController.state = async (request, signal) => {
    if (request.sessionId === h.worker && !injected && h.inbox().length) {
      injected = true
      const decision = await h.step()
      assert.match(decision.messages[0].content[0].text, /probe-race-token/)
    }
    return original(request, signal)
  }
  const result = await h.steer('probe-race-token')
  assert.equal(result.ok, true)
  assert.deepEqual(h.inbox(), [])
  assert.equal(h.host.attempts.length, 0)
  assert.equal(h.events().filter(event => event.event === 'steer.delivered').length, 1)
  assert.equal(h.events().find(event => event.event === 'steer.delivered').payload.deliveryMode, 'pre-step')
})

await run('cancellation while a delivery fails stops retry and keeps it discarded', async h => {
  const original = h.fixture.ctx.sessionController.prompt.bind(h.fixture.ctx.sessionController)
  let attempts = 0
  h.fixture.ctx.sessionController.prompt = async (request, signal) => {
    if (request.sessionId === h.worker) {
      attempts++
      const stopped = await h.fixture.callAs(h.chatbot, 'chatbot_stop_ticket', { ticketId: h.ticketId, reason: 'cancel pending delivery' })
      assert.equal(stopped.ok, true)
      throw new Error('cancel won admission')
    }
    return original(request, signal)
  }
  await h.steer('cancel-token')
  assert.equal(attempts, 1)
  assert.equal(h.fixture.service.store.ticket(h.ticketId).status, 'cancelled')
  assert.deepEqual(h.inbox(), [])
  assert.ok(h.controller.state.data.inbox.find(entry => entry.ticketId === h.ticketId).discardedAt)
  assert.equal(h.events().filter(event => event.event === 'steer.delivered').length, 0)
})

for (const mode of deliveryModes) {
  await run('steer regression: ' + mode, async h => {
    h.running(mode !== 'immediate')
    const steered = await h.steer('steer-' + mode + '-token')
    assert.equal(steered.ok, true)
    if (mode === 'pre-step') {
      const decision = await h.step()
      assert.match(decision.messages[0].content[0].text, /steer-pre-step-token/)
    } else if (mode === 'done-retry') {
      const done = await h.fixture.callAs(h.worker, 'worker_report', { ticketId: h.ticketId, status: 'done', summary: 'done', evidence: ['test'] })
      assert.equal(done.ok, true)
    }
    assert.deepEqual(h.inbox(), [])
    assert.ok(h.events().some(event => event.event === 'steer.delivered' && event.payload.source === 'steer' && event.payload.deliveryMode === mode))
  })
}

assert.deepEqual([...observedModes].sort(), deliveryModes.slice().sort(), 'all three automatic paths are exercised')
console.log(JSON.stringify({ resumeSteerScenarios: scenarios, deliveryModes, realWorkers: 0, realRequests: 0, mockOnly: true }))
