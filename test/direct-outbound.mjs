import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WechatClawService } from '../lib/channels/wechat-claw.mjs'
import { Outbound } from '../lib/wechat/outbound.mjs'
import { WECHAT_ASSISTANT_NOTE_KIND } from '../lib/outbox.mjs'
import { createFixture } from './support/ria-fixture.mjs'

// Direct mode must not silence the Chat. It only labels its text 【Ria】;
// direct replies are labelled 【直通·<标题>】. Live direct chatter retries in
// memory (bounded, deduped) and is never replayed from the durable outbox.

const wait = ms => new Promise(resolve => setTimeout(resolve, ms))

async function waitFor(check, label, timeout = 3000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (check()) return
    await wait(10)
  }
  assert.fail(label + ' timed out')
}

function makeClaw({ stateDir, send, isDirectActive = () => false }) {
  const claw = new WechatClawService({
    ctx: { on() { return () => {} }, sessionController: { prompt: async () => {} } },
    stateDir,
    ensureRia: async () => 'ria-session',
    getRiaId: () => 'ria-session',
    log: () => {},
    imageOptions: () => ({ inbound: true, outbound: true }),
    isDirectActive,
  })
  claw.peer = { userId: 'user-1', contextToken: 'context-1' }
  claw.lastInboundAt = Date.now()
  claw.outbound = new Outbound({ send: send || (async () => 'msg-id'), sendImage: async () => 'image-id', log: () => {} })
  return claw
}

const assistant = text => ({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text }] } } })

// ① Chat assistant text is still forwarded during direct mode, labelled.
{
  const dir = mkdtempSync(join(tmpdir(), 'dsh-ria-direct-prefix-'))
  const sent = []
  let direct = false
  try {
    const claw = makeClaw({ stateDir: dir, send: async text => { sent.push(text); return 'm' }, isDirectActive: () => direct })
    claw.onSessionEvent({ header: { id: 'ria-session' } }, assistant('任务报告'))
    await waitFor(() => sent.length === 1, 'normal delivery')
    assert.equal(sent[0].includes('【Ria】'), false, 'normal mode keeps the plain text')

    direct = true
    claw.onSessionEvent({ header: { id: 'ria-session' } }, assistant('审批通知'))
    await waitFor(() => sent.length === 2, 'direct-mode delivery')
    assert.ok(sent[1].includes('【Ria】'), 'Chat text is labelled 【Ria】 during direct mode')
    assert.ok(sent[1].includes('审批通知'))
    assert.equal(claw.lastAssistantForward.reason, 'delivered')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// ② Durable fallback text carries the 【Ria·补发】 prefix.
{
  const dir = mkdtempSync(join(tmpdir(), 'dsh-ria-direct-fallback-'))
  const sent = []
  try {
    const claw = makeClaw({ stateDir: dir, send: async text => { sent.push(text); return 'm' } })
    assert.equal(await claw.sendAssistantNote('补发正文'), true)
    assert.equal(sent.length, 1)
    assert.ok(sent[0].includes('【Ria·补发】'), sent[0])
    assert.ok(sent[0].includes('补发正文'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// ③ Direct target reply and Ria report both reach the channel, distinguishable.
{
  const fixture = await createFixture({ stateDefault: true })
  const calls = []
  fixture.service.wechatClaw.forwardAssistant = (text, event, options) => {
    calls.push({ text })
    if (options && typeof options.onSettled === 'function') options.onSettled({ reason: 'delivered' })
  }
  try {
    const chat = fixture.service.controller.state.chatSessionId
    fixture.service.controller.setDirect({ sessionId: 'session-independent', title: 'Alpha' })
    fixture.service.controller.onSessionEvent(
      { header: { id: 'session-independent' } },
      assistant('直通回复'),
    )
    assert.equal(calls.at(-1).text, '【直通·Alpha】\n直通回复')

    fixture.service.wechatClaw.onSessionEvent({ header: { id: chat } }, assistant('ticket 已完成'))
    await waitFor(() => calls.some(item => item.text.includes('【Ria】')), 'ria report')
    const report = calls.find(item => item.text.includes('【Ria】'))
    assert.ok(report.text.includes('ticket 已完成'))
    assert.equal(calls.filter(item => item.text.includes('【直通·Alpha】')).length, 1)
  } finally {
    fixture.cleanup()
  }
}

// ④ Bounded retry + visible failure + dedupe + no durable copy.
{
  const fixture = await createFixture({ stateDefault: true })
  const state = fixture.service.controller
  state.directBackoffMs = [5, 5, 5]
  state.directRetryWindowMs = 2000
  const sends = []
  fixture.service.wechatClaw.forwardAssistant = (text, event, options) => {
    sends.push({ text, seq: event && event.seq })
    if (options && typeof options.onSettled === 'function') options.onSettled({ reason: 'send_failed', error: 'boom' })
  }
  try {
    state.setDirect({ sessionId: 'session-x', title: 'X' })
    state.forwardDirectReply('A', { seq: 11 })
    state.forwardDirectReply('A', { seq: 11 })
    assert.equal(sends.filter(item => item.text === '【直通·X】\nA').length, 1, 'the same event is queued once')

    await waitFor(() => sends.some(item => item.text.includes('直通消息发送失败')), 'failure notice', 5000)
    const attempts = sends.filter(item => item.text === '【直通·X】\nA').length
    assert.equal(attempts, 4, 'initial send plus three bounded retries')
    const notice = sends.find(item => item.text.includes('直通消息发送失败'))
    assert.ok(notice.text.includes('已重试 3 次'), notice.text)
    assert.equal(state.directSendQueue.size, 0)
    // Live direct chatter never enters the durable outbox.
    assert.equal(fixture.service.outbox.all().filter(entry => entry.kind === WECHAT_ASSISTANT_NOTE_KIND).length, 0)

    // A delivered message dedupes a re-emitted event for the retry window.
    const delivered = []
    fixture.service.wechatClaw.forwardAssistant = (text, event, options) => {
      delivered.push(text)
      if (options && typeof options.onSettled === 'function') options.onSettled({ reason: 'delivered' })
    }
    state.forwardDirectReply('B', { seq: 12 })
    state.forwardDirectReply('B', { seq: 12 })
    assert.equal(delivered.length, 1)

    // Reset cancels queued retries: no replay after a reconnect.
    fixture.service.wechatClaw.forwardAssistant = (text, event, options) => {
      sends.push({ text })
      if (options && typeof options.onSettled === 'function') options.onSettled({ reason: 'send_failed' })
    }
    const before = sends.length
    state.forwardDirectReply('C', { seq: 13 })
    assert.equal(state.directSendQueue.size, 1)
    state.resetDirectSendQueue()
    assert.equal(state.directSendQueue.size, 0)
    await wait(60)
    assert.equal(sends.length, before + 1, 'reset stops further retries')
  } finally {
    fixture.cleanup()
  }
}

// ⑤ A long pause folds the assistant backlog to 5 + one summary.
{
  const fixture = await createFixture({ stateDefault: true })
  const service = fixture.service
  service.wechatClaw.peer = { userId: 'user-1', contextToken: 'context-1' }
  service.wechatClaw.lastInboundAt = Date.now()
  try {
    for (let index = 1; index <= 8; index += 1) {
      const at = new Date(Date.UTC(2026, 10, 19, 0, index, 0)).toISOString()
      assert.equal(service.notifyWechatAssistantFallback({ text: '补发' + index, reason: 'paused', eventSeq: index, at }), true)
    }
    const before = service.outbox.all().filter(entry => entry.kind === WECHAT_ASSISTANT_NOTE_KIND && entry.status === 'pending')
    assert.equal(before.length, 8)
    assert.equal(service.collapseAssistantBacklog(5), 3)
    const pending = service.outbox.all().filter(entry => entry.kind === WECHAT_ASSISTANT_NOTE_KIND && entry.status === 'pending')
    assert.equal(pending.length, 6, 'five recent replies plus one summary')
    const summary = pending.find(entry => entry.payload && entry.payload.reason === 'summary')
    assert.ok(summary)
    assert.match(summary.payload.text, /另有 3 条较早的补发消息未送达/)
    const texts = pending.map(entry => entry.payload.text)
    assert.ok(texts.includes('补发8'), 'the newest reply is kept')
    assert.equal(texts.includes('补发1'), false, 'the oldest replies are folded')
  } finally {
    fixture.cleanup()
  }
}

console.log('direct outbound ok')
