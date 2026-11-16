// Observes worker approval requests and, when enabled, answers low-risk ones
// directly and relays the rest to Ria.
//
// The host gives an approval listener only the tool name and reason; the
// arguments are cached from tools/pre-execute. In automation mode a low-risk
// request returns allowed-once without waking Ria, a hard-denied request
// returns rejected, and everything else blocks the ticket, wakes Ria, and
// waits for ria_approval_decision. A missing decision fails closed.

import { randomUUID } from 'node:crypto'
import { approvalArgsDigest, approvalArgsPreview, classifyApproval } from './approval-policy.mjs'

export const APPROVAL_TTL_MS = 15 * 60_000
export const APPROVAL_DECISION_TTL_MS = 2 * 60_000
const ARGUMENT_TTL_MS = 10 * 60_000
const ARGUMENT_MAX = 500

const newApprovalId = at => 'apr_' + Number(at).toString(36) + '_' + randomUUID().replace(/-/g, '').slice(0, 10)

export function publicApproval(record) {
  const item = {
    approvalId: record.approvalId,
    workerSessionId: record.workerSessionId,
    ticketId: record.ticketId,
    toolName: record.toolName,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
  }
  if (record.callId !== undefined) item.callId = record.callId
  if (record.reason !== undefined) item.reason = record.reason
  if (record.risk !== undefined) item.risk = record.risk
  if (record.argsDigest !== undefined) item.argsDigest = record.argsDigest
  if (record.argsPreview !== undefined) item.argsPreview = record.argsPreview
  if (record.decisionBy !== undefined) item.decisionBy = record.decisionBy
  else item.decisionBy = 'pending'
  return item
}

/**
 * The one-line question stored on the blocked ticket and sent to the user.
 * With automation on, it says Ria is deciding; with it off, the original
 * "Ria cannot decide for you" wording is preserved.
 */
export function approvalQuestion(record, mode = 'asked') {
  const reason = record.reason ? record.reason : '未说明'
  if (record.automation && mode === 'asked') {
    return '「' + record.workerSessionId + '」正在等待权限审批：' + record.toolName + '（' + reason + '）。Ria 正在判断，2 分钟内未决定将按拒绝处理。'
  }
  return '「' + record.workerSessionId + '」正在等待权限审批：' + record.toolName + '（' + reason + '）。请打开该会话允许或拒绝，Ria 不能代你决定。'
}

function approvalAttention(record) {
  return {
    kind: 'approval',
    question: approvalQuestion(record),
    askedBy: 'worker',
    ref: record.approvalId,
  }
}

export class ApprovalObserver {
  constructor({
    ctx,
    store,
    log = () => {},
    ttlMs = APPROVAL_TTL_MS,
    now = () => Date.now(),
    notify = () => {},
    automationEnabled = () => false,
    classify = classifyApproval,
    decisionTtlMs = APPROVAL_DECISION_TTL_MS,
    wake = async () => {},
    audit = async () => true,
    contextFor = async () => ({}),
  }) {
    this.ctx = ctx
    this.store = store
    this.log = log
    this.ttlMs = ttlMs
    this.decisionTtlMs = decisionTtlMs
    this.now = now
    this.notify = notify
    this.automationEnabled = automationEnabled
    this.classify = classify
    this.wake = wake
    this.audit = audit
    this.contextFor = contextFor
    this.pending = new Map()
    this.arguments = new Map()
    this.disposers = []
  }

  subscribe() {
    const disposeArguments = this.ctx.on('tools/pre-execute', async (exec, next) => {
      this.rememberArguments(exec)
      return await next()
    })
    const disposeResults = this.ctx.on('tools/result', exec => {
      this.forgetArguments(exec)
    })
    const disposeApproval = this.ctx.on('approval/request', async (request, next) => {
      const captured = this.capture(request)
      if (!captured) return await next()
      const { record, ticket } = captured
      const automation = Boolean(this.automationEnabled())
      record.automation = automation
      const ttl = automation ? this.decisionTtlMs : this.ttlMs
      record.expiresAt = record.createdAt + ttl

      if (!automation) {
        this.enterApproval(record, ticket)
        this.startTracking(record, request.signal, true)
        this.notifySafely(record, 'asked')
        try {
          return await next()
        } finally {
          this.clear(record.approvalId, 'resolved')
        }
      }
      try {
        return await this.automated(record, ticket, request, next)
      } finally {
        this.clear(record.approvalId, 'resolved')
      }
    })
    this.disposers = [disposeArguments, disposeResults, disposeApproval]
    return () => {
      for (const dispose of this.disposers.splice(0).reverse()) {
        try { dispose() } catch { /* already removed */ }
      }
    }
  }

  rememberArguments(exec) {
    const agent = exec && exec.agent
    const workerSessionId = agent && agent.id !== undefined ? String(agent.id) : ''
    const callId = exec && exec.callId !== undefined ? String(exec.callId) : ''
    if (!workerSessionId || !callId) return
    const at = this.now()
    this.pruneArguments(at)
    this.arguments.set(workerSessionId + '|' + callId, {
      toolName: String(exec.name || 'unknown'),
      args: exec.arguments,
      argsDigest: approvalArgsDigest(exec.arguments),
      argsPreview: approvalArgsPreview(exec.arguments),
      at,
    })
    if (this.arguments.size > ARGUMENT_MAX) {
      const oldest = [...this.arguments.entries()].sort((a, b) => a[1].at - b[1].at).slice(0, this.arguments.size - ARGUMENT_MAX)
      for (const [key] of oldest) this.arguments.delete(key)
    }
  }

  pruneArguments(at = this.now()) {
    for (const [key, value] of [...this.arguments]) {
      if (at - value.at > ARGUMENT_TTL_MS) this.arguments.delete(key)
    }
  }

  forgetArguments(exec) {
    const agent = exec && exec.agent
    const workerSessionId = agent && agent.id !== undefined ? String(agent.id) : ''
    const callId = exec && exec.callId !== undefined ? String(exec.callId) : ''
    if (workerSessionId && callId) this.arguments.delete(workerSessionId + '|' + callId)
  }

  argumentsFor(workerSessionId, callId) {
    if (!workerSessionId || !callId) return undefined
    return this.arguments.get(String(workerSessionId) + '|' + String(callId))
  }

  capture(request) {
    const agent = request && request.agent
    const workerSessionId = agent && agent.id !== undefined ? String(agent.id) : ''
    if (!workerSessionId) return undefined
    if (workerSessionId === this.store.riaSessionId) return undefined
    const ticket = this.store.activeTickets().find(item => String(item.executor) === workerSessionId)
    if (!ticket) return undefined
    if (request.signal && request.signal.aborted) return undefined

    const createdAt = this.now()
    const record = {
      approvalId: newApprovalId(createdAt),
      workerSessionId,
      ticketId: ticket.ticketId,
      toolName: String(request.toolName || 'unknown'),
      createdAt,
      expiresAt: createdAt + this.ttlMs,
      automation: false,
      decisionBy: 'pending',
    }
    if (request.callId !== undefined) record.callId = String(request.callId)
    if (typeof request.reason === 'string' && request.reason) record.reason = request.reason
    const cached = this.argumentsFor(workerSessionId, record.callId)
    if (cached) {
      record.args = cached.args
      record.argsDigest = cached.argsDigest
      record.argsPreview = cached.argsPreview
    } else {
      // Without cached arguments no rule can tell a read from a delete, so the
      // request is treated as high risk and can only be relayed or denied.
      record.argsUnknown = true
    }
    return { record, ticket }
  }

  async automated(record, ticket, request, next) {
    let classification
    try {
      let cwd = ''
      try {
        const context = await this.contextFor(record.workerSessionId)
        cwd = context && typeof context.cwd === 'string' ? context.cwd : ''
      } catch (error) {
        this.log('warn', 'could not read workspace for approval ' + record.approvalId + ': ' + String(error && error.message ? error.message : error))
      }
      classification = record.argsUnknown
        ? { risk: 'high', auto: 'relay', allowable: false, reasons: ['参数不可用'], summary: '参数不可用，按高风险处理' }
        : await this.classify({ toolName: record.toolName, args: record.args, cwd })
    } catch (error) {
      this.log('warn', 'approval classification failed for ' + record.approvalId + ': ' + String(error && error.message ? error.message : error))
      classification = { risk: 'high', auto: 'relay', allowable: false, reasons: ['分类失败'], summary: '分类失败，按高风险处理' }
    }
    record.classification = classification
    record.risk = classification.risk

    if (classification.auto === 'allow') {
      const audited = await this.auditDecision(record, {
        actor: 'system',
        decision: 'allow',
        outcome: 'allowed-once',
        basis: 'low risk: ' + (classification.summary || 'rule'),
      })
      if (audited) return 'allowed-once'
      this.notifySafely(record, 'decision', { decision: 'deny', reason: '审计写入失败，按拒绝处理' })
      return 'rejected'
    }

    if (classification.auto === 'deny') {
      await this.auditDecision(record, {
        actor: 'system',
        decision: 'deny',
        outcome: 'rejected',
        basis: classification.summary || 'hard deny',
      })
      this.notifySafely(record, 'decision', { decision: 'deny', reason: '命中硬拒绝规则' })
      return 'rejected'
    }

    this.enterApproval(record, ticket)
    this.startTracking(record, request.signal, false)
    this.notifySafely(record, 'asked', { classification })

    try {
      await this.wake(record, ticket, classification)
    } catch (error) {
      const message = String(error && error.message ? error.message : error)
      this.log('warn', 'could not wake Ria for approval ' + record.approvalId + ': ' + message)
      await this.auditDecision(record, {
        actor: 'system',
        decision: 'deny',
        outcome: 'rejected',
        basis: 'wake failed: ' + message,
      })
      this.notifySafely(record, 'decision', { decision: 'deny', reason: '唤醒 Ria 失败，按拒绝处理' })
      return 'rejected'
    }

    const choice = await record.decisionPromise
    record.decisionBy = choice.actor || 'ria'
    if (choice.decision === 'allow') {
      const audited = await this.auditDecision(record, {
        actor: 'ria',
        decision: 'allow',
        outcome: 'allowed-once',
        basis: choice.reason || classification.summary,
      })
      if (!audited) {
        this.notifySafely(record, 'decision', { decision: 'deny', reason: '审计写入失败，按拒绝处理' })
        return 'rejected'
      }
      this.notifySafely(record, 'decision', { decision: 'allow', reason: choice.reason })
      return 'allowed-once'
    }
    if (choice.decision === 'deny') {
      await this.auditDecision(record, {
        actor: 'ria',
        decision: 'deny',
        outcome: 'rejected',
        basis: choice.reason || 'Ria denied',
      })
      this.notifySafely(record, 'decision', { decision: 'deny', reason: choice.reason })
      return 'rejected'
    }
    if (choice.decision === 'ask-user') {
      this.notifySafely(record, 'decision', { decision: 'ask-user', reason: choice.reason })
      let outcome
      let uiError = ''
      try {
        outcome = await next()
      } catch (error) {
        uiError = String(error && error.message ? error.message : error)
        this.log('warn', 'approval UI failed for ' + record.approvalId + ': ' + uiError)
        outcome = 'unavailable'
      }
      if (outcome !== 'allowed-once' && outcome !== 'rejected' && outcome !== 'cancelled') {
        await this.auditDecision(record, {
          actor: 'system',
          decision: 'deny',
          outcome: 'rejected',
          basis: uiError ? 'user relay failed: ' + uiError : 'no user approval surface available',
        })
        this.notifySafely(record, 'final', { decision: 'deny', reason: '没有可用的审批界面，按拒绝处理' })
        return 'rejected'
      }
      const finalDecision = outcome === 'allowed-once' ? 'allow' : 'deny'
      const audited = await this.auditDecision(record, {
        actor: outcome === 'cancelled' ? 'system' : 'user',
        decision: outcome === 'cancelled' ? 'deny' : finalDecision,
        outcome: String(outcome),
        basis: outcome === 'cancelled' ? 'user approval UI cancelled' : 'relayed to the user',
      })
      if (!audited && outcome === 'allowed-once') {
        this.notifySafely(record, 'final', { decision: 'deny', reason: '审计写入失败，按拒绝处理' })
        return 'rejected'
      }
      if (outcome === 'allowed-once' || outcome === 'rejected') {
        this.notifySafely(record, 'final', { decision: finalDecision, reason: '用户已决定' })
      }
      return outcome
    }
    if (choice.decision === 'timeout') {
      await this.auditDecision(record, {
        actor: 'system',
        decision: 'deny',
        outcome: 'rejected',
        basis: '2 minute decision timeout',
      })
      this.notifySafely(record, 'decision', { decision: 'timeout' })
      return 'rejected'
    }
    if (choice.decision === 'abort' || choice.decision === 'cancel') {
      await this.auditDecision(record, {
        actor: 'system',
        decision: 'deny',
        outcome: 'cancelled',
        basis: choice.decision === 'abort' ? 'worker aborted' : 'observer shutdown',
      })
      return 'cancelled'
    }
    await this.auditDecision(record, {
      actor: choice.actor || 'ria',
      decision: 'deny',
      outcome: 'unavailable',
      basis: 'unknown decision ' + String(choice.decision),
    })
    return 'unavailable'
  }

  startTracking(record, signal, autoClear) {
    record.settled = false
    record.decisionPromise = new Promise(resolve => { record.resolveDecision = resolve })
    const ttl = Math.max(1, record.expiresAt - this.now())
    const timer = setTimeout(() => {
      this.settle(record, { decision: 'timeout', actor: 'system' })
      if (autoClear) this.clear(record.approvalId, 'timeout')
    }, ttl)
    if (timer.unref) timer.unref()
    const onAbort = () => {
      this.settle(record, { decision: 'abort', actor: 'system' })
      if (autoClear) this.clear(record.approvalId, 'aborted')
    }
    if (signal) signal.addEventListener('abort', onAbort, { once: true })
    this.pending.set(record.approvalId, { record, timer, signal, onAbort })
  }

  settle(record, choice) {
    if (!record || record.settled) return false
    if (!this.pending.has(record.approvalId)) return false
    record.settled = true
    record.decision = choice
    try { record.resolveDecision(choice) } catch { /* already resolved */ }
    return true
  }

  decision(approvalId, decision, reason) {
    const item = this.pending.get(String(approvalId))
    if (!item) return { ok: false, code: 'approval_not_found' }
    const record = item.record
    if (!record.automation) return { ok: false, code: 'approval_automation_disabled' }
    if (record.settled) return { ok: false, code: 'approval_already_decided' }
    if (record.expiresAt <= this.now()) {
      this.settle(record, { decision: 'timeout', actor: 'system' })
      return { ok: false, code: 'approval_expired' }
    }
    if (!['allow', 'deny', 'ask-user'].includes(decision)) {
      return { ok: false, code: 'decision_invalid' }
    }
    if (decision === 'allow' && record.classification && record.classification.allowable === false) {
      return {
        ok: false,
        code: 'risk_requires_user',
        message: '这是高风险请求，只能 ask-user 或 deny；不能用 allow 放行。',
      }
    }
    this.settle(record, { decision, reason, actor: 'ria' })
    return { ok: true, approvalId: record.approvalId, decision, status: 'recorded' }
  }

  async auditDecision(record, { actor, decision, outcome, basis }) {
    const event = {
      event: 'approval/decision',
      actor,
      approvalId: record.approvalId,
      ticketId: record.ticketId,
      workerSessionId: record.workerSessionId,
      toolName: record.toolName,
      argsDigest: record.argsDigest || '',
      argsPreview: record.argsPreview || '',
      risk: record.risk || '',
      basis: basis || '',
      decision,
      outcome,
      automation: Boolean(record.automation),
    }
    try {
      const result = await this.audit(event)
      return result !== false
    } catch (error) {
      this.log('warn', 'could not write approval audit for ' + record.approvalId + ': ' + String(error && error.message ? error.message : error))
      return false
    }
  }

  notifySafely(record, event, extra) {
    try {
      const result = this.notify(record, event, extra)
      if (result && typeof result.catch === 'function') result.catch(error => {
        this.log('warn', 'could not notify about approval ' + record.approvalId + ': ' + String(error && error.message ? error.message : error))
      })
    } catch (error) {
      this.log('warn', 'could not notify about approval ' + record.approvalId + ': ' + String(error && error.message ? error.message : error))
    }
  }

  /**
   * Mark the active ticket as blocked on this approval. A ticket that is
   * already blocked on another approval is left alone; its attention still
   * points at the first pending request.
   */
  enterApproval(record, fallbackTicket) {
    if (!this.store || typeof this.store.transitionTicket !== 'function') return fallbackTicket
    const ticket = this.ticketFor(record.ticketId) || fallbackTicket
    if (!ticket) return undefined
    if (ticket.status === 'blocked' && ticket.waitingOn === 'approval') return ticket
    if (!['open', 'working'].includes(ticket.status)) return ticket
    const moved = this.store.transitionTicket(ticket.ticketId, 'blocked', {
      actor: 'system',
      reason: 'worker approval requested',
      waitingOn: 'approval',
      blockedReason: approvalQuestion(record),
      attention: approvalAttention(record),
    })
    if (moved && moved.ok === false) {
      this.log('warn', 'could not mark ticket ' + ticket.ticketId + ' blocked on approval: ' + moved.message)
      return ticket
    }
    return (moved && moved.ticket) || this.ticketFor(ticket.ticketId) || ticket
  }

  clear(approvalId, resolution = 'resolved') {
    const item = this.pending.get(approvalId)
    if (!item) return
    if (!item.record.settled) this.settle(item.record, { decision: 'cancel', actor: 'system' })
    this.pending.delete(approvalId)
    clearTimeout(item.timer)
    if (item.signal && item.onAbort) item.signal.removeEventListener('abort', item.onAbort)
    this.releaseTicket(item.record, resolution)
  }

  /**
   * Restore the ticket after the approval is decided, aborted, expired, or the
   * host shuts down. Multiple approvals for one ticket wait for the last one,
   * then go blocked -> open -> working because the ticket state machine has no
   * direct blocked -> working edge.
   */
  releaseTicket(record, resolution) {
    if (!this.store || typeof this.store.transitionTicket !== 'function') return
    const ticket = this.ticketFor(record.ticketId)
    if (!ticket || ticket.status !== 'blocked' || ticket.waitingOn !== 'approval') return
    const remaining = [...this.pending.values()].filter(item => item.record.ticketId === record.ticketId)
    const attentionRef = ticket.attention && ticket.attention.ref
    if (remaining.length > 0) {
      // Hand the visible attention to the next pending approval instead of
      // clearing it while the worker is still stuck.
      if (!attentionRef || attentionRef === record.approvalId) {
        const next = remaining[0].record
        if (typeof this.store.updateTicket === 'function') {
          try {
            this.store.updateTicket(ticket.ticketId, { attention: approvalAttention(next) })
          } catch (error) {
            this.log('warn', 'could not move approval attention on ' + ticket.ticketId + ': ' + String(error && error.message ? error.message : error))
          }
        }
      }
      return
    }
    if (attentionRef && attentionRef !== record.approvalId) return
    const reason = 'worker approval resolved (' + resolution + ')'
    const opened = this.store.transitionTicket(ticket.ticketId, 'open', { actor: 'system', reason })
    if (!opened || opened.ok === false) {
      this.log('warn', 'could not reopen ticket ' + ticket.ticketId + ' after approval: ' + String(opened && opened.message ? opened.message : 'unknown error'))
      return
    }
    const attempt = opened.ticket && opened.ticket.attempt
    const options = { actor: 'system', reason, waitingOn: 'worker' }
    if (!attempt || !attempt.lastRequestId) options.attempt = { legacy: true }
    const working = this.store.transitionTicket(ticket.ticketId, 'working', options)
    if (!working || working.ok === false) {
      this.log('warn', 'could not return ticket ' + ticket.ticketId + ' to working after approval: ' + String(working && working.message ? working.message : 'unknown error'))
    }
  }

  ticketFor(ticketId) {
    if (this.store && typeof this.store.ticket === 'function') {
      const ticket = this.store.ticket(ticketId)
      if (ticket) return ticket
    }
    if (this.store && typeof this.store.activeTickets === 'function') {
      return this.store.activeTickets().find(item => item.ticketId === ticketId)
    }
    return undefined
  }

  list() {
    const at = this.now()
    for (const [id, item] of [...this.pending]) {
      if (item.record.settled) continue
      if (item.record.expiresAt <= at) this.settle(item.record, { decision: 'timeout', actor: 'system' })
    }
    return [...this.pending.values()]
      .filter(item => !item.record.settled)
      .map(item => publicApproval(item.record))
      .sort((a, b) => a.createdAt - b.createdAt || a.approvalId.localeCompare(b.approvalId))
  }

  shutdown() {
    for (const id of [...this.pending.keys()]) this.clear(id, 'shutdown')
  }
}
