import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFixture } from './support/ria-fixture.mjs'

// Plan B: co-management registration is user-owned and decoupled from ticket
// execution. Dispatch/terminal transitions only touch ticket.meta.
async function setup(options = {}) {
  const fixture = await createFixture({
    state: true,
    ...(options.stateDir ? { stateDir: options.stateDir } : {}),
    extraSessions: [
      { sessionId: 'session-cm', running: false, blank: false, updatedAt: 10, cwd: '/work/proj', projections: { values: { title: 'CM Session' } } },
    ],
  })
  const controller = fixture.service.controller
  const state = controller.state
  const chat = state.chatSessionId
  async function register(extra = {}) {
    const added = await fixture.callAs(chat, 'ria_chat_co_manage', { action: 'add', sessionId: 'session-cm', ...extra })
    assert.equal(added.ok, true, JSON.stringify(added))
    return added
  }
  async function makeTicket(goal, projectCwd, workerId = 'session-cm') {
    const made = await fixture.callAs(chat, 'ria_chat_request', { goal })
    assert.equal(made.ok, true, JSON.stringify(made))
    if (projectCwd !== undefined) state.setTicketMeta(made.ticketId, { projectCwd })
    if (workerId) state.setTicketMeta(made.ticketId, { workerId })
    return made.ticketId
  }
  async function plan(ticketId) {
    const advisor = controller.advisor('global').sessionId
    const made = await fixture.callAs(advisor, 'ria_ticket_plan', {
      ticketId, summary: 'wire the binding', steps: ['read code', 'change dispatch'],
      acceptance: 'tests pass', artifacts: ['lib/core/controller.mjs'], notes: 'keep the user registration',
    })
    assert.equal(made.ok, true, JSON.stringify(made))
    return made
  }
  async function dispatch(ticketId) {
    await plan(ticketId)
    const advisor = controller.advisor('global').sessionId
    return await fixture.callAs(advisor, 'ria_ticket_dispatch', { ticketId })
  }
  return { fixture, controller, state, chat, register, makeTicket, plan, dispatch }
}

const events = stateDir => readFileSync(join(stateDir, 'events.jsonl'), 'utf8')
  .split('\n').filter(Boolean).map(line => JSON.parse(line))

// (a) Core regression: register -> dispatch -> terminal -> registration remains.
{
  const { fixture, controller, state, chat, register, makeTicket, dispatch } = await setup()
  try {
    await register({ title: 'CM Regression', cwd: '/work/proj', tags: ['reg'], roleNote: 'binding regression', allowDispatch: true })
    const before = controller.coManagement.watch('session-cm')
    assert.ok(before)
    const ticketId = await makeTicket('keep the registration', '/work/proj/sub')
    const sent = await dispatch(ticketId)
    assert.equal(sent.ok, true, JSON.stringify(sent))
    assert.equal(sent.workerSessionId, 'session-cm')
    const during = controller.coManagement.watch('session-cm')
    assert.equal(during.watchId, before.watchId, 'dispatch does not replace the registration')
    assert.equal(during.titleSnapshot, 'CM Regression')
    assert.equal(during.cwd, '/work/proj')
    assert.equal(during.allowDispatch, true)
    const bound = state.ticketMeta(ticketId)
    assert.equal(bound.executorSessionId, 'session-cm')
    assert.equal(bound.executing, true)
    assert.equal(controller.executingTicketsFor('session-cm').length, 1)

    // The board exposes a read-only co-management group; it never joins the
    // ticket page/counters.
    // Unrelated meta must survive release: it clears exactly two keys.
    state.setTicketMeta(ticketId, { projectCwd: '/work/proj/sub', marker: 'keep-me' })
    const board = await fixture.service.boardData({})
    const group = board.coManagement.find(item => item.sessionId === 'session-cm')
    assert.ok(group, 'board exposes the current co-management registration')
    assert.equal(group.title, 'CM Regression')
    assert.equal(group.cwd, '/work/proj')
    assert.equal(group.allowDispatch, true)
    assert.deepEqual(group.executingTicketIds, [ticketId])
    assert.equal(board.counts.total, fixture.service.store.tickets().length, 'co-management does not change ticket counts')
    assert.equal(board.tickets.length, board.counts.total, 'board page still contains only tickets')

    const stopped = await fixture.callAs(chat, 'ria_chat_stop_ticket', { ticketId, reason: 'regression done' })
    assert.equal(stopped.ok, true, JSON.stringify(stopped))
    assert.equal(fixture.service.store.ticket(ticketId).status, 'cancelled')
    const after = controller.coManagement.watch('session-cm')
    assert.ok(after, 'registration must survive the terminal state')
    assert.equal(after.watchId, before.watchId)
    assert.equal(after.titleSnapshot, 'CM Regression')
    assert.equal(after.cwd, '/work/proj')
    assert.equal(after.allowDispatch, true)
    assert.deepEqual(after.tags, ['reg'])
    const released = state.ticketMeta(ticketId)
    assert.equal(released.executing, false, 'release clears only executing')
    assert.equal(released.executorSessionId, null, 'release clears only executorSessionId')
    assert.equal(released.marker, 'keep-me', 'release leaves unrelated ticket meta alone')
    assert.equal(released.projectCwd, '/work/proj/sub')
    assert.equal(controller.releaseTicketWatch(ticketId), 0, 'release is idempotent')
    assert.equal(controller.releaseTicketWatch(ticketId), 0, 'release is idempotent on repeat')
    assert.equal(controller.executingTicketsFor('session-cm').length, 0)
    console.log('co-management binding core regression ok')
  } finally { fixture.cleanup() }
}

// (b) Two tickets for one co-manager: the second is rejected by the existing
// busy rule, and busy is read from ticket meta rather than the worker row.
{
  const { fixture, controller, state, chat, register, makeTicket, dispatch } = await setup()
  try {
    await register()
    const firstId = await makeTicket('first ticket', '/work/proj/a')
    const first = await dispatch(firstId)
    assert.equal(first.ok, true, JSON.stringify(first))
    const executing = controller.executingTicketsFor('session-cm')
    assert.equal(executing.length, 1)
    assert.equal(String(executing[0].ticketId), firstId)

    // A stale/idle worker row must not make the session selectable while the
    // ticket meta still says executing=true.
    state.addWorker('session-cm', { status: 'idle', currentTicketId: null })
    assert.equal(state.worker('session-cm').currentTicketId, null)
    assert.equal(controller.isWorkerSelectable(state.worker('session-cm'), {
      projectCwd: '/work/proj/a', workerType: 'work', automatic: false,
    }), false, 'busy comes from the executing ticket meta')

    const secondId = await makeTicket('second ticket', '/work/proj/a')
    const second = await dispatch(secondId)
    assert.equal(second.ok, false, JSON.stringify(second))
    assert.equal(second.code, 'specified_worker_unavailable')
    assert.equal(second.cause, 'worker_busy')
    const parked = fixture.service.store.ticket(secondId)
    assert.equal(parked.status, 'blocked')
    assert.equal(parked.waitingOn, 'user')
    assert.deepEqual(controller.executingTicketsFor('session-cm').map(meta => String(meta.ticketId)), [firstId])

    const stopped = await fixture.callAs(chat, 'ria_chat_stop_ticket', { ticketId: firstId, reason: 'release the executor' })
    assert.equal(stopped.ok, true, JSON.stringify(stopped))
    assert.equal(controller.executingTicketsFor('session-cm').length, 0)
    assert.equal(state.worker('session-cm').status, 'idle')
    assert.equal(controller.isWorkerSelectable(state.worker('session-cm'), {
      projectCwd: '/work/proj/a', workerType: 'work', automatic: false,
    }), true, 'clearing the binding frees the session')
    console.log('co-management concurrent busy from ticket meta ok')
  } finally { fixture.cleanup() }
}

// (c) co_manage add/set/remove append one audit event each, with the required
// fields, through the existing events.jsonl writer.
{
  const { fixture, chat, controller } = await setup()
  try {
    await fixture.callAs(chat, 'ria_chat_co_manage', {
      action: 'add', sessionId: 'session-cm', title: 'CM Audit', cwd: '/work/proj/audit', allowDispatch: true,
    })
    await fixture.callAs(chat, 'ria_chat_co_manage', {
      action: 'set', sessionId: 'session-cm', allowDispatch: false, tags: ['audited'],
    })
    await fixture.callAs(chat, 'ria_chat_co_manage', { action: 'remove', sessionId: 'session-cm' })

    const rows = events(fixture.stateDir)
    const forSession = kind => rows.filter(row => row.kind === kind && row.payload && row.payload.sessionId === 'session-cm')
    const added = forSession('co_manage.added').at(-1)
    const updated = forSession('co_manage.updated').at(-1)
    const removed = forSession('co_manage.removed').at(-1)
    assert.ok(added, 'co_manage.added is written')
    assert.ok(updated, 'co_manage.updated is written')
    assert.ok(removed, 'co_manage.removed is written')
    assert.equal(added.payload.title, 'CM Audit')
    assert.equal(added.payload.cwd, '/work/proj/audit')
    assert.equal(added.payload.allowDispatch, true)
    assert.equal(updated.payload.title, 'CM Audit')
    assert.equal(updated.payload.cwd, '/work/proj/audit')
    assert.equal(updated.payload.allowDispatch, false)
    assert.equal(removed.payload.title, 'CM Audit')
    assert.equal(removed.payload.cwd, '/work/proj/audit')
    assert.equal(removed.payload.allowDispatch, false)
    assert.equal(controller.coManagement.watch('session-cm'), null, 'remove still removes the registration')
    console.log('co-manage audit events ok')
  } finally { fixture.cleanup() }
}

// (d) Restart: the registration reloads from disk and the executing meta stays
// consistent with the live ticket state.
{
  const stateDir = mkdtempSync(join(tmpdir(), 'ria-co-binding-restart-'))
  let first = null
  try {
    first = await setup({ stateDir })
    await first.register({ title: 'CM Restart', cwd: '/work/proj', allowDispatch: true, tags: ['restart'] })
    const watchId = first.controller.coManagement.watch('session-cm').watchId
    const ticketId = await first.makeTicket('survive a restart', '/work/proj/sub')
    const sent = await first.dispatch(ticketId)
    assert.equal(sent.ok, true, JSON.stringify(sent))
    first.fixture.cleanup({ keepState: true })
    first = null

    const second = await setup({ stateDir })
    try {
      const restored = second.controller.coManagement.watch('session-cm')
      assert.ok(restored, 'registration survives a restart')
      assert.equal(restored.watchId, watchId)
      assert.equal(restored.titleSnapshot, 'CM Restart')
      assert.equal(restored.cwd, '/work/proj')
      assert.equal(restored.allowDispatch, true)
      assert.deepEqual(restored.tags, ['restart'])
      const meta = second.state.ticketMeta(ticketId)
      assert.equal(meta.executing, true)
      assert.equal(meta.executorSessionId, 'session-cm')
      assert.equal(second.fixture.service.store.ticket(ticketId).status, 'working')
      assert.equal(second.controller.executingTicketsFor('session-cm').length, 1)

      const stopped = await second.fixture.callAs(second.chat, 'ria_chat_stop_ticket', { ticketId, reason: 'restart check' })
      assert.equal(stopped.ok, true, JSON.stringify(stopped))
      assert.equal(second.state.ticketMeta(ticketId).executing, false)
      assert.equal(second.state.ticketMeta(ticketId).executorSessionId, null)
      assert.equal(second.controller.executingTicketsFor('session-cm').length, 0)
      assert.equal(second.controller.coManagement.watch('session-cm').watchId, watchId, 'terminal after restart keeps the registration')
      console.log('co-management restart persistence ok')
    } finally { second.fixture.cleanup() }
  } finally {
    if (first) first.fixture.cleanup()
    rmSync(stateDir, { recursive: true, force: true })
  }
}
