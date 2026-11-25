import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { createDecipheriv } from 'node:crypto'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { Outbound } from '../lib/wechat/outbound.mjs'
import { createFixture } from './support/ria-fixture.mjs'

// Every Claw/CDN request is intercepted by a loopback server. Never read
// credentials or contact a real channel. The test drives the real
// Chat -> controller -> Claw -> Outbound -> uploadClawFile -> sendmessage chain.
const fixture = await createFixture({ stateDefault: true })
const controller = fixture.service.controller
const chat = controller.state.chatSessionId
const claw = fixture.service.wechatClaw
const dir = fixture.stateDir
const good = join(dir, 'note-测试.txt')
const second = join(dir, 'second.md')
const missing = join(dir, 'missing.txt')
const large = join(dir, 'large.bin')
const empty = join(dir, 'empty.txt')
const noPerm = join(dir, 'no-perm.txt')
const directory = join(dir, 'directory')
const sensitive = [
  join(dir, '.env'),
  join(dir, 'secret.pem'),
  join(dir, 'secret.key'),
  join(dir, 'id_rsa_test'),
  join(dir, '.ssh', 'config'),
  join(dir, 'credentials.json'),
]
writeFileSync(good, 'hello claw file\n')
writeFileSync(second, '# second\n')
writeFileSync(large, Buffer.alloc(11 * 1024 * 1024))
writeFileSync(empty, '')
writeFileSync(noPerm, 'secret\n')
chmodSync(noPerm, 0o000)
mkdirSync(directory)
mkdirSync(join(dir, '.ssh'), { recursive: true })
for (const path of sensitive) writeFileSync(path, 'sensitive\n')
const send = args => fixture.callAs(chat, 'ria_chat_send_file', args)
let server
let originalFetch
try {
  // No account: readable error and no HTTP calls.
  let result = await send({ paths: [good] })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'claw_not_connected')
  const forbidden = await controller.chatSendFile({ paths: [good] }, { agent: { id: 'session-not-chat' } })
  assert.equal(forbidden.code, 'forbidden')

  // Parameter validation (call the controller where the tool schema would
  // reject first, so the controller's explicit error codes are exercised).
  assert.equal((await send({ paths: [] })).code, 'invalid_paths')
  assert.equal((await send({ paths: [good, second, good, second] })).code, 'too_many_paths')
  assert.equal((await send({ paths: ['relative.txt'] })).results[0].code, 'path_not_absolute')
  assert.equal((await controller.chatSendFile({ paths: [good], caption: 1 }, { agent: { id: chat } })).code, 'caption_invalid')
  assert.equal((await send({ paths: [good], caption: 'x'.repeat(2001) })).code, 'caption_too_long')

  // Sensitive paths are rejected even when the file exists; all six classes.
  for (const path of sensitive) {
    const checked = await controller.chatSendFile({ paths: [path] }, { agent: { id: chat } })
    assert.equal(checked.results[0].code, 'forbidden_path', path)
  }

  // The old 10MB local rejection is gone: an 11MB file passes local validation
  // and reaches the channel gate (no claw connection here, so that is the first
  // reported error).
  let checked = await controller.chatSendFile({ paths: [large] }, { agent: { id: chat } })
  assert.equal(checked.results[0].code, 'claw_not_connected')
  checked = await controller.chatSendFile({ paths: [missing] }, { agent: { id: chat } })
  assert.equal(checked.results[0].code, 'not_found')
  checked = await controller.chatSendFile({ paths: [empty] }, { agent: { id: chat } })
  assert.equal(checked.results[0].code, 'file_empty')
  checked = await controller.chatSendFile({ paths: [directory] }, { agent: { id: chat } })
  assert.equal(checked.results[0].code, 'invalid_path')
  if (typeof process.getuid !== 'function' || process.getuid() !== 0) {
    checked = await controller.chatSendFile({ paths: [noPerm] }, { agent: { id: chat } })
    assert.equal(checked.results[0].code, 'permission_denied')
  }

  // Mock the real Claw sendFile chain (CDN upload + sendmessage file_item).
  const uploads = [], uploadRequests = [], sends = []
  let base
  let rejectUpload = false
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
        if (rejectUpload) { response.writeHead(400); response.end('mock channel reject: too large (20MB)'); return }
        response.writeHead(200, { 'x-encrypted-param': 'mock-encrypted-param' }); response.end()
      } else if (request.url === '/ilink/bot/sendmessage') {
        sends.push(JSON.parse(raw.toString()))
        json({ ret: 0, msg_id: 'mock-file-msg-' + sends.length })
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
  claw.outbound = new Outbound({
    send: text => claw.sendText(text),
    sendFile: (name, buffer) => claw.sendFile(name, buffer),
    sendImage: (name, buffer) => claw.sendImage(name, buffer),
    log: () => {},
  })

  result = await send({ paths: [good, second], caption: 'mock caption' })
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(result.sent, 2)
  assert.equal(result.failed, 0)
  assert.equal(result.results.length, 2)
  assert.ok(result.results.every(item => item.ok && item.messageId))
  assert.equal(sends[0].msg.item_list[0].type, 1)
  assert.match(sends[0].msg.item_list[0].text_item.text, /mock caption/)
  const fileSends = sends.filter(body => body.msg.item_list[0].type === 4)
  assert.equal(fileSends.length, 2)
  for (let index = 0; index < fileSends.length; index += 1) {
    const item = fileSends[index].msg.item_list[0]
    assert.ok(item.file_item)
    assert.equal(item.file_item.file_name, index === 0 ? 'note-测试.txt' : 'second.md')
    assert.equal(item.file_item.media.encrypt_type, 1)
    assert.equal(item.file_item.media.encrypt_query_param, 'mock-encrypted-param')
    assert.equal(item.file_item.len, String((index === 0 ? 'hello claw file\n' : '# second\n').length))
    const hexKey = Buffer.from(item.file_item.media.aes_key, 'base64').toString('utf8')
    assert.equal(uploadRequests[index].media_type, 3)
    assert.equal(uploadRequests[index].aeskey, hexKey)
    const decipher = createDecipheriv('aes-128-ecb', Buffer.from(hexKey, 'hex'), null)
    assert.deepEqual(Buffer.concat([decipher.update(uploads[index]), decipher.final()]), Buffer.from(index === 0 ? 'hello claw file\n' : '# second\n'))
  }

  // A partial batch is not an overall failure: one good, one missing, one
  // sensitive path, with a complete result row for each.
  result = await controller.chatSendFile({ paths: [good, missing, sensitive[0]] }, { agent: { id: chat } })
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(result.partial, true)
  assert.equal(result.sent, 1)
  assert.equal(result.failed, 2)
  assert.deepEqual(result.results.map(item => item.ok), [true, false, false])
  assert.equal(result.results[1].code, 'not_found')
  assert.equal(result.results[2].code, 'forbidden_path')

  // An upload rejection is a per-path upload_failed, not a thrown call.
  rejectUpload = true
  const uploadFailed = await controller.chatSendFile({ paths: [good] }, { agent: { id: chat } })
  assert.equal(uploadFailed.ok, false)
  assert.equal(uploadFailed.results[0].code, 'upload_failed')
  assert.equal(uploadFailed.results[0].message, 'mock channel reject: too large (20MB)')
  rejectUpload = false

  // 11MB reaches the mocked channel upload handoff instead of being rejected by Ria.
  {
    const calls = []
    const originalEnqueueFile = claw.outbound.enqueueFile
    claw.outbound.enqueueFile = async ({ name, buffer }) => { calls.push({ name, bytes: buffer.length }); return 'large-mock-id' }
    try {
      const largeResult = await controller.chatSendFile({ paths: [large] }, { agent: { id: chat } })
      assert.equal(largeResult.ok, true, JSON.stringify(largeResult))
      assert.equal(calls.length, 1)
      assert.equal(calls[0].bytes, 11 * 1024 * 1024)
    } finally {
      claw.outbound.enqueueFile = originalEnqueueFile
    }
  }

  // A channel-side oversized error keeps its original code and raw message.
  {
    const originalEnqueueFile = claw.outbound.enqueueFile
    claw.outbound.enqueueFile = async () => { throw Object.assign(new Error('channel says file too large'), { code: 'file_too_large' }) }
    try {
      const channelLarge = await controller.chatSendFile({ paths: [good] }, { agent: { id: chat } })
      assert.equal(channelLarge.results[0].code, 'file_too_large')
      assert.equal(channelLarge.results[0].message, 'channel says file too large')
    } finally {
      claw.outbound.enqueueFile = originalEnqueueFile
    }
  }

  // Claw unavailable states remain readable and never send.
  const beforePaused = sends.length
  claw.paused = true
  assert.equal((await send({ paths: [good] })).code, 'claw_paused')
  assert.equal(sends.length, beforePaused)
  claw.paused = false
  claw.peer = undefined
  assert.equal((await send({ paths: [good] })).code, 'claw_no_peer')
  claw.peer = { userId: 'mock-user', contextToken: 'mock-context' }
  const originalEnqueueFile = claw.outbound.enqueueFile
  claw.outbound.enqueueFile = undefined
  assert.equal((await controller.chatSendFile({ paths: [good] }, { agent: { id: chat } })).code, 'channel_unsupported')
  claw.outbound.enqueueFile = originalEnqueueFile

  // The same serial queue interleaves a file and an image without reordering:
  // the image starts only after the file job resolves.
  let release
  const gate = new Promise(resolve => { release = resolve })
  const order = []
  const queue = new Outbound({
    send: async () => {},
    sendFile: async () => { order.push('file-start'); await gate; order.push('file-end') },
    sendImage: async () => { order.push('image') },
    log: () => {},
  })
  const fileJob = queue.enqueueFile({ name: 'a.txt', buffer: Buffer.from('a') })
  const imageJob = queue.enqueueImage({ name: 'a.png', buffer: Buffer.from('png') })
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.deepEqual(order, ['file-start'])
  release()
  await fileJob
  await imageJob
  assert.deepEqual(order, ['file-start', 'file-end', 'image'])

  console.log('state chat send_file mock ok')
} finally {
  try { chmodSync(noPerm, 0o600) } catch { /* already restored */ }
  if (originalFetch) globalThis.fetch = originalFetch
  if (server) await new Promise(resolve => server.close(resolve))
  try { await claw.shutdown() } catch { /* already stopped */ }
  fixture.cleanup()
}
