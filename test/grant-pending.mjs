import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createFixture } from './support/ria-fixture.mjs'

const fixture = await createFixture({ stateDefault: true })
const settle = () => new Promise(resolve => setTimeout(resolve, 30))
const chat = fixture.service.controller.state.chatSessionId
const notices = () => fixture.prompts.filter(item => String(item.sessionId) === String(chat)).map(item => String(item.content[0].text))
const auditLines = () => {
  const file = join(fixture.stateDir, 'audit.jsonl')
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
}

try {
  await fixture.service.ensure()
  const made = await fixture.callAs(chat, 'ria_chat_request', { goal: 'grant pending approval', acceptance: 'no cancelled' })
  const advisor = fixture.service.controller.advisor('global').sessionId
  await fixture.callAs(advisor, 'ria_ticket_plan', { ticketId: made.ticketId, summary: 'wait on approval', steps: ['approval'] })
  const dispatched = await fixture.callAs(advisor, 'ria_ticket_dispatch', { ticketId: made.ticketId })
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
  assert.ok(fixture.service.controller.pendingSettlers.size >= 1)
  assert.ok(fixture.service.controller.pendingApprovals.has('apr_grant_pending'))

  // The grant lands while the request is still pending.
  const granted = await fixture.callAs(chat, 'ria_chat_grant', {
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
  assert.equal(ticket().status, 'working', 'grant settlement must unblock without waiting for decided')
  assert.equal(fixture.service.controller.pendingApprovals.has('apr_grant_pending'), false)
  assert.equal(granted.supersededApprovals[0].status, 'superseded')
  assert.equal(granted.supersededApprovals[0].grantId, granted.grant.grantId)
  assert.ok(fixture.service.routerEvents.query({ ticketId }).events.some(item => item.event === 'approval.superseded'))

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
    fixture.service.controller.rememberApprovalTerminal(reverseId, { decision: 'grant-applied', grantId: 'grant_reverse', at: Date.now() })
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
  await fixture.callAs(chat, 'ria_chat_grant', { action: 'reset', grantId: granted.grant.grantId })
  const before = notices().length
  const second = await fixture.callAs(chat, 'ria_chat_grant', {
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
  await fixture.callAs(chat, 'ria_chat_grant', { action: 'reset', grantId: second.grant.grantId })

  // Stale records without a live settler are superseded, not kept blocking.
  const controller = fixture.service.controller
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
  const fallback = controller.settleApprovalsForGrant(worker, { grantId: 'grant_stale', ticketId, kind: 'temporary' })
  assert.equal(fallback.settled.length, 0)
  assert.equal(fallback.unresolved.length, 0)
  assert.equal(fallback.superseded[0].approvalId, 'apr_stale')
  assert.equal(controller.pendingApprovals.has('apr_stale'), false)
  assert.equal(controller.approvalTerminals.get('apr_stale').decision, 'superseded')

  // Ticket-wide grant supersedes stale records from an old executor, not another ticket.
  controller.pendingApprovals.set('apr_old_worker', { ticketId, sessionId: 'old-worker', toolName: 'bash', callId: 'old-call', key: 'old-key' })
  controller.pendingApprovals.set('apr_other_ticket', { ticketId: 'different-ticket', sessionId: worker, toolName: 'bash', callId: 'other-call', key: 'other-key' })
  const all = controller.settleApprovalsForGrant(worker, { grantId: 'grant_ticket_all', ticketId, kind: 'temporary' })
  assert.equal(all.superseded.some(item => item.approvalId === 'apr_old_worker'), true)
  assert.equal(controller.pendingApprovals.has('apr_old_worker'), false)
  assert.equal(controller.pendingApprovals.has('apr_other_ticket'), true)
  controller.pendingApprovals.delete('apr_other_ticket')
  const saved = controller.state.ticketMeta(ticketId).supersededApprovals
  assert.ok(saved.some(item => item.approvalId === 'apr_old_worker' && item.grantId === 'grant_ticket_all'))

  // A completion report arriving before the next grant is finalized, not timed out.
  const complete = fixture.service.store.addTicket({ status: 'blocked', executor: worker, waitingOn: 'approval', blockedReason: 'old approval',
    attempt: { startedAt: Date.now() - 1000 }, failure: { code: 'approval_timeout', message: 'legacy timeout' } })
  controller.state.setTicketMeta(complete.ticketId, { phase: 'blocked', executorId: worker })
  controller.state.addReport({ reportId: 'saved_done', ticketId: complete.ticketId, executorId: worker, status: 'done', summary: 'already completed', evidence: ['exit 0'], at: Date.now() })
  controller.pendingApprovals.set('apr_saved_done', { ticketId: complete.ticketId, sessionId: worker, toolName: 'bash', callId: 'saved-done-call', key: 'saved-done-key' })
  const completingGrant = await fixture.callAs(chat, 'ria_chat_grant', { action: 'set', ticketId: complete.ticketId,
    sandboxMode: 'danger-full-access', approvalPolicy: 'never', reason: 'finish recorded result' })
  assert.equal(completingGrant.ok, true, JSON.stringify(completingGrant))
  assert.equal(fixture.service.store.ticket(complete.ticketId).status, 'done')
  assert.equal(fixture.service.store.ticket(complete.ticketId).failure, null)
  fixture.service.onSessionEvent({ header: { id: worker } }, { type: 'approval/decided', data: { id: 'apr_saved_done', outcome: 'cancelled' } })
  assert.equal(fixture.service.store.ticket(complete.ticketId).status, 'done')

  // Only a matching successful operation clears a pending approval; failure doesn't.
  const successful = fixture.service.store.addTicket({ status: 'blocked', executor: worker, waitingOn: 'approval', blockedReason: 'stale command' })
  controller.state.setTicketMeta(successful.ticketId, { phase: 'blocked', executorId: worker })
  controller.pendingApprovals.set('apr_success', { ticketId: successful.ticketId, sessionId: worker, toolName: 'bash', callId: 'success-call', key: 'success-key' })
  controller.recordSuccessfulApprovalOperation(worker, { callId: 'other-call', exitCode: 0 })
  controller.recordSuccessfulApprovalOperation(worker, { callId: 'success-call', exitCode: 1 })
  assert.equal(controller.pendingApprovals.has('apr_success'), true)
  controller.recordSuccessfulApprovalOperation(worker, { callId: 'success-call', exitCode: 0 })
  assert.equal(controller.pendingApprovals.has('apr_success'), false)
  assert.equal(fixture.service.store.ticket(successful.ticketId).status, 'working')
  const done = await fixture.callAs(worker, 'ria_worker_report', { ticketId: successful.ticketId, status: 'done', summary: 'operation finished', evidence: ['matching exit 0'] })
  assert.equal(done.ok, true, JSON.stringify(done))
  fixture.service.onSessionEvent({ header: { id: worker } }, { type: 'approval/decided', data: { id: 'apr_success', outcome: 'cancelled' } })
  assert.equal(fixture.service.store.ticket(successful.ticketId).status, 'done')
  assert.equal(fixture.service.store.ticket(successful.ticketId).failure, null)

  // Saved done wins when cancellation arrives first; no approval_timeout is written.
  const late = fixture.service.store.addTicket({ status: 'blocked', executor: worker, waitingOn: 'approval', blockedReason: 'late budget cancel', attempt: { startedAt: Date.now() - 1000 } })
  controller.state.setTicketMeta(late.ticketId, { phase: 'blocked', executorId: worker })
  controller.state.addReport({ reportId: 'done-before-cancel', ticketId: late.ticketId, executorId: worker, status: 'done', summary: 'finished before cancel', evidence: ['success'], at: Date.now() })
  controller.pendingApprovals.set('apr_late_done', { ticketId: late.ticketId, sessionId: worker, toolName: 'bash', callId: 'late-done-call', key: 'late-done-key' })
  fixture.service.onSessionEvent({ header: { id: worker } }, { type: 'approval/decided', data: { id: 'apr_late_done', outcome: 'cancelled' } })
  await settle()
  assert.equal(fixture.service.store.ticket(late.ticketId).status, 'done')
  assert.equal(fixture.service.store.ticket(late.ticketId).failure, null)
  assert.ok(controller.state.ticketMeta(late.ticketId).supersededApprovals.some(item => item.approvalId === 'apr_late_done'))

  // Completion also clears a request that arrived before its approval/asked event.
  const orphan = fixture.service.store.addTicket({ status: 'blocked', executor: worker, waitingOn: 'approval', blockedReason: 'orphan request' })
  controller.state.setTicketMeta(orphan.ticketId, { phase: 'blocked', executorId: worker })
  const orphanSettler = controller.createApprovalSettler(worker, 'bash', 'orphan-call', '', { ticketId: orphan.ticketId })
  const orphanDone = await fixture.callAs(worker, 'ria_worker_report', { ticketId: orphan.ticketId, status: 'done', summary: 'orphan finished', evidence: ['done output'] })
  assert.equal(orphanDone.ok, true, JSON.stringify(orphanDone))
  assert.equal(await orphanSettler.promise, 'rejected', 'completion cannot authorize an obsolete request')
  assert.equal(controller.pendingSettlers.has(orphanSettler.key), false)

  console.log('state grant pending ok')
} finally {
  fixture.cleanup()
}
