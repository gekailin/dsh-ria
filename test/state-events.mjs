import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { StateStore } from '../lib/store/store.mjs'
import { EventLog } from '../lib/state/event-log.mjs'

const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex')
const seed = () => ({
  schemaVersion: 1, chatSessionId: 'chat', sageSessionId: null, executors: {}, tickets: {},
  requests: { req1: { requestId: 'req1', ticketId: 't1', goal: 'g', createdAt: 1 } },
  reports: [{ reportId: 'rep1', ticketId: 't1', summary: 's', at: 2 }],
  workOrders: { t1: { ticketId: 't1', summary: 'work', steps: [] } },
  inbox: [{ id: 'in1', ticketId: 't1', executorId: 'w1', message: 'm', at: 3 }],
  ticketFeedback: [{ feedbackId: 'fb1', ticketId: 't1', kind: 'note', at: 4 }],
  lessonCandidates: [{ id: 'lc1', status: 'candidate', scenario: 's', at: 5 }],
  meta: { executorSeq: 0, reflectionSeq: 0 }, lastError: null,
})

const dir = mkdtempSync(join(tmpdir(), 'ria-events-'))
try {
  writeFileSync(join(dir, 'state.json'), JSON.stringify(seed(), null, 2))
  const warnings = []
  const store = new StateStore(dir, { eventLog: true, onWarn: warning => warnings.push(warning) })
  const stateText = readFileSync(join(dir, 'state.json'), 'utf8')
  const state = JSON.parse(stateText)
  for (const key of ['requests', 'reports', 'workOrders', 'inbox', 'ticketFeedback', 'lessonCandidates']) assert.ok(!Object.hasOwn(state, key), 'state.json omits ' + key)
  assert.ok(statSync(join(dir, 'state.json')).size < 100 * 1024, 'control state under 100KB')
  assert.ok(readdirSync(dir).some(name => name.startsWith('state.json.bak.')), 'state backup exists')
  const kinds = new Set(readFileSync(join(dir, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line).kind))
  for (const kind of ['request.created', 'report.created', 'workorder.created', 'inbox.created', 'feedback.created']) assert.ok(kinds.has(kind), 'events contain ' + kind)
  assert.equal(kinds.has('lesson.created'), false, 'lesson candidates no longer enter events')
  const sample = JSON.parse(readFileSync(join(dir, 'events.jsonl'), 'utf8').split('\n')[0])
  assert.deepEqual(Object.keys(sample).sort(), ['at', 'kind', 'payload', 'ticketId'])
  assert.equal(store.request('req1').goal, 'g')
  assert.equal(store.reportsFor('t1').length, 1)
  assert.equal(store.workOrder('t1').summary, 'work')
  assert.equal(store.pendingInbox('t1', 'w1').length, 1)

  const beforeLines = readFileSync(join(dir, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).length
  const beforePrefix = readFileSync(join(dir, 'events.jsonl'), 'utf8').slice(0, 2000)
  for (let i = 0; i < 50; i += 1) store.addReport({ reportId: 'r' + i, ticketId: 't1', summary: 's' + i, at: 100 + i })
  const afterLines = readFileSync(join(dir, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).length
  assert.equal(afterLines, beforeLines + 50, 'append-only growth')
  assert.equal(readFileSync(join(dir, 'events.jsonl'), 'utf8').slice(0, beforePrefix.length), beforePrefix, 'existing bytes unchanged')
  const stateMtime = statSync(join(dir, 'state.json')).mtimeMs
  const linesBeforeReload = afterLines
  const a = new StateStore(dir, { eventLog: true })
  const b = new StateStore(dir, { eventLog: true })
  assert.deepEqual(a.data.reports, b.data.reports)
  assert.equal(readFileSync(join(dir, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).length, linesBeforeReload, 'reload does not append')
  assert.equal(statSync(join(dir, 'state.json')).mtimeMs, stateMtime, 'reload does not rewrite state.json')

  // Bad line tolerance: append malformed JSON, then load the rest.
  appendFileSync(join(dir, 'events.jsonl'), '{bad line\n', 'utf8')
  const badWarnings = []
  const bad = new StateStore(dir, { eventLog: true, onWarn: warning => badWarnings.push(warning) })
  assert.equal(bad.data.reports.length, 51)
  assert.ok(badWarnings.length >= 1)

  // Caps: 510 requests, workorders, reports and feedback; inbox full.
  const capDir = mkdtempSync(join(tmpdir(), 'ria-events-cap-'))
  try {
    writeFileSync(join(capDir, 'state.json'), JSON.stringify({ meta: {}, requests: {}, reports: [], workOrders: {}, inbox: [], ticketFeedback: [], lessonCandidates: [] }))
    const cap = new StateStore(capDir, { eventLog: true })
    for (let i = 0; i < 510; i += 1) {
      cap.addRequest({ requestId: 'q' + i, ticketId: 't1', goal: 'g' + i })
      cap.addReport({ reportId: 'rp' + i, ticketId: 't1', summary: 's' })
      cap.setWorkOrder('t' + i, { ticketId: 't' + i, summary: 'w' })
      cap.addInbox({ id: 'i' + i, ticketId: 't1', executorId: 'w', message: 'm' })
    }
    cap.data.ticketFeedback = Array.from({ length: 510 }, (_, i) => ({ feedbackId: 'f' + i, ticketId: 't1', kind: 'x' }))
    cap.save()
    const rebuilt = new StateStore(capDir, { eventLog: true })
    assert.equal(Object.keys(rebuilt.data.requests).length, 500)
    assert.equal(Object.keys(rebuilt.data.workOrders).length, 500)
    assert.equal(rebuilt.data.reports.length, 500)
    assert.equal(rebuilt.data.ticketFeedback.length, 500)
    assert.equal(rebuilt.data.inbox.length, 510)
  } finally { rmSync(capDir, { recursive: true, force: true }) }

  // Rotation and retention are directly triggerable with small thresholds.
  const rotDir = mkdtempSync(join(tmpdir(), 'ria-events-rot-'))
  try {
    const log = new EventLog({ stateDir: rotDir, maxBytes: 120, retainDays: 1, now: () => 1_800_000_000_000 })
    for (let i = 0; i < 5; i += 1) log.append({ kind: 'report.created', ticketId: null, payload: { reportId: 'r' + i } })
    assert.ok(existsSync(join(rotDir, 'events.jsonl')))
    assert.ok(requireArchive(rotDir), 'rotation created an archive')
    const old = new EventLog({ stateDir: rotDir, maxBytes: 120, retainDays: 1, now: () => 1_800_100_000_000 })
    assert.equal(requireArchive(rotDir), false, 'retention removes old archive')
  } finally { rmSync(rotDir, { recursive: true, force: true }) }
  const fallbackDir = mkdtempSync(join(tmpdir(), 'ria-events-fallback-'))
  try {
    writeFileSync(join(fallbackDir, 'state.json'), JSON.stringify(seed()))
    const fallback = new StateStore(fallbackDir)
    assert.equal(fallback.request('req1').goal, 'g', 'legacy read path works without events.jsonl')
    assert.equal(existsSync(join(fallbackDir, 'events.jsonl')), false, 'legacy read does not create events.jsonl')
  } finally { rmSync(fallbackDir, { recursive: true, force: true }) }
  console.log('state events ok')
} finally { rmSync(dir, { recursive: true, force: true }) }

function requireArchive(dir) {
  return existsSync(dir) && readdirSync(dir).some(name => /^events-.*\.jsonl$/.test(name))
}