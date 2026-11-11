import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { RiaService } from '../lib/index.js'

function writeState(dir, tasks, deliveries = [], inFlight = undefined) {
  const state = {
    version: 1,
    riaSessionId: 'session-ria',
    riaPreset: 'ptc',
    tasks,
    deliveries,
    grants: [],
  }
  if (inFlight !== undefined) state.inFlight = inFlight
  writeFileSync(join(dir, 'ria.json'), JSON.stringify(state, null, 2))
}

function ticket(overrides = {}) {
  return {
    goal: 'finish the long task',
    acceptance: 'tests pass',
    executor: 'session-worker',
    status: 'working',
    blockedReason: '',
    createdAt: 1,
    updatedAt: 1,
    recoveryCount: 0,
    ...overrides,
  }
}

function harness(options = {}) {
  const prompts = []
  const tools = new Map()
  const attachments = []
  const riaAgent = {
    id: 'session-ria',
    ctx: {
      tools: { register(definition) { tools.set(definition.name, definition); return () => {} } },
      systemPrompt: { section(section) { tools.set('prompt:' + section.name, section); return () => {} } },
    },
    session: { append() { return { seq: 1, time: 1 } } },
  }
  const workspace = {
    id: 'workspace-ria',
    path: options.stateDir,
    async attachSession(id) { attachments.push(id) },
  }
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    workspaceRegistry: { async create() { return workspace } },
    sessionController: {
      async resolveAgent(id) {
        if (String(id) === 'session-ria') {
          if (options.resolveError) return { error: { code: 'session/unavailable', message: 'boom' } }
          return { agent: riaAgent }
        }
        return { error: { code: 'session/not-found', message: 'not found' } }
      },
      async list() {
        return { items: [
          { sessionId: 'session-ria', running: false, blank: false, updatedAt: 1 },
          { sessionId: 'session-worker', running: true, blank: false, updatedAt: 2, cwd: options.stateDir },
        ] }
      },
      async prompt(request, signal) {
        assert.ok(signal instanceof AbortSignal)
        prompts.push(request)
        return { accepted: true }
      },
    },
  }
  return { ctx, prompts, tools, attachments }
}

// A ticket already at the recovery limit is stopped once: blocked with a
// failure code and one recovery_exhausted card, and no recovery prompt.
const dir = mkdtempSync(join(tmpdir(), 'dsh-ria-startup-'))
try {
  writeState(dir, [{
    taskId: 'task_exhausted',
    ...ticket({ recoveryCount: 3 }),
  }])
  const first = harness({ stateDir: dir })
  const service = new RiaService(first.ctx, dir)
  await service.startup()
  assert.equal(first.prompts.length, 0)
  const saved = JSON.parse(readFileSync(join(dir, 'ria.json'), 'utf8'))
  assert.equal(saved.tickets[0].status, 'blocked')
  assert.match(saved.tickets[0].blockedReason, /自动恢复已达上限/)
  assert.equal(saved.tickets[0].failure.code, 'recovery_exhausted')
  const feedback = saved.ticketFeedback.find(item => item.ticketId === 'task_exhausted' && item.kind === 'recovery_exhausted')
  assert.ok(feedback)
  assert.equal(feedback.card, true)
  assert.equal(feedback.mirror, true)
  assert.equal(saved.inFlight, undefined)

  // A second startup has nothing left to report: the exhausted ticket is blocked.
  const againHarness = harness({ stateDir: dir })
  await new RiaService(againHarness.ctx, dir).startup()
  assert.equal(againHarness.prompts.length, 0)

  const statusTool = first.tools.get('ria_status')
  const snapshot = await statusTool.execute({ scope: 'tickets' }, { signal: new AbortController().signal })
  assert.equal(snapshot.tickets[0].status, 'blocked')
  assert.match(snapshot.tickets[0].blockedReason, /自动恢复已达上限/)

  const ticketTool = first.tools.get('ria_ticket')
  assert.ok(ticketTool)
  const exec = { signal: new AbortController().signal, concludeTurn() {} }
  const updated = await ticketTool.execute({ ticketId: 'task_exhausted', status: 'open' }, exec)
  assert.equal(updated.ticket.status, 'open')
  assert.equal(updated.ticket.recoveryCount, 0)
  assert.equal(updated.ticket.blockedReason, '')

  service.store.updateTicket('task_exhausted', { recovery: { count: 2 } })
  const requestTool = first.tools.get('ria_request')
  const dispatched = await requestTool.execute({ targetSessionIds: ['session-worker'], message: 'continue', ticketId: 'task_exhausted', note: '已让 Worker 继续执行未完成任务。' }, exec)
  assert.equal(dispatched.results[0].ok, true)
  assert.equal(service.store.ticket('task_exhausted').recovery.count, 0)

  const retryDir = mkdtempSync(join(tmpdir(), 'dsh-ria-startup-retry-'))
  try {
    writeState(retryDir, [{
      taskId: 'task_retry',
      ...ticket({ goal: 'retry after restart', acceptance: '', recoveryCount: 3 }),
    }], [{
      deliveryId: 'delivery_retry',
      targetSessionId: 'session-worker',
      requestId: 'req_retry',
      taskId: 'task_retry',
      content: [{ type: 'text', text: 'continue' }],
      mode: 'queue',
      createdAt: 1,
    }])
    const third = harness({ stateDir: retryDir })
    const retried = new RiaService(third.ctx, retryDir)
    await retried.startup()
    assert.equal(third.prompts.length, 2)
    assert.equal(third.prompts[0].sessionId, 'session-worker')
    assert.equal(third.prompts[1].sessionId, 'session-ria')
    assert.equal(retried.store.ticket('task_retry').status, 'working')
    assert.equal(retried.store.ticket('task_retry').recovery.count, 1)
    assert.equal(retried.store.ticket('task_retry').blockedReason, '')
  } finally {
    rmSync(retryDir, { recursive: true, force: true })
  }

  const errorDir = mkdtempSync(join(tmpdir(), 'dsh-ria-startup-error-'))
  try {
    writeState(errorDir, [{
      taskId: 'task_error',
      ...ticket({ goal: 'should be reported' }),
    }])
    const second = harness({ stateDir: errorDir, resolveError: true })
    const broken = new RiaService(second.ctx, errorDir)
    await broken.startup()
    assert.equal(second.prompts.length, 1)
    const failureText = second.prompts[0].content[0].text
    assert.match(failureText, /启动恢复失败/)
    assert.match(failureText, /boom/)
    assert.match(failureText, /手动处理/)
  } finally {
    rmSync(errorDir, { recursive: true, force: true })
  }
} finally {
  rmSync(dir, { recursive: true, force: true })
}

// An intake left by a crash is recovered as a ticket: the prompt says to read
// Ria's own session and resolve it, and the counter advances.
const intakeDir = mkdtempSync(join(tmpdir(), 'dsh-ria-startup-intake-'))
try {
  writeState(intakeDir, [{
    taskId: 'task_intake',
    goal: '调查无人车底商 GPU 方案',
    executor: null,
    status: 'intake',
    createdAt: 1,
    updatedAt: 1,
    recoveryCount: 0,
  }])
  const intakeHarness = harness({ stateDir: intakeDir })
  const intakeService = new RiaService(intakeHarness.ctx, intakeDir)
  await intakeService.startup()
  assert.equal(intakeHarness.prompts.length, 1)
  const text = intakeHarness.prompts[0].content[0].text
  assert.match(text, /DSH 刚刚重启/)
  assert.match(text, /task_intake/)
  assert.match(text, /status=intake/)
  assert.match(text, /调查无人车底商 GPU 方案/)
  assert.match(text, /ria_resolve/)
  assert.match(text, /recovery=1\/3/)
  assert.match(text, /不要重复已完成的部分/)
  const saved = JSON.parse(readFileSync(join(intakeDir, 'ria.json'), 'utf8'))
  assert.equal(saved.tickets[0].recovery.count, 1)
  assert.equal(saved.inFlight, undefined)
} finally {
  rmSync(intakeDir, { recursive: true, force: true })
}

// Intake and working tickets share one prompt; every detailed ticket advances
// its own counter.
const mergeDir = mkdtempSync(join(tmpdir(), 'dsh-ria-startup-merge-'))
try {
  writeState(mergeDir, [
    {
      taskId: 'task_merge',
      ...ticket({ goal: 'merge the recovery prompts' }),
    },
    {
      taskId: 'task_late_intake',
      goal: '另一条没有归宿的消息',
      executor: null,
      status: 'intake',
      createdAt: 2,
      updatedAt: 2,
      recoveryCount: 1,
    },
  ])
  const mergeHarness = harness({ stateDir: mergeDir })
  const mergeService = new RiaService(mergeHarness.ctx, mergeDir)
  await mergeService.startup()
  assert.equal(mergeHarness.prompts.length, 1)
  const mergeText = mergeHarness.prompts[0].content[0].text
  assert.match(mergeText, /task_merge/)
  assert.match(mergeText, /task_late_intake/)
  assert.match(mergeText, /recovery=1\/3/)
  assert.match(mergeText, /recovery=2\/3/)
  const savedMerge = JSON.parse(readFileSync(join(mergeDir, 'ria.json'), 'utf8'))
  assert.equal(savedMerge.tickets.find(item => item.ticketId === 'task_merge').recovery.count, 1)
  assert.equal(savedMerge.tickets.find(item => item.ticketId === 'task_late_intake').recovery.count, 2)
} finally {
  rmSync(mergeDir, { recursive: true, force: true })
}

// A forked parent is only a container: recovery visits the unfinished child,
// never the parent and never a finished sibling.
const forkDir = mkdtempSync(join(tmpdir(), 'dsh-ria-startup-fork-'))
try {
  writeState(forkDir, [
    {
      taskId: 'task_parent',
      goal: 'parent container',
      executor: null,
      status: 'forked',
      childTicketIds: ['task_child_done', 'task_child_working'],
      createdAt: 1,
      updatedAt: 1,
    },
    {
      taskId: 'task_child_done',
      goal: 'done child',
      executor: 'session-worker',
      status: 'done',
      resolution: { kind: 'done', summary: 'finished' },
      parentTicketId: 'task_parent',
      rootTicketId: 'task_parent',
      forkDepth: 1,
      createdAt: 2,
      updatedAt: 2,
    },
    {
      taskId: 'task_child_working',
      goal: 'unfinished child',
      executor: 'session-worker',
      status: 'working',
      parentTicketId: 'task_parent',
      rootTicketId: 'task_parent',
      forkDepth: 1,
      createdAt: 3,
      updatedAt: 3,
    },
  ])
  const forkHarness = harness({ stateDir: forkDir })
  await new RiaService(forkHarness.ctx, forkDir).startup()
  assert.equal(forkHarness.prompts.length, 1)
  const forkText = forkHarness.prompts[0].content[0].text
  assert.match(forkText, /task_child_working/)
  assert.doesNotMatch(forkText, /task_parent /)
  assert.doesNotMatch(forkText, /task_child_done/)
} finally {
  rmSync(forkDir, { recursive: true, force: true })
}

// A legacy in-flight record becomes an open ticket during migration, so the
// old patch leaves no top-level inFlight field behind.
const flightDir = mkdtempSync(join(tmpdir(), 'dsh-ria-startup-flight-'))
try {
  writeState(flightDir, [], [], {
    turnId: 12,
    startedAt: Date.UTC(2026, 10, 11, 8, 30, 0),
    lastUserMessage: '调查无人车底商 GPU 方案',
    recoveryCount: 1,
  })
  const flightHarness = harness({ stateDir: flightDir })
  const flightService = new RiaService(flightHarness.ctx, flightDir)
  await flightService.startup()
  assert.equal(flightHarness.prompts.length, 1)
  const flightText = flightHarness.prompts[0].content[0].text
  assert.match(flightText, /调查无人车底商 GPU 方案/)
  assert.match(flightText, /status=open/)
  assert.match(flightText, /recovery=2\/3/)
  const savedFlight = JSON.parse(readFileSync(join(flightDir, 'ria.json'), 'utf8'))
  assert.equal(savedFlight.inFlight, undefined)
  assert.equal(savedFlight.tickets.length, 1)
  assert.equal(savedFlight.tickets[0].origin.kind, 'legacy_inflight')
} finally {
  rmSync(flightDir, { recursive: true, force: true })
}

// Loading a v1 state keeps the recent-worker hint (stored as lastTaskId) and
// writes an exact byte-for-byte backup before the first migrated save.
{
  const dir = mkdtempSync(join(tmpdir(), 'dsh-ria-startup-migrate-'))
  try {
    writeState(dir, [])
    const file = join(dir, 'ria.json')
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    raw.recentWorkers = { 'session-old': { lastUsedAt: 1794400000000, lastTaskId: 'task_old' } }
    writeFileSync(file, JSON.stringify(raw, null, 2))
    const before = readFileSync(file)
    const h = harness({ stateDir: dir })
    await new RiaService(h.ctx, dir).startup()
    const saved = JSON.parse(readFileSync(file, 'utf8'))
    assert.equal(saved.recentWorkers['session-old'].lastTicketId, 'task_old')
    assert.equal(saved.recentWorkers['session-old'].lastTaskId, undefined)
    assert.equal(saved.schemaVersion, 2)
    assert.equal(readFileSync(join(dir, 'ria.json.v1.bak')).equals(before), true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

console.log('startup ok')
