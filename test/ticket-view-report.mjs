import assert from 'node:assert/strict'
import { Controller, selectLatestReport, deriveTicketSummary } from '../lib/core/controller.mjs'

const report = (id, status, summary = id) => ({ reportId: id, status, summary, evidence: [] })
const ticket = (status, extra = {}) => ({
  ticketId: 't1', status, waitingOn: status === 'blocked' ? 'user' : 'none',
  goal: 'goal', acceptance: 'acceptance', executor: 'self',
  resolution: null, failure: null, blockedReason: '', attention: null,
  progress: null, createdAt: 1, updatedAt: 2, ...extra,
})

// Terminal tickets prefer their own status, then any terminal, then the last report.
const doneTicket = ticket('done', { resolution: { summary: 'done summary' } })
const blockedTicket = ticket('blocked')
const failedTicket = ticket('failed')
assert.equal(selectLatestReport(doneTicket, [report('r1', 'progress'), report('r2', 'done'), report('r3', 'progress')]).reportId, 'r2')
assert.equal(selectLatestReport(blockedTicket, [report('r1', 'done'), report('r2', 'blocked'), report('r3', 'progress')]).reportId, 'r2')
assert.equal(selectLatestReport(failedTicket, [report('r1', 'progress'), report('r2', 'done'), report('r3', 'failed'), report('r4', 'progress')]).reportId, 'r3')
// No matching status: choose the nearest terminal report, not a trailing progress.
assert.equal(selectLatestReport(doneTicket, [report('r1', 'progress'), report('r2', 'blocked'), report('r3', 'progress')]).reportId, 'r2')
// No terminal report: fall back to the last report (including cancelled).
assert.equal(selectLatestReport(doneTicket, [report('r1', 'progress'), report('r2', 'failed')]).reportId, 'r2')
assert.equal(selectLatestReport(ticket('cancelled'), [report('r1', 'done'), report('r2', 'progress')]).reportId, 'r2')
assert.equal(selectLatestReport(doneTicket, []), null)
assert.equal(selectLatestReport(null, [report('r1', 'done')]), null)

// Derived summary is read-only and status-specific.
const doneView = Controller.prototype.ticketView.call({
  state: { data: { tickets: {} }, reportsFor: () => [report('p', 'progress'), report('d', 'done'), report('t', 'progress')] },
  ticketHealth: () => ({ activeTurn: null, lastEventAgeMinutes: 0, stuckSuspect: false, stuckReason: null }),
}, doneTicket)
assert.equal(doneView.latestReport.reportId, 'd')
assert.equal(doneView.summary, 'done summary')
assert.deepEqual(doneView.resolution, { summary: 'done summary' })

const resolved = (status, fields) => deriveTicketSummary(ticket(status, fields), null)
assert.equal(resolved('done', { resolution: { summary: '  done summary  ' } }), 'done summary')
assert.equal(resolved('cancelled', { resolution: { reason: 'cancelled reason', summary: 'ignored' } }), 'cancelled reason')
assert.equal(resolved('cancelled', { resolution: { summary: 'fallback summary' } }), 'fallback summary')
assert.equal(resolved('failed', { failure: { message: 'failed message' } }), 'failed message')
assert.equal(deriveTicketSummary(ticket('failed'), report('x', 'progress', 'report fallback')), 'report fallback')
assert.equal(resolved('blocked', { blockedReason: 'blocked reason' }), 'blocked reason')
assert.equal(resolved('blocked', { attention: { question: 'attention question' } }), 'attention question')
assert.equal(deriveTicketSummary(ticket('blocked'), report('x', 'blocked', 'blocked report')), 'blocked report')
assert.equal(resolved('working', { progress: { lastPhase: 'working phase' } }), 'working phase')
assert.equal(deriveTicketSummary(ticket('open'), report('x', 'progress', 'open report')), 'open report')
assert.equal(resolved('working', {}), null)
const blocked = ticket('blocked', { blockedReason: 'kept' })
deriveTicketSummary(blocked, null)
assert.equal(blocked.resolution, null, 'derived summary must not write resolution')
assert.equal(blocked.blockedReason, 'kept')
console.log('ticket report selection ok')
