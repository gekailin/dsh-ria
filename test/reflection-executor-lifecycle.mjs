import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { StateStore } from '../lib/store/store.mjs'
import { createFixture } from './support/ria-fixture.mjs'

const legacyId = 'session-legacy-reflection-2'
const fixture = await createFixture({
  stateDefault: true,
  extraSessions: [
    { sessionId: legacyId, running: false, blank: false, updatedAt: 5, cwd: '/tmp/legacy-reflection' },
  ],
})
try {
  const controller = fixture.service.controller
  const chat = controller.state.chatSessionId
  const sc = fixture.service.ctx.sessionController
  const titleOf = async sessionId => {
    const projection = await sc.projections({ sessionId })
    return projection && projection.values ? projection.values.title : null
  }

  // The old design kept one resident reflection Executor (seq 2). It must be
  // archived exactly once, on the first per-run reflection.
  controller.state.addExecutor(legacyId, { executorType: 'reflection', status: 'idle', seq: 2, cwd: '/tmp/legacy-reflection' })
  controller.state.setMeta({ reflectionSeq: 2 })

  const first = await controller.ensureReflectionExecutor('global')
  assert.equal(first.created, true)
  assert.equal(first.meta.seq, 3)
  assert.equal(first.meta.executorLabel, 'Ria Reflection Executor 3')
  assert.equal(await titleOf(first.sessionId), 'Ria Reflection Executor 3')
  assert.ok(fixture.archivedSessions.includes(legacyId), JSON.stringify(fixture.archivedSessions))
  assert.equal(controller.state.executor(legacyId), null)
  assert.ok(controller.state.data.meta.legacyReflectionExecutorRetiredAt > 0)
  const retiredEvent = fixture.service.routerEvents.query({ limit: 500 }).events
    .find(event => event.event === 'reflection.executor.legacy.retired')
  assert.ok(retiredEvent, 'legacy retirement should be observable')

  // Two consecutive reflection runs get two different Executors; the counter is
  // durable, not process-local.
  const second = await controller.ensureReflectionExecutor('global')
  assert.notEqual(second.sessionId, first.sessionId)
  assert.equal(second.meta.seq, 4)
  assert.equal(second.meta.executorLabel, 'Ria Reflection Executor 4')
  await fixture.service.runtime.flush()
  assert.equal(JSON.parse(readFileSync(join(fixture.stateDir, 'state.json'), 'utf8')).meta.reflectionSeq, 4)
  assert.equal(new StateStore(fixture.stateDir).data.meta.reflectionSeq, 4)

  // A second visit must not archive the legacy Executor again.
  const archivesBefore = fixture.archivedSessions.length
  const again = await controller.retireLegacyReflectionExecutor('run-again')
  assert.equal(again.retired, false)
  assert.equal(fixture.archivedSessions.length, archivesBefore)

  // Creation failure falls back to an idle reflection Executor and records it.
  const fallbackExecutor = await controller.ensureReflectionExecutor('global')
  const originalCreate = sc.create.bind(sc)
  let failNext = true
  sc.create = async request => {
    if (failNext) { failNext = false; throw new Error('host refused session create') }
    return await originalCreate(request)
  }
  let reused
  try {
    reused = await controller.ensureReflectionExecutor('global', null, 'run-fallback')
  } finally {
    sc.create = originalCreate
  }
  assert.equal(reused.created, false)
  assert.equal(reused.fallback, true)
  assert.ok([first, second, fallbackExecutor].some(item => item.sessionId === reused.sessionId),
    'fallback must reuse an existing idle reflection executor: ' + reused.sessionId)
  const fallbackEvent = fixture.service.routerEvents.query({ limit: 500 }).events
    .find(event => event.event === 'reflection.executor.reuse_fallback')
  assert.ok(fallbackEvent, 'fallback must be observable')
  assert.equal(fallbackEvent.payload.runId, 'run-fallback')
  assert.equal(fallbackEvent.payload.executorId, reused.sessionId)
  assert.match(fallbackEvent.payload.error, /host refused session create/)

  // A reflection ticket owns its Executor: done/failed/cancelled archives it,
  // and repeated terminal notifications stay idempotent.
  const request = await controller.requestTicket({ goal: 'reflect lifecycle', acceptance: 'report' }, { agent: { id: chat } }, { mode: 'reflection' })
  assert.equal(request.ok, true, JSON.stringify(request))
  controller.state.setTicketMeta(request.ticketId, { reflectionForDate: '2026-11-23' })
  const advisor = controller.advisor('global').sessionId
  const plan = await fixture.callAs(advisor, 'ria_ticket_plan', { ticketId: request.ticketId, summary: 'reflect', steps: ['read'] })
  assert.equal(plan.ok, true, JSON.stringify(plan))
  const dispatched = await fixture.callAs(advisor, 'ria_ticket_dispatch', { ticketId: request.ticketId })
  assert.equal(dispatched.ok, true, JSON.stringify(dispatched))
  const runExecutor = dispatched.executorSessionId
  assert.equal(controller.state.executor(runExecutor).executorLabel, controller.state.executor(runExecutor).executorLabel)
  const report = await fixture.callAs(runExecutor, 'ria_executor_report', {
    ticketId: request.ticketId, status: 'done', summary: ['# 反思报告', '', 'lifecycle ok'].join('\n'), evidence: ['test'],
  })
  assert.equal(report.ok, true, JSON.stringify(report))
  await controller.flushReflectionArchives()
  assert.ok(fixture.archivedSessions.includes(runExecutor), JSON.stringify(fixture.archivedSessions))
  assert.equal(controller.state.executor(runExecutor), null)
  assert.ok(fixture.service.routerEvents.query({ limit: 500 }).events
    .some(event => event.event === 'reflection.executor.archived' && event.sessionId === runExecutor))

  const archivedCount = fixture.archivedSessions.length
  const ticket = fixture.service.tickets.ticket(request.ticketId)
  controller.onTicketTransition(ticket, { from: 'working', to: 'done', reason: 'duplicate terminal' })
  await controller.flushReflectionArchives()
  const duplicate = await controller.archiveReflectionExecutor(runExecutor, { runId: request.ticketId })
  assert.equal(duplicate.archived, false)
  assert.equal(duplicate.reason, 'already-archived')
  assert.equal(fixture.archivedSessions.length, archivedCount)

  // A second reflection run through the public entry point gets a fresh Executor.
  const secondRun = await fixture.service.startReflectionRun({ forDate: '2026-11-24' })
  assert.equal(secondRun.ok, true, JSON.stringify(secondRun))
  const plan2 = await fixture.callAs(advisor, 'ria_ticket_plan', { ticketId: secondRun.reflectionTicketId, summary: 'reflect again', steps: ['read'] })
  assert.equal(plan2.ok, true, JSON.stringify(plan2))
  const dispatched2 = await fixture.callAs(advisor, 'ria_ticket_dispatch', { ticketId: secondRun.reflectionTicketId })
  assert.equal(dispatched2.ok, true, JSON.stringify(dispatched2))
  assert.notEqual(dispatched2.executorSessionId, runExecutor)
  assert.equal(controller.state.executor(dispatched2.executorSessionId).executorType, 'reflection')
  const report2 = await fixture.callAs(dispatched2.executorSessionId, 'ria_executor_report', {
    ticketId: secondRun.reflectionTicketId, status: 'done', summary: ['# 反思报告', '', 'second run'].join('\n'), evidence: ['test'],
  })
  assert.equal(report2.ok, true, JSON.stringify(report2))
  await controller.flushReflectionArchives()
  assert.ok(fixture.archivedSessions.includes(dispatched2.executorSessionId))

  console.log('reflection executor lifecycle ok')
} finally {
  fixture.cleanup()
}
