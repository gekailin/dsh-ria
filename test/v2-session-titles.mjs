import assert from 'node:assert/strict'
import { createFixture } from './support/ria-fixture.mjs'

const fixture = await createFixture({
  v2Default: true,
  extraSessions: [
    { sessionId: 'session-user-design', running: false, blank: false, updatedAt: 30, cwd: '/tmp', projections: { values: { title: 'Ria 顶层设计' } } },
    { sessionId: 'session-legacy-worker', running: false, blank: false, updatedAt: 29, cwd: '/tmp', projections: { values: { title: 'Worker 1' } } },
    { sessionId: 'session-legacy-reflection', running: false, blank: false, updatedAt: 28, cwd: '/tmp', projections: { values: { title: 'Reflection Worker' } } },
  ],
})
try {
  const controller = fixture.service.v2
  const sc = fixture.service.ctx.sessionController
  // Extra fixture sessions do not preload the fake title map; give the user
  // session a stable title so the test can prove it is never touched.
  await sc.rename({ sessionId: 'session-user-design', title: 'Ria 顶层设计' })
  const titleOf = async sessionId => {
    const projection = await sc.projections({ sessionId })
    return projection && projection.values ? projection.values.title : null
  }
  const originalRename = sc.rename.bind(sc)
  let renameCalls = 0
  sc.rename = async request => {
    renameCalls += 1
    return await originalRename(request)
  }

  const chatbot = (await controller.ensureChatbot()).sessionId
  const advisor = (await controller.ensureAdvisor('global')).sessionId
  const worker1 = (await controller.ensureWorker('global')).sessionId
  const worker2 = (await controller.ensureWorker('global')).sessionId
  const reflection1 = (await controller.ensureReflectionWorker('global')).sessionId

  assert.equal(await titleOf(chatbot), 'Ria')
  assert.equal(await titleOf(advisor), 'Ria Advisor')
  assert.equal(await titleOf(worker1), 'Ria Worker 1')
  assert.equal(await titleOf(worker2), 'Ria Worker 2')
  assert.equal(await titleOf(reflection1), 'Ria Reflection Worker 1')

  // Removing a Worker does not reuse its number.
  controller.v2.removeWorker(worker2)
  const worker3 = (await controller.ensureWorker('global')).sessionId
  assert.equal(await titleOf(worker3), 'Ria Worker 3')

  // Old bindings without seq are assigned persistent numbers and renamed once.
  controller.v2.addWorker('session-legacy-worker', { workerType: 'work', status: 'idle' })
  controller.v2.addWorker('session-legacy-reflection', { workerType: 'reflection', status: 'idle' })
  await sc.rename({ sessionId: chatbot, title: 'Chatbot' })
  await sc.rename({ sessionId: advisor, title: 'Advisor' })
  await sc.rename({ sessionId: worker1, title: 'Worker 1' })
  await sc.rename({ sessionId: worker3, title: 'Worker 3' })
  await sc.rename({ sessionId: reflection1, title: 'Reflection Worker' })
  const before = renameCalls
  const first = await controller.renameRoleSessions()
  assert.ok(first.renamed.length >= 7, JSON.stringify(first))
  assert.equal(await titleOf(chatbot), 'Ria')
  assert.equal(await titleOf(advisor), 'Ria Advisor')
  assert.equal(await titleOf(worker1), 'Ria Worker 1')
  assert.equal(await titleOf(worker3), 'Ria Worker 3')
  assert.equal(await titleOf(reflection1), 'Ria Reflection Worker 1')
  assert.match(await titleOf('session-legacy-worker'), /^Ria Worker \d+$/)
  assert.match(await titleOf('session-legacy-reflection'), /^Ria Reflection Worker \d+$/)
  assert.ok(controller.v2.worker('session-legacy-worker').seq > 0)
  assert.ok(controller.v2.worker('session-legacy-reflection').seq > 0)
  assert.equal(await titleOf('session-user-design'), 'Ria 顶层设计')

  // Idempotent: a second pass neither renames nor emits title events.
  const afterFirst = renameCalls
  const second = await controller.renameRoleSessions()
  assert.equal(second.renamed.length, 0)
  assert.equal(renameCalls, afterFirst)
  assert.ok(afterFirst > before)

  // session list reflects the new titles; old role names are gone.
  const listed = await sc.list({})
  const titles = listed.items.map(item => item && item.projections && item.projections.values ? item.projections.values.title : '')
  assert.ok(titles.includes('Ria'))
  assert.ok(titles.includes('Ria Advisor'))
  assert.ok(titles.includes('Ria Worker 1'))
  assert.ok(titles.includes('Ria Reflection Worker 1'))
  assert.equal(titles.includes('Chatbot'), false)
  assert.equal(titles.includes('Advisor'), false)
  assert.equal(titles.includes('Worker 1'), false)
  assert.equal(titles.includes('Reflection Worker'), false)
  assert.ok(titles.includes('Ria 顶层设计'))

  console.log('v2 session titles ok')
} finally {
  fixture.cleanup()
}
