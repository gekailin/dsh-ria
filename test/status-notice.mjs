import assert from 'node:assert/strict'
import {
  STATUS_NOTICE_BLOCKED_MAX_CHARS,
  STATUS_NOTICE_MAX_CHARS,
  formatStatusNotice,
} from '../lib/core/notifications.mjs'
import { createFixture } from './support/ria-fixture.mjs'

// Formatting is pure: no report body, evidence or goal can pass through.
{
  const done = formatStatusNotice({
    ticketId: 'ticket_abcdef123456',
    status: 'done',
    summary: '第一句完成。第二句不应出现\n证据: secret.md',
    goal: 'this goal must not leak',
    evidence: ['secret.md'],
  })
  assert.equal(done.ticketId, '123456')
  assert.equal(done.status, 'done')
  assert.ok(done.summary.length <= 30)
  assert.match(done.text, /^#123456 done · /)
  assert.ok(done.text.length <= STATUS_NOTICE_MAX_CHARS)
  assert.equal(done.text.includes('第二句'), false)
  assert.equal(done.text.includes('secret.md'), false)
  assert.equal('evidence' in done, false)
  assert.equal('goal' in done, false)

  const long = formatStatusNotice({
    ticketId: 'ticket_abcdef123456', status: 'working',
    summary: '很长的摘要'.repeat(30),
  })
  assert.ok(long.summary.length <= 30)
  assert.ok(long.text.length <= STATUS_NOTICE_MAX_CHARS)

  const empty = formatStatusNotice({ ticketId: 'ticket_1', status: 'cancelled', summary: ' ' })
  assert.equal(empty.summary, '无摘要')
  assert.equal(empty.status, 'cancelled')

  const unknown = formatStatusNotice({ ticketId: 'ticket_1', status: 'progress', summary: 'x' })
  assert.equal(unknown.status, 'failed')
}

// Blocked notices may use two lines, but stay below the larger cap and carry
// only waitingOn plus one-sentence reason.
{
  const blocked = formatStatusNotice({
    ticketId: 'ticket_abcdef654321',
    status: 'blocked',
    summary: '需要确认部署窗口。后面还有正文',
    waitingOn: 'user',
    reason: '确认是否允许重启。证据不应出现',
    evidence: ['secret'],
  })
  assert.equal(blocked.ticketId, '654321')
  assert.equal(blocked.status, 'blocked')
  assert.equal(blocked.waitingOn, 'user')
  assert.equal(blocked.text.split('\n').length, 2)
  assert.match(blocked.text, /waitingOn=user/)
  assert.ok(blocked.text.length <= STATUS_NOTICE_BLOCKED_MAX_CHARS)
  assert.equal(blocked.text.includes('证据'), false)
  assert.equal('evidence' in blocked, false)
}

// The controller sends the exact compact line to Chat and Claw, and Claw
// delivery does not start a typing loop.
{
  const fixture = await createFixture({ stateDefault: true })
  try {
    const controller = fixture.service.controller
    const chat = controller.state.chatSessionId
    const claw = fixture.service.wechatClaw
    const sent = []
    claw.peer = { userId: 'user-1', contextToken: 'context-1' }
    claw.outbound = { enqueue: async (text, options) => { sent.push({ text, options }); return 'id' } }
    const notice = await controller.notifyTicketStatus('ticket_abcdef123456', 'done', '首句完成。证据 secret')
    assert.equal(fixture.steered.at(-1).sessionId, undefined)
    assert.equal(fixture.steered.at(-1).source.kind, 'notice')
    assert.match(fixture.steered.at(-1).source.rpcId, /^ria_/)
    assert.equal(fixture.steered.at(-1).content[0].text, notice.text)
    assert.equal(sent[0].text, '🔔 ' + notice.text)
    assert.match(sent[0].options.ref, /^ria_/)
    assert.equal(sent[0].options.prefix, false)
    const alertSent = []
    claw.outbound = { enqueue: async (text, options) => { alertSent.push({ text, options }); return 'id' } }
    await claw.sendNote('⚠️ alert only')
    assert.ok(alertSent[0].text.startsWith('⚠️'))
    assert.equal(alertSent[0].options.prefix, false)
    await claw.sendNote('🚨 emergency only')
    assert.ok(alertSent[1].text.startsWith('🚨'))
    assert.equal(alertSent[1].options.prefix, false)
    assert.equal(claw.typingUsers.size, 0)
    assert.equal(notice.text.includes('证据'), false)
  } finally { fixture.cleanup() }
}

// A co-managed session working a ticket relays only the compact status line;
// the full assistant body stays out of both Chat and Claw.
{
  const fixture = await createFixture({
    stateDefault: true,
    extraSessions: [{ sessionId: 'session-cm-notice', cwd: '/tmp', title: 'CM Notice' }],
  })
  try {
    const controller = fixture.service.controller
    const id = 'session-cm-notice'
    const ticket = fixture.service.store.addTicket({ status: 'working', executor: id, goal: 'do work' })
    controller.state.setTicketMeta(ticket.ticketId, { phase: 'working', executorId: id })
    controller.state.addExecutor(id, { status: 'working', currentTicketId: ticket.ticketId })
    controller.state.addReport({
      reportId: 'report_notice_1', ticketId: ticket.ticketId, executorId: id,
      status: 'progress', summary: '做到一半。证据: secret', evidence: ['secret'], at: Date.now(),
    })
    const claw = fixture.service.wechatClaw
    const sent = []
    claw.peer = { userId: 'user-1', contextToken: 'context-1' }
    claw.outbound = { enqueue: async text => { sent.push(text); return 'id' } }
    await controller.sendWatchRelay({ sessionId: id, titleSnapshot: 'CM Notice', watchId: 'watch-notice' }, '完整正文\n证据: secret\n代码块', {})
    const text = sent.at(-1)
    assert.ok(text.startsWith('🔔 #' + ticket.ticketId.slice(-6) + ' working · '))
    assert.equal(text.includes('完整正文'), false)
    assert.equal(text.includes('secret'), false)
    assert.ok(text.length <= STATUS_NOTICE_MAX_CHARS)
  } finally { fixture.cleanup() }
}

// Full report storage is untouched.
{
  const fixture = await createFixture({ stateDefault: true })
  try {
    const controller = fixture.service.controller
    const chat = controller.state.chatSessionId
    const ticket = fixture.service.store.addTicket({
      status: 'done', goal: 'full report regression',
      resolution: { kind: 'done', summary: '完整摘要仍可取', evidence: ['e1.md', 'e2.md'] },
    })
    const view = await fixture.callAs(chat, 'ria_chat_status', { ticketId: ticket.ticketId })
    assert.equal(view.ok, true, JSON.stringify(view))
    assert.match(JSON.stringify(view), /完整摘要仍可取/)
    assert.match(JSON.stringify(view), /e1\.md/)
  } finally { fixture.cleanup() }
}

console.log('status-notice ok')
