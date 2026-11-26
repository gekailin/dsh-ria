import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WechatClawService, WECHAT_CLAW_PEER_TTL_MS } from '../lib/channels/wechat-claw.mjs'

const TOKEN = 'context-token-secret'

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

function json(response, value, status = 200) {
  const body = JSON.stringify(value)
  response.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) })
  response.end(body)
}

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
}

function fakeContext(prompts = []) {
  return {
    on() { return () => {} },
    sessionController: {
      prompt(args) { prompts.push(args); return Promise.resolve() },
    },
  }
}

function serviceFor(dir, { logs = [], prompts = [], onDegraded } = {}) {
  return new WechatClawService({
    ctx: fakeContext(prompts),
    stateDir: dir,
    ensureRia: async () => 'ria-session',
    getRiaId: () => 'ria-session',
    log: (level, message) => logs.push({ level, message }),
    typingOptions: () => ({ enabled: false }),
    onDegraded,
  })
}

async function attachSession(service, base) {
  service.session = { token: 'bot-token', baseUrl: base, abort: new AbortController() }
}

function statePath(dir) {
  return join(dir, 'wechat-claw', 'state.json')
}

function stateOf(dir) {
  return JSON.parse(readFileSync(statePath(dir), 'utf8'))
}

function seedPeer(dir, peer) {
  const file = statePath(dir)
  mkdirSync(join(dir, 'wechat-claw'), { recursive: true })
  writeFileSync(file, JSON.stringify({ version: 1, lastInboundAt: peer.at, peer }) + '\n')
}

function inbound(messageId = 'msg-1', contextToken = TOKEN) {
  return {
    message_type: 1,
    message_id: messageId,
    from_user_id: 'user-1',
    context_token: contextToken,
    item_list: [{ type: 1, text_item: { text: 'hello from Claw' } }],
  }
}

// An inbound token is persisted with its receipt time and owner-only mode.
{
  const dir = mkdtempSync(join(tmpdir(), 'dsh-ria-claw-peer-save-'))
  const service = serviceFor(dir)
  try {
    const before = Date.now()
    await service.handleMessage(undefined, inbound('persist-1'))
    assert.deepEqual(service.peer, { userId: 'user-1', contextToken: TOKEN })
    assert.ok(service.peerAt >= before)
    assert.equal(service.peerAt, service.lastInboundAt)
    const stored = stateOf(dir)
    assert.deepEqual(stored.peer, { userId: 'user-1', contextToken: TOKEN, at: service.lastInboundAt })
    assert.equal(statSync(statePath(dir)).mode & 0o777, 0o600)
  } finally {
    await service.shutdown()
    rmSync(dir, { recursive: true, force: true })
  }
}

// A new instance restores the peer and can send without waiting for an inbound.
{
  const dir = mkdtempSync(join(tmpdir(), 'dsh-ria-claw-peer-restart-'))
  const sent = []
  const server = createServer(async (request, response) => {
    if (new URL(request.url, 'http://127.0.0.1').pathname === '/ilink/bot/sendmessage') {
      sent.push(await readJsonBody(request))
      json(response, { ret: 0 })
      return
    }
    response.writeHead(404)
    response.end()
  })
  await listen(server)
  const base = 'http://127.0.0.1:' + server.address().port
  let first
  let second
  try {
    first = serviceFor(dir)
    await attachSession(first, base)
    await first.handleMessage(first.session, inbound('restart-1'))
    await first.shutdown()

    second = serviceFor(dir)
    await attachSession(second, base)
    assert.deepEqual(second.peer, { userId: 'user-1', contextToken: TOKEN })
    assert.equal(second.peerRestored, true)
    await second.sendText('after restart')
    assert.equal(sent.length, 1)
    assert.equal(sent[0].msg.to_user_id, 'user-1')
    assert.equal(sent[0].msg.context_token, TOKEN)
    assert.equal(sent[0].msg.item_list[0].text_item.text, 'after restart')
  } finally {
    if (first) await first.shutdown()
    if (second) await second.shutdown()
    await new Promise(resolve => server.close(resolve))
    rmSync(dir, { recursive: true, force: true })
  }
}

// Expired or malformed saved peers are ignored and scrubbed from disk.
{
  const dir = mkdtempSync(join(tmpdir(), 'dsh-ria-claw-peer-ttl-'))
  try {
    const at = Date.now() - WECHAT_CLAW_PEER_TTL_MS - 1000
    seedPeer(dir, { userId: 'user-1', contextToken: TOKEN, at })
    const expired = serviceFor(dir)
    try {
      assert.equal(expired.peer, undefined)
      assert.equal(expired.peerRestored, false)
      assert.equal(stateOf(dir).peer, undefined)
    } finally {
      await expired.shutdown()
    }

    seedPeer(dir, { userId: 'user-1', contextToken: TOKEN })
    const malformed = serviceFor(dir)
    try {
      assert.equal(malformed.peer, undefined)
    } finally {
      await malformed.shutdown()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// A rejection of a disk-restored token clears it, keeps the token out of errors,
// and lets the next fresh inbound message recover the channel.
{
  const dir = mkdtempSync(join(tmpdir(), 'dsh-ria-claw-peer-reject-'))
  const logs = []
  const sent = []
  const degraded = []
  let reject = true
  let httpFailure = false
  let echoToken = TOKEN
  const server = createServer(async (request, response) => {
    if (new URL(request.url, 'http://127.0.0.1').pathname === '/ilink/bot/sendmessage') {
      sent.push(await readJsonBody(request))
      if (httpFailure) {
        json(response, { message: 'prepare failed for ' + echoToken }, 500)
      } else if (reject) {
        json(response, { ret: -2, errmsg: 'prepare failed for ' + echoToken })
      } else {
        json(response, { ret: 0 })
      }
      return
    }
    response.writeHead(404)
    response.end()
  })
  await listen(server)
  const base = 'http://127.0.0.1:' + server.address().port
  seedPeer(dir, { userId: 'user-1', contextToken: TOKEN, at: Date.now() - 1000 })
  const service = serviceFor(dir, { logs, onDegraded: status => degraded.push(status) })
  try {
    await attachSession(service, base)
    assert.equal(service.peerRestored, true)
    await assert.rejects(service.sendText('stale token'), error => {
      assert.equal(error.code, 'WECHAT_CLAW_PEER_REJECTED')
      assert.equal(error.ret, -2)
      assert.equal(error.errmsg, 'prepare failed for [redacted]')
      assert.equal(error.message.includes(TOKEN), false)
      return true
    })
    assert.deepEqual(service.peer, { userId: 'user-1', contextToken: TOKEN })
    assert.equal(service.peerRestored, true)
    assert.equal(stateOf(dir).peer.contextToken, TOKEN)
    assert.equal(degraded.length, 1)
    assert.equal(degraded[0].degraded.code, 'WECHAT_CLAW_PEER_REJECTED')
    assert.equal(service.degraded.code, 'WECHAT_CLAW_PEER_REJECTED')

    reject = false
    await service.handleMessage(service.session, inbound('refresh-1', 'fresh-token'))
    echoToken = 'fresh-token'
    httpFailure = true
    await assert.rejects(service.sendText('http failure'), error => {
      assert.equal(error.message.includes(TOKEN), false)
      assert.ok(error.message.includes('[redacted]'))
      return true
    })
    httpFailure = false
    await service.sendText('after refresh')
    assert.equal(service.degraded, undefined)
    assert.equal(sent.length, 3)
    assert.equal(sent[2].msg.context_token, 'fresh-token')
    assert.equal(logs.some(entry => entry.message.includes(TOKEN)), false)
  } finally {
    await service.shutdown()
    await new Promise(resolve => server.close(resolve))
    rmSync(dir, { recursive: true, force: true })
  }
}

// Logout removes the saved reply target, so a restart cannot resurrect it.
{
  const dir = mkdtempSync(join(tmpdir(), 'dsh-ria-claw-peer-logout-'))
  try {
    seedPeer(dir, { userId: 'user-1', contextToken: TOKEN, at: Date.now() })
    const service = serviceFor(dir)
    await service.logout()
    assert.equal(service.peer, undefined)
    assert.equal(stateOf(dir).peer, undefined)
    await service.shutdown()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

console.log('wechat-claw-peer ok')