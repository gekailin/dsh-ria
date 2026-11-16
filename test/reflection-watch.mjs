import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createFixture } from './support/ria-fixture.mjs'
import { REFLECTION_WATCH_TOPIC_ID } from '../lib/reflection.mjs'
import { reflectionReportMarkdown } from './support/reflection-report.mjs'

const fixture = await createFixture({ prefix: 'ria-reflection-watch-' })
const { service, stateDir } = fixture
const call = fixture.call

async function begin(forDate) {
  const result = await call('ria_reflect', { action: 'begin', forDate })
  assert.equal(result.ok, true, JSON.stringify(result))
  return result
}

async function spawn(runId, forDate) {
  const result = await call('ria_spawn', {
    cwd: stateDir,
    agentPreset: 'minimal',
    reflectionRunId: runId,
    title: '反思 ' + forDate,
  })
  assert.equal(result.ok, true, JSON.stringify(result))
  return result.sessionId
}

async function dispatch(runId, forDate) {
  const worker = await spawn(runId, forDate)
  const result = await call('ria_reflect', { action: 'dispatch', runId, sessionId: worker })
  assert.equal(result.ok, true, JSON.stringify(result))
  return worker
}

try {
  service.store.addTopic({ topicId: REFLECTION_WATCH_TOPIC_ID, title: '记忆与反思', level: 1 })

  const dateA = '2026-11-12'
  const started = await begin(dateA)
  const workerA = await dispatch(started.runId, dateA)
  const runA = service.reflections.get(started.runId)
  assert.ok(runA.watchTicketId, 'dispatch must create a watch ticket')
  const watchA = service.store.ticket(runA.watchTicketId)
  assert.equal(watchA.status, 'working')
  assert.equal(watchA.executor, workerA)
  assert.equal(watchA.waitingOn, 'worker')
  assert.equal(watchA.goal, '反思 ' + dateA + ' 运行监控')
  assert.equal(watchA.acceptance, '反思报告完成并写入最终报告')
  assert.equal(service.store.primaryTopicFor(watchA.ticketId), REFLECTION_WATCH_TOPIC_ID)
  assert.equal(watchA.origin.kind, 'reflection-watch')
  assert.equal(watchA.origin.sessionId, workerA)

  const ticketCount = service.store.tickets().length
  const repeated = await call('ria_reflect', { action: 'dispatch', runId: started.runId, sessionId: workerA })
  assert.equal(repeated.ok, false)
  assert.equal(repeated.code, 'run_not_starting')
  assert.equal(service.store.tickets().length, ticketCount, 'a repeated dispatch must not create another watch ticket')

  assert.equal(service.recoveryUnits().some(ticket => ticket.ticketId === watchA.ticketId), false, 'a restart must ignore the working watch ticket')

  writeFileSync(join(stateDir, 'reflections', 'runs', started.runId, 'report.partial.md'), reflectionReportMarkdown(runA, 'complete'))
  const finished = await call('ria_reflect', { action: 'finish', runId: started.runId, status: 'complete' })
  assert.equal(finished.ok, true, JSON.stringify(finished))
  const closedA = service.store.ticket(watchA.ticketId)
  assert.equal(closedA.status, 'done')
  assert.equal(closedA.resolution.kind, 'reflection')
  assert.equal(closedA.resolution.reportPath, finished.reportPath)
  assert.ok(closedA.resolution.bytes > 0)
  assert.equal(closedA.resolution.status, 'completed')
  assert.equal(closedA.resolution.runId, started.runId)
  assert.deepEqual(closedA.resolution.warnings, finished.warnings || [])
  assert.ok(service.reflections.get(started.runId).watchClosedAt)

  const dateB = '2026-11-13'
  const aborting = await begin(dateB)
  const workerB = await dispatch(aborting.runId, dateB)
  const watchB = service.reflections.get(aborting.runId).watchTicketId
  assert.ok(watchB)
  const aborted = await call('ria_reflect', { action: 'abort', runId: aborting.runId, reason: 'user cancelled', cancelled: true })
  assert.equal(aborted.ok, true, JSON.stringify(aborted))
  assert.equal(aborted.status, 'cancelled')
  const closedB = service.store.ticket(watchB)
  assert.equal(closedB.status, 'cancelled')
  assert.equal(closedB.resolution.kind, 'reflection_cancelled')
  assert.match(closedB.resolution.reason, /user cancelled/)
  assert.equal(closedB.resolution.runId, aborting.runId)

  const dateC = '2026-11-14'
  const failing = await begin(dateC)
  await dispatch(failing.runId, dateC)
  const watchC = service.reflections.get(failing.runId).watchTicketId
  writeFileSync(join(stateDir, 'reflections', 'runs', failing.runId, 'report.partial.md'), '---\nschema: 2\n---\n## 一句话\n坏了\n')
  const rejected = await call('ria_reflect', { action: 'finish', runId: failing.runId, status: 'complete' })
  assert.equal(rejected.ok, false)
  assert.equal(rejected.code, 'report_invalid')
  const closedC = service.store.ticket(watchC)
  assert.equal(closedC.status, 'blocked')
  assert.equal(closedC.waitingOn, 'user')
  assert.match(closedC.blockedReason, /反思运行监控：/)
  assert.equal(closedC.failure.code, 'reflection_failed')
  assert.equal(closedC.resolution.kind, 'reflection_failed')
  assert.equal(closedC.resolution.runId, failing.runId)

  const dateD = '2026-11-15'
  const dispatchFailure = await begin(dateD)
  const workerD = await spawn(dispatchFailure.runId, dateD)
  fixture.setPromptFailure(new Error('boom'))
  const failedDispatch = await call('ria_reflect', { action: 'dispatch', runId: dispatchFailure.runId, sessionId: workerD })
  assert.equal(failedDispatch.ok, false)
  const watchD = service.store.tickets().find(ticket => ticket.origin && ticket.origin.kind === 'reflection-watch' && ticket.goal === '反思 ' + dateD + ' 运行监控')
  assert.ok(watchD, 'a failed dispatch must still have created its watch ticket')
  assert.equal(watchD.status, 'blocked')
  assert.match(watchD.blockedReason, /boom/)

  console.log('reflection-watch ok')
} finally {
  fixture.cleanup()
}
