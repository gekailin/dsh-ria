import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createFixture } from './support/ria-fixture.mjs'

// New tool names are canonical; worker-era names stay callable as deprecated
// aliases for one release and every alias call is audited with caller/ticket.
const fixture = await createFixture({ stateDefault: true })
try {
  const controller = fixture.service.controller
  const chat = controller.state.chatSessionId

  const chatTools = fixture.visibleTools(chat)
  assert.ok(chatTools.includes('ria_chat_executor_config'))
  assert.equal(chatTools.includes('ria_chat_worker_config'), false, 'deprecated alias is hidden from the visible surface')

  const legacyConfig = await fixture.callAs(chat, 'ria_chat_worker_config', { action: 'get' })
  assert.equal(legacyConfig.ok, true, JSON.stringify(legacyConfig))
  assert.ok(Array.isArray(legacyConfig.executors))

  const made = await fixture.callAs(chat, 'ria_chat_request', { goal: 'exercise legacy report aliases' })
  assert.equal(made.ok, true, JSON.stringify(made))
  const advisor = controller.advisor('global').sessionId
  const plan = await fixture.callAs(advisor, 'ria_ticket_plan', {
    ticketId: made.ticketId, summary: 'alias coverage', steps: ['report'], acceptance: 'aliases work',
  })
  assert.equal(plan.ok, true, JSON.stringify(plan))
  const dispatched = await fixture.callAs(advisor, 'ria_ticket_dispatch', { ticketId: made.ticketId })
  assert.equal(dispatched.ok, true, JSON.stringify(dispatched))
  const executor = dispatched.executorSessionId
  const executorTools = fixture.visibleTools(executor)
  assert.ok(executorTools.includes('ria_executor_report'))
  assert.equal(executorTools.includes('ria_worker_report'), false)
  assert.equal(executorTools.includes('worker_report'), false)

  const legacyReport = await fixture.callAs(executor, 'ria_worker_report', {
    ticketId: made.ticketId, status: 'progress', summary: 'legacy alias works', next: 'done',
  })
  assert.equal(legacyReport.ok, true, JSON.stringify(legacyReport))
  const shortReport = await fixture.callAs(executor, 'worker_report', {
    ticketId: made.ticketId, status: 'progress', summary: 'short alias works', next: 'done',
  })
  assert.equal(shortReport.ok, true, JSON.stringify(shortReport))

  const warnings = readFileSync(join(fixture.stateDir, 'operation-events.jsonl'), 'utf8')
    .trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
    .filter(item => item.event === 'tool.alias_warn')
  const configWarn = warnings.find(item => item.alias === 'ria_chat_worker_config')
  assert.ok(configWarn, JSON.stringify(warnings))
  assert.equal(configWarn.replacement, 'ria_chat_executor_config')
  assert.equal(configWarn.caller, chat)
  assert.equal(configWarn.ticketId, null)
  const reportWarn = warnings.find(item => item.alias === 'ria_worker_report')
  assert.ok(reportWarn, JSON.stringify(warnings))
  assert.equal(reportWarn.replacement, 'ria_executor_report')
  assert.equal(reportWarn.caller, executor)
  assert.equal(reportWarn.ticketId, made.ticketId)
  const shortWarn = warnings.find(item => item.alias === 'worker_report')
  assert.ok(shortWarn, JSON.stringify(warnings))
  assert.equal(shortWarn.replacement, 'ria_executor_report')
  assert.equal(shortWarn.ticketId, made.ticketId)

  console.log('executor tool aliases ok')
} finally {
  fixture.cleanup()
}
