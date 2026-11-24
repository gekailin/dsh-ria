import assert from 'node:assert/strict'
import { createFixture } from './support/ria-fixture.mjs'
import { SAGE_PRINCIPLES_MAX_CHARS } from '../lib/core/prompts.mjs'

const fixture = await createFixture({ stateDefault: true })
try {
  const controller = fixture.service.controller
  controller.cognition.upsertEntry({
    scope: 'principle',
    kind: 'preference',
    body: '原则：' + '很长'.repeat(100),
    cause: '核心原则测试',
    sources: [{ type: 'file', ref: 'DESIGN.md' }],
  })
  controller.cognition.upsertEntry({
    scope: 'project:dsh-ria',
    kind: 'experience',
    body: '静态项目事实',
    cause: '项目事实不应注入 Sage 系统提示词',
    sources: [{ type: 'file', ref: 'lib/roles/cognition.mjs' }],
  })
  const sage = (await controller.ensureSage()).sessionId
  const prompt = fixture.systemPrompts.get(sage)
  assert.ok(prompt.includes('你是 Sage（Ria 的慢脑）'))
  assert.ok(prompt.includes('[PRINCIPLES 摘要]'))
  assert.ok(prompt.includes('SQLite cognition_entries'))
  assert.ok(prompt.includes('需要最新认知时用 ria_sage_read'))
  assert.equal(prompt.includes('[COGNITION INDEX]'), false)
  assert.equal(prompt.includes('静态项目事实'), false)
  assert.equal(prompt.includes('上限 ' + SAGE_PRINCIPLES_MAX_CHARS), true)

  // Scope validation rejects unnormalized scopes.
  const badScope = controller.cognition.upsertEntry({
    scope: 'dsh-ria/ticket-settlement',
    body: 'bad scope',
    cause: 'test',
    sources: [{ type: 'file', ref: 'test' }],
  })
  assert.equal(badScope.ok, false)
  assert.equal(badScope.code, 'cognition_invalid')
  assert.equal(badScope.field, 'scope')

  // Updating a missing explicit id fails closed instead of inserting a colliding id.
  const missingId = controller.cognition.upsertEntry({
    id: 'cog_99999',
    scope: 'global',
    body: 'missing',
    cause: 'test',
    sources: [{ type: 'file', ref: 'test' }],
  })
  assert.equal(missingId.ok, false)
  assert.equal(missingId.code, 'cognition_missing')

  console.log('state sage prompt ok')
} finally {
  fixture.cleanup()
}
