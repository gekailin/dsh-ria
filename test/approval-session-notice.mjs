import assert from 'node:assert/strict'
import { Controller } from '../lib/core/controller.mjs'
import { chatPrompt } from '../lib/prompts/shared.mjs'
import { noticeText } from '../lib/core/notice.mjs'

const base = (overrides = {}) => {
  const notices = []
  const ctx = Object.create(Controller.prototype)
  Object.assign(ctx, {
    sessionApprovalNotices: new Map(),
    approvalTerminals: new Map(),
    roleFor: () => 'advisor',
    workingTicketFor: () => null,
    approvalBlockedTicketFor: () => null,
    coManagement: { active: () => null },
    queueChatNotice: message => notices.push(noticeText(message)),
    queued: notices,
    log: () => {},
    approvalKey: () => 'approval-key',
    service: { routerEvent: () => {} },
    ...overrides,
  })
  return ctx
}

// 1) An unregistered ordinary session (no role, not watched) is silent.
{
  const next = async () => 'rejected'
  const ctx = base({
    roleFor: () => null,
    coManagement: { active: () => null },
    evaluateApprovalRisk: () => ({ decision: 'ask', ticketId: null, risk: { level: 'high' }, key: 'k' }),
    auditApprovalRisk: () => {},
    pendingApprovalFor: () => null,
    createApprovalSettler: () => ({ settled: false, promise: new Promise(() => {}) }),
    closeApprovalSettler: () => {},
  })
  await Controller.prototype.noticeApproval.call(ctx, { agent: { id: 'session-ordinary' }, toolName: 'bash', callId: 'call-1', reason: 'need access' }, next)
  assert.equal(ctx.queued.length, 0, 'unwatched ordinary session must not be notified')
}

// 1b) A co-managed/executor session without a ticket still gets one notice.
{
  const next = async () => 'rejected'
  const ctx = base({
    roleFor: () => 'executor',
    coManagement: { active: () => ({ sessionId: 'session-co' }) },
    evaluateApprovalRisk: () => ({ decision: 'ask', ticketId: null, risk: { level: 'high' }, key: 'k' }),
    auditApprovalRisk: () => {},
    pendingApprovalFor: () => null,
    createApprovalSettler: () => ({ settled: false, promise: new Promise(() => {}) }),
    closeApprovalSettler: () => {},
  })
  await Controller.prototype.noticeApproval.call(ctx, { agent: { id: 'session-co' }, toolName: 'bash', callId: 'call-co', reason: 'need access' }, next)
  assert.equal(ctx.queued.length, 1)
  assert.equal(ctx.queued[0], '🔔 #session-co 等待审批：bash（need access） · 受影响：executor session session-co')
}

// 1c) An internal Advisor session keeps the session-level notice.
{
  const ctx = base()
  await Controller.prototype.noticeApproval.call(ctx, { agent: { id: 'session-advisor' }, toolName: 'write', callId: 'call-advisor', reason: 'need scope' }, async () => 'rejected')
  assert.equal(ctx.queued.length, 1)
  assert.ok(ctx.queued[0].includes('#session-advisor 等待审批：write'))
}

// 2) There is no timeout reminder and no pending timer after the first notice.
{
  const ctx = base()
  Controller.prototype.notifySessionApproval.call(ctx, 'session-advisor', { toolName: 'Bash', reason: 'need access', callId: 'call-2' })
  assert.equal(ctx.queued.length, 1)
  assert.equal(Controller.prototype.notifySessionApproval.call(ctx, 'session-advisor', { toolName: 'Bash', reason: 'need access', callId: 'call-2' }), false)
  const entry = ctx.sessionApprovalNotices.get('session-advisor|call-2')
  assert.equal(entry.timer, undefined, 'no reminder timer is armed')
  await new Promise(resolve => setTimeout(resolve, 35))
  assert.equal(ctx.queued.length, 1, 'no delayed reminder is sent')
  ctx.clearSessionApprovalNotices('session-advisor')
}

// 3) A ticket-owned executor keeps the ticket notice path and no duplicate.
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
