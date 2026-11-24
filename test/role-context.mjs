import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RiaService } from '../lib/index.js'
import { appendRoleContext, appendRoleContextAsync, pruneRoleContextFiles, readRoleContext, roleContextFile } from '../lib/role-context.mjs'
import { reflectionInstruction } from '../lib/prompts/reflection.mjs'
import { createFixture } from './support/ria-fixture.mjs'

const root = mkdtempSync(join(tmpdir(), 'ria-role-context-'))
try {
  // Fields + redaction.
  const at = Date.UTC(2026, 10, 21, 8, 0, 0)
  appendRoleContext(root, {
    at, role: 'router', ticketId: 'ticket_test', phase: 'dispatch', model: 'deterministic-affinity',
    durationMs: 12, attempt: 2, degraded: false, error: null,
    input: { goal: 'g', authorization: 'Bearer secret-token-abcdef', apiKey: 'sk-abcdefghijklmnop', cookie: 'session=abc' },
    output: { selected: 'session-a', reason: 'automatic' },
  })
  const file = roleContextFile(root, at)
  const first = JSON.parse(readFileSync(file, 'utf8').trim())
  for (const key of ['at', 'role', 'ticketId', 'phase', 'model', 'durationMs', 'attempt', 'degraded', 'error', 'input', 'output', 'inputHash', 'outputHash', 'truncated']) assert.ok(key in first, key)
  const raw = readFileSync(file, 'utf8')
  assert.ok(raw.includes('***'))
  assert.ok(!raw.includes('secret-token-abcdef'))
  assert.ok(!raw.includes('sk-abcdefghijklmnop'))
  assert.ok(!raw.includes('session=abc'))
  assert.equal(first.role, 'router')
  assert.equal(first.attempt, 2)

  // Oversized input is truncated and marked.
  const huge = 'x'.repeat(50000)
  appendRoleContext(root, { at, role: 'advisor', ticketId: 'ticket_huge', phase: 'advisor.plan', input: { prompt: huge }, output: { raw: huge } })
  const hugeEntry = JSON.parse(readFileSync(file, 'utf8').trim().split('\n').find(line => line.includes('ticket_huge')))
  assert.equal(hugeEntry.truncated, true)

  // A single oversized entry is kept with metadata + output summary, not dropped.
  const hugeRead = readRoleContext(root, { role: 'advisor', ticketId: 'ticket_huge', maxChars: 1200, now: at + 1000 })
  assert.equal(hugeRead.returned, 1)
  assert.equal(hugeRead.dropped, 0)
  assert.equal(hugeRead.truncatedEntries, 1)
  assert.equal(hugeRead.truncated, true)
  const kept = hugeRead.entries[0]
  for (const key of ['at', 'role', 'ticketId', 'phase', 'model', 'attempt', 'degraded', 'error']) assert.ok(key in kept, key)
  assert.equal(kept.ticketId, 'ticket_huge')
  assert.equal(kept.phase, 'advisor.plan')
  assert.equal(kept.truncated, true)
  assert.ok(typeof kept.output === 'string' && kept.output.length > 0)
  assert.ok(JSON.stringify(kept).length <= 1200)

  // Filters, limit and maxChars.
  const read = readRoleContext(root, { role: 'router', ticketId: 'ticket_test', limit: 20, maxChars: 20000, now: at + 1000 })
  assert.equal(read.total, 1)
  assert.equal(read.returned, 1)
  assert.equal(read.entries[0].ticketId, 'ticket_test')
  const limited = readRoleContext(root, { role: 'router', limit: 1, maxChars: 5, now: at + 1000 })
  assert.equal(limited.returned, 0)
  assert.equal(limited.truncatedCount, 1)

  // Retention: old file removed, current kept.
  const oldAt = at - 40 * 24 * 60 * 60 * 1000
  appendRoleContext(root, { at: oldAt, role: 'advisor', ticketId: 'old', input: {}, output: {} })
  const oldFile = roleContextFile(root, oldAt)
  const oldDate = new Date(oldAt)
  utimesSync(oldFile, oldDate, oldDate)
  const sinceFiltered = readRoleContext(root, { role: 'advisor', since: 1, now: at })
  assert.equal(sinceFiltered.entries.some(entry => entry.ticketId === 'old'), false)
  const removed = pruneRoleContextFiles(root, { retentionDays: 14, now: at })
  assert.equal(removed, 1)
  assert.ok(!readdirSync(root).includes('role-context-' + oldDate.toISOString().slice(0, 10) + '.jsonl'))

  // Write failure is swallowed.
  assert.equal(appendRoleContextAsync('/dev/null', { role: 'router' }, { log: () => {} }), null)
  const instruction = reflectionInstruction({ runId: 'r', forDate: '2026-11-20', windowStart: 1, windowEnd: 2, deadlineAt: 3 })
  assert.match(instruction, /ria_reflect_read_role_context/)
  assert.doesNotMatch(instruction, /复制到 reflections|把报告复制到/)
  assert.match(instruction, /canonical 由宿主/)

  // Tool handler returns the filtered payload.
  const fake = Object.create(RiaService.prototype)
  fake.stateDir = root
  fake.reflectionRunFor = () => ({ status: 'running' })
  fake.reflectionClosed = () => ({ ok: false, code: 'run_closed' })
  const tool = RiaService.prototype.toolReflectReadRoleContext.call(fake, 's', 'r', { role: 'router', ticketId: 'ticket_test', limit: 1 })
  assert.equal(tool.role, 'router')
  assert.equal(tool.returned, 1)

  // Compact mode trims verbose input.prompt and duplicate output.raw while keeping structured output.parsed.
  appendRoleContext(root, {
    at: at + 500, role: 'advisor', ticketId: 'ticket_parsed', phase: 'advisor.plan',
    input: { prompt: 'A'.repeat(6000) },
    output: { raw: JSON.stringify({ action: 'plan', workOrder: { summary: 'plan summary', steps: ['s1'] } }) + ' '.repeat(1000), parsed: { summary: 'plan summary', steps: ['s1'] } },
  })
  const compactWindow = readRoleContext(root, { role: 'advisor', ticketId: 'ticket_parsed', compact: true, maxChars: 20000, now: at + 1000 })
  assert.equal(compactWindow.returned, 1)
  assert.equal(compactWindow.entries[0].output.parsed.summary, 'plan summary')
  assert.ok(compactWindow.entries[0].input.prompt.length <= 401)
  assert.ok(compactWindow.entries[0].output.raw.length <= 201)

  console.log('role context ok')
} finally {
  rmSync(root, { recursive: true, force: true })
}

// Router + Advisor write points.
const fixture = await createFixture({
  stateDefault: true,
  advisorPlan: 'stateless',
  llmReply: JSON.stringify({ action: 'plan', workOrder: { summary: 'role context integration', steps: ['noop'] } }),
})
try {
  const chat = fixture.service.controller.state.chatSessionId
  const request = await fixture.callAs(chat, 'ria_chat_request', { goal: 'role context integration' })
  assert.equal(request.ok, true, JSON.stringify(request))
  await new Promise(resolve => setTimeout(resolve, 20))
  const entries = [
    ...readRoleContext(fixture.stateDir, { role: 'advisor', since: 1, limit: 50 }).entries,
    ...readRoleContext(fixture.stateDir, { role: 'router', since: 1, limit: 50 }).entries,
  ]
  const advisor = entries.find(item => item.role === 'advisor' && item.ticketId === request.ticketId)
  const router = entries.find(item => item.role === 'router' && item.ticketId === request.ticketId)
  assert.ok(advisor, 'advisor role-context entry missing')
  assert.equal(advisor.phase, 'advisor.plan')
  assert.ok(advisor.input.prompt.includes('输出契约'))
  assert.ok(advisor.output.raw.length > 0)
  assert.equal(advisor.degraded, false, 'empty SQLite cognition is healthy, not degraded')
  assert.ok(router, 'router role-context entry missing')
  assert.equal(router.phase, 'dispatch')
  assert.ok(Array.isArray(router.input.candidates))
  assert.ok(router.input.candidates.length > 0)
  assert.ok(Array.isArray(router.output.rejected))
} finally {
  fixture.cleanup()
}
