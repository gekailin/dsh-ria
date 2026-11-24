// Ticket-scoped permission grants, with legacy session-only grants supported.
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
import { appendDailyLog, dailyLogFile } from './shared/daily-log.mjs'

export const AUDIT_LOG_FILE = 'audit.jsonl'

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

export function appendAudit(fileOrStateDir, event) {
  const at = Number.isFinite(event && event.at) ? event.at : Date.now()
  if (String(fileOrStateDir).endsWith('.jsonl')) {
    mkdirSync(dirname(fileOrStateDir), { recursive: true, mode: 0o700 })
    appendFileSync(fileOrStateDir, JSON.stringify({ at, ...event }) + '\n', { mode: 0o600 })
    return
  }
  appendDailyLog(fileOrStateDir, AUDIT_LOG_FILE, { at, ...event }, { at })
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
    scopeKey: grant.scopeKey || ((grant.ticketId || grant.taskId) ? 'ticket:' + (grant.ticketId || grant.taskId) : 'session:' + grant.sessionId),
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
  constructor({ ctx, store, stateDir, isExecutor, log = () => {}, ttlMs = DEFAULT_GRANT_TTL_MS }) {
    this.ctx = ctx
    this.store = store
    this.isExecutor = isExecutor
    this.log = log
    this.ttlMs = ttlMs
    this.stateDir = stateDir
    this.auditFile = dailyLogFile(stateDir, AUDIT_LOG_FILE)
    this.timers = new Map()
    this.retryTimers = new Map()
    this.restoring = new Set()
    this.migrations = new Map()
  }

  audit(event) {
    try {
      const at = Number.isFinite(event && event.at) ? event.at : Date.now()
      this.auditFile = appendDailyLog(this.stateDir, AUDIT_LOG_FILE, { at, ...event }, { at })
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
    const ticketId = typeof args.ticketId === 'string' ? args.ticketId.trim() : ''
    const ticket = ticketId ? this.store.ticket(ticketId) : null
    if (ticketId && !ticket) throw new Error('ticket not found: ' + ticketId)
    if (ticket && ['done', 'failed', 'cancelled'].includes(ticket.status)) throw new Error('ticket is closed: ' + ticketId)
    const sessionId = (typeof args.sessionId === 'string' ? args.sessionId.trim() : '') || (ticket && ticket.executor) || ''
    if (!sessionId) throw new Error('ticketId with an executor or sessionId is required')
    if (ticket && String(ticket.executor) !== sessionId) throw new Error('ticket executor is ' + ticket.executor + ', not this executor')
    if (sessionId === this.store.riaSessionId) throw new Error('cannot grant permissions to Ria itself')
    if (typeof this.isExecutor !== 'function' || !(await this.isExecutor(sessionId))) {
      throw new Error('session is not an available top-level session: ' + sessionId)
    }
    const sandboxMode = args.sandboxMode === undefined ? null : String(args.sandboxMode)
    const approvalPolicy = args.approvalPolicy === undefined ? null : String(args.approvalPolicy)
    if (sandboxMode === null && approvalPolicy === null) throw new Error('sandboxMode or approvalPolicy is required')
    if (sandboxMode !== null && !SANDBOX_MODES.includes(sandboxMode)) throw new Error('invalid sandboxMode: ' + sandboxMode)
    if (approvalPolicy !== null && !APPROVAL_POLICIES.includes(approvalPolicy)) throw new Error('invalid approvalPolicy: ' + approvalPolicy)
    if (this.store.grants().some(item => item.status !== 'restored' && (
      this.applicationsFor(item).some(app => app.sessionId === sessionId && app.status !== 'restored')
      || (ticketId && (item.ticketId || item.taskId) === ticketId)))) {
      throw new Error('ticket/session already has an active permission grant; reset it before setting another')
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
      scopeKey: ticketId ? 'ticket:' + ticketId : 'session:' + sessionId,
      applications: [{ sessionId, before, after: { sandboxMode, approvalPolicy }, escalated, status: 'active' }],
      status: 'applying',
      kind: escalation ? 'temporary' : 'permanent',
      escalation,
      escalated,
      createdAt,
      expiresAt,
      before,
      after: { sandboxMode, approvalPolicy },
      reason: typeof args.reason === 'string' ? args.reason.trim() : '',
      grantKind: args.grantKind === 'emergency' ? 'emergency' : 'debug',
      lastError: null,
    }
    this.store.addGrant(grant)
    this.audit({
      event: 'grant/set',
      grantId: grant.grantId,
      sessionId,
      ticketId: grant.ticketId || grant.taskId,
      kind: grant.kind,
      grant_kind: grant.grantKind,
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
    this.audit({ event: 'grant/active', grantId: grant.grantId, ticketId: grant.ticketId, sessionId, scopeKey: grant.scopeKey })
    this.armTimer(active)
    return publicGrant(active)
  }

  applicationsFor(grant) {
    // Compatibility: legacy grants only stored one session snapshot.
    return Array.isArray(grant.applications) && grant.applications.length ? grant.applications : [{
      sessionId: grant.sessionId, before: grant.before, after: grant.after,
      escalated: grant.escalated, status: 'active',
    }]
  }

  activeForTicket(ticketId, sessionId = null) {
    return this.store.grants().filter(grant => (grant.ticketId || grant.taskId) === ticketId
      && grant.status === 'active' && (grant.expiresAt === null || grant.expiresAt > Date.now())
      && (!sessionId || grant.sessionId === sessionId))
  }

  async restoreApplication(application, restoreAll = false) {
    const agent = await this.resolveAgent(application.sessionId)
    const escalated = application.escalated || { sandboxMode: true, approvalPolicy: true }
    const restored = []
    const skipped = []
    for (const field of ['sandboxMode', 'approvalPolicy']) {
      if (application.after[field] === null || (!restoreAll && escalated[field] === false)) continue
      const current = field === 'sandboxMode' ? this.ctx.sandboxPolicy.overrideOf(agent.session) : this.ctx.approval.overrideOf(agent.session)
      if (current !== application.after[field]) { skipped.push(field); continue }
      if (field === 'sandboxMode') agent.session.append('sandbox/mode', { mode: application.before.sandboxMode })
      else this.ctx.approval.setPolicy(agent, application.before.approvalPolicy)
      restored.push(field)
    }
    return { restored, skipped }
  }

  async moveToExecutor(grantId, sessionId) {
    const previous = this.migrations.get(grantId)
    const operation = (async () => {
      if (previous) await previous
      const grant = this.store.grant(grantId)
      if (!grant || grant.status !== 'active' || this.restoring.has(grantId)) throw new Error('grant is not active: ' + grantId)
      if (grant.sessionId === sessionId) return publicGrant(grant)
      const ticketId = grant.ticketId || grant.taskId
      const ticket = ticketId ? this.store.ticket(ticketId) : null
      if (!ticket || ticket.status !== 'working' || String(ticket.executor) !== sessionId) throw new Error('grant target is not the current ticket executor')
      if (grant.expiresAt !== null && grant.expiresAt <= Date.now()) throw new Error('ticket grant expired before migration')
      if (this.store.grants().some(item => item.grantId !== grantId && item.status !== 'restored'
        && this.applicationsFor(item).some(app => app.sessionId === sessionId && app.status !== 'restored'))) {
        throw new Error('new executor already has a permission grant')
      }
      if (!(await this.isExecutor(sessionId))) throw new Error('new executor session is not available: ' + sessionId)
      const agent = await this.resolveAgent(sessionId)
      const before = this.readCurrent(agent)
      const escalated = escalationFields(before, grant.after.sandboxMode, grant.after.approvalPolicy)
      if (isPermanentGrant(grant) && (escalated.sandboxMode || escalated.approvalPolicy)) throw new Error('permanent downgrade cannot become an escalation on a new executor')
      const applications = this.applicationsFor(grant).map(item => ({ ...item }))
      for (const application of applications) {
        if (application.status === 'restored') continue
        try {
          await this.restoreApplication(application)
          application.status = 'restored'
        } catch (error) {
          application.lastError = String(error && error.message || error)
          this.audit({ event: 'grant/move_restore_pending', grantId, ticketId, sessionId: application.sessionId, error: application.lastError })
        }
      }
      this.store.updateGrant(grantId, { applications })
      // Keep the original deadline: migration must never renew user authorization.
      if (ticket.status !== 'working' || String(ticket.executor) !== sessionId
        || (grant.expiresAt !== null && grant.expiresAt <= Date.now())) throw new Error('ticket/grant changed during migration')
      const application = { sessionId, before, after: grant.after, escalated, status: 'active' }
      applications.push(application)
      const oldSessionId = grant.sessionId
      this.store.updateGrant(grantId, { applications, sessionId, before, escalated,
        scopeKey: 'ticket:' + ticketId, lastError: null })
      try { this.applyFields(agent, grant) } catch (error) {
        this.store.updateGrant(grantId, { status: 'restore_failed', lastError: String(error && error.message || error) })
        this.armRetry(grantId)
        throw error
      }
      this.audit({ event: 'grant/moved', grantId, ticketId, oldSessionId, sessionId, expiresAt: grant.expiresAt, scopeKey: grant.scopeKey })
      this.armTimer(grant)
      return publicGrant(grant)
    })()
    this.migrations.set(grantId, operation)
    try { return await operation } catch (error) {
      if (this.migrations.get(grantId) === operation) this.migrations.delete(grantId)
      const grant = this.store.grant(grantId)
      if (grant && grant.status === 'restore_failed') await this.restore(grantId, 'apply-failed')
      throw error
    } finally { if (this.migrations.get(grantId) === operation) this.migrations.delete(grantId) }
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
        if (ticket && ticket.status === 'working' && String(ticket.executor) !== grant.sessionId) await this.moveToExecutor(grant.grantId, String(ticket.executor))
        this.armTimer(grant)
      }
    }
  }

  async onTicketChanged(ticket) {
    if (!ticket) return []
    if (ticket.status === 'working') {
      const moved = []
      for (const grant of this.activeForTicket(ticket.ticketId)) {
        if (grant.sessionId !== String(ticket.executor)) moved.push(await this.moveToExecutor(grant.grantId, String(ticket.executor)))
      }
      return moved
    }
    if (!['done', 'failed', 'cancelled'].includes(ticket.status)) return []
    const id = ticket.ticketId
    const grants = this.store.grants().filter(item => (item.ticketId || item.taskId) === id && item.status !== 'restored' && !isPermanentGrant(item))
    for (const grant of grants) {
      await this.restore(grant.grantId, ticket.status === 'done' ? 'ticket-done' : 'ticket-cancelled')
    }
  }

  async restore(grantId, trigger) {
    const migration = this.migrations.get(grantId)
    if (migration) { try { await migration } catch { /* restore partially applied migrations too */ } }
    if (this.restoring.has(grantId)) return { grantId, restored: false, skipped: [], busy: true }
    const grant = this.store.grant(grantId)
    if (!grant || grant.status === 'restored') return { grantId, restored: false, skipped: [], missing: true }
    this.restoring.add(grantId)
    this.clearTimers(grantId)
    const restored = []
    const skipped = []
    const errors = []
    const applications = this.applicationsFor(grant).map(item => ({ ...item }))
    const restoreAll = trigger === 'explicit-reset' || trigger === 'apply-failed'
    for (const application of applications) {
      if (application.status === 'restored') continue
      try {
        const result = await this.restoreApplication(application, restoreAll)
        restored.push(...result.restored)
        skipped.push(...result.skipped)
        application.status = 'restored'
        application.lastError = null
      } catch (error) {
        application.lastError = String(error && error.message || error)
        errors.push(application.sessionId + ': ' + application.lastError)
      }
    }
    if (errors.length) {
      const message = errors.join('; ')
      this.store.updateGrant(grantId, { applications, status: 'restore_failed', lastError: message })
      this.audit({ event: 'grant/restore_failed', grantId, ticketId: grant.ticketId || grant.taskId, trigger, error: message })
      this.armRetry(grantId)
      this.restoring.delete(grantId)
      return { grantId, restored: false, skipped, error: message }
    }
    this.store.removeGrant(grantId)
    this.audit({ event: 'grant/restored', grantId, ticketId: grant.ticketId || grant.taskId || null,
      sessionId: grant.sessionId, kind: grant.kind || 'temporary', trigger, restored, skipped })
    this.restoring.delete(grantId)
    return { grantId, restored: true, restoredFields: [...new Set(restored)], skippedFields: [...new Set(skipped)] }
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
