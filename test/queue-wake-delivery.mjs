import assert from 'node:assert/strict'
import { createFixture } from './support/ria-fixture.mjs'

const waitFor = async (predicate, timeoutMs = 2000) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  return predicate()
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

const riaSession = fixture => ({ header: { id: fixture.service.store.riaSessionId || fixture.riaAgent.id } })
const turnStart = turn => ({ type: 'turn/start', data: { turn } })
const turnEnd = turn => ({ type: 'turn/end', data: { turn, reason: { kind: 'completed' } } })

const wakesFor = (fixture, ticketId) => fixture.service.outbox.all()
  .filter(entry => entry.kind === 'queue_wake' && entry.payload && entry.payload.ticketId === ticketId)

// Build a ready downstream ticket but hold the pump so each scenario controls
// exactly when delivery is attempted.
const readyPair = async fixture => {
  const store = fixture.service.store
  const upstream = await fixture.call('ria_ticket', { goal: 'write the draft', executor: 'session-worker' })
  const downstream = await fixture.call('ria_ticket', {
    goal: 'edit the draft',
    executor: 'session-worker',
    dependsOn: [upstream.ticket.ticketId],
  })
  assert.equal(store.transitionTicket(upstream.ticket.ticketId, 'working', { reason: 'dispatch' }).ok, true)
  fixture.service.queuePumpSuspended = true
  // Drop the durability callback to prove delivery only depends on committed state.
  store.onQueueEvent = () => {}
  assert.equal(store.transitionTicket(upstream.ticket.ticketId, 'done', {
    resolution: { summary: 'draft done' },
    reason: 'worker done',
  }).ok, true)
  const ticket = store.ticket(downstream.ticket.ticketId)
  assert.equal(ticket.waitingOn, 'ria')
  assert.ok(Number.isFinite(ticket.readyAt))
  assert.equal(ticket.readyNotifiedAt, null)
  const wakes = wakesFor(fixture, downstream.ticket.ticketId)
  assert.equal(wakes.length, 1)
  assert.equal(wakes[0].status, 'pending')
  return { upstreamId: upstream.ticket.ticketId, downstreamId: downstream.ticket.ticketId, wake: wakes[0] }
}

const fixtureFor = () => createFixture({ queues: { 'session-worker': [{ id: 'queued-1' }] }, running: true })

// 1. No active turn: the cold pump delivers the wake, stamps readyNotifiedAt,
//    and a second pump does not deliver it again.
{
  const fixture = await fixtureFor()
  try {
    const { downstreamId } = await readyPair(fixture)
    const { service } = fixture
    assert.equal(service.currentRiaTurn, undefined)
    service.queuePumpSuspended = false
    await service.pumpOutbox('cold')
    assert.ok(await waitFor(() => Number.isFinite(service.store.ticket(downstreamId).readyNotifiedAt)))
    const wakes = wakesFor(fixture, downstreamId)
    assert.equal(wakes.length, 1)
    assert.equal(wakes[0].status, 'delivered')
    assert.equal(fixture.prompts.length, 1)
    assert.match(fixture.prompts[0].content.map(part => part.text || '').join('\n'), /^\[Queue ready\]/)

    await service.pumpOutbox('again')
    service.publishReadyNotices()
    await service.pumpOutbox('after-publish')
    await sleep(30)
    assert.equal(fixture.prompts.length, 1)
    assert.equal(wakesFor(fixture, downstreamId).length, 1)
  } finally {
    fixture.cleanup()
  }
}

// 2. A turn starts after the wake is pending: the turn-start pump must leave it
//    queued, and turn/end must deliver it exactly once.
{
  const fixture = await fixtureFor()
  try {
    const { downstreamId } = await readyPair(fixture)
    const { service } = fixture
    service.queuePumpSuspended = false
    service.onSessionEvent(riaSession(fixture), turnStart(11))
    assert.equal(service.currentRiaTurn, 11)
    await service.pumpOutbox('turn-start')
    await sleep(30)
    assert.equal(fixture.prompts.length, 0)
    assert.equal(wakesFor(fixture, downstreamId)[0].status, 'pending')

    service.onSessionEvent(riaSession(fixture), turnEnd(11))
    assert.ok(await waitFor(() => Number.isFinite(service.store.ticket(downstreamId).readyNotifiedAt)))
    assert.equal(service.currentRiaTurn, undefined)
    assert.equal(fixture.prompts.length, 1)
    assert.equal(wakesFor(fixture, downstreamId)[0].status, 'delivered')
  } finally {
    fixture.cleanup()
  }
}

// 3. A turn is already running when the upstream closes: the save hook publishes
//    the wake, the active turn defers it, and the turn-end pump delivers it.
{
  const fixture = await fixtureFor()
  try {
    const { service } = fixture
    service.onSessionEvent(riaSession(fixture), turnStart(12))
    assert.equal(service.currentRiaTurn, 12)
    const { downstreamId } = await readyPair(fixture)
    service.queuePumpSuspended = false
    await service.pumpOutbox('active')
    await sleep(30)
    assert.equal(fixture.prompts.length, 0)
    assert.equal(wakesFor(fixture, downstreamId)[0].status, 'pending')

    service.onSessionEvent(riaSession(fixture), turnEnd(12))
    assert.ok(await waitFor(() => Number.isFinite(service.store.ticket(downstreamId).readyNotifiedAt)))
    assert.equal(fixture.prompts.length, 1)
    assert.equal(wakesFor(fixture, downstreamId)[0].status, 'delivered')
    assert.match(fixture.prompts[0].content.map(part => part.text || '').join('\n'), new RegExp(downstreamId))
  } finally {
    fixture.cleanup()
  }
}

// 4. A failed prompt records lastError and increments attempts; after six
//    failures the terminal entry remains readable through ria_status.
{
  const fixture = await fixtureFor()
  try {
    const { downstreamId } = await readyPair(fixture)
    const { service } = fixture
    service.queuePumpSuspended = false
    fixture.setPromptFailure(new Error('outbox transport failed'))
    await service.pumpOutbox('fail-1')
    let wake = wakesFor(fixture, downstreamId)[0]
    assert.equal(wake.status, 'pending')
    assert.equal(wake.attempts, 1)
    assert.equal(wake.lastError, 'outbox transport failed')
    assert.equal(fixture.prompts.length, 0)
    assert.equal(service.store.ticket(downstreamId).readyNotifiedAt, null)

    for (let attempt = 2; attempt <= 6; attempt += 1) {
      wake = service.outbox.entry(wake.id)
      wake.due = Date.now() - 1
      await service.pumpOutbox('fail-' + attempt)
      wake = service.outbox.entry(wake.id)
      assert.equal(wake.attempts, attempt)
      assert.equal(wake.lastError, 'outbox transport failed')
      assert.equal(wake.status, attempt < 6 ? 'pending' : 'failed')
    }
    assert.equal(fixture.prompts.length, 0)
    assert.equal(service.store.ticket(downstreamId).readyNotifiedAt, null)

    const status = await fixture.call('ria_status', {})
    assert.equal(status.outbox.failed, 1)
    const item = status.outbox.items.find(entry => entry.ticketId === downstreamId && entry.kind === 'queue_wake')
    assert.ok(item)
    assert.equal(item.status, 'failed')
    assert.equal(item.attempts, 6)
    assert.equal(item.lastError, 'outbox transport failed')
  } finally {
    fixture.cleanup()
  }
}

console.log('queue wake delivery ok')
