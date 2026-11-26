import assert from 'node:assert/strict'
import { createFixture } from './support/ria-fixture.mjs'

// A co-managed session's turn result must reach Claw even when the channel
// rejects it: the relay is user-facing content, so a failed/skipped send has to
// land in the durable outbox exactly once per source message (916c7b3 keeps the
// ticket lane separate; a ticket-free session must never take that early return).
//
// Regression for: "用户直转问题给协管，它答完了，Ria 读得到，但手机没收到"
//  - the task result was folded into the 172-char "报告较长" teaser, and
//  - a rejected relay was dropped with no outbox entry and no retry because
//    sendWatchRelay passed fallback:false while forwardAssistant is
//    fire-and-forget.

const tick = (ms = 0) => new Promise(resolve => setTimeout(resolve, ms))
const fixture = await createFixture({
  stateDefault: true,
  extraSessions: [
    { sessionId: 'session-relay-co', running: false, blank: false, updatedAt: 1, cwd: '/work/relay', projections: { values: { title: 'Relay Co' } } },
    { sessionId: 'session-relay-busy', running: false, blank: false, updatedAt: 2, cwd: '/work/relay', projections: { values: { title: 'Relay Busy' } } },
  ],
})

try {
  const service = fixture.service
  const controller = service.controller
  const chat = controller.state.chatSessionId
  const id = 'session-relay-co'
  const busy = 'session-relay-busy'
  const events = types => service.routerEvents.query({ types, limit: 200 }).events
  const outboxNotes = () => service.outbox.all().filter(entry => entry.kind === 'wechat_assistant_note')
  const assistant = (sessionId, seq, text, turn) => service.onSessionEvent({ header: { id: sessionId } }, {
    type: 'assistant/message', seq, time: seq,
    data: { turn, message: { content: [{ type: 'text', text }] } },
  })
  const turnEnd = (sessionId, turn) => service.onSessionEvent({ header: { id: sessionId } }, {
    type: 'turn/end', data: { turn, reason: { kind: 'completed' } },
  })

  // --- 1) Ticket-free session: the turn result relays once, in full ----------
  // Historical terminal tickets must not park the session on the ticket lane.
  service.store.addTicket({ status: 'cancelled', executor: id, goal: 'stale cancelled' })
  service.store.addTicket({ status: 'done', executor: id, goal: 'older done' })
  assert.equal(controller.executorWorkingTicket(id), null, 'terminal tickets never bind the session')

  const calls = []
  service.wechatClaw = {
    peer: { userId: 'user@im.wechat' },
    sendAssistantNote: async () => ({ deferred: true }),
    forwardAssistant(text, event, options = {}) {
      calls.push({ text, event, options })
      // Mirror the real channel: fire-and-forget, outcome reported later.
      if (typeof options.onSettled === 'function') {
        options.onSettled({ at: new Date().toISOString(), reason: 'delivered', chars: text.length, eventSeq: event && event.seq, sessionId: options.sessionId, turn: options.turn })
      }
      return undefined
    },
  }

  const forwarded = await fixture.callAs(chat, 'ria_chat_forward', { sessionId: id, content: '给出完整结论表' })
  assert.equal(forwarded.ok, true, JSON.stringify(forwarded))
  const answer = '# 结论\n\n' + '这是正文的一句。'.repeat(30) + '\n\n| k1 | BA k1 |\n| --- | --- |\n| -0.2 | -0.22 |\n\n## 说明\n\n第二段。'
  assistant(id, 101, answer, 1)
  turnEnd(id, 1)
  await tick(20)

  assert.equal(calls.length, 1, 'turn/end relays the buffered reply exactly once')
  assert.equal(calls[0].options.kind, 'notice', 'a direct forward is a task result (🔔)')
  assert.equal(calls[0].options.fallback, true, 'relay failures must be durable, never silently dropped')
  assert.equal(calls[0].options.sessionId, id, 'the relay carries its source session for the fallback key')
  assert.ok(calls[0].text.includes('| k1 | BA k1 |'), 'the answer body reaches Claw, not just the teaser')
  assert.equal(calls[0].text.includes('已折叠'), false, 'task-triggered relays are not folded into a teaser')
  assert.equal(events(['relay.skipped']).length, 0, 'a ticket-free session is never early-returned')
  assert.equal(events(['relay.delivered']).length, 1, 'the real outcome is recorded')
  assert.equal(outboxNotes().length, 0, 'a delivered relay needs no outbox copy')

  // A repeated turn/end for the same turn cannot relay the same text again.
  turnEnd(id, 1)
  await tick(10)
  assert.equal(calls.length, 1, 'the same turn never relays twice')

  // --- 2) A session owning a working ticket keeps the early return ----------
  const busyCalls = []
  service.wechatClaw.forwardAssistant = (text, event, options = {}) => {
    busyCalls.push({ text, options })
    return undefined
  }
  // The watch registration is created the same way production creates it: a
  // direct forward auto-registers the target.
  const busyForward = await fixture.callAs(chat, 'ria_chat_forward', { sessionId: busy, content: 'busy q' })
  assert.equal(busyForward.ok, true, JSON.stringify(busyForward))
  assert.equal(Boolean(controller.coManagement.active(busy)), true)
  const working = service.store.addTicket({ status: 'working', executor: busy, goal: 'busy work' })
  assert.equal(controller.executorWorkingTicket(busy).ticketId, working.ticketId)
  assistant(busy, 201, 'progress only', 1)
  await controller.coManagement.flush(busy)
  assert.equal(busyCalls.length, 0, 'a working-ticket session stays on the settlement lane')
  const skipped = events(['relay.skipped'])
  assert.equal(skipped.length, 1)
  assert.equal(skipped[0].sessionId, busy)
  assert.equal(skipped[0].payload.ticketId, working.ticketId)

  // --- 3) A rejected relay lands in the durable outbox exactly once ---------
  let failNext = true
  service.wechatClaw.forwardAssistant = (text, event, options = {}) => {
    if (!failNext) return undefined
    failNext = false
    const record = {
      at: new Date().toISOString(), reason: 'send_failed', chars: text.length,
      eventSeq: event && event.seq, eventAt: event && event.time,
      sessionId: options.sessionId, turn: options.turn,
      errorCode: 'WECHAT_CLAW_PEER_REJECTED', ret: -2,
    }
    // Mirror wechat-claw.mjs recordAssistantForward + the outbox fallback.
    const queued = service.notifyWechatAssistantFallback({ ...record, text }) !== false
    if (typeof options.onSettled === 'function') options.onSettled({ ...record, fallbackQueued: queued })
    return undefined
  }
  const second = await fixture.callAs(chat, 'ria_chat_forward', { sessionId: id, content: '再给一次完整表' })
  assert.equal(second.ok, true, JSON.stringify(second))
  const body = '# 全表\n\n' + '正文。'.repeat(20) + '\n\n| a | b |\n| --- | --- |\n| 1 | 2 |'
  assistant(id, 301, body, 2)
  turnEnd(id, 2)
  await tick(20)

  const notes = outboxNotes()
  assert.equal(notes.length, 1, 'a rejected task relay is queued durably')
  assert.ok(notes[0].payload.text.includes('| a | b |'), 'the queued copy carries the answer body')
  assert.equal(notes[0].payload.sourceSessionId, id, 'the durable key is per source session')
  assert.equal(notes[0].payload.turn, 2)
  assert.equal(notes[0].status === 'delivered', false, 'the relay stays queued for retry')
  const failed = events(['relay.failed'])
  assert.equal(failed.length, 1)
  assert.equal(failed[0].payload.ret, -2)
  assert.equal(failed[0].payload.fallbackQueued, true)

  // The same turn cannot queue a second copy: the buffer is already spliced and
  // the outbox key (session + seq) is stable.
  turnEnd(id, 2)
  await controller.coManagement.flush(id)
  await tick(10)
  assert.equal(outboxNotes().length, 1, 'one turn produces exactly one outbox entry')

  // --- 4) A no-op turn (no prose) never fabricates a relay ------------------
  const before = outboxNotes().length
  turnEnd(id, 3)
  await tick(10)
  assert.equal(outboxNotes().length, before, 'an empty buffer relays nothing')

  console.log('co-managed relay outbox ok')
} finally {
  fixture.cleanup()
}
