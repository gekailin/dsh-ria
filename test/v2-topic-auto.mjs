import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { advisorPlanSystemPrompt, parseAdvisorOutput } from '../lib/core/advisor.mjs'
import { projectKey } from '../lib/roles/cognition.mjs'
import { createFixture } from './support/ria-fixture.mjs'

const textOf = request => String(((request.messages && request.messages[0] && request.messages[0].content || [])[0] || {}).text || '')

// 1) Contract + tolerant parsing: topic/routing are optional and malformed
//    values never block the plan.
{
  const contract = advisorPlanSystemPrompt()
  assert.ok(contract.includes('"topic"?:{"action":"reuse"|"create"'))
  assert.ok(contract.includes('"routing"?:{"tags"?:string[],"requireTagMatch"?:boolean}'))
  const basePlan = { action: 'plan', workOrder: { summary: 'do it', steps: ['step'] } }
  const malformed = parseAdvisorOutput(JSON.stringify({
    ...basePlan,
    workOrder: { ...basePlan.workOrder, topic: { action: 'nonsense', title: 42 }, routing: { tags: 'bad', requireTagMatch: 'yes' } },
  }))
  assert.equal(malformed.ok, true)
  assert.equal(malformed.workOrder.topic, undefined)
  assert.equal(malformed.workOrder.routing, undefined)
  const good = parseAdvisorOutput(JSON.stringify({
    ...basePlan,
    workOrder: { ...basePlan.workOrder, topic: { action: 'create', title: ' 标题 ', brief: '说明' }, routing: { tags: ['Frontend', '', 'board'], requireTagMatch: true } },
  }))
  assert.equal(good.ok, true)
  assert.deepEqual(good.workOrder.topic, { action: 'create', title: '标题', brief: '说明' })
  assert.deepEqual(good.workOrder.routing, { tags: ['Frontend', 'board'], requireTagMatch: true })
  console.log('advisor topic/routing contract ok')
}

const workspace = mkdtempSync(join(tmpdir(), 'ria-topic-auto-'))
const expectedProjectKey = projectKey(workspace)
let reuseTopic
let dedupeTopic
let explicitTopic
let downgrade = false

const fixture = await createFixture({
  v2Default: true,
  advisorPlan: 'stateless',
  llmReply: request => {
    const prompt = textOf(request)
    let topic = null
    if (prompt.includes('REUSE-ME')) topic = { action: 'reuse', topicId: reuseTopic.topicId }
    else if (prompt.includes('DEGRADE-ME')) topic = { action: 'reuse', topicId: reuseTopic.topicId }
    else if (prompt.includes('CREATE-ME')) topic = { action: 'create', title: '自动创建的独特主题', brief: '一句话方向' }
    else if (prompt.includes('DEDUPE-ME')) topic = { action: 'create', title: '已有主题标题' }
    else if (prompt.includes('EXPLICIT-ME')) topic = { action: 'create', title: '不应创建的主题' }
    if (downgrade) topic = { action: 'reuse', topicId: reuseTopic.topicId }
    return JSON.stringify({
      action: 'plan',
      workOrder: {
        summary: 'plan the work',
        steps: ['do it'],
        ...(topic ? { topic } : {}),
        routing: { tags: ['frontend'], requireTagMatch: false },
      },
    })
  },
})

try {
  const controller = fixture.service.v2
  const store = controller.v2
  const chatbot = store.chatSessionId

  // Same-project candidate + Worker vocabulary/dedicated note must reach the LLM.
  const worker = await controller.ensureWorker('global', null, workspace)
  store.addWorker(worker.sessionId, { status: 'idle', currentTicketId: null, tags: ['frontend'], roleNote: '数据库事务专用', dedicated: true })
  reuseTopic = fixture.service.store.addTopic({ title: '前端候选主题', projectKey: expectedProjectKey })
  const probes = fixture.llmCalls.length

  const reused = await fixture.callAs(chatbot, 'chatbot_request', { goal: 'REUSE-ME', workspace })
  assert.equal(reused.ok, true, JSON.stringify(reused))
  assert.equal(fixture.service.store.primaryTopicFor(reused.ticketId), reuseTopic.topicId)
  const prompt = textOf(fixture.llmCalls[probes])
  assert.ok(prompt.includes('前端候选主题'), 'candidate topic title must be injected')
  assert.ok(prompt.includes('frontend'), 'worker tag vocabulary must be injected')
  assert.ok(prompt.includes('数据库事务专用'), 'dedicated worker role note must be injected')

  // create: new Topic with the ticket projectKey and a primary link.
  const created = await fixture.callAs(chatbot, 'chatbot_request', { goal: 'CREATE-ME', workspace })
  assert.equal(created.ok, true, JSON.stringify(created))
  const createdTopicId = fixture.service.store.primaryTopicFor(created.ticketId)
  assert.ok(createdTopicId)
  const createdTopic = fixture.service.store.topic(createdTopicId)
  assert.equal(createdTopic.title, '自动创建的独特主题')
  assert.equal(createdTopic.projectKey, expectedProjectKey)

  // dedupe: a create whose title already exists is converted to reuse.
  dedupeTopic = fixture.service.store.addTopic({ title: '已有主题标题', projectKey: expectedProjectKey })
  const beforeDedupe = fixture.service.store.topics().length
  const deduped = await fixture.callAs(chatbot, 'chatbot_request', { goal: 'DEDUPE-ME', workspace })
  assert.equal(deduped.ok, true, JSON.stringify(deduped))
  assert.equal(fixture.service.store.primaryTopicFor(deduped.ticketId), dedupeTopic.topicId)
  assert.equal(fixture.service.store.topics().length, beforeDedupe, 'dedupe must not create a duplicate topic')
  const dedupeEvents = fixture.service.routerEvents.query({ ticketId: deduped.ticketId }).events
  assert.ok(dedupeEvents.some(event => event.event === 'topic.auto_assigned' && event.payload.mode === 'reused'))

  // explicit topicId always wins over the Advisor's topic suggestion.
  explicitTopic = fixture.service.store.addTopic({ title: '用户显式主题', projectKey: expectedProjectKey })
  const explicit = await fixture.callAs(chatbot, 'chatbot_request', { goal: 'EXPLICIT-ME', workspace, topicId: explicitTopic.topicId })
  assert.equal(explicit.ok, true, JSON.stringify(explicit))
  assert.equal(fixture.service.store.primaryTopicFor(explicit.ticketId), explicitTopic.topicId)
  assert.equal(fixture.service.store.topics().some(topic => topic.title === '不应创建的主题'), false)

  // A link failure only degrades: the ticket is still dispatched.
  downgrade = true
  const originalLink = fixture.service.store.linkTicket
  fixture.service.store.linkTicket = () => { throw new Error('link store unavailable') }
  try {
    const degraded = await fixture.callAs(chatbot, 'chatbot_request', { goal: 'DEGRADE-ME', workspace })
    assert.equal(degraded.ok, true, JSON.stringify(degraded))
    const ticket = fixture.service.store.ticket(degraded.ticketId)
    assert.equal(ticket.status, 'working', 'topic failure must not block dispatch')
    assert.ok(ticket.executor)
    const events = fixture.service.routerEvents.query({ ticketId: degraded.ticketId }).events
    const degradedEvents = events.filter(event => event.event === 'topic.auto_assign.degraded')
    assert.equal(degradedEvents.length, 1)
    assert.match(degradedEvents[0].payload.message, /link store unavailable/)
  } finally {
    fixture.service.store.linkTicket = originalLink
    downgrade = false
  }

  console.log('v2 topic auto ok')
} finally {
  fixture.cleanup()
  rmSync(workspace, { recursive: true, force: true })
}
