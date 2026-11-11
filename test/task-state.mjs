import assert from 'node:assert/strict'
import { createFixture } from './support/ria-fixture.mjs'
import { migrateV1State, TICKET_TRANSITIONS } from '../lib/tickets.mjs'

function openTicket(store, overrides = {}) {
  return store.addTicket({
    goal: 'finish the report',
    acceptance: 'tests pass',
    executor: 'session-worker',
    ...overrides,
  })
}

// Legal path: open -> working -> done, revision increments at each step, and a
// terminal ticket gets closedAt and a resolution summary.
{
  const fixture = await createFixture()
  try {
    const store = fixture.service.store
    const ticket = openTicket(store)
    assert.equal(ticket.status, 'open')
    assert.equal(ticket.waitingOn, 'ria')
    assert.equal(ticket.revision, 1)

    const working = store.transitionTicket(ticket.ticketId, 'working', {
      attempt: { lastRequestId: 'req_1', startedAt: 1, legacy: false },
      reason: 'dispatch accepted',
    })
    assert.equal(working.ok, true)
    assert.equal(working.ticket.status, 'working')
    assert.equal(working.ticket.waitingOn, 'worker')
    assert.equal(working.ticket.attempt.lastRequestId, 'req_1')
    assert.equal(working.ticket.revision, 2)

    const done = store.transitionTicket(ticket.ticketId, 'done', {
      resolution: { summary: 'report shipped' },
      reason: 'worker completed',
    })
    assert.equal(done.ok, true)
    assert.equal(done.ticket.status, 'done')
    assert.equal(done.ticket.waitingOn, 'none')
    assert.equal(done.ticket.resolution.summary, 'report shipped')
    assert.equal(typeof done.ticket.closedAt, 'number')
    assert.equal(done.ticket.revision, 3)
    assert.equal(done.ticket.history.at(-1).to, 'done')

    const reopened = store.transitionTicket(ticket.ticketId, 'open', { reason: 'user asked again' })
    assert.equal(reopened.ok, true)
    assert.equal(reopened.ticket.status, 'open')
    assert.equal(reopened.ticket.closedAt, null)
    assert.equal(reopened.ticket.resolution, null)
    assert.equal(reopened.ticket.reopenCount, 1)
    assert.equal(reopened.ticket.revision, 4)
  } finally {
    fixture.cleanup()
  }
}

// Illegal edges return an error and leave the ticket untouched.
{
  const fixture = await createFixture()
  try {
    const store = fixture.service.store
    const ticket = openTicket(store)
    const before = JSON.parse(JSON.stringify(ticket))
    for (const target of ['done', 'failed']) {
      const result = store.transitionTicket(ticket.ticketId, target)
      assert.equal(result.ok, false)
      assert.equal(result.code, 'invalid_transition')
    }
    assert.deepEqual(store.ticket(ticket.ticketId), before)
    assert.equal(TICKET_TRANSITIONS.done.includes('working'), false)
  } finally {
    fixture.cleanup()
  }
}

// expectedRevision guards concurrent writers.
{
  const fixture = await createFixture()
  try {
    const store = fixture.service.store
    const ticket = openTicket(store)
    const revision = ticket.revision
    const moved = store.transitionTicket(ticket.ticketId, 'working', {
      expectedRevision: revision,
      attempt: { lastRequestId: 'req_2', legacy: false },
    })
    assert.equal(moved.ok, true)
    const stale = store.transitionTicket(ticket.ticketId, 'done', {
      expectedRevision: revision,
      resolution: { summary: 'too late' },
    })
    assert.equal(stale.ok, false)
    assert.equal(stale.code, 'stale_revision')
    assert.equal(store.ticket(ticket.ticketId).status, 'working')
  } finally {
    fixture.cleanup()
  }
}

// Invariants: blocked needs a reason, working needs an attempt, done needs a
// resolution summary, and only valid states exist.
{
  const fixture = await createFixture()
  try {
    const store = fixture.service.store
    const ticket = openTicket(store)
    const noReason = store.transitionTicket(ticket.ticketId, 'blocked')
    assert.equal(noReason.ok, false)
    assert.equal(noReason.code, 'blocked_reason_required')
    const blocked = store.transitionTicket(ticket.ticketId, 'blocked', { blockedReason: 'waiting for budget', waitingOn: 'user' })
    assert.equal(blocked.ok, true)
    assert.equal(blocked.ticket.waitingOn, 'user')

    const second = openTicket(store, { goal: 'second' })
    const noAttempt = store.transitionTicket(second.ticketId, 'working', { attempt: { legacy: false, lastRequestId: null } })
    assert.equal(noAttempt.ok, false)
    assert.equal(noAttempt.code, 'attempt_required')
    const working = store.transitionTicket(second.ticketId, 'working', { attempt: { lastRequestId: 'req_3', legacy: false } })
    assert.equal(working.ok, true)
    const noResolution = store.transitionTicket(second.ticketId, 'done')
    assert.equal(noResolution.ok, false)
    assert.equal(noResolution.code, 'resolution_required')
    const invalid = store.transitionTicket(second.ticketId, 'nonsense')
    assert.equal(invalid.ok, false)
    assert.equal(invalid.code, 'invalid_status')
  } finally {
    fixture.cleanup()
  }
}

// Fork containers need 2-8 children and children inherit depth/root.
{
  const fixture = await createFixture()
  try {
    const store = fixture.service.store
    const parent = openTicket(store, { goal: 'parent', status: 'intake' })
    const childA = openTicket(store, { goal: 'child a', parentTicketId: parent.ticketId })
    const childB = openTicket(store, { goal: 'child b', parentTicketId: parent.ticketId })
    assert.equal(childA.forkDepth, 1)
    assert.equal(childA.rootTicketId, parent.ticketId)
    assert.deepEqual(store.ticket(parent.ticketId).childTicketIds.sort(), [childA.ticketId, childB.ticketId].sort())

    const forked = store.transitionTicket(parent.ticketId, 'forked', { childTicketIds: [childA.ticketId, childB.ticketId] })
    assert.equal(forked.ok, true)
    assert.equal(forked.ticket.waitingOn, 'children')

    const single = openTicket(store, { goal: 'single parent', status: 'intake' })
    const only = openTicket(store, { goal: 'only child', parentTicketId: single.ticketId })
    const badFork = store.transitionTicket(single.ticketId, 'forked', { childTicketIds: [only.ticketId] })
    assert.equal(badFork.ok, false)
    assert.equal(badFork.code, 'children_required')
    assert.equal(store.ticket(single.ticketId).status, 'intake')

    const grandchild = openTicket(store, { goal: 'grandchild', parentTicketId: childA.ticketId })
    assert.equal(grandchild.forkDepth, 2)
    assert.equal(grandchild.rootTicketId, parent.ticketId)
  } finally {
    fixture.cleanup()
  }
}

// v1 migration converts tasks and dispatch notes, keeps closed fields, and
// defaults the new settings key.
{
  const at = Date.UTC(2026, 10, 11, 12, 0, 0)
  const result = migrateV1State({
    version: 1,
    riaSessionId: 'session-ria',
    tasks: [{
      taskId: 'task_old',
      goal: 'old goal',
      acceptance: 'green',
      executor: 'session-worker',
      status: 'working',
      createdAt: 1,
      updatedAt: 2,
      recoveryCount: 2,
      blockedReason: '',
    }, {
      taskId: 'task_done',
      goal: 'done goal',
      executor: 'session-worker',
      status: 'done',
      createdAt: 3,
      updatedAt: 4,
      blockedReason: '',
    }],
    deliveries: [],
    grants: [],
    recentWorkers: {},
    dispatchNotes: [{ sessionId: 'session-ria', turn: 3, note: 'sent to worker', isTask: true, taskId: 'task_old', at: 5 }],
    settings: { dispatchGuard: false },
  }, at)
  assert.equal(result.migrated, true)
  assert.equal(result.data.schemaVersion, 2)
  assert.equal(result.data.tickets.length, 2)
  assert.equal(result.data.tickets[0].ticketId, 'task_old')
  assert.equal(result.data.tickets[0].status, 'working')
  assert.equal(result.data.tickets[0].recovery.count, 2)
  assert.equal(result.data.tickets[1].closedAt, 4)
  assert.equal(result.data.ticketFeedback.length, 1)
  assert.equal(result.data.ticketFeedback[0].kind, 'dispatched')
  assert.equal(result.data.ticketFeedback[0].body, 'sent to worker')
  assert.deepEqual(result.data.settings, { dispatchGuard: false, progressCards: false })
}

// A legacy in-flight record with no matching ticket becomes an open ticket,
// keeps its recovery count, and leaves no top-level inFlight field behind.
{
  const at = Date.UTC(2026, 10, 11, 12, 0, 0)
  const result = migrateV1State({
    version: 1,
    riaSessionId: 'session-ria',
    tasks: [],
    inFlight: {
      turnId: 12,
      startedAt: Date.UTC(2026, 10, 11, 8, 30, 0),
      lastUserMessage: '调查无人车底商 GPU 方案',
      lastPhase: 'bash',
      recoveryCount: 1,
    },
  }, at)
  assert.equal(result.data.tickets.length, 1)
  const ticket = result.data.tickets[0]
  assert.equal(ticket.status, 'open')
  assert.equal(ticket.executor, 'self')
  assert.equal(ticket.waitingOn, 'ria')
  assert.equal(ticket.origin.kind, 'legacy_inflight')
  assert.equal(ticket.origin.text, '调查无人车底商 GPU 方案')
  assert.equal(ticket.recovery.count, 1)
  assert.equal(ticket.progress.lastPhase, 'bash')
  assert.equal('inFlight' in result.data, false)
}

// An exhausted legacy record becomes blocked with a reason instead of open.
{
  const result = migrateV1State({
    version: 1,
    tasks: [],
    inFlight: {
      turnId: 3,
      startedAt: 1,
      lastUserMessage: '已经到上限的消息',
      recoveryCount: 3,
    },
  }, 2)
  const ticket = result.data.tickets[0]
  assert.equal(ticket.status, 'blocked')
  assert.match(ticket.blockedReason, /自动恢复已达上限/)
  assert.equal(ticket.failure.code, 'recovery_exhausted')
}

// When the captured text matches an active ticket, migration merges the
// recovery count and phase into that ticket instead of creating a duplicate.
{
  const at = Date.UTC(2026, 10, 11, 12, 0, 0)
  const result = migrateV1State({
    version: 1,
    tasks: [{
      taskId: 'task_same',
      goal: '合并恢复记录',
      executor: 'session-worker',
      status: 'working',
      createdAt: 1,
      updatedAt: 1,
      recoveryCount: 1,
    }],
    inFlight: {
      turnId: 9,
      startedAt: 1,
      lastUserMessage: '合并恢复记录',
      lastPhase: 'ria_read',
      recoveryCount: 2,
    },
  }, at)
  assert.equal(result.data.tickets.length, 1)
  const ticket = result.data.tickets[0]
  assert.equal(ticket.ticketId, 'task_same')
  assert.equal(ticket.recovery.count, 2)
  assert.equal(ticket.progress.lastPhase, 'ria_read')
  assert.equal(ticket.revision, 2)
  assert.equal('inFlight' in result.data, false)
}

console.log('task-state ok')
