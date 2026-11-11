// Worker-idle notifications.
//
// Watches agent/status transitions. When a worker that owns a working task
// becomes idle, wake Ria with a synthetic manager note. This is
// read-only with respect to the worker: no prompt, message, tool, or resume is
// sent to it.

import { randomUUID } from 'node:crypto'
import { isUserCancelled, lastTurnEnd } from './turn-end.mjs'
import { HOST_REQUEST_PREFIX } from './wechat/request-ids.mjs'

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
  const fromEnv = parseBoolean(env && env.DSH_RIA_WORKER_IDLE)
  if (fromEnv !== undefined) enabled = fromEnv

  const rawThrottle = source.workerIdleThrottleMs ?? (env && env.DSH_RIA_WORKER_IDLE_THROTTLE_MS)
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

function idleText(sessionId, tasks, lastTurn) {
  const cancelled = isUserCancelled(lastTurn)
  const lines = [
    '[Worker idle]',
    'worker ' + sessionId + ' 的 turn 已结束。',
  ]
  if (lastTurn) {
    const turn = lastTurn.turn === undefined ? '' : '（turn ' + lastTurn.turn + '）'
    lines.push('最后一轮结束原因：' + lastTurn.outcome + turn)
  }
  lines.push('相关任务：')
  for (const task of tasks) {
    lines.push('- taskId=' + (task.ticketId || task.taskId) + (task.goal ? ' | goal=' + shortGoal(task.goal) : ''))
  }
  if (cancelled) {
    lines.push(
      '用户手动取消/叫停了这个 turn。必须停下来等用户决定：不要自动续派、重发、改派，也不要自行换方案。',
      '对应 task 已标为 blocked（blockedReason：用户取消了 worker turn）；若尚未标记，请补上。',
      '请用 ria_read 读取 worker 最近消息，确认取消前做到哪一步，然后向用户报告并询问下一步。',
    )
  } else {
    lines.push(
      '请用 ria_read 读取 worker 最近消息，确认是否真的完成；不要假设已完成。',
      '如果已完成：把对应 task 标为 done，并向用户汇报结果。',
      '如果 worker 明确拒绝执行：把 task 标为 blocked 并写清拒绝原因，停下来问用户下一步；不要自动改派、重发或换方案。',
      '如果 worker 在等用户输入或需要用户决定：把 task 标为 blocked 并写清 blockedReason，然后报告用户。',
      '如果还需要继续：用 ria_request 发送 continuation。',
    )
  }
  return lines.join('\n')
}

export class WorkerIdleWatcher {
  constructor({ ctx, store, ensureRia, getRiaId, log = () => {}, now = Date.now, options = {} } = {}) {
    this.ctx = ctx
    this.store = store
    this.ensureRia = ensureRia
    this.getRiaId = getRiaId
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

    const riaId = this.getRiaId && this.getRiaId()
    if (riaId && sessionId === String(riaId)) {
      this.log('debug', 'skip ' + sessionId + ': it is Ria')
      return
    }

    const tasks = (this.store.tasks ? this.store.tasks() : []).filter(task =>
      task && task.status === 'working' && String(task.executor) === sessionId)
    if (!tasks.length) {
      this.log('debug', 'skip ' + sessionId + ': no working task')
      return
    }

    const taskIds = tasks.map(task => String((task.ticketId || task.taskId))).sort()
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

    const lastTurn = lastTurnEnd(agent && agent.session)
    if (isUserCancelled(lastTurn) && typeof this.store.updateTask === 'function') {
      for (const task of tasks) {
        try {
          this.store.updateTask((task.ticketId || task.taskId), {
            status: 'blocked',
            blockedReason: '用户取消了 worker turn（aborted(user)）；等待用户决定下一步',
          })
        } catch (error) {
          this.log('warn', 'could not block task ' + (task.ticketId || task.taskId) + ' after user cancel: ' + String(error && error.message ? error.message : error))
        }
      }
      this.log('info', 'user cancelled turn on ' + sessionId + '; blocked ' + taskIds.join(','))
    }

    const text = idleText(sessionId, tasks, lastTurn)
    this.log('info', 'notify Ria: ' + sessionId + ' idle for ' + taskIds.join(','))
    const riaSessionId = await this.ensureRia()
    if (!riaSessionId) throw new Error('Ria is unavailable')
    await this.ctx.sessionController.prompt({
      requestId: HOST_REQUEST_PREFIX + randomUUID().replace(/-/g, ''),
      sessionId: String(riaSessionId),
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
