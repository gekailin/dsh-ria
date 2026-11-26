import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RiaService } from '../lib/index.js'
import { Controller } from '../lib/core/controller.mjs'
import { readReflectionState, writeReflectionState, reflectionDate } from '../lib/reflection.mjs'
import { REFLECTION_SCHEDULE_PROMPT, REFLECTION_CATCHUP_PROMPT } from '../lib/prompts/reflection.mjs'

const dir = mkdtempSync(join(tmpdir(), 'ria-reflection-api-'))
try {
  const tickets = []
  const meta = {}
  let creates = 0
  let nextStatus = { ok: true }
  let reflectionEnabled = false
  const service = Object.create(RiaService.prototype)
  service.stateDir = dir
  service.reflections = new Map()
  const events = []
  service.routerEvents = { append: event => events.push(event) }
  service.log = () => {}
  service.store = { reflectionSettings: () => ({ enabled: reflectionEnabled, cadence: 'daily', time: '23:40', weekday: 1 }) }
  service.schedule = null
  service.tickets = {
    tickets: () => tickets,
    ticket: id => tickets.find(ticket => ticket.ticketId === id),
  }
  // Mirror the real shape: RiaService.state is the Controller, and the
  // metadata store is controller.state. A flat stub previously hid the 503.
  service.controller = {
    requestTicket: async () => {
      creates += 1
      if (!nextStatus.ok) return nextStatus
      const ticket = { ticketId: 'ticket_reflect_' + creates, status: 'open' }
      tickets.push(ticket)
      meta[ticket.ticketId] = { ticketId: ticket.ticketId, mode: 'reflection' }
      return { ok: true, ticketId: ticket.ticketId, status: 'open' }
    },
    state: {
      ticketMeta: id => meta[id] || { ticketId: id },
      setTicketMeta: (id, patch) => Object.assign(meta[id] || (meta[id] = { ticketId: id }), patch),
    },
  }

  const first = await service.startReflectionRun({ forDate: '2026-11-20' })
  assert.equal(first.ok, true)
  assert.equal(first.queued, true)
  assert.equal(first.runId, 'ticket_reflect_1')
  assert.equal(first.reflectionTicketId, 'ticket_reflect_1')
  assert.equal(first.forDate, '2026-11-20')
  assert.equal(creates, 1)
  assert.equal(readReflectionState(dir).activeRunId, 'ticket_reflect_1')
  assert.equal(service.reflectionStatusSummary().activeRunId, 'ticket_reflect_1')
  assert.equal(meta['ticket_reflect_1'].reflectionForDate, '2026-11-20')
  assert.equal(meta['ticket_reflect_1'].reflectionTrigger, 'manual')

  const second = await service.startReflectionRun({ forDate: '2026-11-20' })
  assert.equal(second.already_running, true)
  assert.equal(second.alreadyActive, true)
  assert.equal(second.runId, 'ticket_reflect_1')
  assert.equal(creates, 1, 'duplicate forDate must not create another ticket')
  assert.equal(events.filter(event => event.event === 'reflection.run.already_active').length, 1,
    'duplicate trigger must record exactly one already_active event')

  // A terminal active ticket must be cleared before a different date can start.
  tickets[0].status = 'done'
  assert.equal(service.reflectionStatusSummary().activeRunId, null, 'terminal ticket is not an active run')

  nextStatus = { ok: false, code: 'advisor_unavailable', message: 'no reflection executor' }
  const failed = await service.startReflectionRun({ forDate: '2026-11-21' })
  assert.equal(failed.ok, false)
  assert.equal(failed.code, 'advisor_unavailable')
  assert.match(failed.message, /no reflection executor/)

  // Scheduled trigger respects lastCompletedDate idempotency unless force=true.
  nextStatus = { ok: true }
  writeReflectionState(dir, { ...readReflectionState(dir), lastCompletedDate: '2026-11-22', activeRunId: null })
  const skipped = await service.startReflectionRun({ forDate: '2026-11-22', trigger: 'schedule' })
  assert.equal(skipped.ok, true)
  assert.equal(skipped.queued, false)
  assert.equal(skipped.skipped, 'completed')

  const scheduled = await service.startReflectionRun({ forDate: '2026-11-23', trigger: 'schedule' })
  assert.equal(scheduled.ok, true)
  assert.equal(scheduled.queued, true)
  assert.equal(scheduled.trigger, 'schedule')
  assert.equal(meta[scheduled.runId].reflectionTrigger, 'schedule')

  // Prompts point to ria_chat_reflect (never legacy ria_reflect).
  assert.match(REFLECTION_SCHEDULE_PROMPT, /\[RIA_REFLECTION_SCHEDULE\]/)
  assert.match(REFLECTION_SCHEDULE_PROMPT, /ria_chat_reflect/)
  assert.doesNotMatch(REFLECTION_SCHEDULE_PROMPT, /\bria_reflect\b/)
  assert.match(REFLECTION_CATCHUP_PROMPT('2026-11-24'), /ria_chat_reflect/)
  assert.doesNotMatch(REFLECTION_CATCHUP_PROMPT('2026-11-24'), /\bria_reflect\b/)

  // Host-side interception: scheduled/catchup user/message triggers startReflectionRun when enabled, ignores & disables when disabled.
  const startedCalls = []
  let disableCalls = 0
  const fakeCtrl = Object.create(Controller.prototype)
  fakeCtrl.log = () => {}
  fakeCtrl.service = {
    store: { reflectionSettings: () => ({ enabled: reflectionEnabled }) },
    startReflectionRun: async opts => { startedCalls.push(opts); return { ok: true, queued: true } },
    disableReflectionSchedule: async () => { disableCalls += 1; return { ok: true } },
  }
  const ignored = fakeCtrl.maybeTriggerScheduledReflection({
    type: 'user/message',
    time: Date.parse('2026-11-24T15:40:00Z'),
    data: { content: [{ type: 'text', text: REFLECTION_SCHEDULE_PROMPT }] },
  })
  assert.equal(ignored, false)
  assert.equal(startedCalls.length, 0)
  assert.equal(disableCalls, 1)

  reflectionEnabled = true
  const triggered = fakeCtrl.maybeTriggerScheduledReflection({
    type: 'user/message',
    time: Date.parse('2026-11-24T15:40:00Z'),
    data: { content: [{ type: 'text', text: REFLECTION_SCHEDULE_PROMPT }] },
  })
  assert.equal(triggered, true)
  assert.equal(startedCalls.length, 1)
  assert.equal(startedCalls[0].forDate, '2026-11-24')
  assert.equal(startedCalls[0].trigger, 'schedule')

  const triggeredCatchup = fakeCtrl.maybeTriggerScheduledReflection({
    type: 'user/message',
    time: Date.parse('2026-11-25T01:00:00Z'),
    data: { content: [{ type: 'text', text: REFLECTION_CATCHUP_PROMPT('2026-11-24') }] },
  })
  assert.equal(triggeredCatchup, true)
  assert.equal(startedCalls.length, 2)
  assert.equal(startedCalls[1].forDate, '2026-11-24')
  assert.equal(startedCalls[1].trigger, 'catchup')

  const source = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
  const start = source.indexOf("url.pathname.endsWith('/reflection/run')")
  const end = source.indexOf("url.pathname.endsWith('/ensure')", start)
  assert.ok(start >= 0 && end > start, 'reflection/run handler exists')
  const handler = source.slice(start, end)
  assert.match(handler, /startReflectionRun/)
  assert.doesNotMatch(handler, /sessionController[.]prompt/, 'handler must not prompt Chat')
  assert.match(handler, /202/)
  assert.match(handler, /503/)
  // Due-time fallback: no reminder event, still starts exactly once.
  reflectionEnabled = true
  writeReflectionState(dir, { ...readReflectionState(dir), lastCompletedDate: '2026-11-26', activeRunId: null, lastAttemptAt: null })
  const dueAt = Date.parse('2026-11-27T15:50:00Z')
  const due = await service.reflectionDueCheck('test', dueAt)
  assert.equal(due.ok, true)
  assert.equal(due.queued, true, JSON.stringify(due))
  assert.equal(due.forDate, '2026-11-27')
  const persistedDue = readReflectionState(dir)
  assert.equal(persistedDue.phase, 'running')
  assert.equal(persistedDue.forDate, '2026-11-27')
  assert.equal(persistedDue.attempts, 1)
  assert.ok(Number.isFinite(persistedDue.dueAt))
  const dueAgain = await service.reflectionDueCheck('test', dueAt)
  assert.equal(dueAgain.ok, true)
  assert.equal(Boolean(dueAgain.queued), false, 'same due run must not create another ticket')
  assert.ok(['active', 'attempted_today', 'already_running'].includes(dueAgain.skipped) || dueAgain.already_running, JSON.stringify(dueAgain))
  assert.match(REFLECTION_SCHEDULE_PROMPT, /发起失败或未尝试/)
  assert.doesNotMatch(REFLECTION_SCHEDULE_PROMPT, /已自动尝试发起/)

  // Explicit phase/date/dueAt/attempts stay machine-readable and are the
  // fields the status text is built from. Old fields remain present.
  const today = reflectionDate(Date.now())
  const dueState = { ...readReflectionState(dir), phase: 'due', forDate: today, dueAt: Date.now() + 60_000, attempts: 0, activeRunId: null, lastCompletedDate: null, lastStatus: null, lastError: null, skipReason: null }
  writeReflectionState(dir, dueState)
  const dueStatus = service.reflectionStatusSummary()
  assert.equal(dueStatus.phase, 'due')
  assert.equal(dueStatus.forDate, today)
  assert.equal(dueStatus.attempts, 0)
  assert.match(dueStatus.statusText, /今天 .* 23:40 应跑；当前 due/)
  assert.equal(dueStatus.lastCompletedDate, null, 'old field remains present')

  const runningState = { ...dueState, phase: 'running', attempts: 1, activeRunId: due.runId, lastStatus: 'running' }
  writeReflectionState(dir, runningState)
  const runningStatus = service.reflectionStatusSummary()
  assert.equal(runningStatus.phase, 'running')
  assert.equal(runningStatus.attempts, 1)
  assert.match(runningStatus.statusText, /当前 running；runId=ticket_reflect_/)
  assert.match(runningStatus.statusText, /第 1 次尝试/)

  writeReflectionState(dir, { ...runningState, phase: 'completed', attempts: 1, activeRunId: null, lastCompletedDate: today, lastStatus: 'done', lastError: null })
  const completedStatus = service.reflectionStatusSummary()
  assert.equal(completedStatus.phase, 'completed')
  assert.equal(completedStatus.lastCompletedDate, today)
  assert.match(completedStatus.statusText, /当前 completed/)
  // A completed state from yesterday must not leak into today's status.
  const yesterday = reflectionDate(Date.now() - 24 * 60 * 60 * 1000)
  writeReflectionState(dir, { ...completedStatus, phase: 'completed', forDate: yesterday, lastCompletedDate: yesterday, activeRunId: null })
  const rolled = service.reflectionStatusSummary()
  assert.notEqual(rolled.phase, 'completed', 'yesterday completed must not be today completed')
  assert.equal(rolled.forDate, today)
  const legacy = { ...readReflectionState(dir), lastCompletedDate: today, lastStatus: 'done', activeRunId: null }
  delete legacy.phase
  delete legacy.forDate
  writeFileSync(join(dir, 'reflections', 'state.json'), JSON.stringify(legacy))
  assert.equal(service.reflectionStatusSummary().phase, 'completed', 'old state without phase stays readable')

  writeReflectionState(dir, { ...runningState, phase: 'failed', activeRunId: null, lastStatus: 'failed', lastError: 'boom' })
  assert.equal(service.reflectionStatusSummary().phase, 'failed')
  assert.match(service.reflectionStatusSummary().statusText, /最近错误：boom/)
  writeReflectionState(dir, { ...runningState, phase: 'skipped', activeRunId: null, lastStatus: 'skipped', skipReason: 'settings disabled', lastError: null })
  assert.equal(service.reflectionStatusSummary().phase, 'skipped')
  assert.match(service.reflectionStatusSummary().statusText, /跳过原因：settings disabled/)
  console.log('reflection run api ok')
} finally { rmSync(dir, { recursive: true, force: true }) }