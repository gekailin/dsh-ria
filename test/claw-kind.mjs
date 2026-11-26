import assert from 'node:assert/strict'
import { Controller } from '../lib/core/controller.mjs'
import { Outbound } from '../lib/wechat/outbound.mjs'

// 1) A session owning a working ticket stays on the ticket settlement lane:
// sendWatchRelay never emits a conversational relay or duplicate status notice.
// The skip itself must be observable, otherwise it is indistinguishable from a
// delivery (CoManagement.deliver treats a resolved send as success).
{
  const calls = []
  const events = []
  const ctx = {
    service: {
      store: { settings: () => ({ relay: { maxChars: 400 } }) },
      tickets: { tickets: () => [] },
    },
    watchRelayLog: [],
    relaySkipNotices: new Map(),
    routerEvent: event => events.push(event),
    executorWorkingTicket: () => ({ ticketId: 'ticket_relay_working', status: 'working' }),
    latestExecutorReport: () => ({ summary: 'finished' }),
    notifyTicketStatus: async () => { calls.push('status'); return { text: '#relay working' } },
    notifyChat: async () => { calls.push('chat'); return true },
  }
  // The prototype is called with a bare context in this suite: bind the helper
  // the skip path uses so the test exercises the real implementation.
  ctx.recordWatchRelaySkipped = (...args) => Controller.prototype.recordWatchRelaySkipped.apply(ctx, args)
  await Controller.prototype.sendWatchRelay.call(ctx, { watchId: 'w1', sessionId: 'session-co', titleSnapshot: 'co' }, 'body', { seq: 7 })
  assert.equal(calls.length, 0, 'working-ticket session must not emit a watch relay')
  assert.equal(ctx.watchRelayLog.length, 0)
  assert.equal(events.length, 1)
  assert.equal(events[0].event, 'relay.skipped')
  assert.equal(events[0].reason, 'working_ticket')
  assert.equal(events[0].payload.ticketId, 'ticket_relay_working')
  assert.equal(events[0].payload.seq, 7)
}

// 1b) A historical terminal ticket is not a status event for a ticket-free turn.
{
  const calls = []
  const ctx = {
    service: {
      store: { settings: () => ({ relay: { maxChars: 400 } }) },
      tickets: { tickets: () => [{ ticketId: 'ticket_relay_done', status: 'done', waitingOn: 'none', executor: 'session-co', updatedAt: 1 }] },
      wechatClaw: { forwardAssistant: (text, event, options) => { calls.push({ text, options }); return { reason: 'delivered' } } },
    },
    watchRelayLog: [],
    executorWorkingTicket: () => null,
    latestExecutorReport: () => ({ summary: 'finished' }),
    notifyTicketStatus: async () => { throw new Error('historical terminal ticket must not use status path') },
    notifyChat: async () => true,
  }
  await Controller.prototype.sendWatchRelay.call(ctx, { watchId: 'w1b', sessionId: 'session-co', titleSnapshot: 'co' }, 'ordinary reply', {})
  assert.equal(calls.length, 1)
  assert.equal(calls[0].options.kind, 'assistant', 'ticket-free reply uses assistant kind')
  assert.match(calls[0].text, /ordinary reply/)
}

// 2) A co-managed ordinary reply is a conversation: explicit 'assistant'.
{
  const calls = []
  const ctx = {
    service: {
      store: { settings: () => ({ relay: { maxChars: 400 } }) },
      tickets: { tickets: () => [] },
      wechatClaw: { forwardAssistant: (text, event, options) => { calls.push({ text, options }); return { reason: 'delivered' } } },
    },
    watchRelayLog: [],
    executorWorkingTicket: () => null,
    latestExecutorReport: () => null,
    notifyTicketStatus: async () => { throw new Error('ordinary relay must not use status path') },
    notifyChat: async () => true,
  }
  await Controller.prototype.sendWatchRelay.call(ctx, { watchId: 'w2', sessionId: 'session-co', titleSnapshot: 'co' }, 'hello', {})
  assert.equal(calls.length, 1)
  assert.equal(calls[0].options.kind, 'assistant', 'ordinary relay must explicitly use assistant kind')
}

// 3) Chat/assistant output remains the wave prefix.
{
  const sent = []
  const outbound = new Outbound({ send: async value => { sent.push(value); return 'id' } })
  await outbound.enqueue('chat reply', { kind: 'assistant' })
  assert.equal(sent[0], '🌊 chat reply')
}

// 4) System notices remain the bell prefix and go through sendNote with kind notice.
{
  const calls = []
  const ctx = {
    service: { wechatClaw: { sendNote: async (text, options) => { calls.push({ text, options }); return true } } },
    log: () => {},
  }
  await Controller.prototype.notifyClawStatus.call(ctx, '#abcdef done · finished', 'req-1', 'notice')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].options.kind, 'notice')
  const sent = []
  const outbound = new Outbound({ send: async value => { sent.push(value); return 'id' } })
  await outbound.enqueue(calls[0].text, { kind: calls[0].options.kind })
  assert.ok(sent[0].startsWith('🔔 '), 'notice kind must resolve to the bell prefix')
}

console.log('claw kind routing ok')
