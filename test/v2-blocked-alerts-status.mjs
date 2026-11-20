import assert from 'node:assert/strict'
import { createFixture } from './support/ria-fixture.mjs'

const flush = () => new Promise(resolve => setTimeout(resolve, 0))

const fixture = await createFixture({ v2Default: true })
try {
  const controller = fixture.service.v2
  const store = fixture.service.store
  const chatbot = controller.v2.chatSessionId
  const notices = []
  const events = []
  const logs = []
  const originalEvent = controller.routerEvent.bind(controller)
  controller.notifyChat = async message => { notices.push(message); return true }
  controller.routerEvent = event => { events.push(event); originalEvent(event) }
  controller.log = (level, message) => { logs.push(level + ': ' + message) }

  // ---- blocked(waitingOn=user) notifies once, with dedupe + event -------------
  const longGoal = 'g'.repeat(200)
  const ticket = store.addTicket({ status: 'open', waitingOn: 'ria', executor: 'session-worker-x', goal: longGoal, acceptance: 'x' })
  const first = store.transitionTicket(ticket.ticketId, 'blocked', {
    actor: 'router', executor: 'session-worker-x', waitingOn: 'user',
    blockedReason: '需要你选择 A/B', attention: { kind: 'question', question: '选 A 还是 B？' }, reason: 'test block',
  })
  assert.equal(first.ok, true)
  await flush()
  assert.equal(notices.length, 1, 'one notification for the first block')
  assert.ok(notices[0].includes(ticket.ticketId))
  assert.ok(notices[0].includes('选 A 还是 B？'))
  assert.ok(notices[0].includes('进入 blocked 时间：'))
  assert.ok(/\d{4}-\d{2}-\d{2}T/.test(notices[0]))
  assert.ok(notices[0].includes('g'.repeat(119) + '…'))
  assert.ok(!notices[0].includes('g'.repeat(120)), 'goal summary is clipped to 120 chars')
  assert.equal(events.filter(event => event.event === 'ticket.blocked.notified').length, 1)
  assert.equal(events.find(event => event.event === 'ticket.blocked.notified').ticketId, ticket.ticketId)
  const firstMeta = controller.v2.ticketMeta(ticket.ticketId)
  assert.equal(typeof firstMeta.blockedNotifiedKey, 'string')

  // Same revision/blockedReason: the handler must not notify again.
  const current = store.ticket(ticket.ticketId)
  controller.onTicketTransition(current, { from: 'open', to: 'blocked', reason: 'repeat hook' })
  await flush()
  assert.equal(notices.length, 1, 'same revision is deduped')

  // Unblock clears the marker; a new block (new revision/reason) notifies again.
  const reopened = store.transitionTicket(ticket.ticketId, 'open', { actor: 'user', waitingOn: 'ria', reason: 'answered' })
  assert.equal(reopened.ok, true)
  assert.equal(controller.v2.ticketMeta(ticket.ticketId).blockedNotifiedKey, null)
  const second = store.transitionTicket(ticket.ticketId, 'blocked', {
    actor: 'router', executor: 'session-worker-x', waitingOn: 'user',
    blockedReason: '第二个问题', attention: { kind: 'question', question: '继续吗？' }, reason: 'second block',
  })
  assert.equal(second.ok, true)
  await flush()
  assert.equal(notices.length, 2, 'unblock then block notifies again')
  assert.ok(notices[1].includes('继续吗？'))

  // Failure is logged, does not roll back the transition, and still dedupes.
  const failing = store.addTicket({ status: 'open', waitingOn: 'ria', executor: 'session-worker-y', goal: 'notify failure', acceptance: 'x' })
  controller.notifyChat = async () => { throw new Error('chat transport down') }
  const failedBlock = store.transitionTicket(failing.ticketId, 'blocked', {
    actor: 'router', executor: 'session-worker-y', waitingOn: 'user', blockedReason: '等确认',
    attention: { kind: 'decision', question: '确认？' }, reason: 'notify failure',
  })
  assert.equal(failedBlock.ok, true)
  assert.equal(failedBlock.ticket.status, 'blocked')
  await flush()
  assert.ok(logs.some(line => line.includes('could not notify Chat about blocked ticket ' + failing.ticketId)))
  controller.onTicketTransition(store.ticket(failing.ticketId), { from: 'open', to: 'blocked' })
  await flush()
  assert.equal(logs.filter(line => line.includes('could not notify Chat about blocked ticket ' + failing.ticketId)).length, 1, 'failure still dedupes')

  // ---- chatbot_status: all non-terminal tickets + age/stale/zombie fields -----
  controller.notifyChat = async () => true // keep unrelated transitions quiet
  const nowMs = Date.now()
  const make = (status, ageMinutes, extra = {}) => {
    const item = store.addTicket({ status, waitingOn: status === 'blocked' ? 'user' : (status === 'working' ? 'worker' : 'ria'), executor: 'session-ghost', goal: 'status ' + status + ' ' + ageMinutes, acceptance: 'x', ...extra })
    item.updatedAt = nowMs - ageMinutes * 60000
    return item
  }
  const zombie = make('open', 121)
  const ghostWorking = make('working', 90)
  const healthy = make('working', 120)
  controller.v2.addWorker('session-live', { kind: 'managed', status: 'working', currentTicketId: healthy.ticketId, workerType: 'work' })
  healthy.executor = 'session-live'
  controller.v2.setTicketMeta(healthy.ticketId, { phase: 'working', workerId: 'session-live' })
  const exactly60 = make('open', 60)
  const fresh = make('open', 5)

  const list = await fixture.callAs(chatbot, 'chatbot_status', {})
  assert.equal(list.ok, true)
  const ids = new Set(list.tickets.map(item => item.ticketId))
  for (const item of [zombie, ghostWorking, healthy, exactly60, fresh]) assert.ok(ids.has(item.ticketId), 'listed ' + item.ticketId)
  const ghostView = list.tickets.find(item => item.ticketId === ghostWorking.ticketId)
  assert.equal(ghostView.phase, null)
  assert.equal(ghostView.hasActiveWorker, false)
  assert.equal(ghostView.ageMinutes, 90)
  assert.equal(ghostView.stale, true)
  assert.equal(ghostView.zombieSuspect, true)
  const zombieView = list.tickets.find(item => item.ticketId === zombie.ticketId)
  assert.equal(zombieView.zombieSuspect, true)
  assert.equal(zombieView.ageMinutes, 121)
  const healthyView = list.tickets.find(item => item.ticketId === healthy.ticketId)
  assert.equal(healthyView.hasActiveWorker, true)
  assert.equal(healthyView.stale, true, 'worker has no open turn')
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
  const single = await fixture.callAs(chatbot, 'chatbot_status', { ticketId: zombie.ticketId })
  assert.equal(single.ok, true)
  assert.equal(single.found, true)
  assert.equal(single.ticket.ticketId, zombie.ticketId)
  assert.equal(Array.isArray(single.tickets), false)

  console.log('v2 blocked alerts and status ok')
} finally {
  fixture.cleanup()
}
