import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createFixture } from './support/ria-fixture.mjs'

const fixture = await createFixture({
  stateDefault: true,
  extraSessions: [
    { sessionId: 'session-user-design', running: false, blank: false, updatedAt: 30, cwd: '/tmp', projections: { values: { title: 'Ria 顶层设计' } } },
    { sessionId: 'session-legacy-worker', running: false, blank: false, updatedAt: 29, cwd: '/tmp', projections: { values: { title: 'Worker 1' } } },
    { sessionId: 'session-legacy-reflection', running: false, blank: false, updatedAt: 28, cwd: '/tmp', projections: { values: { title: 'Reflection Worker' } } },
    { sessionId: 'session-sage', running: false, blank: false, updatedAt: 27, cwd: '/tmp' },
    { sessionId: 'session-read-fail', running: false, blank: false, updatedAt: 26, cwd: '/tmp' },
    { sessionId: 'session-rename-fail', running: false, blank: false, updatedAt: 25, cwd: '/tmp' },
  ],
})
try {
  const controller = fixture.service.controller
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

  const chat = (await controller.ensureChat()).sessionId
  const advisor = await fixture.advisorSession()
  const worker1 = (await controller.ensureWorker('global')).sessionId
  // New Workers are created idle and are reusable for the next ticket, so
  // occupy the first one before asking for a second distinct Worker.
  controller.state.addWorker(worker1, { status: 'working', currentTicketId: 'ticket-seq-1' })
  const worker2 = (await controller.ensureWorker('global')).sessionId
  const reflection1 = (await controller.ensureReflectionWorker('global')).sessionId

  assert.equal(await titleOf(chat), 'Ria')
  assert.equal(await titleOf(advisor), 'Ria Advisor')
  assert.equal(await titleOf(worker1), 'Ria Worker 1')
  assert.equal(await titleOf(worker2), 'Ria Worker 2')
  assert.equal(await titleOf(reflection1), 'Ria Reflection Worker 1')

  // Removing a Worker does not reuse its number.
  controller.state.removeWorker(worker2)
  const worker3 = (await controller.ensureWorker('global')).sessionId
  assert.equal(await titleOf(worker3), 'Ria Worker 3')

  // Old bindings without seq are assigned persistent numbers and renamed once.
  controller.state.addWorker('session-legacy-worker', { workerType: 'work', status: 'idle' })
  controller.state.addWorker('session-legacy-reflection', { workerType: 'reflection', status: 'idle' })
  await sc.rename({ sessionId: chat, title: 'Chat' })
  await sc.rename({ sessionId: advisor, title: 'Advisor' })
  await sc.rename({ sessionId: worker1, title: 'Worker 1' })
  await sc.rename({ sessionId: worker3, title: 'Worker 3' })
  await sc.rename({ sessionId: reflection1, title: 'Reflection Worker' })
  const before = renameCalls
  const first = await controller.renameRoleSessions()
  assert.ok(first.renamed.length >= 7, JSON.stringify(first))
  assert.equal(await titleOf(chat), 'Ria')
  assert.equal(await titleOf(advisor), 'Ria Advisor')
  assert.equal(await titleOf(worker1), 'Ria Worker 1')
  assert.equal(await titleOf(worker3), 'Ria Worker 3')
  assert.equal(await titleOf(reflection1), 'Ria Reflection Worker 1')
  assert.match(await titleOf('session-legacy-worker'), /^Ria Worker \d+$/)
  assert.match(await titleOf('session-legacy-reflection'), /^Ria Reflection Worker \d+$/)
  assert.ok(controller.state.worker('session-legacy-worker').seq > 0)
  assert.ok(controller.state.worker('session-legacy-reflection').seq > 0)
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
  assert.equal(titles.includes('Chat'), false)
  assert.equal(titles.includes('Advisor'), false)
  assert.equal(titles.includes('Worker 1'), false)
  assert.equal(titles.includes('Reflection Worker'), false)
  assert.ok(titles.includes('Ria 顶层设计'))

  // Read/rename failures are isolated, observable, and the read path now passes
  // a real AbortSignal to projections().
  {
    controller.state.setSage('session-sage')
    controller.state.addWorker('session-read-fail', { workerType: 'work', status: 'idle', seq: 50 })
    controller.state.addWorker('session-rename-fail', { workerType: 'work', status: 'idle', seq: 51 })
    await sc.rename({ sessionId: 'session-sage', title: 'Sage' })
    await sc.rename({ sessionId: 'session-read-fail', title: 'Worker 50' })
    await sc.rename({ sessionId: 'session-rename-fail', title: 'Worker 51' })

    const warnings = []
    const originalLog = controller.log.bind(controller)
    controller.log = (level, message) => { if (level === 'warn') warnings.push(String(message)); return originalLog(level, message) }
    const originalProjections = sc.projections.bind(sc)
    let sawSignal = false
    sc.projections = async (request, signal) => {
      if (String(request.sessionId) === 'session-read-fail') throw new TypeError('signal.throwIfAborted is not a function')
      if (signal && typeof signal.throwIfAborted === 'function') sawSignal = true
      return await originalProjections(request, signal)
    }
    const countedRename = sc.rename
    sc.rename = async request => {
      if (String(request.sessionId) === 'session-rename-fail') throw new Error('rename boom')
      return await countedRename(request)
    }

    const rawTitle = async id => {
      const projection = await originalProjections({ sessionId: id })
      return projection && projection.values ? projection.values.title : null
    }
    const result = await controller.renameRoleSessions()
    assert.equal(sawSignal, true)
    assert.equal(await rawTitle('session-sage'), 'Sage')
    assert.equal(await rawTitle('session-read-fail'), 'Worker 50')
    assert.equal(await rawTitle('session-rename-fail'), 'Worker 51')
    assert.ok(warnings.some(text => text.includes('session-read-fail') && text.includes('signal.throwIfAborted')))
    assert.ok(warnings.some(text => text.includes('session-rename-fail') && text.includes('rename boom')))
    const events = readFileSync(join(fixture.stateDir, 'router-events.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
    assert.ok(events.some(item => item.event === 'role.rename.failed' && item.sessionId === 'session-read-fail' && item.reason === 'read-title' && item.payload.phase === 'read-title'))
    assert.ok(events.some(item => item.event === 'role.rename.failed' && item.sessionId === 'session-rename-fail' && item.reason === 'rename' && item.payload.phase === 'rename'))
    assert.ok(result.skipped.some(item => item.sessionId === 'session-read-fail' && item.reason === 'unavailable'))
    assert.ok(result.skipped.some(item => item.sessionId === 'session-rename-fail' && item.reason === 'rename-failed'))
    const beforeIdempotent = renameCalls
    const again = await controller.renameRoleSessions()
    assert.equal(again.renamed.length, 0)
    assert.equal(renameCalls, beforeIdempotent)
  }

  console.log('state session titles ok')
} finally {
  fixture.cleanup()
}
