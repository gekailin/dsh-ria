import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DEFAULT_INBOUND_IMAGE_MAX_BYTES,
  DEFAULT_WECHAT_IMAGE_OPTIONS,
  IMAGE_PLACEHOLDER,
  imageFailureText,
  imagePartFromMessage,
  parseImageContent,
  pruneInboundImages,
  receiveInboundImage,
} from '../lib/wechat/image.mjs'
import { InboundBridge, WechatService } from '../lib/wechat/service.mjs'
import { WebWxClient } from '../lib/wechat/wxweb.mjs'

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64'
)
const DAY = 24 * 60 * 60 * 1000

function imageMessage(id, content = '<img length="' + PNG.length + '" />') {
  return {
    id,
    from: '@user',
    to: 'filehelper',
    type: 3,
    text: content,
    raw: { MsgId: id, FromUserName: '@user', ToUserName: 'filehelper', MsgType: 3, Content: content },
  }
}

function fakeCtx(store) {
  const prompts = []
  return {
    prompts,
    on() { return () => {} },
    get(name) { return name === 'attachments' ? store : undefined },
    sessionController: {
      async prompt(request) { prompts.push(request); return { accepted: true } },
    },
  }
}

function makeService(dir, ctx, options = {}) {
  return new WechatService({
    ctx,
    stateDir: dir,
    ensureRia: async () => 'ria-1',
    getRiaId: () => 'ria-1',
    ...options,
  })
}

const dir = await mkdtemp(join(tmpdir(), 'dsh-ria-wechat-inbound-'))
try {
  // 1. Defaults: inbound is on unless explicitly disabled.
  assert.deepEqual(DEFAULT_WECHAT_IMAGE_OPTIONS, { inbound: true, outbound: true })
  assert.deepEqual(parseImageContent('<img msgid="7" length="68" cdnmidimgurl="http://x/y" />'), {
    attrs: { msgid: '7', length: '68', cdnmidimgurl: 'http://x/y' },
    caption: '',
  })
  assert.equal(parseImageContent('看这张 <img src="x" />').caption, '看这张')

  // 2. Web protocol: full image first, then webwxgetmedia on the file host.
  {
    const originalFetch = globalThis.fetch
    const requests = []
    globalThis.fetch = async (url, options) => {
      requests.push({ url: String(url), options })
      if (requests.length <= 2) return new Response('not found', { status: 404 })
      return new Response(PNG, { status: 200, headers: { 'content-type': 'image/png', 'content-length': String(PNG.length) } })
    }
    try {
      const client = new WebWxClient({
        base: 'https://wenjian.weixin.qq.com',
        cookie: 'webwx_data_ticket=ticket-value',
        uin: '42',
        sid: 'sid',
        skey: 'skey',
      })
      const bytes = await client.downloadImage({
        msgId: '123456789',
        mediaId: '@media-id',
        sender: '@user',
        encryFilename: 'photo.jpg',
      })
      assert.deepEqual(bytes, PNG)
      assert.equal(requests.length, 3)

      assert.equal(new URL(requests[0].url).pathname, '/cgi-bin/mmwebwx-bin/webwxgetmsgimg')
      assert.equal(new URL(requests[0].url).searchParams.get('MsgID'), '123456789')
      assert.equal(new URL(requests[0].url).searchParams.get('skey'), 'skey')
      assert.equal(new URL(requests[0].url).searchParams.get('mmweb_appid'), 'wx_webfilehelper')
      assert.equal(new URL(requests[0].url).searchParams.has('type'), false)
      assert.match(requests[0].options.headers.Cookie, /webwx_data_ticket=ticket-value/)

      assert.equal(new URL(requests[1].url).host, 'file.wx.qq.com')
      assert.equal(new URL(requests[2].url).host, 'file.wx.qq.com')
      assert.equal(new URL(requests[2].url).pathname, '/cgi-bin/mmwebwx-bin/webwxgetmedia')
      const media = new URL(requests[2].url).searchParams
      assert.equal(media.get('mediaid'), '@media-id')
      assert.equal(media.get('sender'), '@user')
      assert.equal(media.get('msgid'), '123456789')
      assert.equal(media.get('fromuser'), '42')
      assert.equal(media.get('webwx_data_ticket'), 'ticket-value')
      assert.equal(media.get('encryfilename'), 'photo.jpg')
    } finally {
      globalThis.fetch = originalFetch
    }
  }

  // 3. Transport size guard and missing login are explicit errors.
  {
    const originalFetch = globalThis.fetch
    try {
      globalThis.fetch = async () => new Response(PNG, {
        status: 200,
        headers: { 'content-type': 'image/png', 'content-length': String(PNG.length) },
      })
      const client = new WebWxClient({ base: 'https://wenjian.weixin.qq.com', skey: 'skey' })
      await assert.rejects(
        () => client.downloadImage({ msgId: '1', maxBytes: 10 }),
        error => error.code === 'image_too_large'
      )

      globalThis.fetch = async () => new Response('expired', { status: 401 })
      const noCookie = new WebWxClient({ base: 'https://wenjian.weixin.qq.com' })
      await assert.rejects(() => noCookie.downloadImage({ msgId: '1' }), error => error.code === 401)
    } finally {
      globalThis.fetch = originalFetch
    }
  }

  // 4. Download, validate, save, and expose the path as text.
  {
    const calls = []
    const client = {
      async downloadImage(args) {
        calls.push(args)
        return PNG
      },
    }
    const received = await receiveInboundImage(imageMessage(123456789), { client, stateDir: dir })
    assert.equal(received.mediaType, 'image/png')
    assert.equal(received.bytes, PNG.length)
    assert.deepEqual(Buffer.from(received.part.data, 'base64'), PNG)
    assert.match(received.name, /^\d{8}-\d{6}-123456789\.png$/)
    assert.equal(existsSync(received.path), true)
    assert.equal((await readFile(received.path)).equals(PNG), true)
    assert.match(received.text, new RegExp(IMAGE_PLACEHOLDER))
    assert.match(received.text, /（图片已保存：/)
    assert.equal(calls[0].msgId, '123456789')
    assert.equal(calls[0].sender, '@user')
    assert.equal(calls[0].maxBytes, DEFAULT_INBOUND_IMAGE_MAX_BYTES)

    const second = await receiveInboundImage(imageMessage(123456789), { client, stateDir: dir })
    assert.match(second.name, /-2\.png$/)
    assert.notEqual(second.path, received.path)

    const captioned = await receiveInboundImage(imageMessage(222, '看这张 <img length="68" />'), { client, stateDir: dir })
    assert.match(captioned.text, /^看这张/)
    assert.match(captioned.text, /（图片已保存：/)
  }

  // 5. Every download/validation failure is an explicit InboundImageError.
  {
    const base = imageMessage(333)
    const noClient = await receiveInboundImage(base, { stateDir: dir }).catch(error => error)
    assert.equal(noClient.code, 'image_no_client')

    const downloadFailure = await receiveInboundImage(base, {
      stateDir: dir,
      client: { async downloadImage() { throw new Error('network down') } },
    }).catch(error => error)
    assert.equal(downloadFailure.code, 'image_download_failed')
    assert.match(downloadFailure.reason, /network down/)

    const empty = await receiveInboundImage(base, {
      stateDir: dir,
      client: { async downloadImage() { return Buffer.alloc(0) } },
    }).catch(error => error)
    assert.equal(empty.code, 'image_empty')

    const tooLarge = await receiveInboundImage(base, {
      stateDir: dir,
      maxBytes: 16,
      client: { async downloadImage() { return PNG } },
    }).catch(error => error)
    assert.equal(tooLarge.code, 'image_too_large')

    const unknown = await receiveInboundImage(base, {
      stateDir: dir,
      client: { async downloadImage() { return Buffer.from('this is not an image') } },
    }).catch(error => error)
    assert.equal(unknown.code, 'image_unsupported')

    const notImage = await receiveInboundImage({ type: 1 }, { stateDir: dir }).catch(error => error)
    assert.equal(notImage.code, 'image_invalid')

    assert.match(imageFailureText(base, '下载失败'), new RegExp(IMAGE_PLACEHOLDER))
    assert.match(imageFailureText(base, '下载失败'), /\[图片接收失败：下载失败\]/)

    const part = await imagePartFromMessage(base, {
      stateDir: dir,
      client: { async downloadImage() { return PNG } },
    })
    assert.equal(part.type, 'image')
  }

  // 6. Retention by age and by file count.
  {
    const oldDir = join(dir, 'prune-old')
    await mkdir(oldDir, { recursive: true })
    const now = Date.now()
    for (const [name, age] of [['old.png', 40 * DAY], ['mid.png', 2 * DAY], ['new.png', 0]]) {
      await writeFile(join(oldDir, name), PNG)
      const at = new Date(now - age)
      await utimes(join(oldDir, name), at, at)
    }
    const removed = pruneInboundImages(oldDir, { retentionDays: 30, maxFiles: 2, now })
    assert.equal(removed.removed, 1)
    assert.equal(existsSync(join(oldDir, 'old.png')), false)
    assert.deepEqual((await readdir(oldDir)).sort(), ['mid.png', 'new.png'])

    const countDir = join(dir, 'prune-count')
    await mkdir(countDir, { recursive: true })
    for (const name of ['a.png', 'b.png', 'c.png']) {
      await writeFile(join(countDir, name), PNG)
      const at = new Date(now - (name === 'a.png' ? 3 : name === 'b.png' ? 2 : 1) * 1000)
      await utimes(join(countDir, name), at, at)
    }
    pruneInboundImages(countDir, { retentionDays: 30, maxFiles: 2, now })
    assert.deepEqual((await readdir(countDir)).sort(), ['b.png', 'c.png'])
  }

  // 7. Service fallback: download failure still delivers a visible text message.
  {
    const logs = []
    const ctx = fakeCtx()
    const service = makeService(dir, ctx, { log: (level, message) => logs.push({ level, message }) })
    service.session = {
      client: { sentIds: new Set(), async downloadImage() { throw new Error('network down') } },
    }
    await service.deliverImageFromWechat(imageMessage(444))
    assert.equal(ctx.prompts.length, 1)
    assert.deepEqual(ctx.prompts[0].content.map(part => part.type), ['text'])
    assert.match(ctx.prompts[0].content[0].text, new RegExp(IMAGE_PLACEHOLDER))
    assert.match(ctx.prompts[0].content[0].text, /\[图片接收失败：下载失败：network down\]/)
    assert.ok(logs.some(item => item.level === 'warn' && /image 444 rejected/.test(item.message)))
  }

  // 8. Host attachment validation failure degrades to text; a prompt rejection retries text.
  {
    const ctx = fakeCtx({
      imageLimits: { maxImageBytes: 1024 },
      validateImageBatch() { throw new Error('host rejected image') },
    })
    const service = makeService(dir, ctx)
    assert.equal(service.inboundImageMaxBytes, 1024)
    service.session = { client: { sentIds: new Set(), async downloadImage() { return PNG } } }
    await service.deliverImageFromWechat(imageMessage(555))
    assert.equal(ctx.prompts.length, 1)
    assert.match(ctx.prompts[0].content[0].text, /附件校验失败：host rejected image/)

    const retryCtx = fakeCtx()
    let attempts = 0
    retryCtx.sessionController.prompt = async request => {
      attempts += 1
      if (request.content.some(part => part.type === 'image')) throw new Error('agent rejected image')
      retryCtx.prompts.push(request)
      return { accepted: true }
    }
    const retry = makeService(dir, retryCtx)
    retry.session = { client: { sentIds: new Set(), async downloadImage() { return PNG } } }
    await retry.deliverImageFromWechat(imageMessage(666))
    assert.equal(attempts, 2)
    assert.equal(retryCtx.prompts.length, 1)
    assert.match(retryCtx.prompts[0].content[0].text, /\[图片接收失败：投递失败：agent rejected image\]/)
  }

  // 9. InboundBridge delivers the normal text+image composite through the service.
  {
    const ctx = fakeCtx()
    const service = makeService(dir, ctx)
    service.session = { client: { sentIds: new Set(), async downloadImage() { return PNG } } }
    const bridge = new InboundBridge(service)
    await bridge.handle(imageMessage(777))
    assert.equal(ctx.prompts.length, 1)
    assert.deepEqual(ctx.prompts[0].content.map(part => part.type), ['text', 'image'])
    assert.match(ctx.prompts[0].content[0].text, /（图片已保存：/)
    assert.equal(ctx.prompts[0].content[1].mediaType, 'image/png')
    assert.match(ctx.prompts[0].requestId, /^wx_/)
  }

  console.log('wechat-image-inbound ok')
} finally {
  await rm(dir, { recursive: true, force: true })
}
