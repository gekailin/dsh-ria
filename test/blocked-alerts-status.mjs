import assert from 'node:assert/strict'
import { createFixture } from './support/ria-fixture.mjs'
import { noticeText } from '../lib/core/notice.mjs'

const flush = () => new Promise(resolve => setTimeout(resolve, 0))

const fixture = await createFixture({ stateDefault: true })
try {
  const controller = fixture.service.controller
  const store = fixture.service.store
  const chat = controller.state.chatSessionId
  const notices = []
  const events = []
  const logs = []
  const originalEvent = controller.routerEvent.bind(controller)
  controller.notifyChat = async message => { notices.push(noticeText(message)); return true }
  controller.routerEvent = event => { events.push(event); originalEvent(event) }
  controller.log = (level, message) => { logs.push(level + ': ' + message) }

  // ---- blocked(waitingOn=user) notifies once, with dedupe + event -------------
  const longGoal = 'g'.repeat(200)
  const ticket = store.addTicket({ status: 'open', waitingOn: 'ria', executor: 'session-executor-x', goal: longGoal, acceptance: 'x' })
  const first = store.transitionTicket(ticket.ticketId, 'blocked', {
    actor: 'router', executor: 'session-executor-x', waitingOn: 'user',
    blockedReason: '需要你选择 A/B', attention: { kind: 'question', question: '选 A 还是 B？' }, reason: 'test block',
  })
  assert.equal(first.ok, true)
  await flush()
  assert.equal(notices.length, 1, 'one notification for the first block')
  assert.match(notices[0], /^🔔 #工单 需要你决定：/)
  assert.ok(notices[0].includes('选 A 还是 B'))
  assert.ok(notices[0].length <= 240)
  assert.equal(notices[0].includes(longGoal), false, 'goal must not leak into the status line')
  const delivered = events.filter(event => event.event === 'ticket.blocked.notified')
  assert.equal(delivered.length, 1)
  assert.equal(delivered[0].ticketId, ticket.ticketId)
  assert.equal(delivered[0].payload.edge, 'blocked.user')

  // A repeat callback for an already-blocked ticket is not a new edge.
  const current = store.ticket(ticket.ticketId)
  controller.onTicketTransition(current, { from: 'blocked', to: 'blocked', reason: 'repeat hook' })
  await flush()
  assert.equal(notices.length, 1, 'no new edge, no notice')

  // Unblock then block again is a new edge and notifies exactly once.
  const reopened = store.transitionTicket(ticket.ticketId, 'open', { actor: 'user', waitingOn: 'ria', reason: 'answered' })
  assert.equal(reopened.ok, true)
  const second = store.transitionTicket(ticket.ticketId, 'blocked', {
    actor: 'router', executor: 'session-executor-x', waitingOn: 'user',
    blockedReason: '第二个问题', attention: { kind: 'question', question: '继续吗？' }, reason: 'second block',
  })
  assert.equal(second.ok, true)
  await flush()
  assert.equal(notices.length, 2, 'unblock then block notifies again')
  assert.ok(notices[1].includes('继续吗'))

  // Delivery failure keeps the same tick; retry re-renders and delivers once.
  const failing = store.addTicket({ status: 'open', waitingOn: 'ria', executor: 'session-executor-y', goal: 'notify failure', acceptance: 'x' })
  controller.notifyChat = async () => false
  const failedBlock = store.transitionTicket(failing.ticketId, 'blocked', {
    actor: 'router', executor: 'session-executor-y', waitingOn: 'user', blockedReason: '等确认',
    attention: { kind: 'decision', question: '确认？' }, reason: 'notify failure',
  })
  assert.equal(failedBlock.ok, true)
  assert.equal(failedBlock.ticket.status, 'blocked')
  await flush()
  assert.equal(notices.length, 2, 'failed delivery did not add a notice')
  controller.notifyChat = async message => { notices.push(noticeText(message)); return true }
  await controller.drainPendingNotices()
  assert.equal(notices.length, 3, 'same tick retried once after transport recovery')
  assert.ok(notices[2].includes('确认'))

  // ---- ria_chat_status: all non-terminal tickets + age/stale/zombie fields -----
  controller.notifyChat = async () => true // keep unrelated transitions quiet
  const nowMs = Date.now()
  const make = (status, ageMinutes, extra = {}) => {
    const item = store.addTicket({ status, waitingOn: status === 'blocked' ? 'user' : (status === 'working' ? 'executor' : 'ria'), executor: 'session-ghost', goal: 'status ' + status + ' ' + ageMinutes, acceptance: 'x', ...extra })
    item.updatedAt = nowMs - ageMinutes * 60000
    return item
  }
  const zombie = make('open', 121)
  const ghostWorking = make('working', 90)
  const healthy = make('working', 120)
  controller.state.addExecutor('session-live', { kind: 'managed', status: 'working', currentTicketId: healthy.ticketId, executorType: 'work' })
  healthy.executor = 'session-live'
  controller.state.setTicketMeta(healthy.ticketId, { phase: 'working', executorId: 'session-live' })
  const exactly60 = make('open', 60)
  const fresh = make('open', 5)

  const list = await fixture.callAs(chat, 'ria_chat_status', {})
  assert.equal(list.ok, true)
  const ids = new Set(list.tickets.map(item => item.ticketId))
  for (const item of [zombie, ghostWorking, healthy, exactly60, fresh]) assert.ok(ids.has(item.ticketId), 'listed ' + item.ticketId)
  const ghostView = list.tickets.find(item => item.ticketId === ghostWorking.ticketId)
  assert.equal(ghostView.phase, null)
  assert.equal(ghostView.hasActiveExecutor, false)
  assert.equal(ghostView.ageMinutes, 90)
  assert.equal(ghostView.stale, true)
  assert.equal(ghostView.zombieSuspect, true)
  const zombieView = list.tickets.find(item => item.ticketId === zombie.ticketId)
  assert.equal(zombieView.zombieSuspect, true)
  assert.equal(zombieView.ageMinutes, 121)
  const healthyView = list.tickets.find(item => item.ticketId === healthy.ticketId)
  assert.equal(healthyView.hasActiveExecutor, true)
  assert.equal(healthyView.stale, true, 'executor has no open turn')
  assert.equal(healthyView.zombieSuspect, false)
  const boundary = list.tickets.find(item => item.ticketId === exactly60.ticketId)
  assert.equal(boundary.ageMinutes, 60)
  assert.equal(boundary.stale, false, 'exactly 60 minutes is not stale')
  assert.equal(boundary.zombieSuspect, false)
  assert.equal(list.tickets.find(item => item.ticketId === fresh.ticketId).ageMinutes, 5)

  const indexOf = id => list.tickets.findIndex(item => item.ticketId === id)
  assert.ok(indexOf(zombie.ticketId) < indexOf(ghostWorking.ticketId), 'older zombie first')
  assert.ok(indexOf(ghostWorking.ticketId) < indexOf(healthy.ticketId), 'zombies before non-zombies')
  assert.ok(indexOf(healthy.ticketId) < indexOf(exactly60.ticketId), 'non-zombies by age desc')
  assert.ok(indexOf(exactly60.ticketId) < indexOf(fresh.ticketId))

  // Single-ticket lookup stays a bundle, not a list.
  const single = await fixture.callAs(chat, 'ria_chat_status', { ticketId: zombie.ticketId })
  assert.equal(single.ok, true)
  assert.equal(single.found, true)
  assert.equal(single.ticket.ticketId, zombie.ticketId)
  assert.equal(Array.isArray(single.tickets), false)

  // attentionOverview derives waitedMs/stale on read (no timers) and sorts oldest-first.
  const baseNow = Date.UTC(2026, 10, 26, 12, 0, 0)
  const freshAttn = store.addTicket({
    status: 'blocked', waitingOn: 'user', executor: 'session-a', goal: 'fresh decision', acceptance: 'x',
    blockedReason: 'fresh q', attention: { kind: 'decision', question: 'fresh q', askedAt: baseNow - 30 * 60000 },
  })
  const staleAttn = store.addTicket({
    status: 'blocked', waitingOn: 'user', executor: 'session-b', goal: 'stale decision', acceptance: 'x',
    blockedReason: 'stale q', attention: { kind: 'decision', question: 'stale q', askedAt: baseNow - 5 * 60 * 60000 },
  })
  const overview = fixture.service.attentionOverview(baseNow)
  const staleItem = overview.items.find(item => item.ticketId === staleAttn.ticketId)
  const freshItem = overview.items.find(item => item.ticketId === freshAttn.ticketId)
  assert.ok(staleItem && freshItem)
  assert.equal(staleItem.waitedMs, 5 * 60 * 60000)
  assert.equal(staleItem.stale, true)
  assert.equal(freshItem.waitedMs, 30 * 60000)
  assert.equal(freshItem.stale, false)
  assert.ok(overview.staleCount >= 1)
  assert.ok(overview.items.indexOf(staleItem) < overview.items.indexOf(freshItem), 'oldest attention item first')

  console.log('state blocked alerts and status ok')
} finally {
  fixture.cleanup()
}
