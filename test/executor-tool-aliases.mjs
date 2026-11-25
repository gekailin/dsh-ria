import assert from 'node:assert/strict'
import { createFixture } from './support/ria-fixture.mjs'

// Worker-era names and the deprecated watch alias are removed, not callable.
const fixture = await createFixture({ stateDefault: true })
try {
  const controller = fixture.service.controller
  const chat = controller.state.chatSessionId
  const chatTools = fixture.visibleTools(chat)
  for (const name of ['ria_chat_watch', 'ria_chat_worker_config']) {
    assert.equal(chatTools.includes(name), false, 'removed chat tool hidden: ' + name)
    await assert.rejects(fixture.callAs(chat, name, { action: 'list' }), /tool not installed/)
  }
  assert.ok(chatTools.includes('ria_chat_executor_config'))
  assert.ok(chatTools.includes('ria_chat_co_manage'))

  const made = await fixture.callAs(chat, 'ria_chat_request', { goal: 'removed aliases probe' })
  assert.equal(made.ok, true, JSON.stringify(made))
  const advisor = controller.advisor('global').sessionId
  const plan = await fixture.callAs(advisor, 'ria_ticket_plan', {
    ticketId: made.ticketId, summary: 'removed aliases', steps: ['report'], acceptance: 'canonical only',
  })
  assert.equal(plan.ok, true, JSON.stringify(plan))
  const dispatched = await fixture.callAs(advisor, 'ria_ticket_dispatch', { ticketId: made.ticketId })
  assert.equal(dispatched.ok, true, JSON.stringify(dispatched))
  const executor = dispatched.executorSessionId
  const executorTools = fixture.visibleTools(executor)
  assert.equal(executorTools.includes('ria_worker_report'), false)
  assert.equal(executorTools.includes('worker_report'), false)
  for (const name of ['ria_worker_report', 'worker_report']) {
    await assert.rejects(fixture.callAs(executor, name, { ticketId: made.ticketId, status: 'progress', summary: 'x' }), /tool not installed/)
  }
  const report = await fixture.callAs(executor, 'ria_executor_report', {
    ticketId: made.ticketId, status: 'progress', summary: 'canonical report works', next: 'done',
  })
  assert.equal(report.ok, true, JSON.stringify(report))
  const warnings = fixture.service.routerEvents.query({ types: ['tool.alias_warn'], limit: 100 }).events
  assert.equal(warnings.length, 0, 'no alias-warn path remains for removed names')
  console.log('executor tool aliases ok')
} finally {
  fixture.cleanup()
}
