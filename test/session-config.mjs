import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFixture } from './support/ria-fixture.mjs'

// Chat-side ordinary Session configuration:
// - ria_chat_session_config get/set/rename
// - ria_chat_new_session initial model/effort/sandbox/approval
// - strict model and enum validation, plus executor_config deprecated forwarding

const cwd = mkdtempSync(join(tmpdir(), 'ria-session-config-'))
const fixture = await createFixture({ stateDefault: true })
const events = []
fixture.service.routerEvent = event => { events.push(event) }
const chat = fixture.service.controller.state.chatSessionId
const call = (name, args) => fixture.callAs(chat, name, args)
const eventOf = (name, sessionId) => events.find(item => item.event === name && (!sessionId || item.sessionId === sessionId))

try {
  // 1. new_session applies initial model/effort/sandbox/approval once.
  const created = await call('ria_chat_new_session', {
    title: 'Configured Session', cwd,
    model: 'model-fast', provider: 'provider-ok', reasoningEffort: 'high',
    sandboxMode: 'read-only', approvalPolicy: 'never',
  })
  assert.equal(created.ok, true, JSON.stringify(created))
  assert.equal(created.model, 'model-fast')
  assert.equal(created.provider, 'provider-ok')
  assert.equal(created.reasoningEffort, 'high')
  assert.equal(created.sandboxMode, 'read-only')
  assert.equal(created.approvalPolicy, 'never')
  const got = await call('ria_chat_session_config', { action: 'get', sessionId: created.sessionId })
  assert.equal(got.ok, true, JSON.stringify(got))
  assert.equal(got.sessionId, created.sessionId)
  assert.equal(got.title, 'Configured Session')
  assert.equal(got.cwd, cwd)
  assert.equal(got.model, 'model-fast')
  assert.equal(got.provider, 'provider-ok')
  assert.equal(got.reasoningEffort, 'high')
  assert.equal(got.sandboxMode, 'read-only')
  assert.equal(got.approvalPolicy, 'never')
  const createdEvent = eventOf('session.created', created.sessionId)
  assert.ok(createdEvent, JSON.stringify(events))
  assert.equal(createdEvent.payload.model, 'model-fast')
  assert.equal(createdEvent.payload.reasoningEffort, 'high')
  assert.equal(createdEvent.payload.sandboxMode, 'read-only')
  assert.equal(createdEvent.payload.approvalPolicy, 'never')

  // A plain new session reads back the deployment defaults.
  const plain = await call('ria_chat_new_session', { title: 'Plain Session', cwd })
  assert.equal(plain.ok, true, JSON.stringify(plain))
  const plainGet = await call('ria_chat_session_config', { action: 'get', sessionId: plain.sessionId })
  assert.equal(plainGet.sandboxMode, 'workspace-write')
  assert.equal(plainGet.approvalPolicy, 'ask')
  assert.equal(plainGet.model, 'model-vision')

  // 2. set model succeeds, is audited, and reads back; next-turn semantics.
  const changed = await call('ria_chat_session_config', {
    action: 'set', sessionId: created.sessionId,
    model: 'model-vision', provider: 'provider-ok', reason: 'switch model',
  })
  assert.equal(changed.ok, true, JSON.stringify(changed))
  assert.equal(changed.effective, 'next-turn')
  assert.equal(changed.after.model, 'model-vision')
  const afterSet = await call('ria_chat_session_config', { action: 'get', sessionId: created.sessionId })
  assert.equal(afterSet.model, 'model-vision')
  const modelEvent = eventOf('session.model.changed', created.sessionId)
  assert.ok(modelEvent, JSON.stringify(events))
  assert.equal(modelEvent.payload.from.model, 'model-fast')
  assert.equal(modelEvent.payload.to.model, 'model-vision')
  assert.equal(modelEvent.payload.reason, 'switch model')

  // 3. Invalid / ambiguous models are invalid_argument with candidates.
  const invalid = await call('ria_chat_session_config', { action: 'set', sessionId: created.sessionId, model: 'model-nope' })
  assert.equal(invalid.ok, false)
  assert.equal(invalid.code, 'invalid_argument')
  assert.equal(invalid.field, 'model')
  assert.ok(Array.isArray(invalid.candidates) && invalid.candidates.some(item => item.provider === 'provider-ok' && item.model === 'model-vision'))
  assert.match(invalid.message, /provider-ok\/model-vision/)
  const ambiguous = await call('ria_chat_session_config', { action: 'set', sessionId: created.sessionId, model: 'model-shared' })
  assert.equal(ambiguous.ok, false)
  assert.equal(ambiguous.code, 'invalid_argument')
  assert.equal(ambiguous.field, 'provider')
  assert.deepEqual(ambiguous.candidates.map(item => item.provider + '/' + item.model).sort(), ['provider-ok/model-shared', 'provider-text/model-shared'])

  // 4. Chat and managed Executor targets are rejected with distinct codes.
  const chatSelf = await call('ria_chat_session_config', { action: 'set', sessionId: chat, model: 'model-fast', provider: 'provider-ok' })
  assert.equal(chatSelf.ok, false)
  assert.equal(chatSelf.code, 'chat_session_not_editable')
  const managed = await fixture.service.controller.ensureExecutor('global')
  const managedSet = await call('ria_chat_session_config', { action: 'set', sessionId: managed.sessionId, model: 'model-fast', provider: 'provider-ok' })
  assert.equal(managedSet.ok, false)
  assert.equal(managedSet.code, 'managed_executor_not_editable')
  assert.match(managedSet.message, /ria_chat_executor_config/)

  // 5. Permission fields are explicitly rejected here.
  const permission = await call('ria_chat_session_config', { action: 'set', sessionId: created.sessionId, sandboxMode: 'read-only' })
  assert.equal(permission.ok, false)
  assert.equal(permission.code, 'permission_change_forbidden')
  assert.match(permission.message, /ria_chat_grant/)

  // 6. Rename uses the normal rename channel and audits; duplicates are only a warning.
  const renamed = await call('ria_chat_session_config', { action: 'rename', sessionId: created.sessionId, newTitle: '  Renamed Session  ' })
  assert.equal(renamed.ok, true, JSON.stringify(renamed))
  assert.equal(renamed.to, 'Renamed Session')
  assert.equal(renamed.renamed, true)
  const renamedView = await call('ria_chat_session_config', { action: 'get', sessionId: created.sessionId })
  assert.equal(renamedView.title, 'Renamed Session')
  const renameEvent = eventOf('session.renamed', created.sessionId)
  assert.ok(renameEvent, JSON.stringify(events))
  assert.equal(renameEvent.payload.from, 'Configured Session')
  assert.equal(renameEvent.payload.to, 'Renamed Session')
  assert.match(renameEvent.payload.sessionId, /^session-/)
  const byTitle = await call('ria_chat_session_config', { action: 'get', title: 'Renamed Session' })
  assert.equal(byTitle.ok, true, JSON.stringify(byTitle))
  assert.equal(byTitle.sessionId, created.sessionId)
  const duplicate = await call('ria_chat_session_config', { action: 'rename', sessionId: plain.sessionId, newTitle: 'Renamed Session' })
  assert.equal(duplicate.ok, true, JSON.stringify(duplicate))
  assert.equal(duplicate.duplicateTitle, true)
  assert.match(duplicate.warning, /already uses this title/)
  assert.ok(duplicate.duplicateSessions.some(item => item.sessionId === created.sessionId))

  // 7. Empty/too-long rename titles are invalid_argument; ambiguous titles are rejected.
  const emptyTitle = await call('ria_chat_session_config', { action: 'rename', sessionId: created.sessionId, newTitle: '   ' })
  assert.equal(emptyTitle.ok, false)
  assert.equal(emptyTitle.code, 'invalid_argument')
  assert.equal(emptyTitle.field, 'newTitle')
  const longTitle = await call('ria_chat_session_config', { action: 'rename', sessionId: created.sessionId, newTitle: 'x'.repeat(81) })
  assert.equal(longTitle.ok, false)
  assert.equal(longTitle.code, 'invalid_argument')
  assert.equal(longTitle.field, 'newTitle')
  const titleGet = await call('ria_chat_session_config', { action: 'get', title: 'Renamed Session' })
  assert.equal(titleGet.ok, false)
  assert.equal(titleGet.code, 'session_ambiguous')
  assert.ok(titleGet.candidates.length >= 2)

  // 8. Strict unknown/enum validation on both tools.
  const unknownConfig = await call('ria_chat_session_config', { action: 'get', sessionId: created.sessionId, bogus: true })
  assert.equal(unknownConfig.ok, false)
  assert.equal(unknownConfig.code, 'unknown_parameter')
  assert.equal(unknownConfig.field, 'bogus')
  const unknownNew = await call('ria_chat_new_session', { title: 'Bad', cwd, bogus: true })
  assert.equal(unknownNew.ok, false)
  assert.equal(unknownNew.code, 'unknown_parameter')
  assert.equal(unknownNew.field, 'bogus')
  const badSandbox = await call('ria_chat_new_session', { title: 'Bad', cwd, sandboxMode: 'bogus' })
  assert.equal(badSandbox.ok, false)
  assert.equal(badSandbox.code, 'invalid_argument')
  assert.equal(badSandbox.field, 'sandboxMode')
  const badApproval = await call('ria_chat_new_session', { title: 'Bad', cwd, approvalPolicy: 'bogus' })
  assert.equal(badApproval.ok, false)
  assert.equal(badApproval.code, 'invalid_argument')
  assert.equal(badApproval.field, 'approvalPolicy')
  const badModelNew = await call('ria_chat_new_session', { title: 'Bad', cwd, model: 'model-nope' })
  assert.equal(badModelNew.ok, false)
  assert.equal(badModelNew.code, 'invalid_argument')
  assert.ok(Array.isArray(badModelNew.candidates) && badModelNew.candidates.length > 0)

  // 9. executor_config model params are deprecated and forwarded to session_config.
  const combined = await call('ria_chat_executor_config', {
    action: 'set', executorId: managed.sessionId,
    model: 'model-fast', provider: 'provider-ok', allowAutoDispatch: false,
  })
  assert.equal(combined.ok, true, JSON.stringify(combined))
  assert.equal(combined.deprecated, true)
  assert.deepEqual(combined.deprecatedParams.sort(), ['model', 'provider'])
  assert.equal(combined.after.model, 'model-fast')
  assert.deepEqual(combined.autoDispatch, { before: true, after: false })
  assert.equal(combined.executor.allowAutoDispatch, false)
  const compatModelEvent = events.find(item => item.event === 'session.model.changed' && item.payload.sessionId === managed.sessionId)
  assert.ok(compatModelEvent, JSON.stringify(events))
  const deprecatedEvent = events.find(item => item.event === 'tool.param_deprecated' && item.payload.tool === 'ria_chat_executor_config')
  assert.ok(deprecatedEvent, JSON.stringify(events))
  assert.deepEqual(deprecatedEvent.payload.params.sort(), ['model', 'provider'])
  assert.equal(deprecatedEvent.payload.replacement, 'ria_chat_session_config')
  const executorAfter = await call('ria_chat_executor_config', { action: 'get' })
  const managedView = executorAfter.executors.find(item => item.sessionId === managed.sessionId)
  assert.equal(managedView.model.model, 'model-fast')
  assert.equal(managedView.allowAutoDispatch, false)
  // Non-model executor config still behaves as before.
  const tagged = await call('ria_chat_executor_config', { action: 'set', executorId: managed.sessionId, tags: ['docs'], dedicated: true })
  assert.equal(tagged.ok, true, JSON.stringify(tagged))
  assert.deepEqual(tagged.executor.tags, ['docs'])
  assert.equal(tagged.executor.dedicated, true)

  // 10. Tool descriptions state the responsibility boundary.
  const chatTools = fixture.agentTools.get(chat)
  const sessionDef = chatTools && chatTools.get('ria_chat_session_config')
  const executorDef = chatTools && chatTools.get('ria_chat_executor_config')
  assert.ok(sessionDef && executorDef)
  assert.match(sessionDef.description, /rename/)
  assert.match(sessionDef.description, /managed Executors/)
  assert.match(executorDef.description, /ria_chat_session_config/)
  assert.match(executorDef.description, /allowAutoDispatch/)
  assert.match(executorDef.description, /tool\.param_deprecated/)

  console.log('state session config ok')
} finally {
  fixture.cleanup()
  rmSync(cwd, { recursive: true, force: true })
}
