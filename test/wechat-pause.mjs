import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Outbound, PauseError } from '../lib/wechat/outbound.mjs'
import { WechatService } from '../lib/wechat/service.mjs'

const tick = () => new Promise(resolve => setImmediate(resolve))

function fakeCtx() {
  const handlers = new Map()
  return {
    handlers,
    on(name, handler) { handlers.set(name, handler); return () => handlers.delete(name) },
    sessionController: { async prompt() { return { accepted: true } } },
  }
}

function makeService(ctx, dir, logs) {
  return new WechatService({
    ctx,
    stateDir: dir,
    ensureRia: async () => 'ria-1',
    getRiaId: () => 'ria-1',
    log: (level, message) => logs.push({ level, message }),
  })
}

function dispatch(service, rpcId, kind = 'user') {
  service.onSessionEvent(
    { header: { id: 'ria-1' } },
    { type: 'user/message', data: { source: { kind, rpcId }, content: [{ type: 'text', text: 'hello' }] } },
  )
}

async function readState(dir) {
  return JSON.parse(await readFile(join(dir, 'wechat', 'state.json'), 'utf8'))
}

const dir = await mkdtemp(join(tmpdir(), 'dsh-ria-pause-'))
try {
  // Manual pause persists, and manual resume persists too.
  {
    const logs = []
    const ctx = fakeCtx()
    const service = makeService(ctx, dir, logs)
    const view = service.setPaused(true, { by: 'manual', reason: '用户手动暂停' })
    assert.equal(view.paused, true)
    assert.equal(view.pausedBy, 'manual')
    assert.equal(view.pauseReason, '用户手动暂停')
    assert.match(view.pausedAt, /^\d{4}-\d{2}-\d{2}T/)
    assert.equal(view.resumedAt, null)
    assert.equal(logs.some(item => item.level === 'warn' && item.message.startsWith('pause: ')), true)

    let stored = await readState(dir)
    assert.equal(stored.version, 2)
    assert.equal(stored.paused, true)
    assert.equal(stored.pausedBy, 'manual')

    const restarted = makeService(ctx, dir, logs)
    assert.equal(restarted.statusView().paused, true)
    assert.equal(restarted.statusView().pausedBy, 'manual')

    const resumed = restarted.setPaused(false, { by: 'manual', reason: '用户恢复' })
    assert.equal(resumed.paused, false)
    assert.equal(resumed.resumedBy, 'manual')
    assert.match(resumed.resumedAt, /^\d{4}-\d{2}-\d{2}T/)
    stored = await readState(dir)
    assert.equal(stored.paused, false)
    assert.equal(stored.resumedBy, 'manual')
    assert.equal(stored.pausedAt, null)
  }

  // A non-WeChat user message pauses; WeChat resumes; host/schedule messages are ignored.
  {
    const logs = []
    const ctx = fakeCtx()
    const service = makeService(ctx, dir, logs)
    dispatch(service, 'web-uuid-1')
    assert.equal(service.statusView().paused, true)
    assert.equal(service.statusView().pausedBy, 'channel')
    assert.equal(service.statusView().pauseReason, '非微信通道消息')

    const pauseCount = logs.filter(item => item.message.startsWith('pause: ')).length
    dispatch(service, 'host_startup_1')
    dispatch(service, 'schedule_1', 'schedule')
    assert.equal(service.statusView().pausedBy, 'channel')
    assert.equal(logs.filter(item => item.message.startsWith('pause: ')).length, pauseCount)

    dispatch(service, 'wx_1')
    assert.equal(service.statusView().paused, false)
    assert.equal(service.statusView().resumedBy, 'channel')
    assert.equal(logs.some(item => item.message.startsWith('resume: ') && item.message.includes('微信消息')), true)
  }

  // An automatic pause never turns a manual pause into a channel pause.
  {
    const logs = []
    const ctx = fakeCtx()
    const service = makeService(ctx, dir, logs)
    service.setPaused(true, { by: 'manual', reason: '用户手动暂停' })
    dispatch(service, 'web-uuid-2')
    assert.equal(service.statusView().paused, true)
    assert.equal(service.statusView().pausedBy, 'manual')
    assert.equal(service.statusView().pauseReason, '用户手动暂停')
    assert.equal(logs.some(item => item.message.includes('auto pause ignored')), true)

    // A WeChat message is an explicit return to that channel and resumes even a manual pause.
    dispatch(service, 'wx_2')
    assert.equal(service.statusView().paused, false)
    assert.equal(service.statusView().resumedBy, 'channel')
  }

  // Queued messages drop, the in-flight message finishes, and drops are logged.
  {
    const logs = []
    const ctx = fakeCtx()
    const service = makeService(ctx, dir, logs)
    let release
    const sent = []
    const outbound = new Outbound({
      prefix: '',
      gapMs: 0,
      send: async text => {
        sent.push(text)
        if (text === 'first') await new Promise(resolve => { release = resolve })
        return 'msg-' + sent.length
      },
    })
    service.outbound = outbound
    service.session = { client: { sentIds: new Set() } }

    const first = outbound.enqueue('first')
    assert.deepEqual(sent, ['first'])
    const second = assert.rejects(outbound.enqueue('second'), PauseError)
    const third = assert.rejects(outbound.enqueue('third'), PauseError)

    const view = service.setPaused(true, { by: 'manual', reason: '测试暂停' })
    assert.equal(view.paused, true)
    assert.equal(outbound.pending, 0)
    await second
    await third
    assert.deepEqual(sent, ['first'])

    release()
    await first
    assert.deepEqual(sent, ['first'])

    const dropped = logs.filter(item => item.message.startsWith('dropped outbound while paused: '))
    assert.equal(dropped.length >= 2, true)
    assert.equal(dropped.some(item => item.message.includes('"kind":"text"') && item.message.includes('second')), true)
    assert.equal(logs.some(item => item.message.startsWith('pause: ') && item.message.includes('"inFlight":true')), true)

    service.forwardAssistant('reply while paused')
    await tick()
    assert.equal(sent.length, 1)
    assert.equal(logs.some(item => item.message.startsWith('dropped outbound while paused: ') && item.message.includes('"kind":"assistant"') && item.message.includes('reply while paused')), true)

    const notice = await service.notifyWechat('system notice')
    assert.equal(notice, null)
    assert.equal(logs.some(item => item.message.startsWith('dropped outbound while paused: ') && item.message.includes('"kind":"system"')), true)

    await service.flushOutbox()
    assert.equal(sent.length, 1)
  }

  // Paused state survives restart; outbox flushing waits for resume.
  {
    const logs = []
    const ctx = fakeCtx()
    const service = makeService(ctx, dir, logs)
    service.state.addOutbox('backlog-1')
    service.setPaused(true, { by: 'manual', reason: '重启测试' })

    const restarted = makeService(ctx, dir, logs)
    assert.equal(restarted.statusView().paused, true)
    const sent = []
    restarted.outbound = { async enqueue(text) { sent.push(text); return 'id' } }
    await restarted.flushOutbox()
    assert.deepEqual(sent, [])

    restarted.setPaused(false, { by: 'channel', reason: '微信消息' })
    await tick()
    await tick()
    assert.deepEqual(sent, ['backlog-1'])
    assert.equal(restarted.statusView().pendingOutbox, 0)
  }

  // Assistant messages while paused are dropped before they enter the outbound queue.
  {
    const logs = []
    const ctx = fakeCtx()
    const service = makeService(ctx, dir, logs)
    const sent = []
    service.outbound = { async enqueue(text) { sent.push(text); return 'id' } }
    service.session = { client: {} }
    service.setPaused(true, { by: 'manual', reason: '事件测试' })
    service.onSessionEvent(
      { header: { id: 'ria-1' } },
      { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'assistant reply' }] } } },
    )
    await tick()
    assert.deepEqual(sent, [])
    assert.equal(logs.some(item => item.message.startsWith('dropped outbound while paused: ') && item.message.includes('assistant reply')), true)
  }

  console.log('wechat-pause ok')
} finally {
  await rm(dir, { recursive: true, force: true })
}
