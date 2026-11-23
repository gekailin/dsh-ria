import { isAbsolute, join, resolve } from 'node:path'
import { PTC_TRANSPORTS, classify as classifyRisk, decideEscalation, mergeRiskLevels, parseTransportCall, resolveEscalationPolicy } from './risk.mjs'
import { clipText, now, redactSecrets, text } from './shared.mjs'
import { WorkerPool } from './worker-pool.mjs'

// Approval state machine moved verbatim from controller.mjs. The class only
// holds the methods: every field they touch stays initialized by Controller,
// so this is a pure relocation with unchanged semantics.

// Host approval outcomes that resume the Worker. Everything else (rejected,
// cancelled, unavailable) keeps the ticket parked with a durable reason.
const ALLOWED_APPROVAL_OUTCOMES = new Set(['allowed-once', 'allowed', 'approved'])

// Human-readable approval time for blockedReason. Asia/Shanghai has no DST, so
// a fixed +08:00 shift is exact.
function clockText(ms) {
  const shifted = new Date((Number.isFinite(ms) ? ms : Date.now()) + 8 * 60 * 60 * 1000)
  const pad = value => String(value).padStart(2, '0')
  return pad(shifted.getUTCHours()) + ':' + pad(shifted.getUTCMinutes()) + ':' + pad(shifted.getUTCSeconds()) + ' +08:00'
}

export class ApprovalCoordinator extends WorkerPool {
  /**
   * Approval audit events drive ticket state, so a Worker parked on a human
   * decision is visible as blocked(waitingOn=approval) instead of silently
   * "working". Both events are session events; nothing here schedules work.
   */
  trackApprovalTicket(sessionId, event) {
    if (event.type === 'approval/asked') {
      this.onApprovalAsked(sessionId, event)
      return
    }
    if (event.type === 'approval/decided') {
      this.onApprovalDecided(sessionId, event)
      return
    }
    if (event.type === 'turn/end') this.clearApprovalsForSession(sessionId)
  }

  onApprovalAsked(sessionId, event) {
    const data = event.data || {}
    const approvalId = text(data.id)
    if (!approvalId) return
    const toolName = text(data.toolName) || 'unknown'
    const terminal = this.approvalTerminals.get(approvalId) || this.approvalTerminals.get(this.approvalKey(sessionId, toolName, text(data.callId)))
    if (terminal && terminal.decision === 'superseded') return
    const reason = text(data.reason) || '未说明'
    // Only managed Workers on tickets participate in risk decisions; ordinary
    // sessions keep the read-only notice path in noticeApproval().
    if (this.roleFor(sessionId) !== 'worker') return
    // The host appends approval/asked before the approval/request waterfall, so
    // the risk decision is available here. Auto-allowed calls must not park the
    // ticket; everything else blocks with the risk explanation in the reason.
    const decision = this.evaluateApprovalRisk(sessionId, toolName, text(data.callId))
    this.auditApprovalRisk(decision)
    this.rememberAskedApproval(approvalId, decision)
    this.routerEvent({
      event: 'approval.asked',
      ticketId: decision.ticketId,
      sessionId,
      actor: 'router',
      reason: 'worker approval requested',
      payload: {
        approvalId,
        toolName,
        reason,
        callId: text(data.callId),
        riskLevel: decision.risk.level,
        decision: decision.decision,
        policy: decision.policy,
        policySource: decision.policySource,
        transport: decision.risk.signals ? decision.risk.signals.transport || null : null,
        innerCommands: decision.risk.signals && Array.isArray(decision.risk.signals.innerCommands)
          ? decision.risk.signals.innerCommands.slice(0, 3)
          : [],
      },
    })
    if (decision.decision === 'auto-allow') return
    const ticket = this.workingTicketFor(sessionId)
    if (!ticket) return
    const askedAt = Number.isFinite(event.time) ? event.time : now()
    const risk = this.approvalRiskLabel(decision)
    const toolLabel = this.approvalToolDisplay(decision)
    const blockedReason = '[' + risk.text + '] 等待审批：工具 ' + toolLabel + '（' + reason + '），策略 ' + decision.policy + '（' + decision.policySource + '），请求于 ' + clockText(askedAt)
    const moved = this.service.tickets.transitionTicket(ticket.ticketId, 'blocked', {
      actor: 'router',
      executor: sessionId,
      waitingOn: 'approval',
      blockedReason,
      attention: { kind: 'approval', question: blockedReason, ref: approvalId },
      reason: 'worker approval wait',
    })
    if (!moved.ok) {
      this.log('warn', 'could not block ' + ticket.ticketId + ' on approval ' + approvalId + ': ' + moved.code + ' ' + moved.message)
      return
    }
    this.rememberPendingApproval(approvalId, {
      ticketId: ticket.ticketId,
      sessionId,
      toolName,
      reason,
      askedAt,
      callId: text(data.callId),
      key: decision.key,
      risk: decision.risk,
      riskLabel: risk,
      policy: decision.policy,
      policySource: decision.policySource,
      decision: 'ask',
    })
    // Keep the live waterfall settleable by a later grant. The deferred is
    // created now so a grant arriving between asked and request still wins.
    this.createApprovalSettler(sessionId, toolName, text(data.callId), approvalId, this.pendingApprovals.get(approvalId))
    this.state.setTicketMeta(ticket.ticketId, { phase: 'blocked' })
    // The Worker keeps running (it is only waiting), so currentTicketId stays.
    // The blocked transition is the single notice edge; do not send here.
  }

  onApprovalDecided(sessionId, event) {
    // Only managed Workers participate in the dispatch/approval event stream;
    // ordinary sessions keep their separate read-only notice path.
    if (this.roleFor(sessionId) !== 'worker') return
    const data = event.data || {}
    const approvalId = text(data.id)
    const outcome = text(data.outcome)
    const record = approvalId ? this.pendingApprovals.get(approvalId) : null
    const terminal = (approvalId && this.approvalTerminals.get(approvalId))
      || (record && record.callId && this.approvalTerminals.get(record.callId))
      || (record && record.terminal ? { decision: record.terminal } : null)
    if (terminal && (terminal.decision === 'superseded' || !ALLOWED_APPROVAL_OUTCOMES.has(outcome))) {
      if (approvalId) this.pendingApprovals.delete(approvalId)
      if (approvalId) this.approvalAskedRisks.delete(approvalId)
      this.closeApprovalSettlersFor(sessionId, approvalId, record && record.callId)
      if (record && record.key) this.approvalRisks.delete(record.key)
      this.log('info', 'ignored late approval ' + outcome + ' for terminal ' + (approvalId || (record && record.callId) || 'approval') + ' (' + terminal.decision + ')')
      return
    }
    if (record && record.ticketId && this.completedReportFor(record.ticketId, record.sessionId)) {
      this.supersedeApproval(approvalId, record, { reason: 'saved done report supersedes late approval outcome', outcome: 'rejected' })
      this.supersedeTicketApprovals(record.ticketId, { reason: 'saved completion supersedes pending approvals', outcome: 'rejected' })
      this.resumeAfterApproval(record.ticketId, 'saved completion wins over late approval')
      void this.finalizeSavedDone(record.ticketId).catch(error => this.log('warn', 'could not finalize saved done: ' + String(error)))
      return
    }
    if (approvalId && !terminal && ALLOWED_APPROVAL_OUTCOMES.has(outcome)) {
      this.rememberApprovalTerminal(approvalId, { decision: 'allowed', at: now() })
    }
    if (approvalId) this.pendingApprovals.delete(approvalId)
    const askedDecision = approvalId ? this.approvalAskedRisks.get(approvalId) : null
    if (approvalId) this.approvalAskedRisks.delete(approvalId)
    this.closeApprovalSettlersFor(sessionId, approvalId, record && record.callId)
    const grantApplied = Boolean(record && record.grantId && !record.grantUnresolved && ALLOWED_APPROVAL_OUTCOMES.has(outcome))
    // A grant already wrote the auto-allow/grant-applied audit line; do not
    // relabel the same decision as a human approval.
    if (!grantApplied) this.auditHumanApproval(record, sessionId, approvalId, outcome)
    if (record && record.key) this.approvalRisks.delete(record.key)
    const ticketId = record ? record.ticketId : this.approvalBlockedTicketFor(sessionId)
    const decidedRisk = record && record.risk ? record.risk : (askedDecision ? askedDecision.risk : null)
    const auto = (askedDecision && askedDecision.decision === 'auto-allow') || grantApplied
    const decision = auto
      ? 'auto-allow'
      : (ALLOWED_APPROVAL_OUTCOMES.has(outcome) ? 'human-allow' : (outcome === 'rejected' ? 'human-deny' : 'human-cancel'))
    this.routerEvent({
      event: 'approval.decided',
      ticketId: record && record.ticketId ? record.ticketId : (askedDecision && askedDecision.ticketId ? askedDecision.ticketId : (ticketId || null)),
      sessionId,
      actor: 'router',
      reason: 'approval outcome',
      payload: {
        approvalId,
        outcome,
        decision,
        riskLevel: decidedRisk ? decidedRisk.level : 'unknown',
        toolName: record && record.toolName ? record.toolName : (askedDecision ? askedDecision.toolName : ''),
        callId: record && record.callId ? record.callId : (askedDecision ? askedDecision.callId : ''),
      },
    })
    if (!ticketId) return
    const ticket = this.service.tickets.ticket(ticketId)
    if (!ticket || ticket.status !== 'blocked' || ticket.waitingOn !== 'approval') return
    if (this.completedReportFor(ticketId, ticket.executor)) {
      this.supersedeTicketApprovals(ticketId, { reason: 'saved done report supersedes late approval outcome', outcome: 'rejected' })
      this.resumeAfterApproval(ticketId, 'saved completion wins over late approval')
      void this.finalizeSavedDone(ticketId).catch(error => this.log('warn', 'could not finalize saved done: ' + String(error)))
      return
    }
    if (ALLOWED_APPROVAL_OUTCOMES.has(outcome)) {
      const executor = String(ticket.executor || sessionId)
      // The state machine has no blocked -> working edge; reopen first.
      const reopened = this.service.tickets.transitionTicket(ticketId, 'open', {
        actor: 'router',
        executor,
        waitingOn: 'ria',
        // A grant resets the parked state, including an earlier denial record.
        failure: null,
        reason: 'approval granted',
      })
      if (!reopened.ok) {
        this.log('warn', 'could not reopen ' + ticketId + ' after approval: ' + reopened.code + ' ' + reopened.message)
        return
      }
      const working = this.service.tickets.transitionTicket(ticketId, 'working', {
        actor: 'router',
        executor,
        waitingOn: 'worker',
        reason: 'approval granted, resume execution',
      })
      if (!working.ok) {
        this.log('warn', 'could not resume ' + ticketId + ' after approval: ' + working.code + ' ' + working.message)
        this.queueChatNotice('ticket ' + ticketId + ' 审批通过，但恢复到 working 失败（' + working.code + '）；请用 ria_chat_resume 处理。')
        return
      }
      this.state.setTicketMeta(ticketId, { phase: 'working', executorId: executor })
      this.state.addWorker(executor, { status: 'working', currentTicketId: ticketId, lastUsedAt: now() }, { trigger: 'approval.resumed' })
      this.queueChatNotice('ticket ' + ticketId + ' 审批通过，已回到 working，Worker 继续执行。')
      return
    }
    const denied = outcome === 'rejected'
    const label = denied ? '拒绝' : (outcome === 'unavailable' ? '无审批人' : '取消')
    const code = denied ? 'approval_denied' : 'approval_cancelled'
    const detail = record ? record.toolName + '：' + record.reason : (outcome || 'unknown')
    const message = '审批被' + label + '（' + detail + '）'
    const attention = ticket.attention && ticket.attention.kind === 'approval'
      ? { ...ticket.attention, question: ticket.attention.question || ticket.blockedReason || message }
      : { kind: 'approval', question: message }
    try {
      this.service.tickets.updateTicket(ticketId, {
        // The ticket stays blocked; only the reason for stopping changes.
        blockedReason: message,
        attention,
        failure: { code, message, at: now() },
      })
    } catch (error) {
      this.log('warn', 'could not record the approval outcome on ' + ticketId + ': ' + String(error && error.message ? error.message : error))
    }
    this.queueChatNotice('ticket ' + ticketId + ' 审批被' + label + '：' + message + '，工单停在 blocked(waitingOn=approval)，可用 ria_chat_resume 重试。')
  }

  /** The ticket this Worker is currently executing, if any. */
  workingTicketFor(sessionId) {
    return this.service.tickets.tickets().find(item =>
      item.status === 'working' && String(item.executor) === String(sessionId)) || null
  }

  /** The ticket this Worker left parked on an approval, if any. */
  approvalBlockedTicketFor(sessionId) {
    const ticket = this.service.tickets.tickets().find(item =>
      item.status === 'blocked' && item.waitingOn === 'approval' && String(item.executor) === String(sessionId))
    return ticket ? ticket.ticketId : ''
  }

  rememberAskedApproval(approvalId, decision) {
    if (!approvalId || !decision) return
    this.approvalAskedRisks.set(approvalId, decision)
    if (this.approvalAskedRisks.size <= 200) return
    const oldest = [...this.approvalAskedRisks.entries()].slice(0, this.approvalAskedRisks.size - 150)
    for (const [key] of oldest) this.approvalAskedRisks.delete(key)
  }

  rememberPendingApproval(approvalId, record) {
    // Bounded without a timer: drop the oldest entries when the map is full.
    if (this.pendingApprovals.size >= 200) {
      const oldest = [...this.pendingApprovals.entries()].sort((left, right) => left[1].askedAt - right[1].askedAt)
      for (const [key] of oldest.slice(0, oldest.length - 150)) this.pendingApprovals.delete(key)
    }
    this.pendingApprovals.set(approvalId, record)
  }

  pendingApprovalFor(sessionId, toolName, callId) {
    const key = this.approvalKey(sessionId, toolName, callId)
    for (const [approvalId, record] of this.pendingApprovals) {
      if (record && record.key === key) return { approvalId, record }
    }
    return null
  }

  createApprovalSettler(sessionId, toolName, callId, approvalId, record) {
    const key = this.approvalKey(sessionId, toolName, callId)
    const existing = this.pendingSettlers.get(key)
    if (existing && !existing.closed) {
      if (!existing.approvalId && approvalId) existing.approvalId = text(approvalId)
      if (!existing.ticketId && record && record.ticketId) existing.ticketId = text(record.ticketId)
      if (!existing.risk && record && record.risk) existing.risk = record.risk
      if (!existing.policy && record && record.policy) existing.policy = record.policy
      if (!existing.policySource && record && record.policySource) existing.policySource = record.policySource
      return existing
    }
    let resolveFn
    const promise = new Promise(resolve => { resolveFn = resolve })
    const entry = {
      key,
      sessionId: String(sessionId),
      toolName,
      callId: text(callId),
      approvalId: text(approvalId),
      ticketId: record ? text(record.ticketId) : text((this.ticketForApproval(sessionId) || {}).ticketId),
      risk: record ? record.risk : null,
      policy: record ? record.policy : '',
      policySource: record ? record.policySource : '',
      requestSignal: null,
      at: now(),
      settled: false,
      closed: false,
      promise,
    }
    entry.settle = value => {
      if (entry.settled || entry.closed) return false
      entry.settled = true
      resolveFn(value)
      return true
    }
    this.pendingSettlers.set(key, entry)
    if (this.pendingSettlers.size > 200) {
      const oldest = [...this.pendingSettlers.entries()].sort((left, right) => left[1].at - right[1].at)
      for (const [oldKey] of oldest.slice(0, this.pendingSettlers.size - 150)) this.pendingSettlers.delete(oldKey)
    }
    return entry
  }

  closeApprovalSettler(entry) {
    if (!entry) return
    entry.closed = true
    if (this.pendingSettlers.get(entry.key) === entry) this.pendingSettlers.delete(entry.key)
  }

  closeApprovalSettlersFor(sessionId, approvalId, callId) {
    const wantedApproval = text(approvalId)
    const wantedCall = text(callId)
    for (const [key, entry] of [...this.pendingSettlers]) {
      if (String(entry.sessionId) !== String(sessionId)) continue
      if (wantedApproval && entry.approvalId && entry.approvalId !== wantedApproval) continue
      if (wantedCall && entry.callId && entry.callId !== wantedCall) continue
      this.closeApprovalSettler(entry)
      this.pendingSettlers.delete(key)
    }
  }

  auditGrantApplied(record, grant, sessionId, approvalId = '') {
    const grantService = this.service && this.service.grants
    if (!grantService || typeof grantService.audit !== 'function') return
    const risk = record && record.risk ? record.risk : null
    const reasons = risk && Array.isArray(risk.reasons) ? risk.reasons.slice() : []
    reasons.push('[grant-applied] 授权已生效，放行此前挂起的审批')
    try {
      grantService.audit({
        event: 'approval/decision',
        decision: 'auto-allow',
        reason: 'grant-applied',
        grantId: grant.grantId,
        approvalId: approvalId || null,
        ticketId: record && record.ticketId ? record.ticketId : null,
        sessionId,
        tool: record && record.toolName ? record.toolName : 'unknown',
        callId: record && record.callId ? record.callId : null,
        level: risk ? risk.level : 'unknown',
        reasons,
        policy: record && record.policy ? record.policy : '',
        policySource: record && record.policySource ? record.policySource : '',
        transport: risk && risk.signals ? risk.signals.transport || null : null,
        kind: 'risk',
      })
    } catch (error) {
      this.log('warn', 'could not audit grant-applied approval: ' + String(error && error.message ? error.message : error))
    }
  }

  /**
   * A successful grant settles every live approval request for that session.
   * Live waterflows use a deferred; a stale pending record without one is
   * cancelled (signal abort) so the Worker can retry instead of waiting out its
   * budget.
   */
  rememberApprovalTerminal(key, value) {
    if (!key) return
    const nowAt = now()
    for (const [id, item] of this.approvalTerminals) {
      if (!item || nowAt - Number(item.at || 0) > 24 * 60 * 60 * 1000) this.approvalTerminals.delete(id)
    }
    this.approvalTerminals.set(String(key), { ...value, at: value && value.at ? value.at : nowAt })
    while (this.approvalTerminals.size > 500) {
      const oldest = [...this.approvalTerminals.entries()].sort((a, b) => (a[1].at || 0) - (b[1].at || 0))[0]
      if (!oldest) break
      this.approvalTerminals.delete(oldest[0])
    }
  }

  recordSuccessfulApprovalOperation(sessionId, data = {}) {
    // Only an explicit successful command/tool result for the matching call is
    // evidence. An unrelated read or grant alone cannot fabricate execution.
    const result = data.result && typeof data.result === 'object' ? data.result : data
    const exitCode = result.exitCode ?? result.exit_code
    if (exitCode !== 0 || result.timedOut || result.aborted || result.error) return
    const callId = text(data.callId) || text(data.toolCallId)
    if (!callId) return
    const affected = new Set()
    for (const [approvalId, record] of [...this.pendingApprovals]) {
      if (record && record.sessionId === sessionId && record.callId === callId) {
        this.supersedeApproval(approvalId, record, { reason: 'matching operation succeeded with exit 0', outcome: 'rejected' })
        if (record.ticketId) affected.add(record.ticketId)
      }
    }
    for (const ticketId of affected) this.resumeAfterApproval(ticketId, 'successful operation superseded stale approval')
  }

  supersedeApproval(approvalId, record, { grantId = null, reason = 'completed operation', outcome = 'rejected' } = {}) {
    if (!record) return null
    const terminal = { decision: 'superseded', status: 'superseded', grantId, ticketId: record.ticketId || null,
      sessionId: record.sessionId, callId: record.callId || '', key: record.key || '', reason, outcome, at: now() }
    for (const key of [approvalId, record.key]) if (key) this.rememberApprovalTerminal(key, terminal)
    if (approvalId) { this.pendingApprovals.delete(approvalId); this.approvalAskedRisks.delete(approvalId) }
    if (record.key) this.approvalRisks.delete(record.key)
    for (const entry of [...this.pendingSettlers.values()]) {
      const sameApproval = approvalId && entry.approvalId === approvalId
      const sameCall = record.key && entry.key === record.key
      if (entry.sessionId !== record.sessionId || (!sameApproval && !sameCall)) continue
      entry.settle(outcome)
      this.closeApprovalSettler(entry)
    }
    const item = { approvalId: approvalId || null, ...terminal }
    if (record.ticketId) {
      const meta = this.state.ticketMeta(record.ticketId)
      const history = Array.isArray(meta.supersededApprovals) ? meta.supersededApprovals : []
      this.state.setTicketMeta(record.ticketId, { supersededApprovals: [...history.filter(old => old.approvalId !== approvalId), item].slice(-100) })
    }
    this.routerEvent({ event: 'approval.superseded', ticketId: record.ticketId || null, sessionId: record.sessionId,
      actor: 'router', reason, payload: { approvalId: approvalId || null, grantId, status: 'superseded', reason, callId: record.callId || '' } })
    return item
  }

  supersedeTicketApprovals(ticketId, options = {}) {
    const items = []
    for (const [approvalId, record] of [...this.pendingApprovals]) {
      if (record && record.ticketId === ticketId) items.push(this.supersedeApproval(approvalId, record, options))
    }
    for (const entry of [...this.pendingSettlers.values()]) {
      if (entry.ticketId === ticketId && !entry.closed) items.push(this.supersedeApproval(entry.approvalId, entry, options))
    }
    return items
  }

  resumeAfterApproval(ticketId, reason) {
    const ticket = this.service.tickets.ticket(ticketId)
    if (!ticket || ticket.status !== 'blocked' || ticket.waitingOn !== 'approval') return ticket
    if ([...this.pendingApprovals.values()].some(record => record && record.ticketId === ticketId)) return ticket
    const executor = String(ticket.executor || '')
    const opened = this.service.tickets.transitionTicket(ticketId, 'open', { actor: 'router', executor, waitingOn: 'ria', failure: null, reason })
    if (!opened.ok) return ticket
    const working = this.service.tickets.transitionTicket(ticketId, 'working', { actor: 'router', executor, waitingOn: 'worker', reason })
    if (working.ok) {
      this.state.setTicketMeta(ticketId, { phase: 'working', executorId: executor })
      if (this.state.worker(executor)) this.state.addWorker(executor, { status: 'working', currentTicketId: ticketId, lastUsedAt: now() }, { trigger: 'approval.superseded' })
    }
    return working.ok ? working.ticket : opened.ticket
  }

  settleApprovalsForGrant(sessionId, grant) {
    // Narrowing access is not permission to supersede an escalation request.
    if (!grant || grant.kind !== 'temporary') return { settled: [], unresolved: [], superseded: [] }
    const ticketId = grant.ticketId || null
    const settled = []
    const superseded = []
    const matches = record => record && (ticketId ? record.ticketId === ticketId : record.sessionId === sessionId)
    for (const [approvalId, record] of [...this.pendingApprovals]) {
      if (!matches(record)) continue
      const live = [...this.pendingSettlers.values()].find(entry => !entry.closed && entry.sessionId === record.sessionId
        && ((approvalId && entry.approvalId === approvalId) || (record.key && entry.key === record.key)))
      const allowed = record.sessionId === sessionId
      if (live && allowed && live.settle('allowed-once')) {
        this.auditGrantApplied(record, grant, sessionId, approvalId)
        settled.push({ approvalId, ticketId: record.ticketId || null, toolName: record.toolName, callId: record.callId })
      }
      superseded.push(this.supersedeApproval(approvalId, record, { grantId: grant.grantId,
        reason: 'ticket grant applied; pending approval superseded', outcome: allowed ? 'allowed-once' : 'rejected' }))
    }
    // Requests may arrive before their asked event. Preserve the terminal by key.
    for (const entry of [...this.pendingSettlers.values()]) {
      if (entry.closed || !matches(entry)) continue
      const record = { ...entry, sessionId: entry.sessionId, key: entry.key }
      const allowed = entry.sessionId === sessionId
      if (allowed && entry.settle('allowed-once')) {
        this.auditGrantApplied(record, grant, sessionId, entry.approvalId)
        settled.push({ approvalId: entry.approvalId || null, ticketId: entry.ticketId || null, toolName: entry.toolName, callId: entry.callId })
      }
      superseded.push(this.supersedeApproval(entry.approvalId, record, { grantId: grant.grantId,
        reason: 'ticket grant applied; pending approval superseded', outcome: allowed ? 'allowed-once' : 'rejected' }))
    }
    for (const id of new Set([ticketId, ...superseded.map(item => item && item.ticketId)].filter(Boolean))) this.resumeAfterApproval(id, 'grant superseded pending approvals')
    return { settled, unresolved: [], superseded }
  }

  clearApprovalsForSession(sessionId) {
    this.closeApprovalSettlersFor(sessionId)
    for (const [id, record] of [...this.pendingApprovals]) {
      if (String(record.sessionId) !== String(sessionId)) continue
      this.pendingApprovals.delete(id)
      if (record.key) this.approvalRisks.delete(record.key)
    }
    for (const [key, record] of [...this.approvalRisks]) {
      if (String(record.sessionId) === String(sessionId)) this.approvalRisks.delete(key)
    }
  }

  clearApprovalsForTicket(ticketId) {
    for (const [id, record] of [...this.pendingApprovals]) {
      if (String(record.ticketId) !== String(ticketId)) continue
      this.pendingApprovals.delete(id)
      if (record.key) this.approvalRisks.delete(record.key)
      this.closeApprovalSettlersFor(record.sessionId, id, record.callId)
    }
  }

  approvalKey(sessionId, toolName, callId) {
    const id = text(callId)
    return id ? 'call:' + sessionId + '|' + id : 'tool:' + sessionId + '|' + text(toolName)
  }

  /** Cache one tool call's arguments; approval/request itself carries no argv. */
  rememberApprovalToolCall(exec) {
    const agent = exec && exec.agent
    const sessionId = agent && agent.id !== undefined ? String(agent.id) : ''
    if (!sessionId) return
    const toolName = text(exec && exec.name) || 'unknown'
    const key = this.approvalKey(sessionId, toolName, exec && exec.callId)
    const args = exec && exec.arguments && typeof exec.arguments === 'object' && !Array.isArray(exec.arguments)
      ? exec.arguments
      : {}
    // PTC transports (run_code) wrap the real command. Parse it once here so the
    // approval decision classifies the inner bash/write, not the transport name.
    const inner = PTC_TRANSPORTS.has(toolName) ? parseTransportCall(toolName, args) : null
    this.approvalToolCalls.set(key, { sessionId, toolName, args, inner, at: now() })
    // A new call must not reuse the previous decision for the same key.
    this.approvalRisks.delete(key)
    // A new execution cannot inherit a prior grant settlement for a reused key.
    this.approvalTerminals.delete(key)
    if (this.approvalToolCalls.size > 200) {
      const oldest = [...this.approvalToolCalls.entries()].sort((left, right) => left[1].at - right[1].at)
      for (const [entry] of oldest.slice(0, this.approvalToolCalls.size - 150)) this.approvalToolCalls.delete(entry)
    }
  }

  forgetApprovalToolCall(exec) {
    const agent = exec && exec.agent
    const sessionId = agent && agent.id !== undefined ? String(agent.id) : ''
    if (!sessionId) return
    const toolName = text(exec && exec.name) || 'unknown'
    this.approvalToolCalls.delete(this.approvalKey(sessionId, toolName, exec && exec.callId))
  }

  /** The ticket a Worker answers for while it asks: working first, then blocked on approval. */
  ticketForApproval(sessionId) {
    const tickets = this.service.tickets.tickets()
    return tickets.find(item => item.status === 'working' && String(item.executor) === String(sessionId))
      || tickets.find(item => item.status === 'blocked' && item.waitingOn === 'approval' && String(item.executor) === String(sessionId))
      || null
  }

  /**
   * Classify a PTC transport (run_code) by its inner bash/write calls. Multiple
   * inner calls take the worst level; reasons always say which inner command
   * the decision was based on.
   */
  classifyTransportRisk(inner, toolName, context = {}) {
    const cwd = context.cwd || ''
    const workspace = context.workspace || cwd
    const justification = context.justification || ''
    const commands = Array.isArray(inner && inner.commands) ? inner.commands : []
    const innerPaths = Array.isArray(inner && inner.paths) ? inner.paths : []
    const calls = Array.isArray(inner && inner.calls) ? inner.calls : []
    const findings = []
    const issues = []
    let complete = Boolean(inner && inner.parsed === true && inner.complete === true)
    if (!complete) issues.push(inner && inner.reason ? inner.reason : '缺少完整的 run_code 内部参数')
    if (!calls.length) { complete = false; issues.push('未提取到完整的内嵌调用') }
    for (const call of calls) {
      // bash workdir is per call; it must never be overwritten by a later call.
      const declared = call.workdir || call.cwd || ''
      const innerCwd = declared
        ? (isAbsolute(declared) ? resolve(declared) : (cwd && isAbsolute(cwd) ? resolve(cwd, declared) : ''))
        : (cwd && isAbsolute(cwd) ? resolve(cwd) : '')
      if (call.toolName === 'bash' && !declared) {
        complete = false
        issues.push('tools.bash 缺少 workdir/cwd，无法确认命令工作目录（候选默认：' + (cwd || '无法获取') + '）')
      }
      if (!innerCwd) {
        complete = false
        issues.push('tools.' + call.toolName + ' 无法确定 workdir/cwd')
      }
      findings.push(classifyRisk({
        toolName: call.toolName,
        args: { command: call.command, paths: call.paths },
        cwd: innerCwd,
        workspace,
        justification: call.justification || justification,
      }))
    }
    const level = complete ? mergeRiskLevels(findings.map(finding => finding.level)) : 'unknown'
    const actual = commands.length ? commands.slice(0, 3) : innerPaths.slice(0, 3).map(path => 'write ' + path)
    const reasons = ['[via-run_code] 经由 run_code，实际命令：' + (actual.join('；') || '无法完整解析')]
    if (!complete) reasons.push('[run_code-inner-missing] 无法解析 run_code 内部命令（' + [...new Set(issues)].join('；') + '）')
    for (const finding of findings) {
      for (const reason of finding.reasons) if (!reasons.includes(reason)) reasons.push(reason)
    }
    const paths = [...new Set([...innerPaths, ...findings.flatMap(finding => finding.signals.paths || [])])]
    const ruleIds = [...new Set([
      ...findings.flatMap(finding => finding.signals.ruleIds || []),
      ...(!complete ? ['run_code-inner-missing'] : []),
    ])]
    const workdirs = [...new Set(findings.map(finding => finding.signals.cwd).filter(Boolean))]
    return {
      level,
      reasons,
      signals: {
        toolName,
        command: commands[0] || (innerPaths[0] ? 'write ' + innerPaths[0] : ''),
        argv: commands.slice(),
        paths,
        cwd: workdirs.length === 1 ? workdirs[0] : cwd,
        workspace,
        workdirs,
        ruleIds,
        transport: toolName,
        sandboxPermissions: inner && inner.sandboxPermissions || null,
        innerCommands: commands.slice(),
        innerPaths: innerPaths.slice(),
        innerCalls: calls,
        complete,
        level,
      },
    }
  }

  /**
   * Evaluate one approval request. Policy priority is ticket meta > global
   * settings > default (auto-low). The result memoises so approval/asked and
   * approval/request agree and the audit line is written exactly once.
   */
  evaluateApprovalRisk(sessionId, toolName, callId) {
    const key = this.approvalKey(sessionId, toolName, callId)
    const memo = this.approvalRisks.get(key)
    if (memo && now() - memo.at < 120_000) return memo
    const cached = this.approvalToolCalls.get(key)
    const args = cached && cached.toolName === toolName ? cached.args : {}
    const inner = cached && cached.toolName === toolName ? cached.inner : null
    const ticket = this.ticketForApproval(sessionId)
    const meta = ticket ? this.state.ticketMeta(ticket.ticketId) : null
    const worker = this.state.worker(sessionId)
    const cwd = text(worker && worker.cwd) || text(meta && meta.projectCwd)
    const workspace = text(meta && meta.projectCwd) || cwd
    let settings = {}
    try { settings = this.service.store.settings() } catch { settings = {} }
    const resolved = resolveEscalationPolicy({
      ticket: { escalationPolicy: meta && meta.escalationPolicy },
      settings,
    })
    const justification = text(args.justification) || text(args.reason) || (inner && inner.justification) || ''
    const risk = PTC_TRANSPORTS.has(toolName)
      ? this.classifyTransportRisk(inner, toolName, { cwd, workspace, justification })
      : classifyRisk({
        toolName,
        args,
        cwd,
        workspace,
        justification,
        ticket: ticket ? { ...ticket, meta } : null,
      })
    const decision = decideEscalation(risk.level, resolved.policy)
    const record = {
      key,
      sessionId,
      toolName,
      callId: text(callId),
      ticketId: ticket ? ticket.ticketId : '',
      risk,
      decision,
      policy: resolved.policy,
      policySource: resolved.source,
      cwd,
      workspace,
      at: now(),
      audited: false,
    }
    this.approvalRisks.set(key, record)
    if (this.approvalRisks.size > 200) {
      const oldest = [...this.approvalRisks.entries()].sort((left, right) => left[1].at - right[1].at)
      for (const [entry] of oldest.slice(0, this.approvalRisks.size - 150)) this.approvalRisks.delete(entry)
    }
    return record
  }

  riskArgv(record) {
    const signals = record && record.risk && record.risk.signals ? record.risk.signals : {}
    const inner = Array.isArray(signals.innerCommands) && signals.innerCommands.length ? signals.innerCommands[0] : ''
    const raw = inner || signals.command || (Array.isArray(signals.argv) ? signals.argv.join(' ') : '')
    return clipText(redactSecrets(raw), 300)
  }

  riskPaths(record) {
    const signals = record && record.risk && record.risk.signals ? record.risk.signals : {}
    const paths = []
    for (const item of Array.isArray(signals.paths) ? signals.paths : []) if (!paths.includes(item)) paths.push(item)
    for (const item of Array.isArray(signals.innerPaths) ? signals.innerPaths : []) if (!paths.includes(item)) paths.push(item)
    return paths.slice(0, 10).map(item => clipText(redactSecrets(item), 200))
  }

  /** Human-facing tool label; PTC transports show the inner command. */
  approvalToolDisplay(record) {
    const signals = record && record.risk && record.risk.signals ? record.risk.signals : {}
    if (signals.transport && Array.isArray(signals.innerCommands) && signals.innerCommands.length) {
      return signals.transport + '（实际命令：' + signals.innerCommands[0] + '）'
    }
    return record && record.toolName ? record.toolName : 'unknown'
  }

  /** One audit line per decision; failures warn but never block the approval. */
  auditApprovalRisk(record) {
    if (!record || record.audited) return
    record.audited = true
    const grantService = this.service && this.service.grants
    if (!grantService || typeof grantService.audit !== 'function') return
    try {
      grantService.audit({
        event: 'approval/decision',
        ticketId: record.ticketId || null,
        sessionId: record.sessionId,
        tool: record.toolName,
        callId: record.callId || null,
        argv: this.riskArgv(record),
        paths: this.riskPaths(record),
        level: record.risk.level,
        reasons: record.risk.reasons,
        decision: record.decision === 'auto-allow' ? 'auto-allow' : 'ask',
        policy: record.policy,
        policySource: record.policySource,
        transport: record.risk && record.risk.signals ? record.risk.signals.transport || null : null,
        kind: 'risk',
      })
    } catch (error) {
      this.log('warn', 'could not audit approval decision: ' + String(error && error.message ? error.message : error))
    }
  }

  auditHumanApproval(record, sessionId, approvalId, outcome) {
    const grantService = this.service && this.service.grants
    if (!grantService || typeof grantService.audit !== 'function') return
    const allowed = ALLOWED_APPROVAL_OUTCOMES.has(text(outcome))
    const decision = allowed ? 'human-allow' : (text(outcome) === 'rejected' ? 'human-deny' : 'human-cancel')
    try {
      grantService.audit({
        event: 'approval/decision',
        decision,
        approvalId: approvalId || null,
        ticketId: record && record.ticketId ? record.ticketId : null,
        sessionId,
        tool: record && record.toolName ? record.toolName : '',
        callId: record && record.callId ? record.callId : null,
        level: record && record.risk ? record.risk.level : 'unknown',
        reasons: record && record.risk ? record.risk.reasons : [],
        policy: record && record.policy ? record.policy : '',
        policySource: record && record.policySource ? record.policySource : '',
        kind: 'risk',
      })
    } catch (error) {
      this.log('warn', 'could not audit human approval: ' + String(error && error.message ? error.message : error))
    }
  }

  approvalRiskLabel(record) {
    const level = record && record.risk ? record.risk.level : 'unknown'
    const reasons = record && record.risk && Array.isArray(record.risk.reasons) ? record.risk.reasons.join('；') : ''
    return { level, reasons, text: 'risk:' + level + (reasons ? ' ' + reasons : '') }
  }
}
