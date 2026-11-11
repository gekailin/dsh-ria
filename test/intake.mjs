import assert from 'node:assert/strict'
import { createFixture } from './support/ria-fixture.mjs'

function userMessage(id, text, rpcId = 'rpc-' + id) {
  return {
    id,
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user', rpcId },
  }
}

function capture(fixture, id, text, turn) {
  return fixture.service.store.captureIntake({
    sessionId: fixture.riaAgent.id,
    turn,
    message: userMessage(id, text),
  })
}

// The pre-step hook captures every real user message as an intake, lists it in
// a notice in the same step, dedupes a replay, and ignores host-authored
// messages.
{
  const fixture = await createFixture()
  try {
    const message = userMessage('msg-1', '帮我看看无人车底商方案', 'rpc-1')
    const first = await fixture.emit('agent/pre-step', { agent: fixture.riaAgent, turn: 4 }, async () => ({
      kind: 'enter',
      messages: [message],
    }))
    assert.equal(first.kind, 'enter')
    assert.equal(first.messages.length, 2)
    const notice = first.messages[1]
    assert.equal(notice.source.kind, 'ria-task-host')
    assert.match(notice.content[0].text, /\[Task intake\]/)
    assert.match(notice.content[0].text, /无人车底商方案/)
    assert.match(notice.content[0].text, /ria_resolve/)
    assert.equal(fixture.service.store.intakesForTurn(4).length, 1)
    const ticket = fixture.service.store.intakesForTurn(4)[0]
    assert.equal(ticket.status, 'intake')
    assert.equal(ticket.origin.messageId, 'msg-1')

    const replay = await fixture.emit('agent/pre-step', { agent: fixture.riaAgent, turn: 4 }, async () => ({
      kind: 'enter',
      messages: [message],
    }))
    assert.equal(replay.messages.length, 1)
    assert.equal(fixture.service.store.tickets().length, 1)

    const host = userMessage('msg-host', '恢复提示', 'host_123')
    const skipped = await fixture.emit('agent/pre-step', { agent: fixture.riaAgent, turn: 5 }, async () => ({
      kind: 'enter',
      messages: [host],
    }))
    assert.equal(skipped.messages.length, 1)
    assert.equal(fixture.service.store.tickets().length, 1)

    const rejected = await fixture.emit('agent/pre-step', { agent: fixture.riaAgent, turn: 6 }, async () => ({ kind: 'reject' }))
    assert.equal(rejected.kind, 'reject')
    assert.equal(fixture.service.store.tickets().length, 1)
  } finally {
    fixture.cleanup()
  }
}

// ria_resolve dispositions: answered, work (open vs self-start), merge,
// control, blocked, and split (P1).
{
  const fixture = await createFixture()
  try {
    const answered = capture(fixture, 'm-answered', '今天天气怎么样', 7).ticket
    const done = await fixture.call('ria_resolve', { ticketId: answered.ticketId, kind: 'answered', summary: '晴' })
    assert.equal(done.ok, true)
    assert.equal(done.ticket.status, 'done')
    assert.equal(done.ticket.resolution.kind, 'answered')
    assert.equal(done.ticket.resolution.summary, '晴')
    const again = await fixture.call('ria_resolve', { ticketId: answered.ticketId, kind: 'answered' })
    assert.equal(again.ok, false)
    assert.equal(again.code, 'intake_already_resolved')

    const opened = capture(fixture, 'm-work', '把报告写完', 8).ticket
    const work = await fixture.call('ria_resolve', { ticketId: opened.ticketId, kind: 'work', executor: 'session-worker', goal: '写完报告' })
    assert.equal(work.ok, true)
    assert.equal(work.ticket.status, 'open')
    assert.equal(work.ticket.executor, 'session-worker')
    assert.equal(work.ticket.goal, '写完报告')

    const self = capture(fixture, 'm-self', '你现在就查一下', 8).ticket
    const started = await fixture.call('ria_resolve', { ticketId: self.ticketId, kind: 'work', start: true })
    assert.equal(started.ok, true)
    assert.equal(started.ticket.status, 'working')
    assert.equal(started.ticket.executor, 'self')
    assert.equal(fixture.service.store.ticket(self.ticketId).attempt.legacy, true)

    const missing = capture(fixture, 'm-missing', '派给不存在的会话', 8).ticket
    const bad = await fixture.call('ria_resolve', { ticketId: missing.ticketId, kind: 'work', executor: 'session-gone' })
    assert.equal(bad.ok, false)
    assert.equal(bad.code, 'session_missing')
    assert.equal(fixture.service.store.ticket(missing.ticketId).status, 'intake')

    const target = fixture.service.store.addTicket({ goal: '旧任务', executor: 'session-worker' })
    const merged = capture(fixture, 'm-merge', '补充：用中文写', 9).ticket
    const merge = await fixture.call('ria_resolve', { ticketId: merged.ticketId, kind: 'merge', targetTicketId: target.ticketId })
    assert.equal(merge.ok, true)
    assert.equal(merge.ticket.status, 'done')
    assert.equal(merge.ticket.resolution.kind, 'merged')
    assert.equal(merge.ticket.resolution.mergedInto, target.ticketId)
    const targetAfter = fixture.service.store.ticket(target.ticketId)
    assert.equal(targetAfter.history.at(-1).from, 'merged')
    assert.equal(targetAfter.history.at(-1).sourceTicketId, merged.ticketId)

    const cancelTarget = fixture.service.store.addTicket({ goal: '取消我', executor: 'session-worker' })
    const control = capture(fixture, 'm-cancel', '取消那个任务', 10).ticket
    const cancelled = await fixture.call('ria_resolve', { ticketId: control.ticketId, kind: 'control', targetTicketId: cancelTarget.ticketId, action: 'cancel' })
    assert.equal(cancelled.ok, true)
    assert.equal(cancelled.ticket.resolution.kind, 'control')
    assert.equal(fixture.service.store.ticket(cancelTarget.ticketId).status, 'cancelled')

    const blockedIntake = capture(fixture, 'm-blocked', '需要你决定预算', 11).ticket
    const noReason = await fixture.call('ria_resolve', { ticketId: blockedIntake.ticketId, kind: 'blocked' })
    assert.equal(noReason.ok, false)
    assert.equal(noReason.code, 'blocked_reason_required')
    const blocked = await fixture.call('ria_resolve', { ticketId: blockedIntake.ticketId, kind: 'blocked', blockedReason: '预算未定', waitingOn: 'user' })
    assert.equal(blocked.ok, true)
    assert.equal(blocked.ticket.status, 'blocked')
    assert.equal(blocked.ticket.waitingOn, 'user')

    const splitIntake = capture(fixture, 'm-split', '拆成两件事', 12).ticket
    const split = await fixture.call('ria_resolve', { ticketId: splitIntake.ticketId, kind: 'split' })
    assert.equal(split.ok, false)
    assert.equal(split.code, 'not_supported')
    assert.equal(fixture.service.store.ticket(splitIntake.ticketId).status, 'intake')

    const untouchable = capture(fixture, 'm-task-on-intake', '还在 intake', 12).ticket
    await assert.rejects(
      () => fixture.call('ria_ticket', { ticketId: untouchable.ticketId, goal: '改 intake' }),
      error => error.code === 'intake_requires_resolve',
    )
  } finally {
    fixture.cleanup()
  }
}

// turn-stopping steers once, then parks the intake as blocked with a card.
{
  const fixture = await createFixture()
  try {
    const ticket = capture(fixture, 'm-stop', '这件事没有归宿', 13).ticket
    await fixture.emit('agent/turn-stopping', { agent: fixture.riaAgent, turn: 13, signal: new AbortController().signal })
    assert.equal(fixture.steered.length, 1)
    assert.match(fixture.steered[0].content[0].text, /\[Task intake reminder\]/)
    assert.equal(fixture.service.store.ticket(ticket.ticketId).nudgeCount, 1)
    assert.equal(fixture.service.store.ticket(ticket.ticketId).status, 'intake')

    await fixture.emit('agent/turn-stopping', { agent: fixture.riaAgent, turn: 13, signal: new AbortController().signal })
    assert.equal(fixture.steered.length, 1)
    const parked = fixture.service.store.ticket(ticket.ticketId)
    assert.equal(parked.status, 'blocked')
    assert.equal(parked.waitingOn, 'user')
    assert.match(parked.blockedReason, /没有归宿|未在 turn 内给出归宿/)
    const feedback = fixture.service.store.ticketFeedbacks().find(item => item.ticketId === ticket.ticketId)
    assert.equal(feedback.kind, 'blocked')
    assert.equal(feedback.code, 'intake_unresolved')
    assert.equal(feedback.card, true)
  } finally {
    fixture.cleanup()
  }
}

// turn/end closes unresolved intakes: aborted(user) cancels them, an error
// parks them as blocked with a reason.
{
  const fixture = await createFixture()
  try {
    const cancelled = capture(fixture, 'm-abort', '被用户中止', 14).ticket
    fixture.service.closeIntakesForTurn({ turn: 14, reason: { kind: 'aborted', reason: { kind: 'user' } } })
    assert.equal(fixture.service.store.ticket(cancelled.ticketId).status, 'cancelled')
    assert.equal(fixture.service.store.ticket(cancelled.ticketId).resolution.kind, 'aborted')

    const failed = capture(fixture, 'm-error', '异常结束', 15).ticket
    fixture.service.closeIntakesForTurn({ turn: 15, reason: { kind: 'error', error: { message: 'boom' } } })
    const parked = fixture.service.store.ticket(failed.ticketId)
    assert.equal(parked.status, 'blocked')
    assert.equal(parked.waitingOn, 'user')
    assert.match(parked.blockedReason, /boom/)

    const live = capture(fixture, 'm-disposed', '关机打断了', 16).ticket
    fixture.service.closeIntakesForTurn({ turn: 16, reason: { kind: 'aborted', reason: { kind: 'disposed' } } })
    assert.equal(fixture.service.store.ticket(live.ticketId).status, 'intake')
  } finally {
    fixture.cleanup()
  }
}

console.log('intake ok')
