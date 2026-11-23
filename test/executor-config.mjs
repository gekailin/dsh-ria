import assert from 'node:assert/strict'
import { createFixture } from './support/ria-fixture.mjs'

// New Executors may name a preset; existing Executors keep theirs when reused.
// ria_chat_worker_config reads configuration and changes model live, while a
// preset change needs a recreate (DSH has no live preset switch).

const fixture = await createFixture({ stateDefault: true })
const events = []
fixture.service.routerEvent = event => { events.push(event) }

try {
  const controller = fixture.service.controller
  const store = controller.state
  const chat = fixture.service.controller.state.chatSessionId

  async function planAndDispatch(request) {
    const plan = await fixture.callAs(controller.advisor('global').sessionId, 'ria_ticket_plan', {
      ticketId: request.ticketId,
      summary: 'do it',
      steps: ['step one'],
    })
    assert.equal(plan.ok, true, JSON.stringify(plan))
    const dispatched = await fixture.callAs(controller.advisor('global').sessionId, 'ria_ticket_dispatch', { ticketId: request.ticketId })
    assert.equal(dispatched.ok, true, JSON.stringify(dispatched))
    return dispatched
  }

  // ① A work ticket with executorPreset creates the Executor with that preset.
  const custom = await fixture.callAs(chat, 'ria_chat_request', { goal: 'custom preset executor', executorPreset: 'standard' })
  assert.equal(custom.ok, true, JSON.stringify(custom))
  assert.equal(controller.state.ticketMeta(custom.ticketId).executorPreset, 'standard')
  const customDispatch = await planAndDispatch(custom)
  const customMeta = store.executor(customDispatch.executorSessionId)
  assert.equal(customMeta.preset, 'standard')
  const customCreate = fixture.creates.find(item => String(item.sessionId) === String(customDispatch.executorSessionId))
  assert.ok(customCreate, 'the Executor session was created')
  assert.equal(customCreate.agentPreset, 'standard')

  // ② A ticket without executorPreset keeps the default (ptc). The first Executor
  // is busy, so a new one is created.
  const plain = await fixture.callAs(chat, 'ria_chat_request', { goal: 'default preset executor' })
  assert.equal(plain.ok, true)
  assert.equal(controller.state.ticketMeta(plain.ticketId).executorPreset, undefined)
  const plainDispatch = await planAndDispatch(plain)
  assert.notEqual(plainDispatch.executorSessionId, customDispatch.executorSessionId)
  const plainMeta = store.executor(plainDispatch.executorSessionId)
  assert.equal(plainMeta.preset, 'ptc')
  const plainCreate = fixture.creates.find(item => String(item.sessionId) === String(plainDispatch.executorSessionId))
  assert.equal(plainCreate.agentPreset, 'ptc')

  // ③ An unknown preset is refused with the allow-list in the message.
  const invalid = await fixture.callAs(chat, 'ria_chat_request', { goal: 'bad preset', executorPreset: 'danger' })
  assert.equal(invalid.ok, false)
  assert.equal(invalid.code, 'invalid_executor_preset')
  assert.match(invalid.message, /ptc, standard, minimal/)
  // Preset is a work-ticket option only: a reflection ticket refuses it.
  const reflectionPreset = await controller.requestTicket(
    { goal: 'reflection preset', executorPreset: 'standard' },
    { agent: { id: chat } },
    { mode: 'reflection' },
  )
  assert.equal(reflectionPreset.ok, false)
  assert.equal(reflectionPreset.code, 'executor_preset_not_supported')

  // ④ Reuse keeps the Executor's own preset; a different request does not
  // silently re-configure it.
  const created = await controller.ensureExecutor('global', null, undefined, null, 'standard')
  assert.equal(created.created, true)
  store.addExecutor(created.sessionId, { status: 'idle', currentTicketId: null })
  const reused = await controller.ensureExecutor('global', null, undefined, null, 'minimal')
  assert.equal(reused.created, false)
  assert.equal(reused.sessionId, created.sessionId)
  assert.equal(reused.preset, 'standard', 'reused Executors keep their creation preset')
  assert.equal(store.executor(created.sessionId).preset, 'standard')

  // ⑤ ria_chat_worker_config get lists the fields the Chat needs.
  const list = await fixture.callAs(chat, 'ria_chat_worker_config', { action: 'get' })
  assert.equal(list.ok, true)
  assert.deepEqual(list.presets, ['ptc', 'standard', 'minimal'])
  const listed = list.executors.find(item => item.sessionId === created.sessionId)
  assert.ok(listed, 'the newly created Executor is listed')
  assert.equal(listed.executorType, 'work')
  assert.equal(listed.preset, 'standard')
  assert.equal(typeof listed.seq, 'number')
  assert.match(listed.title, /Executor/)
  assert.equal(listed.cwd, store.executor(created.sessionId).cwd)
  assert.equal(listed.status, 'idle')
  assert.deepEqual(listed.model, { provider: 'provider-ok', model: 'model-vision' })

  // ⑥ Model changes apply live and emit executor.config.changed.
  const modelChanged = await fixture.callAs(chat, 'ria_chat_worker_config', { action: 'set', executorId: created.sessionId, model: 'model-fast', provider: 'provider-ok' })
  assert.equal(modelChanged.ok, true, JSON.stringify(modelChanged))
  assert.equal(modelChanged.recreated, false)
  assert.equal(modelChanged.after.model, 'model-fast')
  assert.deepEqual(modelChanged.before, { provider: 'provider-ok', model: 'model-vision' })
  const modelEvent = events.find(item => item.event === 'executor.config.changed' && item.payload.field === 'model')
  assert.ok(modelEvent)
  assert.equal(modelEvent.payload.executorId, created.sessionId)
  assert.equal(modelEvent.payload.before.model, 'model-vision')
  assert.equal(modelEvent.payload.after.model, 'model-fast')
  const afterModel = await fixture.callAs(chat, 'ria_chat_worker_config', { action: 'get' })
  assert.equal(afterModel.executors.find(item => item.sessionId === created.sessionId).model.model, 'model-fast')

  // ⑦ A preset change without recreate is refused with an actionable error.
  const presetOnly = await fixture.callAs(chat, 'ria_chat_worker_config', { action: 'set', executorId: created.sessionId, preset: 'minimal' })
  assert.equal(presetOnly.ok, false)
  assert.equal(presetOnly.code, 'executor_preset_requires_recreate')
  assert.match(presetOnly.message, /重建 executor/)
  assert.equal(store.executor(created.sessionId).preset, 'standard')

  // ⑧ recreate: old binding stops being selectable, a new Executor appears in the
  // same cwd/type with the new preset, and the old session is archived.
  const recreated = await fixture.callAs(chat, 'ria_chat_worker_config', {
    action: 'set',
    executorId: created.sessionId,
    preset: 'minimal',
    recreate: true,
  })
  assert.equal(recreated.ok, true, JSON.stringify(recreated))
  assert.equal(recreated.recreated, true)
  assert.equal(recreated.previousExecutorId, created.sessionId)
  assert.equal(store.executor(created.sessionId), null)
  const replacement = store.executor(recreated.executor.sessionId)
  assert.ok(replacement)
  assert.equal(replacement.preset, 'minimal')
  assert.equal(replacement.executorType, 'work')
  assert.equal(replacement.cwd, listed.cwd)
  assert.equal(recreated.archivedOld, true)
  const presetEvent = events.find(item => item.event === 'executor.config.changed' && item.payload.field === 'preset')
  assert.ok(presetEvent)
  assert.equal(presetEvent.payload.before, 'standard')
  assert.equal(presetEvent.payload.after, 'minimal')
  assert.equal(presetEvent.payload.recreated, true)
  assert.equal(presetEvent.payload.newExecutorId, replacement.sessionId)

  // ⑨ Errors stay readable.
  const missing = await fixture.callAs(chat, 'ria_chat_worker_config', { action: 'set', executorId: 'session-nope', model: 'model-fast' })
  assert.equal(missing.ok, false)
  assert.equal(missing.code, 'executor_missing')
  const badPreset = await fixture.callAs(chat, 'ria_chat_worker_config', { action: 'set', executorId: replacement.sessionId, preset: 'danger' })
  assert.equal(badPreset.ok, false)
  assert.equal(badPreset.code, 'invalid_executor_preset')
  assert.match(badPreset.message, /ptc, standard, minimal/)
  const forbidden = await controller.chatExecutorConfig({ action: 'get' }, { agent: { id: 'session-not-chat' } })
  assert.equal(forbidden.ok, false)
  assert.equal(forbidden.code, 'forbidden')

  console.log('state executor config ok')
} finally {
  fixture.cleanup()
}
