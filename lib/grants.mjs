// Session permission grants.
//
// A grant records the session's effective sandbox mode and approval policy
// before the change, applies the requested values, and writes an audit line.
// Pure downgrades are permanent: only an explicit reset restores them. Any
// escalation is temporary; automatic restores (task close, expiry, restart)
// undo only the escalated fields, so a downgrade bundled into the same grant
// stays in effect. An explicit reset or a failed apply restores every requested
// field. Restores are conservative: if the current value no longer matches the
// value this grant applied, the field is left alone and reported as skipped.

import { randomUUID } from 'node:crypto'
import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

export const SANDBOX_MODES = ['read-only', 'workspace-write', 'danger-full-access']
export const APPROVAL_POLICIES = ['ask', 'never']
export const DEFAULT_GRANT_TTL_MS = 30 * 60_000
export const MIN_GRANT_TTL_MS = 60_000
export const MAX_GRANT_TTL_MS = 24 * 60 * 60_000
const RETRY_MS = 60_000
const SANDBOX_RANK = { 'read-only': 0, 'workspace-write': 1, 'danger-full-access': 2 }

const isPermanentGrant = grant => grant.expiresAt === null || grant.kind === 'permanent'

// A grant is an escalation when any requested field widens access. Pure
// downgrades are permanent: they need no TTL and must survive ticket close and
// restart. A mixed change is temporary because it contains an escalation.
function escalationFields(before, sandboxMode, approvalPolicy) {
  return {
    sandboxMode: sandboxMode !== null && SANDBOX_RANK[sandboxMode] > SANDBOX_RANK[before.sandboxMode],
    approvalPolicy: approvalPolicy !== null && approvalPolicy === 'never' && before.approvalPolicy !== 'never',
  }
}

const newGrantId = () => 'grant_' + Date.now().toString(36) + '_' + randomUUID().replace(/-/g, '').slice(0, 10)

export function appendAudit(file, event) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  appendFileSync(file, JSON.stringify({ at: Date.now(), ...event }) + '\n', { mode: 0o600 })
}

function fieldSummary(before, after) {
  return { from: before, to: after }
}

export function publicGrant(grant) {
  const permanent = grant.expiresAt === null || grant.kind === 'permanent'
  const item = {
    grantId: grant.grantId,
    sessionId: grant.sessionId,
    ticketId: grant.ticketId || grant.taskId || null,
    status: grant.status,
    kind: permanent ? 'permanent' : 'temporary',
    permanent,
    createdAt: grant.createdAt,
    expiresAt: permanent ? null : grant.expiresAt,
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
      throw new Error('cannot resolve session ' + sessionId + ': ' + message)
    }
    if (!resolved.agent || !resolved.agent.session) throw new Error('session has no live agent: ' + sessionId)
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
    if (args.userConfirmed !== true) throw new Error('ria_grant set requires userConfirmed=true; only an explicit user instruction may change session permissions')
    const sessionId = typeof args.sessionId === 'string' ? args.sessionId.trim() : ''
    if (!sessionId) throw new Error('sessionId is required')
    if (sessionId === this.store.riaSessionId) throw new Error('cannot grant permissions to Ria itself')
    if (typeof this.isWorker !== 'function' || !(await this.isWorker(sessionId))) {
      throw new Error('session is not an available top-level session: ' + sessionId)
    }
    const sandboxMode = args.sandboxMode === undefined ? null : String(args.sandboxMode)
    const approvalPolicy = args.approvalPolicy === undefined ? null : String(args.approvalPolicy)
    if (sandboxMode === null && approvalPolicy === null) throw new Error('sandboxMode or approvalPolicy is required')
    if (sandboxMode !== null && !SANDBOX_MODES.includes(sandboxMode)) throw new Error('invalid sandboxMode: ' + sandboxMode)
    if (approvalPolicy !== null && !APPROVAL_POLICIES.includes(approvalPolicy)) throw new Error('invalid approvalPolicy: ' + approvalPolicy)
    if (this.store.grants().some(item => item.sessionId === sessionId && item.status !== 'restored')) {
      throw new Error('session already has an active permission grant; reset it before setting another')
    }

    const ticketId = typeof args.ticketId === 'string' ? args.ticketId.trim() : ''
    let ticket = null
    if (ticketId) {
      ticket = this.store.ticket(ticketId)
      if (!ticket) throw new Error('ticket not found: ' + ticketId)
      if (ticket.status === 'done' || ticket.status === 'cancelled') throw new Error('ticket is closed: ' + ticketId)
      if (ticket.executor !== sessionId) throw new Error('ticket executor is ' + ticket.executor + ', not this worker')
    }

    const agent = await this.resolveAgent(sessionId)
    const before = this.readCurrent(agent)
    if ((sandboxMode === null || sandboxMode === before.sandboxMode) && (approvalPolicy === null || approvalPolicy === before.approvalPolicy)) {
      throw new Error('requested permissions already match the current effective values')
    }

    const escalated = escalationFields(before, sandboxMode, approvalPolicy)
    const escalation = escalated.sandboxMode || escalated.approvalPolicy
    const createdAt = Date.now()
    let expiresAt = null
    if (escalation) {
      const ttlSeconds = args.ttlSeconds === undefined ? Math.floor(this.ttlMs / 1000) : Number(args.ttlSeconds)
      if (!Number.isFinite(ttlSeconds) || ttlSeconds < 60 || ttlSeconds > 86400) throw new Error('ttlSeconds must be between 60 and 86400')
      expiresAt = createdAt + Math.floor(ttlSeconds * 1000)
    }

    const grant = {
      grantId: newGrantId(),
      sessionId,
      ticketId: ticketId || null,
      status: 'applying',
      kind: escalation ? 'temporary' : 'permanent',
      escalation,
      escalated,
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
      ticketId: grant.ticketId || grant.taskId,
      kind: grant.kind,
      escalation,
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
      // A permanent downgrade is the new steady state: ticket close, expiry,
      // and restart must not undo it. Only an explicit reset restores it.
      if (isPermanentGrant(grant) && grant.status !== 'applying' && grant.status !== 'restore_failed') {
        this.clearTimers(grant.grantId)
        continue
      }
      const ticketId = grant.ticketId || grant.taskId
      const ticket = ticketId ? this.store.ticket(ticketId) : null
      const closed = ticketId && (!ticket || ticket.status === 'done' || ticket.status === 'cancelled')
      const expired = grant.expiresAt !== null && grant.expiresAt <= Date.now()
      if (grant.status === 'applying' || grant.status === 'restore_failed' || expired || closed) {
        let trigger = 'startup'
        if (grant.status === 'restore_failed') trigger = 'retry'
        else if (grant.status !== 'applying' && expired) trigger = 'expired'
        else if (grant.status !== 'applying' && closed) trigger = !ticket || ticket.status === 'done' ? 'ticket-done' : 'ticket-cancelled'
        await this.restore(grant.grantId, trigger)
      } else {
        this.armTimer(grant)
      }
    }
  }

  async onTicketChanged(ticket) {
    if (!ticket || (ticket.status !== 'done' && ticket.status !== 'cancelled')) return
    const id = ticket.ticketId
    const grants = this.store.grants().filter(item => (item.ticketId || item.taskId) === id && item.status !== 'restored' && !isPermanentGrant(item))
    for (const grant of grants) {
      await this.restore(grant.grantId, ticket.status === 'done' ? 'ticket-done' : 'ticket-cancelled')
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
    // Automatic restores only undo escalations. A downgrade bundled into the
    // same temporary grant is the new steady state and must survive expiry.
    // Explicit reset and a failed apply undo every field the grant requested.
    const restoreAll = trigger === 'explicit-reset' || trigger === 'apply-failed'
    const escalated = grant.escalated && typeof grant.escalated === 'object'
      ? grant.escalated
      : { sandboxMode: true, approvalPolicy: true }
    const shouldRestore = field => restoreAll || escalated[field] !== false
    try {
      const agent = await this.resolveAgent(grant.sessionId)
      if (grant.after.sandboxMode !== null && shouldRestore('sandboxMode')) {
        const current = this.ctx.sandboxPolicy.overrideOf(agent.session)
        if (current === grant.after.sandboxMode) {
          agent.session.append('sandbox/mode', { mode: grant.before.sandboxMode })
          restored.push('sandboxMode')
        } else {
          skipped.push('sandboxMode')
        }
      }
      if (grant.after.approvalPolicy !== null && shouldRestore('approvalPolicy')) {
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
    this.audit({ event: 'grant/restored', grantId, sessionId: grant.sessionId, kind: grant.kind || 'temporary', trigger, restored, skipped })
    this.restoring.delete(grantId)
    return { grantId, restored: true, restoredFields: restored, skippedFields: skipped }
  }

  armTimer(grant) {
    this.clearTimer(grant.grantId)
    if (isPermanentGrant(grant)) return
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
