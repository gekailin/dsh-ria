import assert from 'node:assert/strict'
import { createFixture } from './support/ria-fixture.mjs'

// Chat-side single approval + answer tools. The approval tool must reuse the
// existing live approval/request settle path (no second state machine, no grant
// shortcut) and the answer tool must reuse the forward delivery path and only
// fire for a session that is actually parked on a question.

const fixture = await createFixture({
  stateDefault: true,
  extraSessions: [
    { sessionId: 'session-ask', running: false, blank: false, updatedAt: 1, cwd: '/tmp', projections: { values: { title: 'Ask Session' } } },
    { sessionId: 'session-busy', running: true, blank: false, updatedAt: 2, cwd: '/tmp', projections: { values: { title: 'Busy Session' } } },
  ],
  pendingInputs: { 'session-ask': ['question'], 'session-busy': [] },
})
const settle = () => new Promise(resolve => setTimeout(resolve, 30))
const controller = fixture.service.controller
const chat = controller.state.chatSessionId
const asked = (executor, data) => fixture.service.onSessionEvent({ header: { id: executor } }, { type: 'approval/asked', time: Date.now(), data })
const decided = (executor, data) => fixture.service.onSessionEvent({ header: { id: executor } }, { type: 'approval/decided', time: Date.now(), data })
const ticketOf = ticketId => fixture.service.store.ticket(ticketId)

try {
  await fixture.service.ensure()
  const request = await fixture.callAs(chat, 'ria_chat_request', { goal: 'chat approval probe', acceptance: 'none' })
  const advisor = controller.advisor('global').sessionId
  await fixture.callAs(advisor, 'ria_ticket_plan', { ticketId: request.ticketId, summary: 'probe', steps: ['probe'] })
  const dispatch = await fixture.callAs(advisor, 'ria_ticket_dispatch', { ticketId: request.ticketId })
  assert.equal(dispatch.ok, true, JSON.stringify(dispatch))
  const ticketId = request.ticketId
  const executor = dispatch.executorSessionId

  // Park the ticket on an approval nobody auto-allows: cache args, emit asked,
  // then start the live approval/request waterfall with a never-resolving next.
  const park = async (approvalId, callId, toolName = 'write') => {
    await fixture.emit('tools/pre-execute', { agent: { id: executor }, name: toolName, callId, arguments: { file_path: '/tmp/xy/' + callId } }, async () => ({ kind: 'enter' }))
    asked(executor, { id: approvalId, toolName, callId, reason: 'probe needs a human' })
    await settle()
    assert.equal(ticketOf(ticketId).status, 'blocked', 'asked parks the ticket')
    assert.equal(ticketOf(ticketId).waitingOn, 'approval')
    const pending = fixture.emit('approval/request', {
      agent: { id: executor }, toolName, callId, reason: 'probe needs a human', signal: new AbortController().signal,
    }, () => new Promise(() => {}))
    await settle()
    return { pending }
  }
  const baseline = {
    grants: JSON.stringify(fixture.service.grants.list()),
    settings: JSON.stringify(fixture.service.store.settings()),
  }

  // 1) approve: settle the live request, then the host's approval/decided event
  // performs the only ticket transition (blocked -> open -> working).
  await park('approval_chat_ok', 'call-chat-ok')
  const approved = await fixture.callAs(chat, 'ria_chat_approval_decide', { approvalId: 'approval_chat_ok', decision: 'approve' })
  assert.equal(approved.ok, true, JSON.stringify(approved))
  assert.equal(approved.ticketId, ticketId)
  assert.equal(approved.outcome, 'allowed-once')
  decided(executor, { id: 'approval_chat_ok', outcome: 'allowed-once' })
  await settle()
  assert.equal(ticketOf(ticketId).status, 'working', 'approve resumes the ticket through the existing path')
  assert.equal(ticketOf(ticketId).failure, null)
  assert.equal(JSON.stringify(fixture.service.grants.list()), baseline.grants, 'no grant is created')
  assert.equal(JSON.stringify(fixture.service.store.settings()), baseline.settings, 'settings (sandbox/approval policy) are untouched')
  const chatEvents = fixture.service.routerEvents.query({ limit: 200 }).events.filter(item => item.event === 'approval.chat_decided')
  assert.equal(chatEvents.length, 1)
  assert.equal(chatEvents[0].actor, 'chat')
  assert.equal(chatEvents[0].payload.actorSource, 'chat')
  assert.equal(chatEvents[0].payload.decision, 'approve')

  // 2) already decided: the same approval id cannot be decided twice.
  const twice = await fixture.callAs(chat, 'ria_chat_approval_decide', { approvalId: 'approval_chat_ok', decision: 'approve' })
  assert.equal(twice.ok, false)
  assert.equal(twice.code, 'approval_already_decided')

  // 3) deny: the ticket stays blocked and the failure is recorded by the
  // existing approval/decided path.
  await park('approval_chat_deny', 'call-chat-deny')
  const denied = await fixture.callAs(chat, 'ria_chat_approval_decide', { approvalId: 'approval_chat_deny', decision: 'deny', reason: '不同意写这个路径' })
  assert.equal(denied.ok, true, JSON.stringify(denied))
  decided(executor, { id: 'approval_chat_deny', outcome: 'rejected' })
  await settle()
  assert.equal(ticketOf(ticketId).status, 'blocked', 'deny keeps the ticket blocked')
  assert.equal(ticketOf(ticketId).waitingOn, 'approval')
  assert.ok(ticketOf(ticketId).failure, 'deny records the failure')

  // 4) deny without a reason is a parameter error and decides nothing.
  const missingReason = await fixture.callAs(chat, 'ria_chat_approval_decide', { approvalId: 'approval_missing_a', decision: 'deny' })
  assert.equal(missingReason.ok, false)
  assert.equal(missingReason.field, 'reason')

  // 5) unknown approval id.
  const missing = await fixture.callAs(chat, 'ria_chat_approval_decide', { approvalId: 'approval_does_not_exist', decision: 'approve' })
  assert.equal(missing.ok, false)
  assert.equal(missing.code, 'approval_not_found')

  // 6) expired: the record exists but the live request is gone (turn ended).
  assert.equal(ticketOf(ticketId).status, 'blocked')
  // The ticket is still blocked from the deny case, which is exactly the state a
  // record without a live settler (ended turn) leaves behind.
  // A record without a live settler is what an ended turn leaves behind; seed
  // it directly so the expired branch is exercised in isolation.
  controller.pendingApprovals.set('approval_chat_expired', {
    sessionId: executor, ticketId, toolName: 'write', callId: 'call-chat-exp', key: 'call:' + executor + '|call-chat-exp', at: Date.now(),
  })
  const expired = await fixture.callAs(chat, 'ria_chat_approval_decide', { approvalId: 'approval_chat_expired', decision: 'approve' })
  assert.equal(expired.ok, false)
  assert.equal(expired.code, 'approval_expired')
  controller.pendingApprovals.delete('approval_chat_expired')

  // 7) not applicable: the approval points at a ticket that is no longer
  // blocked(waitingOn=approval).
  controller.resumeAfterApproval(ticketId, 'test resume before stale probe')
  await settle()
  assert.equal(ticketOf(ticketId).status, 'working')
  controller.pendingApprovals.set('approval_chat_stale', {
    sessionId: executor, ticketId, toolName: 'bash', callId: 'call-chat-stale', key: 'call:' + executor + '|call-chat-stale', at: Date.now(),
  })
  const notApplicable = await fixture.callAs(chat, 'ria_chat_approval_decide', { approvalId: 'approval_chat_stale', decision: 'approve' })
  assert.equal(notApplicable.ok, false)
  assert.equal(notApplicable.code, 'approval_not_applicable')
  controller.pendingApprovals.delete('approval_chat_stale')

  // 8) answer: only a session parked on a question accepts the answer; the text
  // travels through the same delivery path as forward.
  const answered = await fixture.callAs(chat, 'ria_chat_answer', { sessionId: 'session-ask', answer: '是的，先在预发环境验证' })
  assert.equal(answered.ok, true, JSON.stringify(answered))
  assert.equal(answered.sessionId, 'session-ask')
  assert.match(String(answered.requestId), /^ria_answer_/)
  const delivered = fixture.steered.map(item => String(item && item.content && item.content[0] ? item.content[0].text : ''))
  assert.ok(delivered.includes('是的，先在预发环境验证'), 'answer is delivered verbatim: ' + JSON.stringify(delivered))
  const answerEvents = fixture.service.routerEvents.query({ limit: 200 }).events.filter(item => item.event === 'chat.answer.sent')
  assert.equal(answerEvents.length, 1)
  assert.equal(answerEvents[0].payload.actorSource, 'chat')
  assert.equal(answerEvents[0].payload.answerDigest, '是的，先在预发环境验证')

  // 9) no pending question: readable error that lists the current state.
  const notWaiting = await fixture.callAs(chat, 'ria_chat_answer', { sessionId: 'session-busy', answer: '好的' })
  assert.equal(notWaiting.ok, false)
  assert.equal(notWaiting.code, 'answer_not_pending')
  assert.deepEqual(notWaiting.pendingInput, [])
  assert.equal(typeof notWaiting.running, 'boolean', 'the error reports the live running flag')
  assert.match(notWaiting.message, /pendingInput=\[\]/)

  // 10) target validation.
  const bothTargets = await fixture.callAs(chat, 'ria_chat_answer', { sessionId: 'session-ask', title: 'Ask Session', answer: 'x' })
  assert.equal(bothTargets.code, 'answer_target_conflict')
  const noTarget = await fixture.callAs(chat, 'ria_chat_answer', { answer: 'x' })
  assert.equal(noTarget.code, 'answer_target_required')
  const noAnswer = await fixture.callAs(chat, 'ria_chat_answer', { sessionId: 'session-ask', answer: '   ' })
  assert.equal(noAnswer.code, 'invalid_argument')
  const unknownSession = await fixture.callAs(chat, 'ria_chat_answer', { sessionId: 'session-nope', answer: 'x' })
  assert.equal(unknownSession.code, 'answer_target_not_found')

  // 11) role isolation: Chat only (exact list assertions live in controller /
  // sage-tools / executor-kinds; here we check the live fixture surfaces).
  const chatTools = fixture.visibleTools(chat)
  assert.ok(chatTools.includes('ria_chat_approval_decide'))
  assert.ok(chatTools.includes('ria_chat_answer'))
  assert.equal(fixture.visibleTools(advisor).includes('ria_chat_approval_decide'), false)
  assert.equal(fixture.visibleTools(advisor).includes('ria_chat_answer'), false)
  assert.equal(fixture.visibleTools(executor).includes('ria_chat_approval_decide'), false)
  assert.equal(fixture.visibleTools(executor).includes('ria_chat_answer'), false)

  console.log('chat approval + answer ok')
} finally {
  fixture.cleanup()
}
