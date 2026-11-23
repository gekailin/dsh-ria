import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createFixture } from './support/ria-fixture.mjs'
import { REFLECTION_TOOLS, readReflectionRun, readReflectionState } from '../lib/reflection.mjs'

const planAndDispatch = async (fixture, controller, ticketId) => {
  const advisor = controller.advisor('global').sessionId
  const plan = await fixture.callAs(advisor, 'ria_ticket_plan', {
    ticketId,
    summary: 'read evidence and write a retrospective',
    steps: ['ria_reflect_status', 'ria_reflect_read_context', 'ria_reflect_report'],
  })
  assert.equal(plan.ok, true, JSON.stringify(plan))
  const dispatched = await fixture.callAs(advisor, 'ria_ticket_dispatch', { ticketId })
  assert.equal(dispatched.ok, true, JSON.stringify(dispatched))
  return dispatched
}

const promptTextOf = (fixture, sessionId) => {
  const prompt = fixture.prompts.find(item => String(item.sessionId) === String(sessionId))
  assert.ok(prompt, 'expected a prompt for ' + sessionId)
  const content = Array.isArray(prompt.content) ? prompt.content : []
  return content.map(item => String(item && item.text ? item.text : '')).join('\n')
}

// 1) The manual API path (startReflectionRun) must dispatch a bound reflection
//    run: reflectionInstruction, all eight ria_reflect_* tools (including
//    ria_reflect_read_sage_context) and the runId/forDate.
{
  const fixture = await createFixture({ stateDefault: true })
  try {
    const controller = fixture.service.controller
    const started = await fixture.service.startReflectionRun({ forDate: '2026-11-23' })
    assert.equal(started.ok, true, JSON.stringify(started))
    const dispatched = await planAndDispatch(fixture, controller, started.runId)
    const executor = dispatched.executorSessionId

    const text = promptTextOf(fixture, executor)
    assert.match(text, /Sage 质量检查/, 'instruction must demand the Sage audit section')
    assert.match(text, /ria_reflect_read_sage_context/, 'instruction must name the sage context tool')
    assert.match(text, new RegExp('ticketId: ' + started.runId))
    assert.match(text, /forDate: 2026-11-23/)
    assert.match(text, /工单绑定/)

    const visible = fixture.visibleTools(executor)
    for (const name of REFLECTION_TOOLS) assert.ok(visible.includes(name), 'missing bound tool ' + name)
    assert.ok(visible.includes('ria_reflect_read_sage_context'))
    assert.equal(REFLECTION_TOOLS.length, 8)

    const meta = controller.state.ticketMeta(started.runId)
    assert.equal(meta.reflectionForDate, '2026-11-23')
    assert.equal(meta.reflectionTrigger, 'manual')

    const run = readReflectionRun(fixture.stateDir, started.runId)
    assert.ok(run, 'bound run.json must be persisted')
    assert.equal(run.runId, started.runId)
    assert.equal(run.forDate, '2026-11-23')
    assert.equal(run.executorSessionId, executor)
    assert.equal(run.trigger, 'manual')

    const state = readReflectionState(fixture.stateDir)
    assert.equal(state.activeRunId, started.runId)
    assert.equal(state.lastRunId, started.runId)
    assert.equal(state.lastStatus, 'running')
  } finally { fixture.cleanup() }
}

// 2) The schedule/sage path creates the same ticket without a forDate; it must
//    reach the same construction site and derive today's date, so manual and
//    scheduled reflection can never diverge again.
{
  const fixture = await createFixture({ stateDefault: true })
  try {
    const controller = fixture.service.controller
    const chat = controller.state.chatSessionId
    const request = await controller.requestTicket(
      { goal: 'scheduled reflection', acceptance: 'report', source: 'sage', reflectionTrigger: 'schedule' },
      { agent: { id: chat } }, { mode: 'reflection' },
    )
    assert.equal(request.ok, true, JSON.stringify(request))
    const dispatched = await planAndDispatch(fixture, controller, request.ticketId)
    const executor = dispatched.executorSessionId
    const forDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date())
    const text = promptTextOf(fixture, executor)
    assert.match(text, new RegExp('forDate: ' + forDate))
    assert.match(text, /Sage 质量检查/)
    const visible = fixture.visibleTools(executor)
    assert.ok(visible.includes('ria_reflect_read_sage_context'))
    const meta = controller.state.ticketMeta(request.ticketId)
    assert.equal(meta.reflectionForDate, forDate)
    assert.equal(meta.reflectionTrigger, 'schedule')
  } finally { fixture.cleanup() }
}

// 3) cancelled terminal state: accounting records the status and an explicit
//    "canonical not written" reason; canonical bytes stay untouched.
{
  const fixture = await createFixture({ stateDefault: true })
  try {
    const controller = fixture.service.controller
    const started = await fixture.service.startReflectionRun({ forDate: '2026-11-23' })
    const dispatched = await planAndDispatch(fixture, controller, started.runId)
    const executor = dispatched.executorSessionId
    const canonical = join(fixture.stateDir, 'reflections', '2026-11-23.md')
    const before = existsSync(canonical) ? readFileSync(canonical) : null

    fixture.service.updateReflectionStateFromTicket(started.runId, 'cancelled')
    const state = readReflectionState(fixture.stateDir)
    assert.equal(state.lastStatus, 'cancelled')
    assert.equal(state.activeRunId, null)
    assert.equal(state.lastRunId, started.runId)
    assert.equal(state.lastCompletedDate, null, 'cancelled must not advance lastCompletedDate')
    assert.ok(state.lastCanonicalSkip, 'cancelled must record why canonical was not written')
    assert.equal(state.lastCanonicalSkip.status, 'cancelled')
    assert.equal(state.lastCanonicalSkip.ticketId, started.runId)
    assert.match(state.lastCanonicalSkip.reason, /canonical/)
    assert.equal(existsSync(canonical) ? readFileSync(canonical, 'utf8') : null, before ? before.toString('utf8') : null)
    const run = readReflectionRun(fixture.stateDir, started.runId)
    assert.equal(run.status, 'cancelled')
    assert.equal(fixture.service.reflectionBindings.has(executor), false, 'bindings must be dropped on terminal')
  } finally { fixture.cleanup() }
}

// 4) done: the executor draft becomes the canonical report and the skip marker is
//    cleared, so the same accounting path covers every terminal state.
{
  const fixture = await createFixture({ stateDefault: true })
  try {
    const controller = fixture.service.controller
    const started = await fixture.service.startReflectionRun({ forDate: '2026-11-23' })
    const dispatched = await planAndDispatch(fixture, controller, started.runId)
    const executor = dispatched.executorSessionId
    const run = readReflectionRun(fixture.stateDir, started.runId)
    const markdown = [
      '---',
      'schema: 2',
      'date: 2026-11-23',
      'timezone: Asia/Shanghai',
      'cadence: daily',
      'windowStart: ' + new Date(run.windowStart).toISOString(),
      'windowEnd: ' + new Date(run.windowEnd).toISOString(),
      'trigger: ' + run.trigger,
      'runId: ' + started.runId,
      'attempt: 1',
      'executorSessionId: ' + executor,
      'status: complete',
      'sessionsReviewed: 1',
      'sessionsSkipped: 0',
      'ticketsReviewed: 1',
      'compressedBytesRead: 0',
      'decompressedBytesRead: 0',
      'durationMs: 0',
      'degraded: []',
      '---',
      '## 一句话',
      'ok',
      '## 做对了什么',
      '- 绑定派发',
      '## 错漏清单',
      '- 无',
      '## 教训',
      '- 无',
      '## 对 dsh-ria 的迭代建议',
      '无',
      '## memory 候选',
      '- 无',
      '## 明日关注',
      '- 无',
      '## 记忆来源',
      '- 记忆来源：cognition/chat/{preferences,agreements,decisions}.md',
      '## 覆盖与成本',
      '- 无',
      '## 未覆盖',
      '- 无',
      '## Sage 质量检查',
      '- cognition/chat/preferences.md §锚点 2026-11-23',
      '- cognition/chat/decisions.md §锚点 2026-11-23',
    ].join('\n')
    const reported = await fixture.callAs(executor, 'ria_reflect_report', { markdown, status: 'complete', counts: {} })
    assert.equal(reported.ok, true, JSON.stringify(reported))
    const done = await fixture.callAs(executor, 'ria_worker_report', {
      ticketId: started.runId, status: 'done', summary: markdown, evidence: ['draft written'],
    })
    assert.equal(done.ok, true, JSON.stringify(done))
    const canonical = join(fixture.stateDir, 'reflections', '2026-11-23.md')
    assert.ok(existsSync(canonical), 'done must write canonical')
    assert.equal(readFileSync(canonical, 'utf8'), markdown)
    const state = readReflectionState(fixture.stateDir)
    assert.equal(state.lastStatus, 'done')
    assert.equal(state.lastCompletedDate, '2026-11-23')
    assert.equal(state.activeRunId, null)
    assert.equal(state.lastCanonicalSkip, undefined)
  } finally { fixture.cleanup() }
}

// 5) Static guard: the ticket dispatch has exactly one construction site for
//    reflection prompts, and startReflectionRun no longer builds one.
{
  const source = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
  const controller = readFileSync(new URL('../lib/core/controller.mjs', import.meta.url), 'utf8')
  assert.equal(controller.split('boundReflectionDispatch(').length - 1, 1, 'controller must call the bound builder exactly once')
  const startBlock = source.slice(source.indexOf('async startReflectionRun'), source.indexOf('async boundReflectionDispatch'))
  assert.ok(startBlock.length > 0)
  assert.doesNotMatch(startBlock, /reflectionInstruction|promptSession\(|ria_reflect_read_sage_context/)
  const builder = source.slice(source.indexOf('async boundReflectionDispatch'), source.indexOf('async reflectionScheduleItems'))
  assert.match(builder, /reflectionInstruction\(run\)/)
  assert.match(builder, /installReflectionTools/)
  assert.match(builder, /runId: id/)
  assert.match(builder, /forDate/)
}

console.log('reflection dispatch binding ok')
