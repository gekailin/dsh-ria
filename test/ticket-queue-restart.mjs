import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { RiaService } from '../lib/index.js'

function ticket(overrides = {}) {
  return {
    goal: 'finish the long task',
    acceptance: 'tests pass',
    executor: 'session-worker',
    status: 'open',
    blockedReason: '',
    createdAt: 1,
    updatedAt: 1,
    recoveryCount: 0,
    ...overrides,
  }
}

function writeState(dir, tickets, schemaVersion = 2) {
  const state = {
    schemaVersion,
    version: schemaVersion,
    riaSessionId: 'session-ria',
    riaPreset: 'ptc',
    tickets,
    deliveries: [],
    grants: [],
    settings: {},
  }
  writeFileSync(join(dir, 'ria.json'), JSON.stringify(state, null, 2))
}

function harness(options = {}) {
  const prompts = []
  const tools = new Map()
  const riaAgent = {
    id: 'session-ria',
    ctx: {
      tools: { register(definition) { tools.set(definition.name, definition); return () => {} } },
      systemPrompt: { section(section) { tools.set('prompt:' + section.name, section); return () => {} } },
    },
    session: { append() { return { seq: 1, time: 1 } } },
  }
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    agents: { list() { return [] } },
    workspaceRegistry: {
      async create(path, title) { return { id: 'workspace-ria', path, title, async attachSession() {} } },
      async list() { return [] },
    },
    sessionController: {
      async resolveAgent(id) {
        if (String(id) === 'session-ria') return { agent: riaAgent }
        return { error: { code: 'session/not-found', message: 'not found' } }
      },
      async list() {
        return { items: [
          { sessionId: 'session-ria', running: false, blank: false, updatedAt: 1 },
          { sessionId: 'session-worker', running: false, blank: false, updatedAt: 2, cwd: options.stateDir },
        ] }
      },
      async state() { return { active: false, running: false, queue: null, pendingInput: [] } },
      async prompt(request) {
        prompts.push(request)
        return { accepted: true }
      },
    },
  }
  return { ctx, prompts, tools }
}

const waitingDir = mkdtempSync(join(tmpdir(), 'dsh-ria-ticket-queue-wait-'))
try {
  writeState(waitingDir, [
    { ticketId: 'ticket_upstream', ...ticket({ goal: 'draft the plan' }) },
    {
      ticketId: 'ticket_downstream',
      ...ticket({
        goal: 'review the plan',
        dependsOn: ['ticket_upstream'],
        waitingOn: 'ria',
      }),
    },
  ])
  const waiting = harness({ stateDir: waitingDir })
  const service = new RiaService(waiting.ctx, waitingDir)
  await service.startup()

  assert.equal(service.store.data.schemaVersion, 3)
  assert.ok(existsSync(join(waitingDir, 'ria.json.v2.bak')))
  const migrated = JSON.parse(readFileSync(join(waitingDir, 'ria.json'), 'utf8'))
  assert.equal(migrated.schemaVersion, 3)
  const downstream = service.store.ticket('ticket_downstream')
  assert.equal(downstream.waitingOn, 'dependency')
  assert.equal(downstream.readyAt, null)
  const upstream = service.store.ticket('ticket_upstream')
  assert.equal(upstream.status, 'open')
  assert.equal(upstream.waitingOn, 'ria')

  // The waiting ticket is not a recovery unit and is only mentioned in the
  // merged queue summary.
  const recovery = waiting.prompts.filter(request => request.sessionId === 'session-ria')
  assert.equal(recovery.length, 1)
  const text = recovery[0].content.map(part => part.text).join('\n')
  assert.match(text, /ticket_upstream/)
  assert.doesNotMatch(text, /ticket_downstream/)
  assert.match(text, /排队：排队中 1 个/)
  assert.equal(service.store.ticket('ticket_downstream').recovery.count, 0)
} finally {
  rmSync(waitingDir, { recursive: true, force: true })
}

const readyDir = mkdtempSync(join(tmpdir(), 'dsh-ria-ticket-queue-ready-'))
try {
  writeState(readyDir, [
    {
      ticketId: 'ticket_done',
      ...ticket({
        goal: 'draft the plan',
        status: 'done',
        waitingOn: 'none',
        closedAt: 2,
        resolution: { kind: 'done', summary: 'draft ready' },
      }),
    },
    {
      ticketId: 'ticket_ready',
      ...ticket({
        goal: 'review the plan',
        dependsOn: ['ticket_done'],
        waitingOn: 'ria',
      }),
    },
  ])
  const first = harness({ stateDir: readyDir })
  const service = new RiaService(first.ctx, readyDir)
  await service.startup()

  const ready = service.store.ticket('ticket_ready')
  assert.equal(ready.waitingOn, 'ria')
  assert.equal(typeof ready.readyAt, 'number')
  assert.equal(first.prompts.length, 1)
  const text = first.prompts[0].content.map(part => part.text).join('\n')
  assert.match(text, /^\[Queue ready\]/)
  assert.match(text, new RegExp('ticketId=' + ready.ticketId))
  assert.match(text, new RegExp('queueToken=' + service.store.queueTokenFor(ready)))
  assert.ok(service.store.ticket('ticket_ready').readyNotifiedAt >= ready.readyAt)
  assert.equal(service.outbox.summary().pending, 0)

  // A second boot re-notifies the still-undispatched ready ticket once per boot,
  // with a fresh boot-scoped dedupe key.
  const second = harness({ stateDir: readyDir })
  const restarted = new RiaService(second.ctx, readyDir)
  await restarted.startup()
  assert.equal(second.prompts.length, 1)
  const again = second.prompts[0].content.map(part => part.text).join('\n')
  assert.match(again, /^\[Queue ready\]/)
  assert.match(again, /ticket_ready/)
  assert.equal(restarted.store.ticket('ticket_ready').status, 'open')
} finally {
  rmSync(readyDir, { recursive: true, force: true })
}

console.log('ticket queue restart ok')