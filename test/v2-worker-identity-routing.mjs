import assert from 'node:assert/strict'
import { createFixture } from './support/ria-fixture.mjs'

const planReply = routing => () => JSON.stringify({
  action: 'plan',
  workOrder: { summary: 'plan the work', steps: ['do it'], ...(routing ? { routing } : {}) },
})

// 1) chatbot_worker_config carries explicit tags, roleNote and dedicated.
{
  const fixture = await createFixture({ v2Default: true, advisorPlan: 'stateless', llmReply: planReply() })
  try {
    const controller = fixture.service.v2
    const chatbot = controller.v2.chatSessionId
    const worker = await controller.ensureWorker('global')
    const events = []
    fixture.service.routerEvent = event => { events.push(event) }
    const set = await fixture.callAs(chatbot, 'chatbot_worker_config', {
      action: 'set', workerId: worker.sessionId,
      tags: ['SQLite', '前端 UI'], roleNote: '数据库事务专用', dedicated: true,
    })
    assert.equal(set.ok, true, JSON.stringify(set))
    assert.deepEqual(set.worker.tags, ['sqlite', '前端-ui'])
    assert.equal(set.worker.roleNote, '数据库事务专用')
    assert.equal(set.worker.dedicated, true)
    assert.deepEqual(set.worker.autoTags, [])
    assert.deepEqual(set.worker.recentTopics, [])
    const configEvents = events.filter(event => event.event === 'worker.config.changed')
    assert.deepEqual(configEvents.map(event => event.payload.field).sort(), ['dedicated', 'roleNote', 'tags'])

    const get = await fixture.callAs(chatbot, 'chatbot_worker_config', { action: 'get' })
    const row = get.workers.find(item => item.sessionId === worker.sessionId)
    assert.deepEqual(row.tags, ['sqlite', '前端-ui'])
    assert.equal(row.dedicated, true)

    // Clearing explicit tags is explicit: pass [].
    const cleared = await fixture.callAs(chatbot, 'chatbot_worker_config', { action: 'set', workerId: worker.sessionId, tags: [], dedicated: false })
    assert.equal(cleared.ok, true)
    assert.deepEqual(cleared.worker.tags, [])
    assert.equal(cleared.worker.dedicated, false)

    assert.equal((await fixture.callAs(chatbot, 'chatbot_worker_config', { action: 'set', workerId: worker.sessionId, tags: 'docs' })).code, 'invalid_tags')
    assert.equal((await fixture.callAs(chatbot, 'chatbot_worker_config', { action: 'set', workerId: worker.sessionId, roleNote: 'x'.repeat(121) })).code, 'invalid_role_note')
    assert.equal((await fixture.callAs(chatbot, 'chatbot_worker_config', { action: 'set', workerId: worker.sessionId, dedicated: 'yes' })).code, 'invalid_dedicated')
    console.log('worker config identity ok')
  } finally {
    fixture.cleanup()
  }
}

// 2) chatbot_co_manage takes the same identity fields.
{
  const fixture = await createFixture({
    v2Default: true,
    advisorPlan: 'stateless',
    extraSessions: [{ sessionId: 'session-doc', running: false, blank: false, updatedAt: 10, cwd: '/work/docs', projections: { values: { title: 'Docs Session' } } }],
  })
  try {
    const chatbot = fixture.service.v2.v2.chatSessionId
    const added = await fixture.callAs(chatbot, 'chatbot_co_manage', {
      action: 'add', sessionId: 'session-doc', cwd: '/work/docs', tags: ['Docs', '写作'], roleNote: '文档专用', dedicated: true,
    })
    assert.equal(added.ok, true, JSON.stringify(added))
    assert.deepEqual(added.worker.tags, ['docs', '写作'])
    assert.equal(added.worker.roleNote, '文档专用')
    assert.equal(added.worker.dedicated, true)
    const list = await fixture.callAs(chatbot, 'chatbot_co_manage', { action: 'list' })
    const row = list.workers.find(item => item.sessionId === 'session-doc')
    assert.deepEqual(row.tags, ['docs', '写作'])
    assert.equal(row.dedicated, true)
    const updated = await fixture.callAs(chatbot, 'chatbot_co_manage', { action: 'add', sessionId: 'session-doc', tags: [], dedicated: false })
    assert.deepEqual(updated.worker.tags, [])
    assert.equal(updated.worker.dedicated, false)
    assert.equal((await fixture.callAs(chatbot, 'chatbot_co_manage', { action: 'add', sessionId: 'session-doc', tags: {} })).code, 'invalid_tags')
    console.log('co-managed identity ok')
  } finally {
    fixture.cleanup()
  }
}

// 3) preferredTags/topicId feed the deterministic affinity routing.
{
  const fixture = await createFixture({ v2Default: true, advisorPlan: 'stateless', llmReply: planReply() })
  try {
    const controller = fixture.service.v2
    const store = controller.v2
    const chatbot = store.chatSessionId
    const w1 = await controller.ensureWorker('global')
    // Occupy the first Worker so a second, distinct one is created.
    store.addWorker(w1.sessionId, { status: 'working', currentTicketId: 'ticket_hold' })
    const w2 = await controller.ensureWorker('global')
    assert.notEqual(w2.sessionId, w1.sessionId)
    store.addWorker(w1.sessionId, { status: 'idle', currentTicketId: null, tags: ['frontend'], lastUsedAt: Date.now() - 60_000 })
    store.addWorker(w2.sessionId, { status: 'idle', currentTicketId: null, tags: ['sqlite'], lastUsedAt: Date.now() })

    // Affinity beats lastUsedAt: w2 is newer but w1 matches the requested tags.
    const request = await fixture.callAs(chatbot, 'chatbot_request', { goal: 'frontend polish', preferredTags: ['Frontend'] })
    assert.equal(request.ok, true, JSON.stringify(request))
    assert.equal(fixture.service.store.ticket(request.ticketId).executor, w1.sessionId)
    assert.deepEqual(store.ticketMeta(request.ticketId).routingTags, ['frontend'])
    const events = fixture.service.routerEvents.query({ ticketId: request.ticketId }).events
    const attempt = events.find(event => event.event === 'dispatch.attempt')
    assert.ok(attempt)
    assert.deepEqual(attempt.payload.routing.ticketTags, ['frontend'])
    assert.equal(attempt.payload.routing.matchedExplicitTags.includes('frontend'), true)
    assert.ok(attempt.payload.routing.selectedScore >= 100)

    // Dedicated protection: no ticket tags means w1 is never chosen.
    store.addWorker(w1.sessionId, { dedicated: true })
    const generic = await fixture.callAs(chatbot, 'chatbot_request', { goal: 'unrelated chore' })
    assert.equal(generic.ok, true, JSON.stringify(generic))
    assert.notEqual(fixture.service.store.ticket(generic.ticketId).executor, w1.sessionId)

    // An explicit topicId is linked as the primary topic and audited.
    const topic = fixture.service.store.addTopic({ title: '前端主题' })
    const topicRequest = await fixture.callAs(chatbot, 'chatbot_request', { goal: 'topic work', topicId: topic.topicId })
    assert.equal(topicRequest.ok, true, JSON.stringify(topicRequest))
    assert.equal(fixture.service.store.primaryTopicFor(topicRequest.ticketId), topic.topicId)
    const topicEvents = fixture.service.routerEvents.query({ ticketId: topicRequest.ticketId }).events
    assert.ok(topicEvents.some(event => event.event === 'topic.assigned' && event.payload.topicId === topic.topicId))

    // An unknown topic is a request error, not a half-created ticket.
    const missing = await fixture.callAs(chatbot, 'chatbot_request', { goal: 'bad topic', topicId: 'topic_missing_x' })
    assert.equal(missing.ok, false)
    assert.equal(missing.code, 'topic_missing')
    console.log('preferredTags/topicId routing ok')
  } finally {
    fixture.cleanup()
  }
}

// 4) Advisor routing.requireTagMatch forces a fresh Worker when no tags match.
{
  const fixture = await createFixture({ v2Default: true, advisorPlan: 'stateless', llmReply: planReply({ tags: ['rust'], requireTagMatch: true }) })
  try {
    const controller = fixture.service.v2
    const chatbot = controller.v2.chatSessionId
    const tagged = await controller.ensureWorker('global')
    controller.v2.addWorker(tagged.sessionId, { status: 'idle', currentTicketId: null, tags: ['frontend'] })
    const request = await fixture.callAs(chatbot, 'chatbot_request', { goal: 'rust crate' })
    assert.equal(request.ok, true, JSON.stringify(request))
    const meta = controller.v2.ticketMeta(request.ticketId)
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
