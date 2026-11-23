import assert from 'node:assert/strict'
import { createFixture } from './support/ria-fixture.mjs'

// Co-managed transport: an ordinary DSH session registered as a ticket executor.
async function setup() {
  const fixture = await createFixture({
    state: true,
    extraSessions: [
      { sessionId: 'session-cm', running: false, blank: false, updatedAt: 10, cwd: '/work/proj', projections: { values: { title: 'CM Session' } } },
      { sessionId: 'session-cm-other', running: false, blank: false, updatedAt: 11, cwd: '/work/other', projections: { values: { title: 'Other Session' } } },
    ],
  })
  await fixture.service.ensure()
  const chat = fixture.service.controller.state.chatSessionId
  const state = fixture.service.controller.state
  const controller = fixture.service.controller
  const textOf = prompt => (Array.isArray(prompt.content) ? prompt.content : [])
    .filter(part => part && part.type === 'text').map(part => part.text).join('\n')
  async function register(sessionId = 'session-cm', extra = {}) {
    const added = await fixture.callAs(chat, 'ria_chat_co_manage', { action: 'add', sessionId, ...extra })
    assert.equal(added.ok, true, JSON.stringify(added))
    return added
  }
  async function ticket(goal, projectCwd, executorId = 'session-cm') {
    const made = await fixture.callAs(chat, 'ria_chat_request', { goal })
    assert.equal(made.ok, true, JSON.stringify(made))
    if (projectCwd !== undefined) state.setTicketMeta(made.ticketId, { projectCwd })
    if (executorId) state.setTicketMeta(made.ticketId, { executorId })
    return made.ticketId
  }
  async function plan(ticketId) {
    const advisor = controller.advisor('global').sessionId
    const made = await fixture.callAs(advisor, 'ria_ticket_plan', {
      ticketId, summary: 'wire the transport', steps: ['read code', 'change dispatch'],
      acceptance: 'tests pass', artifacts: ['lib/roles/co-managed.mjs'], notes: 'keep it read-only first',
    })
    assert.equal(made.ok, true, JSON.stringify(made))
    return made
  }
  async function dispatch(ticketId) {
    await plan(ticketId)
    const advisor = controller.advisor('global').sessionId
    const sent = await fixture.callAs(advisor, 'ria_ticket_dispatch', { ticketId })
    assert.equal(sent.ok, true, JSON.stringify(sent))
    return sent
  }
  return { fixture, chat, state, controller, textOf, register, ticket, plan, dispatch }
}

// 1) Registration: kind, fields, opt-out and listing.
{
  const { fixture, chat, state, register } = await setup()
  try {
    const added = await register()
    assert.equal(added.executor.kind, 'co-managed')
    assert.equal(added.executor.cwd, '/work/proj')
    assert.equal(added.executor.title, 'CM Session')
    assert.equal(added.executor.allowAutoDispatch, true)
    assert.deepEqual((await fixture.callAs(chat, 'ria_chat_co_manage', { action: 'list' })).executors.map(item => item.sessionId), ['session-cm'])
    const off = await register('session-cm', { allowAutoDispatch: false })
    assert.equal(off.executor.allowAutoDispatch, false)
    assert.equal(state.executor('session-cm').allowAutoDispatch, false)
    await register('session-cm', { allowAutoDispatch: true })
    assert.equal(state.executor('session-cm').allowAutoDispatch, true)
    const removed = await fixture.callAs(chat, 'ria_chat_co_manage', { action: 'remove', sessionId: 'session-cm' })
    assert.equal(removed.ok, true)
    assert.equal(state.executor('session-cm'), null)
    const missing = await fixture.callAs(chat, 'ria_chat_co_manage', { action: 'add', sessionId: 'session-does-not-exist' })
    assert.equal(missing.ok, false)
    assert.equal(missing.code, 'session_unavailable')
    console.log('co-managed registration ok')
  } finally { fixture.cleanup() }
}

// 2) Dispatch: Advisor WorkOrder only, [WorkOrder #ticketId] header, and the
//    execution binding lives on the ticket meta instead of the watch list.
{
  const { fixture, chat, state, controller, textOf, register, ticket, dispatch } = await setup()
  try {
    await register()
    const ticketId = await ticket('ship the co-managed thing', '/work/proj/sub')
    const sent = await dispatch(ticketId)
    assert.equal(sent.executorSessionId, 'session-cm')
    const brief = textOf(fixture.prompts.at(-1))
    assert.ok(brief.startsWith('[WorkOrder #' + ticketId + ']'), brief.slice(0, 120))
    for (const expected of ['wire the transport', 'read code', 'change dispatch', 'tests pass', 'lib/roles/co-managed.mjs', 'keep it read-only first']) {
      assert.ok(brief.includes(expected), 'brief should carry ' + expected)
    }
    assert.equal(fixture.service.store.ticket(ticketId).status, 'working')
    // Dispatch must not touch the user registration; it binds execution on the
    // ticket meta instead.
    const watch = controller.coManagement.watch('session-cm')
    assert.ok(watch, 'user registration remains')
    const watchId = watch.watchId
    assert.equal(String(watch.addedBy).startsWith('ticket:'), false, 'watch stays user-owned')
    assert.equal(watch.ticketId, undefined)
    const bound = state.ticketMeta(ticketId)
    assert.equal(bound.executorSessionId, 'session-cm')
    assert.equal(bound.executing, true)
    const list = await fixture.callAs(chat, 'ria_chat_watch', { action: 'list' })
    assert.equal(list.watches.find(item => item.sessionId === 'session-cm').watchId, watchId)
    // Idempotent: a second attach for the same ticket writes the same binding.
    controller.attachTicketWatch(fixture.service.store.ticket(ticketId), state.executor('session-cm'))
    assert.equal(state.ticketMeta(ticketId).executorSessionId, 'session-cm')
    assert.equal(controller.coManagement.watch('session-cm').watchId, watchId)
    // Assistant reply becomes a structured report.
    fixture.service.onSessionEvent({ header: { id: 'session-cm' } }, {
      type: 'assistant/message', time: Date.now(),
      data: { content: [{ type: 'text', text: '结论: 派发改好了\n证据: node test/state-co-managed.mjs 通过\n产物: lib/roles/co-managed.mjs\n未做项: 无' }] },
    })
    const report = state.reportsFor(ticketId, 5).at(-1)
    assert.equal(report.structured, true)
    assert.equal(report.status, 'progress')
    assert.ok(report.summary.includes('派发改好了'))
    assert.ok(report.evidence.some(item => item.includes('state-co-managed')))
    assert.ok(report.artifacts.some(item => item.includes('co-managed.mjs')))
    assert.equal(fixture.service.store.ticket(ticketId).progress.lastPhase.includes('派发改好了'), true)
    // An unstructured reply is archived verbatim and flagged.
    fixture.service.onSessionEvent({ header: { id: 'session-cm' } }, {
      type: 'assistant/message', time: Date.now(), data: { content: [{ type: 'text', text: '随便说说，没有结构' }] },
    })
    const loose = state.reportsFor(ticketId, 5).at(-1)
    assert.equal(loose.structured, false)
    assert.equal(loose.unstructured, true)
    assert.equal(loose.summary, '随便说说，没有结构')
    // stop_ticket works for co-managed: cancelled + only the execution binding
    // is cleared, while the user registration survives.
    const stopped = await fixture.callAs(chat, 'ria_chat_stop_ticket', { ticketId, reason: '演练结束' })
    assert.equal(stopped.ok, true, JSON.stringify(stopped))
    assert.equal(fixture.service.store.ticket(ticketId).status, 'cancelled')
    assert.equal(controller.coManagement.watch('session-cm').watchId, watchId, 'terminal state keeps the registration')
    const released = state.ticketMeta(ticketId)
    assert.equal(released.executing, false)
    assert.equal(released.executorSessionId, null)
    console.log('co-managed dispatch, binding and stop ok')
  } finally { fixture.cleanup() }
}
// 3a) A turn that ends abnormally parks the ticket on the environment.
{
  const { fixture, state, register, ticket, dispatch } = await setup()
  try {
    await register()
    const failedTicket = await ticket('turn will fail', '/work/proj/a')
    await dispatch(failedTicket)
    fixture.service.onSessionEvent({ header: { id: 'session-cm' } }, {
      type: 'turn/end', time: Date.now(), data: { turn: 3, reason: { kind: 'error', message: 'provider blew up' } },
    })
    const failed = fixture.service.store.ticket(failedTicket)
    assert.equal(failed.status, 'failed')
    assert.equal(failed.failure.code, 'turn_failed')
    assert.match(failed.failure.message, /provider blew up/)
    assert.equal(state.executor('session-cm').currentTicketId, null)
    console.log('co-managed turn failure ok')
  } finally { fixture.cleanup() }
}

// 3b) An approval asked on the co-managed session parks the ticket on approval.
{
  const { fixture, register, ticket, dispatch } = await setup()
  try {
    await register()
    const approvalTicket = await ticket('needs approval', '/work/proj/b')
    await dispatch(approvalTicket)
    fixture.service.onSessionEvent({ header: { id: 'session-cm' } }, {
      type: 'approval/asked', time: Date.now(),
      data: { id: 'apr_cm', toolName: 'bash', callId: 'call_cm', reason: 'run the tests' },
    })
    const parked = fixture.service.store.ticket(approvalTicket)
    assert.equal(parked.status, 'blocked')
    assert.equal(parked.waitingOn, 'approval')
    console.log('co-managed approval park ok')
  } finally { fixture.cleanup() }
}

// 3c) A disposed session parks the ticket on the environment.
{
  const { fixture, register, ticket, dispatch } = await setup()
  try {
    await register()
    const endedTicket = await ticket('session goes away', '/work/proj/c')
    await dispatch(endedTicket)
    fixture.service.onSessionEvent({ header: { id: 'session-cm' } }, { type: 'session/end-seed', time: Date.now(), data: {} })
    const ended = fixture.service.store.ticket(endedTicket)
    assert.equal(ended.status, 'blocked')
    assert.equal(ended.waitingOn, 'environment')
    assert.equal(ended.failure.code, 'session_ended')
    console.log('co-managed session end ok')
  } finally { fixture.cleanup() }
}

// 3d) Stuck detection reuses the shared ticket-health rule.
{
  const { fixture, controller, register, ticket, dispatch } = await setup()
  try {
    await register()
    const stale = await ticket('stuck ticket', '/work/proj/d')
    await dispatch(stale)
    const current = fixture.service.store.ticket(stale)
    current.progress = { lastPhase: 'still going', lastEventAt: Date.now() - 11 * 60 * 1000 }
    current.updatedAt = Date.now() - 11 * 60 * 1000
    fixture.service.store.save()
    const health = controller.ticketHealth(fixture.service.store.ticket(stale))
    assert.equal(health.stuckSuspect, true)
    assert.ok(health.stuckReason.includes('10'))
    console.log('co-managed stuck detection ok')
  } finally { fixture.cleanup() }
}

// 4) Automatic selection only accepts project tickets inside the session cwd.
{
  const { fixture, state, controller, register, ticket } = await setup()
  try {
    await register()
    const idle = state.executor('session-cm')
    assert.equal(controller.isExecutorSelectable(idle, { projectCwd: '/work/proj/sub', executorType: 'work' }), true)
    assert.equal(controller.isExecutorSelectable(idle, { projectCwd: '/work/proj', executorType: 'work' }), true)
    assert.equal(controller.isExecutorSelectable(idle, { projectCwd: null, executorType: 'work' }), false, 'global tickets never select it')
    assert.equal(controller.isExecutorSelectable(idle, { projectCwd: '/work/other/proj', executorType: 'work' }), false, 'another project never selects it')
    assert.equal(controller.isExecutorSelectable(idle, { projectCwd: '/work/projective', executorType: 'work' }), false, 'sibling prefix is not inside cwd')
    const picked = await controller.ensureExecutor('project', null, '/work/proj/sub', null)
    assert.equal(picked.sessionId, 'session-cm')
    // The global ticket keeps a managed Executor: a fresh session is created instead.
    const globalPick = await controller.ensureExecutor('global', null, undefined, null)
    assert.notEqual(globalPick.sessionId, 'session-cm')
    console.log('co-managed selection filter ok')
  } finally { fixture.cleanup() }
}

// 5) Terminal cleanup never removes the user registration; a manual watch also survives.
{
  const { fixture, chat, state, controller, register, ticket, dispatch } = await setup()
  try {
    // The user watches the session first; registering it later must not replace the watch.
    const manual = await fixture.callAs(chat, 'ria_chat_watch', { action: 'add', sessionId: 'session-cm-other' })
    assert.equal(manual.ok, true, JSON.stringify(manual))
    const manualWatchId = manual.watch.watchId
    assert.notEqual(manual.watch.addedBy.startsWith('ticket:'), true)
    await register('session-cm-other')
    const ticketId = await ticket('use the watched session', '/work/other/proj', 'session-cm-other')
    await dispatch(ticketId)
    assert.equal(controller.coManagement.watches().filter(item => item.sessionId === 'session-cm-other').length, 1, 'manual watch is reused, not duplicated')
    await fixture.callAs(chat, 'ria_chat_stop_ticket', { ticketId, reason: 'done rehearsing' })
    const remaining = controller.coManagement.watches().filter(item => item.sessionId === 'session-cm-other')
    assert.equal(remaining.length, 1)
    assert.equal(remaining[0].watchId, manualWatchId, 'manual watch is untouched')
    const meta = state.ticketMeta(ticketId)
    assert.equal(meta.executing, false, 'only the execution binding is cleared')
    assert.equal(meta.executorSessionId, null)
    console.log('co-managed watch cleanup ok')
  } finally { fixture.cleanup() }
}

// 6) A co-managed dispatch without an Advisor WorkOrder is an error, not a downgrade.
{
  const { fixture, chat, state, register, ticket } = await setup()
  try {
    await register()
    const ticketId = await ticket('no plan yet', '/work/proj/e')
    const advisor = fixture.service.controller.advisor('global').sessionId
    const sent = await fixture.callAs(advisor, 'ria_ticket_dispatch', { ticketId })
    assert.equal(sent.ok, false)
    assert.equal(sent.code, 'work_order_missing')
    assert.equal(fixture.service.store.ticket(ticketId).status, 'open')
    console.log('co-managed requires a WorkOrder ok')
  } finally { fixture.cleanup() }
}