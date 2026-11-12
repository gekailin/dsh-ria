import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { createFixture } from './support/ria-fixture.mjs'

const fixture = await createFixture()
try {
  const existing = await fixture.call('ria_spawn', { cwd: fixture.stateDir })
  assert.equal(existing.ok, true)
  assert.equal(existing.workspaceId, 'workspace-ria')
  assert.equal(existing.workspaceError, undefined)
  assert.deepEqual(fixture.workspaceAttachments.at(-1), {
    key: 'workspace-ria:' + existing.sessionId,
    workspaceId: 'workspace-ria',
    sessionId: existing.sessionId,
  })

  const nestedCwd = join(fixture.stateDir, 'scratch')
  mkdirSync(nestedCwd)
  const nested = await fixture.call('ria_spawn', { cwd: nestedCwd })
  assert.equal(nested.ok, true)
  assert.equal(nested.workspaceId, 'workspace-1')
  assert.deepEqual(fixture.workspaceCalls.at(-1), { path: nestedCwd, title: 'scratch' })
  assert.equal(fixture.workspaces.get('workspace-1').path, nestedCwd)
  assert.deepEqual(fixture.workspaceAttachments.at(-1), {
    key: 'workspace-1:' + nested.sessionId,
    workspaceId: 'workspace-1',
    sessionId: nested.sessionId,
  })
} finally {
  fixture.cleanup()
}

const failing = await createFixture({ failAttach: 'workspace storage unavailable' })
try {
  const spawned = await failing.call('ria_spawn', { cwd: failing.stateDir })
  assert.equal(spawned.ok, true)
  assert.equal(spawned.workspaceId, 'workspace-ria')
  assert.equal(spawned.workspaceError, 'workspace storage unavailable')
  assert.equal(failing.workspaceAttachments.length, 0)
} finally {
  failing.cleanup()
}

console.log('workspace spawn ok')
