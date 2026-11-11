import assert from 'node:assert/strict'
import { join } from 'node:path'
import { createFixture } from './support/ria-fixture.mjs'

const fixture = await createFixture()
try {
  const created = await fixture.call('ria_spawn', { cwd: fixture.stateDir, title: 'Builder' })
  assert.equal(created.ok, true)
  assert.equal(created.sessionId, 'session-spawn-1')
  assert.equal(created.cwd, fixture.stateDir)
  assert.equal(created.title, 'Builder')
  const spawnRequest = fixture.creates.find(request => !request.workspaceId)
  assert.deepEqual(spawnRequest, { cwd: fixture.stateDir })
  assert.deepEqual(fixture.renames.at(-1), { sessionId: 'session-spawn-1', title: 'Builder' })

  const sessions = await fixture.call('ria_status', { scope: 'sessions' })
  const spawned = sessions.sessions.find(session => session.sessionId === 'session-spawn-1')
  assert.ok(spawned)
  assert.equal(spawned.cwd, fixture.stateDir)
  assert.equal(spawned.title, 'Builder')
  assert.equal(spawned.blank, true)
  assert.equal(spawned.archived, false)
  assert.equal('origin' in spawned, false)
  assert.equal('parentSessionId' in spawned, false)

  const countBefore = fixture.creates.length
  const missing = await fixture.call('ria_spawn', { cwd: join(fixture.stateDir, 'missing') })
  assert.deepEqual(missing, {
    ok: false,
    code: 'workspace_missing',
    message: missing.message,
    error: missing.message,
  })
  assert.match(missing.message, /工作目录不存在/)
  assert.equal(fixture.creates.length, countBefore)

  const relative = await fixture.call('ria_spawn', { cwd: 'relative-dir' })
  assert.equal(relative.ok, false)
  assert.equal(relative.code, 'workspace_missing')
  assert.match(relative.message, /绝对路径/)
  assert.equal(fixture.creates.length, countBefore)

  const preset = await fixture.call('ria_spawn', { cwd: fixture.stateDir, agentPreset: 'missing-preset' })
  assert.equal(preset.ok, true)
  assert.equal(preset.agentPreset, 'missing-preset')
  assert.deepEqual(fixture.creates.at(-1), { cwd: fixture.stateDir, agentPreset: 'missing-preset' })
} finally {
  fixture.cleanup()
}

const presetFailure = await createFixture({
  failCreate: Object.assign(new Error('preset not found: missing'), { code: 'session/preset-not-found' }),
})
try {
  const result = await presetFailure.call('ria_spawn', { cwd: presetFailure.stateDir })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'preset_not_found')
  assert.match(result.message, /preset not found/)
} finally {
  presetFailure.cleanup()
}

const renameFailure = await createFixture({ failRename: new Error('title service unavailable') })
try {
  const result = await renameFailure.call('ria_spawn', { cwd: renameFailure.stateDir, title: 'Builder' })
  assert.equal(result.ok, true)
  assert.equal(result.sessionId, 'session-spawn-1')
  assert.equal(result.titleError, 'title service unavailable')
} finally {
  renameFailure.cleanup()
}

console.log('spawn ok')
