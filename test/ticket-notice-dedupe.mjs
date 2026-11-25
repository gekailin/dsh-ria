import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createFixture } from './support/ria-fixture.mjs'

// Same ticket/status/revision/waitingOn: any number of relay flushes sends once.
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
    assert.equal(chatNotices.length, 1, 'ten flushes produce one Chat notice')
    assert.equal(clawNotices.length, 1, 'ten flushes produce one Claw notice')
    const suppressed = fixture.service.routerEvents.query({ ticketId: ticket.ticketId, type: 'notice.suppressed' }).events
    assert.equal(suppressed.length, 9)
    assert.equal(suppressed[0].reason, 'duplicate_status')
    assert.match(suppressed[0].payload.signature, new RegExp('^' + ticket.ticketId + '\\|working\\|executor\\|'))
    assert.equal(controller.watchRelayLog.filter(item => item.skipped === 'duplicate').length, 0, 'suppressed relays are not logged as delivered')
    assert.equal(controller.noticeSignatures.size, 1)
    const signature = [...controller.noticeSignatures.keys()][0]
    assert.deepEqual(signature.split('|').slice(0, 3), [ticket.ticketId, 'working', 'executor'])

    // A real revision change is a new state: one new notice, then dedupe.
    fixture.service.tickets.updateTicket(ticket.ticketId, { progress: { lastPhase: 'next', lastEventAt: Date.now() } })
    await controller.notifyTicketStatus(ticket.ticketId, 'working', 'steady body')
    assert.equal(chatNotices.length, 2)
    await controller.notifyTicketStatus(ticket.ticketId, 'working', 'steady body')
    assert.equal(chatNotices.length, 2)

    // waitingOn is part of the signature: each new waiting state sends once.
    await controller.notifyTicketStatus(ticket.ticketId, 'blocked', 'needs a decision', { waitingOn: 'user' })
    assert.equal(chatNotices.length, 3)
    await controller.notifyTicketStatus(ticket.ticketId, 'blocked', 'needs a decision', { waitingOn: 'user' })
    assert.equal(chatNotices.length, 3)
    await controller.notifyTicketStatus(ticket.ticketId, 'blocked', 'needs approval', { waitingOn: 'approval' })
    assert.equal(chatNotices.length, 4)
    await controller.notifyTicketStatus(ticket.ticketId, 'blocked', 'needs approval', { waitingOn: 'approval' })
    assert.equal(chatNotices.length, 4)

    // A status change is a new state: done sends once, then dedupes.
    await controller.notifyTicketStatus(ticket.ticketId, 'done', 'finished')
    assert.equal(chatNotices.length, 5)
    await controller.notifyTicketStatus(ticket.ticketId, 'done', 'finished')
    assert.equal(chatNotices.length, 5)

    // turn/end bookkeeping must not reset the controller-level signatures.
    controller.trackBlockedNotice(id, { type: 'turn/end', data: { turn: 1 } })
    const directAgain = await controller.notifyTicketStatus(ticket.ticketId, 'done', 'finished')
    assert.equal(directAgain, null, 'signature survives turn/end')
    assert.equal(chatNotices.length, 5)
  } finally { fixture.cleanup() }
}

// Different tickets and genuinely new status transitions each send once.
{
  const fixture = await createFixture({ stateDefault: true })
  try {
    const controller = fixture.service.controller
    const store = fixture.service.store
    const first = store.addTicket({ status: 'done', executor: 'self', goal: 'first' })
    const second = store.addTicket({ status: 'done', executor: 'self', goal: 'second' })
    const chatNotices = []
    const clawNotices = []
    controller.notifyChat = async message => { chatNotices.push(message); return true }
    controller.notifyClawStatus = async () => { clawNotices.push(1); return true }
    await controller.notifyTicketStatus(first.ticketId, 'done', 'first done')
    await controller.notifyTicketStatus(first.ticketId, 'done', 'first done')
    await controller.notifyTicketStatus(second.ticketId, 'done', 'second done')
    assert.equal(chatNotices.length, 2, 'different ticket ids do not collide')
    assert.equal(clawNotices.length, 2)
    const suppressed = fixture.service.routerEvents.query({ limit: 200 }).events.filter(event => event.event === 'notice.suppressed')
    assert.equal(suppressed.length, 1)
    assert.equal(suppressed[0].ticketId, first.ticketId)
    assert.equal(suppressed[0].payload.status, 'done')
    assert.equal(suppressed[0].payload.revision, first.revision)
  } finally { fixture.cleanup() }
}

// The tool/code path is exactly the one under test: no per-turn reset code.
{
  const source = readFileSync(new URL('../lib/core/controller.mjs', import.meta.url), 'utf8')
  assert.match(source, /this\.noticeSignatures = new Map\(\)/)
  assert.doesNotMatch(source, /noticeSignatures\.(clear|delete)\([^)]*turn/)
}
console.log('ticket notice dedupe ok')
