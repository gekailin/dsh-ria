import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createFixture } from './support/ria-fixture.mjs'
import { advisorPlanSystemPrompt } from '../lib/core/advisor.mjs'
import { advisorPrompt, chatPrompt, sagePrompt, workerPrompt } from '../lib/core/prompts.mjs'
import { reflectionInstruction } from '../lib/reflection.mjs'
import { RIA_TOOL_NAME_SET, RIA_TOOL_NAMES, candidateWorkOrderTools } from '../lib/tools/tool-catalog.mjs'

// The catalog must mirror the actual registrations, not a hand-maintained
// allow-list that drifts from the tool surface.
const registrationSource = readFileSync(new URL('../lib/tools/registry.mjs', import.meta.url), 'utf8')
  + readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
const registered = new Set([...registrationSource.matchAll(/register\(\s*'([a-z0-9_]+)'/g)].map(match => match[1]))
for (const name of RIA_TOOL_NAMES) assert.ok(registered.has(name), 'catalog name not registered: ' + name)
for (const name of registered) assert.ok(RIA_TOOL_NAME_SET.has(name), 'registered name missing from catalog: ' + name)

const reflection = reflectionInstruction({
  runId: 'refl-test', forDate: '2026-11-20', windowStart: 1, windowEnd: 2, deadlineAt: 3,
  workerSessionId: 'session-test', attempt: 1,
})
const templates = {
  chat: chatPrompt(),
  advisor: advisorPrompt(),
  worker: workerPrompt(),
  sage: sagePrompt(),
  advisorContract: advisorPlanSystemPrompt(),
  reflection,
}
for (const [name, text] of Object.entries(templates)) {
  const tools = candidateWorkOrderTools(text)
  for (const tool of tools) assert.ok(RIA_TOOL_NAME_SET.has(tool), name + ' cites unregistered tool ' + tool)
  assert.equal(/(?<![A-Za-z0-9_])worker_checkpoint(?![A-Za-z0-9_])/.test(text), false, name + ' mentions worker_checkpoint')
  assert.equal(/(?<![A-Za-z0-9_])worker_report(?![A-Za-z0-9_])/.test(text), false, name + ' mentions old worker_report')
}

// Every tool explicitly named by the worker template can be used in a WorkOrder
// and still passes the existence check.
{
  const fixture = await createFixture({ stateDefault: true })
  try {
    const controller = fixture.service.controller
    const chat = controller.state.chatSessionId
    const request = await controller.requestTicket({ goal: 'tools known', acceptance: 'x' }, { agent: { id: chat } }, { mode: 'work' })
    const steps = candidateWorkOrderTools(workerPrompt())
    const persisted = controller.persistWorkOrder(request.ticketId, { summary: 'known tools', steps })
    assert.equal(persisted.ok, true, JSON.stringify(persisted))
    const events = fixture.service.routerEvents.query({ ticketId: request.ticketId, limit: 100 }).events
    assert.equal(events.some(event => event.event === 'workorder.unknown_tool'), false)
  } finally { fixture.cleanup() }
}

// A stale/deleted tool name produces a warning event but does not block planning
// or dispatch.
{
  const fixture = await createFixture({ stateDefault: true })
  try {
    const controller = fixture.service.controller
    const chat = controller.state.chatSessionId
    const request = await fixture.callAs(chat, 'ria_chat_request', { goal: 'unknown tool', acceptance: 'x' })
    assert.equal(request.ok, true, JSON.stringify(request))
    const advisor = controller.advisor('global').sessionId
    const plan = await fixture.callAs(advisor, 'ria_ticket_plan', {
      ticketId: request.ticketId,
      summary: 'use a removed tool',
      steps: ['Run worker_checkpoint', 'Then call ria_worker_report'],
    })
    assert.equal(plan.ok, true, JSON.stringify(plan))
    const events = fixture.service.routerEvents.query({ ticketId: request.ticketId, limit: 100 }).events
    const warning = events.find(event => event.event === 'workorder.unknown_tool')
    assert.ok(warning, JSON.stringify(events))
    assert.equal(warning.payload.tool, 'worker_checkpoint')
    assert.equal(warning.payload.source, 'ticket_plan.workorder')
    assert.equal(warning.payload.ticketId, request.ticketId)
    const dispatched = await fixture.callAs(advisor, 'ria_ticket_dispatch', { ticketId: request.ticketId })
    assert.equal(dispatched.ok, true, JSON.stringify(dispatched))
    assert.equal(fixture.service.tickets.ticket(request.ticketId).status, 'working')
    assert.equal(fixture.service.tickets.ticket(request.ticketId).blockedReason, '')
  } finally { fixture.cleanup() }
}

console.log('workorder tool names ok')
