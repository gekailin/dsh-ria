import assert from 'node:assert/strict'
import { createFixture } from './support/ria-fixture.mjs'

const fixture = await createFixture()
try {
  const spawned = await fixture.call('ria_spawn', { cwd: fixture.stateDir, title: 'Model Worker', model: 'model-fast' })
  assert.equal(spawned.ok, true)
  assert.equal(spawned.sessionId, 'session-spawn-1')
  assert.deepEqual(spawned.selected, { provider: 'provider-ok', model: 'model-fast' })
  assert.deepEqual(fixture.creates.find(request => !request.workspaceId), { cwd: fixture.stateDir })
  const spawnRename = fixture.renames.at(-1)
  assert.deepEqual(spawnRename, { sessionId: 'session-spawn-1', title: 'Model Worker' })

  let sessions = await fixture.call('ria_status', { scope: 'sessions' })
  const spawnedItem = sessions.sessions.find(item => item.sessionId === 'session-spawn-1')
  assert.equal(spawnedItem.provider, 'provider-ok')
  assert.equal(spawnedItem.model, 'model-fast')
  assert.equal('reasoningEffort' in spawnedItem, false)

  const changed = await fixture.call('ria_model', { sessionId: 'session-worker', model: 'model-fast', reasoningEffort: 'high' })
  assert.equal(changed.ok, true)
  assert.equal(changed.sessionId, 'session-worker')
  assert.deepEqual(changed.selected, { provider: 'provider-ok', model: 'model-fast', reasoningEffort: 'high' })
  assert.deepEqual(changed.previous, { provider: 'provider-ok', model: 'model-vision' })

  sessions = await fixture.call('ria_status', { scope: 'sessions' })
  const workerItem = sessions.sessions.find(item => item.sessionId === 'session-worker')
  assert.equal(workerItem.provider, 'provider-ok')
  assert.equal(workerItem.model, 'model-fast')
  assert.equal(workerItem.reasoningEffort, 'high')

  fixture.service.store.touchWorker('session-worker')
  const recent = await fixture.call('ria_status', { scope: 'recent' })
  const recentItem = recent.workers.find(item => item.sessionId === 'session-worker')
  assert.equal(recentItem.provider, 'provider-ok')
  assert.equal(recentItem.model, 'model-fast')
  assert.equal(recentItem.reasoningEffort, 'high')

  const unknown = await fixture.call('ria_model', { sessionId: 'session-worker', model: 'model-nope' })
  assert.equal(unknown.ok, false)
  assert.equal(unknown.code, 'model_not_found')
  assert.equal(unknown.sessionId, 'session-worker')
  assert.match(unknown.message, /找不到模型/)
  sessions = await fixture.call('ria_status', { scope: 'sessions' })
  assert.equal(sessions.sessions.find(item => item.sessionId === 'session-worker').model, 'model-fast')

  const ambiguous = await fixture.call('ria_model', { sessionId: 'session-worker', model: 'model-shared' })
  assert.equal(ambiguous.code, 'model_not_found')
  assert.match(ambiguous.message, /provider/)
  const resolvedShared = await fixture.call('ria_model', { sessionId: 'session-worker', model: 'model-shared', provider: 'provider-text' })
  assert.equal(resolvedShared.ok, true)
  assert.deepEqual(resolvedShared.selected, { provider: 'provider-text', model: 'model-shared' })

  const missing = await fixture.call('ria_model', { sessionId: 'session-missing', model: 'model-fast' })
  assert.deepEqual([missing.ok, missing.code, missing.sessionId], [false, 'session_missing', 'session-missing'])
  const subagent = await fixture.call('ria_model', { sessionId: 'session-subagent', model: 'model-fast' })
  assert.deepEqual([subagent.ok, subagent.code], [false, 'not_top_level'])

  const selfChanged = await fixture.call('ria_model', { sessionId: fixture.riaAgent.id, model: 'model-fast' })
  assert.equal(selfChanged.ok, true)
  assert.deepEqual(selfChanged.selected, { provider: 'provider-ok', model: 'model-fast' })

  const beforeInvalidSpawn = fixture.creates.length
  const invalidSpawn = await fixture.call('ria_spawn', { cwd: fixture.stateDir, model: 'model-nope' })
  assert.equal(invalidSpawn.ok, false)
  assert.equal(invalidSpawn.code, 'model_not_found')
  assert.equal(invalidSpawn.sessionId, undefined)
  assert.equal(fixture.creates.length, beforeInvalidSpawn)
} finally {
  fixture.cleanup()
}

const archivedFixture = await createFixture({ archivedSessionIds: ['session-worker'] })
try {
  const archived = await archivedFixture.call('ria_model', { sessionId: 'session-worker', model: 'model-fast' })
  assert.deepEqual([archived.ok, archived.code], [false, 'session_archived'])
} finally {
  archivedFixture.cleanup()
}

const selectFailure = await createFixture({ failSelectModel: new Error('model route unavailable') })
try {
  const failed = await selectFailure.call('ria_spawn', { cwd: selectFailure.stateDir, model: 'model-fast' })
  assert.equal(failed.ok, false)
  assert.equal(failed.code, 'model_not_found')
  assert.equal(failed.sessionId, 'session-spawn-1')
  assert.equal(failed.cwd, selectFailure.stateDir)
  assert.match(failed.message, /会话已创建/)
  assert.match(failed.message, /默认模型/)
  const sessions = await selectFailure.call('ria_status', { scope: 'sessions' })
  assert.equal(sessions.sessions.find(item => item.sessionId === 'session-spawn-1').model, 'model-vision')
} finally {
  selectFailure.cleanup()
}

// A partial catalog must not turn an ambiguous id into a guessed route.
const partialCatalog = await createFixture({ failListModelsProvider: 'provider-text' })
try {
  const changed = await partialCatalog.call('ria_model', { sessionId: 'session-worker', model: 'model-shared' })
  assert.equal(changed.ok, false)
  assert.equal(changed.code, 'model_not_found')
  assert.match(changed.message, /唯一性.*provider/)
  const beforeSpawn = partialCatalog.creates.length
  const spawned = await partialCatalog.call('ria_spawn', { cwd: partialCatalog.stateDir, model: 'model-shared' })
  assert.equal(spawned.code, 'model_not_found')
  assert.equal(partialCatalog.creates.length, beforeSpawn)
  const explicit = await partialCatalog.call('ria_model', { sessionId: 'session-worker', model: 'model-shared', provider: 'provider-ok' })
  assert.equal(explicit.ok, true)
  assert.equal(explicit.selected.provider, 'provider-ok')
} finally {
  partialCatalog.cleanup()
}

console.log('model ok')
