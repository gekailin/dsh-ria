import assert from 'node:assert/strict'
import { createFixture } from './support/ria-fixture.mjs'

const fixture = await createFixture()
try {
  fixture.service.store.touchWorker('session-worker')
  await fixture.service.startup()
  assert.deepEqual(fixture.workspaceAttachments, [{
    key: 'workspace-ria:session-worker',
    workspaceId: 'workspace-ria',
    sessionId: 'session-worker',
  }])
  assert.equal(await fixture.service.reconcileWorkspaceSessions(), 0)
  assert.equal(fixture.workspaceAttachments.length, 1)
} finally {
  fixture.cleanup()
}

const failing = await createFixture({ failAttach: 'workspace storage unavailable' })
try {
  failing.service.store.touchWorker('session-worker')
  assert.equal(await failing.service.reconcileWorkspaceSessions(), 0)
  assert.equal(failing.workspaceAttachments.length, 0)
} finally {
  failing.cleanup()
}

console.log('workspace reconcile ok')
