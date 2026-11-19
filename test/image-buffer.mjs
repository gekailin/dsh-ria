import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { InboundImageBuffer, DEFAULT_IMAGE_BUFFER_OPTIONS, normalizeImageBufferOptions } from '../lib/channels/image-buffer.mjs'
import { WechatClawService } from '../lib/channels/wechat-claw.mjs'
import { InboundBridge, WechatService } from '../lib/wechat/service.mjs'

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')

class FakeClock {
  time = 1000
  timers = new Map()
  next = 0
  now = () => this.time
  setTimeout = (callback, delay) => {
    const handle = { id: ++this.next, at: this.time + delay, callback, unref() {} }
    this.timers.set(handle.id, handle)
    return handle
  }
  clearTimeout = handle => this.timers.delete(handle.id)
  async advance(ms) {
    const target = this.time + ms
    for (;;) {
      const timer = [...this.timers.values()].filter(item => item.at <= target).sort((a, b) => a.at - b.at || a.id - b.id)[0]
      if (!timer) break
      this.time = timer.at
      this.timers.delete(timer.id)
      await timer.callback()
    }
    this.time = target
  }
}

function harness(dir, kind, options = {}) {
  const clock = options.clock || new FakeClock()
  const prompts = []
  const events = []
  let downloads = 0
  const ctx = {
    on() { return () => {} },
    get(name) {
      if (name === 'attachments') return { validateImageBatch() {}, imageLimits: { maxImageBytes: 20 * 1024 * 1024 } }
    },
    sessionController: { async prompt(request) { prompts.push(request); return { accepted: true } } },
  }
  const common = {
    ctx, stateDir: dir, ensureRia: async () => 'ria-buffer-test', getRiaId: () => 'ria-buffer-test',
    imageBufferOptions: options.config, imageBufferClock: clock,
    onChannelEvent: event => events.push(event), log: () => {},
  }
  const service = kind === 'wechat-claw' ? new WechatClawService(common) : new WechatService(common)
  // Every byte source and prompt endpoint is mocked. No polling/login/outbound.
  service.beginTyping = () => {}
  service.notify = async () => {}
  service.notifyWechat = async () => {}
  service.session = kind === 'wechat-claw'
    ? { accountId: 'account-1', abort: new AbortController() }
    : { abort: new AbortController(), client: { sentIds: new Set(), async downloadImage() { downloads++; return PNG } } }
  service.peer = { userId: 'user-1', contextToken: 'token-1' }
  service.imageBuffer.resume()
  const bridge = kind === 'wechat' ? new InboundBridge(service) : null
  const image = (id, peer = 'user-1', count = 1) => kind === 'wechat-claw'
    ? service.handleMessage(service.session, {
      message_type: 1, message_id: id, from_user_id: peer, create_time_ms: 123456,
      item_list: Array.from({ length: count }, (_, index) => ({ type: 2, image_item: { file_name: id + '-' + index + '.png', media: { full_url: 'https://mock.invalid/' + id + '/' + index } } })),
    })
    : bridge.handle({ id, from: peer, to: 'filehelper', type: 3, time: 123456, text: '<img filename="' + id + '.png" length="' + PNG.length + '" />' })
  const text = (body, id = 'text-' + Math.random(), peer = 'user-1') => kind === 'wechat-claw'
    ? service.handleMessage(service.session, { message_type: 1, message_id: id, from_user_id: peer, item_list: [{ type: 1, text_item: { text: body } }] })
    : bridge.handle({ id, from: peer, to: 'filehelper', type: 1, text: body })
  return { service, clock, prompts, events, image, text, downloads: () => downloads }
}

const root = await mkdtemp(join(tmpdir(), 'dsh-ria-image-buffer-test-'))
const originalFetch = globalThis.fetch
let mockFetches = 0
let scenarios = 0
// Fail-closed mock: an accidental real network path fails this test.
globalThis.fetch = async url => {
  assert.ok(String(url).startsWith('https://mock.invalid/'), 'unexpected non-mock request: ' + url)
  mockFetches++
  return new Response(PNG, { headers: { 'content-type': 'image/png' } })
}
const run = async (name, fn) => { await fn(); scenarios++; console.log('PASS ' + name) }
const imageNames = prompt => prompt.content.filter(part => part.type === 'image').map(part => part.name)

try {
  await run('defaults and configurable normalization', async () => {
    assert.deepEqual(DEFAULT_IMAGE_BUFFER_OPTIONS, { timeoutMs: 120000, maxImages: 10 })
    assert.deepEqual(normalizeImageBufferOptions({ timeoutMs: 50, maxImages: 3 }), { timeoutMs: 50, maxImages: 3 })
    assert.deepEqual(normalizeImageBufferOptions({ timeoutMs: -1, maxImages: NaN }), DEFAULT_IMAGE_BUFFER_OPTIONS)
  })
  for (const kind of ['wechat-claw', 'wechat']) {
    let next = 0
    const create = (options = {}) => harness(join(root, kind + '-' + ++next), kind, options)
    const test = async (name, options, body) => run(kind + ': ' + name, async () => {
      const h = create(options)
      try { await body(h) } finally { await h.service.shutdown() }
    })

    await test('image + text creates exactly one multimodal prompt', {}, async h => {
      await h.image('one')
      assert.equal(h.prompts.length, 0)
      const pending = h.service.imageBuffer.pending('ria-buffer-test', 'user-1')
      assert.equal(pending.length, 1)
      assert.equal(pending[0].size, PNG.length)
      assert.equal(pending[0].mime, 'image/png')
      assert.equal(pending[0].timestamp, 123456)
      assert.equal(pending[0].sourceMessageId, 'one')
      assert.ok(pending[0].fileName.startsWith('one'))
      await h.text('请解释这张图', 'caption')
      assert.equal(h.prompts.length, 1)
      assert.deepEqual(h.prompts[0].content.map(part => part.type), ['text', 'image'])
      assert.ok(h.prompts[0].content[0].text.startsWith('请解释这张图'))
      assert.equal(h.service.imageBuffer.pending('ria-buffer-test', 'user-1').length, 0)
      assert.equal(h.clock.timers.size, 0)
      assert.equal(h.events.at(-1).reason, 'text-arrived')
      for (const event of h.events) {
        assert.equal(event.sessionId, 'ria-buffer-test')
        assert.equal(event.payload.sessionId, 'ria-buffer-test')
        assert.equal(typeof event.payload.count, 'number')
        assert.ok(event.reason)
        assert.equal(event.payload.reason, event.reason)
      }
    })

    await test('three images retain arrival order on the next text', {}, async h => {
      for (const id of ['first', 'second', 'third']) await h.image(id)
      assert.equal(h.prompts.length, 0)
      const pending = h.service.imageBuffer.pending('ria-buffer-test', 'user-1')
      assert.deepEqual(pending.map(image => image.sourceMessageId), ['first', 'second', 'third'])
      const names = pending.map(image => image.path.split(/[\\/]/).pop())
      await h.text('all three')
      assert.equal(h.prompts.length, 1)
      assert.deepEqual(imageNames(h.prompts[0]), names)
      assert.equal(h.events.at(-1).payload.count, 3)
    })

    await test('only images flush once at the first-image deadline', {}, async h => {
      await h.image('old')
      await h.clock.advance(60000)
      await h.image('new')
      await h.clock.advance(59999)
      assert.equal(h.prompts.length, 0)
      await h.clock.advance(1)
      assert.equal(h.prompts.length, 1)
      assert.equal(imageNames(h.prompts[0]).length, 2)
      assert.equal(h.events.at(-1).reason, 'timeout')
      assert.equal(h.clock.timers.size, 0)
      await h.clock.advance(240000)
      assert.equal(h.prompts.length, 1)
    })

    await test('tenth image reaches default limit; eleventh starts a new batch', {}, async h => {
      for (let i = 0; i < 9; i++) await h.image('limit-' + i)
      assert.equal(h.prompts.length, 0)
      await h.image('limit-9')
      assert.equal(h.prompts.length, 1)
      assert.equal(imageNames(h.prompts[0]).length, 10)
      assert.equal(h.events.at(-1).reason, 'limit')
      assert.equal(h.service.imageBuffer.pending('ria-buffer-test', 'user-1').length, 0)
      assert.equal(h.clock.timers.size, 0)
      await h.image('limit-10')
      assert.equal(h.service.imageBuffer.pending('ria-buffer-test', 'user-1').length, 1)
      await h.text('eleventh only')
      assert.equal(h.prompts.length, 2)
      assert.equal(imageNames(h.prompts[1]).length, 1)
    })

    await test('duplicate image messageId is ignored before and after flush', {}, async h => {
      await h.image('duplicate')
      const fetched = mockFetches
      const downloaded = h.downloads()
      await h.image('duplicate')
      assert.equal(mockFetches, fetched)
      assert.equal(h.downloads(), downloaded)
      assert.equal(h.service.imageBuffer.pending('ria-buffer-test', 'user-1').length, 1)
      await h.text('flush duplicate')
      await h.image('duplicate')
      assert.equal(h.prompts.length, 1)
      assert.equal(h.service.imageBuffer.pending('ria-buffer-test', 'user-1').length, 0)
    })

    await test('plain text keeps old content/mode without a buffer event or timer', {}, async h => {
      await h.text('ordinary text')
      assert.equal(h.prompts.length, 1)
      assert.deepEqual(h.prompts[0].content, [{ type: 'text', text: 'ordinary text' }])
      assert.equal(h.prompts[0].mode, 'queue')
      assert.equal(h.clock.timers.size, 0)
      assert.equal(h.events.length, 0)
      assert.equal(h.service.imageBuffer.states.size, 0)
    })

    await test('missing ids are not conflated; numeric zero is deduplicated', {}, async h => {
      await h.image(undefined)
      await h.image(undefined)
      assert.equal(h.service.imageBuffer.pending('ria-buffer-test', 'user-1').length, 2)
      await h.text('two missing ids', 'missing-caption')
      assert.equal(h.prompts.length, 1)
      // The old WebWX protocol cannot download without MsgID/MediaId; retain
      // two visible failure entries rather than swallowing unidentified input.
      if (kind === 'wechat') {
        assert.equal(imageNames(h.prompts[0]).length, 0)
        assert.equal((h.prompts[0].content[0].text.match(/图片接收失败/g) || []).length, 2)
      } else assert.equal(imageNames(h.prompts[0]).length, 2)
      await h.image(0)
      await h.image(0)
      assert.equal(h.service.imageBuffer.pending('ria-buffer-test', 'user-1').length, 1)
      await h.text('zero id', 'zero-caption')
      assert.equal(h.prompts.length, 2)
      assert.equal(imageNames(h.prompts[1]).length, 1)
    })

    await test('peer isolation and equal ids from different users', {}, async h => {
      await h.image('shared-id', 'user-1')
      await h.image('shared-id', 'user-2')
      await h.text('second user', 't2', 'user-2')
      assert.equal(h.prompts.length, 1)
      assert.equal(imageNames(h.prompts[0]).length, 1)
      assert.equal(h.service.imageBuffer.pending('ria-buffer-test', 'user-1').length, 1)
      await h.text('first user', 't1', 'user-1')
      assert.equal(h.prompts.length, 2)
    })

    await test('timeout and text racing never deliver an image twice', { config: () => ({ timeoutMs: 50 }) }, async h => {
      await h.image('race')
      await Promise.all([h.clock.advance(50), h.text('at deadline')])
      assert.equal(h.prompts.flatMap(prompt => imageNames(prompt)).length, 1)
      assert.equal(h.events.filter(event => event.event === 'channel.image_flushed').length, 1)
      await h.clock.advance(500)
      assert.equal(h.prompts.flatMap(prompt => imageNames(prompt)).length, 1)
    })

    await test('config override triggers a two-image limit', { config: () => ({ maxImages: 2, timeoutMs: 25 }) }, async h => {
      await h.image('config-1')
      await h.image('config-2')
      assert.equal(h.prompts.length, 1)
      assert.equal(imageNames(h.prompts[0]).length, 2)
      assert.equal(h.events.at(-1).reason, 'limit')
      await h.clock.advance(25)
      assert.equal(h.prompts.length, 1)
    })

    await test('shutdown cleans timers; restored images are not swallowed', {}, async h => {
      await h.image('restore-me')
      const dir = h.service.stateDir
      await h.service.shutdown()
      assert.equal(h.clock.timers.size, 0)
      assert.equal(h.prompts.length, 0)
      const raw = JSON.parse(await readFile(join(dir, kind, 'image-buffer.json'), 'utf8'))
      assert.equal(raw.buffers[0].images[0].sourceMessageId, 'restore-me')
      assert.equal(raw.buffers[0].images[0].part.data, undefined)
      const restored = harness(dir, kind, { clock: h.clock })
      try {
        await restored.image('restore-me')
        assert.equal(restored.service.imageBuffer.pending('ria-buffer-test', 'user-1').length, 1)
        await restored.text('after reconnect')
        assert.equal(restored.prompts.length, 1)
        assert.equal(imageNames(restored.prompts[0]).length, 1)
      } finally { await restored.service.shutdown() }
    })
  }

  await run('one Claw message above the soft image limit flushes all once', async () => {
    const h = harness(join(root, 'overshoot'), 'wechat-claw', { config: () => ({ maxImages: 2 }) })
    try {
      await h.image('many', 'user-1', 3)
      assert.equal(h.prompts.length, 1)
      assert.equal(imageNames(h.prompts[0]).length, 3)
      assert.equal(h.events.at(-1).reason, 'limit')
      assert.equal(h.clock.timers.size, 0)
    } finally { await h.service.shutdown() }
  })

  await run('failed flush retains exact content/id; later text is preserved in order', async () => {
    const clock = new FakeClock()
    const attempts = []
    const accepted = []
    let online = false
    let next = 0
    const buffer = new InboundImageBuffer({
      channel: 'mock', clock, options: { maxImages: 1 }, requestId: () => 'batch-' + ++next,
      deliver: async (_sessionId, content, requestId) => {
        attempts.push({ content: structuredClone(content), requestId })
        if (!online) throw new Error('mock offline')
        accepted.push({ content, requestId })
      },
    })
    const submit = (messageId, input) => buffer.submit({ sessionId: 'mock-session', peerId: 'mock-peer', messageId, prepare: async () => input })
    await assert.rejects(submit('picture', { imageOnly: true, images: [{ part: { type: 'image', name: 'mock.png', mediaType: 'image/png', data: PNG.toString('base64') }, fileName: 'mock.png', size: PNG.length, mime: 'image/png' }] }), /mock offline/)
    await assert.rejects(submit('caption', { hasText: true, content: [{ type: 'text', text: 'later text' }] }), /mock offline/)
    online = true
    await clock.advance(1000)
    assert.equal(accepted.length, 2)
    assert.equal(accepted[0].requestId, attempts[0].requestId)
    assert.deepEqual(accepted[0].content, attempts[0].content)
    assert.equal(accepted[1].content[0].text, 'later text')
    assert.equal(clock.timers.size, 0)
    await buffer.shutdown()
  })

  await run('text wins before a queued timeout callback; stale callback is harmless', async () => {
    const h = harness(join(root, 'text-first'), 'wechat-claw', { config: () => ({ timeoutMs: 50 }) })
    try {
      await h.image('stale-timer')
      const expiredCallback = [...h.clock.timers.values()][0].callback
      await h.text('text first')
      h.clock.time += 50
      await expiredCallback()
      assert.equal(h.prompts.length, 1)
      assert.equal(h.events.at(-1).reason, 'text-arrived')
      assert.equal(h.clock.timers.size, 0)
    } finally { await h.service.shutdown() }
  })

  await run('slow image preparation and concurrent text retain submission order', async () => {
    const clock = new FakeClock()
    const prompts = []
    let release
    const gate = new Promise(resolve => { release = resolve })
    const buffer = new InboundImageBuffer({ channel: 'mock', clock, requestId: () => 'ordered-id', deliver: async (_id, content) => prompts.push(content) })
    const image = buffer.submit({ sessionId: 's', peerId: 'p', messageId: 'first-image', prepare: async () => {
      await gate
      return { imageOnly: true, images: [{ part: { type: 'image', name: 'ordered.png', mediaType: 'image/png', data: PNG.toString('base64') }, fileName: 'ordered.png', size: PNG.length, mime: 'image/png' }] }
    } })
    const text = buffer.submit({ sessionId: 's', peerId: 'p', messageId: 'next-text', prepare: async () => ({ hasText: true, content: [{ type: 'text', text: 'after slow image' }] }) })
    release()
    await Promise.all([image, text])
    assert.equal(prompts.length, 1)
    assert.deepEqual(prompts[0].map(part => part.type), ['text', 'image'])
    assert.equal(clock.timers.size, 0)
    await buffer.shutdown()
  })

  await run('host partially accepted a failed batch; same requestId prevents replay', async () => {
    const clock = new FakeClock()
    const receivedIds = new Set()
    const prompts = []
    const attempts = []
    let next = 0
    const buffer = new InboundImageBuffer({ channel: 'mock', clock, options: { maxImages: 1 }, requestId: () => 'stable-' + ++next, deliver: async (_id, content, requestId) => {
      attempts.push(requestId)
      if (receivedIds.has(requestId)) return { accepted: true }
      receivedIds.add(requestId)
      prompts.push(content)
      throw new Error('mock response lost after acceptance')
    } })
    await assert.rejects(buffer.submit({ sessionId: 's', peerId: 'p', messageId: 'image', prepare: async () => ({ imageOnly: true, images: [{ part: { type: 'image', name: 'accepted.png', data: PNG.toString('base64'), mediaType: 'image/png' }, fileName: 'accepted.png', size: PNG.length, mime: 'image/png' }] }) }), /response lost/)
    await clock.advance(1000)
    assert.equal(prompts.length, 1)
    assert.equal(attempts.length, 2)
    assert.equal(attempts[0], attempts[1])
    assert.equal(clock.timers.size, 0)
    await buffer.shutdown()
  })

  console.log(JSON.stringify({ imageBufferScenarios: scenarios, requiredScenariosPerWechatChannel: 6, realRequests: 0, mockImageFetches: mockFetches, fakeClock: true }))
} finally {
  globalThis.fetch = originalFetch
  await rm(root, { recursive: true, force: true })
}
