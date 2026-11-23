import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RiaService } from '../lib/index.js'
import { createFixture } from './support/ria-fixture.mjs'

const root = mkdtempSync(join(tmpdir(), 'ria-reflection-guards-'))
try {
  const service = Object.create(RiaService.prototype)
  service.stateDir = root
  service.log = () => {}
  const events = []
  service.routerEvents = { append: event => events.push(event) }
  const run = { runId: 'run-done', forDate: '2026-11-23' }
  service.updateReflectionState({ ...run, status: 'completed' })
  let state = JSON.parse(readFileSync(join(root, 'reflections', 'state.json'), 'utf8'))
  assert.equal(state.lastStatus, 'done')
  assert.equal(state.lastCompletedDate, '2026-11-23')
  assert.equal(state.activeRunId, null)
  assert.equal(state.lastRunId, 'run-done')
  const before = state.lastAttemptAt
  service.updateReflectionState({ ...run, status: 'completed' })
  state = JSON.parse(readFileSync(join(root, 'reflections', 'state.json'), 'utf8'))
  assert.equal(state.lastAttemptAt, before)
  service.updateReflectionState({ runId: 'run-failed', forDate: '2026-11-22', status: 'failed' })
  state = JSON.parse(readFileSync(join(root, 'reflections', 'state.json'), 'utf8'))
  assert.equal(state.lastStatus, 'failed')
  assert.equal(state.activeRunId, null)
  service.updateReflectionState({ runId: 'run-cancel', forDate: '2026-11-22', status: 'cancelled' })
  state = JSON.parse(readFileSync(join(root, 'reflections', 'state.json'), 'utf8'))
  assert.equal(state.lastStatus, 'cancelled')

  const good = service.reflectionSageAudit({ sageContextRead: true }, '## Sage 质量检查\n- cognition/chat/decisions.md — 锚点「a」 — 2026-11-20\n- cognition/chat/agreements.md — 锚点「b」 — 2026-11-21\n')
  assert.equal(good.ok, true, JSON.stringify(good))
  const noSection = service.reflectionSageAudit({ sageContextRead: true }, '## 问题与归因\nno sage\n')
  assert.equal(noSection.ok, false)
  assert.ok(noSection.problems.some(item => item.includes('section')))
  const noCall = service.reflectionSageAudit({ sageContextRead: false }, '## Sage 质量检查\n- a.md — 锚点 — 2026-11-20\n- b.md — 锚点 — 2026-11-21\n')
  assert.equal(noCall.ok, false)
  assert.ok(noCall.problems.some(item => item.includes('call')))
  const fewRefs = service.reflectionSageAudit({ sageContextRead: true }, '## Sage 质量检查\n- only one.md — 锚点 — 2026-11-20\n')
  assert.equal(fewRefs.ok, false)
  const marked = service.markReflectionSageMissing('---\nschema: 2\n---\nbody')
  assert.match(marked, /sage_audit: missing/)

  const fixture = await createFixture({ stateDefault: true })
  try {
    const controller = fixture.service.controller
    const request = await controller.requestTicket({ goal: 'canonical full', acceptance: 'report' }, { agent: { id: controller.state.chatSessionId } }, { mode: 'reflection' })
    controller.state.setTicketMeta(request.ticketId, { reflectionForDate: '2026-11-23' })
    const source = Buffer.from('# full report\n\n' + 'x'.repeat(9000) + '\n')
    const sourcePath = join(fixture.stateDir, 'executor-full.md'); writeFileSync(sourcePath, source)
    fixture.service.reflections = fixture.service.reflections || new Map()
    fixture.service.reflections.set(request.ticketId, { reportFinal: sourcePath })
    const result = fixture.service.writeReflectionCanonicalFromTicket(request.ticketId, { summary: 'short' })
    assert.equal(result.ok, undefined)
    assert.equal(result.reason, 'written')
    const target = readFileSync(result.path)
    assert.equal(createHash('sha256').update(target).digest('hex'), createHash('sha256').update(source).digest('hex'))
    // Write failure leaves an explicit marker, never a summary body.
    const targetPath = result.path
    writeFileSync(targetPath, '# changed\n')
    const ioWrite = (file, value) => {
      if (file === targetPath) throw Object.assign(new Error('read only'), { code: 'EROFS' })
      writeFileSync(file, value)
    }
    const failed = fixture.service.writeReflectionCanonicalFromTicket(request.ticketId, { summary: 'short' }, { ioWrite })
    assert.equal(failed.reason, 'write_failed')
    const marker = readFileSync(failed.markerPath, 'utf8')
    assert.match(marker, /EROFS/)
    assert.match(marker, /sourceSha256/)
    const failedEvents = fixture.service.routerEvents.query({ ticketId: request.ticketId }).events
    assert.ok(failedEvents.some(event => event.event === 'reflection.canonical.failed' && event.ticketId === request.ticketId),
      'canonical failure must emit reflection.canonical.failed')
  } finally { fixture.cleanup() }
  console.log('reflection guards ok')
} finally { rmSync(root, { recursive: true, force: true }) }
