import assert from 'node:assert/strict'
import { createFixture } from './support/ria-fixture.mjs'
import { STUCK_LAST_EVENT_MINUTES, computeTicketHealth } from '../lib/core/ticket-health.mjs'

// A Worker turn can end abnormally (LLM idle timeout -> reason.kind=error, a
// user/parent abort -> reason.kind=aborted). Before this fix `turn/end` only
// looked at the ticket binding, so the ticket stayed working forever with no
// blocked state, no event and no notification. These tests pin the four
// required effects plus the shared stuck-detection fields.

const flush = () => new Promise(resolve => setTimeout(resolve, 0))

const promptText = prompt => (Array.isArray(prompt && prompt.content) ? prompt.content : [])
  .map(part => part && part.type === 'text' ? part.text : '')
  .join('\n')

async function setup() {
  const fixture = await createFixture({ state: true })
  const chat = fixture.service.controller.state.chatSessionId
  return { fixture, chat }
}

// Dispatch through the real path so attempt/worker bindings are production-shaped.
async function dispatch(fixture, chat, goal) {
  const made = await fixture.callAs(chat, 'chat_request', { goal })
  assert.equal(made.ok, true, JSON.stringify(made))
  const advisor = fixture.service.controller.state.advisor('global').sessionId
  const plan = await fixture.callAs(advisor, 'ticket_plan', {
    ticketId: made.ticketId,
    summary: 'do the work',
    steps: ['step one'],
  })
  assert.equal(plan.ok, true, JSON.stringify(plan))
  const sent = await fixture.callAs(advisor, 'ticket_dispatch', { ticketId: made.ticketId })
  assert.equal(sent.ok, true, JSON.stringify(sent))
  return { ticketId: made.ticketId, workerId: sent.workerSessionId }
}

const turnStart = (fixture, workerId, turn) => fixture.service.onSessionEvent(
  { header: { id: workerId } },
  { type: 'turn/start', data: { turn } },
)
const turnEnd = (fixture, workerId, turn, reason) => fixture.service.onSessionEvent(
  { header: { id: workerId } },
  { type: 'turn/end', data: { turn, reason } },
)
const noticesAbout = (fixture, chat, ticketId) => fixture.prompts
  .filter(prompt => String(prompt.sessionId) === chat && promptText(prompt).includes(ticketId))

// 1. reason.kind=error -> blocked(environment), turn_failed, worker released,
//    turn.failed event, exactly one Chat notice.
{
  const { fixture, chat } = await setup()
  try {
    const { ticketId, workerId } = await dispatch(fixture, chat, 'turn error case')
    turnStart(fixture, workerId, 3)
    assert.equal(fixture.service.store.ticket(ticketId).status, 'working')
    turnEnd(fixture, workerId, 3, {
      kind: 'error',
      error: { code: 'idle-timeout', message: 'Did not observe any item or terminal signal within 200000ms' },
    })

    const ticket = fixture.service.store.ticket(ticketId)
    assert.equal(ticket.status, 'blocked')
    assert.equal(ticket.waitingOn, 'environment')
    assert.equal(ticket.failure.code, 'turn_failed')
    assert.equal(ticket.failure.at, ticket.updatedAt)
    assert.match(ticket.blockedReason, /error/)
    assert.match(ticket.blockedReason, /idle-timeout/)
    assert.match(ticket.blockedReason, /200000ms/)
    assert.equal(fixture.service.controller.state.ticketMeta(ticketId).phase, 'blocked')

    const worker = fixture.service.controller.state.worker(workerId)
    assert.equal(worker.status, 'idle')
    assert.equal(worker.currentTicketId, null)
    assert.equal(fixture.service.controller.workerTicketId(worker), null, 'a released worker owns no ticket')
    assert.equal(fixture.service.controller.turnStartedAt.has(workerId), false, 'the turn marker is closed')

    const failed = fixture.service.routerEvents.query({ ticketId }).events.find(item => item.event === 'turn.failed')
    assert.ok(failed, 'turn.failed is written')
    assert.equal(failed.payload.ticketId, ticketId)
    assert.equal(failed.payload.workerId, workerId)
    assert.equal(failed.payload.turnId, 3)
    assert.equal(failed.payload.kind, 'error')
    assert.match(failed.payload.detail, /200000ms/)
    assert.equal(failed.payload.blocked, true)
    assert.equal(failed.payload.failureCode, 'turn_failed')

    await flush()
    const notices = noticesAbout(fixture, chat, ticketId)
    assert.equal(notices.length, 1, 'the Chat is told exactly once')
    assert.match(promptText(notices[0]), /error/)
    assert.match(promptText(notices[0]), /200000ms/)

    // The very same event must not block twice or notify twice.
    turnEnd(fixture, workerId, 3, { kind: 'error', error: { message: 'late duplicate' } })
    await flush()
    assert.equal(fixture.service.store.ticket(ticketId).status, 'blocked')
    assert.equal(noticesAbout(fixture, chat, ticketId).length, 1)
  } finally {
    fixture.cleanup()
  }
}

// 2. reason.kind=aborted -> blocked(environment), turn_aborted, same four effects.
{
  const { fixture, chat } = await setup()
  try {
    const { ticketId, workerId } = await dispatch(fixture, chat, 'turn aborted case')
    turnStart(fixture, workerId, 7)
    turnEnd(fixture, workerId, 7, { kind: 'aborted', reason: { kind: 'user' } })

    const ticket = fixture.service.store.ticket(ticketId)
    assert.equal(ticket.status, 'blocked')
    assert.equal(ticket.waitingOn, 'environment')
    assert.equal(ticket.failure.code, 'turn_aborted')
    assert.match(ticket.blockedReason, /aborted\(user\)/)
    assert.equal(fixture.service.controller.state.worker(workerId).status, 'idle')
    assert.equal(fixture.service.controller.state.worker(workerId).currentTicketId, null)

    const failed = fixture.service.routerEvents.query({ ticketId }).events.find(item => item.event === 'turn.failed')
    assert.ok(failed)
    assert.equal(failed.payload.kind, 'aborted')
    assert.equal(failed.payload.failureCode, 'turn_aborted')
    await flush()
    assert.equal(noticesAbout(fixture, chat, ticketId).length, 1)
  } finally {
    fixture.cleanup()
  }
}

// 3. An unknown/other kind is still abnormal: turn_failed and the original
//    kind is kept in the reason so the cause is not lost.
{
  const { fixture, chat } = await setup()
  try {
    const { ticketId, workerId } = await dispatch(fixture, chat, 'turn unknown case')
    turnStart(fixture, workerId, 2)
    turnEnd(fixture, workerId, 2, { kind: 'max-tokens' })

    const ticket = fixture.service.store.ticket(ticketId)
    assert.equal(ticket.status, 'blocked')
    assert.equal(ticket.failure.code, 'turn_failed')
    assert.match(ticket.blockedReason, /max-tokens/)
    const failed = fixture.service.routerEvents.query({ ticketId }).events.find(item => item.event === 'turn.failed')
    assert.equal(failed.payload.kind, 'max-tokens')
    assert.equal(failed.payload.failureCode, 'turn_failed')
  } finally {
    fixture.cleanup()
  }
}

// 4. Regression: a completed turn keeps the pre-fix behaviour exactly:
//    ticket working, worker still bound, no turn.failed, no notification.
{
  const { fixture, chat } = await setup()
  try {
    const { ticketId, workerId } = await dispatch(fixture, chat, 'turn completed case')
    turnStart(fixture, workerId, 1)
    turnEnd(fixture, workerId, 1, { kind: 'completed' })

    const ticket = fixture.service.store.ticket(ticketId)
    assert.equal(ticket.status, 'working')
    assert.equal(ticket.waitingOn, 'worker')
    assert.equal(ticket.failure, null)
    const worker = fixture.service.controller.state.worker(workerId)
    assert.equal(worker.status, 'working')
    assert.equal(worker.currentTicketId, ticketId)
    assert.equal(fixture.service.controller.turnStartedAt.has(workerId), false, 'the marker always closes')
    const events = fixture.service.routerEvents.query({ ticketId }).events
    assert.equal(events.some(item => item.event === 'turn.failed'), false)
    await flush()
    assert.equal(noticesAbout(fixture, chat, ticketId).length, 0)
  } finally {
    fixture.cleanup()
  }
}

// 5. computeTicketHealth boundaries. Pure function, fixed clock.
{
  const lastEventAt = 1_000_000
  const ticket = { status: 'working', executor: 'session-w', createdAt: lastEventAt, updatedAt: lastEventAt, progress: { lastEventAt } }
  const at = minutes => lastEventAt + minutes * 60000

  assert.equal(STUCK_LAST_EVENT_MINUTES, 10)
  // Exactly 10 minutes of ticket-record silence is not over the threshold; with
  // no session activity known this is the degraded (old) rule.
  assert.deepEqual(computeTicketHealth(ticket, { activeTurn: true, now: at(10) }), {
    activeTurn: true,
    lastEventAgeMinutes: 10,
    sessionLastEventAgeMinutes: null,
    stuckSuspect: false,
    stuckReason: null,
  })
  // 10 minutes + 1 second is: the degraded reason names the ticket record.
  const justOver = computeTicketHealth(ticket, { activeTurn: true, now: at(10) + 1000 })
  assert.equal(justOver.activeTurn, true)
  assert.equal(justOver.lastEventAgeMinutes, 10 + 1 / 60)
  assert.equal(justOver.stuckSuspect, true)
  assert.match(justOver.stuckReason, /工单记录无更新 10\.1 分钟/)
  assert.match(justOver.stuckReason, /阈值 10 分钟/)
  const longTurn = computeTicketHealth(ticket, { activeTurn: true, now: at(155) })
  assert.equal(longTurn.lastEventAgeMinutes, 155)
  assert.equal(longTurn.stuckSuspect, true)
  assert.match(longTurn.stuckReason, /工单记录无更新 155 分钟/)
  assert.equal(computeTicketHealth(ticket, { activeTurn: true, now: at(9) }).stuckSuspect, false)
  assert.equal(computeTicketHealth(ticket, { activeTurn: true, now: at(20), thresholdMinutes: 20 }).stuckSuspect, false)
  assert.equal(computeTicketHealth(ticket, { activeTurn: true, now: at(21), thresholdMinutes: 20 }).stuckSuspect, true)
  // Primary rule: a fresh Worker session means the ticket is advancing, however
  // old the ticket record is. A step-running turn never writes worker_report.
  const sessionFresh = computeTicketHealth(ticket, { activeTurn: true, now: at(60), sessionLastEventAt: at(59) })
  assert.equal(sessionFresh.sessionLastEventAgeMinutes, 1)
  assert.equal(sessionFresh.stuckSuspect, false, 'a live session is never stuck')
  // Both must be stale: a stale session with a fresh ticket record is healthy.
  assert.equal(computeTicketHealth(ticket, { activeTurn: true, now: at(11), sessionLastEventAt: at(0), thresholdMinutes: 10 }).stuckSuspect, false)
  // Session silence > 15 min AND ticket record > 10 min: stuck, and the reason
  // names the session evidence with both clocks.
  const sessionStale = computeTicketHealth(ticket, { activeTurn: true, now: at(60), sessionLastEventAt: at(44) })
  assert.equal(sessionStale.stuckSuspect, true)
  assert.match(sessionStale.stuckReason, /会话无事件 16 分钟/)
  assert.match(sessionStale.stuckReason, /阈值 15 分钟/)
  assert.match(sessionStale.stuckReason, /工单记录无更新 60 分钟/)
  assert.match(sessionStale.stuckReason, /最后事件 \d{4}-\d{2}-\d{2} \d{2}:\d{2}/)
  assert.match(sessionStale.stuckReason, /最后更新 \d{4}-\d{2}-\d{2} \d{2}:\d{2}/)
  // Exactly 15 minutes of session silence is not over the threshold.
  assert.equal(computeTicketHealth(ticket, { activeTurn: true, now: at(60), sessionLastEventAt: at(45) }).stuckSuspect, false)
  // Working without an active turn is a suspect even with a fresh event.
  const noTurn = computeTicketHealth(ticket, { activeTurn: false, now: at(0) })
  assert.equal(noTurn.stuckSuspect, true)
  assert.match(noTurn.stuckReason, /没有活跃 turn/)
  // Both criteria are reported together.
  const both = computeTicketHealth(ticket, { activeTurn: false, now: at(11) })
  assert.match(both.stuckReason, /没有活跃 turn/)
  assert.match(both.stuckReason, /工单记录无更新/)
  // A blocked ticket is never a stuck suspect, however old.
  const blocked = computeTicketHealth({ ...ticket, status: 'blocked', waitingOn: 'environment' }, { activeTurn: false, now: at(60) })
  assert.equal(blocked.stuckSuspect, false)
  assert.equal(blocked.stuckReason, null)
  const blockedOpenTurn = computeTicketHealth({ ...ticket, status: 'blocked', waitingOn: 'approval' }, { activeTurn: true, now: at(155) })
  assert.equal(blockedOpenTurn.stuckSuspect, false)
  assert.equal(blockedOpenTurn.stuckReason, null)
  // Non-working tickets do not report age-based stuckness either.
  assert.equal(computeTicketHealth({ ...ticket, status: 'open' }, { activeTurn: false, now: at(60) }).stuckSuspect, false)
  // No timestamp at all: age is null and only the turn criterion can fire.
  const empty = computeTicketHealth({ status: 'working', progress: {} }, { activeTurn: false, now: 0 })
  assert.equal(empty.lastEventAgeMinutes, null)
  assert.equal(empty.stuckSuspect, true)
}

// 6. chat_status ticket view and chat_worker_config get agree for the same
//    ticket, both criteria included; status/currentTicketId consistency holds.
{
  const { fixture, chat } = await setup()
  try {
    const { ticketId, workerId } = await dispatch(fixture, chat, 'health views case')
    turnStart(fixture, workerId, 4)

    const viewOf = async () => (await fixture.callAs(chat, 'chat_status', { ticketId })).ticket
    const workerOf = async () => (await fixture.callAs(chat, 'chat_worker_config', { action: 'get' })).workers
      .find(item => item.sessionId === workerId)

    const viewActive = await viewOf()
    const workerActive = await workerOf()
    assert.equal(viewActive.activeTurn, true)
    assert.equal(workerActive.activeTurn, true)
    assert.equal(viewActive.stuckSuspect, false)
    assert.equal(workerActive.stuckSuspect, false)
    assert.equal(viewActive.stuckReason, workerActive.stuckReason)
    assert.ok(Math.abs(viewActive.lastEventAgeMinutes - workerActive.lastEventAgeMinutes) < 0.01)

    // Close the turn marker without touching the ticket: working + no active
    // turn is the exact silent state the fix targets.
    fixture.service.controller.turnStartedAt.delete(workerId)
    const viewStuck = await viewOf()
    const workerStuck = await workerOf()
    assert.equal(viewStuck.status, 'working')
    assert.equal(viewStuck.activeTurn, false)
    assert.equal(viewStuck.stuckSuspect, true)
    assert.match(viewStuck.stuckReason, /没有活跃 turn/)
    assert.equal(workerStuck.activeTurn, viewStuck.activeTurn)
    assert.equal(workerStuck.stuckSuspect, viewStuck.stuckSuspect)
    assert.equal(workerStuck.stuckReason, viewStuck.stuckReason)
    assert.equal(workerStuck.status, 'working')
    assert.equal(workerStuck.currentTicketId, ticketId)
    assert.equal(workerStuck.stateConsistent, true, 'status and currentTicketId stay consistent')

    // The ticket record is 11 minutes old but the Worker session just emitted
    // events (turn/start etc.): the ticket is advancing, not stuck.
    fixture.service.controller.turnStartedAt.set(workerId, Date.now())
    const idleSince = Date.now() - 11 * 60000
    const stored = fixture.service.store.ticket(ticketId)
    stored.progress.lastEventAt = idleSince
    stored.updatedAt = idleSince
    fixture.service.store.save()
    const viewFresh = await viewOf()
    assert.equal(viewFresh.activeTurn, true)
    assert.equal(viewFresh.stuckSuspect, false, 'a live Worker session is never stuck')
    assert.equal(viewFresh.stuckReason, null)
    // Drop the session signal: the degraded path uses the ticket record alone.
    fixture.service.controller.sessionLastEventAt.delete(workerId)
    const viewOld = await viewOf()
    const workerOld = await workerOf()
    assert.equal(viewOld.activeTurn, true)
    assert.equal(viewOld.stuckSuspect, true)
    assert.match(viewOld.stuckReason, /工单记录无更新/)
    assert.equal(workerOld.stuckSuspect, viewOld.stuckSuspect)
    // The age text advances between the two reads; the criterion, the verdict
    // and the age itself (within milliseconds) must still agree.
    assert.match(workerOld.stuckReason, /工单记录无更新/)
    assert.ok(Math.abs(workerOld.lastEventAgeMinutes - viewOld.lastEventAgeMinutes) < 0.01)

    // A blocked ticket is not a stuck suspect even with an old event.
    turnEnd(fixture, workerId, 4, { kind: 'error', error: { message: 'boom' } })
    const viewBlocked = await viewOf()
    const workerBlocked = await workerOf()
    assert.equal(viewBlocked.status, 'blocked')
    assert.equal(viewBlocked.stuckSuspect, false)
    assert.equal(workerBlocked.stuckSuspect, false)
    assert.equal(workerBlocked.status, 'idle')
    assert.equal(workerBlocked.currentTicketId, null)
    assert.equal(workerBlocked.stateConsistent, true)
  } finally {
    fixture.cleanup()
  }
}

console.log('state turn failure ok')
