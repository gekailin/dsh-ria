import assert from 'node:assert/strict'
import { createFixture } from './support/ria-fixture.mjs'
import { WECHAT_ASSISTANT_NOTE_KIND } from '../lib/outbox.mjs'

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
  console.log('outbox pump/backlog ok')
} finally {
  fixture.cleanup()
}
