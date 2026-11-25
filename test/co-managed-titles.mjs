import assert from 'node:assert/strict'
import { createFixture } from './support/ria-fixture.mjs'
import { executorDisplayLabel, roleExecutorTitle } from '../lib/core/controller.mjs'

// A co-managed Session belongs to the user: dispatching a ticket must never
// rename it, and a restart migration must not mint a Executor seq for it.
// Managed Executors keep the old behaviour: "Ria Executor NN" + a host rename.
const fixture = await createFixture({
  stateDefault: true,
  extraSessions: [
    { sessionId: 'session-co-title', running: false, blank: false, updatedAt: 10, cwd: '/work/proj', projections: { values: { title: '众源BEV新' } } },
  ],
})
try {
  const controller = fixture.service.controller
  const sc = fixture.service.ctx.sessionController
  const chat = controller.state.chatSessionId
  const state = controller.state
  const titleOf = async sessionId => {
    const projection = await sc.projections({ sessionId })
    return projection && projection.values ? projection.values.title : null
  }
  const originalRename = sc.rename.bind(sc)
  // The fixture only knows titles it was told about; seed the user-owned title.
  await originalRename({ sessionId: 'session-co-title', title: '众源BEV新' })
  const renamed = []
  sc.rename = async request => {
    renamed.push({ sessionId: String(request.sessionId), title: String(request.title) })
    return await originalRename(request)
  }

  // 1) Register the ordinary Session as a co-managed executor.
  const added = await fixture.callAs(chat, 'ria_chat_co_manage', {
    action: 'add', sessionId: 'session-co-title', roleNote: 'BEV 执行器',
  })
  assert.equal(added.ok, true, JSON.stringify(added))
  assert.equal(added.executor.kind, 'co-managed')
  assert.equal(added.executor.title, '众源BEV新')
  assert.equal(await titleOf('session-co-title'), '众源BEV新')

  // 2) Dispatch through the real Advisor → ticket → dispatch path.
  const made = await fixture.callAs(chat, 'ria_chat_request', { goal: 'run a BEV task' })
  assert.equal(made.ok, true, JSON.stringify(made))
  state.setTicketMeta(made.ticketId, { projectCwd: '/work/proj', executorId: 'session-co-title' })
  const advisor = controller.advisor('global').sessionId
  const planned = await fixture.callAs(advisor, 'ria_ticket_plan', {
    ticketId: made.ticketId, summary: 'execute', steps: ['run'],
  })
  assert.equal(planned.ok, true, JSON.stringify(planned))
  const sent = await fixture.callAs(advisor, 'ria_ticket_dispatch', { ticketId: made.ticketId })
  assert.equal(sent.ok, true, JSON.stringify(sent))
  assert.equal(sent.executorSessionId, 'session-co-title')

  // Dispatch itself must not rename, and the title must still be the user's.
  assert.equal(renamed.some(item => item.sessionId === 'session-co-title'), false, JSON.stringify(renamed))
  assert.equal(await titleOf('session-co-title'), '众源BEV新')
  const co = state.executor('session-co-title')
  assert.equal(co.kind, 'co-managed')
  assert.equal(co.executorLabel, '众源BEV新')
  assert.equal(co.seq, undefined)
  assert.equal(executorDisplayLabel(co), '众源BEV新')

  // 3) Startup migration skips the co-managed Session entirely: no rename, no
  // seq allocation (the old bug assigned a fresh NN on every restart).
  const seqBefore = state.data.meta.executorSeq
  const renamedBefore = renamed.length
  const migrated = await controller.renameRoleSessions()
  assert.equal(renamed.some(item => item.sessionId === 'session-co-title'), false, JSON.stringify(renamed))
  assert.equal(renamed.length, renamedBefore)
  assert.equal(await titleOf('session-co-title'), '众源BEV新')
  assert.equal(state.executor('session-co-title').seq, undefined)
  assert.equal(state.data.meta.executorSeq, seqBefore)
  assert.equal(migrated.renamed.length, 0, JSON.stringify(migrated))

  // 4) A managed Executor keeps the old naming and rename path.
  const executor1 = await controller.ensureExecutor('global')
  assert.equal(executor1.meta.seq, 1)
  assert.equal(executor1.meta.executorLabel, 'Ria Executor 1')
  assert.equal(await titleOf(executor1.sessionId), 'Ria Executor 1')
  assert.ok(renamed.some(item => item.sessionId === executor1.sessionId && item.title === 'Ria Executor 1'))
  state.addExecutor(executor1.sessionId, { status: 'working', currentTicketId: 'ticket-occupy' })
  const executor2 = await controller.ensureExecutor('global')
  assert.equal(executor2.meta.seq, 2)
  assert.equal(executor2.meta.executorLabel, 'Ria Executor 2')
  assert.equal(await titleOf(executor2.sessionId), 'Ria Executor 2')
  assert.equal(roleExecutorTitle('work', 2), 'Ria Executor 2')

  // 5) The executor-config listing shows executorLabel, not a host-renamed title.
  const config = await fixture.callAs(chat, 'ria_chat_executor_config', { action: 'get' })
  const row = config.executors.find(item => item.sessionId === 'session-co-title')
  assert.equal(row.title, '众源BEV新')
  assert.equal(row.seq, 0)

  // 6) Legacy records may still carry a cached title from before the live-title
  // change; executorDisplayLabel keeps that compatibility fallback, but new
  // writes no longer persist a title snapshot.
  delete state.data.executors['session-co-title'].executorLabel
  assert.equal(Object.hasOwn(state.data.executors['session-co-title'], 'title'), false, 'sync writes no title snapshot')
  state.data.executors['session-co-title'].title = '众源BEV新'
  assert.equal(executorDisplayLabel(state.executor('session-co-title')), '众源BEV新')
  assert.equal(executorDisplayLabel({ sessionId: 'legacy', executorType: 'work', seq: 9 }), 'Ria Executor 9')

  console.log('co-managed titles ok')
} finally {
  fixture.cleanup()
}
