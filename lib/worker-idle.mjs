// Worker-idle notifications.
//
// Watches agent/status transitions. When a worker that owns a working task
// becomes idle, wake the Super Session with a synthetic manager note. This is
// read-only with respect to the worker: no prompt, message, tool, or resume is
// sent to it.

import { randomUUID } from 'node:crypto'

export const DEFAULT_WORKER_IDLE_OPTIONS = Object.freeze({
  enabled: true,
  throttleMs: 30_000,
})

const TRUE_VALUES = new Set(['1', 'true', 'on', 'yes', 'enabled'])
const FALSE_VALUES = new Set(['0', 'false', 'off', 'no', 'disabled'])

function parseBoolean(value) {
  if (typeof value === 'boolean') return value
  if (typeof value !== 'string') return undefined
  const normalized = value.trim().toLowerCase()
  if (TRUE_VALUES.has(normalized)) return true
  if (FALSE_VALUES.has(normalized)) return false
  return undefined
}

export function normalizeWorkerIdleOptions(config = {}, env = process.env) {
  const source = config && typeof config === 'object' ? config : {}
  let enabled = DEFAULT_WORKER_IDLE_OPTIONS.enabled
  const configured = parseBoolean(source.notifyOnWorkerIdle)
  if (configured !== undefined) enabled = configured
  const fromEnv = parseBoolean(env && env.DSH_SUPER_SESSION_WORKER_IDLE)
  if (fromEnv !== undefined) enabled = fromEnv

  const rawThrottle = source.workerIdleThrottleMs ?? (env && env.DSH_SUPER_SESSION_WORKER_IDLE_THROTTLE_MS)
  let throttleMs = DEFAULT_WORKER_IDLE_OPTIONS.throttleMs
  if (rawThrottle !== undefined && rawThrottle !== null && String(rawThrottle).trim() !== '') {
    const parsed = Number(rawThrottle)
    if (Number.isFinite(parsed)) throttleMs = Math.min(600_000, Math.max(1_000, Math.floor(parsed)))
  }
  return { enabled, throttleMs }
}

function shortGoal(goal) {
  const text = String(goal || '').replace(/\s+/g, ' ').trim()
  return text.length > 240 ? text.slice(0, 237) + '...' : text
}

function idleText(sessionId, tasks) {
  const lines = [
    '[Worker idle]',
    'worker ' + sessionId + ' 的 turn 已结束。',
    '相关任务：',
  ]
  for (const task of tasks) {
    lines.push('- taskId=' + task.taskId + (task.goal ? ' | goal=' + shortGoal(task.goal) : ''))
  }
  lines.push(
    '请用 super_session_read 读取 worker 最近消息，确认是否真的完成；不要假设已完成。',
    '如果已完成：把对应 task 标为 done，并向用户汇报结果。',
    '如果 worker 在等用户输入或需要用户决定：把 task 标为 blocked 并写清 blockedReason，然后报告用户。',
    '如果还需要继续：用 super_session_request 发送 continuation。',
  )
  return lines.join('\n')
}

export class WorkerIdleWatcher {
  constructor({ ctx, store, ensureSuper, getSuperId, log = () => {}, now = Date.now, options = {} } = {}) {
    this.ctx = ctx
    this.store = store
    this.ensureSuper = ensureSuper
    this.getSuperId = getSuperId
    this.log = log
    this.now = now
    this.options = normalizeWorkerIdleOptions(options)
    this.lastNotified = new Map()
    this.disposed = false
  }

  subscribe() {
    if (!this.options.enabled) {
      this.log('info', 'notifications disabled by config/env')
      return () => {}
    }
    this.log('info', 'notifications enabled (throttle ' + this.options.throttleMs + 'ms)')
    const listener = payload => {
      void this.handle(payload).catch(error => {
        this.log('warn', 'notification failed: ' + String(error && error.message ? error.message : error))
      })
    }
    const dispose = this.ctx.on('agent/status', listener)
    return () => {
      this.disposed = true
      this.lastNotified.clear()
      if (typeof dispose === 'function') dispose()
    }
  }

  async handle(payload) {
    if (this.disposed) return
    const agent = payload && payload.agent
    const status = payload && payload.status
    if (status !== 'idle') return
    const rawId = agent && (agent.id ?? (agent.session && agent.session.id))
    if (!rawId) return
    const sessionId = String(rawId)

    const superId = this.getSuperId && this.getSuperId()
    if (superId && sessionId === String(superId)) {
      this.log('debug', 'skip ' + sessionId + ': it is the Super Session')
      return
    }

    const tasks = (this.store.tasks ? this.store.tasks() : []).filter(task =>
      task && task.status === 'working' && String(task.executor) === sessionId)
    if (!tasks.length) {
      this.log('debug', 'skip ' + sessionId + ': no working task')
      return
    }

    const taskIds = tasks.map(task => String(task.taskId)).sort()
    const now = this.now()
    const taskKeys = taskIds.map(taskId => sessionId + '|' + taskId)
    const fresh = taskKeys.some(key => {
      const previous = this.lastNotified.get(key)
      return previous === undefined || now - previous >= this.options.throttleMs
    })
    if (!fresh) {
      const previous = this.lastNotified.get(taskKeys[0])
      this.log('info', 'skip ' + sessionId + ': throttled (' + (now - previous) + 'ms < ' + this.options.throttleMs + 'ms) for ' + taskIds.join(','))
      return
    }
    for (const key of taskKeys) this.lastNotified.set(key, now)
    this.prune(now)

    const text = idleText(sessionId, tasks)
    this.log('info', 'notify Super: ' + sessionId + ' idle for ' + taskIds.join(','))
    const superSessionId = await this.ensureSuper()
    if (!superSessionId) throw new Error('Super Session is unavailable')
    await this.ctx.sessionController.prompt({
      requestId: 'req_' + randomUUID().replace(/-/g, ''),
      sessionId: String(superSessionId),
      mode: 'queue',
      content: [{ type: 'text', text }],
    }, new AbortController().signal)
  }

  prune(now) {
    if (this.lastNotified.size <= 500) return
    for (const [key, at] of this.lastNotified) {
      if (now - at >= this.options.throttleMs) this.lastNotified.delete(key)
    }
  }

  shutdown() {
    this.disposed = true
    this.lastNotified.clear()
  }
}
