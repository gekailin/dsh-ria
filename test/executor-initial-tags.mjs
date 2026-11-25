import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { createFixture } from './support/ria-fixture.mjs'

const workspace = mkdtempSync(join(tmpdir(), 'ria-initial-tags-'))
const fixture = await createFixture({ stateDefault: true })
try {
  const controller = fixture.service.controller
  const first = await controller.ensureExecutor('global', null, undefined, null, null, null, { ticketTags: ['frontend'] })
  const firstMeta = controller.state.executor(first.sessionId)
  assert.equal(first.created, true)
  assert.ok(firstMeta.tags.length > 0, 'new work Executor must have non-empty initial tags')
  assert.ok(firstMeta.tags.includes('frontend'), JSON.stringify(firstMeta.tags))

  const second = await controller.ensureExecutor('global', 'proj-x', workspace, null, null, null, {
    avoidExecutorIds: new Set([first.sessionId]),
  })
  const secondMeta = controller.state.executor(second.sessionId)
  assert.equal(second.created, true)
  assert.ok(secondMeta.tags.length > 0, 'fallback tags must still be non-empty')
  assert.ok(secondMeta.tags.some(tag => ['proj-x', basename(workspace), 'general'].includes(tag)), JSON.stringify(secondMeta.tags))
  console.log('executor initial tags ok')
} finally {
  fixture.cleanup()
}
