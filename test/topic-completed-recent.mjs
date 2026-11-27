import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createFixture } from './support/ria-fixture.mjs'
import {
  COMPLETED_RECENT_EMPTY_TEXT,
  BOARD_TOPIC_GROUP_LIMIT,
  COMPLETED_RECENT_WINDOW_MS,
  selectRecentCompleted,
} from '../lib/board-completed.mjs'

const now = 2_000_000_000_000
const hour = 60 * 60 * 1000
const ticket = (id, closedAt) => ({ ticketId: id, closedAt })

assert.equal(COMPLETED_RECENT_WINDOW_MS, 24 * hour)
assert.equal(BOARD_TOPIC_GROUP_LIMIT, 3)

// Five completed tickets: four inside 24h, only newest three shown.
const five = [
  ticket('ticket-a', now - 1 * hour),
  ticket('ticket-b', now - 2 * hour),
  ticket('ticket-c', now - 3 * hour),
  ticket('ticket-d', now - 4 * hour),
  ticket('ticket-old', now - 30 * hour),
]
const selected = selectRecentCompleted(five, now)
assert.deepEqual(selected.shown.map(item => item.ticketId), ['ticket-a', 'ticket-b', 'ticket-c'])
assert.equal(selected.totalCount, 5)
assert.equal(selected.recentCount, 4)
assert.equal(selected.hasRecent, true)
assert.deepEqual(five.map(item => item.ticketId), ['ticket-a', 'ticket-b', 'ticket-c', 'ticket-d', 'ticket-old'], 'input is not mutated')

// Two recent completed tickets: both shown, total is still five.
const two = selectRecentCompleted([
  ticket('ticket-a', now - 1 * hour),
  ticket('ticket-b', now - 2 * hour),
  ticket('ticket-old-1', now - 25 * hour),
  ticket('ticket-old-2', now - 26 * hour),
  ticket('ticket-old-3', now - 27 * hour),
], now)
assert.deepEqual(two.shown.map(item => item.ticketId), ['ticket-a', 'ticket-b'])
assert.equal(two.totalCount, 5)
assert.equal(two.recentCount, 2)

// None in the window: no old ticket leaks into shown.
const none = selectRecentCompleted([ticket('ticket-old', now - 25 * hour)], now)
assert.deepEqual(none.shown, [])
assert.equal(none.hasRecent, false)
assert.equal(none.totalCount, 1)
assert.equal(none.recentCount, 0)
assert.equal(COMPLETED_RECENT_EMPTY_TEXT, '近 24h 无完成')

// Boundary: exactly now-24h is included; one millisecond older is excluded.
const boundary = selectRecentCompleted([
  ticket('ticket-exact', now - COMPLETED_RECENT_WINDOW_MS),
  ticket('ticket-too-old', now - COMPLETED_RECENT_WINDOW_MS - 1),
], now)
assert.deepEqual(boundary.shown.map(item => item.ticketId), ['ticket-exact'])
assert.equal(boundary.recentCount, 1)

// Future and malformed values are deterministic/non-throwing.
const edge = selectRecentCompleted([
  ticket('ticket-future', now + hour),
  ticket('ticket-invalid', Number.NaN),
  null,
], now)
assert.deepEqual(edge.shown.map(item => item.ticketId), ['ticket-future'])
assert.equal(edge.totalCount, 1)
assert.equal(edge.recentCount, 1)

// Server integration: the topic dialog keeps every completed ticket; the board
// card carries the separate 24h/3 segment.
{
  const fixture = await createFixture({ stateDefault: true })
  try {
    const store = fixture.service.store
    const topic = store.addTopic({ title: 'recent complete topic' })
    const ids = []
    for (const [index, age] of [1, 2, 3, 4, 30].entries()) {
      const ticket = store.addTicket({ goal: 'completed ' + index })
      const moved = store.transitionTicket(ticket.ticketId, 'done', { closedAt: now - age * hour, at: now - age * hour, resolution: { summary: 'done' } })
      assert.equal(moved.ok, true, JSON.stringify(moved))
      store.linkTicket(topic.topicId, ticket.ticketId, 'primary')
      ids.push(ticket.ticketId)
    }
    const data = await fixture.service.boardTopic(topic.topicId, { now })
    assert.equal(data.ok, true)
    assert.equal(data.completed, undefined, 'detail keeps the original all-completed behavior')
    assert.equal(data.tickets.filter(item => item.status === 'done').length, 5, 'detail keeps every completed ticket')
    assert.equal(data.counts.done, 5, 'header total keeps all completed tickets')
  } finally {
    fixture.cleanup()
  }
}

const client = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
assert.match(client, /function renderTopicGroup/)
assert.match(client, /renderTopicGroup\(\{ key: "unreviewed"/)
assert.match(client, /items: completedShown/)
assert.doesNotMatch(client, /cards\(completedShown\)/)
assert.match(client, /ellipsisRow\(omitted, opts\.count\)/)
assert.doesNotMatch(client, /近 24h 无完成/)
assert.doesNotMatch(client, /data-ria-topic-completed-empty/)

// Execute the actual client-side layout function with the old server payload
// (no completed field) and an all-empty topic. This pins the null guard and the
// 24h/3 fallback that keep the modal usable during a server hot-swap window.
const layoutStart = client.indexOf('    function topicRecentCompletedFallback')
const layoutEnd = client.indexOf('\n    // The grid keeps', layoutStart)
assert.ok(layoutStart > 0 && layoutEnd > layoutStart, 'layout functions are present')
const layoutSource = client.slice(layoutStart, layoutEnd)
const makeLayout = new Function(
  'topicTicketTerminal',
  'Date',
  'topicGroupLimit',
  layoutSource + '\nreturn { topicTicketLayout, topicRecentCompletedFallback, topicCardCompletedInfo }',
)
const isTerminal = ticket => ['done', 'cancelled', 'failed'].includes(ticket && ticket.status)
const testTopicGroupLimit = topic => Number.isSafeInteger(topic && topic.groupLimit) && topic.groupLimit > 0 ? topic.groupLimit : 0
const layout = makeLayout(isTerminal, { now: () => now }, testTopicGroupLimit)
const legacyTickets = [
  { ticketId: 'ticket-a', status: 'done', closedAt: now - hour, createdAt: now - 2 * hour },
  { ticketId: 'ticket-b', status: 'done', closedAt: now - 2 * hour, createdAt: now - 3 * hour },
  { ticketId: 'ticket-c', status: 'done', closedAt: now - 3 * hour, createdAt: now - 4 * hour },
  { ticketId: 'ticket-d', status: 'done', closedAt: now - 4 * hour, createdAt: now - 5 * hour },
  { ticketId: 'ticket-old', status: 'done', closedAt: now - 30 * hour, createdAt: now - 31 * hour },
]
const legacy = layout.topicTicketLayout(legacyTickets)
const legacyUnreviewed = legacy.groups.find(group => group.key === 'unreviewed')
assert.equal(legacyUnreviewed.tickets.length, 5, 'detail shows every unreviewed completed ticket, including the 30h one')
assert.equal(legacyUnreviewed.label, '待阅')
assert.equal(legacyUnreviewed.countText, undefined)

const empty = layout.topicTicketLayout([])
assert.equal(empty.groups.length, 0, 'empty topic has no completed section in the original detail behavior')

const cardInfo = layout.topicCardCompletedInfo({
  completed: { shown: [legacyTickets[0], legacyTickets[1], legacyTickets[2]], totalCount: 5, recentCount: 4 },
})
assert.deepEqual(cardInfo.shown.map(item => item.ticketId), ['ticket-a', 'ticket-b', 'ticket-c'])
assert.equal(cardInfo.totalCount, 5)
assert.equal(cardInfo.recentCount, 4)
const cardFallback = layout.topicCardCompletedInfo({})
assert.deepEqual(cardFallback.shown, [], 'missing completed data falls back safely instead of throwing')

console.log('topic recent completed selection ok')
// The board card and the topic dialog must carry the same completed segment.
{
  const fixture = await createFixture({ stateDefault: true })
  try {
    const store = fixture.service.store
    const topic = store.addTopic({ title: 'card completed topic' })
    const ids = []
    for (const [index, age] of [1, 2, 3, 4, 30].entries()) {
      const created = store.addTicket({ goal: 'card completed ' + index })
      const moved = store.transitionTicket(created.ticketId, 'done', { closedAt: now - age * hour, at: now - age * hour, resolution: { summary: 'done' } })
      assert.equal(moved.ok, true, JSON.stringify(moved))
      store.linkTicket(topic.topicId, created.ticketId, 'primary')
      ids.push(created.ticketId)
    }
    const board = await fixture.service.boardData({ now })
    const project = board.projects.find(item => item.topics.some(card => card.topicId === topic.topicId))
    assert.ok(project, 'topic card exists on the board')
    const card = project.topics.find(item => item.topicId === topic.topicId)
    const dialog = await fixture.service.boardTopic(topic.topicId, { now })
    const expectedRecent = selectRecentCompleted(dialog.tickets.filter(item => item.status === 'done'), now)
    assert.deepEqual(card.completed.shown.map(item => item.ticketId), [ids[0], ids[1], ids[2]])
    assert.equal(card.completed.totalCount, 5)
    assert.equal(card.completed.recentCount, 4)
    assert.deepEqual(card.completed.shown.map(item => item.ticketId), expectedRecent.shown.map(item => item.ticketId), 'card uses the same selector as the completed source')
    assert.equal(card.done, dialog.counts.done)
    assert.equal(card.groupLimit, BOARD_TOPIC_GROUP_LIMIT, 'topic card receives the shared limit')
    console.log('topic card completed source ok')
  } finally { fixture.cleanup() }
}

const clientSource = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
assert.match(clientSource, /topicCompletedShown/)
assert.match(clientSource, /renderTopicGroup/)
assert.doesNotMatch(clientSource, /completedShown\.sort\(/)
assert.doesNotMatch(clientSource, /completedTotal/)
assert.doesNotMatch(clientSource, /近 24h " \+ completedRecent/)
assert.match(clientSource, /section\(opts\.label, opts\.count, opts\.color\)/)
console.log('topic card completed client hooks ok')