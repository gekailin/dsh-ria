import assert from 'node:assert/strict'
import { createFixture } from './support/ria-fixture.mjs'

// Model host queue semantics explicitly: queue prompts sent to a running Executor
// are next-turn items, NOT inputs to its current step. Production resume must
// avoid that path and remain in the same durable inbox used by steer.
let scenarios = 0
const deliveryModes = ['immediate', 'pre-step', 'done-retry']
const observedModes = new Set()
const run = async (name, body) => {
  const fixture = await createFixture({ state: true })
  const controller = fixture.service.controller
  const chat = controller.state.chatSessionId
  const host = { running: false, nextTurn: [], inputs: [], attempts: [] }
  const executor = (await controller.ensureExecutor('global')).sessionId
  controller.state.addExecutor(executor, { status: 'idle', currentTicketId: null })
  const ticket = fixture.service.store.addTicket({ status: 'working', executor: executor, goal: name })
  const ticketId = ticket.ticketId
  controller.state.setTicketMeta(ticketId, { phase: 'working', executorId: executor })
  controller.state.setWorkOrder(ticketId, { ticketId, summary: 'mock inbox delivery', steps: ['consume messages'], acceptance: 'inbox empty' })
  const originalPrompt = fixture.ctx.sessionController.prompt.bind(fixture.ctx.sessionController)
  fixture.ctx.sessionController.prompt = async (request, signal) => {
    if (request.sessionId === executor) {
      host.attempts.push(request)
      const target = host.running ? host.nextTurn : host.inputs
      target.push(request)
    }
    return originalPrompt(request, signal)
  }
  const running = value => {
    host.running = value
    fixture.setRunning(executor, value)
    if (value) controller.turnStartedAt.set(executor, Date.now())
    else controller.turnStartedAt.delete(executor)
  }
  const park = () => {
    const moved = fixture.service.store.transitionTicket(ticketId, 'blocked', {
      actor: 'executor', executor: executor, waitingOn: 'user', blockedReason: 'mock decision', reason: 'test park',
    })
    assert.equal(moved.ok, true)
  }
  const resume = message => fixture.callAs(chat, 'ria_chat_resume', { ticketId, message })
  const steer = message => fixture.callAs(chat, 'ria_chat_steer', { ticketId, message })
  const step = async () => fixture.emit('agent/pre-step', { agent: fixture.agentFor(executor), turn: 1, step: 2 },
    async () => ({ kind: 'enter', messages: [] }))
  const events = () => fixture.service.routerEvents.query({ ticketId }).events
  const inbox = () => controller.state.pendingInbox(ticketId, executor)
  const context = { fixture, controller, chat, executor, ticketId, host, running, park, resume, steer, step, events, inbox }
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
  h.controller.state.addExecutor(h.executor, { status: 'idle', currentTicketId: null })
  const result = await h.resume('resume-immediate-token')
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(result.deliveryMode, 'immediate')
  assert.equal(h.host.inputs.length, 1)
  assert.match(h.host.inputs[0].content[0].text, /resume-immediate-token/)
  assert.match(h.host.inputs[0].content[0].text, /\[Executor brief\]/)
  assert.deepEqual(h.host.nextTurn, [])
  assert.deepEqual(h.inbox(), [])
  assert.ok(h.events().some(event => event.event === 'steer.delivered' && event.payload.deliveryMode === 'immediate' && event.payload.source === 'resume'))
  // A following boundary or done cannot replay the already consumed reply.
  assert.deepEqual((await h.step()).messages, [])
  const done = await h.fixture.callAs(h.executor, 'ria_executor_report', { ticketId: h.ticketId, status: 'done', summary: 'consumed', evidence: ['mock input'] })
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
  assert.ok(delivered.payload.messages.every(item => item.executorId === h.executor && item.ticketId === h.ticketId))
  assert.deepEqual((await h.step()).messages, [])
  assert.equal(h.host.attempts.length, 0)
})

await run('done with unconsumed resume prompts one additional turn and consumes it', async h => {
  h.running(true)
  h.park()
  assert.equal((await h.resume('resume-done-token')).ok, true)
  assert.equal(h.inbox().length, 1)
  const done = await h.fixture.callAs(h.executor, 'ria_executor_report', { ticketId: h.ticketId, status: 'done', summary: 'first turn finished', evidence: ['test'] })
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
  h.controller.onSessionEvent({ header: { id: h.executor } }, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  // Await the actual shared delivery rather than a real timeout/polling loop.
  const pendingDelivery = h.controller.steerDeliveryLocks.get(h.executor)
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
    if (request.sessionId === h.executor) { attempts.push(request); throw new Error('mock executor unavailable') }
    return original(request, signal)
  }
  const done = await h.fixture.callAs(h.executor, 'ria_executor_report', { ticketId: h.ticketId, status: 'done', summary: 'finish', evidence: ['test'] })
  // Report records; settlement at turn/end blocks on undelivered done-retry.
  assert.equal(done.ok, true, JSON.stringify(done))
  assert.equal(done.recorded, true)
  assert.equal(attempts.length, 2, 'reuse STEER_MAX_DELIVERY_ATTEMPTS=2')
  assert.equal(attempts[0].requestId, attempts[1].requestId)
  assert.deepEqual(attempts[0].content, attempts[1].content)
  assert.equal(h.fixture.service.store.ticket(h.ticketId).status, 'blocked')
  assert.equal(h.fixture.service.store.ticket(h.ticketId).waitingOn, 'user')
  assert.equal(h.inbox().length, 1)
  assert.ok(h.events().some(event => event.event === 'steer.undelivered' && event.payload.attempts === 2 && event.payload.source === 'resume'))
  assert.ok(h.fixture.prompts.some(prompt => prompt.sessionId === h.chat && prompt.content[0].text.includes('指令没送到')))
})

await run('idle resume exhaustion uses the same blocked/undelivered mechanism', async h => {
  h.park()
  h.running(false)
  h.controller.state.addExecutor(h.executor, { status: 'idle', currentTicketId: null })
  const original = h.fixture.ctx.sessionController.prompt.bind(h.fixture.ctx.sessionController)
  let attempts = 0
  h.fixture.ctx.sessionController.prompt = async (request, signal) => {
    if (request.sessionId === h.executor) { attempts++; throw new Error('mock idle unavailable') }
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
  assert.ok(h.fixture.prompts.some(prompt => prompt.sessionId === h.chat && prompt.content[0].text.includes('指令没送到')))
})

await run('idle steer goes through native agent.steer and is not replayed at pre-step', async h => {
  const result = await h.steer('native-steer-token')
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(result.deliveryMode, 'immediate')
  assert.deepEqual(h.inbox(), [])
  assert.equal(h.host.attempts.length, 0, 'native steer must not start a host prompt turn')
  const native = h.fixture.steered.filter(message => message && message.source && String(message.source.rpcId || '').startsWith('ria_steer_'))
  assert.equal(native.length, 1, 'one native steer message')
  assert.match(native[0].content[0].text, /native-steer-token/)
  assert.equal(native[0].source.ticketId, h.ticketId)
  assert.deepEqual((await h.step()).messages, [], 'pre-step does not replay a consumed steer')
  assert.equal(h.events().filter(event => event.event === 'steer.delivered').length, 1)
})

await run('pre-step consuming during asynchronous idle probe is not replayed', async h => {
  const original = h.fixture.ctx.sessionController.state.bind(h.fixture.ctx.sessionController)
  let injected = false
  h.fixture.ctx.sessionController.state = async (request, signal) => {
    if (request.sessionId === h.executor && !injected && h.inbox().length) {
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

await run('cancellation during the idle probe drops the steer and never injects it', async h => {
  const original = h.fixture.ctx.sessionController.state.bind(h.fixture.ctx.sessionController)
  let fired = false
  let attempts = 0
  h.fixture.ctx.sessionController.state = async (request, signal) => {
    if (request.sessionId === h.executor && !fired) {
      fired = true
      attempts++
      const stopped = await h.fixture.callAs(h.chat, 'ria_chat_stop_ticket', { ticketId: h.ticketId, reason: 'cancel pending delivery' })
      assert.equal(stopped.ok, true)
    }
    return original(request, signal)
  }
  const result = await h.steer('cancel-token')
  assert.equal(result.ok, false, JSON.stringify(result))
  assert.equal(result.dropped, true)
  assert.equal(attempts, 1)
  assert.equal(h.fixture.service.store.ticket(h.ticketId).status, 'cancelled')
  assert.deepEqual(h.inbox(), [])
  assert.ok(h.controller.state.data.inbox.find(entry => entry.ticketId === h.ticketId).discardedAt)
  assert.equal(h.events().filter(event => event.event === 'steer.delivered').length, 0)
  assert.ok(h.events().some(event => event.event === 'steer.dropped_stale' && event.ticketId === h.ticketId))
})

for (const mode of ['immediate', 'pre-step']) {
  await run('steer regression: ' + mode, async h => {
    h.running(mode !== 'immediate')
    const steered = await h.steer('steer-' + mode + '-token')
    assert.equal(steered.ok, true)
    if (mode === 'pre-step') {
      const decision = await h.step()
      assert.match(decision.messages[0].content[0].text, /steer-pre-step-token/)
    }
    assert.deepEqual(h.inbox(), [])
    assert.ok(h.events().some(event => event.event === 'steer.delivered' && event.payload.source === 'steer' && event.payload.deliveryMode === mode))
  })
}

await run('steer pending at turn/end defers done settlement', async h => {
  h.running(true)
  const steered = await h.steer('steer-pending-token')
  assert.equal(steered.ok, true)
  const done = await h.fixture.callAs(h.executor, 'ria_executor_report', { ticketId: h.ticketId, status: 'done', summary: 'done', evidence: ['test'] })
  assert.equal(done.ok, true)
  assert.equal(h.fixture.service.store.ticket(h.ticketId).status, 'working', 'settlement deferred for the owned steer')
  assert.equal(h.inbox().length, 1)
  assert.ok(h.events().some(event => event.event === 'steer.settlement.deferred' && event.ticketId === h.ticketId))
  const decision = await h.step()
  assert.match(decision.messages[0].content[0].text, /steer-pending-token/)
  assert.deepEqual(h.inbox(), [])
  h.running(false)
  h.controller.onSessionEvent({ header: { id: h.executor } }, { type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } })
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(h.fixture.service.store.ticket(h.ticketId).status, 'done')
})

assert.deepEqual([...observedModes].sort(), deliveryModes.slice().sort(), 'all three automatic paths are exercised')
console.log(JSON.stringify({ resumeSteerScenarios: scenarios, deliveryModes, realExecutors: 0, realRequests: 0, mockOnly: true }))
