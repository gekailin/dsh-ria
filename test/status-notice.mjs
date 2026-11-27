import assert from 'node:assert/strict'
import {
  STATUS_NOTICE_BLOCKED_MAX_CHARS,
  STATUS_NOTICE_MAX_CHARS,
  formatStatusNotice,
} from '../lib/core/notifications.mjs'
import { createFixture } from './support/ria-fixture.mjs'
import { Outbound } from '../lib/wechat/outbound.mjs'

// Formatting is pure: no report body, evidence or goal can pass through.
{
  const done = formatStatusNotice({
    ticketId: 'ticket_abcdef123456',
    status: 'done',
    summary: '第一句完成。第二句不应出现\n证据: secret.md',
    goal: 'this goal must not leak',
    evidence: ['secret.md'],
  })
  assert.equal(done.ticketId, 'ticket_abcdef123456', 'the notice carries the complete id')
  assert.equal(done.ref, '#123456（ticket_abcdef123456）')
  assert.equal(done.status, 'done')
  assert.ok(done.summary.length <= 30)
  assert.match(done.text, /^#123456（ticket_abcdef123456） done · /)
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
  assert.equal(blocked.ticketId, 'ticket_abcdef654321')
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
    assert.equal(sent[0].text, notice.text)
    assert.match(sent[0].options.ref, /^ria_/)
    assert.equal(sent[0].options.kind, 'notice')
    const alertSent = []
    claw.outbound = { enqueue: async (text, options) => { alertSent.push({ text, options }); return 'id' } }
    await claw.sendNote('⚠️ alert only')
    assert.ok(alertSent[0].text.startsWith('⚠️'))
    assert.equal(alertSent[0].options.kind, 'raw')
    await claw.sendNote('🚨 emergency only')
    assert.ok(alertSent[1].text.startsWith('🚨'))
    assert.equal(alertSent[1].options.kind, 'raw')
    for (const text of ['📌 task note', '🔐 approval note', '📎 file note', '【Ria·补发】retry']) {
      await claw.sendNote(text)
      const item = alertSent.at(-1)
      assert.ok(item.text.startsWith(text.split('\n')[0]))
      assert.equal(item.options.kind, 'raw', text + ' must use kind=raw')
    }
    assert.equal(claw.typingUsers.size, 0)
    assert.equal(notice.text.includes('证据'), false)
  } finally { fixture.cleanup() }
}

// Explicit forward prefixes: notice bell, false no prefix, and default wave for
// ordinary assistant replies.
{
  const fixture = await createFixture({ stateDefault: true })
  try {
    const claw = fixture.service.wechatClaw
    const sent = []
    claw.peer = { userId: 'user-1', contextToken: 'context-1' }
    claw.outbound = new Outbound({ send: async text => { sent.push(text); return 'id' }, log: () => {} })
    claw.forwardAssistant('notice text', {}, { prefix: '🔔 ' })
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.equal(sent.at(-1), '🔔 notice text')
    claw.forwardAssistant('no prefix', {}, { prefix: false })
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.equal(sent.at(-1), 'no prefix')
    claw.forwardAssistant('ordinary chat', {})
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.equal(sent.at(-1), '🌊 ordinary chat')
  } finally { fixture.cleanup() }
}

// Realistic DSH user/message events carry UserMessage directly (no `turn` field).
// Assistant replies always use the default wave prefix regardless of interleaved
// notice injections, while explicit notice paths (queueChatNotice / notifyClawStatus
// / sendNote) always carry the bell prefix.
{
  const fixture = await createFixture({ stateDefault: true })
  try {
    const controller = fixture.service.controller
    const claw = fixture.service.wechatClaw
    const riaId = claw.getRiaId()
    const sent = []
    claw.peer = { userId: 'user-1', contextToken: 'context-1' }
    claw.outbound = new Outbound({ send: async text => { sent.push(text); return 'id' }, log: () => {} })

    // Interleaved realistic user/message (no turn field): notice then human, then assistant reply.
    claw.onSessionEvent({ header: { id: riaId } }, {
      type: 'user/message', data: { id: 'm1', role: 'user', source: { kind: 'notice', rpcId: 'ria_notice_1' } },
    })
    claw.onSessionEvent({ header: { id: riaId } }, {
      type: 'user/message', data: { id: 'm2', role: 'user', source: { kind: 'user', rpcId: 'wc_human_1' } },
    })
    claw.onSessionEvent({ header: { id: riaId } }, {
      type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'normal reply' }] } },
    })
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.equal(sent.at(-1), '🌊 normal reply', 'assistant reply must never inherit bell from prior notice')

    // queueChatNotice directly pushes a bell-prefixed notice to Claw as well as Chat.
    controller.queueChatNotice('已自动放行低风险提权')
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.equal(sent.at(-1), '🔔 已自动放行低风险提权')

    // Generic sendNote without explicit emoji gets bell; file note with 📎 keeps single prefix.
    await claw.sendNote('普通状态提示')
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.equal(sent.at(-1), '🔔 普通状态提示')
    await claw.sendNote('📎 附件说明', { prefix: false })
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.equal(sent.at(-1), '📎 附件说明')
  } finally { fixture.cleanup() }
}

// WeChatService sendDispatchNote / sendApprovalNote must not double-prefix with 🌊.
{
  const { WechatService } = await import('../lib/wechat/service.mjs')
  const { mkdtempSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = mkdtempSync(join(tmpdir(), 'ria-wechat-prefix-'))
  try {
    const sent = []
    const svc = new WechatService({ stateDir: dir, log: () => {} })
    svc.outbound = new Outbound({ send: async text => { sent.push(text); return 'id' }, log: () => {} })
    await svc.sendDispatchNote('ticket #123456')
    await svc.sendApprovalNote('bash command')
    await svc.sendNote('📎 report.md', { prefix: false })
    await new Promise(resolve => setTimeout(resolve, 30))
    assert.equal(sent[0], '📌 任务已派发：ticket #123456')
    assert.equal(sent[1], '🔐 等待权限审批：bash command')
    assert.equal(sent[2], '📎 report.md')
  } finally { rmSync(dir, { recursive: true, force: true }) }
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
    claw.outbound = new Outbound({ send: async text => { sent.push(text); return 'id' }, log: () => {} })
    await controller.sendWatchRelay({ sessionId: id, titleSnapshot: 'CM Notice', watchId: 'watch-notice' }, '完整正文\n证据: secret\n代码块', {})
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.equal(sent.length, 0, 'working-ticket co-managed session must not emit watch relays; ticket settlement owns its status notices')
    await controller.notifyTicketStatus(ticket.ticketId, 'working', '做到一半。证据: secret')
    await new Promise(resolve => setTimeout(resolve, 20))
    const text = sent.at(-1)
    assert.ok(text.startsWith('🔔 #' + ticket.ticketId.slice(-6) + '（' + ticket.ticketId + '） working · '))
    assert.equal(text.includes('完整正文'), false)
    assert.equal(text.includes('secret'), false)
    assert.ok(text.length <= STATUS_NOTICE_MAX_CHARS)
  } finally { fixture.cleanup() }
}

// A terminal ticket owned by a ticket-free session is history, not a status
// event for this turn: relay the assistant body, never the old done/blocked line.
{
  const fixture = await createFixture({
    stateDefault: true,
    extraSessions: [{ sessionId: 'session-cm-done', cwd: '/tmp', title: 'CM Done' }],
  })
  try {
    const controller = fixture.service.controller
    const id = 'session-cm-done'
    const ticket = fixture.service.store.addTicket({ status: 'done', executor: id, goal: 'done work' })
    controller.state.setTicketMeta(ticket.ticketId, { phase: 'done', executorId: id })
    controller.state.addExecutor(id, { status: 'idle', currentTicketId: ticket.ticketId })
    controller.state.addReport({
      reportId: 'report_done_1', ticketId: ticket.ticketId, executorId: id,
      status: 'done', summary: '已完成首句。证据: secret', evidence: ['secret'], at: Date.now(),
    })
    const claw = fixture.service.wechatClaw
    const chat = []
    controller.notifyChat = async text => { chat.push(text); return true }
    claw.forwardAssistant = undefined
    claw.outbound = new Outbound({ send: async text => { chat.push(text); return 'id' }, log: () => {} })
    await controller.sendWatchRelay({ sessionId: id, titleSnapshot: 'CM Done', watchId: 'watch-done' }, '完整正文\n证据: secret\n代码块', {})
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.ok(chat.some(text => text.includes('完整正文')), 'ticket-free reply body is relayed')
    assert.equal(chat.some(text => text.startsWith('🔔 #' + ticket.ticketId.slice(-6) + '（' + ticket.ticketId + '） done · ')), false, 'historical done ticket is not re-notified')
    const blocked = fixture.service.store.addTicket({
      status: 'blocked', executor: id, waitingOn: 'user',
      blockedReason: '需要用户决定下一步怎么办', goal: 'blocked work',
    })
    blocked.updatedAt = Date.now() + 1000
    controller.state.setTicketMeta(blocked.ticketId, { phase: 'blocked', executorId: id })
    controller.state.addExecutor(id, { status: 'idle', currentTicketId: blocked.ticketId })
    chat.length = 0
    await controller.sendWatchRelay({ sessionId: id, titleSnapshot: 'CM Done', watchId: 'watch-blocked' }, '完整正文', {})
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.ok(chat.some(text => text.includes('完整正文')), 'ticket-free blocked reply body is relayed')
    assert.equal(chat.some(text => text.startsWith('🔔 #' + blocked.ticketId.slice(-6) + '（' + blocked.ticketId + '） blocked · ')), false, 'historical blocked ticket is not re-notified')
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
