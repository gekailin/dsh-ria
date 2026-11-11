// Temporary worker permission grants.
//
// A grant records the worker's effective sandbox mode and approval policy before
// the change, applies the requested values, writes an audit line, and restores
// the originals at task close, explicit reset, expiry, or the next startup.
// Restores are conservative: if the current value no longer matches the value
// this grant applied, the field is left alone and reported as skipped.

import { randomUUID } from 'node:crypto'
import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

export const SANDBOX_MODES = ['read-only', 'workspace-write', 'danger-full-access']
export const APPROVAL_POLICIES = ['ask', 'never']
export const DEFAULT_GRANT_TTL_MS = 30 * 60_000
export const MIN_GRANT_TTL_MS = 60_000
export const MAX_GRANT_TTL_MS = 24 * 60 * 60_000
const RETRY_MS = 60_000

const newGrantId = () => 'grant_' + Date.now().toString(36) + '_' + randomUUID().replace(/-/g, '').slice(0, 10)

function appendAudit(file, event) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  appendFileSync(file, JSON.stringify({ at: Date.now(), ...event }) + '\n', { mode: 0o600 })
}

function fieldSummary(before, after) {
  return { from: before, to: after }
}

export function publicGrant(grant) {
  const item = {
    grantId: grant.grantId,
    sessionId: grant.sessionId,
    taskId: grant.taskId || null,
    status: grant.status,
    createdAt: grant.createdAt,
    expiresAt: grant.expiresAt,
    before: {
      sandboxMode: grant.before.sandboxMode,
      sandboxOverride: grant.before.sandboxOverride ?? null,
      approvalPolicy: grant.before.approvalPolicy,
      approvalOverride: grant.before.approvalOverride ?? null,
    },
    after: {
      sandboxMode: grant.after.sandboxMode,
      approvalPolicy: grant.after.approvalPolicy,
    },
  }
  if (grant.reason) item.reason = grant.reason
  if (grant.lastError) item.lastError = grant.lastError
  return item
}

export class GrantService {
  constructor({ ctx, store, stateDir, isWorker, log = () => {}, ttlMs = DEFAULT_GRANT_TTL_MS }) {
    this.ctx = ctx
    this.store = store
    this.isWorker = isWorker
    this.log = log
    this.ttlMs = ttlMs
    this.auditFile = stateDir + '/audit.jsonl'
    this.timers = new Map()
    this.retryTimers = new Map()
    this.restoring = new Set()
  }

  audit(event) {
    try {
      appendAudit(this.auditFile, event)
    } catch (error) {
      this.log('warn', 'could not write audit.jsonl: ' + String(error && error.message ? error.message : error))
    }
  }

  async resolveAgent(sessionId) {
    const resolved = await this.ctx.sessionController.resolveAgent(sessionId)
    if (!resolved || 'error' in resolved) {
      const message = resolved && resolved.error && resolved.error.message ? resolved.error.message : 'session is not available'
      throw new Error('cannot resolve worker ' + sessionId + ': ' + message)
    }
    if (!resolved.agent || !resolved.agent.session) throw new Error('worker has no live session: ' + sessionId)
    return resolved.agent
  }

  readCurrent(agent) {
    const sandbox = this.ctx.sandboxPolicy
    const approval = this.ctx.approval
    if (!sandbox || typeof sandbox.resolve !== 'function' || typeof sandbox.overrideOf !== 'function') {
      throw new Error('the sandbox policy service is unavailable')
    }
    if (!approval || typeof approval.effectivePolicy !== 'function' || typeof approval.overrideOf !== 'function' || typeof approval.setPolicy !== 'function') {
      throw new Error('the approval service is unavailable')
    }
    const session = agent.session
    return {
      sandboxMode: sandbox.resolve({ session }).mode,
      sandboxOverride: sandbox.overrideOf(session),
      approvalPolicy: approval.effectivePolicy(session),
      approvalOverride: approval.overrideOf(session),
    }
  }

  applyFields(agent, grant) {
    const current = this.readCurrent(agent)
    if (grant.after.sandboxMode !== null) {
      if (current.sandboxOverride !== grant.after.sandboxMode) {
        agent.session.append('sandbox/mode', { mode: grant.after.sandboxMode })
      }
    }
    if (grant.after.approvalPolicy !== null) {
      if (current.approvalOverride !== grant.after.approvalPolicy) {
        this.ctx.approval.setPolicy(agent, grant.after.approvalPolicy)
      }
    }
  }

  async set(args) {
    if (args.userConfirmed !== true) throw new Error('ria_grant set requires userConfirmed=true; only an explicit user instruction may change worker permissions')
    const sessionId = typeof args.sessionId === 'string' ? args.sessionId.trim() : ''
    if (!sessionId) throw new Error('sessionId is required')
    if (sessionId === this.store.riaSessionId) throw new Error('cannot grant permissions to Ria itself')
    if (typeof this.isWorker !== 'function' || !(await this.isWorker(sessionId))) {
      throw new Error('session is not an available top-level worker: ' + sessionId)
    }
    const sandboxMode = args.sandboxMode === undefined ? null : String(args.sandboxMode)
    const approvalPolicy = args.approvalPolicy === undefined ? null : String(args.approvalPolicy)
    if (sandboxMode === null && approvalPolicy === null) throw new Error('sandboxMode or approvalPolicy is required')
    if (sandboxMode !== null && !SANDBOX_MODES.includes(sandboxMode)) throw new Error('invalid sandboxMode: ' + sandboxMode)
    if (approvalPolicy !== null && !APPROVAL_POLICIES.includes(approvalPolicy)) throw new Error('invalid approvalPolicy: ' + approvalPolicy)
    if (this.store.grants().some(item => item.sessionId === sessionId && item.status !== 'restored')) {
      throw new Error('session already has an active permission grant; reset it before setting another')
    }

    const taskId = typeof args.taskId === 'string' ? args.taskId.trim() : ''
    let task = null
    if (taskId) {
      task = this.store.task(taskId)
      if (!task) throw new Error('task not found: ' + taskId)
      if (task.status === 'done' || task.status === 'cancelled') throw new Error('task is closed: ' + taskId)
      if (task.executor !== sessionId) throw new Error('task executor is ' + task.executor + ', not this worker')
    }

    const ttlSeconds = args.ttlSeconds === undefined ? Math.floor(this.ttlMs / 1000) : Number(args.ttlSeconds)
    if (!Number.isFinite(ttlSeconds) || ttlSeconds < 60 || ttlSeconds > 86400) throw new Error('ttlSeconds must be between 60 and 86400')
    const createdAt = Date.now()
    const expiresAt = createdAt + Math.floor(ttlSeconds * 1000)
    const agent = await this.resolveAgent(sessionId)
    const before = this.readCurrent(agent)
    if ((sandboxMode === null || sandboxMode === before.sandboxMode) && (approvalPolicy === null || approvalPolicy === before.approvalPolicy)) {
      throw new Error('requested permissions already match the current effective values')
    }

    const grant = {
      grantId: newGrantId(),
      sessionId,
      taskId: taskId || null,
      status: 'applying',
      createdAt,
      expiresAt,
      before,
      after: { sandboxMode, approvalPolicy },
      reason: typeof args.reason === 'string' ? args.reason.trim() : '',
      lastError: null,
    }
    this.store.addGrant(grant)
    this.audit({
      event: 'grant/set',
      grantId: grant.grantId,
      sessionId,
      taskId: grant.taskId,
      expiresAt,
      sandboxMode: fieldSummary(before.sandboxMode, sandboxMode),
      approvalPolicy: fieldSummary(before.approvalPolicy, approvalPolicy),
      reason: grant.reason,
    })

    try {
      this.applyFields(agent, grant)
    } catch (error) {
      const message = String(error && error.message ? error.message : error)
      this.log('error', 'grant ' + grant.grantId + ' apply failed: ' + message)
      this.audit({ event: 'grant/apply_failed', grantId: grant.grantId, sessionId, error: message })
      await this.restore(grant.grantId, 'apply-failed')
      throw new Error('could not apply permissions: ' + message)
    }

    const active = this.store.updateGrant(grant.grantId, { status: 'active', lastError: null })
    this.audit({ event: 'grant/active', grantId: grant.grantId, sessionId })
    this.armTimer(active)
    return publicGrant(active)
  }

  list() {
    return this.store.grants()
      .filter(item => item.status !== 'restored')
      .map(publicGrant)
      .sort((a, b) => a.createdAt - b.createdAt || a.grantId.localeCompare(b.grantId))
  }

  async reconcile() {
    for (const grant of this.store.grants().slice()) {
      if (grant.status === 'restored') {
        this.clearTimers(grant.grantId)
        continue
      }
      const task = grant.taskId ? this.store.task(grant.taskId) : null
      const closed = grant.taskId && (!task || task.status === 'done' || task.status === 'cancelled')
      if (grant.status === 'applying' || grant.status === 'restore_failed' || grant.expiresAt <= Date.now() || closed) {
        let trigger = 'startup'
        if (grant.status === 'restore_failed') trigger = 'retry'
        else if (grant.status !== 'applying' && grant.expiresAt <= Date.now()) trigger = 'expired'
        else if (grant.status !== 'applying' && closed) trigger = !task || task.status === 'done' ? 'task-done' : 'task-cancelled'
        await this.restore(grant.grantId, trigger)
      } else {
        this.armTimer(grant)
      }
    }
  }

  async onTaskChanged(task) {
    if (!task || (task.status !== 'done' && task.status !== 'cancelled')) return
    const grants = this.store.grants().filter(item => item.taskId === task.taskId && item.status !== 'restored')
    for (const grant of grants) {
      await this.restore(grant.grantId, task.status === 'done' ? 'task-done' : 'task-cancelled')
    }
  }

  async restore(grantId, trigger) {
    if (this.restoring.has(grantId)) return { grantId, restored: false, skipped: [], busy: true }
    const grant = this.store.grant(grantId)
    if (!grant || grant.status === 'restored') return { grantId, restored: false, skipped: [], missing: true }
    this.restoring.add(grantId)
    this.clearTimers(grantId)
    const restored = []
    const skipped = []
    try {
      const agent = await this.resolveAgent(grant.sessionId)
      if (grant.after.sandboxMode !== null) {
        const current = this.ctx.sandboxPolicy.overrideOf(agent.session)
        if (current === grant.after.sandboxMode) {
          agent.session.append('sandbox/mode', { mode: grant.before.sandboxMode })
          restored.push('sandboxMode')
        } else {
          skipped.push('sandboxMode')
        }
      }
      if (grant.after.approvalPolicy !== null) {
        const current = this.ctx.approval.overrideOf(agent.session)
        if (current === grant.after.approvalPolicy) {
          this.ctx.approval.setPolicy(agent, grant.before.approvalPolicy)
          restored.push('approvalPolicy')
        } else {
          skipped.push('approvalPolicy')
        }
      }
    } catch (error) {
      const message = String(error && error.message ? error.message : error)
      this.store.updateGrant(grantId, { status: 'restore_failed', lastError: message })
      this.audit({ event: 'grant/restore_failed', grantId, trigger, error: message })
      this.log('error', 'grant ' + grantId + ' restore failed: ' + message)
      this.armRetry(grantId)
      this.restoring.delete(grantId)
      return { grantId, restored: false, skipped, error: message }
    }
    this.store.removeGrant(grantId)
    this.audit({ event: 'grant/restored', grantId, sessionId: grant.sessionId, trigger, restored, skipped })
    this.restoring.delete(grantId)
    return { grantId, restored: true, restoredFields: restored, skippedFields: skipped }
  }

  armTimer(grant) {
    this.clearTimer(grant.grantId)
    const delay = Math.max(0, grant.expiresAt - Date.now())
    const timer = setTimeout(() => { void this.restore(grant.grantId, 'expired') }, delay)
    if (timer.unref) timer.unref()
    this.timers.set(grant.grantId, timer)
  }

  armRetry(grantId) {
    if (this.retryTimers.has(grantId)) return
    const timer = setTimeout(() => {
      this.retryTimers.delete(grantId)
      void this.restore(grantId, 'retry')
    }, RETRY_MS)
    if (timer.unref) timer.unref()
    this.retryTimers.set(grantId, timer)
  }

  clearTimer(grantId) {
    const timer = this.timers.get(grantId)
    if (timer) clearTimeout(timer)
    this.timers.delete(grantId)
  }

  clearTimers(grantId) {
    this.clearTimer(grantId)
    const retry = this.retryTimers.get(grantId)
    if (retry) clearTimeout(retry)
    this.retryTimers.delete(grantId)
  }

  shutdown() {
    for (const id of [...this.timers.keys()]) this.clearTimer(id)
    for (const id of [...this.retryTimers.keys()]) this.clearTimers(id)
  }
}
