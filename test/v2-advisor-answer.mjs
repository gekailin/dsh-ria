import assert from 'node:assert/strict'
import { createFixture } from './support/ria-fixture.mjs'

async function setup() {
  const fixture = await createFixture({ v2: true })
  const chatbot = fixture.service.v2.v2.chatbotSessionId
  return { fixture, chatbot }
}

async function request(fixture, chatbot, args) {
  const made = await fixture.callAs(chatbot, 'chatbot_request', args)
  assert.equal(made.ok, true, JSON.stringify(made))
  return made
}

function advisorOf(fixture) {
  return fixture.service.v2.v2.advisor('global').sessionId
}

function promptsFor(fixture, sessionId) {
  return fixture.prompts.filter(item => item.sessionId === sessionId).map(item => item.content[0].text)
}

// 1. The Chatbot can create an answer-mode ticket; the Advisor brief carries
// the mode, and ticket_answer closes it as an answered research ticket with a
// Routed notice back to the Chatbot. No Worker is involved anywhere.
{
  const { fixture, chatbot } = await setup()
  try {
    const created = await request(fixture, chatbot, {
      goal: '现在各角色的工具集差异是什么',
      acceptance: '列出 Chatbot/Advisor/Worker 的工具面差异',
      mode: 'answer',
    })
    const advisor = advisorOf(fixture)
    const meta = fixture.service.v2.v2.ticketMeta(created.ticketId)
    assert.equal(meta.mode, 'answer')
    assert.match(promptsFor(fixture, advisor).at(-1), /模式: answer（短问答：只读、一次答复、不派 Worker）/)
    // The role is Advisor (参谋) and its ticket brief is already on the new phase.
    assert.match(promptsFor(fixture, advisor).at(-1), /阶段: advisor/)
    assert.match(promptsFor(fixture, advisor).at(-1), /Chatbot\/Advisor\/Worker/)

    const answer = 'Chatbot 只有 chatbot_*；Advisor 是 read + ticket_*；Worker 是执行工具 + worker_*。'
    const answered = await fixture.callAs(advisor, 'ticket_answer', {
      ticketId: created.ticketId,
      answer,
      evidence: ['lib/v2/controller.mjs'],
    })
    assert.equal(answered.ok, true, JSON.stringify(answered))
    assert.equal(answered.status, 'done')
    assert.equal(answered.truncated, false)
    const ticket = fixture.service.store.ticket(created.ticketId)
    assert.equal(ticket.status, 'done')
    assert.equal(ticket.resolution.kind, 'answered')
    assert.equal(ticket.resolution.answer, answer)
    assert.deepEqual(ticket.resolution.evidence, ['lib/v2/controller.mjs'])
    assert.equal(typeof ticket.closedAt, 'number')

    const notices = promptsFor(fixture, chatbot).filter(item => /\[Router notice\]/.test(item))
    assert.ok(notices.some(item => item.includes(created.ticketId) && item.includes('已答复') && item.includes(answer.slice(0, 20))))
    // No WorkOrder, no Worker, no dispatch brief.
    assert.equal(fixture.service.v2.v2.workOrder(created.ticketId), null)
    assert.equal(fixture.service.v2.v2.workers().length, 0)
    assert.equal(fixture.prompts.some(item => /\[Worker brief\]/.test(item.content[0].text)), false)
  } finally {
    fixture.cleanup()
  }
}

// 2. Default mode is work, and the brief says so.
{
  const { fixture, chatbot } = await setup()
  try {
    const created = await request(fixture, chatbot, { goal: 'update the README' })
    assert.equal(created.mode, 'work')
    assert.equal(fixture.service.v2.v2.ticketMeta(created.ticketId).mode, 'work')
    const advisor = advisorOf(fixture)
    assert.match(promptsFor(fixture, advisor).at(-1), /模式: work/)
  } finally {
    fixture.cleanup()
  }
}

// 3. Authorization and state errors: only an Advisor may answer; working,
// blocked and done tickets are rejected with readable codes and are not moved.
{
  const { fixture, chatbot } = await setup()
  try {
    const workingTicket = await request(fixture, chatbot, { goal: 'run tests' })
    const advisor = advisorOf(fixture)
    await fixture.callAs(advisor, 'ticket_plan', { ticketId: workingTicket.ticketId, summary: 'run the suite' })
    const dispatched = await fixture.callAs(advisor, 'ticket_dispatch', { ticketId: workingTicket.ticketId })
    assert.equal(dispatched.ok, true)
    const workingAnswer = await fixture.callAs(advisor, 'ticket_answer', { ticketId: workingTicket.ticketId, answer: 'nope' })
    assert.equal(workingAnswer.ok, false)
    assert.equal(workingAnswer.code, 'ticket_not_open')
    assert.equal(fixture.service.store.ticket(workingTicket.ticketId).status, 'working')
    // Non-Advisor roles do not get the tool at all.
    await assert.rejects(fixture.callAs(chatbot, 'ticket_answer', { ticketId: workingTicket.ticketId, answer: 'x' }), /tool not installed/)
    await assert.rejects(fixture.callAs(dispatched.workerSessionId, 'ticket_answer', { ticketId: workingTicket.ticketId, answer: 'x' }), /tool not installed/)

    const blockedTicket = await request(fixture, chatbot, { goal: 'needs a decision', mode: 'answer' })
    const blocked = await fixture.callAs(advisor, 'ticket_block', { ticketId: blockedTicket.ticketId, reason: 'pick one', question: 'A or B?' })
    assert.equal(blocked.ok, true)
    const blockedAnswer = await fixture.callAs(advisor, 'ticket_answer', { ticketId: blockedTicket.ticketId, answer: 'x' })
    assert.equal(blockedAnswer.ok, false)
    assert.equal(blockedAnswer.code, 'ticket_blocked')
    assert.equal(fixture.service.store.ticket(blockedTicket.ticketId).status, 'blocked')

    const doneTicket = await request(fixture, chatbot, { goal: 'answered already', mode: 'answer' })
    assert.equal((await fixture.callAs(advisor, 'ticket_answer', { ticketId: doneTicket.ticketId, answer: 'done' })).ok, true)
    const again = await fixture.callAs(advisor, 'ticket_answer', { ticketId: doneTicket.ticketId, answer: 'again' })
    assert.equal(again.ok, false)
    assert.equal(again.code, 'ticket_done')
    assert.equal(fixture.service.store.ticket(doneTicket.ticketId).status, 'done')
  } finally {
    fixture.cleanup()
  }
}

// 4. Empty answers are rejected, invalid modes are rejected, and a long answer
// is clipped to 4000 characters while reporting truncated.
{
  const { fixture, chatbot } = await setup()
  try {
    const invalid = await fixture.callAs(chatbot, 'chatbot_request', { goal: 'x', mode: 'later' })
    assert.equal(invalid.ok, false)
    assert.equal(invalid.code, 'invalid_mode')

    const emptyTicket = await request(fixture, chatbot, { goal: 'empty answer', mode: 'answer' })
    const advisor = advisorOf(fixture)
    const empty = await fixture.callAs(advisor, 'ticket_answer', { ticketId: emptyTicket.ticketId, answer: '   ' })
    assert.equal(empty.ok, false)
    assert.equal(empty.code, 'answer_required')
    assert.equal(fixture.service.store.ticket(emptyTicket.ticketId).status, 'open')

    const longTicket = await request(fixture, chatbot, { goal: 'long answer', mode: 'answer' })
    const longAnswer = 'x'.repeat(5000)
    const long = await fixture.callAs(advisor, 'ticket_answer', { ticketId: longTicket.ticketId, answer: longAnswer })
    assert.equal(long.ok, true)
    assert.equal(long.truncated, true)
    const longDone = fixture.service.store.ticket(longTicket.ticketId)
    assert.equal(longDone.status, 'done')
    assert.equal(longDone.resolution.answer.length, 4000)
    assert.ok(longDone.resolution.summary.startsWith('x'.repeat(50)))
  } finally {
    fixture.cleanup()
  }
}

console.log('v2 advisor answer ok')
