import assert from 'node:assert/strict'
import { createFixture } from './support/ria-fixture.mjs'

const fixture = await createFixture({ stateDefault: true })
const tick = () => new Promise(resolve => setTimeout(resolve, 40))
try {
  const controller = fixture.service.controller
  const store = fixture.service.store
  const chatNotices = []
  const clawNotices = []
  controller.notifyChat = async (message) => { chatNotices.push(String(message)); return true }
  controller.notifyClawStatus = async (message) => { clawNotices.push(String(message)); return true }
  const question = '需要你拍板：a) 是否先精修 chunk 位姿；b) 是否做跨 chunk 联合优化；c) 相机高度是否作为硬约束；d) roll/pitch 自由度；e) 是否产出逐帧位姿。'
  const ticket = store.addTicket({
    status: 'blocked', waitingOn: 'user', executor: 'session-blocked',
    blockedReason: question, attention: { kind: 'question', question }, goal: 'blocked notice test',
  })
  controller.state.addExecutor('session-blocked', { status: 'idle', currentTicketId: null, cwd: '/tmp' })

  // A real blocked(user) edge sends exactly one 🔔 decision notice.
  controller.onTicketTransition(ticket, { from: 'working', to: 'blocked', reason: 'executor needs the user' })
  await tick()
  assert.equal(chatNotices.length, 1, JSON.stringify(chatNotices))
  assert.equal(clawNotices.length, 1)
  assert.match(chatNotices[0], /^🔔 #工单 需要你决定：/)
  assert.ok(chatNotices[0].length <= '🔔 #工单 需要你决定：'.length + 40)
  assert.equal(chatNotices[0].includes('需要你拍板'), true)

  // Re-reporting the same blocked event is suppressed.
  controller.onTicketTransition(ticket, { from: 'working', to: 'blocked', reason: 'duplicate report' })
  await tick()
  assert.equal(chatNotices.length, 1, 'same blocked event must not notify twice')
  assert.equal(clawNotices.length, 1)
  const suppressed = fixture.service.routerEvents.query({ ticketId: ticket.ticketId, type: 'notice.suppressed', limit: 10 }).events
  assert.equal(suppressed.length, 1)
  assert.equal(suppressed[0].reason, 'duplicate_blocked_user')

  // After 30 minutes the existing outbox tick sends exactly one reminder.
  const state = controller.blockedUserNotices.get(ticket.ticketId)
  assert.ok(state && state.count === 1)
  const now = Date.now()
  state.firstAt = now - 31 * 60 * 1000
  const sent = controller.remindBlockedUserTickets(now)
  await tick()
  assert.equal(sent, 1)
  assert.equal(chatNotices.length, 2)
  assert.equal(clawNotices.length, 2)
  assert.match(chatNotices[1], /^🔔 #工单 需要你决定：/)

  // A third reminder is capped.
  const again = controller.remindBlockedUserTickets(now + 60 * 60 * 1000)
  await tick()
  assert.equal(again, 0)
  assert.equal(chatNotices.length, 2)
  const reminded = fixture.service.routerEvents.query({ ticketId: ticket.ticketId, type: 'ticket.blocked.reminded', limit: 10 }).events
  assert.equal(reminded.length, 1)

  // A normal working ticket never enters this path.
  const working = store.addTicket({ status: 'working', executor: 'session-blocked', goal: 'working test' })
  controller.onTicketTransition(working, { from: 'open', to: 'working' })
  await tick()
  assert.equal(chatNotices.length, 2)
  console.log('blocked user notice ok')
} finally {
  fixture.cleanup()
}
