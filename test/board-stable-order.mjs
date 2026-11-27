import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const client = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
const start = client.indexOf('    function stableBoardOrder')
const end = client.indexOf('    function boardLayout', start)
assert.ok(start > 0 && end > start, 'stable order helpers are present')
const helpers = new Function(client.slice(start, end) + '\nreturn { stableBoardOrder, compareBoardProject, compareBoardTopic, compareBoardCard }')()
const key = (item, field) => item[field]
const ids = list => list.map(item => item.projectId || item.topicId || item.ticketId)

// Opening the board preserves the server's initial order (e.g. active / recent
// first) without re-sorting by id; later refreshes keep existing ids in place
// and append brand-new ids. Reopening passes previous=null and accepts the new
// server sort.
const p2 = { projectId: 'p2', counts: { active: 2 }, lastUpdatedAt: 200 }
const p1 = { projectId: 'p1', counts: { active: 0 }, lastUpdatedAt: 100 }
let projects = helpers.stableBoardOrder(null, [p2, p1], item => item.projectId)
assert.deepEqual(ids(projects), ['p2', 'p1'], 'initial open keeps server order')
projects = helpers.stableBoardOrder(ids(projects), [p1, { projectId: 'p3' }, p2], item => item.projectId)
assert.deepEqual(ids(projects), ['p2', 'p1', 'p3'], 'refresh keeps existing order and appends new project')
let reopenedProjects = helpers.stableBoardOrder(null, [p1, { projectId: 'p3' }, p2], item => item.projectId)
assert.deepEqual(ids(reopenedProjects), ['p1', 'p3', 'p2'], 'reopening picks up fresh server order')

// Topic order: initial server order (newest first) is preserved on open, and
// subsequent status/time updates do not jump existing topics.
let topics = helpers.stableBoardOrder(null, [{ topicId: 't2', lastUpdatedAt: 200 }, { topicId: 't1', lastUpdatedAt: 100 }], item => item.topicId)
assert.deepEqual(ids(topics), ['t2', 't1'])
topics = helpers.stableBoardOrder(ids(topics), [{ topicId: 't1', lastUpdatedAt: 300 }, { topicId: 't3', lastUpdatedAt: 250 }, { topicId: 't2', lastUpdatedAt: 200 }], item => item.topicId)
assert.deepEqual(ids(topics), ['t2', 't1', 't3'], 'existing topics stay frozen until board closes')

// Cards: initial server order (most recently updated first) is preserved on
// open; updated cards stay in place while new cards append.
const card = (ticketId, updatedAt) => ({ ticketId, updatedAt })
let cards = helpers.stableBoardOrder(null, [card('c2', 20), card('c1', 10)], item => item.ticketId)
assert.deepEqual(ids(cards), ['c2', 'c1'])
cards = helpers.stableBoardOrder(ids(cards), [card('c1', 99), card('c3', 30), card('c2', 20)], item => item.ticketId)
assert.deepEqual(ids(cards), ['c2', 'c1', 'c3'], 'updated card stays in place; new card appends')

// Working -> done migration: source lane drops it, target lane appends it.
let pending = helpers.stableBoardOrder(null, [card('c2', 20), card('c1', 10)], item => item.ticketId)
let working = helpers.stableBoardOrder(null, [card('c4', 40), card('c3', 30)], item => item.ticketId)
pending = helpers.stableBoardOrder(ids(pending), [card('c2', 20)], item => item.ticketId)
working = helpers.stableBoardOrder(ids(working), [card('c1', 50), card('c4', 40), card('c3', 30)], item => item.ticketId)
assert.deepEqual(ids(pending), ['c2'])
assert.deepEqual(ids(working), ['c4', 'c3', 'c1'], 'migrated card lands at target lane end')
assert.deepEqual(ids(working).slice(0, 2), ['c4', 'c3'], 'other cards keep their relative order')

// Explicit comparator helpers still sort by activity/recency when requested.
const same = [card('b', 2), card('a', 1), card('c', 3)]
assert.deepEqual(ids(helpers.stableBoardOrder(null, same, item => item.ticketId, helpers.compareBoardCard)), ['c', 'b', 'a'])

// The renderer freezes server order on open and does not overwrite it with id sort.
assert.match(client, /stableBoardOrder\(stableProjectOrderRef\.current, filtered, function \(project\) \{ return project\.projectId \|\| project\.id; \}\)/)
assert.match(client, /stableBoardOrder\(stableTopicOrderRef\.current\[projectKey\], project\.topics, function \(topic\) \{ return topic\.topicId; \}\)/)
assert.match(client, /stableBoardOrder\(ticketOrderRef\.current\.pending, topic\.tickets, function \(ticket\) \{ return ticket\.ticketId; \}\)/)
assert.match(client, /if \(!searchingNow && all\.length\)/)
assert.match(client, /pendingScrollRef\.current = node \? \{ top: node\.scrollTop/)
assert.match(client, /node\.scrollTop = pending\.top/)
assert.doesNotMatch(client, /function topicWaterfall[\s\S]{0,500}?\.sort\(/)
console.log('board stable order ok')
