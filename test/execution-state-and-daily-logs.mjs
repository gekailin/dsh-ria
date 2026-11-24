import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../lib/state/sqlite/db.mjs'
import { SqliteTicketRuntime } from '../lib/state/sqlite/runtime.mjs'
import { StateStore } from '../lib/store/store.mjs'
import { appendDailyLog, dailyLogFile, listDailyLogFiles, pruneDailyLogs } from '../lib/shared/daily-log.mjs'

const root = mkdtempSync(join(tmpdir(), 'ria-exec-logs-'))
try {
  // 1. Execution state migrates from legacy events.jsonl into 5 SQLite tables and persists cleanly.
  const stateDir = join(root, 'state')
  mkdirSync(stateDir, { recursive: true })
  writeFileSync(join(stateDir, 'events.jsonl'), [
    JSON.stringify({ at: 10, kind: 'request.created', ticketId: 'req1', payload: { requestId: 'req1', ticketId: 't1', goal: 'legacy req', createdAt: 10 } }),
    JSON.stringify({ at: 20, kind: 'workorder.created', ticketId: 't1', payload: { ticketId: 't1', summary: 'legacy plan', steps: ['a'] } }),
    JSON.stringify({ at: 30, kind: 'report.created', ticketId: 't1', payload: { reportId: 'rep1', ticketId: 't1', summary: 'legacy rep', at: 30 } }),
    JSON.stringify({ at: 40, kind: 'inbox.created', ticketId: 't1', payload: { id: 'in1', ticketId: 't1', executorId: 'w1', message: 'hi', at: 40 } }),
    JSON.stringify({ at: 50, kind: 'feedback.created', ticketId: 't1', payload: { feedbackId: 'fb1', ticketId: 't1', kind: 'note', at: 50 } }),
  ].join('\n') + '\n')

  const dbPath = join(stateDir, 'ria.sqlite')
  openDatabase(dbPath, { create: true }).close()

  const runtime = new SqliteTicketRuntime({ stateDir, dbPath })
  const state = new StateStore(stateDir, { sqlite: true, eventLog: false })
  runtime.attachState(state)

  assert.equal(state.request('req1').goal, 'legacy req')
  assert.equal(state.workOrder('t1').summary, 'legacy plan')
  assert.equal(state.reportsFor('t1').length, 1)
  assert.equal(state.pendingInbox('t1', 'w1').length, 1)
  assert.equal(state.data.ticketFeedback.length, 1)

  // New writes land in SQLite tables directly.
  state.setWorkOrder('t2', { ticketId: 't2', summary: 'sql plan', steps: ['b'] })
  state.addReport({ reportId: 'rep2', ticketId: 't2', summary: 'sql rep', at: 60 })
  state.markInboxDelivered(['in1'], 70)
  assert.equal(runtime.db.prepare('SELECT COUNT(*) n FROM work_orders').get().n, 2)
  assert.equal(runtime.db.prepare('SELECT COUNT(*) n FROM ticket_reports').get().n, 2)
  assert.equal(runtime.db.prepare('SELECT delivered_at FROM executor_inbox WHERE id=?').get('in1').delivered_at, 70)
  await runtime.close()

  // Fresh reload without events.jsonl recovers everything from SQLite.
  rmSync(join(stateDir, 'events.jsonl'))
  const runtime2 = new SqliteTicketRuntime({ stateDir, dbPath })
  const state2 = new StateStore(stateDir, { sqlite: true, eventLog: false })
  runtime2.attachState(state2)
  assert.equal(state2.workOrder('t2').summary, 'sql plan')
  assert.equal(state2.reportsFor('t2')[0].reportId, 'rep2')
  assert.equal(state2.pendingInbox('t1', 'w1').length, 0, 'delivered inbox stays delivered')
  await runtime2.close()

  // 2. Daily log layout: stateDir/logs/YYYY-MM-DD/{router-events,role-context,audit}.jsonl
  const logDir = join(root, 'logs-test')
  const oldAt = Date.parse('2026-01-01T12:00:00Z')
  const nowAt = Date.parse('2026-11-24T12:00:00Z')
  appendDailyLog(logDir, 'router-events.jsonl', { ts: oldAt, event: 'old' }, { at: oldAt })
  appendDailyLog(logDir, 'role-context.jsonl', { at: new Date(oldAt).toISOString(), role: 'advisor' }, { at: oldAt })
  appendDailyLog(logDir, 'audit.jsonl', { at: oldAt, event: 'grant/applied' }, { at: oldAt })
  appendDailyLog(logDir, 'router-events.jsonl', { ts: nowAt, event: 'new' }, { at: nowAt })
  assert.equal(existsSync(dailyLogFile(logDir, 'router-events.jsonl', nowAt)), true)
  assert.equal(listDailyLogFiles(logDir, 'router-events.jsonl').length, 2)

  // Pruning with retentionDays=30 drops old router-events & role-context (14d), keeps audit (365d).
  const pruned = pruneDailyLogs(logDir, { now: nowAt })
  assert.equal(pruned, 2)
  assert.equal(existsSync(dailyLogFile(logDir, 'router-events.jsonl', oldAt)), false)
  assert.equal(existsSync(dailyLogFile(logDir, 'role-context.jsonl', oldAt)), false)
  assert.equal(existsSync(dailyLogFile(logDir, 'audit.jsonl', oldAt)), true)
  assert.equal(existsSync(dailyLogFile(logDir, 'router-events.jsonl', nowAt)), true)

  console.log('execution state sqlite and daily logs ok')
} finally {
  rmSync(root, { recursive: true, force: true })
}
