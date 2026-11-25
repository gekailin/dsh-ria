import assert from 'node:assert/strict'
import { createFixture } from './support/ria-fixture.mjs'

// Three attribution races for Ria steer:
// 1) T1 turn/end before settlement + steer owned by T1 -> defer settlement.
// 2) T1 done + executor idle + late steer -> drop, notify Chat, no reopen.
// 3) T1 done + executor running T2 + stale steer -> strip, T2 stays clean.
// All paths emit steer.dropped_stale except the deferral path.

const tick = () => new Promise(resolve => setTimeout(resolve, 0))

async function setup() {
  const fixture = await createFixture({ state: true })
  const controller = fixture.service.controller
  const chat = controller.state.chatSessionId
  const executor = (await controller.ensureExecutor('global')).sessionId
  const working = (id, executorId = executor) => fixture.service.store.addTicket({
    status: 'working', waitingOn: 'executor', executor: executorId, goal: 'ticket ' + id, acceptance: 'x',
  })
  const done = (id, executorId = executor) => fixture.service.store.addTicket({
    status: 'done', waitingOn: 'none', executor: executorId, goal: 'ticket ' + id, acceptance: 'x',
  })
  const setMeta = ticketId => controller.state.setTicketMeta(ticketId, { phase: 'working', executorId: executor })
  const events = () => fixture.service.routerEvents.query({ limit: 500 }).events
  const fakeInbox = (messages = []) => {
    const inbox = {
      nextStep: messages.map(message => ({ ...message })),
      nextTurn: [],
      remove(id) {
        const index = this.nextStep.findIndex(message => message.id === id)
        if (index < 0) return false
        this.nextStep.splice(index, 1)
        return true
      },
    }
    return inbox
  }
  return { fixture, controller, chat, executor, working, done, setMeta, events, fakeInbox }
}

// 1) T1's steer is pending in the live inbox when turn/end arrives: settlement
// must wait, and the next turn/end settles the original done report.
{
  const h = await setup()
  try {
    const ticket = h.working('defer')
    h.setMeta(ticket.ticketId)
    h.controller.state.addReport({
      reportId: 'report_defer', ticketId: ticket.ticketId, executorId: h.executor,
      status: 'done', summary: 'finished', evidence: ['test'], question: '', at: Date.now(),
    })
    const inbox = h.fakeInbox([{
      id: 'msg_steer_t1', role: 'user', content: [{ type: 'text', text: 'steer stays in T1' }],
      source: { kind: 'user', rpcId: 'ria_steer_defer', ticketId: ticket.ticketId },
    }])
    const originalResolve = h.fixture.ctx.sessionController.resolveAgent.bind(h.fixture.ctx.sessionController)
    h.fixture.ctx.sessionController.resolveAgent = async id => String(id) === h.executor
      ? { agent: { id: h.executor, inbox, steer() {} } }
      : originalResolve(id)
    try {
      const first = await h.controller.settleCompletedTurn(
        h.fixture.service.store.ticket(ticket.ticketId), h.executor,
        { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
      )
      assert.equal(first.settled, false)
      assert.equal(first.reason, 'pending_steer')
      assert.equal(h.fixture.service.store.ticket(ticket.ticketId).status, 'working', 'T1 stays open for its steer')
      assert.ok(h.events().some(event => event.event === 'steer.settlement.deferred' && event.ticketId === ticket.ticketId))
      assert.equal(h.events().some(event => event.event === 'steer.dropped_stale' && event.ticketId === ticket.ticketId), false)
      inbox.remove('msg_steer_t1')
      const second = await h.controller.settleCompletedTurn(
        h.fixture.service.store.ticket(ticket.ticketId), h.executor,
        { type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } },
      )
      assert.equal(second.ok, true)
      assert.equal(second.status, 'done', JSON.stringify(second))
    } finally {
      h.fixture.ctx.sessionController.resolveAgent = originalResolve
    }
    console.log('steer race 1: deferred settlement ok')
  } finally { h.fixture.cleanup() }
}

// 2) T1 is already done and the Executor is idle. The late steer is dropped,
// Chat is told, no new turn/ticket is created, and no done->working reopen.
{
  const h = await setup()
  try {
    const ticket = h.done('idle-late')
    h.setMeta(ticket.ticketId)
    h.fixture.setRunning(h.executor, false)
    const beforeExecutorPrompts = h.fixture.prompts.filter(prompt => prompt.sessionId === h.executor).length
    const beforeSteers = h.fixture.steered.length
    const beforeTickets = h.fixture.service.store.tickets().length
    const result = await h.fixture.callAs(h.chat, 'ria_chat_steer', { ticketId: ticket.ticketId, message: 'too late for T1' })
    assert.equal(result.ok, false, JSON.stringify(result))
    assert.equal(result.dropped, true)
    assert.equal(result.code, 'ticket_closed')
    assert.equal(h.fixture.service.store.ticket(ticket.ticketId).status, 'done', 'closed ticket is never reopened')
    assert.equal(h.fixture.service.store.tickets().length, beforeTickets, 'no new ticket')
    assert.deepEqual(h.controller.state.pendingInbox(ticket.ticketId, h.executor), [], 'no inbox queue entry')
    const newSteers = h.fixture.steered.slice(beforeSteers)
    assert.equal(newSteers.filter(message => String(message.source && message.source.rpcId || '').startsWith('ria_steer_')).length, 0, 'no native steer injected')
    assert.equal(h.fixture.prompts.filter(prompt => prompt.sessionId === h.executor).length, beforeExecutorPrompts, 'no host turn is started for the stale steer')
    assert.ok(newSteers.some(message => String(message.content && message.content[0] && message.content[0].text || '').includes('steer 未投递')), 'Chat notice sent')
    const dropped = h.events().filter(event => event.event === 'steer.dropped_stale' && event.ticketId === ticket.ticketId)
    assert.equal(dropped.length, 1, JSON.stringify(dropped))
    assert.equal(dropped[0].reason, 'ticket_closed')
    console.log('steer race 2: late steer dropped ok')
  } finally { h.fixture.cleanup() }
}

// 3) T1 is done while the Executor runs T2. A late steer for T1 is dropped, and
// a stale T1 steer already waiting in the live/inbox is stripped at pre-step so
// T2's step never receives it.
{
  const h = await setup()
  try {
    const t1 = h.done('t1-done')
    const t2 = h.working('t2-running')
    h.controller.state.setTicketMeta(t2.ticketId, { phase: 'working', executorId: h.executor })
    h.controller.state.addExecutor(h.executor, { status: 'working', currentTicketId: t2.ticketId })
    // Late steer addressed at T1 while the executor owns T2.
    const late = await h.fixture.callAs(h.chat, 'ria_chat_steer', { ticketId: t1.ticketId, message: 'late T1 text' })
    assert.equal(late.ok, false, JSON.stringify(late))
    assert.equal(late.dropped, true)
    assert.equal(h.fixture.service.store.ticket(t1.ticketId).status, 'done')
    assert.ok(h.events().some(event => event.event === 'steer.dropped_stale' && event.ticketId === t1.ticketId && event.reason === 'ticket_closed'))
    // A stale T1 steer already queued before T1 closed: one native message in
    // the live inbox plus one manager-inbox entry. Pre-step must strip both.
    const inbox = h.fakeInbox([{
      id: 'msg_stale_t1', role: 'user', content: [{ type: 'text', text: 'stale native T1 text' }],
      source: { kind: 'user', rpcId: 'ria_steer_stale', ticketId: t1.ticketId },
    }])
    h.controller.addManagerInbox(t1.ticketId, h.executor, 'stale manager T1 text', h.chat, 'steer')
    const originalResolve = h.fixture.ctx.sessionController.resolveAgent.bind(h.fixture.ctx.sessionController)
    h.fixture.ctx.sessionController.resolveAgent = async id => String(id) === h.executor
      ? { agent: { id: h.executor, inbox, steer() {} } }
      : originalResolve(id)
    try {
      const fakeAgent = { id: h.executor, inbox, steer() {} }
      const decision = await h.controller.onPreStep({ agent: fakeAgent, turn: 1, step: 1 },
        async () => ({ kind: 'enter', messages: [] }))
      assert.equal(decision.kind, 'enter')
      assert.equal(JSON.stringify(decision.messages).includes('stale native T1 text'), false, 'native stale steer not injected')
      assert.equal(JSON.stringify(decision.messages).includes('stale manager T1 text'), false, 'manager stale steer not injected')
      assert.equal(inbox.nextStep.length, 0, 'native stale message removed')
      assert.deepEqual(h.controller.state.pendingInbox(t1.ticketId, h.executor), [], 'manager stale entry discarded')
      assert.ok(h.events().some(event => event.event === 'steer.dropped_stale' && event.ticketId === t1.ticketId && event.payload.source === 'native_inbox'))
      assert.ok(h.events().some(event => event.event === 'steer.dropped_stale' && event.ticketId === t1.ticketId && event.payload.source === 'manager_inbox'))
    } finally {
      h.fixture.ctx.sessionController.resolveAgent = originalResolve
    }
    console.log('steer race 3: stale steer stripped from T2 ok')
  } finally { h.fixture.cleanup() }
}
