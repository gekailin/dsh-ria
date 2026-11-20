import assert from 'node:assert/strict'
import { createFixture } from './support/ria-fixture.mjs'

// Stuck detection must look at the Worker session, not only the ticket record:
// a Worker that runs many steps without worker_report(progress) keeps the
// ticket record frozen while the session is perfectly alive.
const fixture = await createFixture({ v2Default: true })
try {
  await fixture.service.ensure()
  const controller = fixture.service.v2
  const worker = await controller.ensureWorker('global')
  const ticket = fixture.service.store.addTicket({ status: 'working', executor: worker.sessionId, goal: 'long multi-step task' })
  controller.v2.setTicketMeta(ticket.ticketId, { phase: 'working', workerId: worker.sessionId })
  const now = Date.now()
  const stale = now - 60 * 60000
  const stored = fixture.service.store.ticket(ticket.ticketId)
  stored.progress = { lastPhase: 'step 25', lastEventAt: stale }
  stored.updatedAt = stale
  fixture.service.store.save()
  const staleAge = () => fixture.service.store.ticket(ticket.ticketId).updatedAt

  // (a) Session events are fresh: the ticket is advancing, however old its record.
  controller.turnStartedAt.set(worker.sessionId, now - 30_000)
  fixture.service.onSessionEvent({ header: { id: worker.sessionId } }, { type: 'step/start', time: now - 30_000, data: { step: 25 } })
  const fresh = controller.ticketHealth(fixture.service.store.ticket(ticket.ticketId), now)
  assert.equal(fresh.activeTurn, true)
  assert.equal(fresh.lastEventAgeMinutes > 50, true, 'ticket record is old')
  assert.equal(fresh.sessionLastEventAgeMinutes < 1, true)
  assert.equal(fresh.stuckSuspect, false, 'a live session is never stuck')
  assert.equal(fresh.stuckReason, null)

  // (b) Session silent past 15 min AND ticket record past 10 min: stuck, and the
  // reason names the session with both clocks.
  controller.sessionLastEventAt.set(worker.sessionId, now - 16 * 60000)
  const silent = controller.ticketHealth(fixture.service.store.ticket(ticket.ticketId), now)
  assert.equal(silent.stuckSuspect, true)
  assert.match(silent.stuckReason, /会话无事件 16 分钟/)
  assert.match(silent.stuckReason, /阈值 15 分钟/)
  assert.match(silent.stuckReason, /工单记录无更新 60 分钟/)
  assert.match(silent.stuckReason, /\d{4}-\d{2}-\d{2} \d{2}:\d{2}/)

  // (c) No session activity known: degraded to the old ticket-record rule.
  controller.sessionLastEventAt.delete(worker.sessionId)
  const degraded = controller.ticketHealth(fixture.service.store.ticket(ticket.ticketId), now)
  assert.equal(degraded.sessionLastEventAgeMinutes, null)
  assert.equal(degraded.stuckSuspect, true)
  assert.match(degraded.stuckReason, /工单记录无更新 60 分钟/)
  assert.match(degraded.stuckReason, /阈值 10 分钟/)

  // (d) Blocked and terminal tickets never report stuck.
  const blocked = fixture.service.store.transitionTicket(ticket.ticketId, 'blocked', { actor: 'test', waitingOn: 'environment', blockedReason: 'manual', reason: 'manual' })
  assert.equal(blocked.ok, true, JSON.stringify(blocked))
  const blockedHealth = controller.ticketHealth(fixture.service.store.ticket(ticket.ticketId), now)
  assert.equal(blockedHealth.stuckSuspect, false)
  assert.equal(blockedHealth.stuckReason, null)

  console.log('ticket health session-first stuck detection ok')
} finally {
  fixture.cleanup()
}
