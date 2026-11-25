import assert from 'node:assert/strict'
import { Controller } from '../lib/core/controller.mjs'
import { Outbound } from '../lib/wechat/outbound.mjs'

// 1) A co-managed terminal ticket is a system status line: explicit 'notice'.
{
  const calls = []
  const ctx = {
    service: {
      store: { settings: () => ({ relay: { maxChars: 400 } }) },
      tickets: { tickets: () => [{ ticketId: 'ticket_relay_done', status: 'done', waitingOn: 'none', executor: 'session-co', updatedAt: 1 }] },
    },
    noticeSignatures: new Map(),
    watchRelayLog: [],
    noticeSignature: (ticketId, status) => ticketId + ':' + status,
    executorWorkingTicket: () => null,
    latestExecutorReport: () => ({ summary: 'finished' }),
    notifyTicketStatus: async (ticketId, status, summary, options) => { calls.push({ ticketId, status, summary, options }); return { text: '#relay done' } },
    notifyChat: async () => true,
    ensureRelayBodyStored: () => {},
    suppressNotice: () => {},
  }
  await Controller.prototype.sendWatchRelay.call(ctx, { watchId: 'w1', sessionId: 'session-co', titleSnapshot: 'co' }, 'body', {})
  assert.equal(calls.length, 1)
  assert.equal(calls[0].options.kind, 'notice', 'terminal relay must explicitly use notice kind')
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
    noticeSignatures: new Map(),
    watchRelayLog: [],
    noticeSignature: (ticketId, status) => ticketId + ':' + status,
    executorWorkingTicket: () => null,
    latestExecutorReport: () => null,
    notifyTicketStatus: async () => { throw new Error('ordinary relay must not use status path') },
    notifyChat: async () => true,
    ensureRelayBodyStored: () => {},
    suppressNotice: () => {},
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
