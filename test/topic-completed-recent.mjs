import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createFixture } from './support/ria-fixture.mjs'
import {
  COMPLETED_RECENT_EMPTY_TEXT,
  COMPLETED_RECENT_LIMIT,
  COMPLETED_RECENT_WINDOW_MS,
  selectRecentCompleted,
} from '../lib/board-completed.mjs'

const now = 2_000_000_000_000
const hour = 60 * 60 * 1000
const ticket = (id, closedAt) => ({ ticketId: id, closedAt })

assert.equal(COMPLETED_RECENT_WINDOW_MS, 24 * hour)
assert.equal(COMPLETED_RECENT_LIMIT, 3)

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

// Server integration: the board topic endpoint applies the same window and
// retains total/recent counts while dropping older terminal tickets.
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
    assert.equal(data.completed.totalCount, 5)
    assert.equal(data.completed.recentCount, 4)
    assert.deepEqual(data.completed.shown.map(item => item.ticketId), [ids[0], ids[1], ids[2]])
    assert.equal(data.tickets.filter(item => item.status === 'done').length, 3, 'old completed tickets omitted from first paint')
    assert.equal(data.counts.done, 5, 'header total keeps all completed tickets')
  } finally {
    fixture.cleanup()
  }
}

const client = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
assert.match(client, /近 24h 无完成/)
assert.match(client, /近 24h " \+ completedRecent/)
assert.match(client, /group\.countText/)
assert.match(client, /data-ria-ticket-empty/)

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
  layoutSource + '\nreturn { topicTicketLayout, topicRecentCompletedFallback }',
)
const isTerminal = ticket => ['done', 'cancelled', 'failed'].includes(ticket && ticket.status)
const layout = makeLayout(isTerminal, { now: () => now })
const legacyTickets = [
  { ticketId: 'ticket-a', status: 'done', closedAt: now - hour, createdAt: now - 2 * hour },
  { ticketId: 'ticket-b', status: 'done', closedAt: now - 2 * hour, createdAt: now - 3 * hour },
  { ticketId: 'ticket-c', status: 'done', closedAt: now - 3 * hour, createdAt: now - 4 * hour },
  { ticketId: 'ticket-d', status: 'done', closedAt: now - 4 * hour, createdAt: now - 5 * hour },
  { ticketId: 'ticket-old', status: 'done', closedAt: now - 30 * hour, createdAt: now - 31 * hour },
]
const legacy = layout.topicTicketLayout(legacyTickets, null)
assert.equal(legacy.completed.totalCount, 5)
assert.equal(legacy.completed.recentCount, 4)
assert.deepEqual(legacy.completed.shown.map(item => item.ticketId), ['ticket-a', 'ticket-b', 'ticket-c'])
const legacyFinished = legacy.groups.find(group => group.key === 'finished')
assert.equal(legacyFinished.tickets.length, 3)
assert.equal(legacyFinished.countText, '5（近 24h 4）')

const empty = layout.topicTicketLayout([], null)
assert.equal(empty.groups.length, 1, 'empty topic renders only the finished section')
const emptyFinished = empty.groups.find(group => group.key === 'finished')
assert.ok(emptyFinished, 'empty topic still renders the finished section')
assert.equal(emptyFinished.tickets.length, 0)
assert.equal(emptyFinished.countText, '0（近 24h 0）')
assert.equal(emptyFinished.emptyText, '近 24h 无完成')

const fromServer = layout.topicTicketLayout(legacyTickets, {
  shown: [legacyTickets[0], legacyTickets[1]], totalCount: 5, recentCount: 3,
})
assert.equal(fromServer.completed.shown.length, 2)
assert.equal(fromServer.groups.find(group => group.key === 'finished').countText, '5（近 24h 3）')

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
    assert.deepEqual(card.completed.shown.map(item => item.ticketId), [ids[0], ids[1], ids[2]])
    assert.equal(card.completed.totalCount, 5)
    assert.equal(card.completed.recentCount, 4)
    assert.deepEqual(card.completed.shown.map(item => item.ticketId), dialog.completed.shown.map(item => item.ticketId), 'card and dialog are the same source')
    assert.equal(card.done, dialog.counts.done)
    console.log('topic card completed source ok')
  } finally { fixture.cleanup() }
}

const clientSource = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
assert.match(clientSource, /data-ria-topic-completed/)
assert.match(clientSource, /topicCompletedShown/)
assert.match(clientSource, /topicTicketTimeText/)
assert.match(clientSource, /completedShown\.map/)
assert.match(clientSource, /已完成 /)
assert.match(clientSource, /近 24h " \+ completedRecent/)
console.log('topic card completed client hooks ok')

