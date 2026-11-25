import assert from 'node:assert/strict'
import { createFixture } from './support/ria-fixture.mjs'

const fixture = await createFixture({
  state: true,
  extraSessions: [
    { sessionId: 'session-ordinary-auto', running: false, blank: false, updatedAt: 10, cwd: '/work/auto', projections: { values: { title: 'Ordinary Auto' } } },
    { sessionId: 'session-ordinary-other', running: false, blank: false, updatedAt: 11, cwd: '/work/other', projections: { values: { title: 'Other Auto' } } },
    { sessionId: 'session-ordinary-failure', running: false, blank: false, updatedAt: 12, cwd: '/work/failure', projections: { values: { title: 'Failure Auto' } } },
    { sessionId: 'session-ordinary-failure-dispatch', running: false, blank: false, updatedAt: 13, cwd: '/work/failure-dispatch', projections: { values: { title: 'Failure Dispatch' } } },
  ],
})
try {
  const controller = fixture.service.controller
  const state = controller.state
  const chat = state.chatSessionId
  let advisor = ''
  const events = () => fixture.service.routerEvents.query({ limit: 500 }).events

  async function request(executorId) {
    const made = await fixture.callAs(chat, 'ria_chat_request', { goal: 'auto track ' + executorId, executorId })
    assert.equal(made.ok, true, JSON.stringify(made))
    advisor = controller.advisor('global').sessionId
    assert.ok(advisor, 'advisor exists after request')
    const cwd = executorId === 'session-ordinary-auto' ? '/work/auto' : executorId === 'session-ordinary-other' ? '/work/other' : executorId === 'session-ordinary-failure-dispatch' ? '/work/failure-dispatch' : null
    if (cwd) state.setTicketMeta(made.ticketId, { projectCwd: cwd })
    const planned = await fixture.callAs(advisor, 'ria_ticket_plan', {
      ticketId: made.ticketId,
      summary: 'auto track dispatch',
      steps: ['do it'],
      acceptance: 'ok',
    })
    assert.equal(planned.ok, true, JSON.stringify(planned))
    return made.ticketId
  }

  // Explicit ordinary, unmanaged -> auto co_manage add, no auto dispatch.
  const ordinaryTicket = await request('session-ordinary-auto')
  const ordinaryDispatch = await fixture.callAs(advisor, 'ria_ticket_dispatch', { ticketId: ordinaryTicket })
  assert.equal(ordinaryDispatch.ok, true, JSON.stringify(ordinaryDispatch))
  const watch = controller.coManagement.watch('session-ordinary-auto')
  assert.ok(watch, 'ordinary session is auto tracked')
  assert.equal(watch.allowDispatch, false)
  assert.equal(watch.cwd, '/work/auto')
  assert.equal(watch.ticketId, ordinaryTicket)
  const auto = events().find(item => item.event === 'co.auto_tracked' && item.ticketId === ordinaryTicket)
  assert.ok(auto, 'co.auto_tracked emitted')
  assert.deepEqual(auto.payload, {
    sessionId: 'session-ordinary-auto', ticketId: ordinaryTicket, source: 'dispatch', allowDispatch: false, cwd: '/work/auto',
  })
  assert.equal(state.executor('session-ordinary-auto').allowAutoDispatch, false)

  // Already registered -> no duplicate add and no duplicate event.
  const beforeAutoCount = events().filter(item => item.event === 'co.auto_tracked' && item.ticketId === ordinaryTicket).length
  await fixture.callAs(chat, 'ria_chat_co_manage', { action: 'add', sessionId: 'session-ordinary-other', allowDispatch: true })
  const otherTicket = await request('session-ordinary-other')
  const otherDispatch = await fixture.callAs(advisor, 'ria_ticket_dispatch', { ticketId: otherTicket })
  assert.equal(otherDispatch.ok, true, JSON.stringify(otherDispatch))
  assert.equal(controller.coManagement.watch('session-ordinary-other').allowDispatch, true)
  assert.equal(events().filter(item => item.event === 'co.auto_tracked' && item.ticketId === otherTicket).length, 0)
  assert.equal(events().filter(item => item.event === 'co.auto_tracked' && item.ticketId === ordinaryTicket).length, beforeAutoCount)

  // Managed executor -> never auto-registered.
  const managed = await controller.ensureExecutor('global')
  const managedTicket = await request(managed.sessionId)
  const managedDispatch = await fixture.callAs(advisor, 'ria_ticket_dispatch', { ticketId: managedTicket })
  assert.equal(managedDispatch.ok, true, JSON.stringify(managedDispatch))
  assert.equal(controller.coManagement.watch(managed.sessionId), null)

  // Role sessions are not ordinary targets and are never auto-registered.
  const roleTrack = await controller.autoTrackExplicitExecutor(chat, 'ticket-role', { source: 'dispatch' })
  assert.equal(roleTrack.ok, true)
  assert.equal(roleTrack.skipped, 'role')
  assert.equal(controller.coManagement.watch(chat), null)

  // Auto-add failure is caught by the helper and never throws.
  const originalAdd = controller.coManagement.add.bind(controller.coManagement)
  controller.coManagement.add = () => { throw new Error('co add unavailable') }
  const tracked = await controller.autoTrackExplicitExecutor('session-ordinary-failure', 'ticket-failure', { source: 'dispatch' })
  assert.equal(tracked.ok, false)
  assert.equal(tracked.skipped, 'add_failed')
  controller.coManagement.add = originalAdd

  // A failed auto-add must not block the actual dispatch.
  const failedAddTicket = await request('session-ordinary-failure-dispatch')
  controller.coManagement.add = () => { throw new Error('co add unavailable') }
  let failedAddDispatch
  try {
    failedAddDispatch = await fixture.callAs(advisor, 'ria_ticket_dispatch', { ticketId: failedAddTicket })
  } finally {
    controller.coManagement.add = originalAdd
  }
  assert.equal(failedAddDispatch.ok, true, JSON.stringify(failedAddDispatch))
  assert.equal(controller.coManagement.watch('session-ordinary-failure-dispatch'), null)
} finally {
  fixture.cleanup()
}
console.log('co auto track ok')