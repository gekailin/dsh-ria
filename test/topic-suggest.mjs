import assert from 'node:assert/strict'
import { createFixture } from './support/ria-fixture.mjs'
import { managerPrompt } from '../lib/index.js'
import { TOPIC_SUGGEST_DEFAULT_LIMIT, TOPIC_SUGGEST_MAX_LIMIT, topicMatchScore, topicMatchTerms, topicSuggestions } from '../lib/topics.mjs'

// Text features are deterministic: Han runs contribute overlapping bigrams,
// Latin/digit runs contribute tokens, and case, width and punctuation vanish.
{
  const terms = topicMatchTerms('Fix 登录，接口 Ｖ２!')
  for (const term of ['fix', '登录', '接口', 'v2']) assert.ok(terms.has(term), 'missing term ' + term)
  assert.equal(terms.size, 4)
  assert.equal(topicMatchTerms('').size, 0)
  assert.equal(topicMatchScore('修复登录接口', '修复登录接口'), 1)
  assert.equal(topicMatchScore('登录', '订单导出'), 0)
  assert.equal(topicMatchScore('', '登录'), 0)
  const focused = topicMatchScore('登录接口', '登录接口修复')
  const broad = topicMatchScore('登录接口', '登录接口、注册接口、支付和订单的完整改造')
  assert.ok(focused > broad, 'a focused candidate must outrank a broad one')
  assert.equal(topicMatchScore('LOGIN v2', 'login V2'), 1)
}

// Pure suggestions: archived/merged topics are out, linked hot tickets are not
// suggested again, counts come from the linked views, and ties are stable.
{
  const topics = [
    { topicId: 'topic_b', title: '登录', brief: '', createdAt: 1, updatedAt: 1 },
    { topicId: 'topic_a', title: '登录', brief: '', createdAt: 1, updatedAt: 1 },
    { topicId: 'topic_broad', title: '登录接口、注册、支付和订单的完整改造', brief: '', createdAt: 1, updatedAt: 1 },
    { topicId: 'topic_archived', title: '登录归档', brief: '', archivedAt: 2, createdAt: 1, updatedAt: 2 },
    { topicId: 'topic_merged', title: '登录合并', brief: '', mergedInto: 'topic_b', createdAt: 1, updatedAt: 2 },
  ]
  const links = [
    { topicId: 'topic_a', ticketId: 'ticket_linked', role: 'primary', at: 1 },
    { topicId: 'topic_archived', ticketId: 'ticket_archived', role: 'primary', at: 1 },
  ]
  const tickets = [
    { ticketId: 'ticket_linked', goal: '登录接口超时', status: 'working', updatedAt: 2 },
    { ticketId: 'ticket_loose', goal: '登录接口报错', status: 'open', updatedAt: 3 },
    { ticketId: 'ticket_other', goal: '订单导出', status: 'open', updatedAt: 4 },
  ]
  const result = topicSuggestions({ goal: '登录接口', topics, links, tickets })
  assert.deepEqual(result.topics.map(item => item.topicId), ['topic_a', 'topic_b', 'topic_broad'])
  assert.equal(result.topics[0].counts.total, 1)
  assert.equal(result.topics[0].counts.working, 1)
  assert.ok(result.topics.every(item => item.topicId !== 'topic_archived' && item.topicId !== 'topic_merged'))
  assert.deepEqual(result.tickets.map(item => item.ticketId), ['ticket_loose'])
  assert.ok(result.topics.every((item, index) => index === 0 || result.topics[index - 1].score >= item.score))
  assert.ok(result.tickets.every((item, index) => index === 0 || result.tickets[index - 1].score >= item.score))

  const many = Array.from({ length: 7 }, (_, index) => ({
    topicId: 'topic_' + String(index).padStart(2, '0'),
    title: '登录' + index,
    brief: '',
    createdAt: 1,
    updatedAt: 1,
  }))
  assert.equal(topicSuggestions({ goal: '登录', topics: many }).topics.length, TOPIC_SUGGEST_DEFAULT_LIMIT)
  const limited = topicSuggestions({ goal: '登录', topics: many, limit: 2 }).topics
  assert.deepEqual(limited.map(item => item.topicId), ['topic_00', 'topic_01'])
  assert.equal(topicSuggestions({ goal: '登录', topics: many, limit: 200 }).topics.length, 7)
  assert.deepEqual(topicSuggestions({ goal: '', topics: many }), { topics: [], tickets: [] })
  assert.equal(TOPIC_SUGGEST_MAX_LIMIT, 20)
}

const fixture = await createFixture()

try {
  const auth = await fixture.call('ria_topic', { action: 'create', title: '登录改造', brief: '认证入口' })
  assert.equal(auth.ok, true)
  const archived = await fixture.call('ria_topic', { action: 'create', title: '登录旧主题' })
  const archivedResult = await fixture.call('ria_topic', { action: 'archive', topicId: archived.topic.topicId })
  assert.equal(archivedResult.ok, true)
  const mergeSource = await fixture.call('ria_topic', { action: 'create', title: '登录合并源' })
  const mergeTarget = await fixture.call('ria_topic', { action: 'create', title: '订单汇总' })
  const merged = await fixture.call('ria_topic', {
    action: 'merge',
    sourceTopicId: mergeSource.topic.topicId,
    targetTopicId: mergeTarget.topic.topicId,
  })
  assert.equal(merged.ok, true)

  // Creating with a topic links it in the same write and returns the id.
  const linked = await fixture.call('ria_ticket', {
    goal: '登录接口超时',
    executor: 'session-worker',
    topicId: auth.topic.topicId,
  })
  assert.equal(linked.ticket.primaryTopicId, auth.topic.topicId)
  assert.equal(linked.topicMissingHint, undefined)
  assert.equal(fixture.service.store.primaryTopicFor(linked.ticket.ticketId), auth.topic.topicId)

  // A create without a topic still succeeds, but tells Ria what to do next.
  const loose = await fixture.call('ria_ticket', { goal: '登录接口很慢', executor: 'session-worker' })
  assert.equal(loose.ticket.primaryTopicId, null)
  assert.match(loose.topicMissingHint, /suggest/)
  assert.match(loose.topicMissingHint, /create/)
  assert.match(loose.topicMissingHint, /link/)
  const unrelated = await fixture.call('ria_ticket', { goal: '订单导出', executor: 'session-worker' })

  const status = await fixture.call('ria_status', { ticketId: linked.ticket.ticketId })
  assert.equal(status.scope, 'ticket')
  assert.equal(status.ticket.primaryTopicId, auth.topic.topicId)
  const looseStatus = await fixture.call('ria_status', { ticketId: loose.ticket.ticketId })
  assert.equal(looseStatus.ticket.primaryTopicId, null)

  // suggest is read-only and scoped to active topics plus unlinked hot tickets.
  const linksBefore = fixture.service.store.links().length
  const suggestion = await fixture.call('ria_topic', { action: 'suggest', goal: '修复登录接口超时' })
  assert.equal(suggestion.ok, true)
  assert.ok(suggestion.topics.some(item => item.topicId === auth.topic.topicId))
  assert.ok(suggestion.topics.every(item => item.topicId !== archived.topic.topicId))
  assert.ok(suggestion.topics.every(item => item.topicId !== mergeSource.topic.topicId))
  const authRow = suggestion.topics.find(item => item.topicId === auth.topic.topicId)
  assert.equal(authRow.counts.total, 1)
  assert.equal(authRow.counts.working, 0)
  assert.ok(authRow.score > 0)
  assert.ok(suggestion.tickets.some(item => item.ticketId === loose.ticket.ticketId))
  assert.ok(suggestion.tickets.every(item => item.ticketId !== linked.ticket.ticketId))
  assert.ok(suggestion.tickets.every(item => item.ticketId !== unrelated.ticket.ticketId))
  assert.equal(fixture.service.store.links().length, linksBefore)

  const limited = await fixture.call('ria_topic', { action: 'suggest', goal: '登录接口', limit: 1 })
  assert.equal(limited.ok, true)
  assert.ok(limited.topics.length <= 1)
  assert.ok(limited.tickets.length <= 1)
  assert.equal((await fixture.call('ria_topic', { action: 'suggest', goal: '登录接口', limit: 0 })).code, 'topic_invalid')
  assert.equal((await fixture.call('ria_topic', { action: 'suggest', goal: '' })).code, 'topic_invalid')
  assert.equal((await fixture.call('ria_topic', { action: 'suggest' })).code, 'topic_invalid')

  // Missing, archived and merged topics reject the whole create; no ticket is
  // written and the goal never appears in the store.
  const before = fixture.service.store.tickets().length
  for (const [topicId, code] of [
    ['topic_nope', 'topic_missing'],
    [archived.topic.topicId, 'topic_archived'],
    [mergeSource.topic.topicId, 'topic_archived'],
  ]) {
    const rejected = await fixture.call('ria_ticket', {
      goal: '不应落库的工单 ' + topicId,
      executor: 'session-worker',
      topicId,
    })
    assert.equal(rejected.ok, false)
    assert.equal(rejected.code, code)
    assert.equal(fixture.service.store.tickets().length, before)
    assert.equal(fixture.service.store.tickets().some(ticket => ticket.goal.includes(topicId)), false)
  }
  const emptyTopic = await fixture.call('ria_ticket', { goal: '空主题', executor: 'session-worker', topicId: '' })
  assert.equal(emptyTopic.ok, false)
  assert.equal(emptyTopic.code, 'topic_missing')

  const updateTopic = await fixture.call('ria_ticket', {
    ticketId: loose.ticket.ticketId,
    topicId: auth.topic.topicId,
  })
  assert.equal(updateTopic.ok, false)
  assert.equal(updateTopic.code, 'topic_invalid')
  assert.equal(fixture.service.store.primaryTopicFor(loose.ticket.ticketId), null)

  const promptText = managerPrompt('session-ria', '')
  assert.match(promptText, /Every new work ticket must carry a primary topic before it is dispatched/)
  assert.match(promptText, /resolving an intake to work/)
  assert.match(promptText, /action="suggest"/)
  assert.match(promptText, /one ticket is enough/)
  assert.match(promptText, /Do not backfill old tickets unless the user explicitly asks\./)
  assert.match(promptText, /suggest is advisory/)

  const topicTool = fixture.installed.get('ria_topic')
  assert.ok(topicTool)
  assert.ok(topicTool.parameters.properties.action.enum.includes('suggest'))
  assert.ok(topicTool.parameters.properties.goal)
  assert.deepEqual(topicTool.parameters.properties.limit.minimum, 1)
  assert.deepEqual(topicTool.parameters.properties.limit.maximum, 20)
  const ticketTool = fixture.installed.get('ria_ticket')
  assert.ok(ticketTool.parameters.properties.topicId)
} finally {
  fixture.cleanup()
}

console.log('topic-suggest ok')
