import assert from 'node:assert/strict'
import { createFixture } from './support/ria-fixture.mjs'

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

function workingTicket(store, executor = 'session-worker', goal = 'approval visibility') {
  return store.addTicket({
    goal,
    acceptance: 'the approval is visible and recoverable',
    executor,
    status: 'working',
  })
}

function approvalRequest(workerSessionId, signal, toolName = 'bash') {
  return {
    agent: { id: workerSessionId },
    toolName,
    callId: 'call_' + workerSessionId,
    reason: 'write outside workspace',
    signal,
  }
}

function outboxKinds(service) {
  return service.outbox.summary().items.map(item => item.kind)
}

// Capturing a worker approval request blocks the active ticket, records
// approval attention, mirrors it into the status overview, queues both the
// local card and WeChat notice, and exposes the remaining lifetime.
{
  const fixture = await createFixture()
  const service = fixture.service
  const store = service.store
  try {
    const ticket = workingTicket(store)
    const controller = new AbortController()
    let release
    const gate = new Promise(resolve => { release = resolve })
    let result
    const pending = fixture.emit(
      'approval/request',
      approvalRequest('session-worker', controller.signal),
      async () => { await gate; result = 'allowed'; return { kind: 'allow' } },
    )

    await sleep(10)
    const blocked = store.ticket(ticket.ticketId)
    assert.equal(blocked.status, 'blocked')
    assert.equal(blocked.waitingOn, 'approval')
    assert.equal(blocked.attention.kind, 'approval')
    assert.equal(blocked.attention.askedBy, 'worker')
    assert.match(blocked.attention.question, /session-worker/)
    assert.match(blocked.attention.question, /bash/)
    assert.match(blocked.blockedReason, /Ria 不能代你决定/)
    assert.equal(typeof blocked.attention.ref, 'string')

    const kinds = outboxKinds(service)
    assert.ok(kinds.includes('approval_note'))
    assert.ok(kinds.includes('wechat_approval_note'))

    const status = await fixture.call('ria_status', { scope: 'tickets' })
    assert.equal(status.attentionOverview.waitingOnApproval, 1)
    assert.equal(status.attentionOverview.waitingOnUser, 0)
    assert.equal(status.attentionOverview.total, 1)
    assert.equal(status.attentionOverview.items[0].ticketId, ticket.ticketId)
    assert.equal(status.attentionOverview.items[0].kind, 'approval')
    assert.equal(status.attentionOverview.items[0].askedBy, 'worker')

    const approval = await fixture.call('ria_approval', {})
    assert.equal(approval.count, 1)
    assert.equal(approval.pending[0].ticketId, ticket.ticketId)
    assert.equal(approval.pending[0].workerSessionId, 'session-worker')
    assert.ok(approval.pending[0].expiresInMs > 0)
    assert.ok(approval.pending[0].expiresAt >= approval.pending[0].createdAt)

    release()
    await pending
    assert.equal(result, 'allowed')
    const restored = store.ticket(ticket.ticketId)
    assert.equal(restored.status, 'working')
    assert.equal(restored.waitingOn, 'worker')
    assert.equal(restored.attention, null)
    assert.equal((await fixture.call('ria_approval', {})).count, 0)
  } finally {
    fixture.cleanup()
  }
}

// Denying also returns the ticket to working; the restore is driven by the
// answerer finishing, not by the answer value.
{
  const fixture = await createFixture()
  const service = fixture.service
  const store = service.store
  try {
    const ticket = workingTicket(store, 'session-no-image', 'denied approval')
    let release
    const gate = new Promise(resolve => { release = resolve })
    const pending = fixture.emit(
      'approval/request',
      approvalRequest('session-no-image', new AbortController().signal, 'edit'),
      async () => { await gate; return { kind: 'deny' } },
    )
    await sleep(10)
    assert.equal(store.ticket(ticket.ticketId).status, 'blocked')

    release()
    await pending
    const restored = store.ticket(ticket.ticketId)
    assert.equal(restored.status, 'working')
    assert.equal(restored.waitingOn, 'worker')
    assert.equal(restored.attention, null)
  } finally {
    fixture.cleanup()
  }
}

// A request from a session without an active ticket is observed but changes
// nothing and is not listed.
{
  const fixture = await createFixture()
  const service = fixture.service
  const store = service.store
  try {
    const ticket = workingTicket(store)
    const pending = fixture.emit(
      'approval/request',
      approvalRequest('session-unrelated', new AbortController().signal),
      async () => ({ kind: 'deny' }),
    )
    await pending
    assert.equal(store.ticket(ticket.ticketId).status, 'working')
    assert.equal((await fixture.call('ria_approval', {})).count, 0)
  } finally {
    fixture.cleanup()
  }
}

// TTL expiry restores the ticket without waiting for the answerer.
{
  const fixture = await createFixture()
  const service = fixture.service
  const store = service.store
  try {
    const ticket = workingTicket(store, 'session-worker', 'expired approval')
    service.approvals.ttlMs = 30
    let release
    const gate = new Promise(resolve => { release = resolve })
    const pending = fixture.emit(
      'approval/request',
      approvalRequest('session-worker', new AbortController().signal),
      async () => { await gate; return { kind: 'deny' } },
    )
    await sleep(15)
    assert.equal(store.ticket(ticket.ticketId).status, 'blocked')
    await sleep(60)
    const restored = store.ticket(ticket.ticketId)
    assert.equal(restored.status, 'working')
    assert.equal(restored.waitingOn, 'worker')
    assert.equal(restored.attention, null)
    assert.equal((await fixture.call('ria_approval', {})).count, 0)

    release()
    await pending
  } finally {
    fixture.cleanup()
  }
}

// Startup reconciliation is the safety net after a restart: the approval queue
// is memory-only, so a blocked+approval ticket with no matching pending request
// must return to working instead of staying blocked forever.
{
  const fixture = await createFixture()
  const service = fixture.service
  const store = service.store
  try {
    const ticket = store.addTicket({
      goal: 'lost approval',
      acceptance: 'recover after restart',
      executor: 'session-worker',
      status: 'blocked',
      waitingOn: 'approval',
      blockedReason: 'waiting for an approval that no longer exists',
      attention: {
        kind: 'approval',
        question: 'worker is waiting for an approval',
        askedBy: 'worker',
        ref: 'apr_missing',
      },
    })
    await service.startup()
    const restored = store.ticket(ticket.ticketId)
    assert.equal(restored.status, 'working')
    assert.equal(restored.waitingOn, 'worker')
    assert.equal(restored.attention, null)
  } finally {
    fixture.cleanup()
  }
}

console.log('approval visibility ok')
