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

const wakesFor = (service, ticketId) => service.outbox.all()
  .filter(entry => entry.kind === 'queue_wake' && entry.payload && entry.payload.ticketId === ticketId)

const queueText = prompt => prompt.content.map(part => part.text || '').join('\n')

// Create an upstream/downstream pair and start the upstream so finishing it
// crosses the dependency boundary exactly once.
const readyPair = async fixture => {
  const upstream = await fixture.call('ria_ticket', { goal: 'write the draft', executor: 'session-worker' })
  const downstream = await fixture.call('ria_ticket', {
    goal: 'edit the draft',
    executor: 'session-worker',
    dependsOn: [upstream.ticket.ticketId],
  })
  const working = fixture.service.store.transitionTicket(upstream.ticket.ticketId, 'working', { reason: 'dispatch' })
  assert.equal(working.ok, true)
  return { upstreamId: upstream.ticket.ticketId, downstreamId: downstream.ticket.ticketId }
}

// 1. The ready event callback is lost, but the committed state still carries
//    readyAt with readyNotifiedAt=null. The save hook must publish and deliver.
{
  const fixture = await createFixture({ queues: { 'session-worker': [{ id: 'queued-1' }] }, running: true })
  const { service } = fixture
  try {
    const store = service.store
    service.queuePumpSuspended = false
    const { upstreamId, downstreamId } = await readyPair(fixture)
    // Drop the durability callback entirely: only state remains.
    store.onQueueEvent = () => {}
    const finished = store.transitionTicket(upstreamId, 'done', { resolution: { summary: 'draft done' }, reason: 'worker done' })
    assert.equal(finished.ok, true)
    const ready = store.ticket(downstreamId)
    assert.equal(ready.status, 'open')
    assert.equal(ready.waitingOn, 'ria')
    assert.ok(Number.isFinite(ready.readyAt))
    assert.equal(ready.readyNotifiedAt, null)

    assert.ok(await waitFor(() => Number.isFinite(store.ticket(downstreamId).readyNotifiedAt)), 'wake should be delivered from committed state')
    const wakes = wakesFor(service, downstreamId)
    assert.equal(wakes.length, 1)
    assert.equal(wakes[0].status, 'delivered')
    assert.equal(fixture.prompts.length, 1)
    const text = queueText(fixture.prompts[0])
    assert.match(text, /^\[Queue ready\]/)
    assert.match(text, new RegExp(downstreamId))
    assert.match(text, /queueToken=/)
  } finally {
    fixture.cleanup()
  }
}

// 2. Invalidate removes only the wake for its own readyAt. A qualified
//    invalidation drops the pending wake; the next publish point restores it
//    once, and the restored wake can still be delivered.
{
  const fixture = await createFixture({ queues: { 'session-worker': [{ id: 'queued-1' }] }, running: true })
  const { service } = fixture
  try {
    const store = service.store
    const { upstreamId, downstreamId } = await readyPair(fixture)
    const finished = store.transitionTicket(upstreamId, 'done', { resolution: { summary: 'draft done' }, reason: 'worker done' })
    assert.equal(finished.ok, true)
    const ready = store.ticket(downstreamId)
    assert.ok(Number.isFinite(ready.readyAt))
    assert.equal(wakesFor(service, downstreamId).length, 1)
    assert.equal(wakesFor(service, downstreamId)[0].status, 'pending')

    service.handleQueueEvent({ kind: 'invalidate', ticketId: downstreamId, readyAt: ready.readyAt + 1 })
    assert.equal(wakesFor(service, downstreamId).length, 1, 'an unrelated readyAt must not remove the wake')

    service.handleQueueEvent({ kind: 'invalidate', ticketId: downstreamId, readyAt: ready.readyAt })
    assert.equal(wakesFor(service, downstreamId).length, 0)

    assert.equal(service.publishReadyNotices(), 1)
    const restored = wakesFor(service, downstreamId)
    assert.equal(restored.length, 1)
    assert.equal(restored[0].status, 'pending')
    assert.equal(service.publishReadyNotices(), 0, 'publishing is idempotent while the wake is pending')
    assert.equal(wakesFor(service, downstreamId).length, 1)

    service.queuePumpSuspended = false
    assert.equal(service.publishReadyNotices(), 0)
    assert.ok(await waitFor(() => Number.isFinite(store.ticket(downstreamId).readyNotifiedAt)))
    assert.equal(wakesFor(service, downstreamId).length, 1)
    assert.equal(wakesFor(service, downstreamId)[0].status, 'delivered')
    assert.equal(fixture.prompts.length, 1)
  } finally {
    fixture.cleanup()
  }
}

// 3. Once readyNotifiedAt is stamped, no later publish may enqueue or deliver
//    the same readiness again.
{
  const fixture = await createFixture({ queues: { 'session-worker': [{ id: 'queued-1' }] }, running: true })
  const { service } = fixture
  try {
    const store = service.store
    service.queuePumpSuspended = false
    const { upstreamId, downstreamId } = await readyPair(fixture)
    const finished = store.transitionTicket(upstreamId, 'done', { resolution: { summary: 'draft done' }, reason: 'worker done' })
    assert.equal(finished.ok, true)
    assert.ok(await waitFor(() => Number.isFinite(store.ticket(downstreamId).readyNotifiedAt)))
    const notifiedAt = store.ticket(downstreamId).readyNotifiedAt
    const promptsBefore = fixture.prompts.length
    assert.equal(promptsBefore, 1)

    assert.equal(service.publishReadyNotices(), 0)
    await new Promise(resolve => setTimeout(resolve, 50))
    assert.equal(fixture.prompts.length, promptsBefore)
    assert.equal(wakesFor(service, downstreamId).length, 1)
    assert.equal(store.ticket(downstreamId).readyNotifiedAt, notifiedAt)
  } finally {
    fixture.cleanup()
  }
}

// 4. A boot reconcile that makes a ticket ready emits exactly one
//    boot-scoped wake. The save hook must not add a parallel state wake for the
//    same readiness before the reconcile event has had its chance.
{
  const fixture = await createFixture({ queues: { 'session-worker': [{ id: 'queued-1' }] }, running: true })
  const { service } = fixture
  try {
    const store = service.store
    const { upstreamId, downstreamId } = await readyPair(fixture)
    const finished = store.transitionTicket(upstreamId, 'done', { resolution: { summary: 'draft done' }, reason: 'worker done' })
    assert.equal(finished.ok, true)

    // Rewind the downstream to the pre-ready state, as if the upstream had
    // finished while dsh was not running.
    const ticket = store.ticket(downstreamId)
    ticket.waitingOn = 'dependency'
    ticket.readyAt = null
    ticket.readyNotifiedAt = null
    ticket.revision += 1
    for (const entry of wakesFor(service, downstreamId)) service.outbox.removeWhere(item => item.id === entry.id)
    assert.equal(wakesFor(service, downstreamId).length, 0)
    assert.equal(fixture.prompts.length, 0)

    await service.startup()
    const wakes = wakesFor(service, downstreamId)
    assert.equal(wakes.length, 1, 'boot reconcile must produce exactly one wake')
    assert.equal(String(wakes[0].payload.bootId || '').startsWith('boot_'), true)
    assert.equal(wakes[0].status, 'delivered')
    assert.ok(Number.isFinite(store.ticket(downstreamId).readyAt))
    assert.ok(Number.isFinite(store.ticket(downstreamId).readyNotifiedAt))
    assert.equal(fixture.prompts.length, 1)
    const text = queueText(fixture.prompts[0])
    const listed = text.split('\n').filter(line => line.startsWith('- ticketId='))
    assert.equal(listed.length, 1, 'the wake prompt must list the ticket once')
    assert.match(listed[0], new RegExp(downstreamId))
  } finally {
    fixture.cleanup()
  }
}

console.log('queue wake recovery ok')
