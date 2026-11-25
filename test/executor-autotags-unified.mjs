import assert from 'node:assert/strict'
import { createFixture } from './support/ria-fixture.mjs'

const fixture = await createFixture({
  stateDefault: true,
  extraSessions: [{ sessionId: 'session-cm-tags', running: false, blank: false, updatedAt: 1, cwd: '/work/tags', projections: { values: { title: 'CM Tags' } } }],
})
try {
  const controller = fixture.service.controller
  const chat = controller.state.chatSessionId
  const added = await fixture.callAs(chat, 'ria_chat_co_manage', {
    action: 'add', sessionId: 'session-cm-tags', tags: ['frontend'], allowDispatch: false,
  })
  assert.equal(added.ok, true, JSON.stringify(added))
  // A second Executor contributes the "backend" vocabulary tag; the co-managed
  // session's explicit "frontend" tag is already known and must not duplicate.
  controller.state.addExecutor('session-tag-vocab', { kind: 'managed', scope: 'global', cwd: '/work/tags', status: 'idle', tags: ['backend'] })

  // Co-managed observation writes autoTags through the single entry.
  fixture.service.onSessionEvent({ header: { id: 'session-cm-tags' } }, {
    type: 'user/message', seq: 1, time: 1,
    data: { turn: 7, content: [{ type: 'text', text: 'please review the backend work' }], source: { kind: 'user' } },
  })
  let co = controller.state.executor('session-cm-tags')
  assert.equal(co.autoTags.backend, 7, JSON.stringify(co.autoTags))
  assert.equal(Object.hasOwn(co.autoTags, 'frontend'), false, 'explicit tags are never duplicated into autoTags')
  assert.equal(co.lastTurn, 7)

  // Repeating the same turn is idempotent (one key, same turn).
  fixture.service.onSessionEvent({ header: { id: 'session-cm-tags' } }, {
    type: 'user/message', seq: 2, time: 2,
    data: { turn: 7, content: [{ type: 'text', text: 'backend again' }], source: { kind: 'user' } },
  })
  co = controller.state.executor('session-cm-tags')
  assert.deepEqual(Object.keys(co.autoTags), ['backend'])
  assert.equal(co.autoTags.backend, 7)

  fixture.service.onSessionEvent({ header: { id: 'session-cm-tags' } }, {
    type: 'assistant/message', seq: 3, time: 3,
    data: { turn: 8, message: { content: [{ type: 'text', text: 'backend release notes' }] } },
  })
  co = controller.state.executor('session-cm-tags')
  assert.equal(co.autoTags.backend, 8, 'newer turn advances the decay timestamp')

  // Done settlement still goes through recordExecutorAutoTags.
  const calls = []
  const originalRecord = controller.recordExecutorAutoTags.bind(controller)
  controller.recordExecutorAutoTags = (executorId, tags, options) => {
    calls.push({ executorId, tags, options })
    return originalRecord(executorId, tags, options)
  }
  const executor = (await controller.ensureExecutor('global')).sessionId
  const ticket = fixture.service.store.addTicket({ status: 'working', executor, goal: 'auto tag done', acceptance: 'x' })
  controller.state.setTicketMeta(ticket.ticketId, { phase: 'working', executorId: executor, routingTags: ['backend'] })
  controller.state.addReport({ reportId: 'r_done_tags', ticketId: ticket.ticketId, executorId: executor, status: 'done', summary: 'done', evidence: ['ok'], question: '', at: Date.now() })
  const settled = await controller.settleCompletedTurn(ticket, executor, { type: 'turn/end', data: { turn: 4, reason: { kind: 'completed' } } })
  assert.equal(settled.status, 'done')
  const doneCall = calls.find(call => call.options && call.options.trigger === 'ticket.done.auto-tags' && call.executorId === executor)
  assert.ok(doneCall, JSON.stringify(calls))
  assert.ok(doneCall.tags.includes('backend'))
  assert.equal(controller.state.executor(executor).autoTags.backend, 4)

  // Cancelled tickets never call the tagging entry.
  const cancelled = fixture.service.store.addTicket({ status: 'working', executor, goal: 'cancel no tags', acceptance: 'x' })
  controller.state.setTicketMeta(cancelled.ticketId, { phase: 'working', executorId: executor, routingTags: ['nope'] })
  fixture.service.store.transitionTicket(cancelled.ticketId, 'cancelled', { actor: 'user', reason: 'test cancel' })
  assert.equal(Object.hasOwn(controller.state.executor(executor).autoTags, 'nope'), false)
  console.log('unified executor autotags ok')
} finally {
  fixture.cleanup()
}
