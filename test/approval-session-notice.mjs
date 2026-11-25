import assert from 'node:assert/strict'
import { Controller } from '../lib/core/controller.mjs'
import { chatPrompt } from '../lib/prompts/shared.mjs'

const base = (overrides = {}) => {
  const notices = []
  const ctx = Object.create(Controller.prototype)
  Object.assign(ctx, {
    sessionApprovalNotices: new Map(),
    approvalNoticeTimeoutMs: 15,
    approvalTerminals: new Map(),
    roleFor: () => 'advisor',
    workingTicketFor: () => null,
    approvalBlockedTicketFor: () => null,
    queueChatNotice: message => notices.push(message),
    queued: notices,
    log: () => {},
    approvalKey: () => 'approval-key',
    ...overrides,
  })
  return ctx
}

// 1) A co-managed/ordinary session without a ticket gets one session-level bell notice.
{
  const next = async () => 'rejected'
  const ctx = base({
    roleFor: () => 'executor',
    evaluateApprovalRisk: () => ({ decision: 'ask', ticketId: null, risk: { level: 'high' }, key: 'k' }),
    auditApprovalRisk: () => {},
    pendingApprovalFor: () => null,
    createApprovalSettler: () => ({ settled: false, promise: new Promise(() => {}) }),
    closeApprovalSettler: () => {},
  })
  await Controller.prototype.noticeApproval.call(ctx, { agent: { id: 'session-co' }, toolName: 'bash', callId: 'call-1', reason: 'need access' }, next)
  assert.equal(ctx.queued.length, 1)
  assert.equal(ctx.queued[0], '🔔 #session-co 等待审批：bash（need access） · 受影响：executor session session-co')
}

// 1b) An Advisor-only session (no ticket) uses the same session-level path.
{
  const ctx = base()
  await Controller.prototype.noticeApproval.call(ctx, { agent: { id: 'session-advisor' }, toolName: 'write', callId: 'call-advisor', reason: 'need scope' }, async () => 'rejected')
  assert.equal(ctx.queued.length, 1)
  assert.ok(ctx.queued[0].includes('#session-advisor 等待审批：write'))
}

// 2/3) Timeout sends exactly one more reminder; a third observation is silent.
{
  const ctx = base()
  Controller.prototype.notifySessionApproval.call(ctx, 'session-advisor', { toolName: 'Bash', reason: 'need access', callId: 'call-2' })
  assert.equal(ctx.queued.length, 1)
  assert.equal(Controller.prototype.notifySessionApproval.call(ctx, 'session-advisor', { toolName: 'Bash', reason: 'need access', callId: 'call-2' }), false)
  await new Promise(resolve => setTimeout(resolve, 35))
  assert.equal(ctx.queued.length, 2)
  assert.match(ctx.queued[1], /仍未处理审批/)
  assert.equal(Controller.prototype.notifySessionApproval.call(ctx, 'session-advisor', { toolName: 'Bash', reason: 'need access', callId: 'call-2' }), false)
  assert.equal(ctx.queued.length, 2)
  ctx.clearSessionApprovalNotices('session-advisor')
}

// 4) A ticket-owned executor keeps the ticket notice path and does not add a
// duplicate session-level notice.
{
  const next = async () => 'rejected'
  const ctx = base({
    roleFor: () => 'executor',
    workingTicketFor: () => ({ ticketId: 'ticket_1' }),
    evaluateApprovalRisk: () => ({ decision: 'ask', ticketId: 'ticket_1', risk: { level: 'high' }, key: 'k' }),
    auditApprovalRisk: () => {},
    pendingApprovalFor: () => null,
    createApprovalSettler: () => ({ settled: false, promise: new Promise(() => {}) }),
    closeApprovalSettler: () => {},
  })
  const outcome = await Controller.prototype.noticeApproval.call(ctx, { agent: { id: 'session-exec' }, toolName: 'bash', callId: 'call-3', reason: 'need access' }, next)
  assert.equal(outcome, 'rejected')
  assert.equal(ctx.queued.length, 0, 'ticket path must not duplicate the generic notice')
}

assert.match(chatPrompt(), /收到审批通知/)
assert.ok(chatPrompt().includes('批准 / 拒绝 / 稍后处理'))
console.log('session approval notice routing ok')
