import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { SuperSessionService } from '../lib/index.js'

function writeState(dir, tasks, deliveries = []) {
  writeFileSync(join(dir, 'super.json'), JSON.stringify({
    version: 1,
    superSessionId: 'session-super',
    superPreset: 'ptc',
    tasks,
    deliveries,
    grants: [],
  }, null, 2))
}

function harness(options = {}) {
  const prompts = []
  const tools = new Map()
  const attachments = []
  const superAgent = {
    id: 'session-super',
    ctx: {
      tools: { register(definition) { tools.set(definition.name, definition); return () => {} } },
      systemPrompt: { section(section) { tools.set('prompt:' + section.name, section); return () => {} } },
    },
    session: { append() { return { seq: 1, time: 1 } } },
  }
  const workspace = {
    id: 'workspace-super',
    path: options.stateDir,
    async attachSession(id) { attachments.push(id) },
  }
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    workspaceRegistry: { async create() { return workspace } },
    sessionController: {
      async resolveAgent(id) {
        if (String(id) === 'session-super') {
          if (options.resolveError) return { error: { code: 'session/unavailable', message: 'boom' } }
          return { agent: superAgent }
        }
        return { error: { code: 'session/not-found', message: 'not found' } }
      },
      async list() {
        return { items: [
          { sessionId: 'session-super', running: false, blank: false, updatedAt: 1 },
          { sessionId: 'session-worker', running: true, blank: false, updatedAt: 2 },
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

const dir = mkdtempSync(join(tmpdir(), 'dsh-super-startup-'))
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
  const service = new SuperSessionService(first.ctx, dir)
  await service.startup()
  assert.equal(first.prompts.length, 1)
  const recoveryText = first.prompts[0].content[0].text
  assert.match(recoveryText, /自动恢复已达上限/)
  assert.match(recoveryText, /task_exhausted/)
  assert.match(recoveryText, /session-worker/)
  assert.match(recoveryText, /finish the long task/)
  assert.match(recoveryText, /blocked/)
  const saved = JSON.parse(readFileSync(join(dir, 'super.json'), 'utf8'))
  assert.equal(saved.tasks[0].status, 'blocked')
  assert.match(saved.tasks[0].blockedReason, /自动恢复已达上限/)

  const statusTool = first.tools.get('super_session_status')
  const snapshot = await statusTool.execute({ scope: 'tasks' }, { signal: new AbortController().signal })
  assert.equal(snapshot.tasks[0].status, 'blocked')
  assert.match(snapshot.tasks[0].blockedReason, /自动恢复已达上限/)

  const taskTool = first.tools.get('super_session_task')
  assert.ok(taskTool)
  const exec = { signal: new AbortController().signal, concludeTurn() {} }
  const updated = await taskTool.execute({ taskId: 'task_exhausted', status: 'working' }, exec)
  assert.equal(updated.task.status, 'working')
  assert.equal(updated.task.recoveryCount, 0)
  assert.equal(updated.task.blockedReason, '')

  service.store.updateTask('task_exhausted', { recoveryCount: 2 })
  const requestTool = first.tools.get('super_session_request')
  const dispatched = await requestTool.execute({ targetSessionIds: ['session-worker'], message: 'continue', taskId: 'task_exhausted', note: '已让 Worker 继续执行未完成任务。' }, exec)
  assert.equal(dispatched.results[0].ok, true)
  assert.equal(service.store.task('task_exhausted').recoveryCount, 0)

  const retryDir = mkdtempSync(join(tmpdir(), 'dsh-super-startup-retry-'))
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
    const retried = new SuperSessionService(third.ctx, retryDir)
    await retried.startup()
    assert.equal(third.prompts.length, 2)
    assert.equal(retried.store.task('task_retry').status, 'working')
    assert.equal(retried.store.task('task_retry').recoveryCount, 1)
    assert.equal(retried.store.task('task_retry').blockedReason, '')
  } finally {
    rmSync(retryDir, { recursive: true, force: true })
  }

  const errorDir = mkdtempSync(join(tmpdir(), 'dsh-super-startup-error-'))
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
    const broken = new SuperSessionService(second.ctx, errorDir)
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
console.log('startup ok')