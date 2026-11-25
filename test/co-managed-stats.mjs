import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { createFixture } from './support/ria-fixture.mjs'
import { StateStore } from '../lib/store/store.mjs'
import { CoManagement } from '../lib/roles/co-management.mjs'

// Co-managed Executors are filtered out of state.json.executors. Their durable
// completion stats must live in coManagement[].stats, survive a restart, and be
// migrated back before a physical executor delete.
const fixture = await createFixture({
  stateDefault: true,
  extraSessions: [
    { sessionId: 'session-cm-stats', running: false, blank: false, updatedAt: 10, cwd: '/work', projections: { values: { title: 'CM Stats' } } },
  ],
})
try {
  const service = fixture.service
  const controller = service.controller
  const state = controller.state
  await service.ensure()
  const chat = state.chatSessionId
  const added = await fixture.callAs(chat, 'ria_chat_co_manage', { action: 'add', sessionId: 'session-cm-stats', cwd: '/work', tags: [] })
  assert.equal(added.ok, true, JSON.stringify(added))
  assert.equal(state.executor('session-cm-stats').kind, 'co-managed')

  const ticket = service.store.addTicket({ status: 'working', executor: 'session-cm-stats', goal: 'co-managed stats persist', waitingOn: 'executor' })
  state.setTicketMeta(ticket.ticketId, {
    phase: 'working', routingTags: ['dsh-ria', 'code'], executorSessionId: 'session-cm-stats',
  })
  state.addReport({
    reportId: 'report_cm_stats_1', ticketId: ticket.ticketId, executorId: 'session-cm-stats',
    status: 'done', summary: 'finished', evidence: ['exit 0'], question: '', at: Date.now(),
  })
  // A trailing progress report must not hide the terminal done report; settlement
  // reads terminalOnly, otherwise the tagging path would never run (cog_225).
  state.addReport({
    reportId: 'report_cm_stats_progress', ticketId: ticket.ticketId, executorId: 'session-cm-stats',
    status: 'progress', summary: 'still chatting after done', evidence: [], question: '', at: Date.now(),
  })
  const settled = await controller.settleTicketFromExecutorEvent('session-cm-stats', {
    type: 'turn/end',
    data: { ticketId: ticket.ticketId, turn: 5, reason: { kind: 'completed' } },
  })
  assert.equal(settled.status, 'done', JSON.stringify(settled))
  assert.equal(service.store.ticket(ticket.ticketId).status, 'done')

  const executor = state.executor('session-cm-stats')
  assert.deepEqual(executor.autoTags, { code: 5, 'dsh-ria': 5 }, 'completion tags accumulated')
  assert.ok(executor.autoTaggedTicketIds.includes(ticket.ticketId), 'ledger records the ticket')
  assert.equal(executor.lastTurn, 5)
  assert.ok(executor.lastUsedAt > 0)

  const stats = state.getCoManagedStats('session-cm-stats')
  assert.ok(stats, 'coManagement stats exist')
  assert.deepEqual(stats.autoTags, { code: 5, 'dsh-ria': 5 })
  assert.deepEqual(stats.autoTaggedTicketIds, [ticket.ticketId])
  assert.equal(stats.lastTurn, 5)
  assert.equal(stats.lastUsedAt, executor.lastUsedAt)
  // Relay counters share the stats object and must not be clobbered.
  const item = state.coManagedItem('session-cm-stats')
  assert.equal(typeof item.stats.relayed, 'number')

  // A later co-management registration save must not replace durable executor
  // stats with the stale in-memory watch snapshot.
  controller.coManagement.save()
  assert.deepEqual(state.getCoManagedStats('session-cm-stats').autoTags, { code: 5, 'dsh-ria': 5 }, 'coManagement save keeps stats')

  // controlOutput still filters the co-managed executor record, but the stats
  // carrier stays in coManagement.
  const output = state.controlOutput()
  assert.equal(Object.hasOwn(output.executors, 'session-cm-stats'), false, 'co-managed executor stays filtered')
  assert.deepEqual(output.coManagement.find(entry => entry.sessionId === 'session-cm-stats').stats.autoTags, { code: 5, 'dsh-ria': 5 })

  // state.json on disk carries the stats and not the derived executor record.
  await delay(20)
  const disk = JSON.parse(readFileSync(join(fixture.stateDir, 'state.json'), 'utf8'))
  assert.equal(Object.hasOwn(disk.executors || {}, 'session-cm-stats'), false, 'filtered from state.json.executors')
  const diskItem = (disk.coManagement || []).find(entry => entry.sessionId === 'session-cm-stats')
  assert.ok(diskItem, 'coManagement entry persisted')
  assert.deepEqual(diskItem.stats.autoTags, { code: 5, 'dsh-ria': 5 })
  assert.deepEqual(diskItem.stats.autoTaggedTicketIds, [ticket.ticketId])
  assert.equal(diskItem.stats.lastTurn, 5)

  // Simulated restart: load() runs syncCoManagedExecutors() from coManagement.
  const reloaded = new StateStore(fixture.stateDir, { sqlite: true })
  const restored = reloaded.executor('session-cm-stats')
  assert.ok(restored, 'sync rebuilds the co-managed executor')
  assert.deepEqual(restored.autoTags, { code: 5, 'dsh-ria': 5 }, 'autoTags survive restart')
  assert.deepEqual(restored.autoTaggedTicketIds, [ticket.ticketId], 'ledger survives restart')
  assert.equal(restored.lastTurn, 5, 'lastTurn survives restart')
  assert.equal(restored.lastUsedAt, executor.lastUsedAt, 'lastUsedAt survives restart')

  // The real restart path also runs CoManagement.normalizeWatch/save, which
  // must keep the executor stats in the same stats object as relay counters.
  const normalizedStore = new StateStore(fixture.stateDir, { sqlite: true })
  const normalizedCo = new CoManagement({ stateDir: fixture.stateDir, state: normalizedStore, send: async () => {}, notify: () => {} })
  try {
    const watch = normalizedCo.watch('session-cm-stats')
    assert.deepEqual(watch.stats.autoTags, { code: 5, 'dsh-ria': 5 }, 'CoManagement normalization keeps stats')
    assert.ok(Number.isFinite(watch.stats.relayed), 'relay counters still present')
    assert.deepEqual(normalizedStore.executor('session-cm-stats').autoTags, { code: 5, 'dsh-ria': 5 }, 'sync after normalization restores executor')
  } finally {
    normalizedCo.close()
  }

  // Physical delete migrates stats back to coManagement first.
  const beforeRemove = reloaded.getCoManagedStats('session-cm-stats')
  reloaded.removeExecutor('session-cm-stats')
  assert.equal(reloaded.executor('session-cm-stats'), null, 'binding removed')
  assert.deepEqual(reloaded.getCoManagedStats('session-cm-stats'), beforeRemove, 'stats survive physical delete')
  await delay(20)
  const afterRemove = JSON.parse(readFileSync(join(fixture.stateDir, 'state.json'), 'utf8'))
  assert.deepEqual(
    afterRemove.coManagement.find(entry => entry.sessionId === 'session-cm-stats').stats.autoTags,
    { code: 5, 'dsh-ria': 5 },
    'deleted executor stats persist in coManagement',
  )
  const rebuilt = new StateStore(fixture.stateDir, { sqlite: true })
  assert.deepEqual(rebuilt.executor('session-cm-stats').autoTags, { code: 5, 'dsh-ria': 5 }, 'stats survive delete + reload')
  // Both physical-delete sites migrate stats before removing the binding, and
  // StateStore.removeExecutor keeps the same guard for any future caller.
  const controllerSource = readFileSync(new URL('../lib/core/controller.mjs', import.meta.url), 'utf8')
  const poolSource = readFileSync(new URL('../lib/core/executor-pool.mjs', import.meta.url), 'utf8')
  assert.match(controllerSource, /preserveCoManagedStats\(id\)\s*\n\s*this\.state\.removeExecutor\(id\)/)
  assert.match(poolSource, /preserveCoManagedStats\(item\.sessionId\)\s*\n\s*this\.state\.removeExecutor\(item\.sessionId\)/)
  console.log('co-managed stats persistence ok')
} finally {
  fixture.cleanup()
}

// Backfill is idempotent, fills only gaps, and uses closed_at to pick the
// latest completion turn for each tag.
const backfillFixture = await createFixture({
  stateDefault: true,
  extraSessions: [
    { sessionId: 'session-cm-backfill', running: false, blank: false, updatedAt: 10, cwd: '/work', projections: { values: { title: 'CM Backfill' } } },
  ],
})
try {
  const service = backfillFixture.service
  const controller = service.controller
  const state = controller.state
  await service.ensure()
  const chat = state.chatSessionId
  await backfillFixture.callAs(chat, 'ria_chat_co_manage', { action: 'add', sessionId: 'session-cm-backfill', cwd: '/work', tags: [] })

  const firstTicket = service.store.addTicket({ status: 'done', executor: 'session-cm-backfill', goal: 'backfill one', resolution: { kind: 'done', summary: 'one' } })
  state.setTicketMeta(firstTicket.ticketId, { routingTags: ['alpha', 'beta'], executorSessionId: 'session-cm-backfill' })
  await delay(10)
  const secondTicket = service.store.addTicket({ status: 'done', executor: 'session-cm-backfill', goal: 'backfill two', resolution: { kind: 'done', summary: 'two' } })
  state.setTicketMeta(secondTicket.ticketId, { routingTags: ['beta', 'gamma'], executorSessionId: 'session-cm-backfill' })

  // A value already present must not be overwritten by backfill.
  state.patchCoManagedStats('session-cm-backfill', { autoTags: { alpha: 99 }, autoTaggedTicketIds: [], lastUsedAt: null, lastTurn: 0 })

  const first = controller.backfillCoManagedExecutorStats()
  assert.equal(first.ok, true, JSON.stringify(first))
  assert.equal(first.matchedSessions, 1)
  assert.equal(first.matchedTickets, 2)
  assert.equal(first.updatedSessions, 1)
  assert.equal(first.tagsAdded, 2, 'alpha already existed; only beta/gamma added')
  assert.equal(first.ledgerAdded, 2)

  const stats = state.getCoManagedStats('session-cm-backfill')
  assert.deepEqual(stats.autoTags, { alpha: 99, beta: 2, gamma: 2 }, 'existing tag kept; latest completion turn per tag')
  assert.deepEqual(stats.autoTaggedTicketIds, [firstTicket.ticketId, secondTicket.ticketId], 'ledger filled in closed_at order')
  assert.equal(stats.lastTurn, 2, 'synthetic turns anchor at the completion count')
  assert.equal(stats.lastUsedAt, service.store.ticket(secondTicket.ticketId).closedAt, 'lastUsedAt is the latest closed_at')

  const beforeSecond = JSON.stringify(stats)
  const second = controller.backfillCoManagedExecutorStats()
  assert.equal(second.ok, true)
  assert.equal(second.updatedSessions, 0)
  assert.equal(second.tagsAdded, 0)
  assert.equal(second.ledgerAdded, 0)
  assert.equal(JSON.stringify(state.getCoManagedStats('session-cm-backfill')), beforeSecond, 'second run is a no-op')
  assert.deepEqual(state.executor('session-cm-backfill').autoTags, { alpha: 99, beta: 2, gamma: 2 }, 'in-memory executor aligned')
  console.log('co-managed stats backfill ok')
} finally {
  backfillFixture.cleanup()
}
