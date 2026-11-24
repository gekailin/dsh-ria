import assert from 'node:assert/strict'
import { createFixture } from './support/ria-fixture.mjs'

// ria_chat_forward is one call = one immediate delivery. There is no pending
// state, no next-message interception, and no ticket/Advisor path.
const fixture = await createFixture({
  stateDefault: true,
  extraSessions: [
    { sessionId: 'session-forward-target', cwd: '/tmp', projections: { values: { title: 'Forward Target' } } },
    { sessionId: 'session-forward-other', cwd: '/tmp', projections: { values: { title: 'Forward Other' } } },
  ],
})
try {
  const controller = fixture.service.controller
  const state = controller.state
  const chat = state.chatSessionId
  const target = 'session-forward-target'
  const forwardTool = fixture.agentTools.get(chat).get('ria_chat_forward')
  assert.ok(forwardTool, 'ria_chat_forward registered')
  assert.deepEqual(Object.keys(forwardTool.parameters.properties || {}).sort(), ['content', 'sessionId', 'title'])
  assert.deepEqual(forwardTool.parameters.required, ['content'])
  assert.equal(forwardTool.parameters.additionalProperties, false)
  assert.equal('arm' in (forwardTool.parameters.properties || {}), false)
  assert.equal('expiry' in (forwardTool.parameters.properties || {}), false)
  assert.equal('expiresAt' in (forwardTool.parameters.properties || {}), false)

  const missingContent = await fixture.callAs(chat, 'ria_chat_forward', { sessionId: target })
  assert.equal(missingContent.ok, false)
  assert.equal(missingContent.code, 'missing_required')
  assert.equal(missingContent.field, 'content')
  const emptyContent = await fixture.callAs(chat, 'ria_chat_forward', { sessionId: target, content: '   ' })
  assert.equal(emptyContent.ok, false)
  assert.equal(emptyContent.code, 'invalid_argument')
  assert.equal(emptyContent.field, 'content')

  const noTarget = await fixture.callAs(chat, 'ria_chat_forward', { content: 'hello' })
  assert.equal(noTarget.code, 'forward_target_required')
  const bothTargets = await fixture.callAs(chat, 'ria_chat_forward', { sessionId: target, title: 'Forward Target', content: 'hello' })
  assert.equal(bothTargets.code, 'forward_target_conflict')

  const typingCalls = []
  const originalBeginTyping = fixture.service.wechatClaw.beginTyping
  fixture.service.wechatClaw.beginTyping = (...args) => { typingCalls.push(args) }
  const ticketsBefore = fixture.service.store.tickets().length
  const llmBefore = fixture.llmCalls.length
  const routerBefore = fixture.service.routerEvents.query({ limit: 500 }).events.length

  // Deliberately include leading/trailing spaces and a newline: no trim/rewrite.
  const exact = '  直转原文：看看git状态\n第二行   '
  const sent = await fixture.callAs(chat, 'ria_chat_forward', { sessionId: target, content: exact })
  assert.equal(sent.ok, true, JSON.stringify(sent))
  assert.equal(sent.sent, true)
  assert.equal(sent.sessionId, target)
  assert.equal(sent.contentLength, exact.length)
  assert.match(sent.rpcId, /^ria_/)
  assert.equal('forward' in controller, false, 'no pending forwarding state remains on the controller')

  const injected = fixture.steered.at(-1)
  assert.ok(injected, 'target received the forward as a user message')
  assert.deepEqual(injected.content, [{ type: 'text', text: exact }], 'content is byte-for-byte identical')
  assert.equal(injected.source.kind, 'forward')
  assert.equal(injected.source.rpcId, sent.rpcId)
  const watcher = controller.coManagement.watch(target)
  assert.ok(watcher)
  assert.equal(watcher.status, 'active')
  assert.equal(watcher.allowDispatch, false, 'auto-registration disables auto dispatch')

  // No ticket, no WorkOrder, no Advisor call.
  assert.equal(fixture.service.store.tickets().length, ticketsBefore, 'forward creates no ticket')
  assert.equal(fixture.llmCalls.length, llmBefore, 'forward does not call Advisor/LLM')
  const newEvents = fixture.service.routerEvents.query({ limit: 500 }).events.slice(0, routerBefore)
  assert.equal(newEvents.some(event => String(event.event || '').startsWith('workorder')), false, 'no workorder event')
  assert.equal(newEvents.filter(event => event.event === 'forward.sent').length, 1)
  assert.equal(newEvents.some(event => String(event.event || '').startsWith('forward.') && event.event !== 'forward.sent'), false, 'only forward.sent is audited')
  const audit = newEvents.find(event => event.event === 'forward.sent')
  assert.equal(audit.sessionId, target)
  assert.equal(audit.payload.sessionId, target)
  assert.equal(audit.payload.title, 'Forward Target')
  assert.equal(audit.payload.contentLength, exact.length)
  assert.equal(audit.payload.rpcId, sent.rpcId)
  assert.equal(typingCalls.length, 0, 'forward does not start Chat typing')
  assert.equal(Object.hasOwn(fixture.service.wechatClaw, ['forward', 'Relay'].join('')), false, 'no channel-side forward interception')

  // A second call is another delivery, not a one-shot arm.
  const second = await fixture.callAs(chat, 'ria_chat_forward', { title: 'Forward Other', content: 'second by title' })
  assert.equal(second.ok, true, JSON.stringify(second))
  assert.equal(second.sessionId, 'session-forward-other')
  const secondInjected = fixture.steered.at(-1)
  assert.deepEqual(secondInjected.content, [{ type: 'text', text: 'second by title' }])
  assert.equal(secondInjected.source.kind, 'forward')
  assert.equal(controller.coManagement.watch('session-forward-other').allowDispatch, false)

  // Managed executors and role sessions are rejected before any delivery.
  const managed = await controller.ensureExecutor('global')
  const steeredBeforeManaged = fixture.steered.length
  const managedRejected = await fixture.callAs(chat, 'ria_chat_forward', { sessionId: managed.sessionId, content: 'nope' })
  assert.equal(managedRejected.ok, false)
  assert.equal(managedRejected.code, 'forward_managed_rejected')
  assert.equal(fixture.steered.length, steeredBeforeManaged)
  controller.setAdvisor('global', 'session-advisor-forward-test')
  const roleRejected = await fixture.callAs(chat, 'ria_chat_forward', { sessionId: 'session-advisor-forward-test', content: 'nope' })
  assert.equal(roleRejected.ok, false)
  assert.equal(roleRejected.code, 'forward_role_rejected')
  assert.equal(fixture.steered.length, steeredBeforeManaged)

  // Unknown target is a readable error, not a partial forward.
  const missing = await fixture.callAs(chat, 'ria_chat_forward', { sessionId: 'session-forward-missing', content: 'nope' })
  assert.equal(missing.ok, false)
  assert.equal(missing.code, 'forward_target_not_found')

  fixture.service.wechatClaw.beginTyping = originalBeginTyping
  console.log('state chat forward ok')
} finally {
  fixture.cleanup()
}
