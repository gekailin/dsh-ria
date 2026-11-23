import assert from 'node:assert/strict'
import { createFixture } from './support/ria-fixture.mjs'
import { ADVISOR_MAX_TOKENS, ADVISOR_TIMEOUT_MS } from '../lib/core/advisor.mjs'

const makeTicket = controller => controller.service.store.addTicket({
  status: 'open', waitingOn: 'ria', executor: 'advisor', goal: 'advisor error test', acceptance: 'x',
})
const eventsFor = (fixture, ticketId) => fixture.service.routerEvents.query({ ticketId, limit: 100 }).events

// 1) finishReason=length -> truncated event + advisor_output_truncated.
{
  const fixture = await createFixture({ stateDefault: true, llmReply: 'partial plan', llmFinishReason: 'length' })
  try {
    const controller = fixture.service.controller
    const ticket = makeTicket(controller)
    await assert.rejects(controller.planTicketStateless(ticket, {}), error => error.code === 'advisor_output_truncated')
    const event = eventsFor(fixture, ticket.ticketId).find(item => item.event === 'advisor.plan.truncated')
    assert.ok(event, 'missing advisor.plan.truncated')
    for (const key of ['model', 'effort', 'maxTokens', 'inputChars', 'outputChars', 'durationMs', 'finishReason']) assert.ok(key in event.payload, key)
    assert.equal(event.payload.maxTokens, ADVISOR_MAX_TOKENS)
    assert.equal(event.payload.finishReason, 'length')
  } finally { fixture.cleanup() }
}

// 2) hard timeout -> timeout event, ticket never working.
{
  const fixture = await createFixture({ stateDefault: true })
  try {
    const controller = fixture.service.controller
    const ticket = makeTicket(controller)
    controller.callAdvisorModel = async () => {
      const error = Object.assign(new Error('fake hard timeout'), {
        code: 'advisor_timeout', model: 'model-x', reasoningEffort: 'high', latencyMs: ADVISOR_TIMEOUT_MS,
      })
      throw error
    }
    await assert.rejects(controller.planTicketStateless(ticket, {}), error => error.code === 'advisor_timeout')
    assert.notEqual(controller.service.store.ticket(ticket.ticketId).status, 'working')
    const event = eventsFor(fixture, ticket.ticketId).find(item => item.event === 'advisor.plan.timeout')
    assert.ok(event, 'missing advisor.plan.timeout')
    assert.equal(event.payload.maxTokens, ADVISOR_MAX_TOKENS)
    for (const key of ['model', 'effort', 'durationMs']) assert.ok(key in event.payload, key)
  } finally { fixture.cleanup() }
}

// 2a) actual hard-timeout race: a stream that never settles must reject fast
// with the injected budget (20ms) and never hang.
{
  const fixture = await createFixture({ stateDefault: true })
  try {
    const controller = fixture.service.controller
    controller.resolveAdvisorModel = async () => ({ provider: 'provider-ok', model: 'model-fast', reasoningEffort: '' })
    controller.service.routerLlm = {
      async *stream() { await new Promise(() => {}) },
    }
    const started = Date.now()
    await assert.rejects(controller.callAdvisorModel({ system: 's', user: 'u', timeoutMs: 20 }), error => error.code === 'advisor_timeout')
    assert.ok(Date.now() - started < 2000, 'hard timeout did not fire promptly')
  } finally { fixture.cleanup() }
}

// 2a2) fake clock: two attempts share one 60s deadline.
{
  const fixture = await createFixture({ stateDefault: true })
  try {
    const controller = fixture.service.controller
    controller.resolveAdvisorModel = async () => ({ provider: 'provider-ok', model: 'model-fake', reasoningEffort: '' })
    let now = 1000
    let calls = 0
    const delays = []
    const realNow = Date.now
    const realSetTimeout = globalThis.setTimeout
    Date.now = () => now
    globalThis.setTimeout = (_fn, ms) => { delays.push(ms); return 1 }
    controller.service.routerLlm = {
      async *stream() {
        calls += 1
        if (calls === 1) now += 40_000
        throw new Error('fake stream failure')
      },
    }
    try {
      await assert.rejects(controller.callAdvisorModel({ system: 's', user: 'u', timeoutMs: 60_000 }), error => error.code === 'advisor_model_failed')
      assert.equal(delays.at(-1), 20_000, 'attempt 2 must get only the remaining budget')
      assert.ok(delays.slice(0, -1).every(ms => ms === 60_000), 'no attempt may restart the full budget')
    } finally {
      Date.now = realNow
      globalThis.setTimeout = realSetTimeout
    }
  } finally { fixture.cleanup() }
}

// 2b) request path catches timeout and parks the ticket blocked.
{
  const fixture = await createFixture({ stateDefault: true, advisorPlan: 'stateless' })
  try {
    const controller = fixture.service.controller
    const chat = controller.state.chatSessionId
    controller.callAdvisorModel = async () => {
      const error = Object.assign(new Error('fake hard timeout'), { code: 'advisor_timeout', model: 'model-x', latencyMs: ADVISOR_TIMEOUT_MS })
      throw error
    }
    const request = await controller.requestTicket({ goal: 'timeout request' }, { agent: { id: chat } }, { mode: 'work' })
    assert.equal(request.ok, false)
    const ticket = controller.service.store.ticket(request.ticketId)
    assert.equal(ticket.status, 'blocked')
    assert.notEqual(ticket.status, 'working')
  } finally { fixture.cleanup() }
}

// 3) complete non-JSON -> advisor_output_unparsable with first 200 chars.
{
  const fixture = await createFixture({ stateDefault: true, llmReply: 'this is definitely not json' })
  try {
    const controller = fixture.service.controller
    const ticket = makeTicket(controller)
    await assert.rejects(controller.planTicketStateless(ticket, {}), error => {
      assert.equal(error.code, 'advisor_output_unparsable')
      assert.match(error.message, /this is definitely not json/)
      return true
    })
    const failed = eventsFor(fixture, ticket.ticketId).find(item => item.event === 'advisor.plan.failed')
    assert.equal(failed.payload.code, 'advisor_output_unparsable')
    for (const key of ['model', 'effort', 'maxTokens', 'inputChars', 'outputChars', 'durationMs', 'finishReason']) assert.ok(key in failed.payload, key)
  } finally { fixture.cleanup() }
}

// 3b) network/stream failure keeps advisor_model_failed.
{
  const fixture = await createFixture({ stateDefault: true, llmFailures: 2 })
  try {
    const controller = fixture.service.controller
    const ticket = makeTicket(controller)
    await assert.rejects(controller.planTicketStateless(ticket, {}), error => error.code === 'advisor_model_failed')
  } finally { fixture.cleanup() }
}

// 4) normal JSON -> parsed WorkOrder and maxTokens=8000 passed to the model.
{
  const fixture = await createFixture({ stateDefault: true, llmReply: JSON.stringify({ action: 'plan', workOrder: { summary: 'normal', steps: ['do it'] } }) })
  try {
    const controller = fixture.service.controller
    const ticket = makeTicket(controller)
    const result = await controller.planTicketStateless(ticket, {})
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.equal(result.workOrder.summary, 'normal')
    assert.ok(fixture.llmCalls.length > 0)
    assert.equal(fixture.llmCalls[0].maxTokens, ADVISOR_MAX_TOKENS)
    const planned = eventsFor(fixture, ticket.ticketId).find(item => item.event === 'advisor.plan')
    assert.equal(planned.payload.maxTokens, ADVISOR_MAX_TOKENS)
    assert.equal(planned.payload.finishReason, 'stop')
    assert.equal(ADVISOR_TIMEOUT_MS, 60_000)
  } finally { fixture.cleanup() }
}

console.log('advisor errors ok')
