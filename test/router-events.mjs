import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RouterEventLog } from '../lib/router-events.mjs'
import { createFixture } from './support/ria-fixture.mjs'

const dirs = []
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), 'ria-router-events-'))
  dirs.push(dir)
  return dir
}

try {
  // 1. Module: append fields, filters, pagination, rotation, retention.
  {
    const dir = tempDir()
    let now = Date.parse('2026-01-15T12:00:00Z')
    const log = new RouterEventLog({ stateDir: dir, now: () => now })
    const first = log.append({
      event: 'ticket.created',
      ticketId: 'ticket_a',
      sessionId: 'session_chatbot',
      actor: 'chat',
      reason: 'chatbot_request',
      payload: { mode: 'work', workspace: '/tmp/ws' },
    })
    assert.equal(first.ts, now)
    assert.equal(first.event, 'ticket.created')
    assert.equal(first.ticketId, 'ticket_a')
    assert.deepEqual(first.payload, { mode: 'work', workspace: '/tmp/ws' })
    now += 1000
    log.append({ event: 'dispatch.attempt', ticketId: 'ticket_a', sessionId: 'worker_a', actor: 'router', reason: 'dispatch', payload: { workerId: 'worker_a' } })
    log.append({ event: 'dispatch.confirmed', ticketId: 'ticket_a', sessionId: 'worker_a', actor: 'router', reason: 'turn', payload: { workerId: 'worker_a' } })
    now += 1000
    log.append({ event: 'ticket.state', ticketId: 'ticket_b', sessionId: 'worker_b', actor: 'router', reason: 'done', payload: { from: 'working', to: 'done' } })

    const byTicket = log.query({ ticketId: 'ticket_a' })
    assert.equal(byTicket.events.length, 3)
    assert.equal(byTicket.total, 3)
    assert.equal(byTicket.hasMore, false)
    assert.ok(byTicket.events.every(item => item.ticketId === 'ticket_a'))
    const byPrefix = log.query({ type: 'dispatch.*' })
    assert.deepEqual(byPrefix.events.map(item => item.event).sort(), ['dispatch.attempt', 'dispatch.confirmed'])
    const byExact = log.query({ types: ['ticket.state'] })
    assert.equal(byExact.events.length, 1)
    assert.equal(byExact.events[0].ticketId, 'ticket_b')
    const byTime = log.query({ from: Date.parse('2026-01-15T12:00:01Z'), to: Date.parse('2026-01-15T12:00:02Z') })
    assert.equal(byTime.events.length, 3)
    const page = log.query({ limit: 1, offset: 1 })
    assert.equal(page.events.length, 1)
    assert.equal(page.total, 4)
    assert.equal(page.hasMore, true)
    assert.equal(page.limit, 1)
    assert.equal(page.offset, 1)
    assert.equal(log.query({ limit: 999 }).limit, 500)

    // Month rotation: the January hot file becomes a monthly file.
    now = Date.parse('2026-02-01T00:00:00Z')
    log.append({ event: 'ticket.created', ticketId: 'ticket_c', sessionId: 's', actor: 'chat', reason: 'x', payload: null })
    assert.ok(existsSync(join(dir, 'router-events-2026-01.jsonl')))
    const hot = readFileSync(join(dir, 'router-events.jsonl'), 'utf8').trim().split('\n').filter(Boolean)
    assert.equal(hot.length, 1)
    assert.equal(JSON.parse(hot[0]).ticketId, 'ticket_c')

    // Size rotation: a tiny maxBytes rotates the hot file into this month's file.
    const sizeDir = tempDir()
    const tiny = new RouterEventLog({ stateDir: sizeDir, now: () => now, maxBytes: 80 })
    tiny.append({ event: 'ticket.created', ticketId: 'ticket_size', sessionId: 's', actor: 'chat', reason: 'x', payload: null })
    tiny.append({ event: 'dispatch.attempt', ticketId: 'ticket_size', sessionId: 'w', actor: 'router', reason: 'x', payload: null })
    assert.ok(existsSync(join(sizeDir, 'router-events-2026-02.jsonl')))
    assert.equal(tiny.query({ ticketId: 'ticket_size' }).events.length, 2)
  }

  // 2. Retention: only the newest 12 monthly files survive.
  {
    const dir = tempDir()
    for (let index = 0; index < 13; index += 1) {
      const date = new Date(Date.UTC(2025, index, 1))
      const month = date.getUTCFullYear() + '-' + String(date.getUTCMonth() + 1).padStart(2, '0')
      writeFileSync(join(dir, 'router-events-' + month + '.jsonl'), JSON.stringify({ ts: 1, event: 'x' }) + '\n')
    }
    const log = new RouterEventLog({ stateDir: dir, now: () => Date.parse('2026-02-01T00:00:00Z') })
    const result = log.prune()
    assert.equal(result.pruned, 1)
    assert.equal(existsSync(join(dir, 'router-events-2025-01.jsonl')), false)
    assert.ok(existsSync(join(dir, 'router-events-2025-02.jsonl')))
    assert.ok(existsSync(join(dir, 'router-events-2026-01.jsonl')))
  }

  // 3. Empty state and write failures are non-fatal.
  {
    const dir = tempDir()
    const log = new RouterEventLog({ stateDir: dir, now: () => Date.parse('2026-01-01T00:00:00Z') })
    assert.deepEqual(log.query({}).events, [])
    const badDir = join(tempDir(), 'not-a-directory')
    writeFileSync(badDir, 'x')
    const broken = new RouterEventLog({ stateDir: badDir, now: () => Date.parse('2026-01-01T00:00:00Z') })
    assert.equal(broken.append({ event: 'ticket.created', ticketId: 't' }), null)
    assert.deepEqual(broken.query({}).events, [])
  }

  // 4. Fixture: the full v2 flow writes the expected event types/payloads.
  {
    const workspace = tempDir()
    const fixture = await createFixture({ v2Default: true })
    try {
      const chatbot = fixture.service.v2.v2.chatbotSessionId
      const seeded = fixture.service.v2.lessons.accept({
        scenario: 'router events integration lesson',
        pitfall: 'missing event',
        approach: 'emit at the existing callback',
        tags: ['router-events'],
        source: { ticketId: 'ticket_old', sessionId: 'session_old' },
      })
      const lessonId = seeded.entry.id
      const made = await fixture.callAs(chatbot, 'chatbot_request', {
        goal: 'router events end-to-end',
        acceptance: 'events exist',
        mode: 'work',
        workspace,
      })
      assert.equal(made.ok, true)
      const advisor = fixture.service.v2.v2.advisor('global').sessionId
      const plan = await fixture.callAs(advisor, 'ticket_plan', {
        ticketId: made.ticketId,
        summary: 'plan for events',
        steps: ['one step'],
        lessons: [lessonId],
      })
      assert.equal(plan.ok, true)
      const dispatched = await fixture.callAs(advisor, 'ticket_dispatch', { ticketId: made.ticketId })
      assert.equal(dispatched.ok, true)
      const worker = dispatched.workerSessionId
      fixture.service.onSessionEvent({ header: { id: worker } }, { type: 'turn/start', data: { turn: 1 } })

      // Low-risk approval: asked + decided are still recorded even though the
      // ticket is never parked.
      await fixture.emit(
        'tools/pre-execute',
        { agent: { id: worker }, name: 'bash', callId: 'call_events', arguments: { command: 'git status' } },
        async () => ({ kind: 'enter' }),
      )
      fixture.service.onSessionEvent(
        { header: { id: worker } },
        { type: 'approval/asked', time: Date.now(), data: { id: 'apr_events', toolName: 'bash', callId: 'call_events', reason: 'read only' } },
      )
      const outcome = await fixture.emit(
        'approval/request',
        { agent: { id: worker }, toolName: 'bash', callId: 'call_events', reason: 'read only', signal: new AbortController().signal },
        async () => 'rejected',
      )
      assert.equal(outcome, 'allowed-once')
      fixture.service.onSessionEvent(
        { header: { id: worker } },
        { type: 'approval/decided', time: Date.now(), data: { id: 'apr_events', outcome: 'allowed-once' } },
      )
      const reported = await fixture.callAs(worker, 'worker_report', {
        ticketId: made.ticketId,
        status: 'done',
        summary: 'done with events',
        evidence: ['router-events.jsonl'],
      })
      assert.equal(reported.ok, true)

      const events = fixture.service.routerEvents.query({ ticketId: made.ticketId }).events
      const types = new Set(events.map(item => item.event))
      for (const type of ['ticket.created', 'advisor.plan', 'dispatch.attempt', 'dispatch.confirmed', 'lesson.injected', 'approval.asked', 'approval.decided', 'ticket.state']) {
        assert.ok(types.has(type), 'missing event type ' + type)
      }
      const created = events.find(item => item.event === 'ticket.created')
      assert.equal(created.payload.mode, 'work')
      assert.equal(created.payload.workspace, workspace)
      assert.equal(created.sessionId, chatbot)
      const planned = events.find(item => item.event === 'advisor.plan')
      assert.equal(planned.payload.steps, 1)
      const attempted = events.find(item => item.event === 'dispatch.attempt')
      assert.equal(attempted.payload.workerId, worker)
      const confirmed = events.find(item => item.event === 'dispatch.confirmed')
      assert.equal(confirmed.payload.workerId, worker)
      assert.equal(confirmed.payload.requestId, attempted.payload.requestId)
      const injected = events.find(item => item.event === 'lesson.injected')
      assert.deepEqual(injected.payload.lessonIds, [lessonId])
      assert.equal(injected.payload.source, 'workOrder')
      const asked = events.find(item => item.event === 'approval.asked')
      assert.equal(asked.payload.riskLevel, 'low')
      assert.equal(asked.payload.decision, 'auto-allow')
      const decided = events.find(item => item.event === 'approval.decided')
      assert.equal(decided.payload.riskLevel, 'low')
      assert.equal(decided.payload.decision, 'auto-allow')
      const transitions = events.filter(item => item.event === 'ticket.state')
      assert.ok(transitions.some(item => item.payload.from === 'open' && item.payload.to === 'working'))
      assert.ok(transitions.some(item => item.payload.from === 'working' && item.payload.to === 'done'))
      assert.ok(transitions.every(item => item.actor && item.reason !== undefined))

      const raw = readFileSync(join(fixture.stateDir, 'router-events.jsonl'), 'utf8').trim().split('\n').filter(Boolean)
      assert.ok(raw.length >= 8)
      assert.ok(raw.every(line => {
        const item = JSON.parse(line)
        return Number.isFinite(item.ts) && typeof item.event === 'string' && 'ticketId' in item && 'sessionId' in item && 'actor' in item && 'reason' in item && 'payload' in item
      }))
    } finally {
      fixture.cleanup()
    }
  }

  // 5. Read-only query through ria_status scope=events and HTTP /events.
  {
    const fixture = await createFixture({})
    try {
      assert.equal(fixture.service.routerEvents.query({}).events.length, 0)
      const empty = await fixture.call('ria_status', { scope: 'events' })
      assert.equal(empty.scope, 'events')
      assert.deepEqual(empty.events, [])
      fixture.service.routerEvents.append({ event: 'ticket.created', ticketId: 'ticket_q', sessionId: 's', actor: 'chat', reason: 'q', payload: { mode: 'work' } })
      fixture.service.routerEvents.append({ event: 'dispatch.attempt', ticketId: 'ticket_q', sessionId: 'w', actor: 'router', reason: 'q', payload: { workerId: 'w' } })
      const before = readFileSync(join(fixture.stateDir, 'router-events.jsonl'), 'utf8')
      const queried = await fixture.call('ria_status', { scope: 'events', ticketId: 'ticket_q', type: 'dispatch.*' })
      assert.equal(queried.ok, true)
      assert.equal(queried.events.length, 1)
      assert.equal(queried.events[0].event, 'dispatch.attempt')
      assert.equal(queried.total, 1)
      assert.equal(readFileSync(join(fixture.stateDir, 'router-events.jsonl'), 'utf8'), before)

      const bad = await fixture.call('ria_status', { scope: 'events', from: 'not-a-time' })
      assert.equal(bad.ok, false)
      assert.equal(bad.code, 'invalid_time')

      // A throwing log must not break the control plane.
      const original = fixture.service.routerEvents.append
      fixture.service.routerEvents.append = () => { throw new Error('audit sink down') }
      assert.doesNotThrow(() => fixture.service.routerEvent({ event: 'ticket.created', ticketId: 'ticket_q' }))
      fixture.service.routerEvents.append = original

      // HTTP GET /events uses the same read-only query.
      const req = new EventEmitter()
      req.method = 'GET'
      req.url = '/plugins/dsh-ria/api/events?ticketId=ticket_q&type=dispatch.*&limit=10'
      req.headers = { host: '127.0.0.1:3080' }
      const res = {
        statusCode: 0,
        headers: {},
        setHeader(name, value) { this.headers[name] = value },
        end(body) { this.body = body; this.done(body) },
      }
      const done = new Promise(resolve => { res.done = resolve })
      fixture.service.httpHandler(req, res)
      const body = JSON.parse(await done)
      assert.equal(res.statusCode, 200)
      assert.equal(body.scope, 'events')
      assert.equal(body.events.length, 1)
      assert.equal(body.events[0].event, 'dispatch.attempt')
    } finally {
      fixture.cleanup()
    }
  }

  console.log('router events ok')
} finally {
  for (const dir of dirs.splice(0).reverse()) {
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* already gone */ }
  }
}
