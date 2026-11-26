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

console.log('topic recent completed selection ok')