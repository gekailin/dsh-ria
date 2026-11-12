import assert from 'node:assert/strict'
import { createCipheriv, randomBytes } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { QqBotService, decryptBindSecret } from '../lib/channels/qq-bot.mjs'
import { WechatClawService, normalizeAccountId } from '../lib/channels/wechat-claw.mjs'
import { qrDataUrl } from '../lib/channels/common.mjs'
import {
  isForeignChannelRequestId,
  isQqRequestId,
  isWechatClawRequestId,
} from '../lib/channels/request-ids.mjs'

function fakeContext() {
  return {
    on() { return () => {} },
    sessionController: { prompt() { return Promise.resolve() } },
  }
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = []
    request.on('data', chunk => chunks.push(chunk))
    request.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'))
      } catch (error) {
        reject(error)
      }
    })
    request.on('error', reject)
  })
}

function json(response, value) {
  const body = JSON.stringify(value)
  response.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) })
  response.end(body)
}

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
}

function encryptSecret(secret, key) {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(key, 'base64'), iv)
  const ciphertext = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()])
  return Buffer.concat([iv, ciphertext, cipher.getAuthTag()]).toString('base64')
}

async function waitForStatus(service, predicate, label) {
  const deadline = Date.now() + 3000
  let view = service.statusView()
  while (Date.now() < deadline) {
    view = service.statusView()
    if (predicate(view)) return view
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  assert.fail(label + ' timed out: ' + JSON.stringify(view.login))
}

// Pure helpers: account-id normalization, QR rendering, request-id prefixes and
// the AES-256-GCM payload returned by the QQ bind endpoint.
{
  assert.equal(normalizeAccountId('abc-im-bot'), 'abc@im.bot')
  assert.equal(normalizeAccountId('abc-im-wechat'), 'abc@im.wechat')
  assert.equal(normalizeAccountId('abc@im.bot'), 'abc@im.bot')
  assert.equal(normalizeAccountId(''), '')

  const qr = await qrDataUrl('https://example.com/connect?task_id=1')
  assert.match(qr, /^data:image\/png;base64,[A-Za-z0-9+/=]+$/)
  assert.ok(qr.length > 500, 'QR PNG should contain real image data')

  assert.equal(isWechatClawRequestId('wc_123'), true)
  assert.equal(isWechatClawRequestId('qq_123'), false)
  assert.equal(isQqRequestId('qq_123'), true)
  assert.equal(isQqRequestId('wx_123'), false)
  assert.equal(isForeignChannelRequestId('qq_123', 'wc_'), true)
  assert.equal(isForeignChannelRequestId('wc_123', 'wc_'), false)
  assert.equal(isForeignChannelRequestId('host_123', 'wc_'), false)

  const key = randomBytes(32).toString('base64')
  const encrypted = encryptSecret('app-secret', key)
  assert.equal(decryptBindSecret(encrypted, key), 'app-secret')
  const tampered = Buffer.from(encrypted, 'base64')
  tampered[tampered.length - 1] ^= 0xff
  assert.throws(() => decryptBindSecret(tampered.toString('base64'), key))
  assert.throws(() => decryptBindSecret('not-base64', key))
}

// Full WeChat Claw pairing against a local mock of the iLink endpoints.
{
  const dir = mkdtempSync(join(tmpdir(), 'dsh-ria-claw-'))
  let statusCalls = 0
  let updates = 0
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1')
    if (url.pathname === '/ilink/bot/get_bot_qrcode') {
      json(response, { qrcode: 'qr-session-1', qrcode_img_content: 'https://example.com/wechat-claw' })
      return
    }
    if (url.pathname === '/ilink/bot/get_qrcode_status') {
      statusCalls += 1
      if (statusCalls === 1) {
        json(response, { status: 'scaned' })
      } else {
        json(response, {
          status: 'confirmed',
          bot_token: 'token-1',
          ilink_bot_id: 'bot-1-im-bot',
          baseurl: 'http://127.0.0.1:' + server.address().port,
          ilink_user_id: 'user-1',
        })
      }
      return
    }
    if (url.pathname === '/ilink/bot/getupdates') {
      await readJsonBody(request)
      updates += 1
      json(response, { ret: 0, msgs: [], get_updates_buf: 'cursor-1' })
      return
    }
    if (url.pathname === '/ilink/bot/sendmessage') {
      await readJsonBody(request)
      json(response, { ret: 0 })
      return
    }
    response.writeHead(404)
    response.end()
  })
  await listen(server)
  const base = 'http://127.0.0.1:' + server.address().port
  process.env.WX_CLAW_BASE = base
  process.env.WX_CLAW_QR_POLL_MS = '10'
  try {
    const service = new WechatClawService({
      ctx: fakeContext(),
      stateDir: dir,
      ensureRia: async () => 'ria-session',
      getRiaId: () => 'ria-session',
      log: () => {},
    })
    const initial = await service.startLogin()
    assert.equal(initial.login.phase, 'waiting', 'startLogin should return as soon as the QR is ready')
    assert.ok(initial.login.qr, 'startLogin should return the QR data URL')
    const view = await waitForStatus(service, status => status.loggedIn, 'WeChat Claw login')
    assert.equal(view.loggedIn, true, 'WeChat Claw should start a session after confirmation')
    assert.equal(view.accountId, 'bot-1@im.bot')
    const creds = JSON.parse(readFileSync(join(dir, 'wechat-claw', 'creds.json'), 'utf8'))
    assert.equal(creds.token, 'token-1')
    assert.equal(creds.accountId, 'bot-1@im.bot')
    assert.equal(creds.userId, 'user-1')

    for (let attempt = 0; attempt < 50 && updates === 0; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    assert.ok(updates > 0, 'the getupdates monitor should run after login')
    await service.shutdown()
  } finally {
    delete process.env.WX_CLAW_BASE
    delete process.env.WX_CLAW_QR_POLL_MS
    await new Promise(resolve => server.close(resolve))
    rmSync(dir, { recursive: true, force: true })
  }
}

// Full QQ bind pairing against a local mock; the SDK session is stubbed so no
// real QQ gateway is contacted.
{
  const dir = mkdtempSync(join(tmpdir(), 'dsh-ria-qq-'))
  let bindKey = ''
  let polls = 0
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1')
    if (url.pathname === '/lite/create_bind_task') {
      const body = await readJsonBody(request)
      bindKey = body.key
      json(response, { retcode: 0, data: { task_id: 'task-1' } })
      return
    }
    if (url.pathname === '/lite/poll_bind_result') {
      polls += 1
      if (polls === 1) {
        json(response, { retcode: 0, data: { status: 1 } })
      } else {
        json(response, {
          retcode: 0,
          data: {
            status: 2,
            bot_appid: '102000001',
            bot_encrypt_secret: encryptSecret('qq-secret', bindKey),
            user_openid: 'openid-1',
          },
        })
      }
      return
    }
    response.writeHead(404)
    response.end()
  })
  await listen(server)
  process.env.QQ_BIND_HOST = 'http://127.0.0.1:' + server.address().port
  process.env.QQ_BIND_POLL_MS = '50'
  try {
    const service = new QqBotService({
      ctx: fakeContext(),
      stateDir: dir,
      ensureRia: async () => 'ria-session',
      getRiaId: () => 'ria-session',
      log: () => {},
    })
    let captured
    service.startSession = async creds => {
      captured = creds
      service.session = { appId: creds.appId, abort: new AbortController() }
      service.login = { phase: 'success', message: 'stub' }
      return service.statusView()
    }
    const initial = await service.startLogin()
    assert.equal(initial.login.phase, 'waiting', 'startLogin should return as soon as the QR is ready')
    assert.ok(initial.login.qr, 'startLogin should return the QR data URL')
    const view = await waitForStatus(service, status => status.loggedIn, 'QQ bind')
    assert.equal(view.loggedIn, true, 'QQ service should reach a session after bind completion')
    assert.deepEqual(captured && { appId: captured.appId, appSecret: captured.appSecret, userOpenid: captured.userOpenid }, {
      appId: '102000001',
      appSecret: 'qq-secret',
      userOpenid: 'openid-1',
    })
    const creds = JSON.parse(readFileSync(join(dir, 'qq-bot', 'creds.json'), 'utf8'))
    assert.equal(creds.appSecret, 'qq-secret')

    service.setPaused(true, { by: 'manual', reason: 'test' })
    const restored = new QqBotService({
      ctx: fakeContext(),
      stateDir: dir,
      ensureRia: async () => 'ria-session',
      getRiaId: () => 'ria-session',
      log: () => {},
    })
    assert.equal(restored.statusView().paused, true)
    assert.equal(restored.statusView().pauseReason, 'test')
    await service.shutdown()
    await restored.shutdown()
  } finally {
    delete process.env.QQ_BIND_HOST
    delete process.env.QQ_BIND_POLL_MS
    await new Promise(resolve => server.close(resolve))
    rmSync(dir, { recursive: true, force: true })
  }
}

// Inbound text must reach sessionController.prompt as content parts, not as a
// bare string: the controller calls .some() on the content array.
{
  const dir = mkdtempSync(join(tmpdir(), 'dsh-ria-content-'))
  const prompts = []
  const ctx = {
    on() { return () => {} },
    sessionController: {
      prompt(args) { prompts.push(args); return Promise.resolve() },
    },
  }
  const qq = new QqBotService({
    ctx,
    stateDir: dir,
    ensureRia: async () => 'ria-session',
    getRiaId: () => 'ria-session',
    log: () => {},
  })
  qq.session = { appId: '102000001', abort: new AbortController() }
  try {
    await qq.handleMessage(qq.session, {
      senderIsBot: false,
      replyTarget: { scope: 'c2c', targetId: 'openid-1' },
      messageId: 'qq-message-1',
      content: 'hello from QQ',
    })
    assert.deepEqual(prompts[0].content, [{ type: 'text', text: 'hello from QQ' }])

    const claw = new WechatClawService({
      ctx,
      stateDir: dir,
      ensureRia: async () => 'ria-session',
      getRiaId: () => 'ria-session',
      log: () => {},
    })
    claw.session = { token: 'token-1', baseUrl: 'http://127.0.0.1:1', abort: new AbortController() }
    await claw.handleMessage(claw.session, {
      message_type: 1,
      message_id: 'claw-message-1',
      from_user_id: 'user-1',
      context_token: 'context-1',
      item_list: [{ type: 1, text_item: { text: 'hello from Claw' } }],
    })
    assert.deepEqual(prompts[1].content, [{ type: 'text', text: 'hello from Claw' }])
    assert.ok(claw.lastInboundAt > 0, 'inbound Claw messages should mark the channel as active')
    await qq.shutdown()
    await claw.shutdown()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// WeChat Claw can carry the same text notes as the legacy channel: dispatch,
// approval and the auto-pause notice. It defers while paused or without a
// reply target instead of dropping the outbox entry.
{
  const dir = mkdtempSync(join(tmpdir(), 'dsh-ria-claw-notes-'))
  const claw = new WechatClawService({
    ctx: fakeContext(),
    stateDir: dir,
    ensureRia: async () => 'ria-session',
    getRiaId: () => 'ria-session',
    log: () => {},
  })
  const sent = []
  claw.session = { token: 'token-1', baseUrl: 'http://127.0.0.1:1', abort: new AbortController() }
  claw.outbound = {
    enqueue(text) { sent.push({ system: false, text }); return Promise.resolve('msg-1') },
    enqueueSystem(text, { prefix } = {}) { sent.push({ system: true, text, prefix }); return Promise.resolve('msg-2') },
    setPaused() {},
  }
  try {
    assert.deepEqual(await claw.sendDispatchNote('hello', { durable: true }), { deferred: true }, 'no peer should defer')
    claw.peer = { userId: 'user-1', contextToken: 'context-1' }
    assert.equal(await claw.sendDispatchNote('hello', { isTask: true, durable: true }), true)
    assert.equal(sent[0].text, '📌 任务已派发：hello')
    assert.equal(await claw.sendDispatchNote('note', { isTask: false, durable: true }), true)
    assert.equal(sent[1].text, '📌 消息已转交：note')
    assert.equal(await claw.sendApprovalNote('allow?', { durable: true }), true)
    assert.equal(sent[2].text, '🔐 等待权限审批：allow?')

    claw.paused = true
    assert.deepEqual(await claw.sendDispatchNote('later', { durable: true }), { deferred: true }, 'paused channel should defer')
    assert.equal(await claw.sendPauseNotice('🌊 paused', { durable: true }), true)
    assert.deepEqual(sent[3], { system: true, text: '🌊 paused', prefix: false })

    claw.paused = false
    claw.observeUserMessage({ source: { kind: 'user', rpcId: 'wx_123' } })
    assert.equal(claw.pauseReason, '微信「文件传输助手」通道消息')
    claw.setPaused(false)
    claw.observeUserMessage({ source: { kind: 'user', rpcId: 'qq_123' } })
    assert.equal(claw.pauseReason, 'QQ 通道消息')
  } finally {
    await claw.shutdown()
    rmSync(dir, { recursive: true, force: true })
  }
}

console.log('channels ok')
