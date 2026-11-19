import assert from 'node:assert/strict'
import { join } from 'node:path'
import { createFixture } from './support/ria-fixture.mjs'

// Two dispatch-path defects: archived/deleted Workers must not be selected, and
// an answer-mode Advisor that returns nothing must park the ticket with a
// readable reason instead of a bare "Advisor 不可用".

async function withEvents(fixture) {
  const events = []
  fixture.service.routerEvent = event => { events.push(event) }
  return events
}

// ① Archived Sessions are never selected, even when their binding is newest.
// ② A deleted Session is removed and the next idle Worker is reused.
// ③ The normal reuse path still works.
{
  const fixture = await createFixture({ v2Default: true, archivedSessionIds: ['session-archived'] })
  try {
    const controller = fixture.service.v2
    const store = controller.v2
    const events = await withEvents(fixture)
    const workersDir = join(fixture.stateDir, 'workers')
    store.addWorker('session-archived', { scope: 'global', workerType: 'work', cwd: workersDir, status: 'idle', lastUsedAt: 9000 })

    // Creating the first real Worker must not pick the archived binding.
    const first = await controller.ensureWorker('global')
    assert.equal(first.created, true, JSON.stringify(first))
    assert.notEqual(first.sessionId, 'session-archived')
    assert.ok(store.worker('session-archived'), 'an archived binding is kept, just not selectable')

    // Make the real Worker idle and older than the dead binding, so the dead one
    // is tried first and must fall through to it.
    store.addWorker(first.sessionId, { status: 'idle', currentTicketId: null, lastUsedAt: 1000 })
    store.addWorker('session-deleted', { scope: 'global', workerType: 'work', cwd: workersDir, status: 'idle', lastUsedAt: 8000 })
    const second = await controller.ensureWorker('global', null, undefined, 'ticket_probe')
    assert.equal(second.created, false, JSON.stringify(second))
    assert.equal(second.sessionId, first.sessionId)
    assert.equal(store.worker('session-deleted'), null, 'a dead binding is removed')
    const failed = events.find(event => event.event === 'worker.resolve_failed')
    assert.ok(failed, 'expected worker.resolve_failed')
    assert.equal(failed.payload.workerId, 'session-deleted')
    assert.equal(failed.ticketId, 'ticket_probe')
    assert.equal(typeof failed.payload.latencyMs, 'number')
    assert.ok(failed.payload.error)

    // Normal path: the same idle Worker is reused again, no new session.
    const third = await controller.ensureWorker('global')
    assert.equal(third.created, false)
    assert.equal(third.sessionId, first.sessionId)
    assert.equal(events.filter(event => event.event === 'worker.resolve_failed').length, 1)

    // Startup reconcile is idempotent and reports what it cleaned.
    store.addWorker('session-gone', { scope: 'global', workerType: 'work', cwd: workersDir, status: 'idle', lastUsedAt: 1 })
    assert.equal(await controller.reconcileWorkerBindings(), 1)
    assert.equal(store.worker('session-gone'), null)
    assert.equal(await controller.reconcileWorkerBindings(), 0)
    const reconciled = events.filter(event => event.event === 'worker.reconcile_removed')
    assert.equal(reconciled.length, 1)
    assert.equal(reconciled[0].payload.workerId, 'session-gone')
  } finally {
    fixture.cleanup()
  }
}

// ④ Empty answer: retried once, then blocked(environment) with a readable
// reason, a router-event and a Chatbot notification.
{
  const fixture = await createFixture({ v2Default: true, advisorMode: 'stateless' })
  try {
    const controller = fixture.service.v2
    await controller.bootstrapCognition()
    const events = await withEvents(fixture)
    const chatbot = fixture.service.v2.v2.chatbotSessionId
    let calls = 0
    controller.callAdvisorModel = async () => {
      calls += 1
      return {
        text: JSON.stringify({ action: 'answer', answer: { text: '' } }),
        usage: { input: 1, output: 1, total: 2 },
        latencyMs: 4,
        attempts: 1,
      }
    }
    const result = await fixture.callAs(chatbot, 'chatbot_request', { goal: '空答复', mode: 'answer' })
    assert.equal(result.ok, false, JSON.stringify(result))
    assert.equal(result.code, 'advisor_answer_failed')
    assert.equal(result.failureType, 'empty')
    assert.equal(calls, 2, 'one initial call plus exactly one retry')
    const ticket = fixture.service.store.ticket(result.ticketId)
    assert.equal(ticket.status, 'blocked')
    assert.equal(ticket.waitingOn, 'environment')
    assert.match(ticket.blockedReason, /Advisor 返回空答复（重试 1 次仍为空）/)
    const event = events.find(item => item.event === 'advisor.answer.failed')
    assert.ok(event)
    assert.equal(event.payload.failureType, 'empty')
    assert.equal(event.payload.retryCount, 1)
    assert.equal(event.payload.model, 'provider-ok/model-vision')
    assert.equal(typeof event.payload.latencyMs, 'number')
    const notified = fixture.prompts.some(item =>
      String(item.sessionId) === String(chatbot) && /回答失败/.test(JSON.stringify(item.content)))
    assert.ok(notified, 'the Chatbot must be notified')
  } finally {
    fixture.cleanup()
  }
}

// ⑤ Timeout and exception are distinct failure types, each parked with a
// readable reason and an advisor.answer.failed event.
async function answerFailureCase({ error, expectedType, reasonPattern, reply }) {
  const fixture = await createFixture({ v2Default: true, advisorMode: 'stateless' })
  try {
    const controller = fixture.service.v2
    await controller.bootstrapCognition()
    const events = await withEvents(fixture)
    const chatbot = fixture.service.v2.v2.chatbotSessionId
    controller.callAdvisorModel = async () => {
      if (error) throw error
      return { text: reply, usage: { input: 1, output: 1, total: 2 }, latencyMs: 5, attempts: 1 }
    }
    const result = await fixture.callAs(chatbot, 'chatbot_request', { goal: 'answer fails', mode: 'answer' })
    assert.equal(result.ok, false, JSON.stringify(result))
    assert.equal(result.code, 'advisor_answer_failed')
    assert.equal(result.failureType, expectedType)
    const ticket = fixture.service.store.ticket(result.ticketId)
    assert.equal(ticket.status, 'blocked')
    assert.equal(ticket.waitingOn, 'environment')
    assert.match(ticket.blockedReason, reasonPattern)
    const event = events.find(item => item.event === 'advisor.answer.failed')
    assert.ok(event, 'expected advisor.answer.failed')
    assert.equal(event.payload.failureType, expectedType)
    assert.equal(typeof event.payload.latencyMs, 'number')
    assert.equal(typeof event.payload.model, 'string')
    return result
  } finally {
    fixture.cleanup()
  }
}

await answerFailureCase({
  error: Object.assign(new Error('llm request timed out'), { code: 'ETIMEDOUT' }),
  expectedType: 'timeout',
  reasonPattern: /Advisor 回答超时/,
})
await answerFailureCase({
  error: new Error('boom'),
  expectedType: 'exception',
  reasonPattern: /Advisor 调用异常/,
})
await answerFailureCase({
  reply: 'this is not json',
  expectedType: 'parse_error',
  reasonPattern: /Advisor 回答无法解析/,
})

console.log('v2 dispatch resilience ok')
