import assert from 'node:assert/strict'
import { createFixture } from './support/ria-fixture.mjs'

const fixture = await createFixture({ queues: { 'session-worker': [{ id: 'queued-1' }] }, running: true })
const { service } = fixture

try {
  const store = service.store
  const queueWakes = () => service.outbox.all().filter(entry => entry.kind === 'queue_wake')
  const queueBlocks = () => service.outbox.all().filter(entry => entry.kind === 'queue_blocked')

  // A ticket with unfinished dependencies opens as waitingOn=dependency and
  // cannot be dispatched, even with a token.
  const upstream = await fixture.call('ria_ticket', { goal: 'write the draft', executor: 'session-worker' })
  const upstreamId = upstream.ticket.ticketId
  const downstream = await fixture.call('ria_ticket', {
    goal: 'edit the draft',
    executor: 'session-worker',
    dependsOn: [upstreamId],
  })
  const downstreamId = downstream.ticket.ticketId
  assert.equal(downstream.ticket.status, 'open')
  assert.equal(downstream.ticket.waitingOn, 'dependency')
  assert.deepEqual(downstream.ticket.dependsOn, [upstreamId])
  assert.equal(downstream.ticket.readyAt, null)
  assert.equal(downstream.ticket.queueState, undefined)

  const waiting = await fixture.call('ria_status', { ticketId: downstreamId })
  assert.equal(waiting.ticket.queueState, 'waiting_dependency')
  assert.match(waiting.ticket.queueText, /排队中/)
  assert.equal(waiting.ticket.queueToken, null)
  assert.equal(waiting.ticket.blockedBy[0].ticketId, upstreamId)
  assert.equal(waiting.ticket.blockedBy[0].status, 'open')

  const promptsBefore = fixture.prompts.length
  const refused = await fixture.call('ria_request', {
    targetSessionIds: ['session-worker'],
    message: 'start editing',
    ticketId: downstreamId,
    note: '试图提前派发。',
  })
  assert.equal(refused.ok, false)
  assert.equal(refused.code, 'ticket_not_ready')
  assert.match(refused.message, /还没就绪/)
  assert.equal(fixture.prompts.length, promptsBefore)

  // Finishing the upstream makes it ready exactly once and records one wake.
  const done = store.transitionTicket(upstreamId, 'working', { reason: 'dispatch' })
  assert.equal(done.ok, true)
  const finished = store.transitionTicket(upstreamId, 'done', { resolution: { summary: 'draft done' }, reason: 'worker done' })
  assert.equal(finished.ok, true)
  const readyTicket = store.ticket(downstreamId)
  assert.equal(readyTicket.waitingOn, 'ria')
  assert.equal(typeof readyTicket.readyAt, 'number')
  assert.equal(queueWakes().filter(entry => entry.payload.ticketId === downstreamId).length, 1)
  const token = store.queueTokenFor(readyTicket)
  assert.match(token, new RegExp('^' + downstreamId + ':'))

  // Recomputing without a state change must not enqueue a second wake.
  store.syncDependents(upstreamId)
  assert.equal(queueWakes().filter(entry => entry.payload.ticketId === downstreamId).length, 1)

  const missingToken = await fixture.call('ria_request', {
    targetSessionIds: ['session-worker'],
    message: 'start editing',
    ticketId: downstreamId,
    note: '缺少 token。',
  })
  assert.equal(missingToken.code, 'ticket_not_ready')
  assert.match(missingToken.message, /queueToken/)

  // The worker has a queued item: queue-mode dispatch is refused, steer is not.
  const busy = await fixture.call('ria_request', {
    targetSessionIds: ['session-worker'],
    message: 'start editing',
    ticketId: downstreamId,
    note: '忙碌 worker。',
    queueToken: token,
  })
  assert.equal(busy.results[0].ok, false)
  assert.equal(busy.results[0].code, 'worker_busy')
  assert.match(busy.results[0].message, /不要给忙碌 worker 排队/)
  assert.match(busy.results[0].message, /dependsOn/)
  assert.equal(fixture.prompts.length, promptsBefore)

  const steered = await fixture.call('ria_request', {
    targetSessionIds: ['session-worker'],
    message: 'just a note',
    ticketId: downstreamId,
    note: '同步信息。',
    mode: 'steer',
    queueToken: token,
  })
  assert.equal(steered.results[0].ok, true)
  assert.equal(fixture.prompts.at(-1).mode, 'steer')
  assert.equal(store.ticket(downstreamId).status, 'working')

  // Steer needs a turn that is actually running: DSH's controller would accept
  // the call for an idle session and silently drop the input.
  const idleTicket = await fixture.call('ria_ticket', { goal: 'idle dispatch', executor: 'session-worker' })
  fixture.queues.set('session-worker', [])
  fixture.setRunning('session-worker', false)
  const idleSteerPrompts = fixture.prompts.length
  const idleSteer = await fixture.call('ria_request', {
    targetSessionIds: ['session-worker'],
    message: 'too early',
    ticketId: idleTicket.ticket.ticketId,
    note: '试图 steer 空闲 worker。',
    mode: 'steer',
  })
  assert.equal(idleSteer.results[0].ok, false)
  assert.equal(idleSteer.results[0].code, 'steer_requires_running')
  assert.match(idleSteer.results[0].message, /running=false/)
  assert.match(idleSteer.results[0].message, /mode=queue/)
  assert.equal(fixture.prompts.length, idleSteerPrompts)
  assert.equal(store.ticket(idleTicket.ticket.ticketId).status, 'open')

  // An idle worker accepts a normal queue dispatch.
  const idle = await fixture.call('ria_request', {
    targetSessionIds: ['session-worker'],
    message: 'go',
    ticketId: idleTicket.ticket.ticketId,
    note: '空闲派发。',
  })
  assert.equal(idle.results[0].ok, true)
  assert.equal(fixture.prompts.at(-1).mode, 'queue')

  // Dependency input validation: self, duplicate, missing, cycle, and limit are
  // rejected without writing the ticket.
  const before = store.tickets().length
  assert.throws(
    () => store.updateTicket(upstreamId, { dependsOn: [upstreamId] }),
    error => error.code === 'dependency_self',
  )
  await assert.rejects(
    () => fixture.call('ria_ticket', { goal: 'bad', executor: 'session-worker', dependsOn: [upstreamId, upstreamId] }),
    error => error.code === 'dependency_duplicate',
  )
  await assert.rejects(
    () => fixture.call('ria_ticket', { goal: 'bad', executor: 'session-worker', dependsOn: ['ticket_missing'] }),
    error => error.code === 'dependency_missing',
  )
  const many = []
  for (let index = 0; index < 9; index += 1) {
    const item = store.addTicket({ goal: 'limit ' + index, executor: 'session-worker' })
    many.push(item.ticketId)
  }
  await assert.rejects(
    () => fixture.call('ria_ticket', { goal: 'too many', executor: 'session-worker', dependsOn: many }),
    error => error.code === 'dependency_limit',
  )
  assert.equal(store.tickets().length, before + 9)

  // A cycle is rejected and leaves the edited ticket unchanged.
  const cycleA = store.addTicket({ goal: 'cycle a', executor: 'session-worker' })
  const cycleB = store.addTicket({ goal: 'cycle b', executor: 'session-worker', dependsOn: [cycleA.ticketId] })
  const cycleBefore = store.ticket(cycleB.ticketId).revision
  await assert.rejects(
    () => fixture.call('ria_ticket', { ticketId: cycleA.ticketId, dependsOn: [cycleB.ticketId] }),
    error => error.code === 'dependency_cycle',
  )
  assert.equal(store.ticket(cycleA.ticketId).dependsOn.length, 0)
  assert.equal(store.ticket(cycleB.ticketId).revision, cycleBefore)

  // Upstream failed produces an alert and a blocking notice. A blocked upstream
  // only keeps waiting.
  const failSource = store.addTicket({ goal: 'fails', executor: 'session-worker' })
  const failWaiter = store.addTicket({ goal: 'waits on failure', executor: 'session-worker', dependsOn: [failSource.ticketId] })
  store.transitionTicket(failSource.ticketId, 'working', { reason: 'dispatch' })
  store.transitionTicket(failSource.ticketId, 'failed', { failure: { code: 'worker_failed', message: 'boom', at: Date.now() }, reason: 'worker failed' })
  const alerted = store.ticket(failWaiter.ticketId)
  assert.equal(alerted.waitingOn, 'dependency')
  assert.deepEqual(alerted.dependencyAlerts.map(alert => alert.status), ['failed'])
  assert.equal(store.queueInfo(alerted).queueState, 'dependency_alert')
  assert.equal(queueBlocks().filter(entry => entry.payload.ticketId === failWaiter.ticketId).length, 1)

  const blockedSource = store.addTicket({ goal: 'blocks', executor: 'session-worker' })
  const blockedWaiter = store.addTicket({ goal: 'waits on block', executor: 'session-worker', dependsOn: [blockedSource.ticketId] })
  store.transitionTicket(blockedSource.ticketId, 'blocked', { blockedReason: 'need user', waitingOn: 'user', reason: 'blocked' })
  assert.equal(store.ticket(blockedWaiter.ticketId).dependencyAlerts.length, 0)
  assert.equal(store.queueInfo(store.ticket(blockedWaiter.ticketId)).queueState, 'waiting_dependency')

  // Cascade cancel: waiting downstream is cancelled, running downstream is
  // deferred, and the ready wake is invalidated.
  const cascadeRoot = store.addTicket({ goal: 'cascade root', executor: 'session-worker' })
  const cascadeOpen = store.addTicket({ goal: 'cascade open', executor: 'session-worker', dependsOn: [cascadeRoot.ticketId] })
  const cascadeWorking = store.addTicket({ goal: 'cascade working', executor: 'session-worker', dependsOn: [cascadeRoot.ticketId] })
  store.transitionTicket(cascadeWorking.ticketId, 'working', { reason: 'dispatch' })
  const cascaded = await fixture.call('ria_ticket', { ticketId: cascadeRoot.ticketId, status: 'cancelled', cascade: 'downstream', reason: 'user changed plans' })
  assert.equal(cascaded.ok, true)
  assert.ok(cascaded.cancelled.some(item => item.ticketId === cascadeRoot.ticketId))
  assert.ok(cascaded.cancelled.some(item => item.ticketId === cascadeOpen.ticketId))
  assert.equal(store.ticket(cascadeOpen.ticketId).resolution.kind, 'cascade_cancel')
  assert.deepEqual(cascaded.deferred.map(item => item.ticketId), [cascadeWorking.ticketId])
  assert.equal(store.ticket(cascadeWorking.ticketId).status, 'working')

  // Merge moves incoming edges to the target; the merged source no longer
  // gates downstream tickets.
  const mergeTarget = store.addTicket({ goal: 'merge target', executor: 'session-worker' })
  const mergeSource = store.addTicket({ goal: 'merge source', executor: 'session-worker' })
  const mergeWaiter = store.addTicket({ goal: 'waits on merge source', executor: 'session-worker', dependsOn: [mergeSource.ticketId] })
  const merged = await fixture.call('ria_ticket', {
    action: 'merge',
    sourceTicketId: mergeSource.ticketId,
    targetTicketId: mergeTarget.ticketId,
    note: 'same work',
  })
  assert.equal(merged.ok, true)
  assert.deepEqual(store.ticket(mergeWaiter.ticketId).dependsOn, [mergeTarget.ticketId])
  assert.equal(store.ticket(mergeSource.ticketId).resolution.kind, 'merged')

  // Status exposes a queue overview.
  const status = await fixture.call('ria_status', { scope: 'tickets' })
  assert.ok(status.queue)
  assert.ok(Array.isArray(status.queue.items))
  const waitingItem = status.queue.items.find(item => item.ticketId === mergeWaiter.ticketId)
  assert.equal(waitingItem.queueState, 'waiting_dependency')
  assert.match(waitingItem.queueText, /排队中/)

  // ria_resolve kind=work accepts dependsOn and opens the intake as dependency.
  const intake = store.addTicket({ status: 'intake', goal: 'intake with dependency', executor: 'session-worker' })
  const resolved = await fixture.call('ria_resolve', {
    ticketId: intake.ticketId,
    kind: 'work',
    goal: 'downstream work',
    executor: 'session-worker',
    dependsOn: [mergeTarget.ticketId],
  })
  assert.equal(resolved.ok, true)
  assert.equal(resolved.ticket.waitingOn, 'dependency')
  assert.deepEqual(resolved.ticket.dependsOn, [mergeTarget.ticketId])

  console.log('ticket queue ok')
} finally {
  fixture.cleanup()
}