import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { QqBotService, normalizeQqBotTypingOptions } from '../lib/channels/qq-bot.mjs'

function fakeContext(prompts = []) {
  return {
    on() { return () => {} },
    sessionController: {
      prompt(args) { prompts.push(args); return Promise.resolve() },
    },
  }
}

function fakeBot({ requests, sends, fail = false }) {
  return {
    creds: { appId: 'app-1', clientSecret: 'secret-1' },
    tokenManager: {
      async getAccessToken(appId, clientSecret) {
        assert.equal(appId, 'app-1')
        assert.equal(clientSecret, 'secret-1')
        return 'token-1'
      },
    },
    apiClient: {
      async request(token, method, path, body) {
        if (fail) throw new Error('typing endpoint down')
        requests.push({ token, method, path, body })
        return { ext_info: {} }
      },
    },
    async sendText(target, text) {
      sends.push({ target, text })
      return { id: 'sent-1' }
    },
  }
}

async function waitFor(predicate, label, timeout = 2500) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.fail(label + ' timed out')
}

function serviceFor(dir, { prompts, requests, sends, enabled = true, fail = false } = {}) {
  const service = new QqBotService({
    ctx: fakeContext(prompts),
    stateDir: dir,
    ensureRia: async () => 'ria-session',
    getRiaId: () => 'ria-session',
    log: () => {},
    typingOptions: () => ({ enabled, durationSec: 1, refreshMs: 1000, maxMs: 2500 }),
  })
  service.session = {
    appId: 'app-1',
    abort: new AbortController(),
    bot: fakeBot({ requests, sends, fail }),
  }
  return service
}

function inbound(scope = 'c2c', targetId = 'openid-1', messageId = 'qq-message-1') {
  return {
    senderIsBot: false,
    replyTarget: { scope, targetId },
    messageId,
    content: 'hello from QQ',
  }
}

// A real C2C message starts typing; refreshes reuse the same target and the
// reply stops the keepalive without any cancel request.
{
  const dir = mkdtempSync(join(tmpdir(), 'dsh-ria-qq-typing-'))
  const requests = []
  const sends = []
  const prompts = []
  const qq = serviceFor(dir, { prompts, requests, sends })
  try {
    await qq.handleMessage(qq.session, inbound())
    assert.deepEqual(prompts[0].content, [{ type: 'text', text: 'hello from QQ' }])
    await waitFor(() => requests.length === 1, 'typing start')
    assert.equal(requests[0].token, 'token-1')
    assert.equal(requests[0].method, 'POST')
    assert.equal(requests[0].path, '/v2/users/openid-1/messages')
    assert.equal(requests[0].body.msg_type, 6)
    assert.deepEqual(requests[0].body.input_notify, { input_type: 1, input_second: 1 })
    assert.equal(requests[0].body.msg_id, 'qq-message-1')
    assert.equal(typeof requests[0].body.msg_seq, 'number')
    assert.equal(qq.statusView().qqTyping.active, 1)
    assert.equal(qq.statusView().qqTyping.enabled, true)

    await waitFor(() => requests.length >= 2, 'typing refresh')
    assert.ok(requests[1].body.msg_seq > requests[0].body.msg_seq, 'each refresh needs a fresh msg_seq')
    assert.equal(requests[1].body.input_notify.input_second, 1)

    await qq.sendText('reply')
    assert.deepEqual(sends, [{ target: { scope: 'c2c', targetId: 'openid-1' }, text: 'reply' }])
    assert.equal(qq.statusView().qqTyping.active, 0)
    const count = requests.length
    await new Promise(resolve => setTimeout(resolve, 1200))
    assert.equal(requests.length, count, 'no typing request may follow the reply')

    await qq.handleMessage(qq.session, inbound('c2c', 'openid-1', 'qq-message-2'))
    await waitFor(() => qq.statusView().qqTyping.active === 1, 'typing before close')
    qq.sessionClosed(qq.session)
    assert.equal(qq.statusView().qqTyping.active, 0, 'disconnect must clear typing timers')
  } finally {
    await qq.shutdown()
    rmSync(dir, { recursive: true, force: true })
  }
}

// Groups and channels do not support input notifications and must stay silent.
{
  const dir = mkdtempSync(join(tmpdir(), 'dsh-ria-qq-typing-group-'))
  const requests = []
  const sends = []
  const qq = serviceFor(dir, { requests, sends })
  try {
    await qq.handleMessage(qq.session, inbound('group', 'group-1'))
    await qq.handleMessage(qq.session, inbound('channel', 'channel-1'))
    await new Promise(resolve => setTimeout(resolve, 80))
    assert.equal(requests.length, 0)
    assert.equal(qq.statusView().qqTyping.active, 0)
    await qq.sendText('group reply')
    assert.equal(sends.length, 1)
  } finally {
    await qq.shutdown()
    rmSync(dir, { recursive: true, force: true })
  }
}

// Outbound alone never starts typing, and enabled=false sends zero requests.
{
  const dir = mkdtempSync(join(tmpdir(), 'dsh-ria-qq-typing-off-'))
  const requests = []
  const sends = []
  const qq = serviceFor(dir, { requests, sends, enabled: false })
  try {
    qq.peer = { scope: 'c2c', targetId: 'openid-1' }
    await qq.sendText('outbound only')
    assert.equal(requests.length, 0)
    assert.equal(sends.length, 1)
    await qq.handleMessage(qq.session, inbound())
    await new Promise(resolve => setTimeout(resolve, 80))
    assert.equal(requests.length, 0, 'the disabled switch must send nothing')
    assert.equal(qq.statusView().qqTyping.enabled, false)
  } finally {
    await qq.shutdown()
    rmSync(dir, { recursive: true, force: true })
  }
}

// Typing failures stay silent and never block inbound delivery or replies.
{
  const dir = mkdtempSync(join(tmpdir(), 'dsh-ria-qq-typing-errors-'))
  const requests = []
  const sends = []
  const qq = serviceFor(dir, { requests, sends, fail: true })
  try {
    await qq.handleMessage(qq.session, inbound())
    await waitFor(() => qq.statusView().qqTyping.active === 0, 'failed typing cleanup')
    await qq.sendText('still works')
    assert.equal(sends.length, 1)
    assert.equal(qq.statusView().qqTyping.active, 0)
  } finally {
    await qq.shutdown()
    rmSync(dir, { recursive: true, force: true })
  }
}

// Pausing the mirror clears an active indicator and stops further refreshes.
{
  const dir = mkdtempSync(join(tmpdir(), 'dsh-ria-qq-typing-pause-'))
  const requests = []
  const sends = []
  const qq = serviceFor(dir, { requests, sends })
  try {
    await qq.handleMessage(qq.session, inbound())
    await waitFor(() => qq.statusView().qqTyping.active === 1, 'typing start')
    qq.setPaused(true, { by: 'manual', reason: 'test' })
    assert.equal(qq.statusView().qqTyping.active, 0)
    const count = requests.length
    await new Promise(resolve => setTimeout(resolve, 1200))
    assert.equal(requests.length, count)
  } finally {
    await qq.shutdown()
    rmSync(dir, { recursive: true, force: true })
  }
}

// The refresh interval may not undercut the advertised input_second window.
{
  assert.deepEqual(normalizeQqBotTypingOptions({}), { enabled: true, durationSec: 30, refreshMs: 30000, maxMs: 600000 })
  const tuned = normalizeQqBotTypingOptions({ durationSec: 30, refreshMs: 1000, maxMs: 5000 })
  assert.equal(tuned.refreshMs, 30000)
  assert.equal(tuned.maxMs, 30000)
  assert.equal(normalizeQqBotTypingOptions({ enabled: false }).enabled, false)
}

console.log('qq-bot-typing ok')
