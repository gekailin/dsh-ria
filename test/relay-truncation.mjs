import assert from 'node:assert/strict'
import { createFixture } from './support/ria-fixture.mjs'
import { formatRelayBody, isReportLike, formatStatusNotice } from '../lib/core/notifications.mjs'

const short = '短回复'.repeat(25) // 100 chars
assert.equal(formatRelayBody(short, 400, { ticketId: 'ticket_abc123' }), short)
assert.equal(isReportLike(short), false)

const long = '长'.repeat(3000)
const longOut = formatRelayBody(long, 400, { ticketId: 'ticket_abc123' })
assert.ok([...longOut].length <= 400, 'long relay must be <=400 chars')
assert.ok(longOut.startsWith('长'.repeat(300)), 'long relay keeps 300-char head')
assert.ok(longOut.includes('完整内容见工单 #abc123'))
assert.equal(longOut.includes('完整内容可 ria_chat_read'), false)

const report = '## 状态：done\n\n' + '正文'.repeat(1000) + '\n\n证据：artifact.md\n\n第三段'
assert.equal(isReportLike(report), true)
const reportOut = formatRelayBody(report, 400, { ticketId: 'ticket_abc123' })
assert.ok(reportOut.includes('## 状态：done'))
assert.ok(reportOut.includes('报告较长，已折叠'))
assert.ok(reportOut.includes('完整内容见工单 #abc123'))
assert.equal(reportOut.includes('证据：artifact.md'), false)
assert.equal(reportOut.includes('第三段'), false)

const noLimit = formatRelayBody(long, 0, { ticketId: 'ticket_abc123' })
assert.equal(noLimit, long, 'maxChars=0 disables truncation')
const noTicket = formatRelayBody(long, 400)
assert.ok(noTicket.includes('完整内容已记入会话记录'))

const status = formatStatusNotice({ ticketId: 'ticket_abc123', status: 'done', summary: long })
assert.ok(status.text.startsWith('#abc123 done · '))
assert.ok([...status.text].length <= 120)
assert.equal(status.text.includes('长'.repeat(300)), false)

const fixture = await createFixture({ stateDefault: true })
try {
  const controller = fixture.service.controller
  const watch = { watchId: 'watch-trunc', sessionId: 'session-trunc', titleSnapshot: 'Trunc' }
  fixture.service.store.setSettings({ relay: { maxChars: 0 } })
  assert.equal(fixture.service.store.settings().relay.maxChars, 0)
  await controller.sendWatchRelay(watch, long, {})
  assert.equal(controller.watchRelayLog.at(-1).text, '【协管·Trunc】\n' + long)
  fixture.service.store.setSettings({ relay: { maxChars: 400 } })
  await controller.sendWatchRelay(watch, long, {})
  const relayed = controller.watchRelayLog.at(-1)
  assert.ok([...relayed.text].length <= 400 + '【协管·Trunc】\n'.length)
  assert.ok(relayed.text.includes('完整内容已记入会话记录'))
  assert.equal(relayed.fullBody, long, 'full body remains in relay log/session record')
  const managed = await controller.notifyTicketStatus('ticket_abc123', 'done', long)
  assert.ok(managed.text.startsWith('#abc123 done · '))
  assert.ok([...managed.text].length <= 120)
  assert.equal(managed.text.includes('长'.repeat(300)), false)

  // A terminal ticket gives the truncation hint a real ticket suffix, and the
  // full body is stored in the ticket report before delivery.
  const doneTicket = fixture.service.store.addTicket({
    status: 'done', executor: 'session-trunc-ticket', goal: 'relay ticket',
    resolution: { kind: 'done', summary: 'done', evidence: [] },
  })
  await controller.sendWatchRelay({ watchId: 'watch-ticket', sessionId: 'session-trunc-ticket', titleSnapshot: 'Ticket Relay' }, long, {})
  const ticketRelay = controller.watchRelayLog.at(-1)
  assert.ok(ticketRelay.text.includes('完整内容见工单 #' + doneTicket.ticketId.slice(-6)))
  assert.equal(ticketRelay.fullBody, long)
  assert.ok(controller.state.reportsFor(doneTicket.ticketId, 100).some(report => report.raw === long), 'full body stored in ticket report')
  console.log('state relay truncation ok')
} finally {
  fixture.cleanup()
}
