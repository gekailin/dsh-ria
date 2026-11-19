import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { V2Store } from '../lib/v2/store.mjs'
import { createFixture } from './support/ria-fixture.mjs'

// Two Worker kinds: work (default, may write its workspace) and reflection
// (read-only retrospective over repository files and session logs).

const fixture = await createFixture({
  v2Default: true,
  // The real host mounts grep/glob; the minimal fixture adds them here so the
  // reflection Worker's read-only surface is observable.
  extraGlobalTools: ['grep', 'glob'],
})

const advisorOf = () => fixture.service.v2.v2.advisor('global').sessionId
const workerOf = sessionId => fixture.service.v2.v2.worker(sessionId)

try {
  await fixture.service.ensure()
  const chatbot = fixture.service.v2.v2.chatbotSessionId

  // ① Old v2.json: a worker row without workerType is a work Worker.
  {
    const dir = mkdtempSync(join(tmpdir(), 'ria-worker-kinds-'))
    try {
      writeFileSync(join(dir, 'v2.json'), JSON.stringify({
        schemaVersion: 1,
        chatbotSessionId: null,
        advisors: {},
        workers: { 'session-old': { sessionId: 'session-old', kind: 'managed', scope: 'global', status: 'idle', cwd: '/tmp/old-worker' } },
        requests: {},
        tickets: {},
        workOrders: {},
        reports: [],
        inbox: [],
        lastError: null,
      }, null, 2))
      const store = new V2Store(dir)
      assert.equal(store.worker('session-old').workerType, 'work')
      assert.deepEqual(store.workers().map(item => item.workerType), ['work'])
      // The read default is persisted on the next write.
      store.addWorker('session-old', { lastUsedAt: 1 })
      assert.equal(JSON.parse(readFileSync(join(dir, 'v2.json'), 'utf8')).workers['session-old'].workerType, 'work')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  // ② A reflection ticket: no Worker exists yet, so dispatch creates one.
  assert.equal(fixture.service.v2.v2.workers().filter(item => item.workerType === 'reflection').length, 0)
  const reflectionRequest = await fixture.callAs(chatbot, 'chatbot_request', {
    goal: '复盘最近两次会话',
    acceptance: '给出根因与建议',
    mode: 'reflection',
  })
  assert.equal(reflectionRequest.ok, true, JSON.stringify(reflectionRequest))
  assert.equal(reflectionRequest.mode, 'reflection')
  const advisor = advisorOf()
  const reflectionPlan = await fixture.callAs(advisor, 'ticket_plan', {
    ticketId: reflectionRequest.ticketId,
    summary: 'read the session logs and write a retrospective',
    steps: ['session_list', 'session_events', 'report'],
  })
  assert.equal(reflectionPlan.ok, true)
  const reflectionDispatch = await fixture.callAs(advisor, 'ticket_dispatch', { ticketId: reflectionRequest.ticketId })
  assert.equal(reflectionDispatch.ok, true, JSON.stringify(reflectionDispatch))
  const reflectionWorkerId = reflectionDispatch.workerSessionId
  const reflectionMeta = workerOf(reflectionWorkerId)
  assert.equal(reflectionMeta.workerType, 'reflection')
  // Its cwd is under the Ria state directory: it has no repository sandbox.
  assert.ok(String(reflectionMeta.cwd).startsWith(fixture.stateDir), reflectionMeta.cwd)
  assert.equal(fixture.service.store.ticket(reflectionRequest.ticketId).status, 'working')
  assert.equal(fixture.service.store.ticket(reflectionRequest.ticketId).executor, reflectionWorkerId)
  assert.equal(fixture.service.v2.v2.workers().filter(item => item.workerType === 'reflection').length, 1)

  // Its tool surface: read-only investigation plus the retrospective pair, no
  // write/execute tools.
  const reflectionTools = fixture.visibleTools(reflectionWorkerId).sort()
  assert.deepEqual(reflectionTools, [
    'glob', 'grep', 'read', 'session_events', 'session_list', 'worker_checkpoint', 'worker_report',
  ])
  assert.equal(reflectionTools.includes('write'), false)
  assert.equal(reflectionTools.includes('edit'), false)
  assert.equal(reflectionTools.includes('bash'), false)

  // ③ A normal work ticket goes to a work Worker, never the reflection one.
  const workRequest = await fixture.callAs(chatbot, 'chatbot_request', {
    goal: '修一个普通 bug',
    acceptance: '测试通过',
    mode: 'work',
  })
  assert.equal(workRequest.ok, true)
  await fixture.callAs(advisor, 'ticket_plan', {
    ticketId: workRequest.ticketId,
    summary: 'fix it',
    steps: ['edit', 'test'],
  })
  const workDispatch = await fixture.callAs(advisor, 'ticket_dispatch', { ticketId: workRequest.ticketId })
  assert.equal(workDispatch.ok, true, JSON.stringify(workDispatch))
  const workWorkerId = workDispatch.workerSessionId
  const workMeta = workerOf(workWorkerId)
  assert.equal(workMeta.workerType, 'work')
  assert.notEqual(workWorkerId, reflectionWorkerId)
  const workTools = fixture.visibleTools(workWorkerId).sort()
  assert.deepEqual(workTools, [
    'bash', 'edit', 'glob', 'grep', 'read', 'run_code', 'worker_checkpoint', 'worker_report', 'write',
  ])
  assert.equal(workTools.includes('session_list'), false)
  assert.equal(workTools.includes('session_events'), false)

  // ④ The Advisor lost the retrospective tools entirely.
  const advisorTools = fixture.visibleTools(advisor)
  assert.equal(advisorTools.includes('session_list'), false)
  assert.equal(advisorTools.includes('session_events'), false)

  // ⑤ Kind mismatch is refused before anything is dispatched.
  const mismatchRequest = await fixture.callAs(chatbot, 'chatbot_request', {
    goal: '又一个普通工单',
    acceptance: 'x',
    mode: 'work',
  })
  await fixture.callAs(advisor, 'ticket_plan', { ticketId: mismatchRequest.ticketId, summary: 'x', steps: ['x'] })
  const mismatch = await fixture.callAs(advisor, 'ticket_dispatch', {
    ticketId: mismatchRequest.ticketId,
    workerSessionId: reflectionWorkerId,
  })
  assert.equal(mismatch.ok, false)
  assert.equal(mismatch.code, 'specified_worker_unavailable')
  assert.equal(mismatch.cause, 'worker_kind_mismatch')
  assert.match(mismatch.message, /reflection worker.*work worker/)
  assert.equal(fixture.service.store.ticket(mismatchRequest.ticketId).status, 'blocked')
  assert.equal(fixture.service.store.ticket(mismatchRequest.ticketId).waitingOn, 'user')

  // Reflection tickets refuse a workspace: they must not touch a repository.
  const withWorkspace = await fixture.callAs(chatbot, 'chatbot_request', {
    goal: '复盘项目',
    mode: 'reflection',
    workspace: fixture.stateDir,
  })
  assert.equal(withWorkspace.ok, false)
  assert.equal(withWorkspace.code, 'reflection_with_workspace')

  // Reflection tickets carry their mode in the brief and the ticket meta.
  const meta = fixture.service.v2.v2.ticketMeta(reflectionRequest.ticketId)
  assert.equal(meta.mode, 'reflection')
  // The Advisor's ticket brief carries the reflection mode.
  const advisorBrief = fixture.prompts.find(item => String(item.sessionId) === String(advisor) && /模式: reflection/.test(String(item.content[0].text)))
  assert.ok(advisorBrief, 'expected an Advisor ticket brief with mode reflection')
  assert.match(String(advisorBrief.content[0].text), /模式: reflection（复盘，派给 reflection worker）/)
  // The reflection Worker's dispatch brief points at its state-dir cwd.
  const workerBrief = fixture.prompts.filter(item => item.sessionId === reflectionWorkerId).at(-1)
  assert.match(String(workerBrief.content[0].text), /reflection-workers/)

  console.log('v2 worker kinds ok')
} finally {
  fixture.cleanup()
}

