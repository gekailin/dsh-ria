import assert from 'node:assert/strict'
import { createFixture } from './support/ria-fixture.mjs'

const event = (seq, type, time, data) => ({ type: 'event', event: { type, seq, time, data } })

const alphaEvents = [
  event(1, 'turn/start', 1000, { turn: 1 }),
  event(2, 'user/message', 1100, { content: [{ type: 'text', text: 'start' }] }),
  event(3, 'tool/call', 1200, { turn: 1, step: 1, callId: 'c1', name: 'read', arguments: '{"path":"a.txt"}' }),
  event(4, 'tool/result', 1300, { turn: 1, step: 1, error: { name: 'ToolError', code: 'E_READ' } }),
  event(5, 'approval/asked', 1400, { id: 'a1', toolName: 'bash', reason: 'run tests token=abc123' }),
  event(6, 'approval/decided', 1500, { id: 'a1', outcome: 'allowed-once' }),
  event(7, 'error', 1600, { code: 'E_BOOM', message: 'boom' }),
  event(8, 'llm/error', 1700, { message: 'Authorization: Bearer sk-secret-999' }),
  event(9, 'command/run', 1800, { commandId: 'cmd1', name: 'npm', args: 'test --token=abc123' }),
  event(10, 'turn/end', 1900, { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } }),
  event(11, 'turn/start', 2000, { turn: 2 }),
  event(12, 'tool/call', 2100, { turn: 2, step: 1, callId: 'c2', name: 'bash', arguments: '{"token":"abc123"}' }),
  event(13, 'tool/result', 2200, { turn: 2, step: 1 }),
  event(14, 'turn/end', 2300, { turn: 2, reason: { kind: 'completed' } }),
  event(15, 'user/message', 2400, { content: [{ type: 'text', text: 'done' }] }),
  event(16, 'step/start', 2500, { turn: 2, step: 1 }),
]

const bulkEvents = Array.from({ length: 205 }, (_, index) =>
  event(index + 1, 'tool/call', 1000 + index, { turn: 1, step: 1, callId: 'c' + (index + 1), name: 'read', arguments: '{}' }))
const noiseEvents = Array.from({ length: 1200 }, (_, index) =>
  event(index + 1, 'user/message', 1000 + index, { content: [{ type: 'text', text: 'noise' }] }))

const fixture = await createFixture({
  v2Default: true,
  // The real host mounts grep/glob; the minimal fixture adds them here so the
  // read-only allow-list is observable.
  extraGlobalTools: ['grep', 'glob'],
  archivedSessionIds: ['session-retro-alpha'],
  extraSessions: [
    { sessionId: 'session-retro-alpha', running: false, blank: false, agentAvailable: true, updatedAt: 1000, cwd: '/tmp/ria-alpha', projections: { values: { title: 'Alpha Retro' } } },
    { sessionId: 'session-retro-beta', running: true, blank: false, agentAvailable: false, updatedAt: 2000, cwd: '/tmp/ria-beta', projections: { values: { title: 'Beta Retro' } } },
    { sessionId: 'session-retro-gamma', running: false, blank: false, agentAvailable: true, updatedAt: 3000, cwd: '/tmp/ria-gamma?token=abc', projections: { values: { title: 'Gamma Retro token=abc123' } } },
    { sessionId: 'session-retro-sub', running: false, blank: false, agentAvailable: true, updatedAt: 4000, cwd: '/tmp/ria-sub', origin: 'subagent', parentSessionId: 'session-retro-alpha', projections: { values: { title: 'Sub Retro' } } },
    { sessionId: 'session-retro-bulk', running: false, blank: false, agentAvailable: true, updatedAt: 500, cwd: '/tmp/ria-bulk' },
    { sessionId: 'session-retro-noise', running: false, blank: false, agentAvailable: true, updatedAt: 400, cwd: '/tmp/ria-noise' },
  ],
  sessionEvents: {
    'session-retro-alpha': alphaEvents,
    'session-retro-bulk': bulkEvents,
    'session-retro-noise': noiseEvents,
  },
})

try {
  const chatbot = fixture.service.v2.v2.chatbotSessionId
  const made = await fixture.callAs(chatbot, 'chatbot_request', { goal: 'review the retrospective tools' })
  assert.equal(made.ok, true)
  const advisor = fixture.service.v2.v2.advisor('global').sessionId
  // Create both Worker kinds before the read-only baseline: session creation
  // renames the session, which is test setup rather than a write by the tools.
  const worker = await fixture.service.v2.ensureWorker('global')
  const reflection = await fixture.service.v2.ensureReflectionWorker('global')
  // Count every write path the two read-only tools could reach; section 8
  // checks that none of these moved.
  const writeBaseline = {
    prompts: fixture.prompts.length,
    appends: fixture.appends.length,
    updates: fixture.updateQueueCalls.length,
    renames: fixture.renames.length,
  }
  // The retrospective tools moved off the Advisor onto the reflection Worker.
  assert.deepEqual(fixture.visibleTools(advisor).sort(), [
    'glob', 'grep', 'lesson_review', 'lesson_search', 'read', 'ticket_block', 'ticket_dispatch', 'ticket_plan', 'ticket_read',
  ])
  assert.deepEqual(fixture.visibleTools(reflection.sessionId).sort(), [
    'glob', 'grep', 'read', 'session_events', 'session_list', 'worker_report',
  ])

  const listAs = args => fixture.callAs(reflection.sessionId, 'session_list', args)
  const eventsAs = args => fixture.callAs(reflection.sessionId, 'session_events', args)

  // 1. session_list filters: id prefix, title, cwd, time range, running,
  // agentAvailable, subagent/archived switches, limit and total.
  const all = await listAs({ idPrefix: 'session-retro' })
  assert.equal(all.ok, true)
  assert.equal(all.total, 5)
  assert.deepEqual(all.sessions.map(item => item.sessionId), [
    'session-retro-gamma', 'session-retro-beta', 'session-retro-alpha', 'session-retro-bulk', 'session-retro-noise',
  ])
  const byId = new Map(all.sessions.map(item => [item.sessionId, item]))
  assert.equal(byId.get('session-retro-alpha').archived, true)
  assert.equal(byId.get('session-retro-beta').agentAvailable, false)
  assert.equal(byId.get('session-retro-gamma').title, 'Gamma Retro token=***')
  assert.equal(byId.get('session-retro-gamma').cwd, '/tmp/ria-gamma?token=***')
  assert.equal(JSON.stringify(all).includes('abc123'), false)
  assert.equal(byId.get('session-retro-sub'), undefined)

  const prefixed = await listAs({ idPrefix: 'SESSION-RETRO-G' })
  assert.deepEqual(prefixed.sessions.map(item => item.sessionId), ['session-retro-gamma'])
  const titled = await listAs({ idPrefix: 'session-retro', titleContains: 'beta' })
  assert.deepEqual(titled.sessions.map(item => item.sessionId), ['session-retro-beta'])
  const cwd = await listAs({ idPrefix: 'session-retro', cwdContains: 'ria-gamma' })
  assert.deepEqual(cwd.sessions.map(item => item.sessionId), ['session-retro-gamma'])
  const ranged = await listAs({
    idPrefix: 'session-retro',
    updatedAfter: new Date(1000).toISOString(),
    updatedBefore: new Date(2000).toISOString(),
  })
  assert.deepEqual(ranged.sessions.map(item => item.sessionId), ['session-retro-beta', 'session-retro-alpha'])
  const running = await listAs({ idPrefix: 'session-retro', running: true })
  assert.deepEqual(running.sessions.map(item => item.sessionId), ['session-retro-beta'])
  const unavailable = await listAs({ idPrefix: 'session-retro', agentAvailable: false })
  assert.deepEqual(unavailable.sessions.map(item => item.sessionId), ['session-retro-beta'])
  const noArchived = await listAs({ idPrefix: 'session-retro', includeArchived: false })
  assert.equal(noArchived.total, 4)
  assert.equal(noArchived.sessions.some(item => item.sessionId === 'session-retro-alpha'), false)
  const withSubagents = await listAs({ idPrefix: 'session-retro', includeSubagents: true })
  assert.equal(withSubagents.total, 6)
  const subagent = withSubagents.sessions.find(item => item.sessionId === 'session-retro-sub')
  assert.equal(subagent.origin, 'subagent')
  assert.equal(subagent.parentSessionId, 'session-retro-alpha')
  const limited = await listAs({ idPrefix: 'session-retro', limit: 2 })
  assert.equal(limited.sessions.length, 2)
  assert.equal(limited.total, 5)
  assert.equal(limited.truncated, true)
  assert.equal((await listAs({ updatedAfter: 'not-a-date' })).code, 'invalid_time')

  // 2. session_events: default review-critical set, one-line summaries,
  // type/seq/time filters and legacy non-key events excluded.
  const review = await eventsAs({ sessionId: 'session-retro-alpha' })
  assert.equal(review.ok, true)
  assert.equal(review.sessionId, 'session-retro-alpha')
  assert.equal(review.count, 13)
  assert.equal(review.truncated, false)
  assert.equal(review.more, false)
  assert.equal(review.nextThroughSeq, null)
  assert.equal(review.note, 'read-only')
  assert.equal(review.events[0].seq, 14)
  const types = new Set(review.events.map(item => item.type))
  assert.equal(types.has('user/message'), false)
  assert.equal(types.has('step/start'), false)
  assert.equal(types.has('llm/error'), true)
  const summaryOf = seq => review.events.find(item => item.seq === seq).summary
  assert.equal(summaryOf(1), 'turn 1')
  assert.equal(summaryOf(10), 'turn 1 end aborted(user)')
  assert.equal(summaryOf(14), 'turn 2 end completed')
  assert.equal(summaryOf(3), 'tool read')
  assert.equal(summaryOf(4), 'tool result error:E_READ')
  assert.equal(summaryOf(13), 'tool result ok')
  assert.equal(summaryOf(6), 'approval a1 outcome=allowed-once')
  assert.equal(summaryOf(5), 'approval a1 tool=bash reason=run tests token=***')
  assert.equal(summaryOf(7), 'error: E_BOOM')
  assert.equal(summaryOf(8), 'error: Authorization: [redacted]')
  assert.equal(summaryOf(9), 'command npm test --token=***')
  const reviewText = JSON.stringify(review)
  assert.equal(reviewText.includes('abc123'), false)
  assert.equal(reviewText.includes('sk-secret-999'), false)

  const approvals = await eventsAs({ sessionId: 'session-retro-alpha', types: ['approval/*'] })
  assert.deepEqual(approvals.events.map(item => item.seq), [6, 5])
  const turns = await eventsAs({ sessionId: 'session-retro-alpha', types: ['turn/*'] })
  assert.deepEqual(turns.events.map(item => item.seq), [14, 11, 10, 1])
  const tools = await eventsAs({ sessionId: 'session-retro-alpha', types: ['tool/*'] })
  assert.deepEqual(tools.events.map(item => item.seq), [13, 12, 4, 3])

  const windowed = await eventsAs({ sessionId: 'session-retro-alpha', fromSeq: 5, toSeq: 9 })
  assert.deepEqual(windowed.events.map(item => item.seq), [9, 8, 7, 6, 5])
  const timed = await eventsAs({ sessionId: 'session-retro-alpha', fromTime: 1400, toTime: 1800 })
  assert.deepEqual(timed.events.map(item => item.seq), [9, 8, 7, 6, 5])
  const timedIso = await eventsAs({
    sessionId: 'session-retro-alpha',
    fromTime: new Date(1400).toISOString(),
    toTime: new Date(1800).toISOString(),
  })
  assert.deepEqual(timedIso.events.map(item => item.seq), [9, 8, 7, 6, 5])
  assert.equal((await eventsAs({ sessionId: 'session-retro-alpha', fromTime: 'nope' })).code, 'invalid_time')
  assert.equal((await eventsAs({ sessionId: 'session-retro-alpha', fromSeq: 9, toSeq: 5 })).code, 'invalid_range')

  // 3. Pagination: the second read continues from nextThroughSeq and never
  // re-returns the first page.
  const firstPage = await eventsAs({ sessionId: 'session-retro-alpha', limit: 3 })
  assert.deepEqual(firstPage.events.map(item => item.seq), [14, 13, 12])
  assert.equal(firstPage.truncated, true)
  assert.equal(firstPage.more, true)
  assert.equal(firstPage.nextThroughSeq, 11)
  assert.ok(firstPage.scanned >= 3)
  const secondPage = await eventsAs({ sessionId: 'session-retro-alpha', limit: 3, toSeq: firstPage.nextThroughSeq })
  assert.deepEqual(secondPage.events.map(item => item.seq), [11, 10, 9])
  assert.equal(secondPage.more, true)
  assert.equal(secondPage.nextThroughSeq, 8)
  const pagedSeqs = [...firstPage.events, ...secondPage.events].map(item => item.seq)
  assert.equal(new Set(pagedSeqs).size, pagedSeqs.length)

  // 4. summaryChars and the limit ceiling.
  const short = await eventsAs({ sessionId: 'session-retro-alpha', types: ['approval/*'], summaryChars: 20 })
  for (const item of short.events) {
    assert.ok(item.summary.length <= 20, item.summary)
    assert.ok(item.summary.endsWith('…'), item.summary)
    assert.equal(/[\r\n]/.test(item.summary), false)
  }
  const bulk = await eventsAs({ sessionId: 'session-retro-bulk', limit: 999 })
  assert.equal(bulk.count, 200)
  assert.equal(bulk.more, true)
  assert.equal(bulk.nextThroughSeq, 5)
  assert.equal(bulk.scanned, 200)
  const bulkTail = await eventsAs({ sessionId: 'session-retro-bulk', toSeq: 5, limit: 200 })
  assert.equal(bulkTail.count, 5)
  assert.equal(bulkTail.more, false)

  // 5. Page cap: 10 bounded pages, not the whole 1200-event log.
  const noise = await eventsAs({ sessionId: 'session-retro-noise' })
  assert.equal(noise.ok, true)
  assert.equal(noise.count, 0)
  assert.equal(noise.scanned, 1000)
  assert.equal(noise.more, true)
  assert.equal(noise.nextThroughSeq, 200)

  // 6. Id resolution and errors.
  const ambiguous = await eventsAs({ sessionId: 'session-retro-', types: ['turn/*'] })
  assert.equal(ambiguous.code, 'session_ambiguous')
  assert.ok(ambiguous.candidates.length <= 5)
  assert.ok(ambiguous.candidates.every(item => item.sessionId && item.title !== undefined))
  const missing = await eventsAs({ sessionId: 'session-no-such-session' })
  assert.equal(missing.code, 'session_not_found')
  const byPrefix = await eventsAs({ sessionId: 'session-retro-al', types: ['turn/*'] })
  assert.equal(byPrefix.ok, true)
  assert.equal(byPrefix.sessionId, 'session-retro-alpha')

  // 7. Role isolation and the reflectionCaller guard.
  assert.equal(fixture.visibleTools(advisor).includes('session_list'), false)
  assert.equal(fixture.visibleTools(advisor).includes('session_events'), false)
  await assert.rejects(
    () => fixture.callAs(chatbot, 'session_list', {}),
    /tool not installed for .*: session_list/,
  )
  await assert.rejects(
    () => fixture.callAs(chatbot, 'session_events', { sessionId: 'session-retro-alpha' }),
    /tool not installed for .*: session_events/,
  )
  assert.equal(fixture.visibleTools(worker.sessionId).includes('session_list'), false)
  await assert.rejects(
    () => fixture.callAs(worker.sessionId, 'session_list', {}),
    /tool not installed for .*: session_list/,
  )
  const forbiddenList = await fixture.service.v2.sessionList({}, { agent: { id: chatbot } })
  assert.equal(forbiddenList.code, 'forbidden')
  const forbiddenEvents = await fixture.service.v2.sessionEvents({ sessionId: 'session-retro-alpha' }, { agent: { id: chatbot } })
  assert.equal(forbiddenEvents.code, 'forbidden')
  // The Advisor and work Workers are refused even when calling the implementation.
  for (const sessionId of [advisor, worker.sessionId]) {
    const refused = await fixture.service.v2.sessionList({}, { agent: { id: sessionId } })
    assert.equal(refused.code, 'forbidden')
  }

  // 8. Read-only: no prompt, append, queue update or rename happened after the
  // baseline. ensureWorker (test setup, not the tools) may still create a
  // session, so creates/summaries are not part of this assertion.
  assert.equal(fixture.prompts.length, writeBaseline.prompts)
  assert.equal(fixture.appends.length, writeBaseline.appends)
  assert.equal(fixture.updateQueueCalls.length, writeBaseline.updates)
  assert.equal(fixture.renames.length, writeBaseline.renames)

  console.log('v2 reflection session tools ok')
} finally {
  fixture.cleanup()
}
