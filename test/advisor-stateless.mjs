import assert from 'node:assert/strict'
import { createFixture } from './support/ria-fixture.mjs'

const reply = request => {
  const user = String((request.messages && request.messages[0] && request.messages[0].content && request.messages[0].content[0] || {}).text || '')
  if (user.includes('ANSWER-ME')) return JSON.stringify({ action: 'answer', answer: { text: '这是答复', summary: '答复' } })
  if (user.includes('BLOCK-ME')) return JSON.stringify({ action: 'block', block: { reason: '缺信息', question: '请补充' } })
  const goal = (user.match(/目标: ([^\n]+)/) || [])[1] || 'plan'
  return JSON.stringify({ action: 'plan', workOrder: { summary: 'plan: ' + goal, steps: ['step 1'] } })
}
const fixture = await createFixture({ stateDefault: true, advisorPlan: 'stateless', llmReply: reply })
try {
  const controller = fixture.service.controller
  await controller.bootstrapCognition()
  const chat = fixture.service.controller.state.chatSessionId
  const advisorCreates = () => fixture.creates.filter(item => String(item.cwd || '').includes('/advisors'))
  const eventsFor = ticketId => fixture.service.routerEvents.query({ ticketId }).events

  const first = await fixture.callAs(chat, 'chat_request', { goal: 'alpha goal' })
  assert.equal(first.ok, true, JSON.stringify(first))
  assert.equal(first.stateless, true)
  assert.equal(controller.state.advisor('global'), null)
  assert.equal(controller.state.ticketMeta(first.ticketId).advisorSessionId, undefined)
  assert.equal(advisorCreates().length, 0)
  assert.equal(fixture.service.store.ticket(first.ticketId).status, 'working')
  const planEvents = eventsFor(first.ticketId).filter(item => item.event === 'advisor.plan')
  assert.equal(planEvents.length, 1)
  const payload = planEvents[0].payload
  assert.equal(planEvents[0].sessionId, '')
  assert.equal(payload.degraded, false)
  assert.ok(Array.isArray(payload.cognitionIds))
  assert.equal(typeof payload.latencyMs, 'number')
  assert.equal(typeof payload.attempts, 'number')
  assert.ok(payload.usage && typeof payload.usage.total === 'number')
  assert.match(payload.briefSummary, /alpha goal/)
  assert.match(payload.workOrderSummary, /alpha goal/)
  assert.ok(fixture.prompts.some(item => item.sessionId === fixture.service.store.ticket(first.ticketId).executor))

  // Two tickets are isolated; the same ticket with an existing WorkOrder does
  // not call the model again.
  const beforeCalls = fixture.llmCalls.length
  const [a, b] = await Promise.all([
    fixture.callAs(chat, 'chat_request', { goal: 'beta one' }),
    fixture.callAs(chat, 'chat_request', { goal: 'beta two' }),
  ])
  assert.equal(a.ok && b.ok, true)
  assert.match(controller.state.workOrder(a.ticketId).summary, /beta one/)
  assert.match(controller.state.workOrder(b.ticketId).summary, /beta two/)
  const callsAfterTwo = fixture.llmCalls.length
  assert.ok(callsAfterTwo >= beforeCalls + 2)
  const again = await controller.createAdvisorForTicket(fixture.service.store.ticket(a.ticketId), controller.state.ticketMeta(a.ticketId), null)
  assert.equal(fixture.llmCalls.length, callsAfterTwo)
  assert.ok(again.code === 'worker_busy' || again.code === 'ticket_not_open' || again.ok === true, JSON.stringify(again))

  // Degraded: retrieval failure is explicit in the event.
  const originalRetrieve = controller.cognition.retrieve.bind(controller.cognition)
  controller.cognition.retrieve = () => { throw new Error('retrieval down') }
  const degraded = await fixture.callAs(chat, 'chat_request', { goal: 'degraded goal' })
  controller.cognition.retrieve = originalRetrieve
  assert.equal(degraded.ok, true, JSON.stringify(degraded))
  const degradedEvent = eventsFor(degraded.ticketId).find(item => item.event === 'advisor.plan')
  assert.equal(degradedEvent.payload.degraded, true)
  assert.deepEqual(degradedEvent.payload.cognitionIds, [])

  // Block action. There is no answer action any more: every request is a work ticket.
  const blocked = await fixture.callAs(chat, 'chat_request', { goal: 'BLOCK-ME' })
  assert.equal(fixture.service.store.ticket(blocked.ticketId).status, 'blocked')
  assert.equal(fixture.service.store.ticket(blocked.ticketId).waitingOn, 'user')
  assert.equal(fixture.service.store.ticket(blocked.ticketId).attention.kind, 'question')

  // There is no Advisor session switch: every plan is one stateless LLM call.
  const statelessAgain = await fixture.callAs(chat, 'chat_request', { goal: 'stateless again' })
  assert.equal(statelessAgain.ok, true)
  assert.equal(statelessAgain.stateless, true)
  assert.equal(controller.state.advisor('global'), null)
  assert.equal(advisorCreates().length, 0)

  console.log('state advisor stateless ok')
} finally {
  fixture.cleanup()
}

// Two failed LLM attempts must fail visibly and leave the ticket blocked.
{
  const failing = await createFixture({ stateDefault: true, advisorPlan: 'stateless', llmFailures: 2 })
  try {
    const controller = failing.service.controller
    await controller.bootstrapCognition()
    const chat = failing.service.controller.state.chatSessionId
    const result = await failing.callAs(chat, 'chat_request', { goal: 'fail plan' })
    assert.equal(result.ok, false, JSON.stringify(result))
    assert.equal(result.code, 'advisor_unavailable')
    const ticket = failing.service.store.ticket(result.ticketId)
    assert.equal(ticket.status, 'blocked')
    assert.match(ticket.blockedReason || '', /Advisor 不可用/)
    const events = failing.service.routerEvents.query({ ticketId: result.ticketId }).events
    const failed = events.find(item => item.event === 'advisor.plan.failed')
    assert.ok(failed)
    assert.equal(failed.sessionId, '')
    assert.equal(failed.payload.attempts, 2)
    assert.equal(controller.state.advisor('global'), null)
    console.log('state advisor failure ok')
  } finally {
    failing.cleanup()
  }
}
