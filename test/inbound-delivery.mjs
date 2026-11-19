import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { QqBotService } from '../lib/channels/qq-bot.mjs'
import { WechatClawService } from '../lib/channels/wechat-claw.mjs'
import { WechatService } from '../lib/wechat/service.mjs'

const SERVICES = {
  wechat: { Service: WechatService, prefix: 'wx_' },
  'wechat-claw': { Service: WechatClawService, prefix: 'wc_' },
  'qq-bot': { Service: QqBotService, prefix: 'qq_' },
}

function harness(dir, kind, options = {}) {
  const calls = []
  const delivered = []
  const logs = []
  const { Service } = SERVICES[kind]
  const ctx = {
    on() { return () => {} },
    sessionController: {
      async prompt(request, signal) {
        assert.ok(signal && typeof signal.throwIfAborted === 'function', kind + ' should pass an AbortSignal')
        calls.push(request)
        if (request.mode === 'steer' && options.failSteer) throw new Error('session/steer-unavailable')
        delivered.push(request)
        return { accepted: true }
      },
    },
  }
  const service = new Service({
    ctx,
    stateDir: dir,
    ensureRia: async () => 'ria-1',
    getRiaId: () => 'ria-1',
    log: (level, message) => logs.push({ level, message }),
    isRiaBusy: () => {
      if (options.probeThrows) throw new Error('probe failed')
      return options.busy === true
    },
  })
  return { calls, delivered, logs, service }
}

const dir = await mkdtemp(join(tmpdir(), 'dsh-ria-inbound-delivery-'))
const signal = () => new AbortController().signal
try {
  for (const [kind, { prefix }] of Object.entries(SERVICES)) {
    // Idle Ria: start a normal turn.
    {
      const { calls, delivered, logs, service } = harness(dir, kind, { busy: false })
      const mode = await service.promptContent('ria-1', [{ type: 'text', text: 'hello' }], signal())
      assert.equal(mode, 'queue')
      assert.deepEqual(calls.map(call => call.mode), ['queue'])
      assert.equal(delivered.length, 1)
      assert.ok(calls[0].requestId.startsWith(prefix), kind + ' should keep its request id prefix')
      assert.ok(logs.some(entry => entry.message.includes('mode=queue reason=ria_idle requestId=' + calls[0].requestId)))
    }

    // Busy Ria: join the running turn instead of queueing behind it.
    {
      const { calls, delivered, logs, service } = harness(dir, kind, { busy: true })
      const mode = await service.promptContent('ria-1', [{ type: 'text', text: 'hello' }], signal())
      assert.equal(mode, 'steer')
      assert.deepEqual(calls.map(call => call.mode), ['steer'])
      assert.equal(delivered.length, 1)
      assert.ok(calls[0].requestId.startsWith(prefix), kind + ' should keep its request id prefix')
      assert.ok(logs.some(entry => entry.message.includes('mode=steer reason=ria_busy requestId=' + calls[0].requestId)))
    }

    // A failed steer falls back to exactly one queue prompt with the same id.
    {
      const { calls, delivered, logs, service } = harness(dir, kind, { busy: true, failSteer: true })
      const mode = await service.promptContent('ria-1', [{ type: 'text', text: 'hello' }], signal())
      assert.equal(mode, 'queue')
      assert.deepEqual(calls.map(call => call.mode), ['steer', 'queue'])
      assert.equal(delivered.length, 1, kind + ' must deliver the fallback exactly once')
      assert.equal(calls[0].requestId, calls[1].requestId, 'fallback must reuse the request id')
      assert.ok(calls[1].requestId.startsWith(prefix))
      assert.ok(logs.some(entry => entry.message.includes('mode=queue reason=steer_failed requestId=' + calls[1].requestId)))
    }

    // A throwing busy probe is treated as idle; delivery still happens.
    {
      const { calls, delivered, service } = harness(dir, kind, { probeThrows: true })
      await service.promptContent('ria-1', [{ type: 'text', text: 'hello' }], signal())
      assert.deepEqual(calls.map(call => call.mode), ['queue'])
      assert.equal(delivered.length, 1)
    }
  }
} finally {
  await rm(dir, { recursive: true, force: true })
}

console.log('inbound delivery ok')

// Keep the image-buffer mock suite in the existing npm test entry point.
await import('./image-buffer.mjs')
