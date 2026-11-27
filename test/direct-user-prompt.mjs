import assert from 'node:assert/strict'
import { createFixture } from './support/ria-fixture.mjs'

const FIXED_REPLY = '请通过 Ria 下达任务。Advisor/Executor 只接受 Ria 派发的工单，直接对话不会被处理。'
const SAGE_REPLY = '请通过 Ria 与 Sage 交互。Sage 只接受 Ria/Sage 内部提案，直接对话不会被处理。'
const message = (rpcId, text = 'run this direct command', kind = 'user') => ({
  id: 'msg_' + rpcId,
  role: 'user',
  content: [{ type: 'text', text }],
  source: { kind, rpcId },
})
const decisionWith = messages => ({ kind: 'enter', messages })
const settle = () => new Promise(resolve => setTimeout(resolve, 20))

const fixture = await createFixture({
  stateDefault: true,
  extraSessions: [
    { sessionId: 'session-independent', running: false, blank: false, updatedAt: 10, cwd: '/tmp', projections: { values: { title: 'Independent' } } },
    { sessionId: 'session-cm-direct', running: false, blank: false, updatedAt: 10, cwd: '/tmp', projections: { values: { title: 'Co-managed direct' } } },
  ],
})
try {
  const controller = fixture.service.controller
  const chat = fixture.service.controller.state.chatSessionId
  const advisor = await fixture.advisorSession()
  const executor = (await controller.ensureExecutor('global')).sessionId
  const reflection = (await controller.ensureReflectionExecutor('global')).sessionId
  const sage = (await controller.ensureSage()).sessionId
  const coManaged = 'session-cm-direct'
  const registered = await fixture.callAs(chat, 'ria_chat_co_manage', {
    action: 'add', sessionId: coManaged, cwd: '/tmp', allowDispatch: false,
  })
  assert.equal(registered.ok, true, JSON.stringify(registered))
  // Co-managed is the user's own context: installing its executor role must not
  // add the managed Executor prompt or the ria_executor_report tool.
  controller.install(fixture.agentFor(coManaged), 'executor')
  assert.equal(fixture.assembleSystemPrompt(coManaged), '')
  assert.equal(fixture.visibleTools(coManaged).includes('ria_executor_report'), false)
  // Managed Executor keeps its direct prompt and report tool.
  assert.match(fixture.assembleSystemPrompt(executor), /你是直管 Executor/)
  assert.equal(fixture.visibleTools(executor).includes('ria_executor_report'), true)
  const agentOf = id => fixture.agentFor(id)
  const preStep = (id, messages) => controller.onPreStep(
    { agent: agentOf(id), turn: 1 },
    async () => decisionWith(messages),
  )
  const direct = rpcId => message(rpcId)
  const assertBlocked = async (id, fixed = FIXED_REPLY) => {
    const before = fixture.prompts.length
    const beforeEvents = fixture.service.routerEvents.query({ limit: 200 }).events.length
    const result = await preStep(id, [direct('user-' + id)])
    // Zero-LLM, zero-surface-write block: empty messages array closes turn cleanly.
    assert.equal(result.kind, 'enter')
    assert.deepEqual(result.messages, [])
    assert.equal(fixture.prompts.length, before, 'interception must not notify Chat')
    const events = fixture.service.routerEvents.query({ limit: 200 }).events
    assert.ok(events.length > beforeEvents, 'direct_user.blocked audit event recorded')
    const latest = events.filter(item => item.event === 'direct_user.blocked' && item.sessionId === id).at(-1)
    assert.ok(latest, 'direct_user.blocked event present for ' + id)
    assert.equal(latest.payload.hint, fixed)
    assert.equal(latest.payload.excerpt, 'run this direct command')
  }

  assert.equal(fixture.service.store.settings().blockDirectUserMessages, true)

  // Advisor and managed Executor (including reflection) are Ria-only.
  await assertBlocked(advisor)
  await assertBlocked(executor)
  await assertBlocked(reflection)
  await assertBlocked(sage, SAGE_REPLY)

  // directUserGuardsSnapshot matches the exact same guard predicate (used by
  // GET /plugins/dsh-ria/api/session-guards for conversation.composer takeover).
  {
    const snap = controller.directUserGuardsSnapshot()
    assert.equal(snap.riaSessionId, chat)
    assert.equal(snap.sessions[advisor]?.role, 'advisor')
    assert.equal(snap.sessions[executor]?.role, 'executor')
    assert.equal(snap.sessions[reflection]?.role, 'executor')
    assert.equal(snap.sessions[sage]?.role, 'sage')
    assert.equal(snap.sessions[sage]?.hint, SAGE_REPLY)
    assert.equal(snap.sessions[coManaged], undefined, 'co-managed must never be composer-blocked')
    assert.equal(snap.sessions[chat], undefined, 'chat must never be composer-blocked')
  }

  // Co-managed sessions are user-owned: direct user messages are normal input.
  {
    const input = [direct('user-cm-direct')]
    const result = await preStep(coManaged, input)
    assert.deepEqual(result.messages, input, 'co-managed user message must pass through')
    assert.equal(result.messages[0].source.kind, 'user')
    assert.equal(fixture.service.controller.state.executor(coManaged).status, 'idle')
    assert.equal(fixture.service.controller.state.executor(coManaged).currentTicketId, null)
  }

  // Sage also rejects direct input with zero model call; host_ injection is allowed.
  {
    const input = [direct('user-sage-direct')]
    const result = await preStep(sage, input)
    assert.deepEqual(result.messages, [])
    const hostInput = [message('host_sage', 'internal proposal', 'user')]
    assert.equal((await preStep(sage, hostInput)).messages, hostInput)
  }

  // A host_ prompt passes through unchanged.
  {
    const input = [message('host_startup', 'continue the ticket')]
    const result = await preStep(executor, input)
    assert.equal(result.messages, input)
  }

  // Ria steer/forward injections carry explicit source kinds and pass the
  // direct-user guard for both managed and co-managed targets. A plain user
  // message still gets blocked (messages: []) on a managed executor.
  for (const id of [executor, coManaged]) {
    const injected = [message('ria_injected', 'injected by Ria', 'user')]
    assert.equal((await preStep(id, injected)).messages, injected, 'rpcId ria_ injection must pass for ' + id)
    const afterDirect = await preStep(id, [direct('user-' + id)])
    if (id === coManaged) {
      assert.equal(afterDirect.messages[0].source.kind, 'user')
    } else {
      assert.deepEqual(afterDirect.messages, [])
    }
  }

  // Hijacked turn settlement guard: a direct user message during an active
  // working ticket returns messages: [] AND does not park the ticket as empty_turn.
  {
    const workingTicket = fixture.service.store.addTicket({
      status: 'working',
      executor: executor,
      waitingOn: 'executor',
      goal: 'active task must survive direct message',
    })
    controller.state.setTicketMeta(workingTicket.ticketId, { phase: 'working', executorId: executor })
    controller.state.addExecutor(executor, { status: 'working', currentTicketId: workingTicket.ticketId })
    const hijacked = await controller.onPreStep(
      { agent: agentOf(executor), turn: 9 },
      async () => decisionWith([direct('user-mid-ticket')]),
    )
    assert.deepEqual(hijacked.messages, [])
    const settled = await controller.settleCompletedTurn(
      fixture.service.store.ticket(workingTicket.ticketId),
      executor,
      { type: 'turn/end', data: { turn: 9, reason: { kind: 'completed' } } },
    )
    assert.equal(settled.settled, false)
    assert.equal(settled.reason, 'hijacked_turn')
    assert.equal(fixture.service.store.ticket(workingTicket.ticketId).status, 'working', 'working ticket stays working')
    // Cleanup ticket for subsequent assertions.
    fixture.service.store.transitionTicket(workingTicket.ticketId, 'cancelled', { actor: 'user', resolution: { kind: 'cancelled', reason: 'cleanup' }, reason: 'cleanup' })
    controller.state.addExecutor(executor, { status: 'idle', currentTicketId: null })
  }

  // waitingOn=user: the user must be able to answer the clarification.
  {
    const ticket = fixture.service.store.addTicket({
      status: 'blocked',
      executor: executor,
      waitingOn: 'user',
      blockedReason: 'need a clarification',
    })
    const input = [direct('user-waiting')]
    const result = await preStep(executor, input)
    assert.equal(result.messages, input)
    assert.equal(fixture.service.store.ticket(ticket.ticketId).status, 'blocked')
    assert.equal(fixture.service.store.ticket(ticket.ticketId).waitingOn, 'user')
  }

  // Advisor waitingOn=user uses the 'advisor' executor role.
  {
    const ticket = fixture.service.store.addTicket({
      status: 'blocked',
      executor: 'advisor',
      waitingOn: 'user',
      blockedReason: 'need a clarification',
    })
    const input = [direct('user-advisor-waiting')]
    const result = await preStep(advisor, input)
    assert.equal(result.messages, input)
    assert.equal(fixture.service.store.ticket(ticket.ticketId).waitingOn, 'user')
  }

  // Switch off: original behavior.
  fixture.service.store.setSettings({ blockDirectUserMessages: false })
  {
    const input = [direct('user-switch-off')]
    assert.equal((await preStep(executor, input)).messages, input)
    assert.equal((await preStep(sage, input)).messages, input)
  }
  fixture.service.store.setSettings({ blockDirectUserMessages: true })

  // Chat and ordinary independent sessions are untouched.
  {
    const chatInput = [direct('user-to-chat')]
    assert.equal((await preStep(chat, chatInput)).messages, chatInput)
    const independentInput = [direct('user-to-independent')]
    assert.equal((await preStep('session-independent', independentInput)).messages, independentInput)
  }

  // Non-user source and non-host user source pass through.
  {
    const replyInput = [message('reply-1', 'answer', 'user-question-reply')]
    assert.equal((await preStep(executor, replyInput)).messages, replyInput)
    const systemInput = [message('sys-1', 'system note', 'system')]
    assert.equal((await preStep(executor, systemInput)).messages, systemInput)
  }

  // Every prompt minted by dsh-ria now uses the ria_ namespace.
  {
    const before = fixture.prompts.length
    await controller.promptSession(executor, 'prefix probe')
    assert.equal(fixture.prompts.length, before + 1)
    assert.match(fixture.prompts.at(-1).requestId, /^ria_/)
  }

  await settle()
  console.log('state direct user prompt ok')
} finally {
  fixture.cleanup()
}