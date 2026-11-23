import assert from 'node:assert/strict'
import { createFixture } from './support/ria-fixture.mjs'

// Event-driven settlement: report records evidence, executor events settle.
// Managed/co-managed share this path; kind is not consulted here.

const fixture = await createFixture({ stateDefault: true })
const controller = fixture.service.controller
const store = fixture.service.store
const executor = 'settle-probe-executor'
let reportSeq = 0

const workingTicket = goal => {
  const ticket = store.addTicket({ status: 'working', executor, goal, waitingOn: 'executor', attempt: { startedAt: Date.now() - 1000 } })
  controller.state.setTicketMeta(ticket.ticketId, { phase: 'working', executorId: executor })
  controller.state.addExecutor(executor, { status: 'working', currentTicketId: ticket.ticketId, lastUsedAt: Date.now() })
  return ticket
}

const recordReport = (ticketId, status, extra = {}) => {
  const report = {
    reportId: 'settle_report_' + (++reportSeq),
    ticketId,
    executorId: executor,
    status,
    summary: extra.summary || (status === 'done' ? 'finished' : 'progress'),
    evidence: extra.evidence || (status === 'done' ? ['exit 0'] : []),
    question: extra.question || '',
    at: Date.now(),
  }
  controller.state.addReport(report)
  return report
}

const settle = (ticketId, data) => controller.settleTicketFromExecutorEvent(executor, {
  type: 'turn/end',
  data: { ticketId, turn: 1, reason: data },
})

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

  // 9. restart reconciliation: working -> blocked(environment, interrupted).
  {
    const ticket = workingTicket('restart')
    await controller.reconcileInterruptedWorkingTickets()
    const blocked = store.ticket(ticket.ticketId)
    assert.equal(blocked.status, 'blocked')
    assert.equal(blocked.waitingOn, 'environment')
    assert.match(blocked.blockedReason, /^interrupted:/)
    assert.equal(controller.state.ticketMeta(ticket.ticketId).reason, 'interrupted')
    assert.equal(controller.state.executor(executor).currentTicketId, null)
  }

  console.log('state ticket settlement ok')
} finally {
  fixture.cleanup()
}
