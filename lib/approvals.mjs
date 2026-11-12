// Observes worker approval requests without answering them.
//
// The listener records a pending request for a worker with an active task, then
// immediately delegates to the next answerer. It never returns an approval
// outcome itself, so the existing UI answerer keeps full control.

import { randomUUID } from 'node:crypto'

export const APPROVAL_TTL_MS = 15 * 60_000

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
  return item
}

/**
 * The one-line question stored on the blocked ticket and sent to the user.
 * The session id is the only worker identity the observer has; the note is
 * deliberately explicit that Ria cannot answer the approval.
 */
export function approvalQuestion(record) {
  const reason = record.reason ? record.reason : '未说明'
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
  constructor({ ctx, store, log = () => {}, ttlMs = APPROVAL_TTL_MS, now = () => Date.now(), notify = () => {} }) {
    this.ctx = ctx
    this.store = store
    this.log = log
    this.ttlMs = ttlMs
    this.now = now
    this.notify = notify
    this.pending = new Map()
  }

  subscribe() {
    return this.ctx.on('approval/request', async (request, next) => {
      const record = this.capture(request)
      try {
        return await next()
      } finally {
        if (record) this.clear(record.approvalId, 'resolved')
      }
    })
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
    }
    if (request.callId !== undefined) record.callId = String(request.callId)
    if (typeof request.reason === 'string' && request.reason) record.reason = request.reason

    this.enterApproval(record, ticket)

    const timer = setTimeout(() => this.clear(record.approvalId, 'timeout'), this.ttlMs)
    if (timer.unref) timer.unref()
    const signal = request.signal
    const onAbort = () => this.clear(record.approvalId, 'aborted')
    if (signal) signal.addEventListener('abort', onAbort, { once: true })
    this.pending.set(record.approvalId, { record, timer, signal, onAbort })
    try {
      this.notify(record, this.ticketFor(record.ticketId) || ticket)
    } catch (error) {
      this.log('warn', 'could not notify about approval ' + record.approvalId + ': ' + String(error && error.message ? error.message : error))
    }
    return record
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
      if (item.record.expiresAt <= at) this.clear(id, 'timeout')
    }
    return [...this.pending.values()]
      .map(item => publicApproval(item.record))
      .sort((a, b) => a.createdAt - b.createdAt || a.approvalId.localeCompare(b.approvalId))
  }

  shutdown() {
    for (const id of [...this.pending.keys()]) this.clear(id, 'shutdown')
  }
}
