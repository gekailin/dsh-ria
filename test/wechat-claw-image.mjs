import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDecipheriv, randomBytes } from 'node:crypto'
import { WechatClawService } from '../lib/channels/wechat-claw.mjs'
import {
  DEFAULT_WECHAT_CLAW_IMAGE_OPTIONS,
  encryptAesEcb,
  normalizeWechatClawImageOptions,
} from '../lib/channels/wechat-claw-image.mjs'
import { Outbound } from '../lib/wechat/outbound.mjs'

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64'
)
const wait = (ms = 20) => new Promise(resolve => setTimeout(resolve, ms))

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = []
    request.on('data', chunk => chunks.push(chunk))
    request.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')) } catch (error) { reject(error) }
    })
    request.on('error', reject)
  })
}

function readRawBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = []
    request.on('data', chunk => chunks.push(chunk))
    request.on('end', () => resolve(Buffer.concat(chunks)))
    request.on('error', reject)
  })
}

function json(response, value, headers = {}) {
  const body = JSON.stringify(value)
  response.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), ...headers })
  response.end(body)
}

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
}

function makeClaw(dir, options = {}) {
  const validate = []
  const prompts = []
  const notices = []
  const ctx = {
    on() { return () => {} },
    get(name) {
      if (name !== 'attachments') return undefined
      return {
        imageLimits: { maxImageBytes: options.maxImageBytes || 20 * 1024 * 1024 },
        validateImageBatch(list) { validate.push(list) },
      }
    },
    sessionController: {
      prompt(args) {
        prompts.push(args)
        return Promise.resolve({ accepted: true })
      },
    },
  }
  const claw = new WechatClawService({
    ctx,
    stateDir: dir,
    ensureRia: async () => 'ria-session',
    getRiaId: () => 'ria-session',
    log: () => {},
    imageOptions: options.imageOptions,
  })
  claw.session = {
    token: 'token-1',
    baseUrl: options.baseUrl || 'http://127.0.0.1:1',
    abort: new AbortController(),
  }
  claw.peer = { userId: 'user-1', contextToken: 'context-1' }
  claw.outbound = {
    enqueue(text) { notices.push(text); return Promise.resolve('msg-1') },
    enqueueImage() { return Promise.resolve('msg-2') },
    setPaused() {},
  }
  return { claw, prompts, notices, validate }
}

// Pure option normalization and the public defaults.
{
  assert.deepEqual(normalizeWechatClawImageOptions(), { inbound: true, outbound: true })
  assert.deepEqual(normalizeWechatClawImageOptions({ inbound: false }), { inbound: false, outbound: true })
  assert.deepEqual({ ...DEFAULT_WECHAT_CLAW_IMAGE_OPTIONS }, { inbound: true, outbound: true })
}

const dir = mkdtempSync(join(tmpdir(), 'dsh-ria-claw-image-'))
const server = createServer(async (request, response) => {
  const url = new URL(request.url, 'http://127.0.0.1')
  if (url.pathname === '/download') {
    const mode = url.searchParams.get('mode') || 'ok'
    if (mode === 'fail') { response.writeHead(500); response.end('nope'); return }
    const body = mode === 'large' ? Buffer.concat([PNG, Buffer.alloc(2000)]) : mode === 'bad' ? Buffer.from('not an image') : PNG
    response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': body.length })
    response.end(body)
    return
  }
  if (url.pathname === '/upload') {
    const body = await readRawBody(request)
    uploads.push(body)
    if (uploadMode === 'reject') { response.writeHead(400); response.end('bad'); return }
    response.writeHead(200, { 'x-encrypted-param': 'encrypted-param-1' })
    response.end()
    return
  }
  if (url.pathname === '/ilink/bot/getuploadurl') {
    uploadRequests.push(await readJsonBody(request))
    if (uploadMode === 'no-upload') { json(response, { ret: 1 }); return }
    json(response, { ret: 0, upload_full_url: base + '/upload' })
    return
  }
  if (url.pathname === '/ilink/bot/sendmessage') {
    sends.push(await readJsonBody(request))
    json(response, { ret: 0, msg_id: 'sent-1' })
    return
  }
  response.writeHead(404)
  response.end()
})
let base = ''
let uploadMode = 'ok'
const uploads = []
const uploadRequests = []
const sends = []
await listen(server)
base = 'http://127.0.0.1:' + server.address().port

try {
  // Inbound success: CDN bytes are AES encrypted, decrypted, checked and saved,
  // then delivered as the original caption plus a host image part.
  {
    const key = randomBytes(16)
    const ciphertext = encryptAesEcb(PNG, key)
    const imageServer = createServer((request, response) => {
      response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': ciphertext.length })
      response.end(ciphertext)
    })
    await listen(imageServer)
    const imageBase = 'http://127.0.0.1:' + imageServer.address().port
    const { claw, prompts, validate } = makeClaw(dir)
    try {
      await claw.handleMessage(claw.session, {
        message_type: 1,
        message_id: 'claw-image-1',
        from_user_id: 'user-1',
        context_token: 'context-1',
        item_list: [
          { type: 1, text_item: { text: '看看这张图' } },
          { type: 2, image_item: { media: { full_url: imageBase + '/download' }, aeskey: key.toString('hex') } },
        ],
      })
      assert.equal(prompts.length, 1)
      const content = prompts[0].content
      assert.equal(content[0].type, 'text')
      assert.match(content[0].text, /看看这张图/)
      assert.match(content[0].text, /图片已保存：/)
      assert.equal(content[1].type, 'image')
      assert.equal(content[1].mediaType, 'image/png')
      assert.deepEqual(Buffer.from(content[1].data, 'base64'), PNG)
      assert.equal(validate.length, 1)
      assert.equal(validate[0][0].mediaType, 'image/png')
      const saved = content[0].text.match(/图片已保存：([^\n]+)/)[1].trim().replace(/）$/, '')
      assert.deepEqual(readFileSync(saved), PNG)
      assert.equal(statSync(saved).mode & 0o777, 0o600)
      assert.equal(statSync(dir + '/wechat-claw-inbound').mode & 0o777, 0o700)
    } finally {
      await new Promise(resolve => imageServer.close(resolve))
      await claw.shutdown()
    }
  }

  // A voice/file/generic non-image item still gets the old text-only notice.
  {
    const { claw, notices } = makeClaw(dir)
    await claw.handleMessage(claw.session, {
      message_type: 1,
      message_id: 'claw-voice-1',
      from_user_id: 'user-1',
      context_token: 'context-1',
      item_list: [{ type: 3, voice_item: { duration: 1000 } }],
    })
    assert.deepEqual(notices, ['目前只能接收文本消息。'])
    await claw.shutdown()
  }

  // Download failures, over-limit files and wrong magic bytes keep the caption
  // and append a visible failure line instead of dropping the message.
  {
    for (const [mode, maxImageBytes, expected] of [
      ['fail', undefined, /图片下载失败/],
      ['large', 1024, /图片超过/],
      ['bad', undefined, /只支持 PNG/],
    ]) {
      const { claw, prompts } = makeClaw(dir, { maxImageBytes })
      await claw.handleMessage(claw.session, {
        message_type: 1,
        message_id: 'claw-bad-' + mode,
        from_user_id: 'user-1',
        context_token: 'context-1',
        item_list: [
          { type: 1, text_item: { text: '原文字-' + mode } },
          { type: 2, image_item: { media: { full_url: base + '/download?mode=' + mode } } },
        ],
      })
      assert.equal(prompts.length, 1)
      assert.match(prompts[0].content[0].text, new RegExp('原文字-' + mode))
      assert.match(prompts[0].content[0].text, expected)
      assert.equal(prompts[0].content.length, 1)
      await claw.shutdown()
    }
  }

  // Inbound disabled: a pure image is refused; text still goes through.
  {
    const { claw, prompts, notices } = makeClaw(dir, { imageOptions: () => ({ inbound: false, outbound: true }) })
    await claw.handleMessage(claw.session, {
      message_type: 1,
      message_id: 'claw-off-1',
      from_user_id: 'user-1',
      context_token: 'context-1',
      item_list: [{ type: 2, image_item: { media: { full_url: base + '/download' } } }],
    })
    assert.deepEqual(notices, ['目前只能接收文本消息。'])
    assert.equal(prompts.length, 0)
    await claw.shutdown()
  }

  // Outbound success: getuploadurl -> encrypted CDN upload -> sendmessage with
  // an image_item that points at the returned x-encrypted-param.
  {
    const { claw } = makeClaw(dir, { baseUrl: base })
    uploads.length = 0
    uploadRequests.length = 0
    sends.length = 0
    await claw.sendImage('shot.png', PNG)
    assert.equal(uploadRequests.length, 1)
    const start = uploadRequests[0]
    assert.equal(start.media_type, 1)
    assert.equal(start.rawsize, PNG.length)
    assert.match(start.rawfilemd5, /^[0-9a-f]{32}$/)
    assert.match(start.aeskey, /^[0-9a-f]{32}$/)
    assert.equal(start.filesize, Math.ceil((PNG.length + 1) / 16) * 16)
    assert.equal(uploads.length, 1)
    assert.deepEqual(requireDecrypt(uploads[0], start.aeskey), PNG)
    assert.equal(sends.length, 1)
    const item = sends[0].msg.item_list[0]
    assert.equal(item.type, 2)
    assert.equal(item.image_item.media.encrypt_query_param, 'encrypted-param-1')
    assert.equal(item.image_item.media.encrypt_type, 1)
    // The wire format is base64 of the hex string (44 chars); base64 of the raw
    // bytes (24 chars) makes the client show a black, "expired" image.
    assert.equal(item.image_item.media.aes_key, Buffer.from(start.aeskey, 'utf8').toString('base64'))
    assert.equal(item.image_item.media.aes_key.length, 44)
    assert.equal(Buffer.from(item.image_item.media.aes_key, 'base64').toString('utf8'), start.aeskey)
    assert.equal(item.image_item.mid_size, uploads[0].length)
    await claw.shutdown()
  }

  // Upload failure is visible: the queue falls back to a text line instead of
  // swallowing the assistant reply.
  {
    const { claw, notices } = makeClaw(dir, { baseUrl: base })
    const outbound = new Outbound({
      send: text => { notices.push(text); return Promise.resolve('text-1') },
      sendImage: (name, buffer) => claw.sendImage(name, buffer),
      log: () => {},
    })
    claw.outbound = outbound
    writeFileSync(join(dir, 'shot.png'), PNG)
    uploadMode = 'no-upload'
    try {
      await claw.deliverAssistant('图片在这里\n\n![shot](shot.png)')
      assert.ok(notices.some(text => text.includes('图片 shot.png 发送失败')), JSON.stringify(notices))
      assert.ok(notices.some(text => text.includes('图片在这里')), JSON.stringify(notices))
    } finally {
      uploadMode = 'ok'
    }
    await claw.shutdown()
  }

  // Fenced code and outbound=off keep the Markdown as plain text; paused
  // forwards send nothing.
  {
    const { claw, notices } = makeClaw(dir)
    const outbound = new Outbound({
      send: text => { notices.push(text); return Promise.resolve('text-1') },
      sendImage: () => { throw new Error('must not upload fenced code') },
      log: () => {},
    })
    claw.outbound = outbound
    await claw.deliverAssistant('示例：\n\n\u0060\u0060\u0060\n![x](shot.png)\n\u0060\u0060\u0060\n')
    assert.equal(notices.length, 1)
    assert.match(notices[0], /!\[x\]\(shot\.png\)/)

    const off = makeClaw(dir, { imageOptions: () => ({ inbound: true, outbound: false }) })
    const offOutbound = new Outbound({
      send: text => { off.notices.push(text); return Promise.resolve('text-2') },
      sendImage: () => { throw new Error('outbound disabled') },
      log: () => {},
    })
    off.claw.outbound = offOutbound
    await off.claw.deliverAssistant('![shot](shot.png)')
    assert.equal(off.notices.length, 1)
    assert.match(off.notices[0], /!\[shot\]\(shot\.png\)/)

    const paused = makeClaw(dir)
    paused.claw.paused = true
    paused.claw.outbound = new Outbound({ send: () => { throw new Error('must not send') }, sendImage: () => { throw new Error('must not send') }, log: () => {} })
    paused.claw.forwardAssistant('![shot](shot.png)')
    await wait()
    assert.equal(paused.notices.length, 0)
    await claw.shutdown()
    await off.claw.shutdown()
    await paused.claw.shutdown()
  }
} finally {
  await new Promise(resolve => server.close(resolve))
  rmSync(dir, { recursive: true, force: true })
}

function requireDecrypt(buffer, keyHex) {
  // AES-128-ECB with PKCS#7 padding: decrypt and strip the padding to compare.
  const decipher = createDecipheriv('aes-128-ecb', Buffer.from(keyHex, 'hex'), null)
  return Buffer.concat([decipher.update(buffer), decipher.final()])
}


console.log('wechat-claw-image ok')
