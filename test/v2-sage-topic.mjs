import assert from 'node:assert/strict'
import { createFixture } from './support/ria-fixture.mjs'

// Sage topic gardener: structure only, never ticket state or dispatch.
const fixture = await createFixture({ v2Default: true, advisorPlan: 'stateless' })
try {
  const controller = fixture.service.v2
  const store = fixture.service.store
  const sage = (await controller.ensureSage()).sessionId
  const chatbot = controller.v2.chatSessionId
  const call = args => fixture.callAs(sage, 'sage_topic', args)

  const topicA = store.addTopic({ title: '重复主题 A', brief: 'first' })
  const topicB = store.addTopic({ title: '目标主题 B' })
  const openTicket = store.addTicket({ status: 'open', waitingOn: 'ria', executor: 'advisor', goal: 'open work', acceptance: 'x' })
  store.linkTicket(topicA.topicId, openTicket.ticketId, 'primary')

  // 1. list includes the active topics and their ticket progress.
  const listed = await call({ action: 'list' })
  assert.equal(listed.ok, true, JSON.stringify(listed))
  const row = listed.topics.find(item => item.topicId === topicA.topicId)
  assert.ok(row)
  assert.equal(row.ticketCount, 1)
  assert.equal(row.progress.open, 1)

  // 2. update edits structure only.
  const updated = await call({ action: 'update', topicId: topicB.topicId, title: '规范后的主题 B', brief: '整理后' })
  assert.equal(updated.ok, true, JSON.stringify(updated))
  assert.equal(store.topic(topicB.topicId).title, '规范后的主题 B')
  assert.equal(store.topic(topicB.topicId).brief, '整理后')
  assert.equal(store.ticket(openTicket.ticketId).status, 'open', 'update never touches tickets')

  // 3. merge moves every link and archives the source.
  const merged = await call({ action: 'merge', sourceTopicId: topicA.topicId, targetTopicId: topicB.topicId })
  assert.equal(merged.ok, true, JSON.stringify(merged))
  assert.equal(store.topic(topicA.topicId).mergedInto, topicB.topicId)
  assert.equal(store.links().filter(link => link.topicId === topicA.topicId).length, 0)
  assert.ok(store.links().some(link => link.topicId === topicB.topicId && link.ticketId === openTicket.ticketId && link.role === 'primary'))
  assert.equal(store.ticket(openTicket.ticketId).status, 'open', 'merge never touches tickets')

  // 4. archive refuses while the topic still has unfinished tickets.
  const refused = await call({ action: 'archive', topicId: topicB.topicId })
  assert.equal(refused.ok, false)
  assert.equal(refused.code, 'topic_unfinished')
  assert.equal(store.topic(topicB.topicId).archivedAt, null)
  assert.equal(store.ticket(openTicket.ticketId).status, 'open')

  // 5. archive succeeds once every linked ticket is terminal.
  store.transitionTicket(openTicket.ticketId, 'done', { actor: 'test', executor: 'worker', resolution: { kind: 'done', summary: 'ok' } })
  const archived = await call({ action: 'archive', topicId: topicB.topicId })
  assert.equal(archived.ok, true, JSON.stringify(archived))
  assert.ok(store.topic(topicB.topicId).archivedAt)
  assert.ok((await call({ action: 'list' })).topics.every(item => item.topicId !== topicB.topicId))
  assert.ok((await call({ action: 'list', includeArchived: true })).topics.some(item => item.topicId === topicB.topicId && item.archived))

  // 6. Only Sage holds the tool.
  await assert.rejects(() => fixture.callAs(chatbot, 'sage_topic', { action: 'list' }), /tool not installed|forbidden/)

  // 7. Unknown action and missing topic id are readable errors.
  assert.equal((await call({ action: 'nope' })).code, 'invalid_action')
  assert.equal((await call({ action: 'archive' })).code, 'topic_id_required')
  assert.equal((await call({ action: 'update', topicId: 'topic_missing_x', title: 'x' })).code, 'topic_missing')

  console.log('v2 sage topic ok')
} finally {
  fixture.cleanup()
}
