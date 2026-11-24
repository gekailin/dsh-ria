import assert from 'node:assert/strict'
import { createFixture } from './support/ria-fixture.mjs'

// Same status/revision/waitingOn: 10 relay flushes produce one notification.
{
  const fixture = await createFixture({
    stateDefault: true,
    extraSessions: [{ sessionId: 'session-dedupe', cwd: '/tmp', title: 'Dedupe' }],
  })
  try {
    const controller = fixture.service.controller
    const store = fixture.service.store
    const id = 'session-dedupe'
    const ticket = store.addTicket({ status: 'working', executor: id, waitingOn: 'executor', goal: 'dedupe' })
    controller.state.setTicketMeta(ticket.ticketId, { phase: 'working', executorId: id })
    controller.state.addExecutor(id, { status: 'working', currentTicketId: ticket.ticketId })
    controller.state.addReport({
      reportId: 'report_dedupe', ticketId: ticket.ticketId, executorId: id,
      status: 'progress', summary: 'steady', evidence: [], at: Date.now(),
    })
    const chatNotices = []
    const clawNotices = []
    controller.notifyChat = async message => { chatNotices.push(message); return true }
    controller.notifyClawStatus = async () => { clawNotices.push(1); return true }
    const watch = { watchId: 'watch-dedupe', sessionId: id, titleSnapshot: 'Dedupe' }
    for (let index = 0; index < 10; index += 1) await controller.sendWatchRelay(watch, 'steady body', {})
    assert.equal(chatNotices.length, 1)
    assert.equal(clawNotices.length, 1)
    const suppressed = fixture.service.routerEvents.query({ ticketId: ticket.ticketId, type: 'notice.suppressed' }).events
    assert.equal(suppressed.length, 9)
    assert.equal(suppressed[0].reason, 'duplicate_status')
    assert.match(suppressed[0].payload.signature, new RegExp('^' + ticket.ticketId + ':working:'))
    assert.equal(controller.watchRelayLog.filter(item => item.skipped === 'duplicate').length, 9)
    const signature = controller.noticeSignatures.get(ticket.ticketId).signature
    assert.deepEqual(signature.split(':').slice(0, 2), [ticket.ticketId, 'working'])
    assert.equal(signature.split(':')[3], 'executor')
  } finally { fixture.cleanup() }
}

// A different status/waitingOn is one new notification, then dedupes.
{
  const fixture = await createFixture({
    stateDefault: true,
    extraSessions: [{ sessionId: 'session-blocked', cwd: '/tmp', title: 'Blocked' }],
  })
  try {
    const controller = fixture.service.controller
    const store = fixture.service.store
    const id = 'session-blocked'
    const ticket = store.addTicket({ status: 'blocked', executor: id, waitingOn: 'user', blockedReason: 'need user', goal: 'blocked' })
    controller.state.setTicketMeta(ticket.ticketId, { phase: 'blocked', executorId: id })
    controller.state.addExecutor(id, { status: 'idle', currentTicketId: ticket.ticketId })
    const chatNotices = []
    controller.notifyChat = async () => { chatNotices.push(1); return true }
    controller.notifyClawStatus = async () => true
    const watch = { watchId: 'watch-blocked', sessionId: id, titleSnapshot: 'Blocked' }
    await controller.sendWatchRelay(watch, 'body', {})
    await controller.sendWatchRelay(watch, 'body', {})
    assert.equal(chatNotices.length, 1)
    const signature = controller.noticeSignatures.get(ticket.ticketId).signature
    assert.match(signature, new RegExp('^' + ticket.ticketId + ':blocked:'));
    assert.equal(signature.split(':')[3], 'user')
  } finally { fixture.cleanup() }
}

// Direct done notification followed by the first terminal relay stays one.
{
  const fixture = await createFixture({
    stateDefault: true,
    extraSessions: [{ sessionId: 'session-done', cwd: '/tmp', title: 'Done' }],
  })
  try {
    const controller = fixture.service.controller
    const store = fixture.service.store
    const id = 'session-done'
    const ticket = store.addTicket({
      status: 'done', executor: id, goal: 'direct done',
      resolution: { kind: 'done', summary: 'direct done', evidence: [] },
    })
    controller.state.setTicketMeta(ticket.ticketId, { phase: 'done', executorId: id })
    controller.state.addExecutor(id, { status: 'idle', currentTicketId: ticket.ticketId })
    const chatNotices = []
    controller.notifyChat = async () => { chatNotices.push(1); return true }
    controller.notifyClawStatus = async () => true
    await controller.notifyTicketStatus(ticket.ticketId, 'done', 'direct done')
    await controller.sendWatchRelay({ watchId: 'watch-done', sessionId: id, titleSnapshot: 'Done' }, 'full body', {})
    assert.equal(chatNotices.length, 1, 'direct done plus reload sends once')
    assert.equal(controller.noticeSignatures.get(ticket.ticketId).signature, ticket.ticketId + ':done:' + ticket.revision + ':' + String(ticket.waitingOn || ''))
  } finally { fixture.cleanup() }
}

console.log('ticket notice dedupe ok')
