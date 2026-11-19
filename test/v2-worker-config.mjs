import assert from 'node:assert/strict'
import { createFixture } from './support/ria-fixture.mjs'

// New Workers may name a preset; existing Workers keep theirs when reused.
// chatbot_worker_config reads configuration and changes model live, while a
// preset change needs a recreate (DSH has no live preset switch).

const fixture = await createFixture({ v2Default: true })
const events = []
fixture.service.routerEvent = event => { events.push(event) }

try {
  const controller = fixture.service.v2
  const store = controller.v2
  const chatbot = fixture.service.v2.v2.chatbotSessionId

  async function planAndDispatch(request) {
    const plan = await fixture.callAs(controller.v2.advisor('global').sessionId, 'ticket_plan', {
      ticketId: request.ticketId,
      summary: 'do it',
      steps: ['step one'],
    })
    assert.equal(plan.ok, true, JSON.stringify(plan))
    const dispatched = await fixture.callAs(controller.v2.advisor('global').sessionId, 'ticket_dispatch', { ticketId: request.ticketId })
    assert.equal(dispatched.ok, true, JSON.stringify(dispatched))
    return dispatched
  }

  // ① A work ticket with workerPreset creates the Worker with that preset.
  const custom = await fixture.callAs(chatbot, 'chatbot_request', { goal: 'custom preset worker', workerPreset: 'standard' })
  assert.equal(custom.ok, true, JSON.stringify(custom))
  assert.equal(controller.v2.ticketMeta(custom.ticketId).workerPreset, 'standard')
  const customDispatch = await planAndDispatch(custom)
  const customMeta = store.worker(customDispatch.workerSessionId)
  assert.equal(customMeta.preset, 'standard')
  const customCreate = fixture.creates.find(item => String(item.sessionId) === String(customDispatch.workerSessionId))
  assert.ok(customCreate, 'the Worker session was created')
  assert.equal(customCreate.agentPreset, 'standard')

  // ② A ticket without workerPreset keeps the default (ptc). The first Worker
  // is busy, so a new one is created.
  const plain = await fixture.callAs(chatbot, 'chatbot_request', { goal: 'default preset worker' })
  assert.equal(plain.ok, true)
  assert.equal(controller.v2.ticketMeta(plain.ticketId).workerPreset, undefined)
  const plainDispatch = await planAndDispatch(plain)
  assert.notEqual(plainDispatch.workerSessionId, customDispatch.workerSessionId)
  const plainMeta = store.worker(plainDispatch.workerSessionId)
  assert.equal(plainMeta.preset, 'ptc')
  const plainCreate = fixture.creates.find(item => String(item.sessionId) === String(plainDispatch.workerSessionId))
  assert.equal(plainCreate.agentPreset, 'ptc')

  // ③ An unknown preset is refused with the allow-list in the message.
  const invalid = await fixture.callAs(chatbot, 'chatbot_request', { goal: 'bad preset', workerPreset: 'danger' })
  assert.equal(invalid.ok, false)
  assert.equal(invalid.code, 'invalid_worker_preset')
  assert.match(invalid.message, /ptc, standard, minimal/)
  // Preset is a work-ticket option only.
  const answerPreset = await fixture.callAs(chatbot, 'chatbot_request', { goal: 'bad mode', mode: 'answer', workerPreset: 'standard' })
  assert.equal(answerPreset.ok, false)
  assert.equal(answerPreset.code, 'worker_preset_not_supported')

  // ④ Reuse keeps the Worker's own preset; a different request does not
  // silently re-configure it.
  const created = await controller.ensureWorker('global', null, undefined, null, 'standard')
  assert.equal(created.created, true)
  store.addWorker(created.sessionId, { status: 'idle', currentTicketId: null })
  const reused = await controller.ensureWorker('global', null, undefined, null, 'minimal')
  assert.equal(reused.created, false)
  assert.equal(reused.sessionId, created.sessionId)
  assert.equal(reused.preset, 'standard', 'reused Workers keep their creation preset')
  assert.equal(store.worker(created.sessionId).preset, 'standard')

  // ⑤ chatbot_worker_config get lists the fields the Chatbot needs.
  const list = await fixture.callAs(chatbot, 'chatbot_worker_config', { action: 'get' })
  assert.equal(list.ok, true)
  assert.deepEqual(list.presets, ['ptc', 'standard', 'minimal'])
  const listed = list.workers.find(item => item.sessionId === created.sessionId)
  assert.ok(listed, 'the newly created Worker is listed')
  assert.equal(listed.workerType, 'work')
  assert.equal(listed.preset, 'standard')
  assert.equal(typeof listed.seq, 'number')
  assert.match(listed.title, /Worker/)
  assert.equal(listed.cwd, store.worker(created.sessionId).cwd)
  assert.equal(listed.status, 'idle')
  assert.deepEqual(listed.model, { provider: 'provider-ok', model: 'model-vision' })

  // ⑥ Model changes apply live and emit worker.config.changed.
  const modelChanged = await fixture.callAs(chatbot, 'chatbot_worker_config', { action: 'set', workerId: created.sessionId, model: 'model-fast', provider: 'provider-ok' })
  assert.equal(modelChanged.ok, true, JSON.stringify(modelChanged))
  assert.equal(modelChanged.recreated, false)
  assert.equal(modelChanged.after.model, 'model-fast')
  assert.deepEqual(modelChanged.before, { provider: 'provider-ok', model: 'model-vision' })
  const modelEvent = events.find(item => item.event === 'worker.config.changed' && item.payload.field === 'model')
  assert.ok(modelEvent)
  assert.equal(modelEvent.payload.workerId, created.sessionId)
  assert.equal(modelEvent.payload.before.model, 'model-vision')
  assert.equal(modelEvent.payload.after.model, 'model-fast')
  const afterModel = await fixture.callAs(chatbot, 'chatbot_worker_config', { action: 'get' })
  assert.equal(afterModel.workers.find(item => item.sessionId === created.sessionId).model.model, 'model-fast')

  // ⑦ A preset change without recreate is refused with an actionable error.
  const presetOnly = await fixture.callAs(chatbot, 'chatbot_worker_config', { action: 'set', workerId: created.sessionId, preset: 'minimal' })
  assert.equal(presetOnly.ok, false)
  assert.equal(presetOnly.code, 'worker_preset_requires_recreate')
  assert.match(presetOnly.message, /重建 worker/)
  assert.equal(store.worker(created.sessionId).preset, 'standard')

  // ⑧ recreate: old binding stops being selectable, a new Worker appears in the
  // same cwd/type with the new preset, and the old session is archived.
  const recreated = await fixture.callAs(chatbot, 'chatbot_worker_config', {
    action: 'set',
    workerId: created.sessionId,
    preset: 'minimal',
    recreate: true,
  })
  assert.equal(recreated.ok, true, JSON.stringify(recreated))
  assert.equal(recreated.recreated, true)
  assert.equal(recreated.previousWorkerId, created.sessionId)
  assert.equal(store.worker(created.sessionId), null)
  const replacement = store.worker(recreated.worker.sessionId)
  assert.ok(replacement)
  assert.equal(replacement.preset, 'minimal')
  assert.equal(replacement.workerType, 'work')
  assert.equal(replacement.cwd, listed.cwd)
  assert.equal(recreated.archivedOld, true)
  const presetEvent = events.find(item => item.event === 'worker.config.changed' && item.payload.field === 'preset')
  assert.ok(presetEvent)
  assert.equal(presetEvent.payload.before, 'standard')
  assert.equal(presetEvent.payload.after, 'minimal')
  assert.equal(presetEvent.payload.recreated, true)
  assert.equal(presetEvent.payload.newWorkerId, replacement.sessionId)

  // ⑨ Errors stay readable.
  const missing = await fixture.callAs(chatbot, 'chatbot_worker_config', { action: 'set', workerId: 'session-nope', model: 'model-fast' })
  assert.equal(missing.ok, false)
  assert.equal(missing.code, 'worker_missing')
  const badPreset = await fixture.callAs(chatbot, 'chatbot_worker_config', { action: 'set', workerId: replacement.sessionId, preset: 'danger' })
  assert.equal(badPreset.ok, false)
  assert.equal(badPreset.code, 'invalid_worker_preset')
  assert.match(badPreset.message, /ptc, standard, minimal/)
  const forbidden = await controller.chatbotWorkerConfig({ action: 'get' }, { agent: { id: 'session-not-chatbot' } })
  assert.equal(forbidden.ok, false)
  assert.equal(forbidden.code, 'forbidden')

  console.log('v2 worker config ok')
} finally {
  fixture.cleanup()
}
