import assert from 'node:assert/strict'
import { advisorPlanSystemPrompt, detectToolCallTraces, parseAdvisorOutput } from '../lib/core/advisor.mjs'
import { createFixture } from './support/ria-fixture.mjs'

const eventsFor = (fixture, ticketId) => fixture.service.routerEvents.query({ ticketId, limit: 100 }).events

// Prompt has no tool-reading requirement.
const prompt = advisorPlanSystemPrompt()
assert.equal(prompt.includes('ria_ticket_read'), false)
assert.ok(prompt.includes('工单内容已在输入中'))

// Detection unit check.
assert.equal(detectToolCallTraces('<tool_call>{"name":"ria_ticket_read"}</tool_call>'), true)
assert.equal(detectToolCallTraces('<Grep path="x"/>'), true)
assert.equal(detectToolCallTraces('{"action":"plan"}'), false)
assert.equal(parseAdvisorOutput('<tool_call>{"name":"ria_ticket_read"}</tool_call>').code, 'advisor_attempted_tool_call')

// topic missing event, unchanged return shape.
{
  const fixture = await createFixture({ stateDefault: true })
  try {
    const controller = fixture.service.controller
    const ticket = controller.service.store.addTicket({ status: 'open', waitingOn: 'ria', executor: 'advisor', goal: 'topic missing', acceptance: 'x' })
    const result = await controller.assignTicketTopic(ticket, {}, null)
    assert.deepEqual(result, { ok: true, skipped: 'none' })
    const event = eventsFor(fixture, ticket.ticketId).find(item => item.event === 'topic.auto_assign.degraded')
    assert.ok(event)
    assert.equal(event.payload.code, 'topic_missing')
    assert.equal(event.payload.ticketId, ticket.ticketId)
  } finally { fixture.cleanup() }
}

// First tool call then valid plan: exactly two calls, retry system prompt augmented.
{
  let calls = 0
  const fixture = await createFixture({
    stateDefault: true,
    llmReply: () => {
      calls += 1
      return calls === 1
        ? '<tool_call>{"name":"ria_ticket_read","arguments":{}}</tool_call>'
        : JSON.stringify({ action: 'plan', workOrder: { summary: 'retry plan', steps: ['do'] } })
    },
  })
  try {
    const controller = fixture.service.controller
    const ticket = controller.service.store.addTicket({ status: 'open', waitingOn: 'ria', executor: 'advisor', goal: 'retry', acceptance: 'x' })
    const result = await controller.planTicketStateless(ticket, {})
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.equal(result.workOrder.summary, 'retry plan')
    assert.equal(fixture.llmCalls.length, 2)
    assert.match(fixture.llmCalls[1].system, /禁止输出任何 tool_call/)
  } finally { fixture.cleanup() }
}

// Tool calls twice: failure event + request path blocked, never working.
{
  const fixture = await createFixture({ stateDefault: true, advisorPlan: 'stateless', llmReply: '<Grep path="src/foo.js"/>' })
  try {
    const controller = fixture.service.controller
    const chat = controller.state.chatSessionId
    const request = await controller.requestTicket({ goal: 'tool call twice' }, { agent: { id: chat } }, { mode: 'work' })
    assert.equal(request.ok, false, JSON.stringify(request))
    const ticket = controller.service.store.ticket(request.ticketId)
    assert.equal(ticket.status, 'blocked')
    assert.notEqual(ticket.status, 'working')
    assert.equal(fixture.llmCalls.length, 2)
    const event = eventsFor(fixture, request.ticketId).find(item => item.event === 'advisor.plan.tool_call')
    assert.ok(event)
    assert.equal(event.payload.code, 'advisor_attempted_tool_call')
  } finally { fixture.cleanup() }
}

console.log('advisor tool call handling ok')
