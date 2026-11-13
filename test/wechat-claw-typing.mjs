import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WechatClawService } from '../lib/channels/wechat-claw.mjs'

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

async function waitFor(predicate, label, timeout = 2000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.fail(label + ' timed out')
}

function inbound(messageId = 'msg-1', text = 'hello from Claw') {
  return {
    message_type: 1,
    message_id: messageId,
    from_user_id: 'user-1',
    context_token: 'context-1',
    item_list: [{ type: 1, text_item: { text } }],
  }
}

function serviceFor(dir, base, { events, prompts, typingOptions } = {}) {
  return new WechatClawService({
    ctx: fakeContext(prompts),
    stateDir: dir,
    ensureRia: async () => 'ria-session',
    getRiaId: () => 'ria-session',
    log: () => {},
    typingOptions: typingOptions || (() => ({ enabled: true, refreshMs: 30, maxMs: 1000 })),
  })
}

async function attachSession(service, base) {
  service.session = { token: 'token-1', baseUrl: base, abort: new AbortController() }
}

// start -> refresh -> cancel, and every outbound cancels before it sends.
{
  const dir = mkdtempSync(join(tmpdir(), 'dsh-ria-claw-typing-'))
  const events = []
  let configCalls = 0
  let ticket = 'ticket-1'
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1')
    if (url.pathname === '/ilink/bot/getconfig') {
      await readJsonBody(request)
      configCalls += 1
      json(response, { ret: 0, typing_ticket: ticket })
      return
    }
    if (url.pathname === '/ilink/bot/sendtyping') {
      const body = await readJsonBody(request)
      events.push('typing:' + body.status)
      json(response, { ret: 0 })
      return
    }
    if (url.pathname === '/ilink/bot/sendmessage') {
      const body = await readJsonBody(request)
      events.push('send:' + body.msg.item_list[0].text_item.text)
      json(response, { ret: 0 })
      return
    }
    response.writeHead(404)
    response.end()
  })
  await listen(server)
  const base = 'http://127.0.0.1:' + server.address().port
  const prompts = []
  const claw = serviceFor(dir, base, { events, prompts })
  await attachSession(claw, base)
  try {
    await claw.handleMessage(claw.session, inbound())
    assert.deepEqual(prompts[0].content, [{ type: 'text', text: 'hello from Claw' }])
    await waitFor(() => events.includes('typing:1'), 'typing start')
    assert.equal(claw.statusView().wechatClawTyping.active, 1)
    assert.equal(configCalls, 1)
    assert.equal(claw.statusView().wechatClawTyping.ticketCache, 1)

    await waitFor(() => events.filter(value => value === 'typing:1').length >= 2, 'typing refresh')
    assert.equal(configCalls, 1, 'the typing ticket should be reused across refreshes')

    await claw.sendText('reply')
    const cancel = events.lastIndexOf('typing:2')
    const send = events.lastIndexOf('send:reply')
    assert.ok(cancel >= 0, 'outbound should cancel typing first')
    assert.ok(send > cancel, 'typing must be cancelled before the reply is sent')
    assert.equal(claw.statusView().wechatClawTyping.active, 0)

    await claw.handleMessage(claw.session, inbound('msg-2', 'again'))
    await waitFor(() => claw.statusView().wechatClawTyping.active === 1, 'typing restart')
    await claw.cancelTyping('user-1', 'test cancel')
    assert.equal(events.at(-1), 'typing:2')
    assert.equal(claw.statusView().wechatClawTyping.active, 0)
    assert.equal(ticket, 'ticket-1')

    await claw.handleMessage(claw.session, inbound('msg-3', 'before close'))
    await waitFor(() => claw.statusView().wechatClawTyping.active === 1, 'typing before close')
    claw.sessionClosed(claw.session)
    await waitFor(() => events.at(-1) === 'typing:2' && claw.statusView().wechatClawTyping.active === 0, 'disconnect cancel')
  } finally {
    await claw.shutdown()
    await new Promise(resolve => server.close(resolve))
    rmSync(dir, { recursive: true, force: true })
  }
}

// A failed ticket or send invalidates the cache and retries once with a new one.
{
  const dir = mkdtempSync(join(tmpdir(), 'dsh-ria-claw-ticket-'))
  let configCalls = 0
  const events = []
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1')
    if (url.pathname === '/ilink/bot/getconfig') {
      await readJsonBody(request)
      configCalls += 1
      json(response, { ret: configCalls === 1 ? 1 : 0, typing_ticket: 'ticket-' + configCalls })
      return
    }
    if (url.pathname === '/ilink/bot/sendtyping') {
      const body = await readJsonBody(request)
      events.push('typing:' + body.status + ':' + body.typing_ticket)
      json(response, { ret: 0 })
      return
    }
    response.writeHead(404)
    response.end()
  })
  await listen(server)
  const base = 'http://127.0.0.1:' + server.address().port
  const claw = serviceFor(dir, base, { events })
  await attachSession(claw, base)
  try {
    await claw.handleMessage(claw.session, inbound())
    await waitFor(() => events.length > 0, 'typing with a fresh ticket')
    assert.equal(configCalls, 2, 'a ret!=0 ticket should be discarded and fetched again')
    assert.equal(events[0], 'typing:1:ticket-2')
    await claw.cancelTyping('user-1', 'done')
  } finally {
    await claw.shutdown()
    await new Promise(resolve => server.close(resolve))
    rmSync(dir, { recursive: true, force: true })
  }
}

// Typing failures stay silent and never affect inbound delivery or replies.
{
  const dir = mkdtempSync(join(tmpdir(), 'dsh-ria-claw-typing-errors-'))
  let configCalls = 0
  let sends = 0
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1')
    if (url.pathname === '/ilink/bot/getconfig') {
      await readJsonBody(request)
      configCalls += 1
      json(response, { error: 'nope' }, 500)
      return
    }
    if (url.pathname === '/ilink/bot/sendmessage') {
      await readJsonBody(request)
      sends += 1
      json(response, { ret: 0 })
      return
    }
    response.writeHead(404)
    response.end()
  })
  await listen(server)
  const base = 'http://127.0.0.1:' + server.address().port
  const claw = serviceFor(dir, base)
  await attachSession(claw, base)
  try {
    await claw.handleMessage(claw.session, inbound())
    await waitFor(() => configCalls === 2, 'two quiet ticket attempts')
    await new Promise(resolve => setTimeout(resolve, 30))
    assert.equal(claw.statusView().wechatClawTyping.active, 0)
    await claw.sendText('still works')
    assert.equal(sends, 1)
  } finally {
    await claw.shutdown()
    await new Promise(resolve => server.close(resolve))
    rmSync(dir, { recursive: true, force: true })
  }
}

// Disabled typing makes zero typing requests; outbound-only traffic never starts it.
{
  const dir = mkdtempSync(join(tmpdir(), 'dsh-ria-claw-typing-off-'))
  let typingCalls = 0
  let sends = 0
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1')
    if (url.pathname === '/ilink/bot/getconfig' || url.pathname === '/ilink/bot/sendtyping') {
      typingCalls += 1
      json(response, { ret: 0, typing_ticket: 'ticket-1' })
      return
    }
    if (url.pathname === '/ilink/bot/sendmessage') {
      await readJsonBody(request)
      sends += 1
      json(response, { ret: 0 })
      return
    }
    response.writeHead(404)
    response.end()
  })
  await listen(server)
  const base = 'http://127.0.0.1:' + server.address().port
  const claw = serviceFor(dir, base, { typingOptions: () => ({ enabled: false }) })
  await attachSession(claw, base)
  claw.peer = { userId: 'user-1', contextToken: 'context-1' }
  try {
    await claw.sendText('outbound only')
    assert.equal(typingCalls, 0, 'outbound alone must not start typing')
    await claw.handleMessage(claw.session, inbound())
    await new Promise(resolve => setTimeout(resolve, 50))
    assert.equal(typingCalls, 0, 'the disabled switch must send nothing')
    assert.equal(sends, 1)
    assert.deepEqual(claw.statusView().wechatClawTyping.enabled, false)
  } finally {
    await claw.shutdown()
    await new Promise(resolve => server.close(resolve))
    rmSync(dir, { recursive: true, force: true })
  }
}

// Pausing the mirror cancels an active indicator.
{
  const dir = mkdtempSync(join(tmpdir(), 'dsh-ria-claw-typing-pause-'))
  const events = []
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1')
    if (url.pathname === '/ilink/bot/getconfig') {
      await readJsonBody(request)
      json(response, { ret: 0, typing_ticket: 'ticket-1' })
      return
    }
    if (url.pathname === '/ilink/bot/sendtyping') {
      const body = await readJsonBody(request)
      events.push(body.status)
      json(response, { ret: 0 })
      return
    }
    response.writeHead(404)
    response.end()
  })
  await listen(server)
  const base = 'http://127.0.0.1:' + server.address().port
  const claw = serviceFor(dir, base)
  await attachSession(claw, base)
  try {
    await claw.handleMessage(claw.session, inbound())
    await waitFor(() => claw.statusView().wechatClawTyping.active === 1, 'typing start')
    claw.setPaused(true, { by: 'manual', reason: 'test' })
    await waitFor(() => events.includes(2), 'pause cancel')
    assert.equal(claw.statusView().wechatClawTyping.active, 0)
  } finally {
    await claw.shutdown()
    await new Promise(resolve => server.close(resolve))
    rmSync(dir, { recursive: true, force: true })
  }
}

console.log('wechat-claw-typing ok')
