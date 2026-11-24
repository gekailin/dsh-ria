import assert from 'node:assert/strict'
import { createFixture } from './support/ria-fixture.mjs'

// Event-driven settlement: report records evidence, executor events settle.
// Managed/co-managed share this path; kind is not consulted here.

const fixture = await createFixture({ stateDefault: true })
const controller = fixture.service.controller
const store = fixture.service.store
const executor = 'settle-probe-executor'
let reportSeq = 0

const workingTicket = (goal, { executorId = executor, routingTags = [], lastUsedAt = Date.now() } = {}) => {
  const ticket = store.addTicket({ status: 'working', executor: executorId, goal, waitingOn: 'executor', attempt: { startedAt: Date.now() - 1000 } })
  controller.state.setTicketMeta(ticket.ticketId, { phase: 'working', executorId, ...(routingTags.length ? { routingTags } : {}) })
  controller.state.addExecutor(executorId, { status: 'working', currentTicketId: ticket.ticketId, lastUsedAt })
  return ticket
}

const recordReport = (ticketId, status, extra = {}) => {
  const report = {
    reportId: 'settle_report_' + (++reportSeq),
    ticketId,
    executorId: extra.executorId || executor,
    status,
    summary: extra.summary || (status === 'done' ? 'finished' : 'progress'),
    evidence: extra.evidence || (status === 'done' ? ['exit 0'] : []),
    question: extra.question || '',
    at: Date.now(),
  }
  controller.state.addReport(report)
  return report
}

const settleAs = (executorId, ticketId, data) => controller.settleTicketFromExecutorEvent(executorId, {
  type: 'turn/end',
  data: { ticketId, turn: 1, reason: data },
})
const settle = (ticketId, data) => settleAs(executor, ticketId, data)

try {
  await fixture.service.ensure()

  // 0. report only records; the ticket stays working until turn/end.
  {
    const ticket = workingTicket('report is not settlement')
    const result = await controller.executorReport({
      ticketId: ticket.ticketId, status: 'done', summary: 'done evidence', evidence: ['exit 0'],
    }, { agent: { id: executor } })
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.equal(result.recorded, true)
    assert.equal(result.settlementDeferred, true)
    assert.equal(store.ticket(ticket.ticketId).status, 'working', 'report alone must not transition')
    assert.ok(controller.state.reportsFor(ticket.ticketId).some(item => item.status === 'done'))
    await settle(ticket.ticketId, { kind: 'completed' })
    assert.equal(store.ticket(ticket.ticketId).status, 'done')
  }

  // 0b. report(blocked) also records only; turn/end applies it.
  {
    const ticket = workingTicket('blocked report is evidence')
    const result = await controller.executorReport({
      ticketId: ticket.ticketId, status: 'blocked', summary: 'need a decision', question: 'which?',
    }, { agent: { id: executor } })
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.equal(result.recorded, true)
    assert.equal(store.ticket(ticket.ticketId).status, 'working', 'blocked report alone must not transition')
    await settle(ticket.ticketId, { kind: 'completed' })
    assert.equal(store.ticket(ticket.ticketId).status, 'blocked')
    assert.equal(store.ticket(ticket.ticketId).waitingOn, 'user')
  }

  // 1. turn/end + done report -> done.
  {
    const ticket = workingTicket('done report')
    recordReport(ticket.ticketId, 'done')
    const result = await settle(ticket.ticketId, { kind: 'completed' })
    assert.equal(result.status, 'done')
    assert.equal(store.ticket(ticket.ticketId).status, 'done')
  }

  // 2. turn/end without report -> done + no_report.
  {
    const ticket = workingTicket('no report')
    const result = await settle(ticket.ticketId, { kind: 'completed' })
    assert.equal(result.status, 'done')
    assert.equal(result.no_report, true)
    assert.equal(store.ticket(ticket.ticketId).status, 'done')
    assert.equal(controller.state.ticketMeta(ticket.ticketId).no_report, true)
  }

  // 3. question -> blocked(waitingOn=user).
  {
    const ticket = workingTicket('question')
    const result = await controller.settleTicketFromExecutorEvent(executor, {
      type: 'user-question', data: { ticketId: ticket.ticketId, question: 'which branch?' },
    })
    assert.equal(result.status, 'blocked')
    assert.equal(store.ticket(ticket.ticketId).waitingOn, 'user')
    assert.match(store.ticket(ticket.ticketId).blockedReason, /which branch/)
  }

  // 4. approval asked -> blocked(approval); allowed -> working.
  {
    const ticket = workingTicket('approval')
    await controller.settleTicketFromExecutorEvent(executor, {
      type: 'approval/asked',
      data: { ticketId: ticket.ticketId, id: 'apr_settle_1', toolName: 'write', callId: 'call_settle_1', reason: 'need write' },
    })
    assert.equal(store.ticket(ticket.ticketId).status, 'blocked')
    assert.equal(store.ticket(ticket.ticketId).waitingOn, 'approval')
    await controller.settleTicketFromExecutorEvent(executor, {
      type: 'approval/decided', data: { ticketId: ticket.ticketId, id: 'apr_settle_1', outcome: 'allowed' },
    })
    assert.equal(store.ticket(ticket.ticketId).status, 'working')
    assert.equal(store.ticket(ticket.ticketId).waitingOn, 'executor')
  }

  // 5. error -> failed with the raw 413 text.
  {
    const ticket = workingTicket('413')
    const raw = 'Request Entity Too Large: upstream body 123456789 bytes'
    const result = await settle(ticket.ticketId, { kind: 'error', error: { code: '413', message: raw } })
    assert.equal(result.status, 'failed')
    const failed = store.ticket(ticket.ticketId)
    assert.equal(failed.status, 'failed')
    assert.match(failed.failure.message, /Request Entity Too Large/)
    assert.match(failed.failure.message, /123456789 bytes/)
  }

  // 6. human abort -> blocked(user), never failed/done.
  {
    const ticket = workingTicket('human abort')
    const result = await settle(ticket.ticketId, { kind: 'aborted', reason: { kind: 'user' } })
    assert.equal(result.status, 'blocked')
    assert.equal(store.ticket(ticket.ticketId).status, 'blocked')
    assert.equal(store.ticket(ticket.ticketId).waitingOn, 'user')
    assert.equal(store.ticket(ticket.ticketId).failure, null)
  }

  // 6b. explicit ria_chat_stop_ticket event is a human abort, not failed/done.
  {
    const ticket = workingTicket('explicit human stop')
    const result = await controller.settleTicketFromExecutorEvent(executor, { type: 'ria_chat_stop_ticket', data: { ticketId: ticket.ticketId } })
    assert.equal(result.status, 'blocked')
    assert.equal(store.ticket(ticket.ticketId).waitingOn, 'user')
  }

  // 7. multi-turn: progress report defers, final done settles once.
  {
    const ticket = workingTicket('multi turn')
    recordReport(ticket.ticketId, 'progress')
    await settle(ticket.ticketId, { kind: 'completed' })
    assert.equal(store.ticket(ticket.ticketId).status, 'working')
    recordReport(ticket.ticketId, 'done')
    await settle(ticket.ticketId, { kind: 'completed' })
    assert.equal(store.ticket(ticket.ticketId).status, 'done')
  }

  // 8. terminal is immutable and a second event does not notify again.
  {
    const ticket = workingTicket('idempotent')
    recordReport(ticket.ticketId, 'done')
    await settle(ticket.ticketId, { kind: 'completed' })
    const before = store.ticket(ticket.ticketId)
    const result = await settle(ticket.ticketId, { kind: 'error', error: { message: 'late' } })
    assert.equal(result.settled, false)
    const after = store.ticket(ticket.ticketId)
    assert.equal(after.status, 'done')
    assert.equal(after.updatedAt, before.updatedAt)
  }

  // 9. restart reconciliation: a ticket already auto-resumed once stays blocked.
  {
    const ticket = workingTicket('restart')
    controller.state.setTicketMeta(ticket.ticketId, { autoResumeCount: 1 })
    await controller.reconcileInterruptedWorkingTickets()
    const blocked = store.ticket(ticket.ticketId)
    assert.equal(blocked.status, 'blocked')
    assert.equal(blocked.waitingOn, 'environment')
    assert.match(blocked.blockedReason, /^interrupted:/)
    assert.equal(controller.state.ticketMeta(ticket.ticketId).reason, 'interrupted')
    assert.equal(controller.state.executor(executor).currentTicketId, null)
    assert.ok(controller.state && controller.service.routerEvents.query({ ticketId: ticket.ticketId }).events
      .some(event => event.event === 'ticket.auto_resume.skipped'))
  }

  // 10. trailing progress must not shadow a terminal report.
  //     done + progress -> done (and completion tags/lastUsedAt are written).
  {
    const ex = 'settle-done-tail'
    const ticket = workingTicket('done then progress', { executorId: ex, routingTags: ['dsh-ria', 'code'], lastUsedAt: 1000 })
    recordReport(ticket.ticketId, 'done', { executorId: ex, summary: 'done', evidence: ['exit 0'] })
    recordReport(ticket.ticketId, 'progress', { executorId: ex, summary: 'trailing progress' })
    assert.equal(controller.latestExecutorReport(ticket.ticketId, ex).status, 'progress', 'default latest report still includes progress')
    assert.equal(controller.latestExecutorReport(ticket.ticketId, ex, { terminalOnly: true }).status, 'done', 'terminalOnly skips trailing progress')
    const result = await settleAs(ex, ticket.ticketId, { kind: 'completed' })
    assert.equal(result.status, 'done', JSON.stringify(result))
    assert.equal(store.ticket(ticket.ticketId).status, 'done', 'ticket leaves working')
    const completed = controller.state.executor(ex)
    assert.deepEqual(completed.autoTags, { 'dsh-ria': 1, code: 1 }, 'autoTags from done ticket routingTags')
    assert.ok(completed.lastUsedAt > 1000, 'lastUsedAt moves on done')
    assert.ok(completed.autoTaggedTicketIds.includes(ticket.ticketId), 'ledger records the ticket')
  }

  // 11. only progress -> progress_report, ticket stays working, no completion write.
  {
    const ex = 'settle-progress-only'
    const ticket = workingTicket('progress only', { executorId: ex, lastUsedAt: 2000 })
    recordReport(ticket.ticketId, 'progress', { executorId: ex, summary: 'still going' })
    const result = await settleAs(ex, ticket.ticketId, { kind: 'completed' })
    assert.equal(result.settled, false)
    assert.equal(result.reason, 'progress_report')
    assert.equal(store.ticket(ticket.ticketId).status, 'working')
    const executorNow = controller.state.executor(ex)
    assert.deepEqual(executorNow.autoTags, {})
    assert.deepEqual(executorNow.autoTaggedTicketIds, [])
    assert.equal(executorNow.lastUsedAt, 2000, 'progress alone does not move lastUsedAt')
  }

  // 12. blocked + trailing progress -> blocked.
  {
    const ex = 'settle-blocked-tail'
    const ticket = workingTicket('blocked then progress', { executorId: ex })
    recordReport(ticket.ticketId, 'blocked', { executorId: ex, summary: 'need a decision', question: 'which?' })
    recordReport(ticket.ticketId, 'progress', { executorId: ex, summary: 'trailing progress' })
    const result = await settleAs(ex, ticket.ticketId, { kind: 'completed' })
    assert.equal(result.status, 'blocked', JSON.stringify(result))
    assert.equal(store.ticket(ticket.ticketId).status, 'blocked')
    assert.equal(store.ticket(ticket.ticketId).waitingOn, 'user')
  }

  // 13. failed + trailing progress -> failed.
  {
    const ex = 'settle-failed-tail'
    const ticket = workingTicket('failed then progress', { executorId: ex })
    recordReport(ticket.ticketId, 'failed', { executorId: ex, summary: 'boom' })
    recordReport(ticket.ticketId, 'progress', { executorId: ex, summary: 'trailing progress' })
    const result = await settleAs(ex, ticket.ticketId, { kind: 'completed' })
    assert.equal(result.status, 'failed', JSON.stringify(result))
    assert.equal(store.ticket(ticket.ticketId).status, 'failed')
  }

  // 14. multi-round progress never settles; one done settles exactly once even
  //     with more progress afterwards.
  {
    const ex = 'settle-multi-tail'
    const ticket = workingTicket('multi round trailing progress', { executorId: ex, routingTags: ['multi-tag'], lastUsedAt: 3000 })
    for (let round = 0; round < 3; round += 1) {
      recordReport(ticket.ticketId, 'progress', { executorId: ex, summary: 'round ' + round })
      const result = await settleAs(ex, ticket.ticketId, { kind: 'completed' })
      assert.equal(result.reason, 'progress_report')
      assert.equal(store.ticket(ticket.ticketId).status, 'working')
      assert.deepEqual(controller.state.executor(ex).autoTags, {})
    }
    recordReport(ticket.ticketId, 'done', { executorId: ex, summary: 'done', evidence: ['exit 0'] })
    recordReport(ticket.ticketId, 'progress', { executorId: ex, summary: 'tail after done' })
    const first = await settleAs(ex, ticket.ticketId, { kind: 'completed' })
    assert.equal(first.status, 'done', JSON.stringify(first))
    const completed = controller.state.executor(ex)
    const autoTags = { ...completed.autoTags }
    const ledger = completed.autoTaggedTicketIds.slice()
    const lastUsedAt = completed.lastUsedAt
    assert.deepEqual(autoTags, { 'multi-tag': 1 })
    assert.equal(ledger.filter(id => id === ticket.ticketId).length, 1, 'done applies once')
    recordReport(ticket.ticketId, 'progress', { executorId: ex, summary: 'late progress' })
    const second = await settleAs(ex, ticket.ticketId, { kind: 'completed' })
    assert.equal(second.settled, false)
    assert.equal(store.ticket(ticket.ticketId).status, 'done')
    const unchanged = controller.state.executor(ex)
    assert.deepEqual(unchanged.autoTags, autoTags)
    assert.deepEqual(unchanged.autoTaggedTicketIds, ledger)
    assert.equal(unchanged.lastUsedAt, lastUsedAt, 'late progress does not rewrite completion fields')
  }

  // 15. approval-pending branch also ignores a trailing progress report.
  {
    const ex = 'settle-approval-tail'
    const ticket = workingTicket('approval done then progress', { executorId: ex, routingTags: ['approval-tag'] })
    recordReport(ticket.ticketId, 'done', { executorId: ex, summary: 'done', evidence: ['exit 0'] })
    await controller.settleTicketFromExecutorEvent(ex, {
      type: 'approval/asked',
      data: { ticketId: ticket.ticketId, id: 'apr_settle_tail', toolName: 'write', callId: 'call_settle_tail', reason: 'need write' },
    })
    assert.equal(store.ticket(ticket.ticketId).status, 'blocked')
    assert.equal(store.ticket(ticket.ticketId).waitingOn, 'approval')
    recordReport(ticket.ticketId, 'progress', { executorId: ex, summary: 'trailing progress' })
    const result = await settleAs(ex, ticket.ticketId, { kind: 'completed' })
    assert.equal(result.status, 'done', JSON.stringify(result))
    assert.equal(store.ticket(ticket.ticketId).status, 'done')
  }

  console.log('state ticket settlement ok')
} finally {
  fixture.cleanup()
}
