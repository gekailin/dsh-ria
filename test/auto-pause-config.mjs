import assert from 'node:assert/strict'
import { createFixture } from './support/ria-fixture.mjs'

const fixture = await createFixture()
try {
  const service = fixture.service
  // All three channels share the same store-backed gate.
  service.store.setSettings({ wechatAutoPause: false })
  assert.equal(service.wechat.autoPause('非微信通道消息'), false)
  assert.equal(service.wechat.state.paused, false)
  assert.equal(service.wechatClaw.autoPause('微信「文件传输助手」通道消息'), false)
  assert.equal(service.wechatClaw.paused, false)
  assert.equal(service.qqBot.autoPause('非 QQ 通道消息'), false)
  assert.equal(service.qqBot.paused, false)

  service.store.setSettings({ wechatAutoPause: true })
  assert.equal(service.wechatClaw.autoPause('微信「文件传输助手」通道消息'), true)
  assert.equal(service.wechatClaw.paused, true)
  service.wechatClaw.setPaused(false, { by: 'channel', reason: 'test reset' })

  assert.equal(service.qqBot.autoPause('非 QQ 通道消息'), true)
  assert.equal(service.qqBot.paused, true)
  service.qqBot.setPaused(false, { by: 'channel', reason: 'test reset' })

  assert.equal(service.wechat.autoPause('非微信通道消息'), true)
  assert.equal(service.wechat.state.paused, true)

  // ria_/host_ injected prompts are not channel activity and must remain ignored.
  service.wechat.setPaused(false, { by: 'channel', reason: 'test reset' })
  service.wechat.observeUserMessage({ source: { kind: 'user', rpcId: 'host_legacy_wake' }, content: [{ type: 'text', text: 'wake' }] })
  service.wechat.observeUserMessage({ source: { kind: 'user', rpcId: 'ria_turn_notice' }, content: [{ type: 'text', text: 'notice' }] })
  assert.equal(service.wechat.state.paused, false)
} finally {
  fixture.cleanup()
}
console.log('auto pause config guard ok')