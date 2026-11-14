import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFixture } from './support/ria-fixture.mjs'

function fakeOutbound() {
  const sent = []
  return {
    sent,
    setPaused() { return 0 },
    async enqueueSystem(text, options) {
      sent.push({ text, options })
      return 'job'
    },
    async enqueue(text, options) {
      sent.push({ text, options })
      return 'job'
    },
  }
}

function autoPauseEntry(service) {
  return service.outbox.all().find(entry => entry.kind === 'channel_pause_notice')
}

function autoPauseEntries(service) {
  return service.outbox.all().filter(entry => entry.kind === 'channel_pause_notice')
}

async function drain(service) {
  await service.pumpOutbox('test-channel-pause')
  await service.pumpOutbox('test-channel-pause-settled')
}

// 文件传输助手: its own disconnect must not borrow WeChat Claw, and replaying
// the same pausedAt must not send twice.
{
  const fixture = await createFixture()
  const service = fixture.service
  const outbound = fakeOutbound()
  service.wechat.outbound = outbound
  try {
    assert.equal(service.wechat.autoPause('QQ 通道消息'), true)
    await drain(service)
    const status = {
      paused: true,
      pausedBy: 'channel',
      pausedAt: service.wechat.state.data.pausedAt,
      pauseReason: 'QQ 通道消息',
    }
    const entry = autoPauseEntry(service)
    assert.equal(outbound.sent.length, 1)
    assert.match(outbound.sent[0].text, /Ria 已自动暂停微信「文件传输助手」推送/)
    assert.match(outbound.sent[0].text, /QQ 通道消息/)
    assert.equal(entry.payload.channel, 'wechat')
    assert.equal(entry.payload.pausedAt, status.pausedAt)
    assert.equal(entry.status, 'delivered')

    assert.equal(service.notifyWechatAutoPause(status), true)
    await drain(service)
    assert.equal(outbound.sent.length, 1)
    assert.equal(autoPauseEntries(service).length, 1)

    assert.equal(service.notifyWechatAutoPause({ ...status, pausedBy: 'manual' }), false)
    service.wechat.setPaused(false, { by: 'channel', reason: 'resume' })
    service.wechat.outbound = undefined
    assert.equal(service.notifyWechatAutoPause({ ...status, pausedAt: '2026-11-14T12:00:01.000Z' }), false)
    await drain(service)
    assert.equal(autoPauseEntries(service).length, 1)
  } finally {
    fixture.cleanup()
  }
}

// 微信 Claw: transition-only callback, own channel delivery, paused-state bypass.
{
  const fixture = await createFixture()
  const service = fixture.service
  const outbound = fakeOutbound()
  const reason = '微信「文件传输助手」通道消息'
  service.wechatClaw.outbound = outbound
  service.wechatClaw.peer = { userId: 'user-1', contextToken: 'context-1' }
  try {
    assert.equal(service.wechatClaw.autoPause(reason), true)
    await drain(service)
    const entry = autoPauseEntry(service)
    assert.equal(outbound.sent.length, 1)
    assert.match(outbound.sent[0].text, /Ria 已自动暂停微信 Claw 推送/)
    assert.match(outbound.sent[0].text, /微信「文件传输助手」通道消息/)
    assert.equal(outbound.sent[0].options.prefix, false)
    assert.equal(entry.payload.channel, 'wechat-claw')
    assert.equal(entry.payload.pausedAt, service.wechatClaw.pausedAt)
    assert.equal(entry.status, 'delivered')

    assert.equal(service.wechatClaw.autoPause(reason), false)
    await drain(service)
    assert.equal(outbound.sent.length, 1)
    assert.equal(autoPauseEntries(service).length, 1)

    assert.equal(service.notifyChannelAutoPause('wechat-claw', {
      paused: true,
      pausedBy: 'manual',
      pausedAt: service.wechatClaw.pausedAt,
    }), false)
    service.wechatClaw.setPaused(false, { by: 'channel', reason: 'resume' })
    service.wechatClaw.outbound = undefined
    service.wechatClaw.peer = undefined
    assert.equal(service.wechatClaw.autoPause('again'), true)
    await drain(service)
    assert.equal(autoPauseEntries(service).length, 1)
  } finally {
    fixture.cleanup()
  }
}

// QQ: only C2C has a reply target, and the same durable notice path applies.
{
  const fixture = await createFixture()
  const service = fixture.service
  const outbound = fakeOutbound()
  service.qqBot.session = {}
  service.qqBot.outbound = outbound
  service.qqBot.peer = { scope: 'c2c', targetId: 'user-2' }
  try {
    assert.equal(service.qqBot.autoPause('微信 Claw 通道消息'), true)
    await drain(service)
    const entry = autoPauseEntry(service)
    assert.equal(outbound.sent.length, 1)
    assert.match(outbound.sent[0].text, /Ria 已自动暂停 QQ 推送/)
    assert.match(outbound.sent[0].text, /微信 Claw 通道消息/)
    assert.equal(outbound.sent[0].options.prefix, false)
    assert.equal(entry.payload.channel, 'qq-bot')
    assert.equal(entry.status, 'delivered')

    assert.equal(service.qqBot.autoPause('微信 Claw 通道消息'), false)
    await drain(service)
    assert.equal(outbound.sent.length, 1)
    assert.equal(autoPauseEntries(service).length, 1)

    assert.equal(service.notifyChannelAutoPause('qq-bot', {
      paused: true,
      pausedBy: 'manual',
      pausedAt: service.qqBot.pausedAt,
    }), false)
    service.qqBot.setPaused(false, { by: 'channel', reason: 'resume' })
    service.qqBot.session = undefined
    service.qqBot.outbound = undefined
    service.qqBot.peer = undefined
    assert.equal(service.qqBot.autoPause('again'), true)
    await drain(service)
    assert.equal(autoPauseEntries(service).length, 1)

    assert.deepEqual(await service.qqBot.sendPauseNotice('later', { durable: true }), { deferred: true })
  } finally {
    fixture.cleanup()
  }
}

// A true restart keeps the delivered record: replaying the same pause from the
// loaded state is a no-op rather than a second notice.
{
  const stateDir = mkdtempSync(join(tmpdir(), 'dsh-ria-channel-pause-restart-'))
  let first
  let second
  const status = {
    paused: true,
    pausedBy: 'channel',
    pausedAt: '2026-11-14T12:20:00.000Z',
    pauseReason: '非微信通道消息',
  }
  try {
    first = await createFixture({ stateDir })
    const firstOutbound = fakeOutbound()
    first.service.wechat.outbound = firstOutbound
    first.service.wechat.autoPause(status.pauseReason)
    await drain(first.service)
    assert.equal(firstOutbound.sent.length, 1)
    first.cleanup({ keepState: true })
    first = undefined

    second = await createFixture({ stateDir })
    const replayOutbound = fakeOutbound()
    second.service.wechat.outbound = replayOutbound
    assert.equal(second.service.notifyWechatAutoPause({
      ...status,
      pausedAt: second.service.wechat.state.data.pausedAt,
    }), true)
    await drain(second.service)
    assert.equal(replayOutbound.sent.length, 0)
    assert.equal(autoPauseEntries(second.service).length, 1)
    assert.equal(autoPauseEntry(second.service).status, 'delivered')
  } finally {
    if (first) first.cleanup()
    if (second) second.cleanup()
    rmSync(stateDir, { recursive: true, force: true })
  }
}

// The same replay rule applies to the two bot channels: their pause state and
// the delivered notice are both persisted.
for (const channel of ['wechat-claw', 'qq-bot']) {
  const stateDir = mkdtempSync(join(tmpdir(), 'dsh-ria-channel-pause-restart-' + channel + '-'))
  let first
  let second
  const attachTarget = service => {
    const outbound = fakeOutbound()
    const target = channel === 'wechat-claw' ? service.wechatClaw : service.qqBot
    if (channel === 'qq-bot') target.session = { bot: { stop() {} }, abort: new AbortController() }
    target.outbound = outbound
    target.peer = channel === 'wechat-claw'
      ? { userId: 'user-1', contextToken: 'context-1' }
      : { scope: 'c2c', targetId: 'user-2' }
    return { outbound, target }
  }
  try {
    first = await createFixture({ stateDir })
    const firstReady = attachTarget(first.service)
    assert.equal(firstReady.target.autoPause('另一个通道消息'), true)
    await drain(first.service)
    assert.equal(firstReady.outbound.sent.length, 1)
    const pausedAt = firstReady.target.pausedAt
    first.cleanup({ keepState: true })
    first = undefined

    second = await createFixture({ stateDir })
    const secondReady = attachTarget(second.service)
    assert.equal(second.service.notifyChannelAutoPause(channel, {
      paused: true,
      pausedBy: 'channel',
      pausedAt,
      pauseReason: '另一个通道消息',
    }), true)
    await drain(second.service)
    assert.equal(secondReady.outbound.sent.length, 0)
    assert.equal(autoPauseEntries(second.service).length, 1)
    assert.equal(autoPauseEntry(second.service).status, 'delivered')
  } finally {
    if (first) first.cleanup()
    if (second) second.cleanup()
    rmSync(stateDir, { recursive: true, force: true })
  }
}

console.log('channel-pause-notices ok')
