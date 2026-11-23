import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createFixture } from './support/ria-fixture.mjs'

const fixture = await createFixture({ stateDefault: true })
try {
  const controller = fixture.service.controller
  const chat = controller.state.chatSessionId
  const request = await controller.requestTicket({ goal: 'reflect canonical', acceptance: 'report' }, { agent: { id: chat } }, { mode: 'reflection' })
  assert.equal(request.ok, true, JSON.stringify(request))
  const forDate = '2026-11-20'
  controller.state.setTicketMeta(request.ticketId, { reflectionForDate: forDate })
  const advisor = controller.advisor('global').sessionId
  const plan = await fixture.callAs(advisor, 'ria_ticket_plan', { ticketId: request.ticketId, summary: 'reflect', steps: ['read'] })
  assert.equal(plan.ok, true, JSON.stringify(plan))
  const dispatched = await fixture.callAs(advisor, 'ria_ticket_dispatch', { ticketId: request.ticketId })
  assert.equal(dispatched.ok, true, JSON.stringify(dispatched))
  const summary = '# 反思报告\n\ncanonical body'
  const report = await fixture.callAs(dispatched.executorSessionId, 'ria_worker_report', {
    ticketId: request.ticketId, status: 'done', summary, evidence: ['artifacts/report.md'],
  })
  assert.equal(report.ok, true, JSON.stringify(report))
  const target = join(fixture.stateDir, 'reflections', forDate + '.md')
  assert.ok(existsSync(target))
  const written = readFileSync(target, 'utf8')
  assert.match(written, /canonical body/)
  assert.match(written, /artifacts\/report\.md/)

  const service = fixture.service
  const same = service.writeReflectionCanonicalFromTicket(request.ticketId, { summary, evidence: ['artifacts/report.md'] })
  assert.equal(same.skipped, true)
  assert.equal(same.reason, 'same_content')
  const before = readFileSync(target, 'utf8')
  const different = service.writeReflectionCanonicalFromTicket(request.ticketId, { summary: 'different report', evidence: ['other.md'] })
  assert.equal(different.skipped, false)
  assert.equal(different.reason, 'different_content')
  assert.ok(existsSync(different.executorPath))
  assert.equal(readFileSync(target, 'utf8'), before)
  console.log('reflection canonical ok')
} finally {
  fixture.cleanup()
}
