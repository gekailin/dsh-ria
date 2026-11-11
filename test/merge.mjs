import assert from 'node:assert/strict'
import { createFixture } from './support/ria-fixture.mjs'
import { isTerminal } from '../lib/tickets.mjs'

function open(store, overrides = {}) {
  return store.addTicket({
    goal: 'finish the report',
    acceptance: 'tests pass',
    executor: 'session-worker',
    ...overrides,
  })
}

function container(store, overrides = {}) {
  return store.addTicket({
    goal: 'container',
    status: 'intake',
    executor: null,
    ...overrides,
  })
}

function forkedParent(store, goals) {
  const parent = container(store)
  for (const goal of goals) open(store, { goal, parentTicketId: parent.ticketId })
  const moved = store.transitionTicket(parent.ticketId, 'forked', { reason: 'split work' })
  assert.equal(moved.ok, true)
  return moved.ticket
}

function finish(store, ticketId, summary = 'done') {
  const working = store.transitionTicket(ticketId, 'working', {
    attempt: { lastRequestId: 'req_' + ticketId, startedAt: 1, legacy: false },
  })
  assert.equal(working.ok, true, working.message)
  const done = store.transitionTicket(ticketId, 'done', { resolution: { summary } })
  assert.equal(done.ok, true, done.message)
  return done.ticket
}

// 1. Basic merge: source closes with resolution.kind=merged; target keeps its
// executor/goal/acceptance and records the merge in history.
{
  const fixture = await createFixture()
  try {
    const store = fixture.service.store
    const source = open(store, { goal: 'write section A' })
    const target = open(store, { goal: 'write the report' })
    const targetGoal = target.goal
    const result = store.mergeTicket(source.ticketId, target.ticketId, { reason: 'same report' })
    assert.equal(result.ok, true, result.message)
    const closed = store.ticket(source.ticketId)
    const kept = store.ticket(target.ticketId)
    assert.equal(closed.status, 'done')
    assert.equal(closed.resolution.kind, 'merged')
    assert.equal(closed.resolution.mergedInto, target.ticketId)
    assert.equal(typeof closed.closedAt, 'number')
    assert.equal(kept.status, 'open')
    assert.equal(kept.goal, targetGoal)
    assert.equal(kept.executor, 'session-worker')
    const entry = kept.history.find(item => item.kind === 'merge')
    assert.equal(entry.from, source.ticketId)
    assert.equal(entry.to, target.ticketId)
    assert.equal(entry.snapshot.goal, 'write section A')
    assert.equal(store.activeTickets().some(item => item.ticketId === source.ticketId), false)
    const feedback = store.ticketFeedbacks()
    assert.equal(feedback.some(item => item.ticketId === target.ticketId && item.kind === 'merged' && item.code === 'merge_target'), true)
    assert.equal(feedback.some(item => item.ticketId === source.ticketId && item.kind === 'merged' && item.code === 'merged_into'), true)
  } finally {
    fixture.cleanup()
  }
}

// 2. Every rejected merge returns its code and leaves the store untouched.
{
  const fixture = await createFixture()
  try {
    const store = fixture.service.store
    const source = open(store)
    const target = open(store)
    const unchanged = () => assert.deepEqual(JSON.parse(JSON.stringify(store.data)), before)
    let before = JSON.parse(JSON.stringify(store.data))
    assert.equal(store.mergeTicket(source.ticketId, source.ticketId).code, 'merge_self')
    unchanged()
    assert.equal(store.mergeTicket(source.ticketId, 'task_missing').code, 'ticket_missing')
    unchanged()
    assert.equal(store.mergeTicket('task_missing', target.ticketId).code, 'ticket_missing')
    unchanged()

    const closedSource = open(store)
    store.transitionTicket(closedSource.ticketId, 'cancelled', { resolution: { reason: 'duplicate' } })
    before = JSON.parse(JSON.stringify(store.data))
    assert.equal(store.mergeTicket(closedSource.ticketId, target.ticketId).code, 'source_closed')
    unchanged()

    const closedTarget = open(store)
    store.transitionTicket(closedTarget.ticketId, 'cancelled', { resolution: { reason: 'duplicate' } })
    before = JSON.parse(JSON.stringify(store.data))
    assert.equal(store.mergeTicket(source.ticketId, closedTarget.ticketId).code, 'target_closed')
    unchanged()

    const merged = store.mergeTicket(source.ticketId, target.ticketId)
    assert.equal(merged.ok, true)
    before = JSON.parse(JSON.stringify(store.data))
    assert.equal(store.mergeTicket(source.ticketId, target.ticketId).code, 'merge_irreversible')
    unchanged()
  } finally {
    fixture.cleanup()
  }
}

// 2b. An ancestor/descendant pair and tickets from different roots are refused.
{
  const fixture = await createFixture()
  try {
    const store = fixture.service.store
    const parentA = forkedParent(store, ['A one', 'A two'])
    const childA = store.ticket(parentA.childTicketIds[0])
    const parentB = forkedParent(store, ['B one', 'B two'])
    const childB = store.ticket(parentB.childTicketIds[0])
    const before = JSON.parse(JSON.stringify(store.data))
    assert.equal(store.mergeTicket(parentA.ticketId, childA.ticketId).code, 'merge_cycle')
    assert.deepEqual(JSON.parse(JSON.stringify(store.data)), before)
    assert.equal(store.mergeTicket(childA.ticketId, parentA.ticketId).code, 'merge_cycle')
    assert.deepEqual(JSON.parse(JSON.stringify(store.data)), before)
    assert.equal(store.mergeTicket(childA.ticketId, childB.ticketId).code, 'merge_root_mismatch')
    assert.deepEqual(JSON.parse(JSON.stringify(store.data)), before)
  } finally {
    fixture.cleanup()
  }
}

// 3. A source container's children move to the target, which becomes forked.
{
  const fixture = await createFixture()
  try {
    const store = fixture.service.store
    const source = forkedParent(store, ['child one', 'child two'])
    const target = container(store)
    const result = store.mergeTicket(source.ticketId, target.ticketId, { reason: 'one container' })
    assert.equal(result.ok, true, result.message)
    assert.equal(result.movedChildren.length, 2)
    const kept = store.ticket(target.ticketId)
    assert.equal(kept.status, 'forked')
    assert.equal(kept.waitingOn, 'children')
    assert.deepEqual(new Set(kept.childTicketIds), new Set(result.movedChildren))
    assert.equal(kept.childTicketIds.length, 2)
    assert.deepEqual([...kept.childTicketIds], [...kept.childTicketIds].sort((a, b) => {
      const left = store.ticket(a)
      const right = store.ticket(b)
      return left.createdAt - right.createdAt || String(a).localeCompare(String(b))
    }))
    for (const id of kept.childTicketIds) {
      const child = store.ticket(id)
      assert.equal(child.parentTicketId, target.ticketId)
      assert.equal(child.rootTicketId, target.ticketId)
      assert.equal(child.forkDepth, kept.forkDepth + 1)
    }
    assert.deepEqual(store.ticket(source.ticketId).childTicketIds, [])
    assert.equal(isTerminal(store.ticket(source.ticketId).status), true)
  } finally {
    fixture.cleanup()
  }
}

// 4. A target with an executor cannot absorb a source that still has active
// children.
{
  const fixture = await createFixture()
  try {
    const store = fixture.service.store
    const source = forkedParent(store, ['one', 'two'])
    const target = open(store, { goal: 'busy target' })
    const before = JSON.parse(JSON.stringify(store.data))
    const result = store.mergeTicket(source.ticketId, target.ticketId)
    assert.equal(result.ok, false)
    assert.equal(result.code, 'target_busy')
    assert.deepEqual(JSON.parse(JSON.stringify(store.data)), before)
  } finally {
    fixture.cleanup()
  }
}

// 5. Pending deliveries follow the source to the target; request ids are kept.
{
  const fixture = await createFixture()
  try {
    const store = fixture.service.store
    const source = open(store)
    const target = open(store)
    const moved = store.addDelivery({ targetSessionId: 'session-worker', requestId: 'req_keep', ticketId: source.ticketId, content: [{ type: 'text', text: 'hi' }] })
    const other = store.addDelivery({ targetSessionId: 'session-worker', requestId: 'req_other', ticketId: target.ticketId, content: [{ type: 'text', text: 'other' }] })
    const result = store.mergeTicket(source.ticketId, target.ticketId)
    assert.equal(result.ok, true)
    assert.equal(result.movedDeliveries, 1)
    assert.equal(store.delivery(moved.deliveryId).ticketId, target.ticketId)
    assert.equal(store.delivery(moved.deliveryId).requestId, 'req_keep')
    assert.equal(store.delivery(other.deliveryId).ticketId, target.ticketId)
  } finally {
    fixture.cleanup()
  }
}

// 6. Source attempts stay on the source; the target gets one summary attempt.
{
  const fixture = await createFixture()
  try {
    const store = fixture.service.store
    const source = open(store)
    const target = open(store)
    source.attempts.push({ at: 1, executor: 'session-worker', outcome: 'failed', reason: 'first try' })
    source.attempts.push({ at: 2, executor: 'session-worker', outcome: 'blocked', reason: 'waiting' })
    target.attempts.push({ at: 3, executor: 'session-worker', outcome: 'completed', reason: 'target history' })
    const sourceAttempts = JSON.parse(JSON.stringify(source.attempts))
    const targetCount = target.attempts.length
    const result = store.mergeTicket(source.ticketId, target.ticketId)
    assert.equal(result.ok, true)
    assert.deepEqual(store.ticket(source.ticketId).attempts, sourceAttempts)
    const kept = store.ticket(target.ticketId)
    assert.equal(kept.attempts.length, targetCount + 1)
    assert.equal(kept.attempts.at(-1).reason, 'merged from ' + source.ticketId)
    assert.equal(kept.attempts.at(-1).executor, 'session-worker')
    assert.equal(kept.attempts.at(-1).outcome, 'completed')
  } finally {
    fixture.cleanup()
  }
}

// 7. Two parents merge; once every moved child is done the surviving parent
// converges to done and the merged parent no longer participates.
{
  const fixture = await createFixture()
  try {
    const store = fixture.service.store
    const keep = forkedParent(store, ['keep one', 'keep two'])
    const fold = forkedParent(store, ['fold one', 'fold two'])
    const result = store.mergeTicket(fold.ticketId, keep.ticketId)
    assert.equal(result.ok, true, result.message)
    const parent = store.ticket(keep.ticketId)
    assert.equal(parent.status, 'forked')
    assert.equal(parent.childTicketIds.length, 4)
    assert.equal(store.ticket(fold.ticketId).resolution.kind, 'merged')
    const ids = [...parent.childTicketIds]
    ids.forEach((id, index) => {
      finish(store, id, 'child ' + index)
      const current = store.ticket(keep.ticketId)
      if (index < ids.length - 1) assert.equal(current.status, 'forked')
      else assert.equal(current.status, 'done')
    })
    assert.equal(store.ticket(keep.ticketId).status, 'done')
    assert.equal(store.ticket(fold.ticketId).status, 'done')
    assert.equal(store.activeTickets().length, 0)
  } finally {
    fixture.cleanup()
  }
}

// 8. A merged source cannot be reopened; a normal target can.
{
  const fixture = await createFixture()
  try {
    const store = fixture.service.store
    const source = open(store)
    const target = open(store)
    assert.equal(store.mergeTicket(source.ticketId, target.ticketId).ok, true)
    const reopenSource = store.transitionTicket(source.ticketId, 'open')
    assert.equal(reopenSource.ok, false)
    assert.equal(reopenSource.code, 'merge_irreversible')
    finish(store, target.ticketId, 'closed')
    const reopenTarget = store.transitionTicket(target.ticketId, 'open', { reason: 'more work' })
    assert.equal(reopenTarget.ok, true)
    assert.equal(reopenTarget.ticket.status, 'open')
  } finally {
    fixture.cleanup()
  }
}

console.log('merge ok')
