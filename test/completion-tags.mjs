import assert from 'node:assert/strict'
import { createFixture } from './support/ria-fixture.mjs'

// Completion-only learning: done adds ticket/topic tags and lastUsedAt;
// cancelled/failed/blocked/human-abort must not touch either.

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

const settle = (executor, ticketId, reason) => controller.settleTicketFromExecutorEvent(executor, {
  type: 'turn/end', data: { ticketId, turn: 1, reason },
})

const snapshot = executorId => {
  const executor = state.executor(executorId)
  return {
    autoTags: [...(executor.autoTags || [])],
    lastUsedAt: executor.lastUsedAt,
    ledger: [...(executor.autoTaggedTicketIds || [])],
    tags: [...(executor.tags || [])],
    dedicated: executor.dedicated,
  }
}

try {
  await fixture.service.ensure()

  // 1. done accumulates ticket tags + topic tags, normalizes, dedupes, caps 12.
  {
    const executor = 'completion-exec'
    state.addExecutor(executor, { status: 'idle', tags: ['explicit'], autoTags: ['old'], lastUsedAt: 1000, dedicated: true })
    const topic = store.addTopic({ title: '完成标签主题', tags: ['topic-tag', 'docs'] })
    const ticket = workingTicket(executor, ['code', 'explicit', 'Code', 'dsh-ria', '  Docs  '])
    store.linkTicket(topic.topicId, ticket.ticketId)
    addReport(ticket.ticketId, 'done', { executorId: executor })
    const result = await settle(executor, ticket.ticketId, { kind: 'completed' })
    assert.equal(result.status, 'done', JSON.stringify(result))
    const done = state.executor(executor)
    assert.deepEqual(done.tags, ['explicit'], 'explicit tags unchanged')
    assert.equal(done.dedicated, true, 'dedicated unchanged')
    assert.deepEqual(done.autoTags, ['code', 'dsh-ria', 'docs', 'topic-tag', 'old'], 'normalized/deduped/ticket+topic tags')
    assert.ok(done.autoTags.every(tag => tag === tag.toLowerCase()), 'normalized lowercase')
    assert.equal(done.autoTags.includes('explicit'), false, 'explicit tag never copied')
    assert.ok(done.lastUsedAt > 1000, 'lastUsedAt moves on done')
    assert.ok(done.autoTaggedTicketIds.includes(ticket.ticketId), 'ledger records the ticket')
  }

  // 2. idempotent: replaying the same completion does not add again or move time.
  {
    const executor = 'completion-idem'
    state.addExecutor(executor, { status: 'idle', tags: [], autoTags: ['keep'], lastUsedAt: 2000 })
    const ticket = workingTicket(executor, ['x', 'x', 'y'])
    addReport(ticket.ticketId, 'done', { executorId: executor })
    await settle(executor, ticket.ticketId, { kind: 'completed' })
    const before = snapshot(executor)
    const replay = controller.applyTicketCompletionToExecutor(executor, ticket.ticketId, 3000)
    assert.equal(replay.applied, false)
    assert.deepEqual(snapshot(executor), before, 'same ticket cannot add twice')
  }

  // 3. cap at 12 (including >12 new tags).
  {
    const executor = 'completion-cap'
    state.addExecutor(executor, { status: 'idle', tags: [], autoTags: [] })
    const tags = Array.from({ length: 16 }, (_, i) => 'tag-' + i)
    const ticket = workingTicket(executor, tags)
    addReport(ticket.ticketId, 'done', { executorId: executor })
    await settle(executor, ticket.ticketId, { kind: 'completed' })
    assert.equal(state.executor(executor).autoTags.length, 12, 'autoTag cap is 12')
  }

  // 4. cancelled / failed / blocked / human abort do not touch either field.
  {
    const executor = 'completion-noop'
    state.addExecutor(executor, { status: 'idle', tags: [], autoTags: ['keep'], lastUsedAt: 4000 })
    const stable = snapshot(executor)

    const blockedTicket = workingTicket(executor, ['blocked-tag'])
    addReport(blockedTicket.ticketId, 'blocked', { executorId: executor, summary: 'need user', question: 'which?' })
    await settle(executor, blockedTicket.ticketId, { kind: 'completed' })
    assert.equal(store.ticket(blockedTicket.ticketId).status, 'blocked')
    assert.deepEqual(snapshot(executor), stable, 'blocked must not tag')

    const failedTicket = workingTicket(executor, ['failed-tag'])
    await settle(executor, failedTicket.ticketId, { kind: 'error', error: { code: '413', message: 'Request Entity Too Large' } })
    assert.equal(store.ticket(failedTicket.ticketId).status, 'failed')
    assert.deepEqual(snapshot(executor), stable, 'failed must not tag')

    const abortedTicket = workingTicket(executor, ['abort-tag'])
    await settle(executor, abortedTicket.ticketId, { kind: 'aborted', reason: { kind: 'user' } })
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

  // 5. syncCoManagedExecutors must preserve completion fields, not empty them.
  {
    const executor = 'completion-co'
    state.addExecutor(executor, {
      kind: 'co-managed', status: 'idle', tags: ['explicit'], autoTags: ['learned'],
      autoTaggedTicketIds: ['ticket_done_1'], lastUsedAt: 5555, recentTopics: ['topic_1'], dedicated: false,
    })
    state.data.coManagement = [{
      watchId: 'watch_completion', sessionId: executor, titleSnapshot: 'Completion Co', cwd: '/work',
      tags: ['from-cm'], roleNote: '', allowDispatch: true, dedicated: false, addedAt: 1, status: 'active',
    }]
    state.syncCoManagedExecutors()
    const synced = state.executor(executor)
    assert.deepEqual(synced.tags, ['from-cm'], 'explicit tags come from coManagement')
    assert.deepEqual(synced.autoTags, ['learned'], 'autoTags preserved')
    assert.deepEqual(synced.autoTaggedTicketIds, ['ticket_done_1'], 'ledger preserved')
    assert.equal(synced.lastUsedAt, 5555, 'lastUsedAt preserved')
    assert.deepEqual(synced.recentTopics, ['topic_1'], 'recentTopics preserved')
  }

  console.log('state completion tags ok')
} finally {
  fixture.cleanup()
}