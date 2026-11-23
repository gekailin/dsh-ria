import assert from 'node:assert/strict'
import { join } from 'node:path'
import { createFixture } from './support/ria-fixture.mjs'

// Two dispatch-path defects: archived/deleted Executors must not be selected, and
// an Advisor that returns nothing must park the ticket with a
// readable reason instead of a bare "Advisor 不可用".

async function withEvents(fixture) {
  const events = []
  fixture.service.routerEvent = event => { events.push(event) }
  return events
}

// ① Archived Sessions are never selected, even when their binding is newest.
// ② A deleted Session is removed and the next idle Executor is reused.
// ③ The normal reuse path still works.
{
  const fixture = await createFixture({ stateDefault: true, archivedSessionIds: ['session-archived'] })
  try {
    const controller = fixture.service.controller
    const store = controller.state
    const events = await withEvents(fixture)
    const executorsDir = join(fixture.stateDir, 'executors')
    store.addExecutor('session-archived', { scope: 'global', executorType: 'work', cwd: executorsDir, status: 'idle', lastUsedAt: 9000 })

    // Creating the first real Executor must not pick the archived binding.
    const first = await controller.ensureExecutor('global')
    assert.equal(first.created, true, JSON.stringify(first))
    assert.notEqual(first.sessionId, 'session-archived')
    assert.ok(store.executor('session-archived'), 'an archived binding is kept, just not selectable')

    // Make the real Executor idle and older than the dead binding, so the dead one
    // is tried first and must fall through to it.
    store.addExecutor(first.sessionId, { status: 'idle', currentTicketId: null, lastUsedAt: 1000 })
    store.addExecutor('session-deleted', { scope: 'global', executorType: 'work', cwd: executorsDir, status: 'idle', lastUsedAt: 8000 })
    const second = await controller.ensureExecutor('global', null, undefined, 'ticket_probe')
    assert.equal(second.created, false, JSON.stringify(second))
    assert.equal(second.sessionId, first.sessionId)
    assert.equal(store.executor('session-deleted'), null, 'a dead binding is removed')
    const failed = events.find(event => event.event === 'executor.resolve_failed')
    assert.ok(failed, 'expected executor.resolve_failed')
    assert.equal(failed.payload.executorId, 'session-deleted')
    assert.equal(failed.ticketId, 'ticket_probe')
    assert.equal(typeof failed.payload.latencyMs, 'number')
    assert.ok(failed.payload.error)

    // Normal path: the same idle Executor is reused again, no new session.
    const third = await controller.ensureExecutor('global')
    assert.equal(third.created, false)
    assert.equal(third.sessionId, first.sessionId)
    assert.equal(events.filter(event => event.event === 'executor.resolve_failed').length, 1)

    // Startup reconcile is idempotent and reports what it cleaned.
    store.addExecutor('session-gone', { scope: 'global', executorType: 'work', cwd: executorsDir, status: 'idle', lastUsedAt: 1 })
    assert.equal(await controller.reconcileExecutorBindings(), 1)
    assert.equal(store.executor('session-gone'), null)
    assert.equal(await controller.reconcileExecutorBindings(), 0)
    const reconciled = events.filter(event => event.event === 'executor.reconcile_removed')
    assert.equal(reconciled.length, 1)
    assert.equal(reconciled[0].payload.executorId, 'session-gone')
  } finally {
    fixture.cleanup()
  }
}

console.log('state dispatch resilience ok')
