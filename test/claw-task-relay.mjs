import assert from 'node:assert/strict'
import { createFixture } from './support/ria-fixture.mjs'

const tick = () => new Promise(resolve => setTimeout(resolve, 0))
const fixture = await createFixture({
  stateDefault: true,
  extraSessions: [{ sessionId: 'session-claw-task', running: false, blank: false, updatedAt: 1, cwd: '/work/claw', projections: { values: { title: 'Claw Task' } } }],
})
try {
  const controller = fixture.service.controller
  const chat = controller.state.chatSessionId
  const id = 'session-claw-task'
  const sent = []
  fixture.service.wechatClaw = {
    forwardAssistant(text, event, options = {}) {
      sent.push({ text: String(text), kind: options.kind, task: Boolean(event && event.riaTaskTurn) })
      return 'delivered'
    },
  }
  const assistant = (seq, text) => fixture.service.onSessionEvent({ header: { id } }, {
    type: 'assistant/message', seq, time: seq,
    data: { turn: 1, message: { content: [{ type: 'text', text }] } },
  })

  // 1) Forward-triggered turn -> task marker -> Claw notice (🔔).
  const forwarded = await fixture.callAs(chat, 'ria_chat_forward', { sessionId: id, content: 'read the report and suggest improvements' })
  assert.equal(forwarded.ok, true, JSON.stringify(forwarded))
  assert.equal(controller.isRiaTaskTurn(id), true, 'forward marks the turn at injection time')
  assistant(1, 'task result')
  await controller.coManagement.flush(id)
  assert.equal(sent.length, 1)
  assert.equal(sent[0].kind, 'notice', 'task result uses the notice lane (🔔)')
  assert.equal(sent[0].task, true, 'marker travels on the buffered relay event')

  // Turn end consumes and clears the marker.
  fixture.service.onSessionEvent({ header: { id } }, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  await tick()
  assert.equal(controller.isRiaTaskTurn(id), false, 'turn/end clears the task marker')

  // 2) Natural assistant reply -> assistant lane (🌊).
  assistant(2, 'just chatting')
  await controller.coManagement.flush(id)
  assert.equal(sent.at(-1).kind, 'assistant')
  assert.equal(sent.at(-1).task, false)

  // 3) Aborted turn also clears the marker; the next natural reply stays 🌊.
  const second = await fixture.callAs(chat, 'ria_chat_forward', { sessionId: id, content: 'one more task' })
  assert.equal(second.ok, true, JSON.stringify(second))
  assert.equal(controller.isRiaTaskTurn(id), true)
  fixture.service.onSessionEvent({ header: { id } }, { type: 'turn/end', data: { turn: 2, reason: { kind: 'aborted', reason: { kind: 'user' } } } })
  await tick()
  assert.equal(controller.isRiaTaskTurn(id), false, 'aborted turn/end clears the marker')
  assistant(3, 'natural after abort')
  await controller.coManagement.flush(id)
  assert.equal(sent.at(-1).kind, 'assistant')

  // 4) Ticket status notices stay on the 🔔 lane.
  const clawKinds = []
  controller.notifyClawStatus = async (text, requestId, kind = 'notice') => { clawKinds.push(kind); return true }
  const ticket = fixture.service.store.addTicket({ status: 'working', executor: id, goal: 'status' })
  await controller.notifyTicketStatus(ticket.ticketId, 'working', 'ticket status')
  assert.deepEqual(clawKinds, ['notice'])
  console.log('claw task relay lanes ok')
} finally {
  fixture.cleanup()
}
