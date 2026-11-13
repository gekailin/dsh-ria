import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFixture } from './support/ria-fixture.mjs'

const TURN_START = { type: 'turn/start', data: { turn: 1 } }
const worker = { header: { id: 'session-worker' } }
const unconfirmed = service => service.outbox.all().filter(entry => entry.kind === 'dispatch_unconfirmed')

async function dispatch(fixture, message, mode = 'queue') {
  const made = await fixture.call('ria_ticket', { goal: 'ship the thing', executor: 'session-worker' })
  const ticketId = made.ticket.ticketId
  const sent = await fixture.call('ria_request', {
    targetSessionIds: ['session-worker'],
    message,
    ticketId,
    note: '开始处理。',
    mode,
  })
  assert.equal(sent.results[0].ok, true)
  return ticketId
}

function expired(ticket) {
  ticket.attempt.startedAt = Date.now() - 61_000
  return ticket
}

// 1. An early turn/start, arriving before prompt() resolves, confirms the
// dispatch; the ticket stays working and no alert is queued.
{
  let fixture
  let fired = false
  fixture = await createFixture({
    onPrompt: async request => {
      if (fired || request.sessionId !== 'session-worker') return
      fired = true
      fixture.service.onSessionEvent(worker, TURN_START)
    },
  })
  try {
    const ticketId = await dispatch(fixture, 'please fix the bug')
    assert.equal(fired, true)
    const ticket = fixture.service.store.ticket(ticketId)
    assert.equal(ticket.status, 'working')
    assert.equal(typeof ticket.attempt.confirmedAt, 'number')
    assert.equal(unconfirmed(fixture.service).length, 0)
  } finally {
    fixture.cleanup()
  }
}

// 2. A dispatch that never opens a turn is parked as blocked(environment)
// after the deadline, with a local alert and its WeChat mirror.
{
  const fixture = await createFixture()
  try {
    const ticketId = await dispatch(fixture, 'please fix the bug')
    assert.equal(fixture.service.reconcileDispatchConfirmations('test'), 0) // not expired yet
    const ticket = expired(fixture.service.store.ticket(ticketId))
    fixture.service.store.save()
    assert.equal(fixture.service.reconcileDispatchConfirmations('test'), 1)
    assert.equal(ticket.status, 'blocked')
    assert.equal(ticket.waitingOn, 'environment')
    assert.match(ticket.blockedReason, /60 秒内未开始执行/)
    const requestId = ticket.attempt.lastRequestId
    assert.ok(ticket.blockedReason.includes(requestId))
    assert.equal(ticket.failure.code, 'dispatch_unconfirmed')
    const alerts = unconfirmed(fixture.service)
    assert.equal(alerts.length, 1)
    assert.equal(alerts[0].payload.ticketId, ticketId)
    assert.ok(alerts[0].payload.note.includes(requestId))
    assert.equal(fixture.service.outbox.all().filter(entry => entry.kind === 'wechat_dispatch_note' && entry.payload.ticketId === ticketId && /60 秒/.test(entry.payload.note)).length, 1)
    // The same expired attempt must not alert twice.
    assert.equal(fixture.service.reconcileDispatchConfirmations('test'), 0)
    assert.equal(unconfirmed(fixture.service).length, 1)
  } finally {
    fixture.cleanup()
  }
}

// 3. Steer injects into the running turn and never emits turn/start, so it is
// confirmed immediately and is never parked by the timeout sweep.
{
  const fixture = await createFixture()
  try {
    fixture.setRunning('session-worker', true)
    const ticketId = await dispatch(fixture, 'one small update', 'steer')
    const ticket = fixture.service.store.ticket(ticketId)
    assert.equal(ticket.status, 'working')
    assert.equal(ticket.attempt.immediate, true)
    assert.equal(typeof ticket.attempt.confirmedAt, 'number')
    expired(ticket)
    fixture.service.store.save()
    assert.equal(fixture.service.reconcileDispatchConfirmations('test'), 0)
    assert.equal(ticket.status, 'working')
    assert.equal(unconfirmed(fixture.service).length, 0)
  } finally {
    fixture.cleanup()
  }
}

// 4. Terminal tickets are never swept.
{
  const fixture = await createFixture()
  try {
    const ticketId = await dispatch(fixture, 'already done elsewhere')
    const finished = fixture.service.store.transitionTicket(ticketId, 'done', { resolution: { summary: 'already complete' } })
    assert.equal(finished.ok, true)
    expired(finished.ticket)
    fixture.service.store.save()
    assert.equal(fixture.service.reconcileDispatchConfirmations('test'), 0)
    assert.equal(fixture.service.store.ticket(ticketId).status, 'done')
    assert.equal(unconfirmed(fixture.service).length, 0)
  } finally {
    fixture.cleanup()
  }
}

// 5. A fresh service over the same ria.json catches an already-expired
// dispatch during startup, without waiting for a new timer.
{
  const stateDir = mkdtempSync(join(tmpdir(), 'dsh-ria-dispatch-'))
  let first
  try {
    first = await createFixture({ stateDir })
    const ticketId = await dispatch(first, 'survives a restart')
    expired(first.service.store.ticket(ticketId))
    first.service.store.save()
    first.cleanup({ keepState: true })
    first = undefined

    const second = await createFixture({ stateDir })
    try {
      await second.service.startup()
      const ticket = second.service.store.ticket(ticketId)
      assert.equal(ticket.status, 'blocked')
      assert.equal(ticket.waitingOn, 'environment')
      assert.equal(ticket.failure.code, 'dispatch_unconfirmed')
      assert.equal(unconfirmed(second.service).length, 1)
    } finally {
      second.cleanup()
    }
  } finally {
    if (first) first.cleanup({ keepState: true })
    rmSync(stateDir, { recursive: true, force: true })
  }
}

console.log('dispatch-confirm ok')
