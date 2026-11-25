import assert from 'node:assert/strict'
import { createFixture } from './support/ria-fixture.mjs'

// Reflection Executors follow Sage's live Session model selection through the
// normal Session-config path, while their preset is the fixed ptc preset. Work,
// Chat and Advisor sessions must keep their own models.

const fixture = await createFixture({ stateDefault: true })
try {
  const controller = fixture.service.controller
  const state = controller.state
  const chat = state.chatSessionId

  const chatCreate = fixture.creates.find(item => String(item.sessionId) === String(chat))
  assert.ok(chatCreate, 'Chat Session was created')
  assert.equal(chatCreate.agentPreset, 'standard', 'Chat creation preset is standard')
  assert.equal(chatCreate.cwd, fixture.stateDir, 'Chat is rooted at the Ria state directory')

  const chatBefore = await controller.executorModelOf(chat)
  const advisorId = await fixture.advisorSession()
  const advisorBefore = await controller.executorModelOf(advisorId)
  const work = await controller.ensureExecutor('global')
  const workBefore = await controller.executorModelOf(work.sessionId)
  assert.deepEqual(workBefore, { provider: 'provider-ok', model: 'model-vision' }, 'ordinary Executor keeps the host default')

  const sage = await controller.ensureSage()
  assert.equal(sage.preset, 'standard', 'Sage creation preset is standard')
  const sageCreate = fixture.creates.find(item => String(item.sessionId) === String(sage.sessionId))
  assert.ok(sageCreate, 'Sage Session was created')
  assert.equal(sageCreate.agentPreset, 'standard', 'Sage creation preset is standard')
  assert.equal(sageCreate.cwd, fixture.stateDir, 'Sage is rooted at the Ria state directory')

  const firstSelection = await controller.selectSessionModel(sage.sessionId, {
    provider: 'provider-ok', model: 'model-fast', reasoningEffort: 'high',
  })
  assert.equal(firstSelection.ok, true, JSON.stringify(firstSelection))
  const firstSageModel = await controller.executorModelOf(sage.sessionId)
  assert.deepEqual(firstSageModel, { provider: 'provider-ok', model: 'model-fast', reasoningEffort: 'high' })

  const first = await controller.ensureReflectionExecutor('global')
  assert.equal(first.created, true)
  assert.equal(first.preset, 'ptc', 'reflection Executor uses the fixed ptc preset')
  assert.equal(first.meta.preset, 'ptc')
  assert.equal(state.executor(first.sessionId).preset, 'ptc')
  const firstCreate = fixture.creates.find(item => String(item.sessionId) === String(first.sessionId))
  assert.ok(firstCreate, 'reflection Session was created')
  assert.equal(firstCreate.agentPreset, 'ptc', 'host create call receives ptc')
  assert.deepEqual(await controller.executorModelOf(first.sessionId), firstSageModel, 'new reflection copies Sage model/provider/reasoningEffort')

  // Changing Sage's model affects the NEXT reflection Executor, not the old one.
  const secondSelection = await controller.selectSessionModel(sage.sessionId, {
    provider: 'provider-ok', model: 'model-vision',
  })
  assert.equal(secondSelection.ok, true, JSON.stringify(secondSelection))
  const second = await controller.ensureReflectionExecutor('global')
  assert.notEqual(second.sessionId, first.sessionId)
  assert.equal(second.meta.preset, 'ptc')
  assert.deepEqual(await controller.executorModelOf(second.sessionId), { provider: 'provider-ok', model: 'model-vision' }, 'new reflection follows the changed Sage model')
  assert.deepEqual(await controller.executorModelOf(first.sessionId), firstSageModel, 'an existing reflection does not silently change model')

  // No regression: Chat, Advisor and ordinary work Executor keep their own
  // current model and preset through Sage model changes and reflection creation.
  assert.deepEqual(await controller.executorModelOf(chat), chatBefore, 'Chat model is unchanged')
  assert.deepEqual(await controller.executorModelOf(advisorId), advisorBefore, 'Advisor model is unchanged')
  assert.deepEqual(await controller.executorModelOf(work.sessionId), workBefore, 'ordinary Executor model is unchanged')
  assert.equal(state.data.riaPreset, 'standard', 'Chat preset stays standard')
  assert.equal(state.executor(work.sessionId).preset, 'ptc', 'ordinary Executor keeps the default ptc preset')

  console.log('reflection model/preset ok')
} finally {
  fixture.cleanup()
}
