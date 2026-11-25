import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFixture } from './support/ria-fixture.mjs'
import { CoManagement } from '../lib/roles/co-management.mjs'
import { StateStore } from '../lib/store/store.mjs'

const settle = () => new Promise(resolve => setTimeout(resolve, 30))
const clone = value => JSON.parse(JSON.stringify(value))
const dirs = []
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), 'ria-co-archive-'))
  dirs.push(dir)
  return dir
}

function retiredEvents(fixture) {
  return fixture.service.routerEvents.query({ types: ['co.auto_retired'], limit: 100 }).events
}
function watchOf(fixture, sessionId) {
  return fixture.service.controller.coManagement.watch(sessionId)
}
async function addWatch(fixture, sessionId) {
  const chat = fixture.service.controller.state.chatSessionId
  const added = await fixture.callAs(chat, 'ria_chat_co_manage', { action: 'add', sessionId })
  assert.equal(added.ok, true, JSON.stringify(added))
}

try {
  // 1. Module core: retire flips status only, keeps stats/tags, is idempotent,
  // and an explicit re-add is the only way back to active.
  {
    const dir = tempDir()
    let current = 5000
    const state = new StateStore(dir)
    const manager = new CoManagement({
      stateDir: dir,
      state,
      now: () => current,
      send: async () => {},
      notify: () => {},
    })
    manager.add({ sessionId: 'session-module', title: 'Module', cwd: '/work', tags: ['keep'] })
    const item = manager.data.watches[0]
    item.stats = { relayed: 3, suppressed: 1, lastRelayAt: 123, autoTags: { code: 2 }, autoTaggedTicketIds: ['ticket-a'] }
    manager.save()
    const statsBefore = clone(manager.watch('session-module').stats)

    const first = manager.retire('session-module', 'archived')
    assert.equal(first.ok, true)
    assert.equal(first.already, false)
    const retired = manager.watch('session-module')
    assert.equal(retired.status, 'inactive')
    assert.equal(retired.retiredReason, 'archived')
    assert.equal(retired.retiredAt, 5000)
    assert.deepEqual(retired.stats, statsBefore, 'retire keeps autoTags and stats')
    assert.deepEqual(retired.tags, ['keep'], 'retire keeps user fields')
    assert.ok(retired.watchId && retired.sessionId === 'session-module', 'retire keeps the entry itself')

    current = 6000
    const second = manager.retire('session-module', 'archived')
    assert.equal(second.already, true, 'second retire is a no-op')
    assert.equal(manager.watch('session-module').retiredAt, 5000, 'inactive entry is not re-stamped')
    assert.deepEqual(manager.watch('session-module').stats, statsBefore)

    const readded = manager.add({ sessionId: 'session-module', title: 'Module' })
    assert.equal(readded.ok, true)
    assert.equal(readded.reactivated, true)
    const active = manager.watch('session-module')
    assert.equal(active.status, 'active')
    assert.equal(active.retiredReason, undefined, 're-add clears retire reason')
    assert.equal(active.retiredAt, undefined, 're-add clears retire time')
    assert.deepEqual(active.stats, statsBefore, 're-add keeps stats')
    manager.close()
  }

  // 2. Archive event: exactly one co.auto_retired; inactive entry keeps its
  // entry, autoTags and stats; live and dormant (temporarily unavailable)
  // sessions stay active.
  {
    const fixture = await createFixture({
      stateDefault: true,
      extraSessions: [
        { sessionId: 'session-archive', running: false, blank: false, updatedAt: 10, cwd: '/work', projections: { values: { title: 'Archive Me' } } },
        { sessionId: 'session-live', running: false, blank: false, updatedAt: 9, cwd: '/work', projections: { values: { title: 'Live' } } },
        { sessionId: 'session-dormant', agentAvailable: false, running: false, blank: false, updatedAt: 8, cwd: '/work', projections: { values: { title: 'Dormant' } } },
      ],
    })
    try {
      const controller = fixture.service.controller
      await addWatch(fixture, 'session-archive')
      await addWatch(fixture, 'session-live')
      await addWatch(fixture, 'session-dormant')
      controller.state.patchCoManagedStats('session-archive', {
        autoTags: { archived: 4 }, autoTaggedTicketIds: ['ticket-archived'], lastTurn: 9, lastUsedAt: 12345,
      })
      const before = clone(controller.state.coManagedItem('session-archive'))
      assert.ok(before && before.stats && Array.isArray(before.stats.autoTaggedTicketIds), 'stats seeded')

      await fixture.ctx.workspaceRegistry.archiveSession('session-archive')
      await fixture.emit('workspace/session-archived', { sessionId: 'session-archive' })
      await settle()

      const retired = watchOf(fixture, 'session-archive')
      assert.ok(retired, 'entry is preserved, not deleted')
      assert.equal(retired.status, 'inactive')
      assert.equal(retired.retiredReason, 'archived')
      assert.ok(Number.isFinite(retired.retiredAt))
      assert.deepEqual(retired.stats, before.stats, 'event retire keeps autoTags/stats')
      assert.deepEqual(retired.tags, before.tags, 'event retire keeps tags')
      assert.deepEqual(controller.state.executor('session-archive').autoTags, { archived: 4 }, 'derived executor keeps autoTags')

      const events = retiredEvents(fixture)
      assert.equal(events.length, 1, 'exactly one co.auto_retired')
      assert.equal(events[0].sessionId, 'session-archive')
      assert.equal(events[0].reason, 'archived')
      assert.deepEqual(events[0].payload, { sessionId: 'session-archive', reason: 'archived' })

      assert.equal(watchOf(fixture, 'session-live').status, 'active', 'live session is untouched')
      assert.equal(watchOf(fixture, 'session-dormant').status, 'active', 'dormant but present session is not retired')
      assert.equal(retiredEvents(fixture).filter(event => event.sessionId !== 'session-archive').length, 0)

      // Idempotent across the event and a later reconcile.
      const retiredAt = retired.retiredAt
      await fixture.emit('workspace/session-archived', { sessionId: 'session-archive' })
      await settle()
      const reconciled = await controller.reconcileWatches()
      assert.equal(reconciled.ok, true, JSON.stringify(reconciled))
      assert.equal(retiredEvents(fixture).length, 1, 'event + reconcile never duplicate the event')
      assert.equal(watchOf(fixture, 'session-archive').retiredAt, retiredAt, 'inactive entry is not re-written')
    } finally {
      fixture.cleanup()
    }
  }

  // 3. Startup reconcile: archived and missing ids retire, live ids do not.
  {
    const fixture = await createFixture({
      stateDefault: true,
      extraSessions: [
        { sessionId: 'session-live', running: false, blank: false, updatedAt: 10, cwd: '/work', projections: { values: { title: 'Live' } } },
        { sessionId: 'session-archived', running: false, blank: false, updatedAt: 9, cwd: '/work', projections: { values: { title: 'Archived' } } },
      ],
    })
    try {
      const controller = fixture.service.controller
      await addWatch(fixture, 'session-live')
      await addWatch(fixture, 'session-archived')
      await fixture.ctx.workspaceRegistry.archiveSession('session-archived')
      // A registration whose session disappeared between runs.
      const missing = controller.coManagement.add({ sessionId: 'session-gone', title: 'Gone', cwd: '/work' })
      assert.equal(missing.ok, true)
      controller.state.syncCoManagedExecutors()
      controller.state.save()

      // The real startup entry point must run the reconcile.
      await fixture.service.startup()
      await settle()

      assert.equal(watchOf(fixture, 'session-live').status, 'active', 'active session stays active')
      assert.equal(watchOf(fixture, 'session-archived').status, 'inactive')
      assert.equal(watchOf(fixture, 'session-archived').retiredReason, 'archived')
      assert.equal(watchOf(fixture, 'session-gone').status, 'inactive')
      assert.equal(watchOf(fixture, 'session-gone').retiredReason, 'missing')
      const events = retiredEvents(fixture)
      assert.equal(events.length, 2, 'one event per retired entry')
      assert.equal(events.filter(event => event.sessionId === 'session-live').length, 0)
      assert.deepEqual(events.map(event => event.reason).sort(), ['archived', 'missing'])

      // Repeated startup/reconcile is idempotent.
      const again = await controller.reconcileWatches()
      assert.equal(again.ok, true)
      assert.equal(again.retired.length, 0)
      assert.equal(retiredEvents(fixture).length, 2)
    } finally {
      fixture.cleanup()
    }
  }

  // 4. Unreachable/read-failure: the whole pass is abandoned, nothing changes.
  {
    const fixture = await createFixture({
      stateDefault: true,
      extraSessions: [
        { sessionId: 'session-live', running: false, blank: false, updatedAt: 10, cwd: '/work', projections: { values: { title: 'Live' } } },
      ],
    })
    try {
      const controller = fixture.service.controller
      await addWatch(fixture, 'session-live')
      const missing = controller.coManagement.add({ sessionId: 'session-gone', title: 'Gone', cwd: '/work' })
      assert.equal(missing.ok, true)
      controller.state.syncCoManagedExecutors()
      controller.state.save()
      const liveBefore = clone(watchOf(fixture, 'session-live'))
      const goneBefore = clone(watchOf(fixture, 'session-gone'))
      assert.equal(retiredEvents(fixture).length, 0)

      const originalList = fixture.ctx.sessionController.list
      fixture.ctx.sessionController.list = async () => { throw new Error('daemon unavailable') }
      let failed = await controller.reconcileWatches()
      assert.equal(failed.ok, false)
      assert.equal(failed.code, 'sessions_unavailable')
      assert.deepEqual(watchOf(fixture, 'session-live'), liveBefore, 'list failure changes nothing')
      assert.deepEqual(watchOf(fixture, 'session-gone'), goneBefore)
      assert.equal(retiredEvents(fixture).length, 0, 'list failure records no event')
      fixture.ctx.sessionController.list = originalList

      const descriptor = Object.getOwnPropertyDescriptor(fixture.ctx.workspaceRegistry, 'archivedSessionIds')
      Object.defineProperty(fixture.ctx.workspaceRegistry, 'archivedSessionIds', {
        configurable: true,
        get() { throw new Error('archive rpc timeout') },
      })
      failed = await controller.reconcileWatches()
      assert.equal(failed.ok, false)
      assert.equal(failed.code, 'sessions_unavailable')
      assert.deepEqual(watchOf(fixture, 'session-live'), liveBefore, 'archive read failure changes nothing')
      assert.deepEqual(watchOf(fixture, 'session-gone'), goneBefore)
      assert.equal(retiredEvents(fixture).length, 0, 'archive read failure records no event')
      Object.defineProperty(fixture.ctx.workspaceRegistry, 'archivedSessionIds', descriptor)

      // An empty list during startup is treated as an unready store, not as
      // "every watched session was deleted".
      fixture.ctx.sessionController.list = async () => ({ items: [] })
      failed = await controller.reconcileWatches()
      assert.equal(failed.ok, false)
      assert.equal(failed.code, 'sessions_empty')
      assert.deepEqual(watchOf(fixture, 'session-live'), liveBefore, 'empty list changes nothing')
      assert.deepEqual(watchOf(fixture, 'session-gone'), goneBefore)
      assert.equal(retiredEvents(fixture).length, 0, 'empty list records no event')
      fixture.ctx.sessionController.list = originalList
    } finally {
      fixture.cleanup()
    }
  }

  console.log('co-management archive lifecycle ok')
} finally {
  for (const dir of dirs.splice(0).reverse()) {
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* already gone */ }
  }
}
