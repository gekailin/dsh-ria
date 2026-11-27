import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const client = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
const start = client.indexOf('    function stableBoardOrder')
const end = client.indexOf('    function boardLayout', start)
assert.ok(start > 0 && end > start, 'stable order helpers are present')
const helpers = new Function(client.slice(start, end) + '\nreturn { stableBoardOrder, compareBoardProject, compareBoardTopic, compareBoardCard }')()
const key = (item, field) => item[field]
const ids = list => list.map(item => item.projectId || item.topicId || item.ticketId)

// Project order: deterministic first pass, existing order retained, new append.
const p2 = { projectId: 'p2' }
const p1 = { projectId: 'p1' }
let projects = helpers.stableBoardOrder(null, [p2, p1], item => item.projectId, helpers.compareBoardProject)
assert.deepEqual(ids(projects), ['p1', 'p2'])
projects = helpers.stableBoardOrder(ids(projects), [p2, { projectId: 'p3' }, p1], item => item.projectId, helpers.compareBoardProject)
assert.deepEqual(ids(projects), ['p1', 'p2', 'p3'], 'new project appends; existing projects keep their order')

// Topic order: status/time changes must not move existing topics.
let topics = helpers.stableBoardOrder(null, [{ topicId: 't2' }, { topicId: 't1' }], item => item.topicId, helpers.compareBoardTopic)
assert.deepEqual(ids(topics), ['t1', 't2'])
topics = helpers.stableBoardOrder(ids(topics), [{ topicId: 't2' }, { topicId: 't3' }, { topicId: 't1' }], item => item.topicId, helpers.compareBoardTopic)
assert.deepEqual(ids(topics), ['t1', 't2', 't3'])

// Cards: initial deterministic createdAt/ticketId order; new card appends.
const card = (ticketId, createdAt) => ({ ticketId, createdAt })
let cards = helpers.stableBoardOrder(null, [card('c2', 20), card('c1', 10)], item => item.ticketId, helpers.compareBoardCard)
assert.deepEqual(ids(cards), ['c1', 'c2'])
cards = helpers.stableBoardOrder(ids(cards), [card('c2', 99), card('c3', 30), card('c1', 10)], item => item.ticketId, helpers.compareBoardCard)
assert.deepEqual(ids(cards), ['c1', 'c2', 'c3'], 'updated card stays in place; new card appends')

// Working -> done migration: source lane drops it, target lane appends it.
let pending = helpers.stableBoardOrder(null, [card('c1', 10), card('c2', 20)], item => item.ticketId, helpers.compareBoardCard)
let working = helpers.stableBoardOrder(null, [card('c3', 30), card('c4', 40)], item => item.ticketId, helpers.compareBoardCard)
pending = helpers.stableBoardOrder(ids(pending), [card('c2', 20)], item => item.ticketId, helpers.compareBoardCard)
working = helpers.stableBoardOrder(ids(working), [card('c3', 30), card('c4', 40), card('c1', 10)], item => item.ticketId, helpers.compareBoardCard)
assert.deepEqual(ids(pending), ['c2'])
assert.deepEqual(ids(working), ['c3', 'c4', 'c1'], 'migrated card lands at target lane end')
assert.deepEqual(ids(working).slice(0, 2), ['c3', 'c4'], 'other cards keep their relative order')

// Determinism: same input set computed twice yields the same result.
const same = [card('b', 2), card('a', 1), card('c', 3)]
assert.deepEqual(ids(helpers.stableBoardOrder(null, same, item => item.ticketId, helpers.compareBoardCard)), ids(helpers.stableBoardOrder(null, same.slice().reverse(), item => item.ticketId, helpers.compareBoardCard)))

// The renderer uses the stable helpers and keeps its existing scroll restore.
assert.match(client, /stableBoardOrder\(stableProjectOrderRef\.current/)
assert.match(client, /stableBoardOrder\(ticketOrderRef\.current\.pending/)
assert.match(client, /pendingScrollRef\.current = node \? \{ top: node\.scrollTop/)
assert.match(client, /node\.scrollTop = pending\.top/)
assert.doesNotMatch(client, /function topicWaterfall[\s\S]{0,500}?\.sort\(/)
console.log('board stable order ok')
