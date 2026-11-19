import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createFixture } from './support/ria-fixture.mjs'

const fixture = await createFixture({ v2Default: true })
const settle = () => new Promise(resolve => setTimeout(resolve, 30))
const chatbot = fixture.service.v2.v2.chatbotSessionId
const notices = () => fixture.prompts.filter(item => String(item.sessionId) === String(chatbot)).map(item => String(item.content[0].text))
const auditLines = () => {
  const file = join(fixture.stateDir, 'audit.jsonl')
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
}

try {
  await fixture.service.ensure()
  const made = await fixture.callAs(chatbot, 'chatbot_request', { goal: 'grant pending approval', acceptance: 'no cancelled' })
  const advisor = fixture.service.v2.v2.advisor('global').sessionId
  await fixture.callAs(advisor, 'ticket_plan', { ticketId: made.ticketId, summary: 'wait on approval', steps: ['approval'] })
  const dispatched = await fixture.callAs(advisor, 'ticket_dispatch', { ticketId: made.ticketId })
  const ticketId = made.ticketId
  const worker = dispatched.workerSessionId
  const ticket = () => fixture.service.store.ticket(ticketId)

  // A request that never settles by itself, exactly like a human approval
  // waiting for a click. Asked is appended first, as the host does.
  fixture.service.onSessionEvent(
    { header: { id: worker } },
    { type: 'approval/asked', time: Date.now(), data: { id: 'apr_grant_pending', toolName: 'bash', callId: 'call_grant_pending', reason: 'needs approval before grant' } },
  )
  const pendingRequest = fixture.emit(
    'approval/request',
    {
      agent: { id: worker },
      toolName: 'bash',
      callId: 'call_grant_pending',
      reason: 'needs approval before grant',
      signal: new AbortController().signal,
    },
    () => new Promise(() => {}),
  )
  await settle()
  assert.equal(ticket().status, 'blocked')
  assert.equal(ticket().waitingOn, 'approval')
  assert.ok(fixture.service.v2.pendingSettlers.size >= 1)
  assert.ok(fixture.service.v2.pendingApprovals.has('apr_grant_pending'))

  // The grant lands while the request is still pending.
  const granted = await fixture.callAs(chatbot, 'chatbot_grant', {
    action: 'set',
    sessionId: worker,
    sandboxMode: 'danger-full-access',
    approvalPolicy: 'never',
    reason: 'allow the pending request',
    kind: 'emergency',
  })
  assert.equal(granted.ok, true, JSON.stringify(granted))
  assert.equal(granted.settledApprovals.length, 1)
  assert.equal(granted.settledApprovals[0].approvalId, 'apr_grant_pending')
  const outcome = await pendingRequest
  assert.equal(outcome, 'allowed-once')

  // The host appends approval/decided after the request returns; the ticket must
  // go blocked -> open -> working without a cancelled failure.
  fixture.service.onSessionEvent(
    { header: { id: worker } },
    { type: 'approval/decided', time: Date.now(), data: { id: 'apr_grant_pending', outcome: 'allowed-once' } },
  )
  assert.equal(ticket().status, 'working')
  assert.equal(ticket().waitingOn, 'worker')
  assert.equal(ticket().failure, null)
  assert.equal(ticket().blockedReason, '')

  const grantAudit = auditLines().find(item => item.event === 'approval/decision' && item.reason === 'grant-applied' && item.approvalId === 'apr_grant_pending')
    || auditLines().find(item => item.event === 'approval/decision' && item.reason === 'grant-applied')
  assert.ok(grantAudit, 'missing grant-applied audit')
  assert.equal(grantAudit.decision, 'auto-allow')
  assert.equal(grantAudit.grantId, granted.grant.grantId)
  assert.equal(grantAudit.sessionId, worker)
  assert.equal(grantAudit.tool, 'bash')

  await settle()
  assert.ok(notices().some(text => text.includes('授权已生效') && text.includes('已放行此前挂起的请求')), 'missing grant settlement notice')

  // A late cancelled/denied event for the same approval must not undo the grant.
  {
    const beforeCancel = notices().length
    fixture.service.onSessionEvent(
      { header: { id: worker } },
      { type: 'approval/decided', time: Date.now(), data: { id: 'apr_grant_pending', outcome: 'cancelled' } },
    )
    await settle()
    assert.equal(ticket().status, 'working')
    assert.equal(ticket().failure, null)
    assert.equal(notices().slice(beforeCancel).some(text => text.includes('审批被取消')), false)
  }

  // Reverse order: cancellation arrives before the allowed-once event, but the
  // grant terminal is already recorded.
  {
    const reverse = fixture.service.store.addTicket({
      status: 'blocked', executor: worker, waitingOn: 'approval', blockedReason: 'reverse race',
    })
    const reverseId = 'apr_grant_reverse'
    fixture.service.v2.rememberApprovalTerminal(reverseId, { decision: 'grant-applied', grantId: 'grant_reverse', at: Date.now() })
    fixture.service.onSessionEvent(
      { header: { id: worker } },
      { type: 'approval/decided', time: Date.now(), data: { id: reverseId, outcome: 'cancelled' } },
    )
    assert.equal(fixture.service.store.ticket(reverse.ticketId).status, 'blocked')
    fixture.service.onSessionEvent(
      { header: { id: worker } },
      { type: 'approval/decided', time: Date.now(), data: { id: reverseId, outcome: 'allowed-once' } },
    )
    assert.equal(fixture.service.store.ticket(reverse.ticketId).status, 'working')
    assert.equal(fixture.service.store.ticket(reverse.ticketId).failure, null)
  }

  // No pending request: grant still works and must not claim it settled anything.
  await fixture.callAs(chatbot, 'chatbot_grant', { action: 'reset', grantId: granted.grant.grantId })
  const before = notices().length
  const second = await fixture.callAs(chatbot, 'chatbot_grant', {
    action: 'set',
    sessionId: worker,
    sandboxMode: 'read-only',
    reason: 'no pending request',
    kind: 'debug',
  })
  assert.equal(second.ok, true, JSON.stringify(second))
  assert.equal(second.settledApprovals, undefined)
  await settle()
  const added = notices().slice(before)
  assert.equal(added.some(text => text.includes('已放行此前挂起的请求')), false)
  await fixture.callAs(chatbot, 'chatbot_grant', { action: 'reset', grantId: second.grant.grantId })

  // Fallback: a stale pending record without a live settler cannot be settled
  // (the host only exposes AbortSignal, not its controller). It is marked
  // unresolved so the Worker/operator is told to retry; live requests always
  // have a settler and are covered by scheme A.
  const controller = fixture.service.v2
  const staleKey = controller.approvalKey(worker, 'bash', 'call_stale')
  controller.pendingApprovals.set('apr_stale', {
    ticketId,
    sessionId: worker,
    toolName: 'bash',
    reason: 'stale pending',
    askedAt: Date.now(),
    callId: 'call_stale',
    key: staleKey,
    risk: { level: 'high', reasons: ['[write-outside-workspace] stale'] },
    policy: 'auto-low',
    policySource: 'default',
    decision: 'ask',
  })
  const fallback = controller.settleApprovalsForGrant(worker, { grantId: 'grant_stale', kind: 'temporary' })
  assert.equal(fallback.settled.length, 0)
  assert.equal(fallback.unresolved.length, 1)
  assert.equal(fallback.unresolved[0].approvalId, 'apr_stale')
  assert.equal(controller.pendingApprovals.get('apr_stale').grantUnresolved, true)
  controller.pendingApprovals.delete('apr_stale')

  console.log('v2 grant pending ok')
} finally {
  fixture.cleanup()
}
