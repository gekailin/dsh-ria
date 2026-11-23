import assert from 'node:assert/strict'
import { createFixture } from './support/ria-fixture.mjs'

const planReply = routing => () => JSON.stringify({
  action: 'plan',
  workOrder: { summary: 'plan the work', steps: ['do it'], ...(routing ? { routing } : {}) },
})

// 1) ria_chat_executor_config carries explicit tags, roleNote and dedicated.
{
  const fixture = await createFixture({ stateDefault: true, advisorPlan: 'stateless', llmReply: planReply() })
  try {
    const controller = fixture.service.controller
    const chat = controller.state.chatSessionId
    const executor = await controller.ensureExecutor('global')
    const events = []
    fixture.service.routerEvent = event => { events.push(event) }
    const set = await fixture.callAs(chat, 'ria_chat_executor_config', {
      action: 'set', executorId: executor.sessionId,
      tags: ['SQLite', '前端 UI'], roleNote: '数据库事务专用', dedicated: true,
    })
    assert.equal(set.ok, true, JSON.stringify(set))
    assert.deepEqual(set.executor.tags, ['sqlite', '前端-ui'])
    assert.equal(set.executor.roleNote, '数据库事务专用')
    assert.equal(set.executor.dedicated, true)
    assert.deepEqual(set.executor.autoTags, [])
    assert.deepEqual(set.executor.recentTopics, [])
    const configEvents = events.filter(event => event.event === 'executor.config.changed')
    assert.deepEqual(configEvents.map(event => event.payload.field).sort(), ['dedicated', 'roleNote', 'tags'])

    const get = await fixture.callAs(chat, 'ria_chat_executor_config', { action: 'get' })
    const row = get.executors.find(item => item.sessionId === executor.sessionId)
    assert.deepEqual(row.tags, ['sqlite', '前端-ui'])
    assert.equal(row.dedicated, true)

    // Clearing explicit tags is explicit: pass [].
    const cleared = await fixture.callAs(chat, 'ria_chat_executor_config', { action: 'set', executorId: executor.sessionId, tags: [], dedicated: false })
    assert.equal(cleared.ok, true)
    assert.deepEqual(cleared.executor.tags, [])
    assert.equal(cleared.executor.dedicated, false)

    assert.equal((await fixture.callAs(chat, 'ria_chat_executor_config', { action: 'set', executorId: executor.sessionId, tags: 'docs' })).code, 'invalid_tags')
    assert.equal((await fixture.callAs(chat, 'ria_chat_executor_config', { action: 'set', executorId: executor.sessionId, roleNote: 'x'.repeat(121) })).code, 'invalid_role_note')
    assert.equal((await fixture.callAs(chat, 'ria_chat_executor_config', { action: 'set', executorId: executor.sessionId, dedicated: 'yes' })).code, 'invalid_dedicated')
    console.log('executor config identity ok')
  } finally {
    fixture.cleanup()
  }
}

// 2) ria_chat_co_manage takes the same identity fields.
{
  const fixture = await createFixture({
    stateDefault: true,
    advisorPlan: 'stateless',
    extraSessions: [{ sessionId: 'session-doc', running: false, blank: false, updatedAt: 10, cwd: '/work/docs', projections: { values: { title: 'Docs Session' } } }],
  })
  try {
    const chat = fixture.service.controller.state.chatSessionId
    const added = await fixture.callAs(chat, 'ria_chat_co_manage', {
      action: 'add', sessionId: 'session-doc', cwd: '/work/docs', tags: ['Docs', '写作'], roleNote: '文档专用', dedicated: true,
    })
    assert.equal(added.ok, true, JSON.stringify(added))
    assert.deepEqual(added.executor.tags, ['docs', '写作'])
    assert.equal(added.executor.roleNote, '文档专用')
    assert.equal(added.executor.dedicated, true)
    const list = await fixture.callAs(chat, 'ria_chat_co_manage', { action: 'list' })
    const row = list.executors.find(item => item.sessionId === 'session-doc')
    assert.deepEqual(row.tags, ['docs', '写作'])
    assert.equal(row.dedicated, true)
    const updated = await fixture.callAs(chat, 'ria_chat_co_manage', { action: 'add', sessionId: 'session-doc', tags: [], dedicated: false })
    assert.deepEqual(updated.executor.tags, [])
    assert.equal(updated.executor.dedicated, false)

    // set only updates an existing co-managed session.
    const set = await fixture.callAs(chat, 'ria_chat_co_manage', {
      action: 'set', sessionId: 'session-doc', tags: ['API'], roleNote: '接口联调', dedicated: true,
    })
    assert.equal(set.ok, true, JSON.stringify(set))
    assert.deepEqual(set.executor.tags, ['api'])
    assert.equal(set.executor.roleNote, '接口联调')
    assert.equal(set.executor.dedicated, true)
    const missingSet = await fixture.callAs(chat, 'ria_chat_co_manage', { action: 'set', sessionId: 'session-missing', tags: ['x'] })
    assert.equal(missingSet.ok, false)
    assert.equal(missingSet.code, 'not_co_managed')
    assert.equal(fixture.service.controller.state.executor('session-missing'), null, 'set never creates a executor')
    const emptySet = await fixture.callAs(chat, 'ria_chat_co_manage', { action: 'set', sessionId: 'session-doc' })
    assert.equal(emptySet.code, 'config_required')
    const managed = await fixture.service.controller.ensureExecutor('global')
    assert.equal((await fixture.callAs(chat, 'ria_chat_co_manage', { action: 'set', sessionId: managed.sessionId, tags: ['x'] })).code, 'not_co_managed')

    assert.equal((await fixture.callAs(chat, 'ria_chat_co_manage', { action: 'add', sessionId: 'session-doc', tags: {} })).code, 'invalid_tags')
    const removed = await fixture.callAs(chat, 'ria_chat_co_manage', { action: 'remove', sessionId: 'session-doc' })
    assert.equal(removed.removed, true)
    const afterRemove = await fixture.callAs(chat, 'ria_chat_co_manage', { action: 'list' })
    assert.equal(afterRemove.executors.some(item => item.sessionId === 'session-doc'), false)
    console.log('co-managed identity ok')
  } finally {
    fixture.cleanup()
  }
}

// 3) preferredTags/topicId feed the deterministic affinity routing.
{
  const fixture = await createFixture({ stateDefault: true, advisorPlan: 'stateless', llmReply: planReply() })
  try {
    const controller = fixture.service.controller
    const store = controller.state
    const chat = store.chatSessionId
    const w1 = await controller.ensureExecutor('global')
    // Occupy the first Executor so a second, distinct one is created.
    store.addExecutor(w1.sessionId, { status: 'working', currentTicketId: 'ticket_hold' })
    const w2 = await controller.ensureExecutor('global')
    assert.notEqual(w2.sessionId, w1.sessionId)
    store.addExecutor(w1.sessionId, { status: 'idle', currentTicketId: null, tags: ['frontend'], lastUsedAt: Date.now() - 60_000 })
    store.addExecutor(w2.sessionId, { status: 'idle', currentTicketId: null, tags: ['sqlite'], lastUsedAt: Date.now() })

    // Affinity beats lastUsedAt: w2 is newer but w1 matches the requested tags.
    const request = await fixture.callAs(chat, 'ria_chat_request', { goal: 'frontend polish', preferredTags: ['Frontend', 'docs'] })
    assert.equal(request.ok, true, JSON.stringify(request))
    assert.equal(fixture.service.store.ticket(request.ticketId).executor, w1.sessionId)
    assert.deepEqual(store.ticketMeta(request.ticketId).routingTags, ['frontend', 'docs'])
    // Explicit tags never leak into the learned autoTags.
    const learned = store.executor(w1.sessionId)
    assert.deepEqual(learned.tags, ['frontend'])
    assert.deepEqual(learned.autoTags, ['docs'])
    const events = fixture.service.routerEvents.query({ ticketId: request.ticketId }).events
    const attempt = events.find(event => event.event === 'dispatch.attempt')
    assert.ok(attempt)
    assert.deepEqual(attempt.payload.routing.ticketTags, ['frontend', 'docs'])
    assert.equal(attempt.payload.routing.matchedExplicitTags.includes('frontend'), true)
    assert.ok(attempt.payload.routing.selectedScore >= 100)

    // Dedicated protection: no ticket tags means w1 is never chosen.
    store.addExecutor(w1.sessionId, { dedicated: true })
    const generic = await fixture.callAs(chat, 'ria_chat_request', { goal: 'unrelated chore' })
    assert.equal(generic.ok, true, JSON.stringify(generic))
    assert.notEqual(fixture.service.store.ticket(generic.ticketId).executor, w1.sessionId)

    // An explicit topicId is linked as the primary topic and audited.
    const topic = fixture.service.store.addTopic({ title: '前端主题' })
    const topicRequest = await fixture.callAs(chat, 'ria_chat_request', { goal: 'topic work', topicId: topic.topicId })
    assert.equal(topicRequest.ok, true, JSON.stringify(topicRequest))
    assert.equal(fixture.service.store.primaryTopicFor(topicRequest.ticketId), topic.topicId)
    const topicEvents = fixture.service.routerEvents.query({ ticketId: topicRequest.ticketId }).events
    assert.ok(topicEvents.some(event => event.event === 'topic.assigned' && event.payload.topicId === topic.topicId))

    // An unknown topic is a request error, not a half-created ticket.
    const missing = await fixture.callAs(chat, 'ria_chat_request', { goal: 'bad topic', topicId: 'topic_missing_x' })
    assert.equal(missing.ok, false)
    assert.equal(missing.code, 'topic_missing')
    console.log('preferredTags/topicId routing ok')
  } finally {
    fixture.cleanup()
  }
}

// 4) Advisor routing.requireTagMatch forces a fresh Executor when no tags match.
{
  const fixture = await createFixture({ stateDefault: true, advisorPlan: 'stateless', llmReply: planReply({ tags: ['rust'], requireTagMatch: true }) })
  try {
    const controller = fixture.service.controller
    const chat = controller.state.chatSessionId
    const tagged = await controller.ensureExecutor('global')
    controller.state.addExecutor(tagged.sessionId, { status: 'idle', currentTicketId: null, tags: ['frontend'] })
    const request = await fixture.callAs(chat, 'ria_chat_request', { goal: 'rust crate' })
    assert.equal(request.ok, true, JSON.stringify(request))
    const meta = controller.state.ticketMeta(request.ticketId)
    assert.equal(meta.requireTagMatch, true)
    assert.deepEqual(meta.routingTags, ['rust'])
    assert.notEqual(fixture.service.store.ticket(request.ticketId).executor, tagged.sessionId)
    const events = fixture.service.routerEvents.query({ ticketId: request.ticketId }).events
    const attempt = events.find(event => event.event === 'dispatch.attempt')
    assert.equal(attempt.payload.routing.createdNew, true)
    console.log('requireTagMatch routing ok')
  } finally {
    fixture.cleanup()
  }
}
