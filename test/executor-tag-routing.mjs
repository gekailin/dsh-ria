import assert from 'node:assert/strict'
import { AUTO_TAG_LIMIT, TAG_LIMIT, normalizeTags, mergeTags } from '../lib/store/tags.mjs'
import { rankCandidateExecutors, isExecutorEligible } from '../lib/core/executor-pool.mjs'

// normalizeTags: lowercase, whitespace/underscore to hyphen, filter, dedupe.
assert.deepEqual(normalizeTags([' Frontend ', 'SQLite', 'frontend', 'a  b', 'a_b', 'x/y']),
  ['frontend', 'sqlite', 'a-b', 'xy'])
assert.equal(normalizeTags(Array.from({ length: 20 }, (_, i) => 't' + i)).length, TAG_LIMIT)
assert.equal(normalizeTags(Array.from({ length: 120 }, (_, i) => 't' + i), AUTO_TAG_LIMIT).length, AUTO_TAG_LIMIT)
assert.deepEqual(normalizeTags('frontend'), [])
assert.deepEqual(normalizeTags(['!!!', '-----', '']), [])
assert.ok(normalizeTags(['前端', '数据-库', 'state.1']).includes('前端'))
assert.deepEqual(mergeTags(['A'], ['b', 'a']), ['a', 'b'])

const now = 1_000_000_000_000
const base = { status: 'idle', currentTicketId: null, executorType: 'work', allowAutoDispatch: true, seq: 10 }

// The retired dedicated switch no longer hard-filters generic tickets: explicit
// tags only affect affinity scoring, and a matching ticket still prefers w1.
{
  const executors = [
    { ...base, sessionId: 'w1', seq: 1, tags: ['sqlite'], lastUsedAt: now },
    { ...base, sessionId: 'w2', seq: 2, tags: [], lastUsedAt: now - 1000 },
  ]
  const generic = rankCandidateExecutors(executors, { now })
  assert.deepEqual(generic.map(item => item.executor.sessionId), ['w2', 'w1'])
  const frontend = rankCandidateExecutors(executors, { now, ticketTags: ['frontend'] })
  assert.deepEqual(frontend.map(item => item.executor.sessionId), ['w1', 'w2'])
  const sqlite = rankCandidateExecutors(executors, { now, ticketTags: ['sqlite'] })
  assert.equal(sqlite[0].executor.sessionId, 'w1')
}

// Affinity beats blind lastUsedAt: an explicit frontend executor older than a
// generic executor still wins a frontend ticket.
{
  const executors = [
    { ...base, sessionId: 'frontend', seq: 1, tags: ['frontend'], lastUsedAt: now - 5 * 86400000 },
    { ...base, sessionId: 'generic', seq: 2, tags: [], lastUsedAt: now },
  ]
  const ranked = rankCandidateExecutors(executors, { now, ticketTags: ['frontend'] })
  assert.deepEqual(ranked.map(item => item.executor.sessionId), ['frontend', 'generic'])
  assert.equal(ranked[0].matchedExplicitTags[0], 'frontend')
}

// recentTopics: previous topic is the strongest context signal.
{
  const executors = [
    { ...base, sessionId: 'topic', seq: 1, tags: [], recentTopics: ['t1'], lastUsedAt: now - 86400000 },
    { ...base, sessionId: 'other', seq: 2, tags: [], recentTopics: ['t2'], lastUsedAt: now },
  ]
  const ranked = rankCandidateExecutors(executors, { now, primaryTopicId: 't1' })
  assert.equal(ranked[0].executor.sessionId, 'topic')
  assert.equal(ranked[0].matchedTopic, 0)
}

// Generic ticket: a tagged executor gets the default -10 penalty, so an
// untagged generic executor wins even if the tagged one was used more recently.
{
  const executors = [
    { ...base, sessionId: 'tagged', seq: 1, tags: ['sqlite'], lastUsedAt: now },
    { ...base, sessionId: 'plain', seq: 2, tags: [], lastUsedAt: now - 1000 },
  ]
  const ranked = rankCandidateExecutors(executors, { now })
  assert.equal(ranked[0].executor.sessionId, 'plain')
  assert.equal(ranked[0].genericPenalty, 0)
  assert.equal(ranked[1].executor.sessionId, 'tagged')
  assert.equal(ranked[1].genericPenalty, 10)
}

// requireTagMatch + hard safety filters.
{
  const executors = [
    { ...base, sessionId: 'busy', tags: ['frontend'], currentTicketId: 'ticket_x' },
    { ...base, sessionId: 'archived', tags: ['frontend'], archivedAt: 1 },
    { ...base, sessionId: 'optout', tags: ['frontend'], allowAutoDispatch: false },
    { ...base, sessionId: 'match', tags: ['frontend'] },
  ]
  assert.equal(isExecutorEligible(executors[0], {}), false)
  assert.equal(isExecutorEligible(executors[1], {}), false)
  assert.equal(isExecutorEligible(executors[2], {}), false)
  const ranked = rankCandidateExecutors(executors, { ticketTags: ['frontend'], requireTagMatch: true })
  assert.deepEqual(ranked.map(item => item.executor.sessionId), ['match'])
  assert.deepEqual(rankCandidateExecutors(executors, { ticketTags: ['docs'], requireTagMatch: true }), [])
}

// Deterministic tie-break: same score => seq ascending.
{
  const executors = [
    { ...base, sessionId: 'b', seq: 2, tags: [] },
    { ...base, sessionId: 'a', seq: 1, tags: [] },
  ]
  const ranked = rankCandidateExecutors(executors, { now, ticketTags: [] , })
  assert.deepEqual(ranked.map(item => item.executor.sessionId), ['a', 'b'])
}

console.log('state-executor-tag-routing: ok')
