import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFixture } from './support/ria-fixture.mjs'

// A Worker that stops for an approval must show up as blocked(waitingOn=approval)
// on its ticket and get a Chatbot notice. Valid completed work supersedes old
// approvals instead of being reported as an approval timeout.

const independentCwd = mkdtempSync(join(tmpdir(), 'ria-independent-'))
const fixture = await createFixture({
  v2Default: true,
  extraSessions: [
    { sessionId: 'session-independent', running: false, blank: false, updatedAt: 10, cwd: independentCwd, projections: { values: { title: 'Independent Session' } } },
  ],
})

const settle = () => new Promise(resolve => setTimeout(resolve, 20))
const chatbot = fixture.service.v2.v2.chatbotSessionId
const notices = () => fixture.prompts.filter(item => String(item.sessionId) === String(chatbot))
const textOf = prompt => String(prompt && prompt.content && prompt.content[0] ? prompt.content[0].text : '')
const asked = (worker, data) => fixture.service.onSessionEvent({ header: { id: worker } }, { type: 'approval/asked', time: Date.now(), data })
const decided = (worker, data) => fixture.service.onSessionEvent({ header: { id: worker } }, { type: 'approval/decided', time: Date.now(), data })
const ticketOf = ticketId => fixture.service.store.ticket(ticketId)

try {
  await fixture.service.ensure()
  const request = await fixture.callAs(chatbot, 'chatbot_request', { goal: 'approval probe', acceptance: 'none' })
  const advisor = fixture.service.v2.v2.advisor('global').sessionId
  await fixture.callAs(advisor, 'ticket_plan', { ticketId: request.ticketId, summary: 'do the probe', steps: ['probe'] })
  const dispatch = await fixture.callAs(advisor, 'ticket_dispatch', { ticketId: request.ticketId })
  assert.equal(dispatch.ok, true)
  const ticketId = request.ticketId
  const worker = dispatch.workerSessionId
  assert.equal(ticketOf(ticketId).status, 'working')
  assert.equal(String(ticketOf(ticketId).executor), String(worker))

  // Risk policy replaces the old tool whitelist. The default is auto-low: a
  // cached read-only command is auto-allowed, unknown arguments still ask.
  {
    const cache = (callId, args) => fixture.emit(
      'tools/pre-execute',
      { agent: { id: worker }, name: 'bash', callId, arguments: args },
      async () => ({ kind: 'enter' }),
    )
    const calls = []
    const next = async () => { calls.push('next'); return 'rejected' }
    await cache('call-low', { command: 'git status' })
    const allowed = await fixture.emit('approval/request', { agent: { id: worker }, toolName: 'bash', callId: 'call-low', reason: 'why', signal: new AbortController().signal }, next)
    assert.equal(allowed, 'allowed-once')
    assert.deepEqual(calls, [])
    // The matching asked event must not park the ticket this plugin approved.
    asked(worker, { id: 'apr_auto', toolName: 'bash', callId: 'call-low', reason: 'why' })
    assert.equal(ticketOf(ticketId).status, 'working')
    // An unknown tool/arguments still goes to the answerer.
    const other = await fixture.emit('approval/request', { agent: { id: worker }, toolName: 'write', callId: 'call-w', reason: 'why', signal: new AbortController().signal }, next)
    assert.equal(other, 'rejected')
    assert.deepEqual(calls, ['next'])
    // An independent session is never auto-approved.
    const foreign = await fixture.emit('approval/request', { agent: { id: 'session-independent' }, toolName: 'bash', callId: 'call-i', reason: 'why', signal: new AbortController().signal }, next)
    assert.equal(foreign, 'rejected')
    assert.deepEqual(fixture.service.store.settings().approvalAutoAllow, { enabled: false, tools: [] })
  }

  // asked -> blocked(waitingOn=approval) with the tool, the reason and the time.
  const before = notices().length
  asked(worker, { id: 'apr_1', toolName: 'bash', callId: 'call-1', reason: '受控实验：写工作区外探针' })
  {
    const ticket = ticketOf(ticketId)
    assert.equal(ticket.status, 'blocked')
    assert.equal(ticket.waitingOn, 'approval')
    assert.match(ticket.blockedReason, /bash/)
    assert.match(ticket.blockedReason, /受控实验/)
    assert.match(ticket.blockedReason, /请求于 \d{2}:\d{2}:\d{2} \+08:00/)
    assert.equal(ticket.attention.kind, 'approval')
    assert.equal(ticket.attention.ref, 'apr_1')
    assert.equal(fixture.service.v2.v2.ticketMeta(ticketId).phase, 'blocked')
    await settle()
    const sent = notices().slice(before)
    assert.equal(sent.length, 1)
    assert.match(textOf(sent[0]), new RegExp(ticketId))
    assert.match(textOf(sent[0]), /bash/)
    assert.match(textOf(sent[0]), /受控实验/)
    assert.match(textOf(sent[0]), /请求于 \d{2}:\d{2}:\d{2} \+08:00/)
    assert.match(textOf(sent[0]), /blocked\(waitingOn=approval\)/)
  }

  // allowed -> blocked has no direct edge to working; ask -> open -> working.
  {
    const before = notices().length
    decided(worker, { id: 'apr_1', outcome: 'allowed-once' })
    const ticket = ticketOf(ticketId)
    assert.equal(ticket.status, 'working')
    assert.equal(ticket.waitingOn, 'worker')
    assert.equal(String(ticket.executor), String(worker))
    assert.equal(ticket.blockedReason, '')
    assert.equal(ticket.attention, null)
    await settle()
    const sent = notices().slice(before)
    assert.equal(sent.length, 1)
    assert.match(textOf(sent[0]), /审批通过/)
  }

  // rejected -> stays blocked with a durable failure code.
  asked(worker, { id: 'apr_2', toolName: 'bash', callId: 'call-2', reason: '第二次' })
  decided(worker, { id: 'apr_2', outcome: 'rejected' })
  {
    const ticket = ticketOf(ticketId)
    assert.equal(ticket.status, 'blocked')
    assert.equal(ticket.waitingOn, 'approval')
    assert.equal(ticket.failure.code, 'approval_denied')
    assert.match(ticket.failure.message, /bash/)
    await settle()
    assert.match(textOf(notices().at(-1)), /拒绝/)
  }

  // cancelled (the budget-exhaustion shape) also stays blocked.
  // A manual resume is allowed while waiting on an approval.
  {
    const resume = await fixture.callAs(chatbot, 'chatbot_resume', { ticketId })
    assert.equal(resume.ok, true, JSON.stringify(resume))
    assert.equal(ticketOf(ticketId).status, 'working')
  }
  asked(worker, { id: 'apr_3', toolName: 'bash', callId: 'call-3', reason: '第三次' })
  decided(worker, { id: 'apr_3', outcome: 'cancelled' })
  {
    const ticket = ticketOf(ticketId)
    assert.equal(ticket.status, 'blocked')
    assert.equal(ticket.failure.code, 'approval_cancelled')
    await settle()
    assert.match(textOf(notices().at(-1)), /取消/)
  }

  // Resuming also clears the recorded denial/cancellation, so the timeout case
  // starts from a healthy working ticket.
  {
    const resume = await fixture.callAs(chatbot, 'chatbot_resume', { ticketId })
    assert.equal(resume.ok, true, JSON.stringify(resume))
    assert.equal(ticketOf(ticketId).status, 'working')
    assert.equal(ticketOf(ticketId).failure, null)
  }

  // No decided at all: valid completed work supersedes the obsolete approval.
  asked(worker, { id: 'apr_4', toolName: 'bash', callId: 'call-4', reason: '无决定' })
  assert.equal(ticketOf(ticketId).status, 'blocked')
  assert.equal(ticketOf(ticketId).waitingOn, 'approval')
  {
    const progress = await fixture.callAs(worker, 'worker_report', { ticketId, status: 'progress', summary: 'still waiting' })
    assert.equal(progress.ok, true)
    assert.equal(progress.status, 'blocked')
    const done = await fixture.callAs(worker, 'worker_report', { ticketId, status: 'done', summary: 'finished', evidence: ['command exit 0'] })
    assert.equal(done.ok, true, JSON.stringify(done))
    assert.equal(done.status, 'done')
    const ticket = ticketOf(ticketId)
    assert.equal(ticket.status, 'done')
    assert.equal(ticket.waitingOn, 'none')
    assert.equal(ticket.failure, null)
    assert.equal(fixture.service.v2.pendingApprovals.has('apr_4'), false)
    decided(worker, { id: 'apr_4', outcome: 'cancelled' })
    assert.equal(ticket.status, 'done')
    assert.equal(ticket.failure, null)
    await settle()
    assert.equal(notices().some(item => /approval_timeout/.test(textOf(item))), false)
  }

  // Ordinary independent sessions keep their read-only notice, and their
  // approval events never move a ticket.
  {
    // The whitelist block above already notified for this session; drop the
    // flood guard so this assertion observes the notice itself.
    fixture.service.v2.blockedNoticeMinIntervalMs = 0
    fixture.service.v2.blockedNoticeWindowMs = 0
    const revision = ticketOf(ticketId).revision
    const before = notices().length
    const outcome = await fixture.emit('approval/request', {
      agent: { id: 'session-independent' },
      toolName: 'bash',
      callId: 'call-ind',
      reason: 'independent',
      signal: new AbortController().signal,
    }, async () => 'rejected')
    assert.equal(outcome, 'rejected')
    await settle()
    const sent = notices().slice(before)
    assert.equal(sent.length, 0)
    const events = readFileSync(join(fixture.stateDir, 'router-events.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
    assert.ok(events.some(item => item.event === 'notice.suppressed' && item.sessionId === 'session-independent' && item.payload && item.payload.kind === 'approval'))
    fixture.service.onSessionEvent({ header: { id: 'session-independent' } }, { type: 'approval/asked', time: Date.now(), data: { id: 'apr_ind', toolName: 'bash' } })
    assert.equal(ticketOf(ticketId).revision, revision)
    assert.equal(ticketOf(ticketId).status, 'done')
  }

  // The store records the whitelist in settings(), defaulting to off.
  assert.deepEqual(fixture.service.store.settings().approvalAutoAllow, { enabled: false, tools: [] })
} finally {
  fixture.cleanup()
  rmSync(independentCwd, { recursive: true, force: true })
}

console.log('v2 approval ticket ok')
