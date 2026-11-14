import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createFixture } from './support/ria-fixture.mjs'
import { REFLECTION_LOCK_TTL_MS, readReflectionState } from '../lib/reflection.mjs'

const fixture = await createFixture({ prefix: 'ria-reflection-run-' })
const { service, stateDir } = fixture
const call = fixture.call
const lockFile = join(stateDir, 'reflections', '.lock')
const reportFile = date => join(stateDir, 'reflections', date + '.md')

function report({ runId, date, window, worker, status = 'complete', attempt = 1 }) {
  return [
    '---',
    'schema: 2',
    'date: ' + date,
    'timezone: Asia/Shanghai',
    'cadence: daily',
    'windowStart: ' + window.from,
    'windowEnd: ' + window.to,
    'trigger: manual',
    'runId: ' + runId,
    'attempt: ' + attempt,
    'workerSessionId: ' + worker,
    'status: ' + status,
    'sessionsReviewed: 1',
    'sessionsSkipped: 0',
    'ticketsReviewed: 0',
    'compressedBytesRead: 10',
    'decompressedBytesRead: 20',
    'durationMs: 1000',
    'degraded: []',
    '---',
    '## 一句话',
    '今天没有异常。',
    '## 做对了什么',
    '- 无',
    '## 错漏清单',
    '- 无',
    '## 教训',
    '- 无',
    '## memory 候选',
    '- 无',
    '## 明日关注',
    '- 无',
    '## 覆盖与成本',
    '- 1 个会话',
    '## 未覆盖',
    '- 无',
    '',
  ].join('\n')
}

async function begin(forDate, extra = {}) {
  return call('ria_reflect', { action: 'begin', forDate, ...extra })
}

async function spawn(runId, forDate) {
  const result = await call('ria_spawn', {
    cwd: stateDir,
    agentPreset: 'minimal',
    reflectionRunId: runId,
    title: 'Ria 反省 ' + forDate,
  })
  assert.equal(result.ok, true, JSON.stringify(result))
  return result.sessionId
}

try {
  const emptyStatus = await call('ria_reflect', { action: 'status' })
  assert.equal(emptyStatus.ok, true, JSON.stringify(emptyStatus))
  assert.equal(emptyStatus.run, null)
  assert.equal(emptyStatus.state.lastCompletedDate, null)
  assert.equal(emptyStatus.settings.implemented, false)

  const dateA = '2026-11-13'
  const started = await begin(dateA)
  assert.equal(started.ok, true, JSON.stringify(started))
  assert.equal(started.locked, false)
  assert.equal(started.attempt, 1)
  assert.equal(started.spawn.agentPreset, 'minimal')
  assert.match(started.instruction, new RegExp(started.runId))
  assert.ok(existsSync(lockFile), 'begin must create the lock')
  assert.equal(readReflectionState(stateDir).activeRunId, started.runId)

  const activeStatus = await call('ria_reflect', { action: 'status' })
  assert.equal(activeStatus.ok, true, JSON.stringify(activeStatus))
  assert.equal(activeStatus.run.runId, started.runId)
  assert.equal(activeStatus.run.status, 'starting')

  const worker = await spawn(started.runId, dateA)
  assert.deepEqual(fixture.visibleTools(worker).sort(), [
    'ria_reflect_read_context',
    'ria_reflect_read_session',
    'ria_reflect_read_sessions',
    'ria_reflect_read_tickets',
    'ria_reflect_report',
    'ria_reflect_status',
  ])
  const dispatched = await call('ria_reflect', { action: 'dispatch', runId: started.runId, sessionId: worker })
  assert.equal(dispatched.ok, true, JSON.stringify(dispatched))
  assert.equal(fixture.prompts.at(-1).mode, 'queue')
  assert.match(fixture.prompts.at(-1).content[0].text, new RegExp('workerSessionId: ' + worker))

  const locked = await begin(dateA)
  assert.equal(locked.locked, true)
  assert.equal(locked.runId, started.runId)

  writeFileSync(join(stateDir, 'reflections', 'runs', started.runId, 'report.partial.md'), report({
    runId: started.runId,
    date: dateA,
    window: started.window,
    worker,
  }))
  const finished = await call('ria_reflect', { action: 'finish', runId: started.runId, status: 'complete' })
  assert.equal(finished.ok, true, JSON.stringify(finished))
  assert.equal(readFileSync(finished.reportPath, 'utf8').includes('今天没有异常'), true)
  assert.equal(readReflectionState(stateDir).lastCompletedDate, dateA)
  assert.equal(existsSync(lockFile), false, 'finish must release the lock')
  assert.equal(existsSync(join(stateDir, 'reflections', 'runs', started.runId, 'report.partial.md')), true, 'the draft stays for audit')

  const skipped = await begin(dateA)
  assert.equal(skipped.locked, false)
  assert.equal(skipped.skipped, 'completed')

  const forced = await begin(dateA, { force: true })
  assert.equal(forced.ok, true)
  assert.notEqual(forced.runId, started.runId)
  assert.match(forced.reportPath, new RegExp(dateA + '[.]manual-[0-9]{4}[.]md$'))
  await call('ria_reflect', { action: 'abort', runId: forced.runId, reason: 'test cleanup' })

  const dateB = '2026-11-14'
  const bad = await begin(dateB)
  const badWorker = await spawn(bad.runId, dateB)
  await call('ria_reflect', { action: 'dispatch', runId: bad.runId, sessionId: badWorker })
  writeFileSync(join(stateDir, 'reflections', 'runs', bad.runId, 'report.partial.md'), '---\nschema: 2\n---\n## 一句话\n坏了\n')
  const rejected = await call('ria_reflect', { action: 'finish', runId: bad.runId, status: 'complete' })
  assert.equal(rejected.ok, false)
  assert.equal(rejected.code, 'report_invalid')
  assert.equal(existsSync(reportFile(dateB)), false)
  assert.equal(existsSync(lockFile), false)
  assert.equal(readReflectionState(stateDir).lastCompletedDate, dateA)

  const dateC = '2026-11-15'
  const aborting = await begin(dateC)
  const abortWorker = await spawn(aborting.runId, dateC)
  await call('ria_reflect', { action: 'dispatch', runId: aborting.runId, sessionId: abortWorker })
  const aborted = await call('ria_reflect', { action: 'abort', runId: aborting.runId, reason: 'user cancelled', cancelled: true })
  assert.equal(aborted.ok, true)
  assert.equal(aborted.status, 'cancelled')
  assert.equal(existsSync(reportFile(dateC)), false)
  assert.equal(existsSync(lockFile), false)

  const dateD = '2026-11-16'
  fixture.service.onSessionEvent({ header: { id: fixture.riaAgent.id } }, { type: 'turn/start', data: { turn: 20 } })
  const captured = fixture.service.store.captureIntake({
    sessionId: fixture.riaAgent.id,
    turn: 20,
    message: {
      id: 'msg-reflection-intake',
      role: 'user',
      content: [{ type: 'text', text: '开始今天的反思吧' }],
      source: { kind: 'user', rpcId: 'rpc-reflection-intake' },
    },
  })
  assert.equal(captured.ticket.status, 'intake')
  const failing = await begin(dateD)
  assert.equal(failing.intake.ticketId, captured.ticket.ticketId)
  assert.equal(fixture.service.store.ticket(captured.ticket.ticketId).status, 'done')
  const failWorker = await spawn(failing.runId, dateD)
  fixture.setPromptFailure(new Error('boom'))
  const dispatchFailed = await call('ria_reflect', { action: 'dispatch', runId: failing.runId, sessionId: failWorker })
  assert.equal(dispatchFailed.ok, false)
  assert.equal(dispatchFailed.code, 'dispatch_failed')
  assert.equal(dispatchFailed.attempts.at(-1).outcome, 'failed')
  assert.match(dispatchFailed.attempts.at(-1).error, /boom/)
  assert.equal(existsSync(lockFile), false)
  assert.equal(readReflectionState(stateDir).lastCompletedDate, dateA)

  const dateE = '2026-11-17'
  const retry = await begin(dateE)
  assert.equal(retry.ok, true)
  assert.equal(retry.attempt, 1)
  const retryWorker = await spawn(retry.runId, dateE)
  const retryFailed = await call('ria_reflect', { action: 'dispatch', runId: retry.runId, sessionId: retryWorker })
  assert.equal(retryFailed.ok, false)
  assert.equal(retryFailed.code, 'dispatch_failed')
  const second = await begin(dateE)
  assert.equal(second.ok, true)
  assert.equal(second.locked, false)
  assert.equal(second.attempt, 2)
  assert.notEqual(second.runId, retry.runId)
  const secondWorker = await spawn(second.runId, dateE)
  const secondFailed = await call('ria_reflect', { action: 'dispatch', runId: second.runId, sessionId: secondWorker })
  assert.equal(secondFailed.ok, false)
  assert.equal(secondFailed.attempts.length, 2)
  const capped = await begin(dateE)
  assert.equal(capped.locked, false)
  assert.equal(capped.skipped, 'failed')
  fixture.setPromptFailure(undefined)

  const dateF = '2026-11-18'
  const stale = await begin(dateF)
  assert.equal(stale.ok, true)
  const staleLock = JSON.parse(readFileSync(lockFile, 'utf8'))
  staleLock.startedAt = Date.now() - REFLECTION_LOCK_TTL_MS - 1000
  writeFileSync(lockFile, JSON.stringify(staleLock))
  const takeover = await begin(dateF)
  assert.equal(takeover.ok, true)
  assert.equal(takeover.locked, false)
  assert.notEqual(takeover.runId, stale.runId)
  const abandoned = JSON.parse(readFileSync(join(stateDir, 'reflections', 'runs', stale.runId, 'run.json'), 'utf8'))
  assert.equal(abandoned.status, 'abandoned')
  await call('ria_reflect', { action: 'abort', runId: takeover.runId, reason: 'test cleanup' })

  const dateG = '2026-11-19'
  const warned = await begin(dateG)
  assert.equal(warned.ok, true)
  const warnedWorker = await spawn(warned.runId, dateG)
  await call('ria_reflect', { action: 'dispatch', runId: warned.runId, sessionId: warnedWorker })
  const warnedBody = report({
    runId: warned.runId,
    date: dateG,
    window: warned.window,
    worker: warnedWorker,
  })
    .replace('## 教训\n- 无\n', '## 教训\n- 无\n## 对 dsh-ria 的迭代建议\n- 问题：测试证据 ticket_mwtest。建议改法：lib/reflection.mjs:1205。影响面：无。优先级：P2。\n')
    .replace('## memory 候选\n- 无\n', '## memory 候选\n- **bad** [target: team:ops]：非法 target 降级。\n')
  writeFileSync(join(stateDir, 'reflections', 'runs', warned.runId, 'report.partial.md'), warnedBody)
  const warnedFinish = await call('ria_reflect', { action: 'finish', runId: warned.runId, status: 'complete' })
  assert.equal(warnedFinish.ok, true, JSON.stringify(warnedFinish))
  assert.equal(warnedFinish.warnings.length, 1)
  assert.match(warnedFinish.warnings[0], /memory candidate bad: invalid target "team:ops"/)
  const warnedRun = JSON.parse(readFileSync(join(stateDir, 'reflections', 'runs', warned.runId, 'run.json'), 'utf8'))
  assert.deepEqual(warnedRun.warnings, warnedFinish.warnings)

  assert.equal(service.reflections.size >= 7, true)
  console.log('reflection-run ok')
} finally {
  fixture.cleanup()
}
