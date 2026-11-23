import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { StateStore } from '../lib/store/store.mjs'
import { createFixture } from './support/ria-fixture.mjs'

// Two Executor kinds: work (default, may write its workspace) and reflection
// (read-only retrospective over repository files and session logs).

const fixture = await createFixture({
  stateDefault: true,
  // The real host mounts grep/glob; the minimal fixture adds them here so the
  // reflection Executor's read-only surface is observable.
  extraGlobalTools: ['grep', 'glob'],
})

const advisorOf = () => fixture.service.controller.advisor('global').sessionId
const executorOf = sessionId => fixture.service.controller.state.executor(sessionId)

try {
  await fixture.service.ensure()
  const chat = fixture.service.controller.state.chatSessionId

  // ① Old state.json: a executor row without executorType is a work Executor.
  {
    const dir = mkdtempSync(join(tmpdir(), 'ria-executor-kinds-'))
    try {
      writeFileSync(join(dir, 'state.json'), JSON.stringify({
        schemaVersion: 1,
        chatSessionId: null,
        advisors: {},
        executors: { 'session-old': { sessionId: 'session-old', kind: 'managed', scope: 'global', status: 'idle', cwd: '/tmp/old-executor' } },
        requests: {},
        tickets: {},
        workOrders: {},
        reports: [],
        inbox: [],
        lastError: null,
      }, null, 2))
      const store = new StateStore(dir)
      assert.equal(store.executor('session-old').executorType, 'work')
      assert.deepEqual(store.executors().map(item => item.executorType), ['work'])
      // The read default is persisted on the next write.
      store.addExecutor('session-old', { lastUsedAt: 1 })
      assert.equal(JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')).executors['session-old'].executorType, 'work')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  // ② A reflection ticket: no Executor exists yet, so dispatch creates one.
  assert.equal(fixture.service.controller.state.executors().filter(item => item.executorType === 'reflection').length, 0)
  // Reflection tickets are created internally now; ria_chat_request is work-only.
  const reflectionRequest = await fixture.service.controller.requestTicket({
    goal: '复盘最近两次会话',
    acceptance: '给出根因与建议',
  }, { agent: { id: chat } }, { mode: 'reflection' })
  assert.equal(reflectionRequest.ok, true, JSON.stringify(reflectionRequest))
  assert.equal(reflectionRequest.mode, 'reflection')
  const advisor = advisorOf()
  const reflectionPlan = await fixture.callAs(advisor, 'ria_ticket_plan', {
    ticketId: reflectionRequest.ticketId,
    summary: 'read the session logs and write a retrospective',
    steps: ['ria_session_list', 'ria_session_events', 'report'],
  })
  assert.equal(reflectionPlan.ok, true)
  const reflectionDispatch = await fixture.callAs(advisor, 'ria_ticket_dispatch', { ticketId: reflectionRequest.ticketId })
  assert.equal(reflectionDispatch.ok, true, JSON.stringify(reflectionDispatch))
  const reflectionExecutorId = reflectionDispatch.executorSessionId
  const reflectionMeta = executorOf(reflectionExecutorId)
  assert.equal(reflectionMeta.executorType, 'reflection')
  // Its cwd is under the Ria state directory: it has no repository sandbox.
  assert.ok(String(reflectionMeta.cwd).startsWith(fixture.stateDir), reflectionMeta.cwd)
  assert.equal(fixture.service.store.ticket(reflectionRequest.ticketId).status, 'working')
  assert.equal(fixture.service.store.ticket(reflectionRequest.ticketId).executor, reflectionExecutorId)
  assert.equal(fixture.service.controller.state.executors().filter(item => item.executorType === 'reflection').length, 1)

  // Its tool surface: read-only investigation plus the bound retrospective
  // tools, no write/execute tools. A reflection dispatch binds all eight
  // ria_reflect_* tools (including the Sage context reader).
  const reflectionTools = fixture.visibleTools(reflectionExecutorId).sort()
  assert.deepEqual(reflectionTools, [
    'glob', 'grep', 'read', 'ria_executor_report',
    'ria_reflect_read_context', 'ria_reflect_read_role_context',
    'ria_reflect_read_sage_context', 'ria_reflect_read_session',
    'ria_reflect_read_sessions', 'ria_reflect_read_tickets', 'ria_reflect_report',
    'ria_reflect_status', 'ria_session_events', 'ria_session_list',
  ])
  assert.equal(reflectionTools.includes('write'), false)
  assert.equal(reflectionTools.includes('edit'), false)
  assert.equal(reflectionTools.includes('bash'), false)

  // ③ A normal work ticket goes to a work Executor, never the reflection one.
  const workRequest = await fixture.callAs(chat, 'ria_chat_request', {
    goal: '修一个普通 bug',
    acceptance: '测试通过',
  })
  assert.equal(workRequest.ok, true)
  await fixture.callAs(advisor, 'ria_ticket_plan', {
    ticketId: workRequest.ticketId,
    summary: 'fix it',
    steps: ['edit', 'test'],
  })
  const workDispatch = await fixture.callAs(advisor, 'ria_ticket_dispatch', { ticketId: workRequest.ticketId })
  assert.equal(workDispatch.ok, true, JSON.stringify(workDispatch))
  const workExecutorId = workDispatch.executorSessionId
  const workMeta = executorOf(workExecutorId)
  assert.equal(workMeta.executorType, 'work')
  assert.notEqual(workExecutorId, reflectionExecutorId)
  const workTools = fixture.visibleTools(workExecutorId).sort()
  assert.deepEqual(workTools, [
    'bash', 'edit', 'glob', 'grep', 'read', 'ria_executor_report', 'run_code', 'write',
  ])
  assert.equal(workTools.includes('ria_session_list'), false)
  assert.equal(workTools.includes('ria_session_events'), false)

  // ④ The Advisor lost the retrospective tools entirely.
  const advisorTools = fixture.visibleTools(advisor)
  assert.equal(advisorTools.includes('ria_session_list'), false)
  assert.equal(advisorTools.includes('ria_session_events'), false)

  // ⑤ Kind mismatch is refused before anything is dispatched.
  const mismatchRequest = await fixture.callAs(chat, 'ria_chat_request', {
    goal: '又一个普通工单',
    acceptance: 'x',
  })
  await fixture.callAs(advisor, 'ria_ticket_plan', { ticketId: mismatchRequest.ticketId, summary: 'x', steps: ['x'] })
  const mismatch = await fixture.callAs(advisor, 'ria_ticket_dispatch', {
    ticketId: mismatchRequest.ticketId,
    executorSessionId: reflectionExecutorId,
  })
  assert.equal(mismatch.ok, false)
  assert.equal(mismatch.code, 'specified_executor_unavailable')
  assert.equal(mismatch.cause, 'executor_kind_mismatch')
  assert.match(mismatch.message, /reflection executor.*work executor/)
  assert.equal(fixture.service.store.ticket(mismatchRequest.ticketId).status, 'blocked')
  assert.equal(fixture.service.store.ticket(mismatchRequest.ticketId).waitingOn, 'user')

  // Reflection tickets refuse a workspace: they must not touch a repository.
  const withWorkspace = await fixture.service.controller.requestTicket({
    goal: '复盘项目',
    workspace: fixture.stateDir,
  }, { agent: { id: chat } }, { mode: 'reflection' })
  assert.equal(withWorkspace.ok, false)
  assert.equal(withWorkspace.code, 'reflection_with_workspace')

  // Reflection tickets carry their mode in the brief and the ticket meta.
  const meta = fixture.service.controller.state.ticketMeta(reflectionRequest.ticketId)
  assert.equal(meta.mode, 'reflection')
  // The Advisor's ticket brief carries the reflection mode.
  const advisorBrief = fixture.prompts.find(item => String(item.sessionId) === String(advisor) && /模式: reflection/.test(String(item.content[0].text)))
  assert.ok(advisorBrief, 'expected an Advisor ticket brief with mode reflection')
  assert.match(String(advisorBrief.content[0].text), /模式: reflection（复盘，派给 reflection executor）/)
  // The reflection Executor is dispatched with the bound reflectionInstruction,
  // not a generic ticket brief: it names the ticket, the run date and the Sage
  // audit requirement.
  const executorBrief = fixture.prompts.filter(item => item.sessionId === reflectionExecutorId).at(-1)
  assert.match(String(executorBrief.content[0].text), /工单绑定/)
  assert.match(String(executorBrief.content[0].text), /Sage 质量检查/)
  assert.match(String(executorBrief.content[0].text), new RegExp('ticketId: ' + reflectionRequest.ticketId))

  console.log('state executor kinds ok')
} finally {
  fixture.cleanup()
}

