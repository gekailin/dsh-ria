import assert from 'node:assert/strict'
import { createFixture } from './support/ria-fixture.mjs'

const FIXED_REPLY = '请通过 Ria 下达任务。Advisor/Worker 只接受 Ria 派发的工单，直接对话不会被处理。'
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
  ],
})
try {
  const controller = fixture.service.controller
  const chat = fixture.service.controller.state.chatSessionId
  const advisor = await fixture.advisorSession()
  const worker = (await controller.ensureWorker('global')).sessionId
  const reflection = (await controller.ensureReflectionWorker('global')).sessionId
  const sage = (await controller.ensureSage()).sessionId
  const agentOf = id => fixture.agentFor(id)
  const preStep = (id, messages) => controller.onPreStep(
    { agent: agentOf(id), turn: 1 },
    async () => decisionWith(messages),
  )
  const direct = rpcId => message(rpcId)
  const assertBlocked = async (id, fixed = FIXED_REPLY) => {
    const before = fixture.prompts.length
    const result = await preStep(id, [direct('user-' + id)])
    assert.equal(result.messages.length, 1)
    assert.equal(result.messages[0].source.kind, 'ria-task-host')
    assert.ok(result.messages[0].content[0].text.includes(fixed))
    assert.equal(result.messages[0].content[0].text.includes('run this direct command'), false)
    assert.equal(fixture.prompts.length, before, 'interception must not notify Chat')
  }

  assert.equal(fixture.service.store.settings().blockDirectUserMessages, true)

  // Advisor and managed Worker (including reflection) are Ria-only.
  await assertBlocked(advisor)
  await assertBlocked(worker)
  await assertBlocked(reflection)
  await assertBlocked(sage, SAGE_REPLY)

  // Sage also rejects direct input; host_ injection is allowed.
  {
    const input = [direct('user-sage-direct')]
    const result = await preStep(sage, input)
    assert.ok(result.messages[0].content[0].text.includes(SAGE_REPLY))
    const hostInput = [message('host_sage', 'internal proposal', 'user')]
    assert.equal((await preStep(sage, hostInput)).messages, hostInput)
  }

  // A host_ prompt passes through unchanged.
  {
    const input = [message('host_startup', 'continue the ticket')]
    const result = await preStep(worker, input)
    assert.equal(result.messages, input)
  }

  // waitingOn=user: the user must be able to answer the clarification.
  {
    const ticket = fixture.service.store.addTicket({
      status: 'blocked',
      executor: worker,
      waitingOn: 'user',
      blockedReason: 'need a clarification',
    })
    const input = [direct('user-waiting')]
    const result = await preStep(worker, input)
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
    assert.equal((await preStep(worker, input)).messages, input)
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
    assert.equal((await preStep(worker, replyInput)).messages, replyInput)
    const systemInput = [message('sys-1', 'system note', 'system')]
    assert.equal((await preStep(worker, systemInput)).messages, systemInput)
  }

  await settle()
  console.log('state direct user prompt ok')
} finally {
  fixture.cleanup()
}
