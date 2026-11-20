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
  const chatbot = store.chatSessionId
  const worker = await controller.ensureWorker('global', null, workspace)
  store.addWorker(worker.sessionId, { status: 'idle', currentTicketId: null, tags: ['frontend'], roleNote: '前端' })
  const topic = fixture.service.store.addTopic({ title: '前端主题', projectKey: projectKey(workspace) })

  const request = await fixture.callAs(chatbot, 'chatbot_request', {
    goal: 'frontend polish', workspace, preferredTags: ['frontend', 'docs'], topicId: topic.topicId,
  })
  assert.equal(request.ok, true, JSON.stringify(request))
  assert.equal(fixture.service.store.ticket(request.ticketId).executor, worker.sessionId)
  assert.deepEqual(store.ticketMeta(request.ticketId).routingTags, ['frontend', 'docs'])

  // Reset the dispatch-time learning so this test proves the done path.
  store.addWorker(worker.sessionId, { autoTags: [], recentTopics: [] })
  const done = await fixture.callAs(worker.sessionId, 'worker_report', {
    ticketId: request.ticketId, status: 'done', summary: 'completed', evidence: ['test: soft tags'],
  })
  assert.equal(done.ok, true, JSON.stringify(done))
  assert.equal(fixture.service.store.ticket(request.ticketId).status, 'done')

  const learned = store.worker(worker.sessionId)
  assert.deepEqual(learned.tags, ['frontend'], 'explicit tags stay untouched')
  assert.deepEqual(learned.autoTags, ['docs'], 'only non-explicit tags are learned')
  assert.deepEqual(learned.recentTopics, [topic.topicId])
  assert.equal(learned.autoTags.includes('frontend'), false)
  console.log('worker soft tags on done ok')
} finally {
  fixture.cleanup()
  rmSync(workspace, { recursive: true, force: true })
}
