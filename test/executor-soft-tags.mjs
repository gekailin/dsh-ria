import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFixture } from './support/ria-fixture.mjs'
import { projectKey } from '../lib/roles/cognition.mjs'

const workspace = mkdtempSync(join(tmpdir(), 'ria-soft-tags-'))
const fixture = await createFixture({
  stateDefault: true,
  advisorPlan: 'stateless',
  llmReply: JSON.stringify({ action: 'plan', workOrder: { summary: 'do the work', steps: ['do it'] } }),
})
try {
  const controller = fixture.service.controller
  const store = controller.state
  const chat = store.chatSessionId
  const executor = await controller.ensureExecutor('global', null, workspace)
  store.addExecutor(executor.sessionId, { status: 'idle', currentTicketId: null, tags: ['frontend'], roleNote: '前端' })
  const topic = fixture.service.store.addTopic({ title: '前端主题', projectKey: projectKey(workspace) })

  const request = await fixture.callAs(chat, 'ria_chat_request', {
    goal: 'frontend polish', workspace, preferredTags: ['frontend', 'docs'], topicId: topic.topicId,
  })
  assert.equal(request.ok, true, JSON.stringify(request))
  assert.equal(fixture.service.store.ticket(request.ticketId).executor, executor.sessionId)
  assert.deepEqual(store.ticketMeta(request.ticketId).routingTags, ['frontend', 'docs'])
  assert.deepEqual(store.executor(executor.sessionId).tags, ['frontend', 'docs'], 'dispatch actively updates managed work executor tags')

  // Simulate a topic tag added after dispatch so done learns non-explicit tags into autoTags.
  fixture.service.store.updateTopic(topic.topicId, { tags: ['topic-only'] })
  store.addExecutor(executor.sessionId, { autoTags: {}, recentTopics: [] })
  const done = await fixture.callAs(executor.sessionId, 'ria_executor_report', {
    ticketId: request.ticketId, status: 'done', summary: 'completed', evidence: ['test: soft tags'],
  })
  assert.equal(done.ok, true, JSON.stringify(done))
  assert.equal(fixture.service.store.ticket(request.ticketId).status, 'done')

  const learned = store.executor(executor.sessionId)
  assert.deepEqual(learned.tags, ['frontend', 'docs'], 'done does not overwrite dispatch-maintained tags')
  assert.deepEqual(learned.autoTags, { 'topic-only': 1 }, 'only non-explicit tags are learned into autoTags')
  assert.deepEqual(learned.recentTopics, [topic.topicId])
  assert.equal(Object.hasOwn(learned.autoTags, 'frontend'), false)
  assert.equal(Object.hasOwn(learned.autoTags, 'docs'), false)
  console.log('executor soft tags on done ok')
} finally {
  fixture.cleanup()
  rmSync(workspace, { recursive: true, force: true })
}
