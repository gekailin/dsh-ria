import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { InboundBridge, WechatService, assistantText } from '../lib/wechat/service.mjs'

function fakeCtx() {
  const handlers = new Map()
  const prompts = []
  return {
    handlers,
    prompts,
    on(name, handler) {
      handlers.set(name, handler)
      return () => handlers.delete(name)
    },
    sessionController: {
      async prompt(request) { prompts.push(request); return { accepted: true } },
    },
  }
}

function makeService(ctx, dir, overrides = {}) {
  return new WechatService({
    ctx,
    stateDir: dir,
    ensureSuper: async () => 'super-1',
    getSuperId: () => 'super-1',
    ...overrides,
  })
}

const dir = await mkdtemp(join(tmpdir(), 'dsh-super-session-wechat-'))
try {
  assert.equal(assistantText({ data: { message: { content: [
    { type: 'tool', text: 'ignored' },
    { type: 'text', text: 'first' },
    { type: 'text', text: 'second' },
  ] } } }), 'first\nsecond')
  assert.equal(assistantText({ data: { message: { content: [{ type: 'text', text: '  ' }] } } }), '')
  assert.equal(assistantText(undefined), '')

  {
    const ctx = fakeCtx()
    const service = makeService(ctx, dir)
    const dispose = service.subscribe()
    const sent = []
    service.session = { client: { sentIds: new Set() } }
    service.outbound = { async enqueue(text) { sent.push(text); return 'id' } }
    const handler = ctx.handlers.get('session/event')
    assert.equal(typeof handler, 'function')
    handler({ header: { id: 'super-1' } }, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'hello' }] } } })
    await new Promise(resolve => setTimeout(resolve, 0))
    assert.deepEqual(sent, ['hello'])
    handler({ header: { id: 'other' } }, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'nope' }] } } })
    handler({ header: { id: 'super-1' } }, { type: 'assistant/message', data: { interrupted: true, message: { content: [{ type: 'text', text: 'partial' }] } } })
    handler({ header: { id: 'super-1' } }, { type: 'tool/call', data: {} })
    await new Promise(resolve => setTimeout(resolve, 0))
    assert.deepEqual(sent, ['hello'])
    dispose()
  }

  {
    const ctx = fakeCtx()
    const service = makeService(ctx, dir)
    service.session = { client: { sentIds: new Set(['echo-1']) } }
    const bridge = new InboundBridge(service)

    await bridge.handle({ id: 'echo-1', to: 'filehelper', type: 1, text: 'my own send' })
    assert.equal(ctx.prompts.length, 0)

    await bridge.handle({ id: 'msg-1', to: 'somewhere', type: 1, text: 'wrong peer' })
    assert.equal(ctx.prompts.length, 0)

    await bridge.handle({ id: 'msg-2', to: 'filehelper', type: 1, text: ' raw text ' })
    assert.equal(ctx.prompts.length, 1)
    assert.equal(ctx.prompts[0].sessionId, 'super-1')
    assert.equal(ctx.prompts[0].mode, 'queue')
    assert.deepEqual(ctx.prompts[0].content, [{ type: 'text', text: ' raw text ' }])
    assert.match(ctx.prompts[0].requestId, /^req_/)

    await bridge.handle({ id: 'msg-2', to: 'filehelper', type: 1, text: ' raw text ' })
    assert.equal(ctx.prompts.length, 1)
    assert.equal(service.state.hasSeen('msg-2'), true)

    const restarted = makeService(ctx, dir)
    assert.equal(restarted.state.hasSeen('msg-2'), true)
  }

  {
    const ctx = fakeCtx()
    ctx.sessionController.prompt = async () => { throw new Error('worker unavailable') }
    const service = makeService(ctx, dir)
    service.session = { client: { sentIds: new Set() } }
    const bridge = new InboundBridge(service)
    await bridge.handle({ id: 'msg-3', to: 'filehelper', type: 1, text: 'hello' })
    assert.equal(service.state.hasSeen('msg-3'), true)
  }

  {
    const ctx = fakeCtx()
    const service = makeService(ctx, dir)
    for (let i = 1; i <= 12; i += 1) service.state.addOutbox('old-' + i)
    const sent = []
    service.outbound = { async enqueue(text) { sent.push(text) } }
    await service.flushOutbox()
    assert.equal(sent.length, 11)
    assert.match(sent[0], /跳过 2 条/)
    assert.equal(sent[1], 'old-3')
    assert.equal(sent[10], 'old-12')
    assert.equal(service.state.data.outbox.length, 0)
  }

  {
    const ctx = fakeCtx()
    const service = makeService(ctx, dir)
    assert.equal(service.statusView().loggedIn, false)
    assert.equal(service.statusView().login.phase, 'idle')
    service.session = { client: {}, self: { NickName: 'me', UserName: '@me' }, startedAt: '2026-01-01T00:00:00.000Z' }
    const view = service.statusView()
    assert.equal(view.loggedIn, true)
    assert.equal(view.nick, 'me')
    assert.equal(view.user, '@me')
    assert.equal(view.since, '2026-01-01T00:00:00.000Z')
  }

  console.log('wechat ok')
} finally {
  await rm(dir, { recursive: true, force: true })
}
