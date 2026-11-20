import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { WechatClawService } from '../lib/channels/wechat-claw.mjs'
import {
  CLAW_FILE_EXTENSIONS,
  CLAW_INBOUND_FILE_DIR,
  DEFAULT_WECHAT_CLAW_FILE_OPTIONS,
  FILE_PLACEHOLDER,
  clawFileItem,
  clawFileItems,
  formatFileSize,
  isAllowedClawFile,
  normalizeWechatClawFileOptions,
  receiveInboundClawFile,
  safeClawFileName,
  uploadClawFile,
} from '../lib/channels/wechat-claw-file.mjs'
import { encryptAesEcb } from '../lib/channels/wechat-claw-image.mjs'
import { createFixture } from './support/ria-fixture.mjs'

const PDF = Buffer.from('%PDF-1.4\nRia file transfer test\n%%EOF\n', 'utf8')
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
  const prompts = []
  const notices = []
  const ctx = {
    on() { return () => {} },
    get() { return undefined },
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
    fileOptions: options.fileOptions,
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
  return { claw, prompts, notices }
}

// Pure helpers: the allowlist, safe names, sizes and protocol item shape.
{
  assert.deepEqual(normalizeWechatClawFileOptions(), { enabled: true, maxBytes: 20 * 1024 * 1024 })
  assert.deepEqual(normalizeWechatClawFileOptions({ enabled: false, maxBytes: 1024 }), { enabled: false, maxBytes: 1024 })
  assert.deepEqual({ ...DEFAULT_WECHAT_CLAW_FILE_OPTIONS }, { enabled: true, maxBytes: 20 * 1024 * 1024 })
  assert.ok(CLAW_FILE_EXTENSIONS.includes('pdf'))
  assert.ok(CLAW_FILE_EXTENSIONS.includes('docx'))
  assert.ok(!CLAW_FILE_EXTENSIONS.includes('exe'))
  assert.equal(isAllowedClawFile('A.PDF'), true)
  assert.equal(isAllowedClawFile('run.sh'), false)
  assert.equal(safeClawFileName('../../etc/passwd.pdf'), 'passwd.pdf')
  assert.equal(safeClawFileName('..\\..\\evil.pdf'), 'evil.pdf')
  assert.equal(safeClawFileName(' .. '), 'file')
  assert.equal(formatFileSize(18), '18 B')
  assert.equal(formatFileSize(2048), '2 KB')
  assert.equal(formatFileSize(2 * 1024 * 1024), '2 MB')
  const item = clawFileItem({ downloadEncryptedQueryParam: 'param-1', aeskey: 'a'.repeat(32), ciphertextSize: 32, rawsize: PDF.length }, 'a.pdf')
  assert.equal(item.type, 4)
  assert.equal(item.file_item.file_name, 'a.pdf')
  assert.equal(item.file_item.len, String(PDF.length))
  assert.equal(item.file_item.media.encrypt_query_param, 'param-1')
  assert.equal(Buffer.from(item.file_item.media.aes_key, 'base64').toString('utf8'), 'a'.repeat(32))
  assert.deepEqual(clawFileItems({ item_list: [{ type: 4, file_item: {} }, { type: 2 }] }), [{ item: {}, index: 0 }])
}

const dir = mkdtempSync(join(tmpdir(), 'dsh-ria-claw-file-'))
const uploads = []
const uploadRequests = []
const sends = []
let uploadMode = 'ok'
let uploadAttempt = 0
const server = createServer(async (request, response) => {
  const url = new URL(request.url, 'http://127.0.0.1')
  if (url.pathname === '/download') {
    const key = url.searchParams.get('key')
    const body = url.searchParams.get('bad') === '1' ? Buffer.from('garbage') : encryptAesEcb(PDF, Buffer.from(key, 'hex'))
    response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': body.length })
    response.end(body)
    return
  }
  if (url.pathname === '/upload') {
    const body = await readRawBody(request)
    uploads.push(body)
    uploadAttempt += 1
    if (uploadMode === 'retry-once' && uploadAttempt === 1) {
      response.writeHead(500)
      response.end('try again')
      return
    }
    if (uploadMode === 'reject') {
      response.writeHead(400)
      response.end('bad')
      return
    }
    response.writeHead(200, { 'x-encrypted-param': 'encrypted-param-' + uploadAttempt })
    response.end()
    return
  }
  if (url.pathname === '/ilink/bot/getuploadurl') {
    uploadRequests.push(await readJsonBody(request))
    json(response, { ret: 0, upload_full_url: base + '/upload' })
    return
  }
  if (url.pathname === '/ilink/bot/sendmessage') {
    sends.push(await readJsonBody(request))
    json(response, { ret: 0, msg_id: 'sent-file-1' })
    return
  }
  response.writeHead(404)
  response.end()
})
let base = ''
await listen(server)
base = 'http://127.0.0.1:' + server.address().port

try {
  // Inbound file: encrypted CDN payload -> decrypt -> save -> explicit text
  // reference with the original name, size and absolute path.
  {
    const key = randomBytes(16)
    const download = base + '/download?key=' + key.toString('hex')
    const { claw, prompts } = makeClaw(dir)
    try {
      await claw.handleMessage(claw.session, {
        message_type: 1,
        message_id: 'claw-file-1',
        from_user_id: 'user-1',
        context_token: 'context-1',
        item_list: [
          { type: 1, text_item: { text: '文件在这儿' } },
          { type: 4, file_item: { media: { full_url: download, aes_key: Buffer.from(key.toString('hex'), 'utf8').toString('base64') }, file_name: '方案.pdf', len: String(PDF.length), md5: 'x' } },
        ],
      })
      assert.equal(prompts.length, 1)
      const text = prompts[0].content[0].text
      assert.match(text, /文件在这儿/)
      assert.match(text, /📎 文件：方案\.pdf（\d+ B）/)
      const saved = text.match(/路径：([^\n]+)/)[1].trim()
      assert.equal(dirname(saved), join(dir, CLAW_INBOUND_FILE_DIR))
      assert.ok(saved.endsWith('-方案.pdf'))
      assert.deepEqual(readFileSync(saved), PDF)
      assert.equal(statSync(saved).mode & 0o777, 0o600)
      assert.equal(statSync(dirname(saved)).mode & 0o777, 0o700)
      assert.equal(prompts[0].content.length, 1, 'files are delivered as text references, not host file parts')
      assert.equal(prompts[0].content[0].type, 'text')
    } finally {
      await claw.shutdown()
    }
  }

  // Traversal names are stripped to a basename; a pure file gets the placeholder
  // caption; unsupported and oversized files keep the message with a failure line.
  {
    const key = randomBytes(16)
    const download = base + '/download?key=' + key.toString('hex')
    const traversal = makeClaw(dir)
    try {
      await traversal.claw.handleMessage(traversal.claw.session, {
        message_type: 1,
        message_id: 'claw-file-traversal',
        from_user_id: 'user-1',
        context_token: 'context-1',
        item_list: [{ type: 4, file_item: { media: { full_url: download, aes_key: Buffer.from(key.toString('hex'), 'utf8').toString('base64') }, file_name: '../../evil.pdf', len: String(PDF.length) } }],
      })
      const text = traversal.prompts[0].content[0].text
      assert.match(text, new RegExp(FILE_PLACEHOLDER))
      const saved = text.match(/路径：([^\n]+)/)[1].trim()
      assert.equal(dirname(saved), join(dir, CLAW_INBOUND_FILE_DIR))
      assert.ok(saved.endsWith('-evil.pdf'))
    } finally {
      await traversal.claw.shutdown()
    }

    const cases = [
      { name: 'setup.exe', expected: /不支持的文件类型：exe/ },
      { name: 'large.pdf', len: String(8 * 1024 * 1024), expected: /超过 1 KB 上限/ },
    ]
    for (const test of cases) {
      const { claw, prompts } = makeClaw(dir, { fileOptions: () => ({ enabled: true, maxBytes: 1024 }) })
      try {
        await claw.handleMessage(claw.session, {
          message_type: 1,
          message_id: 'claw-file-bad-' + test.name,
          from_user_id: 'user-1',
          context_token: 'context-1',
          item_list: [
            { type: 1, text_item: { text: '原文字-' + test.name } },
            { type: 4, file_item: { media: { full_url: download, aes_key: Buffer.from(key.toString('hex'), 'utf8').toString('base64') }, file_name: test.name, len: test.len || String(PDF.length) } },
          ],
        })
        assert.equal(prompts.length, 1)
        const text = prompts[0].content[0].text
        assert.match(text, new RegExp('原文字-' + test.name.replace('.', '\\.')))
        assert.match(text, test.expected)
        assert.match(text, /\[文件接收失败：/)
      } finally {
        await claw.shutdown()
      }
    }

    const downloadFail = makeClaw(dir)
    try {
      await downloadFail.claw.handleMessage(downloadFail.claw.session, {
        message_type: 1,
        message_id: 'claw-file-download-fail',
        from_user_id: 'user-1',
        context_token: 'context-1',
        item_list: [
          { type: 1, text_item: { text: '还是原文' } },
          { type: 4, file_item: { media: { full_url: base + '/missing' }, file_name: 'x.pdf', len: '10' } },
        ],
      })
      assert.match(downloadFail.prompts[0].content[0].text, /还是原文/)
      assert.match(downloadFail.prompts[0].content[0].text, /文件下载失败/)
    } finally {
      await downloadFail.claw.shutdown()
    }

    const offText = makeClaw(dir, { fileOptions: () => ({ enabled: false }) })
    try {
      await offText.claw.handleMessage(offText.claw.session, {
        message_type: 1,
        message_id: 'claw-file-off-text',
        from_user_id: 'user-1',
        context_token: 'context-1',
        item_list: [
          { type: 1, text_item: { text: '这个文件给你' } },
          { type: 4, file_item: { media: { full_url: download }, file_name: 'x.pdf' } },
        ],
      })
      assert.equal(offText.prompts.length, 1)
      assert.match(offText.prompts[0].content[0].text, /这个文件给你/)
      assert.match(offText.prompts[0].content[0].text, /\[文件接收失败：文件接收已关闭\]/)
    } finally {
      await offText.claw.shutdown()
    }

    const off = makeClaw(dir, { fileOptions: () => ({ enabled: false }) })
    try {
      await off.claw.handleMessage(off.claw.session, {
        message_type: 1,
        message_id: 'claw-file-off',
        from_user_id: 'user-1',
        context_token: 'context-1',
        item_list: [{ type: 4, file_item: { media: { full_url: download }, file_name: 'x.pdf' } }],
      })
      assert.deepEqual(off.notices, ['目前文件接收已关闭。'])
      assert.equal(off.prompts.length, 0)
    } finally {
      await off.claw.shutdown()
    }
  }

  // Outbound: getuploadurl media_type=3 -> encrypted CDN body -> file_item.
  {
    const { claw } = makeClaw(dir, { baseUrl: base })
    uploads.length = 0
    uploadRequests.length = 0
    sends.length = 0
    uploadMode = 'ok'
    uploadAttempt = 0
    try {
      await claw.sendFile('方案.pdf', PDF)
      assert.equal(uploadRequests.length, 1)
      const start = uploadRequests[0]
      assert.equal(start.media_type, 3)
      assert.equal(start.to_user_id, 'user-1')
      assert.equal(start.rawsize, PDF.length)
      assert.match(start.filekey, /^[0-9a-f]{32}$/)
      assert.match(start.rawfilemd5, /^[0-9a-f]{32}$/)
      assert.equal(start.rawfilemd5, createHash('md5').update(PDF).digest('hex'))
      assert.match(start.aeskey, /^[0-9a-f]{32}$/)
      assert.equal(start.filesize, Math.ceil((PDF.length + 1) / 16) * 16)
      assert.equal(uploads.length, 1)
      assert.equal(sends.length, 1)
      const item = sends[0].msg.item_list[0]
      assert.equal(item.type, 4)
      assert.equal(item.file_item.file_name, '方案.pdf')
      assert.equal(item.file_item.len, String(PDF.length))
      assert.equal(item.file_item.media.encrypt_query_param, 'encrypted-param-1')
      assert.equal(Buffer.from(item.file_item.media.aes_key, 'base64').toString('utf8'), start.aeskey)
      assert.equal(item.file_item.media.encrypt_type, 1)
      assert.equal(claw.lastFileSend, undefined, 'service does not record; the Ria tool does')
    } finally {
      await claw.shutdown()
    }
  }

  // A transient CDN 5xx is retried; a 4xx is not.
  {
    const { claw } = makeClaw(dir, { baseUrl: base })
    uploads.length = 0
    sends.length = 0
    uploadMode = 'retry-once'
    uploadAttempt = 0
    try {
      await claw.sendFile('retry.pdf', PDF)
      assert.equal(uploads.length, 2)
      assert.equal(sends.length, 1)
    } finally {
      uploadMode = 'ok'
      await claw.shutdown()
    }
    const rejected = makeClaw(dir, { baseUrl: base })
    uploads.length = 0
    uploadMode = 'reject'
    uploadAttempt = 0
    try {
      await assert.rejects(() => rejected.claw.sendFile('reject.pdf', PDF), error => error.code === 'file_upload_failed')
      assert.equal(uploads.length, 1)
      assert.equal(sends.length, 1, 'no sendmessage after a rejected upload')
    } finally {
      uploadMode = 'ok'
      await rejected.claw.shutdown()
    }
  }

  // Paused and no-peer sends fail loudly before touching the network.
  {
    const paused = makeClaw(dir, { baseUrl: base })
    paused.claw.paused = true
    const uploadsBeforePause = uploadRequests.length
    try {
      await assert.rejects(() => paused.claw.sendFile('x.pdf', PDF), error => error.code === 'WECHAT_PAUSED')
      assert.equal(uploadRequests.length, uploadsBeforePause, 'paused send must not call getuploadurl')
    } finally {
      paused.claw.paused = false
      await paused.claw.shutdown()
    }
    const peerless = makeClaw(dir, { baseUrl: base })
    peerless.claw.peer = undefined
    try {
      await assert.rejects(() => peerless.claw.sendFile('x.pdf', PDF), /尚未收到可回复的消息/)
    } finally {
      await peerless.claw.shutdown()
    }
  }
// Durable file queue: channel_file_send entries left by older builds are still
// drained when the channel is reachable, and a missing file fails loudly instead
// of silently disappearing.
{
  const fixture = await createFixture()
  const file = join(fixture.stateDir, '报告.pdf')
  writeFileSync(file, PDF)
  const claw = fixture.service.wechatClaw
  const sent = []
  claw.session = { token: 'token-tool', baseUrl: base, abort: new AbortController() }
  claw.peer = { userId: 'user-1', contextToken: 'context-tool' }
  claw.outbound = {
    enqueue(text) { sent.push(text); return Promise.resolve('note-1') },
    enqueueImage() { return Promise.resolve('image-1') },
    setPaused() {},
  }
  claw.lastInboundAt = Date.now()
  const enqueue = payload => fixture.service.outbox.enqueue({ kind: 'channel_file_send', payload }).entry
  try {
    assert.equal(fixture.service.channelFileOptions('wechat').maxBytes, 20 * 1024 * 1024)
    const delivered = await fixture.service.deliverOutboxEntry(enqueue({ channel: 'wechat-claw', path: file, name: '报告.pdf', bytes: PDF.length, note: '这是报告' }))
    assert.equal(delivered, true)
    assert.deepEqual(sent, ['📎 这是报告'])
    assert.equal(claw.lastFileSend.delivered, true)
    assert.equal(claw.lastFileSend.name, '报告.pdf')
    assert.equal(claw.lastFileSend.path, file)

    await assert.rejects(
      () => fixture.service.deliverOutboxEntry(enqueue({ channel: 'wechat-claw', path: join(fixture.stateDir, 'gone.pdf'), name: 'gone.pdf' })),
      /文件已不存在/,
    )

    writeFileSync(join(fixture.stateDir, 'empty.txt'), '')
    await assert.rejects(
      () => fixture.service.deliverOutboxEntry(enqueue({ channel: 'wechat-claw', path: join(fixture.stateDir, 'empty.txt'), name: 'empty.txt' })),
      /文件不可用/,
    )

    claw.paused = true
    claw.pausedAt = new Date().toISOString()
    assert.deepEqual(await fixture.service.deliverOutboxEntry(enqueue({ channel: 'wechat-claw', path: file, name: '报告.pdf' })), { deferred: true })
    claw.paused = false

    claw.peer = undefined
    assert.deepEqual(await fixture.service.deliverOutboxEntry(enqueue({ channel: 'wechat-claw', path: file, name: '报告.pdf' })), { deferred: true })
  } finally {
    fixture.cleanup()
  }
}

} finally {
  await new Promise(resolve => server.close(resolve))
  rmSync(dir, { recursive: true, force: true })
}

console.log('wechat-claw-file ok')
