import assert from 'node:assert/strict'
import { createHash, createDecipheriv } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { Outbound } from '../lib/wechat/outbound.mjs'
import { createFixture } from './support/ria-fixture.mjs'

// Every Session is a fixture; every HTTP request is intercepted and restricted
// to this loopback server. Never read account credentials or start/login Claw.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')
const sha = createHash('sha256').update(PNG).digest('hex')
const reply = [{ type: 'event', event: { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'image reviewed' }] } } } }]
const attempts = []
let rejectImages = false
let failUnknown = false
const fixture = await createFixture({
  stateDefault: true,
  imageLimits: { maxImageBytes: 10 * 1024 * 1024, maxImagesPerMessage: 5, maxMessageImageBytes: 20 * 1024 * 1024, mediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] },
  extraSessions: [{ sessionId: 'session-image-target', cwd: process.cwd(), title: 'Image Target' }],
  waitRecords: { 'session-image-target': reply },
  onPrompt(request) {
    if (request.sessionId !== 'session-image-target') return
    attempts.push(request)
    if (failUnknown) throw new Error('transport timeout: acceptance unknown')
    if (rejectImages && request.content.some(part => part.type === 'image')) {
      throw Object.assign(new Error('Model does not support image input'), { code: 'session/attachment-invalid', data: { reason: 'MODEL_DOES_NOT_SUPPORT_IMAGES' } })
    }
  },
})
const controller = fixture.service.controller
const chat = controller.state.chatSessionId
const claw = fixture.service.wechatClaw
const imagePath = join(fixture.stateDir, 'shot.png')
const secondPath = join(fixture.stateDir, 'shot-two.png')
const badPath = join(fixture.stateDir, 'not-image.png')
const largePath = join(fixture.stateDir, 'oversized.png')
const exactPath = join(fixture.stateDir, '10mb.png')
writeFileSync(imagePath, PNG)
writeFileSync(secondPath, PNG)
writeFileSync(badPath, 'not an image')
writeFileSync(largePath, Buffer.concat([PNG, Buffer.alloc(10 * 1024 * 1024 + 1 - PNG.length)]))
writeFileSync(exactPath, Buffer.concat([PNG, Buffer.alloc(10 * 1024 * 1024 - PNG.length)]))
const directory = join(fixture.stateDir, 'directory')
mkdirSync(directory)
const originalGet = fixture.ctx.get.bind(fixture.ctx)
fixture.ctx.get = name => name === 'attachments'
  ? { ...originalGet(name), imageHostPath: () => imagePath }
  : originalGet(name)
const send = args => fixture.callAs(chat, 'chat_send_image', args)
const directNotices = []
controller.notifyDirect = message => directNotices.push(message)
let server
let originalFetch
try {
  // Tool surfaces and optional image parameters.
  assert.ok(fixture.visibleTools(chat).includes('chat_send_image'))
  const schemas = fixture.agentTools.get(chat)
  assert.equal(schemas.get('chat_send_image').parameters.properties.paths.maxItems, 5)

  // Direct: keep the old string branch for text; encoded and stored image
  // parts preserve their identity/order through Claw.promptContent.
  controller.direct = { sessionId: 'session-image-target', title: 'Image Target' }
  const originalPrompt = controller.promptSession.bind(controller)
  const helperInputs = []
  controller.promptSession = (...args) => { helperInputs.push(args[1]); return originalPrompt(...args) }
  assert.equal(await controller.directRelay([{ type: 'text', text: 'plain direct' }], chat), true)
  assert.equal(helperInputs.at(-1), 'plain direct')
  const directContent = [{ type: 'text', text: 'see image' }, { type: 'image', mediaType: 'image/png', data: PNG.toString('base64'), name: 'shot.png' }]
  await claw.promptContent(chat, directContent)
  assert.strictEqual(helperInputs.at(-1), directContent)
  assert.strictEqual(attempts.at(-1).content, directContent)
  assert.equal(attempts.at(-1).mode, 'steer')
  const reference = { attachmentId: 'sha256:' + sha, mediaType: 'image/png', name: 'shot.png' }
  const storedContent = [{ type: 'text', text: 'stored image' }, { type: 'image', attachment: reference }]
  await controller.directRelay(storedContent, chat)
  assert.deepEqual(attempts.at(-1).content, storedContent)
  rejectImages = true
  const directBefore = attempts.length
  await controller.directRelay(directContent, chat)
  assert.equal(attempts.length, directBefore + 2)
  assert.equal(attempts.at(-1).requestId, attempts.at(-2).requestId)
  assert.equal(attempts.at(-1).content.length, 1)
  assert.match(attempts.at(-1).content[0].text, /图片未能附带/)
  assert.match(directNotices.at(-1), /图片未能附带/)
  rejectImages = false
  controller.direct = undefined
  controller.promptSession = originalPrompt

  // No account is configured: this must not prompt/login or make an HTTP call.
  let result = await send({ paths: [imagePath] })
  assert.equal(result.code, 'claw_not_connected')
  const forbidden = await controller.chatSendImage({ paths: [imagePath] }, { agent: { id: 'session-not-chat' } })
  assert.equal(forbidden.code, 'forbidden')

  // Mock the *real* Claw sendImage chain end-to-end with loopback endpoints.
  const uploads = [], uploadRequests = [], sends = []
  let rejectNextUpload = false
  let base
  server = createServer(async (request, response) => {
    try {
      const chunks = []
      for await (const chunk of request) chunks.push(chunk)
      const raw = Buffer.concat(chunks)
      const json = value => { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(value)) }
      if (request.url === '/ilink/bot/getuploadurl') {
        uploadRequests.push(JSON.parse(raw.toString()))
        json({ ret: 0, upload_full_url: base + '/upload' })
      } else if (request.url === '/upload') {
        uploads.push(raw)
        if (rejectNextUpload) { rejectNextUpload = false; response.writeHead(400); response.end('mock reject'); return }
        response.writeHead(200, { 'x-encrypted-param': 'mock-encrypted-param' }); response.end()
      } else if (request.url === '/ilink/bot/sendmessage') {
        sends.push(JSON.parse(raw.toString()))
        json({ ret: 0, msg_id: 'mock-msg-' + sends.length })
      } else { response.writeHead(404); response.end() }
    } catch (error) { response.writeHead(500); response.end(String(error)) }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  base = 'http://127.0.0.1:' + server.address().port
  originalFetch = globalThis.fetch
  globalThis.fetch = (url, options) => {
    const target = new URL(typeof url === 'string' ? url : url.url || String(url))
    assert.equal(target.origin, base, 'test must never call a real Claw/CDN endpoint')
    return originalFetch(url, options)
  }
  claw.session = { token: 'fake-test-token', baseUrl: base, abort: new AbortController() }
  claw.peer = { userId: 'mock-user', contextToken: 'mock-context' }
  claw.paused = false
  claw.outbound = new Outbound({ send: text => claw.sendText(text), sendImage: (name, buffer) => claw.sendImage(name, buffer), log: () => {} })
  result = await send({ paths: [imagePath, secondPath], caption: 'mock caption' })
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(result.results.length, 2)
  assert.ok(result.results.every(item => item.ok && item.messageId))
  assert.equal(sends[0].msg.item_list[0].type, 1)
  const imageSends = sends.filter(body => body.msg.item_list[0].type === 2)
  assert.equal(imageSends.length, 2)
  for (let i = 0; i < imageSends.length; i++) {
    const item = imageSends[i].msg.item_list[0]
    assert.ok(item.image_item)
    assert.equal(item.text_item, undefined)
    assert.equal(item.image_item.media.encrypt_query_param, 'mock-encrypted-param')
    assert.equal(item.image_item.media.encrypt_type, 1)
    assert.equal(item.image_item.media.aes_key.length, 44)
    assert.equal(item.image_item.media.full_url, undefined)
    assert.equal(item.image_item.data, undefined)
    assert.ok(!JSON.stringify(item).includes(PNG.toString('base64')))
    assert.ok(!JSON.stringify(item).includes('http'))
    assert.equal(uploadRequests[i].media_type, 1)
    const hexKey = Buffer.from(item.image_item.media.aes_key, 'base64').toString('utf8')
    assert.equal(hexKey, uploadRequests[i].aeskey)
    const decipher = createDecipheriv('aes-128-ecb', Buffer.from(hexKey, 'hex'), null)
    assert.deepEqual(Buffer.concat([decipher.update(uploads[i]), decipher.final()]), PNG)
    assert.equal(item.image_item.mid_size, uploads[i].length)
  }
  const beforeInvalid = sends.length
  for (const args of [{ paths: [] }, { paths: Array(6).fill(imagePath) }, { paths: [largePath] }, { paths: ['relative.png'] }, { paths: [badPath] }, { paths: [directory] }, { paths: [join(fixture.stateDir, 'missing.png')] }, { paths: [exactPath, exactPath, exactPath] }]) {
    result = await send(args)
    assert.equal(result.ok, false, JSON.stringify(result))
    assert.ok(result.message)
    assert.equal(sends.length, beforeInvalid)
  }
  result = await send({ paths: [badPath, imagePath] })
  assert.equal(result.results[0].ok, false)
  assert.equal(result.results[1].ok, true)
  rejectNextUpload = true
  result = await send({ paths: [imagePath, secondPath] })
  assert.equal(result.ok, false)
  assert.equal(result.results[0].ok, false)
  assert.equal(result.results[1].ok, true)
  claw.paused = true
  const pausedBefore = sends.length
  assert.equal((await send({ paths: [imagePath] })).code, 'claw_paused')
  assert.equal(sends.length, pausedBefore)
  claw.paused = false
  claw.peer = undefined
  assert.equal((await send({ paths: [imagePath] })).code, 'claw_no_peer')
  console.log('state chat images/direct/send_image mock ok')
} finally {
  if (originalFetch) globalThis.fetch = originalFetch
  if (server) await new Promise(resolve => server.close(resolve))
  await claw.shutdown()
  fixture.cleanup()
}
