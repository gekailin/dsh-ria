import assert from 'node:assert/strict'
import { ApprovalObserver } from '../lib/approvals.mjs'

const tasks = [
  { taskId: 'task_1', executor: 'session-worker', status: 'working' },
  { taskId: 'task_2', executor: 'session-other', status: 'open' },
]

function assertLossless(value, path = 'value') {
  if (value === undefined) throw new Error(path + ' is undefined')
  if (typeof value === 'number' && !Number.isFinite(value)) throw new Error(path + ' is not finite')
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertLossless(item, path + '[' + index + ']'))
    return
  }
  if (typeof value === 'object') {
    if (value instanceof Date) throw new Error(path + ' is a Date')
    for (const [key, item] of Object.entries(value)) assertLossless(item, path + '.' + key)
    return
  }
  throw new Error(path + ' has unsupported type ' + typeof value)
}

function setup(overrides = {}) {
  let handler
  let disposed = false
  const ctx = {
    on(event, fn) {
      assert.equal(event, 'approval/request')
      handler = fn
      return () => { disposed = true; handler = undefined }
    },
  }
  const store = {
    riaSessionId: 'session-ria',
    activeTasks: () => tasks,
  }
  const observer = new ApprovalObserver({ ctx, store, ttlMs: 10000, ...overrides })
  const dispose = observer.subscribe()
  return { observer, dispose, invoke: (request, next) => handler(request, next), isDisposed: () => disposed }
}

{
  const { observer, invoke } = setup()
  let during
  let nextCalls = 0
  const result = await invoke(
    {
      agent: { id: 'session-worker' },
      toolName: 'bash',
      callId: 'call_1',
      reason: 'write outside workspace',
      signal: new AbortController().signal,
    },
    async () => {
      nextCalls += 1
      during = observer.list()
      return 'denied'
    },
  )
  assert.equal(result, 'denied')
  assert.equal(nextCalls, 1)
  assert.equal(during.length, 1)
  assertLossless(during)
  const item = during[0]
  assert.equal(item.workerSessionId, 'session-worker')
  assert.equal(item.taskId, 'task_1')
  assert.equal(item.toolName, 'bash')
  assert.equal(item.callId, 'call_1')
  assert.equal(item.reason, 'write outside workspace')
  assert.equal(typeof item.approvalId, 'string')
  assert.equal(typeof item.createdAt, 'number')
  assert.equal(typeof item.expiresAt, 'number')
  assert.equal(observer.list().length, 0)
}

{
  const { observer, invoke } = setup()
  let nextCalls = 0
  const next = async () => { nextCalls += 1; return 'unavailable' }
  await invoke({ agent: { id: 'session-ria' }, toolName: 'bash' }, next)
  await invoke({ agent: { id: 'session-unknown' }, toolName: 'bash' }, next)
  await invoke({ toolName: 'bash' }, next)
  assert.equal(nextCalls, 3)
  assert.equal(observer.list().length, 0)
}

{
  const { observer, invoke } = setup()
  const controller = new AbortController()
  let during
  await invoke(
    { agent: { id: 'session-worker' }, toolName: 'bash', signal: controller.signal },
    async () => {
      controller.abort()
      during = observer.list()
      return 'unavailable'
    },
  )
  assert.equal(during.length, 0)
  assert.equal(observer.list().length, 0)
}

{
  const { observer, invoke } = setup({ ttlMs: 20 })
  let during
  const pending = invoke(
    { agent: { id: 'session-worker' }, toolName: 'bash', signal: new AbortController().signal },
    async () => {
      await new Promise(resolve => setTimeout(resolve, 40))
      during = observer.list()
      return 'unavailable'
    },
  )
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.equal(observer.list().length, 0)
  await pending
  assert.equal(during.length, 0)
}

{
  const { observer, invoke, dispose, isDisposed } = setup()
  let release
  const pending = invoke(
    { agent: { id: 'session-worker' }, toolName: 'bash', signal: new AbortController().signal },
    () => new Promise(resolve => { release = resolve }),
  )
  await new Promise(resolve => setTimeout(resolve, 5))
  assert.equal(observer.list().length, 1)
  observer.shutdown()
  assert.equal(observer.list().length, 0)
  release('denied')
  await pending
  dispose()
  assert.equal(isDisposed(), true)
}

console.log('approvals ok')
