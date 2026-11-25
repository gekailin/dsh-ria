import assert from 'node:assert/strict'
import { createFixture } from './support/ria-fixture.mjs'

// Ria-origin injection namespaces must be distinguishable:
// forward -> ria_forward_, steer -> ria_steer_, host guards -> ria_ (not user).

const tick = () => new Promise(resolve => setTimeout(resolve, 0))
const fixture = await createFixture({
  state: true,
  extraSessions: [{ sessionId: 'session-rpc-forward', running: false, blank: false, updatedAt: 1, cwd: '/work/rpc', projections: { values: { title: 'RPC Forward' } } }],
})
try {
  const controller = fixture.service.controller
  const chat = controller.state.chatSessionId
  const events = () => fixture.service.routerEvents.query({ limit: 300 }).events

  // 1) Direct forward uses the ria_forward_ namespace end to end.
  const forwarded = await fixture.callAs(chat, 'ria_chat_forward', { sessionId: 'session-rpc-forward', content: 'forward body' })
  assert.equal(forwarded.ok, true, JSON.stringify(forwarded))
  assert.match(forwarded.rpcId, /^ria_forward_/)
  const fwdEvent = events().find(event => event.event === 'forward.sent' && event.sessionId === 'session-rpc-forward')
  assert.ok(fwdEvent)
  assert.equal(fwdEvent.payload.rpcId, forwarded.rpcId)
  const fwdSteer = fixture.steered.at(-1)
  assert.equal(fwdSteer.source.rpcId, forwarded.rpcId)
  assert.equal(fwdSteer.source.kind, 'user')

  // 2) Busy steer merged at pre-step uses ria_steer_ and keeps ticketId.
  const executor = (await controller.ensureExecutor('global')).sessionId
  controller.state.addExecutor(executor, { status: 'idle', currentTicketId: null })
  const ticket = fixture.service.store.addTicket({ status: 'working', executor, goal: 'rpc steer', acceptance: 'x' })
  controller.state.setTicketMeta(ticket.ticketId, { phase: 'working', executorId: executor })
  fixture.setRunning(executor, true)
  const steered = await fixture.callAs(chat, 'ria_chat_steer', { ticketId: ticket.ticketId, message: 'steer body' })
  assert.equal(steered.ok, true, JSON.stringify(steered))
  const decision = await fixture.emit('agent/pre-step', { agent: fixture.agentFor(executor), turn: 1, step: 2 },
    async () => ({ kind: 'enter', messages: [] }))
  assert.equal(decision.messages.length, 1)
  assert.match(decision.messages[0].source.rpcId, /^ria_steer_/)
  assert.equal(decision.messages[0].source.ticketId, ticket.ticketId)

  // 3) The managed-executor direct-user guard is still a Ria namespace message,
  // so it can be told apart from a real user direct message.
  const direct = {
    id: 'msg_direct_rpc', role: 'user', content: [{ type: 'text', text: 'user direct' }],
    source: { kind: 'user', rpcId: 'user-rpc-1' },
  }
  const guarded = await fixture.emit('agent/pre-step', { agent: fixture.agentFor(executor), turn: 1, step: 3 },
    async () => ({ kind: 'enter', messages: [direct] }))
  assert.equal(guarded.messages.length, 1)
  assert.equal(guarded.messages[0].source.kind, 'ria-task-host')
  assert.match(guarded.messages[0].source.rpcId, /^ria_/)
  console.log('rpc prefixes ok')
} finally {
  fixture.cleanup()
}
