import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { RiaService } from '../lib/index.js'

function writeState(dir, tasks, deliveries = [], inFlight = undefined) {
  const state = {
    version: 1,
    riaSessionId: 'session-ria',
    riaPreset: 'ptc',
    tasks,
    deliveries,
    grants: [],
  }
  if (inFlight !== undefined) state.inFlight = inFlight
  writeFileSync(join(dir, 'ria.json'), JSON.stringify(state, null, 2))
}

function inFlightRecord(overrides = {}) {
  return {
    turnId: 12,
    startedAt: Date.UTC(2026, 10, 11, 8, 30, 0),
    lastUserMessage: '调查无人车底商 GPU 方案',
    recoveryCount: 0,
    ...overrides,
  }
}

function harness(options = {}) {
  const prompts = []
  const tools = new Map()
  const attachments = []
  const riaAgent = {
    id: 'session-ria',
    ctx: {
      tools: { register(definition) { tools.set(definition.name, definition); return () => {} } },
      systemPrompt: { section(section) { tools.set('prompt:' + section.name, section); return () => {} } },
    },
    session: { append() { return { seq: 1, time: 1 } } },
  }
  const workspace = {
    id: 'workspace-ria',
    path: options.stateDir,
    async attachSession(id) { attachments.push(id) },
  }
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    workspaceRegistry: { async create() { return workspace } },
    sessionController: {
      async resolveAgent(id) {
        if (String(id) === 'session-ria') {
          if (options.resolveError) return { error: { code: 'session/unavailable', message: 'boom' } }
          return { agent: riaAgent }
        }
        return { error: { code: 'session/not-found', message: 'not found' } }
      },
      async list() {
        return { items: [
          { sessionId: 'session-ria', running: false, blank: false, updatedAt: 1 },
          { sessionId: 'session-worker', running: true, blank: false, updatedAt: 2, cwd: options.stateDir },
        ] }
      },
      async prompt(request, signal) {
        assert.ok(signal instanceof AbortSignal)
        prompts.push(request)
        return { accepted: true }
      },
    },
  }
  return { ctx, prompts, tools, attachments }
}

const dir = mkdtempSync(join(tmpdir(), 'dsh-ria-startup-'))
try {
  writeState(dir, [{
    taskId: 'task_exhausted',
    goal: 'finish the long task',
    acceptance: 'tests pass',
    executor: 'session-worker',
    status: 'working',
    blockedReason: '',
    createdAt: 1,
    updatedAt: 1,
    recoveryCount: 3,
  }])
  const first = harness({ stateDir: dir })
  const service = new RiaService(first.ctx, dir)
  await service.startup()
  assert.equal(first.prompts.length, 1)
  const recoveryText = first.prompts[0].content[0].text
  assert.match(recoveryText, /自动恢复已达上限/)
  assert.match(recoveryText, /task_exhausted/)
  assert.match(recoveryText, /session-worker/)
  assert.match(recoveryText, /finish the long task/)
  assert.match(recoveryText, /blocked/)
  const saved = JSON.parse(readFileSync(join(dir, 'ria.json'), 'utf8'))
  assert.equal(saved.tickets[0].status, 'blocked')
  assert.match(saved.tickets[0].blockedReason, /自动恢复已达上限/)

  const statusTool = first.tools.get('ria_status')
  const snapshot = await statusTool.execute({ scope: 'tasks' }, { signal: new AbortController().signal })
  assert.equal(snapshot.tasks[0].status, 'blocked')
  assert.match(snapshot.tasks[0].blockedReason, /自动恢复已达上限/)

  const taskTool = first.tools.get('ria_task')
  assert.ok(taskTool)
  const exec = { signal: new AbortController().signal, concludeTurn() {} }
  const updated = await taskTool.execute({ taskId: 'task_exhausted', status: 'working' }, exec)
  assert.equal(updated.task.status, 'working')
  assert.equal(updated.task.recoveryCount, 0)
  assert.equal(updated.task.blockedReason, '')

  service.store.updateTask('task_exhausted', { recoveryCount: 2 })
  const requestTool = first.tools.get('ria_request')
  const dispatched = await requestTool.execute({ targetSessionIds: ['session-worker'], message: 'continue', taskId: 'task_exhausted', note: '已让 Worker 继续执行未完成任务。' }, exec)
  assert.equal(dispatched.results[0].ok, true)
  assert.equal(service.store.task('task_exhausted').recovery.count, 0)

  const retryDir = mkdtempSync(join(tmpdir(), 'dsh-ria-startup-retry-'))
  try {
    writeState(retryDir, [{
      taskId: 'task_retry',
      goal: 'retry after restart',
      acceptance: '',
      executor: 'session-worker',
      status: 'working',
      blockedReason: '',
      createdAt: 1,
      updatedAt: 1,
      recoveryCount: 3,
    }], [{
      deliveryId: 'delivery_retry',
      targetSessionId: 'session-worker',
      requestId: 'req_retry',
      taskId: 'task_retry',
      content: [{ type: 'text', text: 'continue' }],
      mode: 'queue',
      createdAt: 1,
    }])
    const third = harness({ stateDir: retryDir })
    const retried = new RiaService(third.ctx, retryDir)
    await retried.startup()
    assert.equal(third.prompts.length, 2)
    assert.equal(retried.store.task('task_retry').status, 'working')
    assert.equal(retried.store.task('task_retry').recovery.count, 1)
    assert.equal(retried.store.task('task_retry').blockedReason, '')
  } finally {
    rmSync(retryDir, { recursive: true, force: true })
  }

  const errorDir = mkdtempSync(join(tmpdir(), 'dsh-ria-startup-error-'))
  try {
    writeState(errorDir, [{
      taskId: 'task_error',
      goal: 'should be reported',
      acceptance: '',
      executor: 'session-worker',
      status: 'working',
      blockedReason: '',
      createdAt: 1,
      updatedAt: 1,
      recoveryCount: 0,
    }])
    const second = harness({ stateDir: errorDir, resolveError: true })
    const broken = new RiaService(second.ctx, errorDir)
    await broken.startup()
    assert.equal(second.prompts.length, 1)
    const failureText = second.prompts[0].content[0].text
    assert.match(failureText, /启动恢复失败/)
    assert.match(failureText, /boom/)
    assert.match(failureText, /手动处理/)
  } finally {
    rmSync(errorDir, { recursive: true, force: true })
  }
} finally {
  rmSync(dir, { recursive: true, force: true })
}
// (a) A leftover in-flight turn with no task: startup sends one recovery
// prompt that quotes the user message, and bumps the recovery counter.
const flightDir = mkdtempSync(join(tmpdir(), 'dsh-ria-startup-flight-'))
try {
  writeState(flightDir, [], [], inFlightRecord())
  const flightHarness = harness({ stateDir: flightDir })
  const flightService = new RiaService(flightHarness.ctx, flightDir)
  await flightService.startup()
  assert.equal(flightHarness.prompts.length, 1)
  const flightText = flightHarness.prompts[0].content[0].text
  assert.match(flightText, /上次我自己的 turn 没有正常结束/)
  assert.match(flightText, /开始时间/)
  assert.match(flightText, /调查无人车底商 GPU 方案/)
  assert.match(flightText, /ria_read/)
  assert.match(flightText, /不要重复已完成的部分/)
  const savedFlight = JSON.parse(readFileSync(join(flightDir, 'ria.json'), 'utf8'))
  assert.equal(savedFlight.inFlight.recoveryCount, 1)
  assert.equal(savedFlight.inFlight.turnId, 12)
} finally {
  rmSync(flightDir, { recursive: true, force: true })
}

// (b) A normal turn end clears the record; an aborted turn keeps it and
// remembers the last tool so the recovery prompt can say where it stopped.
const trackDir = mkdtempSync(join(tmpdir(), 'dsh-ria-startup-track-'))
try {
  writeState(trackDir, [])
  const trackHarness = harness({ stateDir: trackDir })
  const trackService = new RiaService(trackHarness.ctx, trackDir)
  let turn = 5
  const session = {
    header: { id: 'session-ria' },
    snapshotEvents() { return [{ type: 'turn/start', data: { turn } }] },
  }
  const userMessage = text => ({
    type: 'user/message',
    data: { source: { kind: 'user', rpcId: 'req_user_' + text.length }, content: [{ type: 'text', text }] },
  })
  trackService.onSessionEvent(session, userMessage('  调查 GPU 方案  '))
  assert.equal(trackService.store.inFlight().turnId, 5)
  assert.equal(trackService.store.inFlight().lastUserMessage, '调查 GPU 方案')
  assert.equal(trackService.store.inFlight().recoveryCount, 0)
  // Host prompts must not overwrite the record they are recovering.
  trackService.onSessionEvent(session, {
    type: 'user/message',
    data: { source: { kind: 'user', rpcId: 'host_recovery' }, content: [{ type: 'text', text: 'DSH 刚刚重启。' }] },
  })
  assert.equal(trackService.store.inFlight().lastUserMessage, '调查 GPU 方案')
  trackService.onSessionEvent(session, { type: 'tool/call', data: { name: 'ria_read' } })
  trackService.onSessionEvent(session, { type: 'turn/end', data: { turn: 5, reason: { kind: 'completed' } } })
  assert.equal(trackService.store.inFlight(), undefined)

  turn = 7
  trackService.onSessionEvent(session, userMessage('继续调查'))
  trackService.onSessionEvent(session, { type: 'tool/call', data: { name: 'bash' } })
  trackService.onSessionEvent(session, { type: 'turn/end', data: { turn: 7, reason: { kind: 'aborted', reason: { kind: 'disposed' } } } })
  assert.equal(trackService.store.inFlight().turnId, 7)
  assert.equal(trackService.store.inFlight().lastPhase, 'bash')
  trackService.onSessionEvent(session, { type: 'turn/end', data: { turn: 7, reason: { kind: 'completed' } } })
  assert.equal(trackService.store.inFlight(), undefined)

  // A stop the user asked for is deliberate: no recovery prompt later.
  turn = 9
  trackService.onSessionEvent(session, userMessage('停下来'))
  trackService.onSessionEvent(session, { type: 'tool/call', data: { name: 'bash' } })
  trackService.onSessionEvent(session, { type: 'turn/end', data: { turn: 9, reason: { kind: 'aborted', reason: { kind: 'user' } } } })
  assert.equal(trackService.store.inFlight(), undefined)
} finally {
  rmSync(trackDir, { recursive: true, force: true })
}

// (c) At the recovery limit the prompt appears once, the record is cleared,
// and the next startup stays silent.
const limitDir = mkdtempSync(join(tmpdir(), 'dsh-ria-startup-limit-'))
try {
  writeState(limitDir, [], [], inFlightRecord({ recoveryCount: 3 }))
  const limitHarness = harness({ stateDir: limitDir })
  const limitService = new RiaService(limitHarness.ctx, limitDir)
  await limitService.startup()
  assert.equal(limitHarness.prompts.length, 1)
  assert.match(limitHarness.prompts[0].content[0].text, /自动恢复已达上限/)
  assert.match(limitHarness.prompts[0].content[0].text, /调查无人车底商 GPU 方案/)
  const savedLimit = JSON.parse(readFileSync(join(limitDir, 'ria.json'), 'utf8'))
  assert.equal(savedLimit.inFlight, undefined)
  const againHarness = harness({ stateDir: limitDir })
  await new RiaService(againHarness.ctx, limitDir).startup()
  assert.equal(againHarness.prompts.length, 0)
} finally {
  rmSync(limitDir, { recursive: true, force: true })
}

// (d) Tasks and an unfinished turn share one prompt instead of two.
const mergeDir = mkdtempSync(join(tmpdir(), 'dsh-ria-startup-merge-'))
try {
  writeState(mergeDir, [{
    taskId: 'task_merge',
    goal: 'merge the recovery prompts',
    acceptance: '',
    executor: 'session-worker',
    status: 'working',
    blockedReason: '',
    createdAt: 1,
    updatedAt: 1,
    recoveryCount: 0,
  }], [], inFlightRecord({ recoveryCount: 1 }))
  const mergeHarness = harness({ stateDir: mergeDir })
  const mergeService = new RiaService(mergeHarness.ctx, mergeDir)
  await mergeService.startup()
  assert.equal(mergeHarness.prompts.length, 1)
  const mergeText = mergeHarness.prompts[0].content[0].text
  assert.match(mergeText, /调查无人车底商 GPU 方案/)
  assert.match(mergeText, /task_merge/)
  assert.match(mergeText, /merge the recovery prompts/)
  assert.match(mergeText, /上一轮自动恢复 2\/3/)
  const savedMerge = JSON.parse(readFileSync(join(mergeDir, 'ria.json'), 'utf8'))
  assert.equal(savedMerge.inFlight.recoveryCount, 2)
  assert.equal(savedMerge.tickets[0].recovery.count, 1)
} finally {
  rmSync(mergeDir, { recursive: true, force: true })
}

console.log('startup ok')