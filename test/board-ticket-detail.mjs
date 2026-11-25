import assert from 'node:assert/strict'
import { createFixture } from './support/ria-fixture.mjs'

// The detail endpoint must return the full normalized ticket, not the lean
// board projection: the dialog renders every field from this payload.
const fixture = await createFixture({ state: true })
try {
  const goal = '# 目标\n\n- 步骤一\n- 步骤二'
  const acceptance = '| 项 | 值 |\n| --- | --- |\n| 测试 | 通过 |'
  const ticket = fixture.service.store.addTicket({
    goal,
    acceptance,
    status: 'open',
    executor: 'self',
    checklist: [{ text: 'step one', done: false }],
  })
  const detail = await fixture.service.boardTicketDetail(ticket.ticketId)
  assert.equal(detail.ok, true)
  assert.ok(detail.ticket && typeof detail.ticket === 'object', 'full ticket is returned')
  assert.equal(detail.ticket.goal, goal, 'goal is not truncated')
  assert.equal(detail.ticket.acceptance, acceptance, 'acceptance is not truncated')
  for (const key of ['ticketId', 'status', 'executor', 'waitingOn', 'origin', 'history', 'dependsOn', 'checklist', 'revision', 'createdAt', 'updatedAt', 'closedAt']) {
    assert.ok(Object.hasOwn(detail.ticket, key), 'ticket field missing: ' + key)
  }
  assert.equal(detail.ticket.checklist.length, 1)
  assert.equal(detail.resolution, null)

  const missing = await fixture.service.boardTicketDetail('ticket-does-not-exist')
  assert.equal(missing.ok, false)
  assert.equal(missing.code, 'ticket_missing')

  console.log('board ticket detail ok')
} finally {
  fixture.cleanup()
}
