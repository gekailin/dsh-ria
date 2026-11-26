import assert from 'node:assert/strict'
import { createFixture } from './support/ria-fixture.mjs'

const fixture = await createFixture({ state: true })
try {
  const service = fixture.service
  const controller = service.controller
  const events = () => service.routerEvents.query({ limit: 500 }).events
  const suppressed = () => events().filter(item => item.event === 'channel.auto_pause.suppressed')
  const pauses = () => events().filter(item => item.event === 'channel.auto_pause')

  service.store.setSettings({ wechatAutoPause: false })

  // Persisted channel pause must be cleared when the opt-out is disabled.
  service.wechat.state.data.paused = true
  service.wechat.state.data.pausedBy = 'channel'
  service.wechat.state.data.pauseReason = 'legacy auto pause'
  service.wechat.state.data.pausedAt = '2026-11-12T08:06:11.949Z'
  assert.equal(service.wechat.reconcileAutoPauseSetting(), true)
  assert.equal(service.wechat.state.paused, false)
  assert.equal(service.wechat.state.data.pauseReason, null)
  const reconciled = events().find(item => item.event === 'channel.auto_pause' && item.payload && item.payload.reconciled === true)
  assert.ok(reconciled)
  assert.equal(reconciled.payload.autoPauseDisabled, true)

  service.wechatClaw.paused = true
  service.wechatClaw.pausedBy = 'channel'
  assert.equal(service.wechatClaw.reconcileAutoPauseSetting(), true)
  assert.equal(service.wechatClaw.paused, false)
  service.qqBot.paused = true
  service.qqBot.pausedBy = 'channel'
  assert.equal(service.qqBot.reconcileAutoPauseSetting(), true)
  assert.equal(service.qqBot.paused, false)

  // Every trigger point is suppressed with an observable record.
  service.wechat.observeUserMessage({ source: { kind: 'user', rpcId: 'web-auto-1' }, content: [] })
  service.wechatClaw.observeUserMessage({ source: { kind: 'user', rpcId: 'wechat-auto-1' }, content: [] })
  service.qqBot.observeUserMessage({ source: { kind: 'user' }, rpcId: 'web-auto-2', content: [] })
  assert.equal(service.wechat.state.paused, false)
  assert.equal(service.wechatClaw.paused, false)
  assert.equal(service.qqBot.paused, false)
  assert.equal(suppressed().length >= 3, true)
  for (const item of suppressed()) {
    assert.equal(item.payload.wechatAutoPause, false)
    assert.equal(item.payload.suppressed, true)
    assert.equal(item.payload.autoPauseDisabled, true)
    assert.equal(typeof item.payload.reason, 'string')
  }

  // Enabled setting still pauses and records the normal transition.
  service.store.setSettings({ wechatAutoPause: true })
  assert.equal(service.wechat.autoPause('test'), true)
  assert.equal(service.wechatClaw.autoPause('test'), true)
  assert.equal(service.qqBot.autoPause('test'), true)
  assert.equal(service.wechat.state.paused, true)
  assert.equal(service.wechatClaw.paused, true)
  assert.equal(service.qqBot.paused, true)
  assert.equal(pauses().some(item => item.payload && item.payload.wechatAutoPause === true && item.payload.suppressed === false), true)

  // Config missing/undefined is treated as disabled, never as enabled.
  service.store.setSettings({ wechatAutoPause: false })
  service.wechat.setPaused(false, { by: 'channel', reason: 'reset' })
  service.wechatClaw.setPaused(false, { by: 'channel', reason: 'reset' })
  service.qqBot.setPaused(false, { by: 'channel', reason: 'reset' })
  controller.state.data.settings.wechatAutoPause = undefined
  assert.equal(service.wechat.autoPause('missing'), false)
  assert.equal(service.wechatClaw.autoPause('missing'), false)
  assert.equal(service.qqBot.autoPause('missing'), false)
  assert.equal(service.wechat.state.paused, false)
  assert.equal(service.wechatClaw.paused, false)
  assert.equal(service.qqBot.paused, false)
} finally {
  fixture.cleanup()
}
console.log('auto pause reconcile/suppressed ok')