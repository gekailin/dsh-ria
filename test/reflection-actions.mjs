import assert from 'node:assert/strict'
import { createFixture } from './support/ria-fixture.mjs'

const fixture = await createFixture({ stateDefault: true })
try {
  const service = fixture.service
  service.applyReflectionCognitionActions({ runId: 'run-test' }, [
    { kind: 'add', scope: 'project:dsh-ria', body: 'reflection action body', cause: 'reflection', sources: [{ type: 'reflection', ref: 'run-test' }], reason: 'test' },
    { kind: 'retire', targetEntryId: 'cog_1', scope: 'global', body: 'retire action', cause: 'stale', sources: [{ type: 'reflection', ref: 'run-test' }] },
  ])
  const proposals = service.controller.cognition.listProposals().filter(item => item.source === 'ria_reflect_report')
  assert.equal(proposals.length, 2)
  assert.ok(proposals.some(item => item.body === 'reflection action body' && item.priority === 'high'))
  assert.ok(proposals.some(item => item.kind === 'retire' && item.targetEntryId === 'cog_1'))
  console.log('reflection actions ok')
} finally { fixture.cleanup() }
