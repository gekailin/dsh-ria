import assert from 'node:assert/strict'
import { createFixture } from './support/ria-fixture.mjs'
import { AUTO_TAG_TURN_THRESHOLD, activeAutoTags } from '../lib/store/tags.mjs'
import { isExecutorEligible, scoreExecutor } from '../lib/core/executor-pool.mjs'

// Completion-only learning: done adds ticket/topic tags as {tag: lastTurn} and
// moves lastUsedAt; cancelled/failed/blocked/human-abort must not touch either.

const fixture = await createFixture({ stateDefault: true })
const controller = fixture.service.controller
const store = fixture.service.store
const state = controller.state
let seq = 0

const workingTicket = (executor, tags = []) => {
  const ticket = store.addTicket({ status: 'working', executor, goal: 'completion tags ' + (++seq), waitingOn: 'executor' })
  controller.state.setTicketMeta(ticket.ticketId, { phase: 'working', executorId: executor, routingTags: tags })
  controller.state.setWorkOrder(ticket.ticketId, { ticketId: ticket.ticketId, summary: 'do it', steps: ['do it'], routing: { tags } })
  return ticket
}

const addReport = (ticketId, status, extra = {}) => {
  const report = {
    reportId: 'completion_report_' + (++seq), ticketId, executorId: extra.executorId || 'completion-exec',
    status, summary: extra.summary || (status === 'done' ? 'finished' : 'progress'),
    evidence: extra.evidence || (status === 'done' ? ['exit 0'] : []), question: extra.question || '', at: Date.now(),
  }
  controller.state.addReport(report)
  return report
}

const settle = (executor, ticketId, reason, turn = 1) => controller.settleTicketFromExecutorEvent(executor, {
  type: 'turn/end', data: { ticketId, turn, reason },
})

const snapshot = executorId => {
  const executor = state.executor(executorId)
  return {
    autoTags: { ...(executor.autoTags || {}) },
    lastUsedAt: executor.lastUsedAt,
    ledger: [...(executor.autoTaggedTicketIds || [])],
    tags: [...(executor.tags || [])],
  }
}

try {
  await fixture.service.ensure()

  // 1. done accumulates ticket tags + topic tags as {tag: currentTurn}; explicit
  // tags never enter the map, and pre-existing entries are preserved.
  {
    const executor = 'completion-exec'
    state.addExecutor(executor, { status: 'idle', tags: ['explicit'], autoTags: { old: 0 }, lastUsedAt: 1000 })
    const topic = store.addTopic({ title: '完成标签主题', tags: ['topic-tag', 'docs'] })
    const ticket = workingTicket(executor, ['code', 'explicit', 'Code', 'dsh-ria', '  Docs  '])
    store.linkTicket(topic.topicId, ticket.ticketId)
    addReport(ticket.ticketId, 'done', { executorId: executor })
    const result = await settle(executor, ticket.ticketId, { kind: 'completed' }, 7)
    assert.equal(result.status, 'done', JSON.stringify(result))
    const done = state.executor(executor)
    assert.deepEqual(done.tags, ['explicit'], 'explicit tags unchanged')
    assert.deepEqual(done.autoTags, { old: 0, code: 7, 'dsh-ria': 7, docs: 7, 'topic-tag': 7 }, 'normalized/deduped/ticket+topic tags at current turn')
    assert.equal(Object.hasOwn(done.autoTags, 'explicit'), false, 'explicit tag never copied')
    assert.equal(done.lastTurn, 7, 'completion stores the current turn')
    assert.ok(done.lastUsedAt > 1000, 'lastUsedAt moves on done')
    assert.ok(done.autoTaggedTicketIds.includes(ticket.ticketId), 'ledger records the ticket')
  }

  // 2. idempotent: replaying the same completion does not add again or move time.
  {
    const executor = 'completion-idem'
    state.addExecutor(executor, { status: 'idle', tags: [], autoTags: { keep: 0 }, lastUsedAt: 2000 })
    const ticket = workingTicket(executor, ['x', 'x', 'y'])
    addReport(ticket.ticketId, 'done', { executorId: executor })
    await settle(executor, ticket.ticketId, { kind: 'completed' }, 3)
    const before = snapshot(executor)
    const replay = controller.applyTicketCompletionToExecutor(executor, ticket.ticketId, 3000, 4)
    assert.equal(replay.applied, false)
    assert.deepEqual(snapshot(executor), before, 'same ticket cannot add twice')
  }

  // 3. legacy arrays normalize to {tag:0}; 100 entries cap evicts the oldest
  // lastTurn deterministically (tie: lexicographically smaller tag).
  {
    const executor = 'completion-cap'
    state.addExecutor(executor, { status: 'idle', tags: [], autoTags: ['legacy-a', 'legacy-b'] })
    assert.deepEqual(state.executor(executor).autoTags, { 'legacy-a': 0, 'legacy-b': 0 }, 'legacy array gets lastTurn 0')
  }
  {
    const executor = 'completion-cap-full'
    const existing = Object.fromEntries(Array.from({ length: 100 }, (_, index) => ['old-' + index, index]))
    state.addExecutor(executor, { status: 'idle', tags: [], autoTags: existing })
    const ticket = workingTicket(executor, ['new'])
    addReport(ticket.ticketId, 'done', { executorId: executor })
    await settle(executor, ticket.ticketId, { kind: 'completed' }, 100)
    const tags = state.executor(executor).autoTags
    assert.equal(Object.keys(tags).length, 100, 'physical cap is 100')
    assert.equal(tags.new, 100, 'new tag stores current turn')
    assert.equal(Object.hasOwn(tags, 'old-0'), false, 'oldest lastTurn is evicted')
    assert.equal(tags['old-1'], 1, 'next oldest retained')
  }

  // 4. cancelled / failed / blocked / human abort do not touch either field.
  {
    const executor = 'completion-noop'
    state.addExecutor(executor, { status: 'idle', tags: [], autoTags: { keep: 0 }, lastUsedAt: 4000 })
    const stable = snapshot(executor)

    const blockedTicket = workingTicket(executor, ['blocked-tag'])
    addReport(blockedTicket.ticketId, 'blocked', { executorId: executor, summary: 'need user', question: 'which?' })
    await settle(executor, blockedTicket.ticketId, { kind: 'completed' }, 5)
    assert.equal(store.ticket(blockedTicket.ticketId).status, 'blocked')
    assert.deepEqual(snapshot(executor), stable, 'blocked must not tag')

    const failedTicket = workingTicket(executor, ['failed-tag'])
    await settle(executor, failedTicket.ticketId, { kind: 'error', error: { code: '413', message: 'Request Entity Too Large' } }, 6)
    assert.equal(store.ticket(failedTicket.ticketId).status, 'failed')
    assert.deepEqual(snapshot(executor), stable, 'failed must not tag')

    const abortedTicket = workingTicket(executor, ['abort-tag'])
    await settle(executor, abortedTicket.ticketId, { kind: 'aborted', reason: { kind: 'user' } }, 7)
    assert.equal(store.ticket(abortedTicket.ticketId).status, 'blocked')
    assert.deepEqual(snapshot(executor), stable, 'human abort must not tag')

    const cancelled = workingTicket(executor, ['cancelled-tag'])
    const stopped = await fixture.callAs(controller.state.chatSessionId, 'ria_chat_stop_ticket', {
      ticketId: cancelled.ticketId, reason: 'completion-tags test',
    })
    assert.equal(stopped.ok, true, JSON.stringify(stopped))
    assert.equal(store.ticket(cancelled.ticketId).status, 'cancelled')
    assert.deepEqual(snapshot(executor), stable, 'cancelled must not tag')
  }

  // 5. syncCoManagedExecutors must preserve the dict and completion fields.
  {
    const executor = 'completion-co'
    state.addExecutor(executor, {
      kind: 'co-managed', status: 'idle', tags: ['explicit'], autoTags: { learned: 9 },
      autoTaggedTicketIds: ['ticket_done_1'], lastUsedAt: 5555, recentTopics: ['topic_1'], lastTurn: 9,
    })
    state.data.coManagement = [{
      watchId: 'watch_completion', sessionId: executor, titleSnapshot: 'Completion Co', cwd: '/work',
      tags: ['from-cm'], roleNote: '', allowDispatch: true, addedAt: 1, status: 'active',
    }]
    state.syncCoManagedExecutors()
    const synced = state.executor(executor)
    assert.deepEqual(synced.tags, ['from-cm'], 'explicit tags come from coManagement')
    assert.deepEqual(synced.autoTags, { learned: 9 }, 'autoTags dict preserved')
    assert.equal(synced.lastTurn, 9, 'lastTurn preserved')
    assert.deepEqual(synced.autoTaggedTicketIds, ['ticket_done_1'], 'ledger preserved')
    assert.equal(synced.lastUsedAt, 5555, 'lastUsedAt preserved')
    assert.deepEqual(synced.recentTopics, ['topic_1'], 'recentTopics preserved')
  }

  // 6. Turn threshold: only currentTurn - lastTurn <= 30 participates; the
  // stored entries are not deleted. Boundary 30 passes, 31 fails.
  {
    const tags = { fresh: 70, stale: 69, edge: 71 }
    assert.equal(AUTO_TAG_TURN_THRESHOLD, 30)
    assert.deepEqual(activeAutoTags(tags, 100, 30), ['fresh', 'edge'])
    assert.deepEqual(activeAutoTags(tags, 100, 31), ['stale', 'fresh', 'edge'])
    assert.deepEqual(activeAutoTags(tags, 100, 29), ['edge'])
    assert.deepEqual(tags, { fresh: 70, stale: 69, edge: 71 }, 'threshold never mutates storage')

    const executor = { status: 'idle', sessionId: 'threshold', tags: [], autoTags: tags, lastTurn: 100 }
    const scored = scoreExecutor(executor, { ticketTags: ['fresh', 'stale', 'edge'], currentTurn: 100, autoTagTurnThreshold: 30 })
    assert.deepEqual(scored.matchedAutoTags, ['fresh', 'edge'], 'stale tag ignored by scoring')
    // Tags never hard-filter eligibility; staleness only affects scoring.
    assert.equal(isExecutorEligible(executor, { ticketTags: ['stale'], currentTurn: 100, autoTagTurnThreshold: 30 }), true)
    assert.equal(isExecutorEligible(executor, { ticketTags: ['stale'], currentTurn: 100, autoTagTurnThreshold: 31 }), true)
  }

  // 7. Service option overrides the default threshold.
  {
    const configured = await createFixture({ stateDefault: true, autoTagTurnThreshold: 31 })
    try {
      assert.equal(configured.service.controller.autoTagTurnThreshold, 31)
    } finally {
      configured.cleanup()
    }
  }

  console.log('state completion tags ok')
} finally {
  fixture.cleanup()
}
