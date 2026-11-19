import assert from 'node:assert/strict'
import { createFixture } from './support/ria-fixture.mjs'

const FIXED_REPLY = '请通过 Ria 下达任务。Advisor/Worker 只接受 Ria 派发的工单，直接对话不会被处理。'
const message = (rpcId, text = 'run this direct command', kind = 'user') => ({
  id: 'msg_' + rpcId,
  role: 'user',
  content: [{ type: 'text', text }],
  source: { kind, rpcId },
})
const decisionWith = messages => ({ kind: 'enter', messages })
const settle = () => new Promise(resolve => setTimeout(resolve, 20))

const fixture = await createFixture({
  v2Default: true,
  extraSessions: [
    { sessionId: 'session-independent', running: false, blank: false, updatedAt: 10, cwd: '/tmp', projections: { values: { title: 'Independent' } } },
  ],
})
try {
  const controller = fixture.service.v2
  const chatbot = fixture.service.v2.v2.chatbotSessionId
  const advisor = (await controller.ensureAdvisor('global')).sessionId
  const worker = (await controller.ensureWorker('global')).sessionId
  const reflection = (await controller.ensureReflectionWorker('global')).sessionId
  const agentOf = id => fixture.agentFor(id)
  const preStep = (id, messages) => controller.onPreStep(
    { agent: agentOf(id), turn: 1 },
    async () => decisionWith(messages),
  )
  const direct = rpcId => message(rpcId)
  const assertBlocked = async id => {
    const before = fixture.prompts.length
    const result = await preStep(id, [direct('user-' + id)])
    assert.equal(result.messages.length, 1)
    assert.equal(result.messages[0].source.kind, 'ria-task-host')
    assert.ok(result.messages[0].content[0].text.includes(FIXED_REPLY))
    assert.equal(result.messages[0].content[0].text.includes('run this direct command'), false)
    assert.equal(fixture.prompts.length, before, 'interception must not notify Chatbot')
  }

  assert.equal(fixture.service.store.settings().blockDirectUserMessages, true)

  // Advisor and managed Worker (including reflection) are Ria-only.
  await assertBlocked(advisor)
  await assertBlocked(worker)
  await assertBlocked(reflection)

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
    const result = await preStep(worker, input)
    assert.equal(result.messages, input)
  }
  fixture.service.store.setSettings({ blockDirectUserMessages: true })

  // Chatbot and ordinary independent sessions are untouched.
  {
    const chatbotInput = [direct('user-to-chatbot')]
    assert.equal((await preStep(chatbot, chatbotInput)).messages, chatbotInput)
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
  console.log('v2 direct user prompt ok')
} finally {
  fixture.cleanup()
}
