import assert from 'node:assert/strict'
import { createFixture } from './support/ria-fixture.mjs'

// Single-shot forward: no action/status/cancel, one inbound message, auto-disarm.
const fixture = await createFixture({
  stateDefault: true,
  extraSessions: [{ sessionId: 'session-forward-target', cwd: '/tmp', title: 'Forward Target' }],
})
try {
  const controller = fixture.service.controller
  const chat = controller.state.chatSessionId
  const target = 'session-forward-target'
  const forwardTool = fixture.agentTools.get(chat).get('ria_chat_forward')
  assert.ok(forwardTool, 'ria_chat_forward registered')
  assert.equal('action' in (forwardTool.parameters.properties || {}), false, 'no action parameter')
  assert.equal('status' in (forwardTool.parameters.properties || {}), false)
  assert.equal('cancel' in (forwardTool.parameters.properties || {}), false)

  const miss = await fixture.callAs(chat, 'ria_chat_forward', {})
  assert.equal(miss.ok, false)
  assert.equal(miss.code, 'forward_target_required')
  const both = await fixture.callAs(chat, 'ria_chat_forward', { sessionId: target, title: 'Forward Target' })
  assert.equal(both.ok, false)
  assert.equal(both.code, 'forward_target_conflict')

  const armed = await fixture.callAs(chat, 'ria_chat_forward', { sessionId: target })
  assert.equal(armed.ok, true, JSON.stringify(armed))
  assert.equal(armed.armed, true)
  assert.equal(controller.forward.sessionId, target)
  assert.equal(controller.coManagement.watch(target).allowDispatch, false, 'auto-registration disables auto dispatch')
  assert.ok(fixture.service.routerEvents.query({ sessionId: target }).events.some(event => event.event === 'forward.armed'))

  const forwarded = await controller.forwardRelay([{ type: 'text', text: 'next message' }], chat)
  assert.equal(forwarded, true)
  assert.equal(controller.forward, undefined, 'consumed after one message')
  assert.ok(fixture.prompts.some(item => item.sessionId === target && String(item.content[0].text).includes('next message')))
  assert.ok(fixture.service.routerEvents.query({ sessionId: target }).events.some(event => event.event === 'forward.delivered'))
  assert.equal(await controller.forwardRelay([{ type: 'text', text: 'second' }], chat), false, 'only one message')

  const managed = await controller.ensureExecutor('global')
  const managedRejected = await fixture.callAs(chat, 'ria_chat_forward', { sessionId: managed.sessionId })
  assert.equal(managedRejected.ok, false)
  assert.equal(managedRejected.code, 'forward_managed_rejected')
  controller.setAdvisor('global', 'session-advisor-forward-test')
  const roleRejected = await fixture.callAs(chat, 'ria_chat_forward', { sessionId: 'session-advisor-forward-test' })
  assert.equal(roleRejected.ok, false)
  assert.equal(roleRejected.code, 'forward_role_rejected')

  // Timeout is lazy on the next inbound and emits forward.expired.
  controller.forward = { sessionId: target, title: 'Forward Target', armedAt: Date.now() - 1000, expiresAt: Date.now() - 1 }
  const expired = await controller.forwardRelay([{ type: 'text', text: 'too late' }], chat)
  assert.equal(expired, false)
  assert.equal(controller.forward, undefined)
  assert.ok(fixture.service.routerEvents.query({ sessionId: target }).events.some(event => event.event === 'forward.expired'))

  console.log('state chat forward ok')
} finally {
  fixture.cleanup()
}
