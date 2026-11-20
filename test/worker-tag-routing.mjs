import assert from 'node:assert/strict'
import { AUTO_TAG_LIMIT, TAG_LIMIT, normalizeTags, mergeTags } from '../lib/store/tags.mjs'
import { rankCandidateWorkers, isWorkerEligible } from '../lib/core/worker-pool.mjs'

// normalizeTags: lowercase, whitespace/underscore to hyphen, filter, dedupe.
assert.deepEqual(normalizeTags([' Frontend ', 'SQLite', 'frontend', 'a  b', 'a_b', 'x/y']),
  ['frontend', 'sqlite', 'a-b', 'xy'])
assert.equal(normalizeTags(Array.from({ length: 20 }, (_, i) => 't' + i)).length, TAG_LIMIT)
assert.equal(normalizeTags(Array.from({ length: 20 }, (_, i) => 't' + i), AUTO_TAG_LIMIT).length, AUTO_TAG_LIMIT)
assert.deepEqual(normalizeTags('frontend'), [])
assert.deepEqual(normalizeTags(['!!!', '-----', '']), [])
assert.ok(normalizeTags(['前端', '数据-库', 'state.1']).includes('前端'))
assert.deepEqual(mergeTags(['A'], ['b', 'a']), ['a', 'b'])

const now = 1_000_000_000_000
const base = { status: 'idle', currentTicketId: null, workerType: 'work', allowAutoDispatch: true, seq: 10 }

// Dedicated security: a dedicated sqlite worker must never take a generic or
// frontend ticket, even if it is the newest idle worker.
{
  const workers = [
    { ...base, sessionId: 'w1', seq: 1, tags: ['sqlite'], dedicated: true, lastUsedAt: now },
    { ...base, sessionId: 'w2', seq: 2, tags: [], lastUsedAt: now - 1000 },
  ]
  const generic = rankCandidateWorkers(workers, { now })
  assert.deepEqual(generic.map(item => item.worker.sessionId), ['w2'])
  const frontend = rankCandidateWorkers(workers, { now, ticketTags: ['frontend'] })
  assert.deepEqual(frontend.map(item => item.worker.sessionId), ['w2'])
  const sqlite = rankCandidateWorkers(workers, { now, ticketTags: ['sqlite'] })
  assert.equal(sqlite[0].worker.sessionId, 'w1')
}

// Affinity beats blind lastUsedAt: an explicit frontend worker older than a
// generic worker still wins a frontend ticket.
{
  const workers = [
    { ...base, sessionId: 'frontend', seq: 1, tags: ['frontend'], lastUsedAt: now - 5 * 86400000 },
    { ...base, sessionId: 'generic', seq: 2, tags: [], lastUsedAt: now },
  ]
  const ranked = rankCandidateWorkers(workers, { now, ticketTags: ['frontend'] })
  assert.deepEqual(ranked.map(item => item.worker.sessionId), ['frontend', 'generic'])
  assert.equal(ranked[0].matchedExplicitTags[0], 'frontend')
}

// recentTopics: previous topic is the strongest context signal.
{
  const workers = [
    { ...base, sessionId: 'topic', seq: 1, tags: [], recentTopics: ['t1'], lastUsedAt: now - 86400000 },
    { ...base, sessionId: 'other', seq: 2, tags: [], recentTopics: ['t2'], lastUsedAt: now },
  ]
  const ranked = rankCandidateWorkers(workers, { now, primaryTopicId: 't1' })
  assert.equal(ranked[0].worker.sessionId, 'topic')
  assert.equal(ranked[0].matchedTopic, 0)
}

// Generic ticket: a tagged worker gets the default -10 penalty, so an
// untagged generic worker wins even if the tagged one was used more recently.
{
  const workers = [
    { ...base, sessionId: 'tagged', seq: 1, tags: ['sqlite'], lastUsedAt: now },
    { ...base, sessionId: 'plain', seq: 2, tags: [], lastUsedAt: now - 1000 },
  ]
  const ranked = rankCandidateWorkers(workers, { now })
  assert.equal(ranked[0].worker.sessionId, 'plain')
  assert.equal(ranked[0].genericPenalty, 0)
  assert.equal(ranked[1].worker.sessionId, 'tagged')
  assert.equal(ranked[1].genericPenalty, 10)
}

// requireTagMatch + hard safety filters.
{
  const workers = [
    { ...base, sessionId: 'busy', tags: ['frontend'], currentTicketId: 'ticket_x' },
    { ...base, sessionId: 'archived', tags: ['frontend'], archivedAt: 1 },
    { ...base, sessionId: 'optout', tags: ['frontend'], allowAutoDispatch: false },
    { ...base, sessionId: 'match', tags: ['frontend'] },
  ]
  assert.equal(isWorkerEligible(workers[0], {}), false)
  assert.equal(isWorkerEligible(workers[1], {}), false)
  assert.equal(isWorkerEligible(workers[2], {}), false)
  const ranked = rankCandidateWorkers(workers, { ticketTags: ['frontend'], requireTagMatch: true })
  assert.deepEqual(ranked.map(item => item.worker.sessionId), ['match'])
  assert.deepEqual(rankCandidateWorkers(workers, { ticketTags: ['docs'], requireTagMatch: true }), [])
}

// Deterministic tie-break: same score => seq ascending.
{
  const workers = [
    { ...base, sessionId: 'b', seq: 2, tags: [] },
    { ...base, sessionId: 'a', seq: 1, tags: [] },
  ]
  const ranked = rankCandidateWorkers(workers, { now, ticketTags: [] , })
  assert.deepEqual(ranked.map(item => item.worker.sessionId), ['a', 'b'])
}

console.log('state-worker-tag-routing: ok')
