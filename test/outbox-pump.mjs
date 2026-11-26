import assert from 'node:assert/strict'
import { createFixture } from './support/ria-fixture.mjs'
import { WECHAT_ASSISTANT_NOTE_KIND, WECHAT_ASSISTANT_RETRY_DELAYS_MS } from '../lib/outbox.mjs'

const fixture = await createFixture({ state: true })
try {
  const service = fixture.service
  const events = () => service.routerEvents.query({ limit: 500 }).events
  service.wechatClaw.sendAssistantNote = async () => true

  const enqueue = key => service.outbox.enqueue({
    kind: WECHAT_ASSISTANT_NOTE_KIND,
    dedupeKey: key,
    payload: { text: key, reason: 'test', at: new Date().toISOString(), chars: key.length, truncated: false },
  }).entry

  // Fixture construction already registers the timer; one tick delivers without
  // any inbound/turn interaction.
  service.startOutbox()
  assert.ok(service.outboxTimer, 'startOutbox registers a timer immediately')
  const entry = enqueue('outbox-startup-test')
  assert.equal(entry.status, 'pending')
  await service.tickOutbox()
  assert.equal(service.outbox.entry(entry.id).status, 'delivered', 'tick delivers without inbound interaction')

  // Three/four no-progress inspections rebuild the timer and keep recovering.
  const stuck = enqueue('outbox-stall-test')
  service.afterOutboxTick()
  service.afterOutboxTick()
  service.afterOutboxTick()
  service.afterOutboxTick()
  const recovered = events().filter(item => item.event === 'outbox.pump.recovered')
  assert.equal(recovered.length, 1)
  assert.equal(recovered[0].payload.pending, 1)
  assert.equal(service.outbox.entry(stuck.id).status, 'pending')
  await service.tickOutbox()
  assert.equal(service.outbox.entry(stuck.id).status, 'delivered', 'rebuilt tick resumes delivery')
  service.shutdownOutbox()

  // Backlog is observable at either threshold, without floating minute math.
  service.checkOutboxBacklog([])
  service.checkOutboxBacklog(Array.from({ length: 11 }, (_, index) => ({
    id: 'pending-' + index, status: 'pending', eventAt: Date.now(),
  })))
  const backlogEvents = events().filter(item => item.event === 'outbox.backlog')
  const countEvent = backlogEvents.find(item => item.payload.pending === 11)
  assert.ok(countEvent)

  service.checkOutboxBacklog([])
  service.checkOutboxBacklog([{ id: 'old', status: 'pending', eventAt: Date.now() - 3 * 60 * 1000 }])
  const ageEvent = events().filter(item => item.event === 'outbox.backlog').find(item => item.payload.pending === 1)
  assert.ok(ageEvent)
  assert.ok(ageEvent.payload.oldestAgeMs > 2 * 60 * 1000)

  assert.deepEqual(WECHAT_ASSISTANT_RETRY_DELAYS_MS, [10_000, 30_000, 60_000, 180_000, 300_000])
  const chat = []
  service.controller.notifyChat = async text => { chat.push(text); return true }
  service.checkOutboxDeferredBacklog(Array.from({ length: 5 }, (_, index) => ({
    id: 'deferred-' + index, kind: WECHAT_ASSISTANT_NOTE_KIND, status: 'pending', eventAt: Date.now() - 1000,
  })))
  service.checkOutboxDeferredBacklog(Array.from({ length: 5 }, (_, index) => ({
    id: 'deferred-' + index, kind: WECHAT_ASSISTANT_NOTE_KIND, status: 'pending', eventAt: Date.now() - 1000,
  })))
  const deferredEvents = events().filter(item => item.event === 'outbox.deferred.backlog')
  assert.equal(deferredEvents.length, 1, 'deferred alert fires once for the same backlog')
  assert.equal(deferredEvents[0].payload.pending, 5)
  assert.equal(chat.length, 0, 'deferred backlog is event-only, no user push')
  service.checkOutboxDeferredBacklog([{ id: 'old-deferred', kind: WECHAT_ASSISTANT_NOTE_KIND, status: 'pending', eventAt: Date.now() - 3 * 60 * 1000 }])
  assert.ok(events().some(item => item.event === 'outbox.deferred.backlog' && item.payload.pending === 1))

  // A Claw ret=-2 keeps the durable entry and backoff; it is not cleared or
  // rewritten with a new id.
  const retry = enqueue('outbox-ret2-test')
  const originalSend = service.wechatClaw.sendAssistantNote
  let rejected = 0
  service.wechatClaw.sendAssistantNote = async () => {
    rejected += 1
    const error = new Error('sendmessage ret=-2')
    error.code = 'WECHAT_CLAW_PEER_REJECTED'
    error.ret = -2
    throw error
  }
  await service.tickOutbox()
  const retryEntry = service.outbox.entry(retry.id)
  assert.equal(rejected, 1)
  assert.equal(retryEntry.status, 'pending')
  assert.equal(retryEntry.attempts, 1)
  assert.ok(retryEntry.due - Date.now() <= 11_000, 'first assistant retry uses the 10s backoff')
  retryEntry.due = Date.now()
  service.wechatClaw.sendAssistantNote = originalSend
  await service.tickOutbox()
  assert.equal(service.outbox.entry(retry.id).status, 'delivered')
  console.log('outbox pump/backlog ok')
} finally {
  fixture.cleanup()
}