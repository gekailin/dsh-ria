import assert from 'node:assert/strict'
import { createFixture } from './support/ria-fixture.mjs'
import { classify, decideEscalation, resolveEscalationPolicy } from '../lib/core/risk.mjs'

const command = 'dsh plugin --profile web add file:/home/gkl/Desktop/vibe_proj/dsh-ria'
const result = classify({ toolName: 'bash', args: { command }, cwd: '/tmp', workspace: '/tmp' })
assert.equal(result.level, 'medium')
assert.ok(result.signals.ruleIds.includes('plugin-install'), JSON.stringify(result.signals.ruleIds))
assert.ok(result.reasons.some(reason => reason.includes('向 profile 安装/更新插件')), JSON.stringify(result.reasons))
assert.equal(decideEscalation('medium', 'auto-low-medium'), 'auto-allow')
assert.equal(decideEscalation('medium', 'strict'), 'ask')
assert.equal(resolveEscalationPolicy({ ticket: { escalationPolicy: 'auto-low-medium' } }).policy, 'auto-low-medium')

const fixture = await createFixture({ v2Default: true })
try {
  const chatbot = fixture.service.v2.v2.chatSessionId
  const created = await fixture.callAs(chatbot, 'chatbot_request', {
    goal: 'deploy the plugin',
    escalationPolicy: 'auto-low-medium',
  })
  assert.equal(created.ok, true, JSON.stringify(created))
  assert.equal(fixture.service.v2.v2.ticketMeta(created.ticketId).escalationPolicy, 'auto-low-medium')

  // Only work tickets carry an escalation policy; reflection ignores it when
  // it is passed (there is no answer mode any more).
  const reflection = await fixture.service.v2.requestTicket({
    goal: 'retrospective',
    escalationPolicy: 'auto-low-medium',
  }, { agent: { id: chatbot } }, { mode: 'reflection' })
  assert.equal(reflection.ok, true, JSON.stringify(reflection))
  assert.equal(fixture.service.v2.v2.ticketMeta(reflection.ticketId).escalationPolicy, undefined)

  const invalid = await fixture.callAs(chatbot, 'chatbot_request', {
    goal: 'bad policy',
    escalationPolicy: 'nope',
  })
  assert.equal(invalid.ok, false)
  assert.equal(invalid.code, 'invalid_escalation_policy')

  // End-to-end decision uses the ticket policy.
  const controller = fixture.service.v2
  const worker = (await controller.ensureWorker('global')).sessionId
  const ticket = fixture.service.store.addTicket({ status: 'working', executor: worker, goal: 'deploy plugin' })
  controller.v2.setTicketMeta(ticket.ticketId, { phase: 'working', escalationPolicy: 'auto-low-medium' })
  await fixture.emit('tools/pre-execute', { agent: { id: worker }, name: 'bash', callId: 'plugin-call', arguments: { command } }, async () => ({ kind: 'enter' }))
  const autoDecision = controller.evaluateApprovalRisk(worker, 'bash', 'plugin-call')
  assert.equal(autoDecision.decision, 'auto-allow')
  assert.equal(autoDecision.policy, 'auto-low-medium')
  controller.v2.setTicketMeta(ticket.ticketId, { escalationPolicy: 'strict' })
  await fixture.emit('tools/pre-execute', { agent: { id: worker }, name: 'bash', callId: 'plugin-call-strict', arguments: { command } }, async () => ({ kind: 'enter' }))
  const strictDecision = controller.evaluateApprovalRisk(worker, 'bash', 'plugin-call-strict')
  assert.equal(strictDecision.decision, 'ask')
  assert.equal(strictDecision.policy, 'strict')

  console.log('v2 risk plugin ok')
} finally {
  fixture.cleanup()
}
