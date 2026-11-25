import assert from 'node:assert/strict'
import { normalizeProjectKey, topicProjectKey, topicSuggestions } from '../lib/topics.mjs'

assert.equal(normalizeProjectKey('  dsh-ria-a1b2c3d4 '), 'dsh-ria-a1b2c3d4')
assert.equal(normalizeProjectKey(''), null)
assert.equal(normalizeProjectKey(null), null)
assert.equal(topicProjectKey({ projectKey: 'p1' }), 'p1')
assert.equal(topicProjectKey({}), null)

const topics = [
  { topicId: 'p1_match', projectKey: 'p1', title: '登录接口', updatedAt: 5, createdAt: 1 },
  { topicId: 'p1_other', projectKey: 'p1', title: '订单导出', updatedAt: 9, createdAt: 1 },
  { topicId: 'p2_match', projectKey: 'p2', title: '登录接口', updatedAt: 10, createdAt: 1 },
  { topicId: 'global_match', projectKey: null, title: '登录接口', updatedAt: 11, createdAt: 1 },
  { topicId: 'p1_archived', projectKey: 'p1', title: '登录归档', archivedAt: 2, updatedAt: 12, createdAt: 1 },
]

// Same-project filtering: p2/global topics must not leak into a p1 request.
{
  const result = topicSuggestions({ goal: '登录接口', projectKey: 'p1', topics, limit: 5 })
  assert.deepEqual(result.topics.map(item => item.topicId), ['p1_match', 'p1_other'])
  assert.equal(result.topics[0].score > 0, true)
  assert.equal(result.topics[1].score, 0, 'low-score same-project topic is the recall fallback')
  assert.equal(result.topics[1].projectKey, 'p1')
}

// Global bucket is selected with an explicit null projectKey.
{
  const result = topicSuggestions({ goal: '登录接口', projectKey: null, topics, limit: 5 })
  assert.deepEqual(result.topics.map(item => item.topicId), ['global_match'])
}

// Omitting projectKey preserves the old cross-project behaviour.
{
  const result = topicSuggestions({ goal: '登录接口', topics, limit: 5 })
  assert.deepEqual(result.topics.map(item => item.topicId).sort(), ['global_match', 'p1_match', 'p2_match'])
}

// Fallback is ordered by updatedAt descending, and archived topics are out.
{
  const extra = [
    { topicId: 'p1_old', projectKey: 'p1', title: '旧主题', updatedAt: 1, createdAt: 1 },
    { topicId: 'p1_new', projectKey: 'p1', title: '新主题', updatedAt: 7, createdAt: 1 },
    ...topics,
  ]
  const result = topicSuggestions({ goal: '登录接口', projectKey: 'p1', topics: extra, limit: 5 })
  assert.deepEqual(result.topics.map(item => item.topicId), ['p1_match', 'p1_other', 'p1_new', 'p1_old'])
  assert.ok(result.topics.every(item => item.topicId !== 'p1_archived'))
}

// Large long-lived topics with dozens of historical tickets must not lose to
// single-ticket topics due to Dice denominator dilution, and tags are returned.
{
  const bigTopics = [
    { topicId: 't_big', projectKey: 'p1', title: '存储与数据', tags: ['sqlite', 'storage'], updatedAt: 1, createdAt: 1 },
    { topicId: 't_small', projectKey: 'p1', title: '无关临时票', tags: [], updatedAt: 100, createdAt: 100 },
  ]
  const bigTickets = Array.from({ length: 40 }, (_, i) => ({
    ticketId: 'tk_' + i,
    goal: '历史存储迁移与清理工单编号 ' + i + ' 包含大量不同词汇 alpha' + i + ' beta' + i,
    status: 'done',
    updatedAt: i + 1,
  }))
  const bigLinks = bigTickets.map(t => ({ topicId: 't_big', ticketId: t.ticketId, role: 'primary' }))
  const result = topicSuggestions({
    goal: '存储与数据 sqlite 迁移',
    projectKey: 'p1',
    topics: bigTopics,
    links: bigLinks,
    tickets: bigTickets,
    limit: 5,
  })
  assert.equal(result.topics[0].topicId, 't_big')
  assert.ok(result.topics[0].score >= 0.4, 'big topic identity score must stay high, got ' + result.topics[0].score)
  assert.deepEqual(result.topics[0].tags, ['sqlite', 'storage'])
}

console.log('topic-project-key: ok')
