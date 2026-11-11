import assert from 'node:assert/strict'
import { normalizeWorkerIdleOptions, WorkerIdleWatcher } from '../lib/worker-idle.mjs'

const settle = () => new Promise(resolve => setTimeout(resolve, 10))

function setup({ tasks = [], options = {}, riaId = 'session-ria' } = {}) {
  let handler
  let clock = 1_000
  const prompts = []
  const logs = []
  const ctx = {
    on(event, listener) {
      assert.equal(event, 'agent/status')
      handler = listener
      return () => { handler = undefined }
    },
    sessionController: {
      async prompt(request, signal) {
        assert.ok(signal instanceof AbortSignal)
        prompts.push(request)
        return { accepted: true }
      },
    },
  }
  const watcher = new WorkerIdleWatcher({
    ctx,
    store: { tasks: () => tasks },
    ensureRia: async () => riaId,
    getRiaId: () => riaId,
    log: (level, message) => logs.push(level + ': ' + message),
    now: () => clock,
    options,
  })
  const dispose = watcher.subscribe()
  return {
    watcher,
    prompts,
    logs,
    emit: payload => handler && handler(payload),
    advance: ms => { clock += ms },
    dispose,
    hasHandler: () => Boolean(handler),
  }
}

const workerTask = (overrides = {}) => ({
  taskId: 'task_1',
  goal: 'finish the report',
  acceptance: 'tests pass',
  executor: 'session-worker',
  status: 'working',
  ...overrides,
})

{
  const h = setup({ tasks: [workerTask()] })
  h.emit({ agent: { id: 'session-worker' }, status: 'idle' })
  await settle()
  assert.equal(h.prompts.length, 1)
  const request = h.prompts[0]
  assert.equal(request.sessionId, 'session-ria')
  assert.equal(request.mode, 'queue')
  const text = request.content[0].text
  assert.match(text, /\[Worker idle\]/)
  assert.match(text, /session-worker 的 turn 已结束/)
  assert.match(text, /taskId=task_1/)
  assert.match(text, /finish the report/)
  assert.match(text, /ria_read/)
  assert.match(text, /不要假设已完成/)
  assert.match(text, /blockedReason/)
  assert.match(h.logs.join('\n'), /notify Ria: session-worker idle for task_1/)
}

{
  const h = setup({ tasks: [workerTask({ executor: 'session-ria' })] })
  h.emit({ agent: { id: 'session-ria' }, status: 'idle' })
  await settle()
  assert.equal(h.prompts.length, 0)
}

{
  const h = setup({ tasks: [workerTask({ status: 'done' })] })
  h.emit({ agent: { id: 'session-worker' }, status: 'idle' })
  await settle()
  assert.equal(h.prompts.length, 0)
}

{
  const h = setup({ tasks: [workerTask()] })
  h.emit({ agent: { id: 'session-worker' }, status: 'running' })
  await settle()
  assert.equal(h.prompts.length, 0)
}

{
  const h = setup({ tasks: [workerTask()] })
  h.emit({ agent: { id: 'session-worker' }, status: 'idle' })
  await settle()
  h.emit({ agent: { id: 'session-worker' }, status: 'idle' })
  await settle()
  assert.equal(h.prompts.length, 1)
  assert.match(h.logs.join('\n'), /throttled/)
  h.advance(30_001)
  h.emit({ agent: { id: 'session-worker' }, status: 'idle' })
  await settle()
  assert.equal(h.prompts.length, 2)
}

{
  const h = setup({ tasks: [workerTask()], options: { notifyOnWorkerIdle: false } })
  assert.equal(h.hasHandler(), false)
  assert.match(h.logs.join('\n'), /disabled/)
}

{
  const tasks = [workerTask(), workerTask({ taskId: 'task_2', goal: 'second' })]
  const h = setup({ tasks })
  h.emit({ agent: { id: 'session-worker' }, status: 'idle' })
  await settle()
  assert.equal(h.prompts.length, 1)
  const text = h.prompts[0].content[0].text
  assert.match(text, /taskId=task_1/)
  assert.match(text, /taskId=task_2/)
  tasks.length = 1
  h.emit({ agent: { id: 'session-worker' }, status: 'idle' })
  await settle()
  assert.equal(h.prompts.length, 1)
  h.advance(30_001)
  h.emit({ agent: { id: 'session-worker' }, status: 'idle' })
  await settle()
  assert.equal(h.prompts.length, 2)
}

{
  assert.deepEqual(normalizeWorkerIdleOptions({}, {}), { enabled: true, throttleMs: 30_000 })
  assert.equal(normalizeWorkerIdleOptions({ notifyOnWorkerIdle: false }, {}).enabled, false)
  assert.equal(normalizeWorkerIdleOptions({ notifyOnWorkerIdle: true }, { DSH_RIA_WORKER_IDLE: '0' }).enabled, false)
  assert.equal(normalizeWorkerIdleOptions({}, { DSH_RIA_WORKER_IDLE: 'off' }).enabled, false)
  assert.equal(normalizeWorkerIdleOptions({ workerIdleThrottleMs: 5 }, {}).throttleMs, 1_000)
  assert.equal(normalizeWorkerIdleOptions({}, { DSH_RIA_WORKER_IDLE_THROTTLE_MS: '900000' }).throttleMs, 600_000)
}

console.log('worker-idle ok')
