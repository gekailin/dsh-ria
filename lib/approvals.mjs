// Observes worker approval requests without answering them.
//
// The listener records a pending request for a worker with an active task, then
// immediately delegates to the next answerer. It never returns an approval
// outcome itself, so the existing UI answerer keeps full control.

import { randomUUID } from 'node:crypto'

export const APPROVAL_TTL_MS = 15 * 60_000

const newApprovalId = () => 'apr_' + Date.now().toString(36) + '_' + randomUUID().replace(/-/g, '').slice(0, 10)

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

export class ApprovalObserver {
  constructor({ ctx, store, log = () => {}, ttlMs = APPROVAL_TTL_MS }) {
    this.ctx = ctx
    this.store = store
    this.log = log
    this.ttlMs = ttlMs
    this.pending = new Map()
  }

  subscribe() {
    return this.ctx.on('approval/request', async (request, next) => {
      const record = this.capture(request)
      try {
        return await next()
      } finally {
        if (record) this.clear(record.approvalId)
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

    const createdAt = Date.now()
    const record = {
      approvalId: newApprovalId(),
      workerSessionId,
      ticketId: ticket.ticketId,
      toolName: String(request.toolName || 'unknown'),
      createdAt,
      expiresAt: createdAt + this.ttlMs,
    }
    if (request.callId !== undefined) record.callId = String(request.callId)
    if (typeof request.reason === 'string' && request.reason) record.reason = request.reason

    const timer = setTimeout(() => this.clear(record.approvalId), this.ttlMs)
    if (timer.unref) timer.unref()
    const signal = request.signal
    const onAbort = () => this.clear(record.approvalId)
    if (signal) signal.addEventListener('abort', onAbort, { once: true })
    this.pending.set(record.approvalId, { record, timer, signal, onAbort })
    return record
  }

  clear(approvalId) {
    const item = this.pending.get(approvalId)
    if (!item) return
    this.pending.delete(approvalId)
    clearTimeout(item.timer)
    if (item.signal && item.onAbort) item.signal.removeEventListener('abort', item.onAbort)
  }

  list() {
    const now = Date.now()
    for (const [id, item] of [...this.pending]) {
      if (item.record.expiresAt <= now) this.clear(id)
    }
    return [...this.pending.values()]
      .map(item => publicApproval(item.record))
      .sort((a, b) => a.createdAt - b.createdAt || a.approvalId.localeCompare(b.approvalId))
  }

  shutdown() {
    for (const id of [...this.pending.keys()]) this.clear(id)
  }
}
