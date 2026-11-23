import assert from 'node:assert/strict'
import { createFixture } from './support/ria-fixture.mjs'
import { workerDisplayLabel, roleWorkerTitle } from '../lib/core/controller.mjs'

// A co-managed Session belongs to the user: dispatching a ticket must never
// rename it, and a restart migration must not mint a Worker seq for it.
// Managed Workers keep the old behaviour: "Ria Worker NN" + a host rename.
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
  assert.equal(added.worker.kind, 'co-managed')
  assert.equal(added.worker.title, '众源BEV新')
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
  assert.equal(sent.workerSessionId, 'session-co-title')

  // Dispatch itself must not rename, and the title must still be the user's.
  assert.equal(renamed.some(item => item.sessionId === 'session-co-title'), false, JSON.stringify(renamed))
  assert.equal(await titleOf('session-co-title'), '众源BEV新')
  const co = state.worker('session-co-title')
  assert.equal(co.kind, 'co-managed')
  assert.equal(co.executorLabel, '众源BEV新')
  assert.equal(co.seq, undefined)
  assert.equal(workerDisplayLabel(co), '众源BEV新')

  // 3) Startup migration skips the co-managed Session entirely: no rename, no
  // seq allocation (the old bug assigned a fresh NN on every restart).
  const seqBefore = state.data.meta.executorSeq
  const renamedBefore = renamed.length
  const migrated = await controller.renameRoleSessions()
  assert.equal(renamed.some(item => item.sessionId === 'session-co-title'), false, JSON.stringify(renamed))
  assert.equal(renamed.length, renamedBefore)
  assert.equal(await titleOf('session-co-title'), '众源BEV新')
  assert.equal(state.worker('session-co-title').seq, undefined)
  assert.equal(state.data.meta.executorSeq, seqBefore)
  assert.equal(migrated.renamed.length, 0, JSON.stringify(migrated))

  // 4) A managed Worker keeps the old naming and rename path.
  const worker1 = await controller.ensureWorker('global')
  assert.equal(worker1.meta.seq, 1)
  assert.equal(worker1.meta.executorLabel, 'Ria Worker 1')
  assert.equal(await titleOf(worker1.sessionId), 'Ria Worker 1')
  assert.ok(renamed.some(item => item.sessionId === worker1.sessionId && item.title === 'Ria Worker 1'))
  state.addWorker(worker1.sessionId, { status: 'working', currentTicketId: 'ticket-occupy' })
  const worker2 = await controller.ensureWorker('global')
  assert.equal(worker2.meta.seq, 2)
  assert.equal(worker2.meta.executorLabel, 'Ria Worker 2')
  assert.equal(await titleOf(worker2.sessionId), 'Ria Worker 2')
  assert.equal(roleWorkerTitle('work', 2), 'Ria Worker 2')

  // 5) The worker-config listing shows executorLabel, not a host-renamed title.
  const config = await fixture.callAs(chat, 'ria_chat_worker_config', { action: 'get' })
  const row = config.executors.find(item => item.sessionId === 'session-co-title')
  assert.equal(row.title, '众源BEV新')
  assert.equal(row.seq, 0)

  // 6) Legacy records without executorLabel still get a usable display name.
  delete state.data.executors['session-co-title'].executorLabel
  assert.equal(workerDisplayLabel(state.worker('session-co-title')), '众源BEV新')
  assert.equal(workerDisplayLabel({ sessionId: 'legacy', executorType: 'work', seq: 9 }), 'Ria Worker 9')

  console.log('co-managed titles ok')
} finally {
  fixture.cleanup()
}
