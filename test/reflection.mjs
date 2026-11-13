import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { createFixture } from './support/ria-fixture.mjs'
import { makeReflectionRun, querySession, readArchiveSession, writeReflectionReport } from '../lib/reflection.mjs'

const base = Date.UTC(2026, 10, 14, 9, 0, 0)
const t = offset => base + offset
const unitStateDir = mkdtempSync(join(tmpdir(), 'dsh-ria-refl-'))
const run = makeReflectionRun({
  runId: 'refl-unit',
  forDate: '2026-11-14',
  windowStart: '2026-11-14T00:00:00.000Z',
  windowEnd: '2026-11-15T00:00:00.000Z',
  createdAt: base,
}, { stateDir: unitStateDir })

const events = [
  { type: 'turn/start', time: t(0), data: { turn: 1 } },
  { type: 'system/message', time: t(1), data: { content: 'system' } },
  { type: 'user/message', time: t(2), data: { turn: 1, content: [{ type: 'text', text: 'do the thing' }], source: { kind: 'user' } } },
  {
    type: 'assistant/message', time: t(3), data: {
      turn: 1, step: 1, message: {
        content: [
          { type: 'reasoning', text: 'first thought' },
          { type: 'text', text: 'first answer' },
          { type: 'tool-call', name: 'read', arguments: '{"path":"a.txt"}' },
        ],
      },
    },
  },
  { type: 'tool/call', time: t(4), data: { turn: 1, step: 1, callId: 'c1', name: 'read', arguments: '{"path":"a.txt"}' } },
  { type: 'tool/result', time: t(5), data: { turn: 1, step: 1, toolCallId: 'c1', content: [{ type: 'text', text: 'file body' }] } },
  {
    type: 'assistant/message', time: t(6), data: {
      turn: 1, step: 2, message: { content: [{ type: 'reasoning', text: 'second thought' }, { type: 'text', text: 'final answer' }] },
    },
  },
  { type: 'turn/end', time: t(7), data: { turn: 1, reason: { kind: 'completed' } } },
  { type: 'user/message', time: t(8), data: { turn: 2, content: [{ type: 'text', text: 'host note' }], source: { kind: 'system' } } },
]

const summary = querySession({ run, events, mode: 'summary', seenRefs: new Set() })
assert.equal(summary.ok, true)
assert.equal(summary.mode, 'summary')
assert.equal(summary.window.from, '2026-11-14T00:00:00.000Z')
assert.equal(summary.stats.messages, 3)
assert.equal(summary.messages.filter(item => item.role === 'assistant').length, 1)
assert.equal(summary.messages.find(item => item.role === 'user').text, 'do the thing')
assert.equal(summary.messages.filter(item => item.role === 'user').at(-1).injected, true)
const idleNote = querySession({
  run,
  events: [{ type: 'user/message', time: t(8), data: { turn: 2, content: [{ type: 'text', text: '[Worker idle]\nworker session-1 finished.' }], source: { kind: 'user' } } }],
  mode: 'summary',
  seenRefs: new Set(),
})
assert.equal(idleNote.messages[0].injected, true)
const longEvents = [
  { type: 'user/message', time: t(2), data: { turn: 1, content: [{ type: 'text', text: 'y'.repeat(2500) }], source: { kind: 'user' } } },
  { type: 'assistant/message', time: t(3), data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'still visible' }] } } },
  { type: 'tool/call', time: t(4), data: { turn: 1, step: 1, callId: 'c9', name: 'read', arguments: '{"path":"b.txt"}' } },
  { type: 'tool/result', time: t(5), data: { turn: 1, step: 1, toolCallId: 'c9', content: [{ type: 'text', text: 'body' }] } },
]
const longSummary = querySession({ run, events: longEvents, mode: 'summary', seenRefs: new Set() })
assert.equal(longSummary.messages[0].text.length, 1000)
assert.ok(longSummary.messages.some(item => item.role === 'assistant' && item.text === 'still visible'))
assert.ok(longSummary.messages.some(item => item.role === 'tool' && item.brief.name === 'read'))
const longFull = querySession({ run, events: longEvents, mode: 'full', from: 0, to: 4, seenRefs: new Set() })
assert.equal(longFull.messages[0].text.length, 2000)
assert.ok(longFull.messages.some(item => item.role === 'assistant' && item.text === 'still visible'))
assert.ok(summary.messages.some(item => item.role === 'thinking' && item.brief.preview.includes('first thought')))
assert.ok(summary.messages.some(item => item.role === 'tool' && item.brief.name === 'read' && item.brief.ok === true && item.brief.preview.includes('a.txt')))
assert.equal(summary.messages.filter(item => item.role === 'assistant').map(item => item.text).includes('first answer'), false)
assert.ok(summary.messages.every(item => typeof item.ref === 'string' && item.ref.startsWith('e')))

const toolRef = summary.messages.find(item => item.role === 'tool').ref
const full = querySession({ run, events, mode: 'full', refs: [toolRef], seenRefs: new Set([toolRef]) })
assert.equal(full.ok, true)
assert.equal(full.mode, 'full')
assert.ok(full.messages.some(item => item.role === 'tool' && item.text.includes('a.txt')))
assert.ok(full.messages.some(item => item.role === 'tool' && item.text.includes('file body')))

const noWindow = querySession({ run, events, mode: 'full' })
assert.equal(noWindow.code, 'invalid_window')
const mixed = querySession({ run, events, mode: 'summary', from: '2026-11-14T08:00:00.000Z', to: 3 })
assert.equal(mixed.code, 'invalid_window')
const numeric = querySession({ run, events, mode: 'summary', from: 2, to: 8 })
assert.deepEqual(numeric.window, { from: 2, to: 8 })
assert.equal(numeric.messages.some(item => item.text === 'host note'), false)
const clipped = querySession({ run, events, mode: 'summary', maxChars: 20 })
assert.equal(clipped.truncated, true)
assert.ok(clipped.stats.omittedChars > 0)
const badRefs = querySession({ run, events, mode: 'full', refs: Array.from({ length: 51 }, (_, i) => 'e' + i) })
assert.equal(badRefs.code, 'invalid_refs')
const pastRef = querySession({ run, events, mode: 'full', refs: ['e2'], seenRefs: new Set() })
assert.equal(pastRef.truncated, true)

// Archive reading skips a torn/corrupt frame and never rewrites the log.
const home = mkdtempSync(join(tmpdir(), 'dsh-ria-home-'))
const sessionDir = join(home, 'sessions', '--workspace--', 'session-archive')
mkdirSync(sessionDir, { recursive: true })
const line = value => Buffer.from(JSON.stringify(value) + '\n')
const good = Buffer.concat([
  line({ type: 'session', version: 4, id: 'session-archive' }),
  line(events[2]),
  line(events[4]),
])
const file = join(sessionDir, 'session.v4.jsonl.zstd')
writeFileSync(file, Buffer.concat([zstdCompressSync(good), zstdCompressSync(Buffer.from('{not json\n')), zstdCompressSync(line(events[5]))]))
const archive = readArchiveSession('session-archive', { dshHome: home })
assert.equal(archive.corruptFrames, 1)
assert.equal(archive.events.length, 3)
const beforeArchive = readFileSync(file)
assert.deepEqual(readFileSync(file), beforeArchive)

const runReport = makeReflectionRun({ runId: 'refl-report', forDate: '2026-11-14', stateDir: join(home, 'state') }, { stateDir: join(home, 'state') })
runReport.status = 'running'
const report = writeReflectionReport({ run: runReport, markdown: '# hi\n', status: 'partial', counts: { messages: 1 } })
assert.equal(report.ok, true)
assert.equal(report.bytes, 5)
assert.equal(statSync(report.path).mode & 0o777, 0o600)
const tooLarge = writeReflectionReport({ run: runReport, markdown: 'x'.repeat(30721), status: 'partial', counts: {} })
assert.equal(tooLarge.code, 'report_too_large')
const empty = writeReflectionReport({ run: runReport, markdown: '', status: 'partial', counts: {} })
assert.equal(empty.code, 'report_empty')

const fixture = await createFixture({ sessionEvents: { 'session-ria': events } })
try {
  assert.equal(fixture.installed.has('ria_reflect_status'), false)
  const opened = fixture.service.openReflectionRun({ runId: 'refl-run-1', candidates: ['session-ria'], windowStart: Date.now() - 1000, windowEnd: Date.now() + 60000 })
  const spawned = await fixture.call('ria_spawn', { cwd: fixture.stateDir, reflectionRunId: opened.runId, title: 'Reflector' })
  assert.equal(spawned.ok, true)
  assert.equal(spawned.reflectionRunId, opened.runId)
  const reflectId = spawned.sessionId
  assert.equal(fixture.service.reflectionBindings.get(reflectId), opened.runId)
  const tools = fixture.agentTools.get(reflectId)
  assert.ok(tools)
  assert.deepEqual([...tools.keys()].sort(), ['ria_reflect_read_context', 'ria_reflect_read_session', 'ria_reflect_read_sessions', 'ria_reflect_read_tickets', 'ria_reflect_report', 'ria_reflect_status'])
  assert.equal(tools.has('ria_ticket'), false)
  assert.equal(fixture.installed.has('ria_reflect_status'), false)

  const call = (name, args = {}) => tools.get(name).execute(args, { agent: { id: reflectId }, signal: new AbortController().signal, concludeTurn() {} })
  const status = await call('ria_reflect_status')
  assert.equal(status.runId, opened.runId)
  assert.equal(status.state, 'running')
  assert.equal(status.candidates.some(item => item.sessionId === reflectId), true)
  assert.equal(status.reportPath, join(fixture.stateDir, 'reflections', 'runs', 'refl-run-1', 'report.partial.md'))

  const listed = await call('ria_reflect_read_sessions')
  assert.ok(listed.sessions.some(item => item.sessionId === 'session-ria'))

  const sessionSummary = await call('ria_reflect_read_session', { sessionId: 'session-ria', mode: 'summary', from: 0, to: 9 })
  assert.equal(sessionSummary.ok, true)
  assert.equal(sessionSummary.mode, 'summary')
  assert.equal(sessionSummary.messages.filter(item => item.role === 'assistant').length, 1)
  const assistantRef = sessionSummary.messages.find(item => item.role === 'assistant').ref
  const sessionFull = await call('ria_reflect_read_session', { sessionId: 'session-ria', mode: 'full', refs: [assistantRef] })
  assert.equal(sessionFull.ok, true)
  assert.equal(sessionFull.mode, 'full')
  assert.ok(sessionFull.messages.some(item => item.role === 'assistant' && item.text === 'final answer'))
  const sessionRange = await call('ria_reflect_read_session', { sessionId: 'session-ria', mode: 'full', from: 3, to: 7 })
  assert.ok(sessionRange.messages.some(item => item.role === 'assistant' && item.text === 'first answer'))
  assert.ok(sessionRange.messages.some(item => item.role === 'assistant' && item.text === 'final answer'))

  const denied = await call('ria_reflect_read_session', { sessionId: 'session-worker' })
  assert.equal(denied.code, 'session_not_allowed')

  fixture.setRunning(reflectId, true)
  const ticket = await fixture.call('ria_ticket', { goal: 'reflect this', executor: reflectId })
  assert.ok(ticket.ticket)
  const tickets = await call('ria_reflect_read_tickets', { scope: 'window' })
  assert.equal(tickets.tickets.some(item => item.ticketId === ticket.ticket.ticketId), true)
  assert.equal(tickets.tickets.find(item => item.ticketId === ticket.ticket.ticketId).goal, 'reflect this')

  writeFileSync(join(fixture.stateDir, 'memory.md'), 'remember sk-secret-value\n')
  const memory = await call('ria_reflect_read_context', { kind: 'memory' })
  assert.equal(memory.text.includes('sk-secret-value'), false)
  assert.ok(memory.text.includes('[redacted]'))

  const written = await call('ria_reflect_report', { markdown: '# reflection\n', status: 'partial', counts: { messages: 1 } })
  assert.equal(written.ok, true)
  assert.equal(statSync(written.path).mode & 0o777, 0o600)
  const injected = await call('ria_reflect_report', { markdown: '# x\n', status: 'partial', counts: {}, path: '/tmp/nope' })
  assert.equal(injected.code, 'invalid_argument')

  const statusTool = tools.get('ria_reflect_status')
  fixture.service.closeReflectionRun(opened.runId, 'completed')
  const closed = await statusTool.execute({}, { agent: { id: reflectId }, signal: new AbortController().signal, concludeTurn() {} })
  assert.equal(closed.code, 'run_closed')
  assert.equal(fixture.service.reflectionBindings.has(reflectId), false)
} finally {
  fixture.cleanup()
}

rmSync(unitStateDir, { recursive: true, force: true })
rmSync(home, { recursive: true, force: true })
console.log('reflection ok')
