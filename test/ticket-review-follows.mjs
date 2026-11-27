import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { createFixture } from './support/ria-fixture.mjs'

const fixture = await createFixture({ stateDefault: true })
const server = createServer((req, res) => fixture.service.httpHandler(req, res))
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const base = 'http://127.0.0.1:' + server.address().port + '/plugins/dsh-ria/api'
const post = async (path, payload) => {
  const response = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) })
  return { status: response.status, body: await response.json() }
}
const get = async path => {
  const response = await fetch(base + path)
  return { status: response.status, body: await response.json() }
}

try {
  const store = fixture.service.store
  const topic = store.addTopic({ title: 'Review & Follows Topic' })

  // 1. Create two finished tickets + one cancelled ticket.
  const t1 = store.addTicket({ goal: 'First completed task', status: 'open' })
  store.transitionTicket(t1.ticketId, 'done', { resolution: { summary: 'First result summary' } })
  store.linkTicket(topic.topicId, t1.ticketId, 'primary')

  const t2 = store.addTicket({ goal: 'Second failed task', status: 'open' })
  store.transitionTicket(t2.ticketId, 'working', { executor: 'self' })
  const failed2 = store.transitionTicket(t2.ticketId, 'failed', { failure: { code: 'err', message: 'boom' } })
  assert.equal(failed2.ok, true, JSON.stringify(failed2))
  store.linkTicket(topic.topicId, t2.ticketId, 'primary')

  const tCancel = store.addTicket({ goal: 'Cancelled task', status: 'open' })
  store.transitionTicket(tCancel.ticketId, 'cancelled', { resolution: { reason: 'user cancelled' } })
  store.linkTicket(topic.topicId, tCancel.ticketId, 'primary')

  // 2. Multi-value follows + depends (alias of dependsOn) without scheduling block on follows.
  const tFollow = store.addTicket({
    goal: 'Followup task',
    status: 'open',
    depends: [t1.ticketId],
    follows: [t1.ticketId, t2.ticketId],
  })
  store.linkTicket(topic.topicId, tFollow.ticketId, 'primary')
  assert.deepEqual(tFollow.dependsOn, [t1.ticketId], 'depends alias maps to dependsOn')
  assert.deepEqual(tFollow.follows, [t1.ticketId, t2.ticketId], 'follows stores multiple predecessors')
  assert.equal(tFollow.waitingOn, 'ria', 'follows on failed ticket does not block scheduling')

  // Reject self-follow, duplicates, missing target, and >5 follows.
  assert.throws(() => store.updateTicket(tFollow.ticketId, { follows: [tFollow.ticketId] }), err => err.code === 'follows_self')
  assert.throws(() => store.updateTicket(tFollow.ticketId, { follows: [t1.ticketId, t1.ticketId] }), err => err.code === 'follows_duplicate')
  assert.throws(() => store.updateTicket(tFollow.ticketId, { follows: ['ticket_nonexistent'] }), err => err.code === 'follows_missing')

  // 3. Advisor context includes predecessor goal + resolution/failure summary.
  const advisorCtx = fixture.service.controller.advisorFollowsContext(tFollow)
  assert.ok(advisorCtx.includes(t1.ticketId) && advisorCtx.includes('First result summary'), 'advisor context includes followed done resolution')
  assert.ok(advisorCtx.includes(t2.ticketId) && advisorCtx.includes('boom'), 'advisor context includes followed failed reason')

  // 4. Detail endpoint returns bidirectional follows / followedBy + review state.
  const detailFollow = await get('/tickets/' + encodeURIComponent(tFollow.ticketId))
  assert.equal(detailFollow.status, 200)
  assert.deepEqual(detailFollow.body.context.follows, [t1.ticketId, t2.ticketId])
  assert.equal(detailFollow.body.context.followsSummaries.length, 2)
  const detailT1 = await get('/tickets/' + encodeURIComponent(t1.ticketId))
  assert.equal(detailT1.status, 200)
  assert.deepEqual(detailT1.body.context.followedBy, [tFollow.ticketId])
  assert.equal(detailT1.body.context.needsReview, true)
  assert.equal(detailT1.body.context.reviewed, false)

  // 5. Board topic card shows unreviewed (done + failed) and excludes cancelled from unreviewed.
  let board = await get('/board?limit=200')
  let card = board.body.projects.flatMap(p => p.topics).find(t => t.topicId === topic.topicId)
  assert.ok(card, 'topic card present')
  assert.equal(card.counts.unreviewed, 2, 'done + failed are unreviewed; cancelled is not')
  assert.equal(card.counts.reviewed, 1, 'cancelled counts as reviewed')
  assert.equal(card.unreviewed.length, 2)

  // 6. Mark single ticket reviewed, then unmark, then reopen bumps revision back to unreviewed.
  const markOne = await post('/tickets/review', { ticketId: t1.ticketId, reviewed: true })
  assert.equal(markOne.status, 200, JSON.stringify(markOne.body))
  assert.equal(markOne.body.review.reviewed, true)
  assert.equal(markOne.body.review.needsReview, false)

  const unmarkOne = await post('/tickets/review', { ticketId: t1.ticketId, reviewed: false })
  assert.equal(unmarkOne.status, 200)
  assert.equal(unmarkOne.body.review.needsReview, true)

  // Reopen after review resets needsReview because revision advances.
  await post('/tickets/review', { ticketId: t1.ticketId, reviewed: true })
  store.transitionTicket(t1.ticketId, 'open', { reason: 'reopen' })
  store.transitionTicket(t1.ticketId, 'done', { resolution: { summary: 'done again' } })
  const detailReopened = await get('/tickets/' + encodeURIComponent(t1.ticketId))
  assert.equal(detailReopened.body.context.needsReview, true, 'reopen + re-done returns to unreviewed')

  // 7. Topic review-all marks remaining unreviewed tickets in one call.
  const reviewTopic = await post('/tickets/review', { topicId: topic.topicId, reviewed: true })
  assert.equal(reviewTopic.status, 200, JSON.stringify(reviewTopic.body))
  assert.equal(reviewTopic.body.count, 2)

  board = await get('/board?limit=200')
  card = board.body.projects.flatMap(p => p.topics).find(t => t.topicId === topic.topicId)
  assert.equal(card.counts.unreviewed, 0)
  assert.equal(card.counts.reviewed, 3)

  // 8. Client markers for review UI, topic modal filters, and SayDialog clipboard paste.
  const client = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  assert.match(client, /data-ria-topic-review-all/)
  assert.match(client, /data-ria-project-review-all/)
  assert.match(client, /data-ria-ticket-review-btn/)
  assert.match(client, /data-ria-topic-reviewed-row/)
  assert.match(client, /id: "unreviewed", label: "待阅"/)
  assert.match(client, /id: "reviewed", label: "已阅"/)
  assert.match(client, /function extractClipboardFiles/)
  assert.match(client, /data-ria-say-preview/)

  console.log('ticket review and follows ok')
} finally {
  await new Promise(resolve => server.close(resolve))
  fixture.cleanup()
}
