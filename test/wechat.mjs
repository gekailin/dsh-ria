import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_WECHAT_IMAGE_OPTIONS, imagePartFromMessage, isImageMessage, normalizeWechatImageOptions } from '../lib/wechat/image.mjs'
import { Outbound } from '../lib/wechat/outbound.mjs'
import { InboundBridge, WechatService, assistantText } from '../lib/wechat/service.mjs'

function fakeCtx() {
  const handlers = new Map()
  const prompts = []
  const signals = []
  return {
    handlers,
    prompts,
    signals,
    on(name, handler) {
      handlers.set(name, handler)
      return () => handlers.delete(name)
    },
    sessionController: {
      async prompt(request, signal) { prompts.push(request); signals.push(signal); return { accepted: true } },
    },
  }
}

function makeService(ctx, dir, overrides = {}) {
  return new WechatService({
    ctx,
    stateDir: dir,
    ensureRia: async () => 'ria-1',
    getRiaId: () => 'ria-1',
    ...overrides,
  })
}

const dir = await mkdtemp(join(tmpdir(), 'dsh-ria-wechat-'))
try {
  assert.equal(assistantText({ data: { message: { content: [
    { type: 'tool', text: 'ignored' },
    { type: 'text', text: 'first' },
    { type: 'text', text: 'second' },
  ] } } }), 'first\nsecond')
  assert.equal(assistantText({ data: { message: { content: [{ type: 'text', text: '  ' }] } } }), '')
  assert.equal(assistantText(undefined), '')

  {
    const ctx = fakeCtx()
    const service = makeService(ctx, dir)
    const dispose = service.subscribe()
    const sent = []
    service.session = { client: { sentIds: new Set() } }
    service.outbound = { async enqueue(text) { sent.push(text); return 'id' } }
    const handler = ctx.handlers.get('session/event')
    assert.equal(typeof handler, 'function')
    handler({ header: { id: 'ria-1' } }, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'hello' }] } } })
    await new Promise(resolve => setTimeout(resolve, 0))
    assert.deepEqual(sent, ['hello'])
    handler({ header: { id: 'other' } }, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'nope' }] } } })
    handler({ header: { id: 'ria-1' } }, { type: 'assistant/message', data: { interrupted: true, message: { content: [{ type: 'text', text: 'partial' }] } } })
    handler({ header: { id: 'ria-1' } }, { type: 'tool/call', data: {} })
    await new Promise(resolve => setTimeout(resolve, 0))
    assert.deepEqual(sent, ['hello'])
    dispose()
  }

  {
    const ctx = fakeCtx()
    const service = makeService(ctx, dir)
    service.session = { client: { sentIds: new Set(['echo-1']) } }
    const bridge = new InboundBridge(service)

    await bridge.handle({ id: 'echo-1', to: 'filehelper', type: 1, text: 'my own send' })
    assert.equal(ctx.prompts.length, 0)

    await bridge.handle({ id: 'msg-1', to: 'somewhere', type: 1, text: 'wrong peer' })
    assert.equal(ctx.prompts.length, 0)

    await bridge.handle({ id: 'msg-2', to: 'filehelper', type: 1, text: ' raw text ' })
    assert.equal(ctx.prompts.length, 1)
    assert.equal(ctx.prompts[0].sessionId, 'ria-1')
    assert.equal(ctx.prompts[0].mode, 'queue')
    assert.deepEqual(ctx.prompts[0].content, [{ type: 'text', text: ' raw text ' }])
    assert.equal(ctx.signals[0] instanceof AbortSignal, true)
    assert.equal(ctx.signals[0].aborted, false)
    assert.match(ctx.prompts[0].requestId, /^wx_/)

    await bridge.handle({ id: 'msg-2', to: 'filehelper', type: 1, text: ' raw text ' })
    assert.equal(ctx.prompts.length, 1)
    assert.equal(service.state.hasSeen('msg-2'), true)

    const restarted = makeService(ctx, dir)
    assert.equal(restarted.state.hasSeen('msg-2'), true)
  }

  {
    const ctx = fakeCtx()
    ctx.sessionController.prompt = async (_request, signal) => {
      assert.equal(signal instanceof AbortSignal, true)
      throw new Error('worker unavailable')
    }
    const service = makeService(ctx, dir)
    service.session = { client: { sentIds: new Set() } }
    const bridge = new InboundBridge(service)
    await bridge.handle({ id: 'msg-3', to: 'filehelper', type: 1, text: 'hello' })
    assert.equal(service.state.hasSeen('msg-3'), true)
  }

  {
    const ctx = fakeCtx()
    const service = makeService(ctx, dir)
    for (let i = 1; i <= 12; i += 1) service.state.addOutbox('old-' + i)
    const sent = []
    service.outbound = { async enqueue(text) { sent.push(text) } }
    await service.flushOutbox()
    assert.equal(sent.length, 11)
    assert.match(sent[0], /跳过 2 条/)
    assert.equal(sent[1], 'old-3')
    assert.equal(sent[10], 'old-12')
    assert.equal(service.state.data.outbox.length, 0)
  }

  {
    const logs = []
    const sent = []
    const ctx = fakeCtx()
    const service = makeService(ctx, dir, { log: (level, message) => logs.push({ level, message }) })
    service.session = { client: { sentIds: new Set() } }
    service.outbound = { async enqueue(text) { sent.push(text); return 'id' } }

    assert.equal(await service.sendDispatchNote('已把任务交给 Worker One。', { isTask: true }), true)
    assert.deepEqual(sent, ['📌 任务已派发：已把任务交给 Worker One。'])
    assert.equal(await service.sendDispatchNote('转述一句话给 Worker One。', { isTask: false }), true)
    assert.equal(sent[1], '📌 消息已转交：转述一句话给 Worker One。')

    service.setPaused(true, { by: 'manual', reason: '测试暂停' })
    const beforePause = sent.length
    assert.equal(await service.sendDispatchNote('暂停期间不要发。', { isTask: true }), false)
    assert.equal(sent.length, beforePause)
    const dropped = logs.find(item => /dropped outbound while paused/.test(item.message))
    assert.ok(dropped)
    assert.match(dropped.message, /dispatch-note/)
    assert.match(dropped.message, /测试暂停/)

    service.setPaused(false, { by: 'manual', reason: '测试恢复' })
    assert.equal(await service.sendDispatchNote('恢复后发送。', { isTask: true }), true)
    assert.equal(sent.at(-1), '📌 任务已派发：恢复后发送。')

    const offlineLogs = []
    const offline = makeService(fakeCtx(), dir, { log: (level, message) => offlineLogs.push({ level, message }) })
    assert.equal(await offline.sendDispatchNote('未登录时不要发。', { isTask: true }), false)
    assert.ok(offlineLogs.some(item => item.level === 'info' && /not connected/.test(item.message) && /dispatch note/.test(item.message)))
    assert.equal(offlineLogs.some(item => /dropped outbound/.test(item.message)), false)
  }

  {
    const logs = []
    const service = makeService(fakeCtx(), dir, { log: (level, message) => logs.push({ level, message }) })
    service.session = { client: {} }
    service.outbound = { async enqueue() { throw new Error('send failed') } }
    assert.equal(await service.sendDispatchNote('发送失败。', { isTask: true }), false)
    assert.ok(logs.some(item => item.level === 'warn' && /could not send dispatch note/.test(item.message) && /send failed/.test(item.message)))
  }

  {
    assert.deepEqual(DEFAULT_WECHAT_IMAGE_OPTIONS, { inbound: false, outbound: true })
    assert.deepEqual(normalizeWechatImageOptions(undefined), { inbound: false, outbound: true })
    assert.deepEqual(normalizeWechatImageOptions({ inbound: true, outbound: 'yes' }), { inbound: true, outbound: true })
    assert.equal(isImageMessage({ type: 3 }), true)
    assert.equal(isImageMessage({ type: '3' }), true)
    assert.equal(isImageMessage({ type: 1 }), false)
    await assert.rejects(() => imagePartFromMessage({ type: 3 }), /reserved but not implemented/)

    const sentTexts = []
    const withPrefix = new Outbound({ async send(text) { sentTexts.push(text); return 'id' } })
    await withPrefix.enqueue('hello')
    assert.deepEqual(sentTexts, ['🌊 hello'])
    sentTexts.length = 0
    await withPrefix.enqueue('plain', { prefix: false })
    assert.deepEqual(sentTexts, ['plain'])

    const images = []
    const outbound = new Outbound({
      async send() { return 'id' },
      async sendFile() { return 'id' },
      async sendImage(name, buffer, mime) { images.push([name, buffer.toString(), mime]); return 'image-id' },
    })
    assert.equal(await outbound.enqueueImage({ name: 'a.jpg', buffer: Buffer.from('x'), mime: 'image/jpeg' }), 'image-id')
    assert.deepEqual(images, [['a.jpg', 'x', 'image/jpeg']])
    outbound.setPaused(true)
    await assert.rejects(() => outbound.enqueueImage({ name: 'a.jpg', buffer: Buffer.from('x') }), error => error.code === 'WECHAT_PAUSED')
  }

  {
    // Default off: an image is still "unsupported", and text keeps working.
    const ctx = fakeCtx()
    const service = makeService(ctx, dir)
    const sent = []
    service.session = { client: { sentIds: new Set() } }
    service.outbound = { async enqueue(text) { sent.push(text); return 'id' } }
    const bridge = new InboundBridge(service)
    await bridge.handle({ id: 'img-off-1', to: 'filehelper', type: 3, text: '<img />' })
    assert.equal(ctx.prompts.length, 0)
    assert.ok(sent.some(text => /只能接收文本消息/.test(text)))
    await bridge.handle({ id: 'img-off-text', to: 'filehelper', type: 1, text: 'still text' })
    assert.equal(ctx.prompts.length, 1)
    assert.deepEqual(ctx.prompts[0].content, [{ type: 'text', text: 'still text' }])
  }

  {
    // Reserved inbound switch: recognition routes to the stub, text is unaffected.
    const ctx = fakeCtx()
    const service = makeService(ctx, dir, { wechatImage: { inbound: true } })
    service.session = { client: { sentIds: new Set() } }
    const delivered = []
    service.deliverImageFromWechat = async message => { delivered.push(message) }
    const bridge = new InboundBridge(service)
    await bridge.handle({ id: 'img-on-1', to: 'filehelper', type: 3, text: '<img />' })
    assert.equal(delivered.length, 1)
    assert.equal(delivered[0].id, 'img-on-1')
    assert.equal(ctx.prompts.length, 0)
    await bridge.handle({ id: 'img-on-text', to: 'filehelper', type: 1, text: 'text with images on' })
    assert.equal(ctx.prompts.length, 1)
    assert.deepEqual(ctx.prompts[0].content, [{ type: 'text', text: 'text with images on' }])
  }

  {
    const ctx = fakeCtx()
    const service = makeService(ctx, dir)
    assert.equal(service.statusView().loggedIn, false)
    assert.equal(service.statusView().login.phase, 'idle')
    service.session = { client: {}, self: { NickName: 'me', UserName: '@me' }, startedAt: '2026-01-01T00:00:00.000Z' }
    const view = service.statusView()
    assert.equal(view.loggedIn, true)
    assert.equal(view.nick, 'me')
    assert.equal(view.user, '@me')
    assert.equal(view.since, '2026-01-01T00:00:00.000Z')
  }

  console.log('wechat ok')
} finally {
  await rm(dir, { recursive: true, force: true })
}
