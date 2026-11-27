import assert from 'node:assert/strict'
import { createFixture } from './support/ria-fixture.mjs'
import { noticeText } from '../lib/core/notice.mjs'

// A ticket-free co-managed session that ends abnormally must notify Chat once,
// without entering any ticket/no_report settlement path.
const fixture = await createFixture({ stateDefault: true })
const tick = () => new Promise(resolve => setTimeout(resolve, 60))
try {
  const controller = fixture.service.controller
  const id = 'session-53d5a84b-def1-4dc3-8df2-ef9e2463c63a'
  const notices = []
  const clawNotices = []
  controller.notifyChat = async (message) => { notices.push(noticeText(message)); return true }
  controller.notifyClawStatus = async (message) => { clawNotices.push(noticeText(message)); return true }
  const ticketsBefore = fixture.service.store.tickets().length
  const ensureExecutor = () => controller.state.addExecutor(id, {
    kind: 'co-managed', executorType: 'work', status: 'idle', currentTicketId: null, cwd: '/tmp',
  })
  const session = { header: { id } }
  const send = (event) => controller.onSessionEvent(session, event)

  // 1) error end -> one notice.
  ensureExecutor()
  send({ type: 'turn/start', time: 1, data: { turn: 1 } })
  send({ type: 'turn/end', time: 2, data: { turn: 1, reason: { kind: 'error', error: { code: 'TIMEOUT', message: 'Upstream model request timed out' } } } })
  await tick()
  assert.equal(notices.length, 1, JSON.stringify(notices))
  assert.equal(clawNotices.length, 1)
  assert.match(notices[0], /^🔔 #会话 异常结束：53d5a8 · /)
  assert.match(notices[0], /TIMEOUT/)
  assert.match(notices[0], /Upstream model request timed out/)

  // 2) aborted end -> one notice with a readable cause.
  ensureExecutor()
  send({ type: 'turn/start', time: 3, data: { turn: 2 } })
  send({ type: 'turn/end', time: 4, data: { turn: 2, reason: { kind: 'aborted', reason: { kind: 'user' } } } })
  await tick()
  assert.equal(notices.length, 2, JSON.stringify(notices))
  assert.match(notices[1], /aborted\(user\)/)

  // 3) completed with no assistant text -> one no_output notice.
  ensureExecutor()
  send({ type: 'turn/start', time: 5, data: { turn: 3 } })
  send({ type: 'turn/end', time: 6, data: { turn: 3, reason: { kind: 'completed' } } })
  await tick()
  assert.equal(notices.length, 3, JSON.stringify(notices))
  assert.match(notices[2], /没有 assistant 文本|no_output/)

  // 4) completed with assistant text is normal: no notice.
  ensureExecutor()
  send({ type: 'turn/start', time: 7, data: { turn: 4 } })
  send({ type: 'assistant/message', time: 8, data: { turn: 4, message: { content: [{ type: 'text', text: 'done normally' }] } } })
  send({ type: 'turn/end', time: 9, data: { turn: 4, reason: { kind: 'completed' } } })
  await tick()
  assert.equal(notices.length, 3, 'normal completed turn must not notify')

  // 5) the same abnormal turn/end twice does not notify twice.
  ensureExecutor()
  send({ type: 'turn/end', time: 10, data: { turn: 1, reason: { kind: 'error', error: { code: 'TIMEOUT', message: 'again' } } } })
  await tick()
  assert.equal(notices.length, 3, 'duplicate abnormal end is deduped')

  // 6) no ticket / no_report settlement was created by any of these turns.
  assert.equal(fixture.service.store.tickets().length, ticketsBefore, 'ticket-free session did not create a ticket')
  assert.equal(controller.executorWorkingTicket(id), null)
  const events = fixture.service.routerEvents.query({ type: 'session.abnormal_end', limit: 20 }).events
  assert.equal(events.length, 3, 'one audit event per abnormal turn')
  assert.deepEqual(events.map(event => event.payload.kind).sort(), ['aborted', 'error', 'no_output'])
  assert.ok(events.every(event => event.ticketId === null))
  console.log('ticket-free abnormal session notice ok')
} finally {
  fixture.cleanup()
}
