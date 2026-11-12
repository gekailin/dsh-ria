import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { DEFAULT_WECHAT_IMAGE_OPTIONS, imageMediaType } from '../lib/wechat/image.mjs'
import { Outbound } from '../lib/wechat/outbound.mjs'
import { WechatService, extractAssistantImages } from '../lib/wechat/service.mjs'
import { WebWxClient } from '../lib/wechat/wxweb.mjs'

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64'
)
const wait = (ms = 20) => new Promise(resolve => setTimeout(resolve, ms))

function fakeCtx() {
  return {
    on() { return () => {} },
    sessionController: { async prompt() { return { accepted: true } } },
  }
}

function makeService(dir, options = {}) {
  return new WechatService({
    ctx: fakeCtx(),
    stateDir: dir,
    ensureRia: async () => 'ria-1',
    getRiaId: () => 'ria-1',
    ...options,
  })
}

const dir = await mkdtemp(join(tmpdir(), 'dsh-ria-wechat-image-'))
try {
  assert.equal(imageMediaType(PNG), 'image/png')
  assert.equal(DEFAULT_WECHAT_IMAGE_OPTIONS.outbound, true)

  // 1. WebWxClient uploads mediatype=pic with MediaType 3, then sends Type=3.
  {
    const originalFetch = globalThis.fetch
    const requests = []
    globalThis.fetch = async (url, options) => {
      requests.push({ url: String(url), options })
      return new Response(JSON.stringify({ BaseResponse: { Ret: 0 }, MediaId: '@img-media', Signature: 'sig' }), { status: 200 })
    }
    try {
      const client = new WebWxClient({
        base: 'https://wenjian.weixin.qq.com',
        cookie: 'a=1; webwx_data_ticket=ticket-value',
        passTicket: 'a%2Bb',
        uin: '42',
        sid: 'sid',
        skey: 'skey',
      })
      client.self = { UserName: '@self' }
      let sent
      client.request = async (path, options) => {
        sent = { path, options }
        return { BaseResponse: { Ret: 0 }, MsgID: 'msg-image-1' }
      }
      const id = await client.sendImage('filehelper', { name: 'shot.png', buffer: PNG, mime: 'image/png' })
      assert.equal(id, 'msg-image-1')
      assert.equal(requests.length, 1)
      assert.equal(requests[0].url, 'https://file.wx.qq.com/cgi-bin/mmwebwx-bin/webwxuploadmedia?f=json')
      const form = requests[0].options.body
      assert.equal(form.get('name'), 'shot.png')
      assert.equal(form.get('type'), 'image/png')
      assert.equal(form.get('mediatype'), 'pic')
      const upload = JSON.parse(form.get('uploadmediarequest'))
      assert.equal(upload.MediaType, 3)
      assert.equal(upload.FileMd5, createHash('md5').update(PNG).digest('hex'))
      assert.equal(sent.path, '/cgi-bin/mmwebwx-bin/webwxsendmsgimg')
      assert.equal(sent.options.query.fun, 'async')
      assert.equal(sent.options.body.Msg.Type, 3)
      assert.equal(sent.options.body.Msg.MediaId, '@img-media')
      assert.equal(client.sentIds.has('msg-image-1'), true)
    } finally {
      globalThis.fetch = originalFetch
    }
  }

  // 2. Outbound sends images through the same serial queue, and pause rejects.
  {
    const events = []
    const outbound = new Outbound({
      gapMs: 0,
      prefix: '',
      async send(text) { events.push(['text', text]); return 'text-id' },
      async sendImage(name, buffer, mime) { events.push(['image', name, buffer.length, mime]); return 'image-id' },
    })
    assert.equal(await outbound.enqueueImage({ name: 'a.png', buffer: PNG, mime: 'image/png' }), 'image-id')
    assert.deepEqual(events, [['image', 'a.png', PNG.length, 'image/png']])
    outbound.setPaused(true)
    await assert.rejects(() => outbound.enqueueImage({ name: 'b.png', buffer: PNG }), error => error.code === 'WECHAT_PAUSED')
  }

  // 3. A local markdown image is sent as an image; the syntax leaves the text.
  {
    await writeFile(join(dir, 'shot.png'), PNG)
    const service = makeService(dir)
    const texts = []
    const images = []
    service.outbound = {
      async enqueue(text) { texts.push(text); return 'text-id' },
      async enqueueFile() { throw new Error('not used') },
      async enqueueImage(image) { images.push(image); return 'image-id' },
    }
    service.forwardAssistant('看图：\n\n![shot](shot.png)\n\n完成')
    await wait()
    assert.deepEqual(texts, ['看图：\n\n完成'])
    assert.equal(images.length, 1)
    assert.equal(images[0].name, 'shot.png')
    assert.equal(images[0].mime, 'image/png')
    assert.deepEqual(images[0].buffer, PNG)
  }

  // 4. Missing file: keep the markdown text, never fail the reply.
  {
    const service = makeService(dir)
    const texts = []
    const images = []
    service.outbound = {
      async enqueue(text) { texts.push(text); return 'text-id' },
      async enqueueFile() { throw new Error('not used') },
      async enqueueImage(image) { images.push(image); return 'image-id' },
    }
    service.forwardAssistant('![gone](gone.png)')
    await wait()
    assert.deepEqual(texts, ['![gone](gone.png)'])
    assert.equal(images.length, 0)
  }

  // 5. Existing but non-image file: same text fallback.
  {
    await writeFile(join(dir, 'note.png'), 'plain text, not an image')
    const service = makeService(dir)
    const texts = []
    const images = []
    service.outbound = {
      async enqueue(text) { texts.push(text); return 'text-id' },
      async enqueueFile() { throw new Error('not used') },
      async enqueueImage(image) { images.push(image); return 'image-id' },
    }
    service.forwardAssistant('这是说明 ![note](note.png)')
    await wait()
    assert.deepEqual(texts, ['这是说明 ![note](note.png)'])
    assert.equal(images.length, 0)
  }

  // 6. Fenced examples are documentation, not images to send.
  {
    const result = extractAssistantImages('\x60\x60\x60\n![shot](shot.png)\n\x60\x60\x60', [dir])
    assert.equal(result.images.length, 0)
    assert.match(result.text, /!\[shot\]\(shot\.png\)/)
  }

  // 7. wechatImage.outbound:false keeps the markdown text and sends no image.
  {
    const service = makeService(dir, { wechatImage: { outbound: false } })
    const texts = []
    const images = []
    service.outbound = {
      async enqueue(text) { texts.push(text); return 'text-id' },
      async enqueueFile() { throw new Error('not used') },
      async enqueueImage(image) { images.push(image); return 'image-id' },
    }
    service.forwardAssistant('![shot](shot.png)')
    await wait()
    assert.deepEqual(texts, ['![shot](shot.png)'])
    assert.equal(images.length, 0)
  }

  // 8. Reconnection uses image extraction and waits for actual media completion.
  {
    const service = makeService(join(dir, 'backlog-image'))
    const source = '看图：\n\n![shot](' + join(dir, 'shot.png') + ')'
    const events = []
    let entered, release
    const started = new Promise(resolve => { entered = resolve })
    const gate = new Promise(resolve => { release = resolve })
    service.outbound = new Outbound({
      gapMs: 0, prefix: '',
      async send(text) { events.push(['text', text]); return 'text-id' },
      async sendImage(name) { events.push(['image', name]); entered(); await gate; return 'image-id' },
    })
    service.state.addOutbox(source)
    const flushing = service.flushOutbox()
    await started
    assert.equal(service.state.data.outbox.length, 1)
    release()
    await flushing
    assert.deepEqual(events, [['text', '看图：'], ['image', 'shot.png']])
    assert.equal(service.state.data.outbox.length, 0)
    assert.equal(makeService(join(dir, 'backlog-image')).state.data.outbox.length, 0)
  }

  // 9. Real image transport failure requires a completed explicit fallback.
  {
    const stateDir = join(dir, 'failed-image')
    const service = makeService(stateDir)
    const source = '![shot](' + join(dir, 'shot.png') + ')'
    let entered, release
    const started = new Promise(resolve => { entered = resolve })
    const gate = new Promise(resolve => { release = resolve })
    const texts = []
    service.outbound = new Outbound({
      gapMs: 0, prefix: '',
      async sendImage() { throw new Error('image upload unavailable') },
      async send(text) { texts.push(text); entered(); await gate; return 'fallback-id' },
    })
    service.state.addOutbox(source)
    const flushing = service.flushOutbox()
    await started
    assert.equal(service.state.data.outbox.length, 1)
    assert.match(texts[0], /图片 shot\.png 发送失败.*Ria 会话/)
    release()
    await flushing
    assert.equal(service.state.data.outbox.length, 0)
    assert.equal(makeService(stateDir).state.data.outbox.length, 0)
  }

  // 10. If the fallback transport also fails, retain the original for restart/retry.
  {
    const stateDir = join(dir, 'failed-fallback')
    const service = makeService(stateDir)
    const source = '![shot](' + join(dir, 'shot.png') + ')'
    service.outbound = new Outbound({
      gapMs: 0, prefix: '',
      async sendImage() { throw new Error('image upload unavailable') },
      async send() { throw new Error('fallback unavailable') },
    })
    service.state.addOutbox(source)
    await service.flushOutbox()
    assert.equal(service.lastError, 'fallback unavailable')
    const restarted = makeService(stateDir)
    assert.equal(restarted.state.data.outbox[0].text, source)
    const images = []
    restarted.outbound = new Outbound({
      gapMs: 0, prefix: '',
      async send() { throw new Error('unexpected text') },
      async sendImage(name) { images.push(name); return 'image-id' },
    })
    await restarted.flushOutbox()
    assert.deepEqual(images, ['shot.png'])
    assert.equal(restarted.state.data.outbox.length, 0)
  }

  console.log('wechat-image ok')
} finally {
  await rm(dir, { recursive: true, force: true })
}
