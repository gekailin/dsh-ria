import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WechatClawService } from '../lib/channels/wechat-claw.mjs'
import { Outbound } from '../lib/wechat/outbound.mjs'
import { WECHAT_ASSISTANT_NOTE_KIND } from '../lib/outbox.mjs'
import { createFixture } from './support/ria-fixture.mjs'

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
)

async function waitFor(check, label) {
  const deadline = Date.now() + 2000
  while (Date.now() < deadline) {
    if (check()) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.fail(label + ' timed out')
}

function makeClaw({ stateDir, send, sendImage, imageOptions = { inbound: true, outbound: true }, onAssistantUndelivered } = {}) {
  const claw = new WechatClawService({
    ctx: { on() { return () => {} }, sessionController: { prompt: async () => {} } },
    stateDir,
    ensureRia: async () => 'ria-session',
    getRiaId: () => 'ria-session',
    log: () => {},
    imageOptions: () => imageOptions,
    onAssistantUndelivered,
  })
  claw.peer = { userId: 'user-1', contextToken: 'context-1' }
  claw.lastInboundAt = Date.now()
  claw.outbound = new Outbound({
    send: send || (async () => 'msg-id'),
    sendImage: sendImage || (async () => 'image-id'),
    log: () => {},
  })
  return claw
}

// A short reply goes out through the serial outbound queue, and the status view
// records that the turn was delivered.
{
  const dir = mkdtempSync(join(tmpdir(), 'dsh-ria-claw-forward-'))
  const sent = []
  try {
    const claw = makeClaw({ stateDir: dir, send: async text => { sent.push(text); return 'msg-1' } })
    claw.forwardAssistant('短回复', { seq: 1 })
    await waitFor(() => claw.lastAssistantForward && claw.lastAssistantForward.reason === 'delivered', 'short delivery')
    assert.equal(sent.length, 1)
    assert.equal(sent[0], '🌊 短回复')
    assert.equal(claw.lastAssistantForward.chars, 3)
    assert.equal(claw.lastAssistantForward.eventSeq, 1)
    assert.equal(claw.statusView().lastAssistantForward.reason, 'delivered')
    const logFile = join(dir, 'wechat-claw', 'assistant.log.jsonl')
    assert.equal(existsSync(logFile), true)
    const line = JSON.parse(readFileSync(logFile, 'utf8').trim().split('\n')[0])
    assert.equal(line.reason, 'delivered')
    assert.equal(line.chars, 3)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// A long report is split into several endpoint-safe messages and the tail is
// never replaced by a truncation note.
{
  const dir = mkdtempSync(join(tmpdir(), 'dsh-ria-claw-forward-'))
  const sent = []
  try {
    const claw = makeClaw({ stateDir: dir, send: async text => { sent.push(text); return 'msg-1' } })
    const text = '报告'.repeat(2500) + '结尾标记'
    claw.forwardAssistant(text, { seq: 2 })
    await waitFor(() => claw.lastAssistantForward && claw.lastAssistantForward.reason === 'delivered', 'long delivery')
    assert.ok(sent.length >= 2, 'a 5000-character report must be split before sendmessage')
    const joined = sent.join('')
    assert.ok(joined.includes('结尾标记'), 'the tail must survive chunking')
    assert.equal(joined.includes('已截断'), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// Markdown images are sent as image messages, not as a text path.
{
  const dir = mkdtempSync(join(tmpdir(), 'dsh-ria-claw-forward-'))
  const sent = []
  const images = []
  try {
    writeFileSync(join(dir, 'pic.png'), PNG_1X1)
    const claw = makeClaw({
      stateDir: dir,
      send: async text => { sent.push(text); return 'msg-1' },
      sendImage: async (name, buffer) => { images.push({ name, bytes: buffer.length }); return 'image-1' },
    })
    claw.forwardAssistant('图如下\n![pic](pic.png)', { seq: 3 })
    await waitFor(() => claw.lastAssistantForward && claw.lastAssistantForward.reason === 'delivered', 'image delivery')
    assert.equal(images.length, 1)
    assert.equal(images[0].name, 'pic.png')
    assert.equal(claw.lastAssistantForward.images, 1)
    assert.equal(claw.lastAssistantForward.imagesFailed, 0)
    assert.equal(sent.join('').includes('pic.png'), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// A rejected send keeps the iLink ret/errmsg and asks the host for a durable
// fallback copy instead of dropping the reply.
{
  const dir = mkdtempSync(join(tmpdir(), 'dsh-ria-claw-forward-'))
  const fallbacks = []
  try {
    const error = new Error('sendmessage ret=-2 errmsg=prepare failed')
    error.code = 'WECHAT_CLAW_SEND_REJECTED'
    error.ret = -2
    error.errmsg = 'prepare failed'
    const claw = makeClaw({
      stateDir: dir,
      send: async () => { throw error },
      onAssistantUndelivered: info => { fallbacks.push(info); return true },
    })
    claw.forwardAssistant('这条发不出去', { seq: 4 })
    await waitFor(() => claw.lastAssistantForward && claw.lastAssistantForward.reason === 'send_failed', 'send failure')
    const record = claw.lastAssistantForward
    assert.equal(record.ret, -2)
    assert.equal(record.errmsg, 'prepare failed')
    assert.equal(record.errorCode, 'WECHAT_CLAW_SEND_REJECTED')
    assert.equal(record.deliveredChunks, 0)
    assert.equal(record.totalChunks, 1)
    assert.equal(record.fallbackQueued, true)
    assert.equal(fallbacks.length, 1)
    assert.equal(fallbacks[0].text, '这条发不出去')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// Paused and disconnected channels record why the reply was skipped and still
// hand the text to the durable fallback path.
{
  const dir = mkdtempSync(join(tmpdir(), 'dsh-ria-claw-forward-'))
  const fallbacks = []
  try {
    const paused = makeClaw({
      stateDir: dir,
      send: async () => { throw new Error('must not send') },
      onAssistantUndelivered: info => { fallbacks.push(info); return true },
    })
    paused.paused = true
    paused.forwardAssistant('暂停时的回复', { seq: 5 })
    assert.equal(paused.lastAssistantForward.reason, 'paused')
    assert.equal(fallbacks.length, 1)
    assert.equal(fallbacks[0].reason, 'paused')

    const offline = makeClaw({
      stateDir: dir,
      onAssistantUndelivered: info => { fallbacks.push(info); return true },
    })
    offline.outbound = undefined
    offline.forwardAssistant('断线时的回复', { seq: 6 })
    assert.equal(offline.lastAssistantForward.reason, 'no_outbound')
    assert.equal(fallbacks.length, 2)
    assert.equal(fallbacks[1].reason, 'no_outbound')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// The service turns an undelivered assistant message into one durable note and
// pumps it through Claw. A deferred note stays pending without spending an
// attempt; an inbound message re-arms it instead of waiting for backoff.
{
  const fixture = await createFixture()
  const service = fixture.service
  const calls = []
  const original = service.wechatClaw.sendAssistantNote
  service.wechatClaw.lastInboundAt = Date.now()
  service.wechatClaw.sendAssistantNote = async (text, options) => {
    calls.push({ text, options })
    return true
  }
  try {
    assert.equal(service.notifyWechatAssistantFallback({ text: '补发正文', reason: 'send_failed', at: '2026-11-14T09:00:00.000Z', eventSeq: 1 }), true)
    await service.pumpOutbox('test-assistant-fallback')
    assert.equal(calls.length, 1)
    assert.equal(calls[0].text, '补发正文')
    assert.equal(calls[0].options.durable, true)
    const entry = service.outbox.all().find(item => item.kind === WECHAT_ASSISTANT_NOTE_KIND)
    assert.ok(entry)
    assert.equal(entry.status, 'delivered')
    assert.equal(entry.payload.reason, 'send_failed')

    service.wechatClaw.sendAssistantNote = async () => ({ deferred: true })
    assert.equal(service.notifyWechatAssistantFallback({ text: '稍后再发', reason: 'paused', at: '2026-11-14T09:01:00.000Z', eventSeq: 2 }), true)
    await service.pumpOutbox('test-assistant-deferred')
    const deferred = service.outbox.all().find(item => item.kind === WECHAT_ASSISTANT_NOTE_KIND && item.payload.eventSeq === 2)
    assert.equal(deferred.status, 'pending')
    assert.equal(deferred.attempts, 0)

    service.wechatClaw.sendAssistantNote = async (text, options) => {
      calls.push({ text, options })
      return true
    }
    const retried = await service.handleWechatClawInbound()
    assert.ok(retried >= 1)
    assert.equal(service.outbox.entry(deferred.id).status, 'delivered')
  } finally {
    service.wechatClaw.sendAssistantNote = original
    fixture.cleanup()
  }
}

console.log('wechat-claw-forward ok')
