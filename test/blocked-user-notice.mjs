import assert from 'node:assert/strict'
import { createFixture } from './support/ria-fixture.mjs'
import { noticeText } from '../lib/core/notice.mjs'

const fixture = await createFixture({ stateDefault: true })
const tick = () => new Promise(resolve => setTimeout(resolve, 40))
try {
  const controller = fixture.service.controller
  const store = fixture.service.store
  const chatNotices = []
  const clawNotices = []
  controller.notifyChat = async (message) => { chatNotices.push(noticeText(message)); return true }
  controller.notifyClawStatus = async (message) => { clawNotices.push(noticeText(message)); return true }
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
  // The notice carries the complete ticket id (reference + separator) and the
  // question is clipped to 40 chars.
  assert.ok(chatNotices[0].includes(ticket.ticketId), 'the decision notice names the complete ticket id')
  assert.ok(chatNotices[0].length <= '🔔 #工单 需要你决定：'.length + ticket.ticketId.length + 16 + 40)
  assert.equal(chatNotices[0].includes('需要你拍板'), true)

  // Same blocked state re-reported ten times is not a transition edge: it must
  // not emit, and the diagnostic suppressed event is not a dedupe signature.
  for (let index = 0; index < 10; index += 1) {
    controller.onTicketTransition(ticket, { from: 'blocked', to: 'blocked', reason: 'duplicate report' })
  }
  await tick()
  assert.equal(chatNotices.length, 1, 'same blocked state must not notify twice')
  assert.equal(clawNotices.length, 1)
  const suppressed = fixture.service.routerEvents.query({ ticketId: ticket.ticketId, type: 'notice.suppressed', limit: 20 }).events
  assert.equal(suppressed.length, 10)
  assert.equal(suppressed.every(item => item.reason === 'duplicate_blocked_user'), true)

  // There is no timed reminder anymore: a later outbox tick must not add a
  // second blocked(user) notification for the same event.
  await fixture.service.doPumpOutbox('tick')
  await tick()
  assert.equal(chatNotices.length, 1)
  assert.equal(clawNotices.length, 1)

  // A changed blocked event (revision changes) is a new event and sends once.
  const changed = { ...ticket, revision: (Number(ticket.revision) || 0) + 1 }
  controller.onTicketTransition(changed, { from: 'working', to: 'blocked', reason: 'revision changed' })
  await tick()
  assert.equal(chatNotices.length, 2)
  assert.equal(clawNotices.length, 2)

  // A normal working ticket never enters this path.
  const working = store.addTicket({ status: 'working', executor: 'session-blocked', goal: 'working test' })
  controller.onTicketTransition(working, { from: 'open', to: 'working' })
  await tick()
  assert.equal(chatNotices.length, 2)
  console.log('blocked user notice ok')
} finally {
  fixture.cleanup()
}