import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { StateStore } from '../lib/store/store.mjs'
import { createFixture } from './support/ria-fixture.mjs'

async function withFixture(test, options = {}) {
  const fixture = await createFixture({ stateDefault: true, ...options })
  try { await test(fixture) } finally { fixture.cleanup() }
}

async function plannedTicket(fixture, args = {}) {
  const controller = fixture.service.controller
  const chat = controller.state.chatSessionId
  const request = await fixture.callAs(chat, 'ria_chat_request', { goal: 'auto-dispatch policy', ...args })
  assert.equal(request.ok, true, JSON.stringify(request))
  const advisor = controller.advisor('global').sessionId
  const plan = await fixture.callAs(advisor, 'ria_ticket_plan', {
    ticketId: request.ticketId, summary: 'execute the ticket', steps: ['work'],
  })
  assert.equal(plan.ok, true, JSON.stringify(plan))
  return { request, advisor, chat }
}

function eventsFor(fixture, ticketId) {
  return fixture.service.routerEvents.query({ ticketId, limit: 500 }).events
}

// New bindings persist true; old JSON without this field still selects/persists true.
{
  const dir = mkdtempSync(join(tmpdir(), 'ria-auto-dispatch-old-'))
  try {
    writeFileSync(join(dir, 'state.json'), JSON.stringify({
      executors: { old: { sessionId: 'old', kind: 'managed', status: 'idle', scope: 'global' } },
    }))
    const store = new StateStore(dir)
    assert.equal(store.executor('old').allowAutoDispatch, true)
    assert.equal(store.executors()[0].allowAutoDispatch, true)
    store.addExecutor('old', { lastUsedAt: 1 })
    assert.equal(JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')).executors.old.allowAutoDispatch, true)
    store.addExecutor('new')
    assert.equal(store.executor('new').allowAutoDispatch, true)
    store.addExecutor('new', { allowAutoDispatch: false })
    assert.equal(new StateStore(dir).executor('new').allowAutoDispatch, false)
  } finally { rmSync(dir, { recursive: true, force: true }) }
}

await withFixture(async fixture => {
  const controller = fixture.service.controller
  const first = await controller.ensureExecutor('global')
  assert.equal(first.meta.allowAutoDispatch, true)
  assert.equal(JSON.parse(readFileSync(join(fixture.stateDir, 'state.json'), 'utf8')).executors[first.sessionId].allowAutoDispatch, true)
  const reused = await controller.ensureExecutor('global')
  assert.equal(reused.sessionId, first.sessionId)
  assert.equal(reused.created, false)
  // Simulate a binding loaded before the flag existed; defaulting is also used by selection.
  delete controller.state.data.executors[first.sessionId].allowAutoDispatch
  assert.equal((await controller.ensureExecutor('global')).sessionId, first.sessionId)
})

// False excludes an otherwise idle, same-cwd, newest Executor. Configuration is
// immediate; flipping the flag does not recreate or stop a Executor or its ticket.
await withFixture(async fixture => {
  const controller = fixture.service.controller
  const chat = controller.state.chatSessionId
  const explicitOnly = await controller.ensureExecutor('global')
  const off = await fixture.callAs(chat, 'ria_chat_executor_config', {
    action: 'set', executorId: explicitOnly.sessionId, allowAutoDispatch: false,
  })
  assert.equal(off.ok, true, JSON.stringify(off))
  assert.equal(off.before, true)
  assert.equal(off.after, false)
  assert.equal(off.executor.allowAutoDispatch, false)
  assert.equal(off.executor.selectable, false)
  assert.equal(off.executor.status, 'idle')
  const auto = await controller.ensureExecutor('global')
  assert.notEqual(auto.sessionId, explicitOnly.sessionId)
  assert.equal(auto.meta.allowAutoDispatch, true)
  assert.equal(controller.state.executor(explicitOnly.sessionId).cwd, auto.meta.cwd)
  controller.state.addExecutor(explicitOnly.sessionId, { lastUsedAt: Date.now() + 1000 })
  assert.equal((await controller.ensureExecutor('global')).sessionId, auto.sessionId)
  const get = await fixture.callAs(chat, 'ria_chat_executor_config', { action: 'get' })
  assert.equal(get.executors.find(item => item.sessionId === explicitOnly.sessionId).allowAutoDispatch, false)
  const on = await fixture.callAs(chat, 'ria_chat_executor_config', {
    action: 'set', seq: explicitOnly.meta.seq, allowAutoDispatch: true,
  })
  assert.equal(on.ok, true, JSON.stringify(on))
  assert.equal(on.before, false)
  assert.equal(on.after, true)
  assert.equal(on.executor.allowAutoDispatch, true)
  assert.equal(on.executor.selectable, true)
  assert.equal((await controller.ensureExecutor('global')).sessionId, explicitOnly.sessionId)
  const changes = eventsFor(fixture).filter(event => event.event === 'executor.config.changed' && event.payload.field === 'allowAutoDispatch')
  assert.equal(changes.length, 2)
  assert.ok(changes.some(event => event.payload.before === true && event.payload.after === false))
  assert.ok(changes.some(event => event.payload.before === false && event.payload.after === true))
  assert.ok(changes.every(event => event.actor === 'chat' && event.payload.executorId === explicitOnly.sessionId))
  const repeated = await fixture.callAs(chat, 'ria_chat_executor_config', {
    action: 'set', executorId: explicitOnly.sessionId, allowAutoDispatch: true,
  })
  assert.equal(repeated.ok, true)
  assert.equal(eventsFor(fixture).filter(event => event.event === 'executor.config.changed' && event.payload.field === 'allowAutoDispatch').length, 2)
  for (const value of ['false', 0, null]) {
    const invalid = await fixture.callAs(chat, 'ria_chat_executor_config', {
      action: 'set', executorId: explicitOnly.sessionId, allowAutoDispatch: value,
    })
    assert.equal(invalid.code, 'invalid_allow_auto_dispatch')
    assert.equal(controller.state.executor(explicitOnly.sessionId).allowAutoDispatch, true)
  }
})

// Either public request selector writes a fixed binding and can target false.
for (const selector of ['executorId', 'executorSeq']) {
  await withFixture(async fixture => {
    const controller = fixture.service.controller
    const target = await controller.ensureExecutor('global')
    controller.state.addExecutor(target.sessionId, { allowAutoDispatch: false })
    const requestSelector = { [selector]: selector === 'executorId' ? target.sessionId : target.meta.seq }
    const { request, advisor, chat } = await plannedTicket(fixture, requestSelector)
    assert.equal(controller.state.ticketMeta(request.ticketId).executorId, target.sessionId)
    if (selector === 'executorSeq') assert.equal(controller.state.ticketMeta(request.ticketId).executorSeq, target.meta.seq)
    const beforeCreates = fixture.creates.length
    const sent = await fixture.callAs(advisor, 'ria_ticket_dispatch', { ticketId: request.ticketId })
    assert.equal(sent.ok, true, JSON.stringify(sent))
    assert.equal(sent.executorSessionId, target.sessionId)
    assert.equal(fixture.creates.length, beforeCreates)
    assert.equal(fixture.service.tickets.ticket(request.ticketId).executor, target.sessionId)
    assert.equal(controller.state.executor(target.sessionId).allowAutoDispatch, false)
    // The opt-out concerns new automatic assignments, not reporting or resuming this ticket.
    const blocked = await fixture.callAs(target.sessionId, 'ria_executor_report', { ticketId: request.ticketId, status: 'blocked', question: 'continue?' })
    assert.equal(blocked.ok, true)
    const resumed = await fixture.callAs(chat, 'ria_chat_resume', { ticketId: request.ticketId })
    assert.equal(resumed.ok, true, JSON.stringify(resumed))
    assert.equal(resumed.executorSessionId, target.sessionId)
  })
}

// Metadata-only bindings and the Advisor's explicit override use the same checks.
for (const selector of ['metaId', 'metaSeq', 'toolId']) {
  await withFixture(async fixture => {
    const controller = fixture.service.controller
    const target = await controller.ensureExecutor('global')
    controller.state.addExecutor(target.sessionId, { allowAutoDispatch: false })
    const { request, advisor } = await plannedTicket(fixture)
    if (selector === 'metaId') controller.state.setTicketMeta(request.ticketId, { executorId: target.sessionId })
    if (selector === 'metaSeq') controller.state.setTicketMeta(request.ticketId, { executorSeq: target.meta.seq })
    const sent = await fixture.callAs(advisor, 'ria_ticket_dispatch', {
      ticketId: request.ticketId, ...(selector === 'toolId' ? { executorSessionId: target.sessionId } : {}),
    })
    assert.equal(sent.ok, true, JSON.stringify(sent))
    assert.equal(sent.executorSessionId, target.sessionId)
    assert.equal(controller.state.ticketMeta(request.ticketId).executorId, target.sessionId)
  })
}

// Initial dispatch to an explicit unavailable Executor blocks on the user; a
// perfectly usable alternative must never be selected or silently created.
for (const scenario of ['archived', 'busy', 'kind', 'missing', 'unresolvable', 'workspace', 'prompt']) {
  await withFixture(async fixture => {
    const controller = fixture.service.controller
    const target = scenario === 'kind' ? await controller.ensureReflectionExecutor('global') : await controller.ensureExecutor('global')
    controller.state.addExecutor(target.sessionId, { allowAutoDispatch: false })
    const alternative = await controller.ensureExecutor('global')
    const { request, advisor, chat } = await plannedTicket(fixture, { executorId: target.sessionId })
    if (scenario === 'archived') fixture.archivedSessions.push(target.sessionId)
    if (scenario === 'busy') fixture.setRunning(target.sessionId, true)
    if (scenario === 'missing') controller.state.removeExecutor(target.sessionId)
    if (scenario === 'workspace') controller.state.addExecutor(target.sessionId, { projectCwd: '/other', cwd: '/other' })
    if (scenario === 'unresolvable') {
      const resolve = fixture.ctx.sessionController.resolveAgent.bind(fixture.ctx.sessionController)
      fixture.ctx.sessionController.resolveAgent = id => id === target.sessionId
        ? { error: { code: 'session/not-found', message: 'specified Executor unavailable' } } : resolve(id)
    }
    if (scenario === 'prompt') {
      const prompt = fixture.ctx.sessionController.prompt.bind(fixture.ctx.sessionController)
      fixture.ctx.sessionController.prompt = (args, signal) => {
        if (args.sessionId === target.sessionId) throw new Error('specified prompt rejected')
        return prompt(args, signal)
      }
    }
    const beforeCreates = fixture.creates.length
    const beforePrompts = fixture.prompts.length
    const sent = await fixture.callAs(advisor, 'ria_ticket_dispatch', { ticketId: request.ticketId })
    assert.equal(sent.ok, false, scenario + ': ' + JSON.stringify(sent))
    assert.equal(sent.code, 'specified_executor_unavailable')
    assert.equal(sent.status, 'blocked')
    assert.equal(sent.waitingOn, 'user')
    const ticket = fixture.service.tickets.ticket(request.ticketId)
    assert.equal(ticket.status, 'blocked')
    assert.equal(ticket.waitingOn, 'user')
    assert.ok(ticket.blockedReason.includes(target.sessionId))
    assert.match(ticket.blockedReason, /指定 executor.*不可用/)
    assert.equal(fixture.creates.length, beforeCreates)
    assert.equal(controller.state.executor(alternative.sessionId).currentTicketId, null)
    assert.equal(fixture.prompts.slice(beforePrompts).some(prompt => prompt.sessionId === alternative.sessionId), false)
    assert.ok(fixture.prompts.slice(beforePrompts).some(prompt => prompt.sessionId === chat && prompt.content[0].text.includes('指定 executor')))
    const event = eventsFor(fixture, request.ticketId).find(event => event.event === 'dispatch.executor_unavailable')
    assert.ok(event)
    assert.equal(event.payload.executorId, target.sessionId)
    // A later resume remains pinned too (including initially failed dispatches).
    const resumed = await fixture.callAs(chat, 'ria_chat_resume', { ticketId: request.ticketId })
    assert.equal(resumed.ok, false, JSON.stringify(resumed))
    assert.equal(fixture.creates.length, beforeCreates)
    assert.equal(fixture.service.tickets.ticket(request.ticketId).waitingOn, 'user')
  })
}

// Validate selectors without creating tickets or forwarding to the Advisor.
await withFixture(async fixture => {
  const controller = fixture.service.controller
  const chat = controller.state.chatSessionId
  const target = await controller.ensureExecutor('global')
  const before = fixture.service.tickets.tickets().length
  for (const args of [
    { executorId: target.sessionId, executorSeq: target.meta.seq }, { executorId: '' },
    { executorSeq: 0 }, { executorSeq: 1.5 }, { executorSeq: '1' },
    { executorSeq: 999999 },
  ]) {
    const result = await fixture.callAs(chat, 'ria_chat_request', { goal: 'invalid selector', ...args })
    assert.equal(result.ok, false, JSON.stringify(result))
    assert.equal(fixture.service.tickets.tickets().length, before)
  }
  // The independent reflection sequence must not shadow work Executor seq=1.
  await controller.ensureReflectionExecutor('global')
  const request = await fixture.callAs(chat, 'ria_chat_request', { goal: 'work seq', executorSeq: target.meta.seq })
  assert.equal(request.ok, true)
  assert.equal(controller.state.ticketMeta(request.ticketId).executorId, target.sessionId)
})

// work/reflection independently number from one. Create reflection first so
// an unfiltered seq lookup would choose the wrong kind.
await withFixture(async fixture => {
  const controller = fixture.service.controller
  const reflection = await controller.ensureReflectionExecutor('global')
  const work = await controller.ensureExecutor('global')
  assert.equal(reflection.meta.seq, work.meta.seq)
  const { request, advisor } = await plannedTicket(fixture, { executorSeq: work.meta.seq })
  assert.equal(controller.state.ticketMeta(request.ticketId).executorId, work.sessionId)
  const sent = await fixture.callAs(advisor, 'ria_ticket_dispatch', { ticketId: request.ticketId })
  assert.equal(sent.executorSessionId, work.sessionId)
})

// The flag is generic: reflection automatic reuse also opts out, while an
// explicitly selected reflection Executor is still legal for a reflection ticket.
await withFixture(async fixture => {
  const controller = fixture.service.controller
  const reflection = await controller.ensureReflectionExecutor('global')
  controller.state.addExecutor(reflection.sessionId, { allowAutoDispatch: false })
  assert.notEqual((await controller.ensureReflectionExecutor('global')).sessionId, reflection.sessionId)
  const request = await controller.requestTicket({ goal: 'reflection auto-dispatch' }, { agent: { id: controller.state.chatSessionId } }, { mode: 'reflection' })
  assert.equal(request.ok, true, JSON.stringify(request))
  const advisor = controller.advisor('global').sessionId
  assert.equal((await fixture.callAs(advisor, 'ria_ticket_plan', { ticketId: request.ticketId, summary: 'read the logs', steps: ['ria_session_list'] })).ok, true)
  const sent = await fixture.callAs(advisor, 'ria_ticket_dispatch', {
    ticketId: request.ticketId, executorSessionId: reflection.sessionId,
  })
  assert.equal(sent.ok, true, JSON.stringify(sent))
  assert.equal(sent.executorSessionId, reflection.sessionId)
}, { extraGlobalTools: ['grep', 'glob'] })

// Switching off while assigned changes only eligibility for new auto work.
await withFixture(async fixture => {
  const controller = fixture.service.controller
  const { request, advisor, chat } = await plannedTicket(fixture)
  const sent = await fixture.callAs(advisor, 'ria_ticket_dispatch', { ticketId: request.ticketId })
  const updated = await fixture.callAs(chat, 'ria_chat_executor_config', {
    action: 'set', executorId: sent.executorSessionId, allowAutoDispatch: false,
  })
  assert.equal(updated.ok, true, JSON.stringify(updated))
  assert.equal(updated.executor.currentTicketId, request.ticketId)
  assert.equal(fixture.service.tickets.ticket(request.ticketId).status, 'working')
  assert.equal(fixture.cancelCalls.length, 0)
  const report = await fixture.callAs(sent.executorSessionId, 'ria_executor_report', {
    ticketId: request.ticketId, status: 'done', summary: 'complete', evidence: ['test'],
  })
  assert.equal(report.ok, true)
  assert.equal(controller.state.executor(sent.executorSessionId).allowAutoDispatch, false)
  assert.notEqual((await controller.ensureExecutor('global')).sessionId, sent.executorSessionId)
})

// Disabling while the automatic candidate is being resolved affects this same
// selection attempt. Its reservation is released and another eligible executor wins.
await withFixture(async fixture => {
  const controller = fixture.service.controller
  const target = await controller.ensureExecutor('global')
  const resolve = fixture.ctx.sessionController.resolveAgent.bind(fixture.ctx.sessionController)
  fixture.ctx.sessionController.resolveAgent = async id => {
    if (id === target.sessionId) controller.state.addExecutor(id, { allowAutoDispatch: false })
    return await resolve(id)
  }
  const next = await controller.ensureExecutor('global')
  assert.notEqual(next.sessionId, target.sessionId)
  assert.equal(controller.executorReservations.size, 0)
})

// Preset recreation preserves opt-out; simultaneous model/flag updates emit
// distinct field events and get reflects both immediately.
await withFixture(async fixture => {
  const controller = fixture.service.controller
  const chat = controller.state.chatSessionId
  const target = await controller.ensureExecutor('global')
  const combined = await fixture.callAs(chat, 'ria_chat_executor_config', {
    action: 'set', executorId: target.sessionId, model: 'model-fast', provider: 'provider-ok', allowAutoDispatch: false,
  })
  assert.equal(combined.ok, true, JSON.stringify(combined))
  assert.equal(combined.after.model, 'model-fast')
  assert.deepEqual(combined.autoDispatch, { before: true, after: false })
  assert.equal(combined.executor.allowAutoDispatch, false)
  const recreated = await fixture.callAs(chat, 'ria_chat_executor_config', {
    action: 'set', executorId: target.sessionId, preset: 'minimal', recreate: true,
  })
  assert.equal(recreated.ok, true, JSON.stringify(recreated))
  assert.equal(recreated.executor.allowAutoDispatch, false)
  assert.notEqual((await controller.ensureExecutor('global')).sessionId, recreated.executor.sessionId)
})

// The shipped stateless Advisor dispatches directly after planning; neither
// success nor an unavailable explicit Executor may be routed through auto reuse.
for (const unavailable of [false, true]) {
  await withFixture(async fixture => {
    const controller = fixture.service.controller
    const chat = controller.state.chatSessionId
    const target = await controller.ensureExecutor('global')
    controller.state.addExecutor(target.sessionId, { allowAutoDispatch: false })
    const alternative = await controller.ensureExecutor('global')
    if (unavailable) fixture.archivedSessions.push(target.sessionId)
    const beforeCreates = fixture.creates.length
    const made = await fixture.callAs(chat, 'ria_chat_request', {
      goal: 'stateless explicit selection', executorSeq: target.meta.seq,
    })
    const ticket = fixture.service.tickets.ticket(made.ticketId)
    assert.ok(ticket, JSON.stringify(made))
    assert.equal(controller.state.ticketMeta(made.ticketId).executorId, target.sessionId)
    assert.equal(ticket.status, unavailable ? 'blocked' : 'working')
    assert.equal(ticket.waitingOn, unavailable ? 'user' : 'executor')
    assert.equal(ticket.executor, target.sessionId)
    assert.equal(fixture.creates.length, beforeCreates)
    assert.equal(controller.state.executor(alternative.sessionId).currentTicketId, null)
  }, { advisorPlan: 'stateless', llmReply: JSON.stringify({ action: 'plan', workOrder: { summary: 'plan', steps: ['execute'] } }) })
}

// A tool-supplied id is a deliberate reassignment, not a fallback; an
// unavailable ticket binding alone must never cause this alternative to run.
await withFixture(async fixture => {
  const controller = fixture.service.controller
  const original = await controller.ensureExecutor('global')
  controller.state.addExecutor(original.sessionId, { allowAutoDispatch: false })
  const replacement = await controller.ensureExecutor('global')
  controller.state.addExecutor(replacement.sessionId, { allowAutoDispatch: false })
  const { request, advisor } = await plannedTicket(fixture, { executorId: original.sessionId })
  fixture.archivedSessions.push(original.sessionId)
  const sent = await fixture.callAs(advisor, 'ria_ticket_dispatch', {
    ticketId: request.ticketId, executorSessionId: replacement.sessionId,
  })
  assert.equal(sent.ok, true, JSON.stringify(sent))
  assert.equal(sent.executorSessionId, replacement.sessionId)
  assert.equal(controller.state.ticketMeta(request.ticketId).executorId, replacement.sessionId)
})

// A seq-only legacy selector that no longer resolves blocks on the user and
// cannot fall through to the automatic pool.
await withFixture(async fixture => {
  const controller = fixture.service.controller
  const alternative = await controller.ensureExecutor('global')
  const { request, advisor } = await plannedTicket(fixture)
  controller.state.setTicketMeta(request.ticketId, { executorSeq: 999999 })
  const sent = await fixture.callAs(advisor, 'ria_ticket_dispatch', { ticketId: request.ticketId })
  assert.equal(sent.code, 'specified_executor_unavailable')
  assert.match(sent.message, /seq=999999/)
  assert.equal(fixture.service.tickets.ticket(request.ticketId).waitingOn, 'user')
  assert.equal(controller.state.executor(alternative.sessionId).currentTicketId, null)
})

// Immutable ticket reads (as in SQLite) must still follow legal environment
// blocked -> open -> user blocked edges after an explicit prompt failure.
await withFixture(async fixture => {
  const controller = fixture.service.controller
  const target = await controller.ensureExecutor('global')
  const { request } = await plannedTicket(fixture, { executorId: target.sessionId })
  fixture.service.tickets.transitionTicket(request.ticketId, 'blocked', {
    actor: 'router', executor: target.sessionId, waitingOn: 'environment', blockedReason: 'prompt failed',
  })
  const readTicket = fixture.service.tickets.ticket
  fixture.service.tickets.ticket = id => {
    const ticket = readTicket(id)
    return ticket ? structuredClone(ticket) : ticket
  }
  try {
    const blocked = await controller.blockResumeExecutor(request.ticketId, target.sessionId,
      { code: 'dispatch_failed', message: 'rejected' }, { code: 'specified_executor_unavailable' })
    assert.equal(blocked.status, 'blocked')
    assert.equal(readTicket(request.ticketId).waitingOn, 'user')
  } finally { fixture.service.tickets.ticket = readTicket }
})

// A concurrent Executor removal during the config read cannot recreate a stale
// binding or emit a successful flag-change event.
await withFixture(async fixture => {
  const controller = fixture.service.controller
  const chat = controller.state.chatSessionId
  const target = await controller.ensureExecutor('global')
  const view = controller.executorConfigView.bind(controller)
  controller.executorConfigView = async executor => {
    const snapshot = await view(executor)
    controller.state.removeExecutor(executor.sessionId)
    return snapshot
  }
  const updated = await fixture.callAs(chat, 'ria_chat_executor_config', {
    action: 'set', executorId: target.sessionId, allowAutoDispatch: false,
  })
  assert.equal(updated.ok, false)
  assert.equal(updated.code, 'executor_missing')
  assert.equal(controller.state.executor(target.sessionId), null)
  assert.equal(eventsFor(fixture).some(event => event.payload && event.payload.field === 'allowAutoDispatch'), false)
})

console.log('state auto-dispatch policy ok')
