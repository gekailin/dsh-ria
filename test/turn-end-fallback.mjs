import assert from 'node:assert/strict'
import { createFixture } from './support/ria-fixture.mjs'

const tick = () => new Promise(resolve => setTimeout(resolve, 0))

function stubAssistant(sc, sessionId, text, turn = 1) {
  const original = sc.events.bind(sc)
  sc.events = async request => {
    const id = request && request.address ? String(request.address.sessionId) : ''
    if (id !== sessionId) return await original(request)
    return {
      records: [{
        type: 'event',
        event: { type: 'assistant/message', seq: 1, at: 1, data: { turn, message: { content: [{ type: 'text', text }] } } },
      }],
      hasMore: false,
      cursor: 1,
    }
  }
  return () => { sc.events = original }
}

async function setup() {
  const fixture = await createFixture({ stateDefault: true, extraSessions: [{ sessionId: 'session-cm-fallback', running: false, blank: false, updatedAt: 1, cwd: '/work/cm', projections: { values: { title: 'CM Fallback' } } }] })
  const controller = fixture.service.controller
  const executor = (await controller.ensureExecutor('global')).sessionId
  const chat = controller.state.chatSessionId
  return { fixture, controller, executor, chat }
}

// 1) No report + final assistant text -> done with that text as the report.
{
  const { fixture, controller, executor } = await setup()
  try {
    const ticket = fixture.service.store.addTicket({ status: 'working', executor, goal: 'fallback done', acceptance: 'x' })
    controller.state.setTicketMeta(ticket.ticketId, { phase: 'working', executorId: executor })
    const restore = stubAssistant(fixture.ctx.sessionController, executor, 'final fallback answer')
    try {
      const result = await controller.settleCompletedTurn(ticket, executor, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
      assert.equal(result.ok, true, JSON.stringify(result))
      assert.equal(result.status, 'done')
      assert.equal(fixture.service.store.ticket(ticket.ticketId).status, 'done')
      const report = controller.state.reportsFor(ticket.ticketId, 10).at(-1)
      assert.equal(report.status, 'done')
      assert.equal(report.summary, 'final fallback answer')
      assert.equal(report.fallback, 'turn_end')
      assert.ok(fixture.service.routerEvents.query({ ticketId: ticket.ticketId }).events.some(event => event.event === 'ticket.fallback_settled'))
    } finally { restore() }
    console.log('turn/end fallback done ok')
  } finally { fixture.cleanup() }
}

// 2) Progress-only then turn/end still settles done from the final text
// (cog_225: the progress report never wins over settlement).
{
  const { fixture, controller, executor } = await setup()
  try {
    const ticket = fixture.service.store.addTicket({ status: 'working', executor, goal: 'progress fallback', acceptance: 'x' })
    controller.state.setTicketMeta(ticket.ticketId, { phase: 'working', executorId: executor })
    controller.state.addReport({ reportId: 'r_progress', ticketId: ticket.ticketId, executorId: executor, status: 'progress', summary: 'still going', evidence: [], question: '', at: Date.now() })
    const restore = stubAssistant(fixture.ctx.sessionController, executor, 'progress turn final text', 2)
    try {
      const result = await controller.settleCompletedTurn(ticket, executor, { type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } })
      assert.equal(result.status, 'done')
      assert.equal(controller.state.reportsFor(ticket.ticketId, 10).at(-1).summary, 'progress turn final text')
    } finally { restore() }
    console.log('turn/end progress fallback ok')
  } finally { fixture.cleanup() }
}

// 3) Nothing to settle -> blocked(empty_turn), not blocked(no_report).
{
  const { fixture, controller, executor } = await setup()
  try {
    const ticket = fixture.service.store.addTicket({ status: 'working', executor, goal: 'empty turn', acceptance: 'x' })
    controller.state.setTicketMeta(ticket.ticketId, { phase: 'working', executorId: executor })
    const result = await controller.settleCompletedTurn(ticket, executor, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
    assert.equal(result.status, 'blocked')
    assert.equal(result.empty_turn, true)
    assert.equal(fixture.service.store.ticket(ticket.ticketId).blockedReason.includes('without a report or assistant text'), true)
  } finally { fixture.cleanup() }
}

// 4) A terminal done report plus a trailing progress still settles done.
{
  const { fixture, controller, executor } = await setup()
  try {
    const ticket = fixture.service.store.addTicket({ status: 'working', executor, goal: 'done then progress', acceptance: 'x' })
    controller.state.setTicketMeta(ticket.ticketId, { phase: 'working', executorId: executor })
    controller.state.addReport({ reportId: 'r_done', ticketId: ticket.ticketId, executorId: executor, status: 'done', summary: 'terminal done', evidence: ['exit 0'], question: '', at: Date.now() })
    controller.state.addReport({ reportId: 'r_tail', ticketId: ticket.ticketId, executorId: executor, status: 'progress', summary: 'late progress', evidence: [], question: '', at: Date.now() + 1 })
    const result = await controller.settleCompletedTurn(ticket, executor, { type: 'turn/end', data: { turn: 3, reason: { kind: 'completed' } } })
    assert.equal(result.status, 'done')
    assert.equal(fixture.service.store.ticket(ticket.ticketId).status, 'done')
    console.log('terminalOnly done wins ok')
  } finally { fixture.cleanup() }
}

// 5) Co-managed dual track: with a working ticket the assistant reply is
// Executor evidence, not a watch relay; after done the same session relays.
{
  const { fixture, controller, executor, chat } = await setup()
  try {
    const added = await fixture.callAs(chat, 'ria_chat_co_manage', { action: 'add', sessionId: 'session-cm-fallback', allowDispatch: false })
    assert.equal(added.ok, true, JSON.stringify(added))
    const co = 'session-cm-fallback'
    const ticket = fixture.service.store.addTicket({ status: 'working', executor: co, goal: 'co-managed ticket', acceptance: 'x' })
    controller.state.setTicketMeta(ticket.ticketId, { phase: 'working', executorId: co })
    controller.state.addExecutor(co, { status: 'working', currentTicketId: ticket.ticketId })
    const relaysBefore = controller.watchRelayLog.length
    fixture.service.onSessionEvent({ header: { id: co } }, {
      type: 'assistant/message', seq: 2, time: 2,
      data: { turn: 1, message: { content: [{ type: 'text', text: 'co-managed final answer' }] } },
    })
    assert.equal(controller.watchRelayLog.length, relaysBefore, 'ticketed co-managed reply is not relayed')
    assert.ok(controller.state.reportsFor(ticket.ticketId, 10).some(report => report.status === 'progress'), 'assistant text recorded as progress evidence')
    const restore = stubAssistant(fixture.ctx.sessionController, co, 'co-managed final answer')
    try {
      fixture.service.onSessionEvent({ header: { id: co } }, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
      await tick()
      await tick()
      assert.equal(fixture.service.store.ticket(ticket.ticketId).status, 'done', 'turn/end fallback settles the co-managed ticket')
    } finally { restore() }
    const afterDone = controller.watchRelayLog.length
    fixture.service.onSessionEvent({ header: { id: co } }, {
      type: 'assistant/message', seq: 3, time: 3,
      data: { turn: 2, message: { content: [{ type: 'text', text: 'ticket-free reply' }] } },
    })
    await tick()
    await controller.sendWatchRelay(controller.coManagement.watch(co), 'ticket-free reply', {})
    assert.ok(controller.watchRelayLog.length > afterDone, 'ticket-free co-managed reply relays again')
    console.log('co-managed dual track ok')
  } finally { fixture.cleanup() }
}
