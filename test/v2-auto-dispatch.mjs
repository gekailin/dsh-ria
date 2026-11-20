import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { V2Store } from '../lib/v2/store.mjs'
import { createFixture } from './support/ria-fixture.mjs'

async function withFixture(test, options = {}) {
  const fixture = await createFixture({ v2Default: true, ...options })
  try { await test(fixture) } finally { fixture.cleanup() }
}

async function plannedTicket(fixture, args = {}) {
  const controller = fixture.service.v2
  const chatbot = controller.v2.chatbotSessionId
  const request = await fixture.callAs(chatbot, 'chatbot_request', { goal: 'auto-dispatch policy', ...args })
  assert.equal(request.ok, true, JSON.stringify(request))
  const advisor = controller.v2.advisor('global').sessionId
  const plan = await fixture.callAs(advisor, 'ticket_plan', {
    ticketId: request.ticketId, summary: 'execute the ticket', steps: ['work'],
  })
  assert.equal(plan.ok, true, JSON.stringify(plan))
  return { request, advisor, chatbot }
}

function eventsFor(fixture, ticketId) {
  return fixture.service.routerEvents.query({ ticketId, limit: 500 }).events
}

// New bindings persist true; old JSON without this field still selects/persists true.
{
  const dir = mkdtempSync(join(tmpdir(), 'ria-auto-dispatch-old-'))
  try {
    writeFileSync(join(dir, 'v2.json'), JSON.stringify({
      workers: { old: { sessionId: 'old', kind: 'managed', status: 'idle', scope: 'global' } },
    }))
    const store = new V2Store(dir)
    assert.equal(store.worker('old').allowAutoDispatch, true)
    assert.equal(store.workers()[0].allowAutoDispatch, true)
    store.addWorker('old', { lastUsedAt: 1 })
    assert.equal(JSON.parse(readFileSync(join(dir, 'v2.json'), 'utf8')).workers.old.allowAutoDispatch, true)
    store.addWorker('new')
    assert.equal(store.worker('new').allowAutoDispatch, true)
    store.addWorker('new', { allowAutoDispatch: false })
    assert.equal(new V2Store(dir).worker('new').allowAutoDispatch, false)
  } finally { rmSync(dir, { recursive: true, force: true }) }
}

await withFixture(async fixture => {
  const controller = fixture.service.v2
  const first = await controller.ensureWorker('global')
  assert.equal(first.meta.allowAutoDispatch, true)
  assert.equal(JSON.parse(readFileSync(join(fixture.stateDir, 'v2.json'), 'utf8')).workers[first.sessionId].allowAutoDispatch, true)
  const reused = await controller.ensureWorker('global')
  assert.equal(reused.sessionId, first.sessionId)
  assert.equal(reused.created, false)
  // Simulate a binding loaded before the flag existed; defaulting is also used by selection.
  delete controller.v2.data.workers[first.sessionId].allowAutoDispatch
  assert.equal((await controller.ensureWorker('global')).sessionId, first.sessionId)
})

// False excludes an otherwise idle, same-cwd, newest Worker. Configuration is
// immediate; flipping the flag does not recreate or stop a Worker or its ticket.
await withFixture(async fixture => {
  const controller = fixture.service.v2
  const chatbot = controller.v2.chatbotSessionId
  const explicitOnly = await controller.ensureWorker('global')
  const off = await fixture.callAs(chatbot, 'chatbot_worker_config', {
    action: 'set', workerId: explicitOnly.sessionId, allowAutoDispatch: false,
  })
  assert.equal(off.ok, true, JSON.stringify(off))
  assert.equal(off.before, true)
  assert.equal(off.after, false)
  assert.equal(off.worker.allowAutoDispatch, false)
  assert.equal(off.worker.selectable, false)
  assert.equal(off.worker.status, 'idle')
  const auto = await controller.ensureWorker('global')
  assert.notEqual(auto.sessionId, explicitOnly.sessionId)
  assert.equal(auto.meta.allowAutoDispatch, true)
  assert.equal(controller.v2.worker(explicitOnly.sessionId).cwd, auto.meta.cwd)
  controller.v2.addWorker(explicitOnly.sessionId, { lastUsedAt: Date.now() + 1000 })
  assert.equal((await controller.ensureWorker('global')).sessionId, auto.sessionId)
  const get = await fixture.callAs(chatbot, 'chatbot_worker_config', { action: 'get' })
  assert.equal(get.workers.find(item => item.sessionId === explicitOnly.sessionId).allowAutoDispatch, false)
  const on = await fixture.callAs(chatbot, 'chatbot_worker_config', {
    action: 'set', seq: explicitOnly.meta.seq, allowAutoDispatch: true,
  })
  assert.equal(on.ok, true, JSON.stringify(on))
  assert.equal(on.before, false)
  assert.equal(on.after, true)
  assert.equal(on.worker.allowAutoDispatch, true)
  assert.equal(on.worker.selectable, true)
  assert.equal((await controller.ensureWorker('global')).sessionId, explicitOnly.sessionId)
  const changes = eventsFor(fixture).filter(event => event.event === 'worker.config.changed' && event.payload.field === 'allowAutoDispatch')
  assert.equal(changes.length, 2)
  assert.ok(changes.some(event => event.payload.before === true && event.payload.after === false))
  assert.ok(changes.some(event => event.payload.before === false && event.payload.after === true))
  assert.ok(changes.every(event => event.actor === 'chatbot' && event.payload.workerId === explicitOnly.sessionId))
  const repeated = await fixture.callAs(chatbot, 'chatbot_worker_config', {
    action: 'set', workerId: explicitOnly.sessionId, allowAutoDispatch: true,
  })
  assert.equal(repeated.ok, true)
  assert.equal(eventsFor(fixture).filter(event => event.event === 'worker.config.changed' && event.payload.field === 'allowAutoDispatch').length, 2)
  for (const value of ['false', 0, null]) {
    const invalid = await fixture.callAs(chatbot, 'chatbot_worker_config', {
      action: 'set', workerId: explicitOnly.sessionId, allowAutoDispatch: value,
    })
    assert.equal(invalid.code, 'invalid_allow_auto_dispatch')
    assert.equal(controller.v2.worker(explicitOnly.sessionId).allowAutoDispatch, true)
  }
})

// Either public request selector writes a fixed binding and can target false.
for (const selector of ['workerId', 'workerSeq']) {
  await withFixture(async fixture => {
    const controller = fixture.service.v2
    const target = await controller.ensureWorker('global')
    controller.v2.addWorker(target.sessionId, { allowAutoDispatch: false })
    const requestSelector = { [selector]: selector === 'workerId' ? target.sessionId : target.meta.seq }
    const { request, advisor, chatbot } = await plannedTicket(fixture, requestSelector)
    assert.equal(controller.v2.ticketMeta(request.ticketId).workerId, target.sessionId)
    if (selector === 'workerSeq') assert.equal(controller.v2.ticketMeta(request.ticketId).workerSeq, target.meta.seq)
    const beforeCreates = fixture.creates.length
    const sent = await fixture.callAs(advisor, 'ticket_dispatch', { ticketId: request.ticketId })
    assert.equal(sent.ok, true, JSON.stringify(sent))
    assert.equal(sent.workerSessionId, target.sessionId)
    assert.equal(fixture.creates.length, beforeCreates)
    assert.equal(fixture.service.tickets.ticket(request.ticketId).executor, target.sessionId)
    assert.equal(controller.v2.worker(target.sessionId).allowAutoDispatch, false)
    // The opt-out concerns new automatic assignments, not reporting or resuming this ticket.
    const blocked = await fixture.callAs(target.sessionId, 'worker_report', { ticketId: request.ticketId, status: 'blocked', question: 'continue?' })
    assert.equal(blocked.ok, true)
    const resumed = await fixture.callAs(chatbot, 'chatbot_resume', { ticketId: request.ticketId })
    assert.equal(resumed.ok, true, JSON.stringify(resumed))
    assert.equal(resumed.workerSessionId, target.sessionId)
  })
}

// Metadata-only bindings and the Advisor's explicit override use the same checks.
for (const selector of ['metaId', 'metaSeq', 'toolId']) {
  await withFixture(async fixture => {
    const controller = fixture.service.v2
    const target = await controller.ensureWorker('global')
    controller.v2.addWorker(target.sessionId, { allowAutoDispatch: false })
    const { request, advisor } = await plannedTicket(fixture)
    if (selector === 'metaId') controller.v2.setTicketMeta(request.ticketId, { workerId: target.sessionId })
    if (selector === 'metaSeq') controller.v2.setTicketMeta(request.ticketId, { workerSeq: target.meta.seq })
    const sent = await fixture.callAs(advisor, 'ticket_dispatch', {
      ticketId: request.ticketId, ...(selector === 'toolId' ? { workerSessionId: target.sessionId } : {}),
    })
    assert.equal(sent.ok, true, JSON.stringify(sent))
    assert.equal(sent.workerSessionId, target.sessionId)
    assert.equal(controller.v2.ticketMeta(request.ticketId).workerId, target.sessionId)
  })
}

// Initial dispatch to an explicit unavailable Worker blocks on the user; a
// perfectly usable alternative must never be selected or silently created.
for (const scenario of ['archived', 'busy', 'kind', 'missing', 'unresolvable', 'workspace', 'prompt']) {
  await withFixture(async fixture => {
    const controller = fixture.service.v2
    const target = scenario === 'kind' ? await controller.ensureReflectionWorker('global') : await controller.ensureWorker('global')
    controller.v2.addWorker(target.sessionId, { allowAutoDispatch: false })
    const alternative = await controller.ensureWorker('global')
    const { request, advisor, chatbot } = await plannedTicket(fixture, { workerId: target.sessionId })
    if (scenario === 'archived') fixture.archivedSessions.push(target.sessionId)
    if (scenario === 'busy') fixture.setRunning(target.sessionId, true)
    if (scenario === 'missing') controller.v2.removeWorker(target.sessionId)
    if (scenario === 'workspace') controller.v2.addWorker(target.sessionId, { projectCwd: '/other', cwd: '/other' })
    if (scenario === 'unresolvable') {
      const resolve = fixture.ctx.sessionController.resolveAgent.bind(fixture.ctx.sessionController)
      fixture.ctx.sessionController.resolveAgent = id => id === target.sessionId
        ? { error: { code: 'session/not-found', message: 'specified Worker unavailable' } } : resolve(id)
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
    const sent = await fixture.callAs(advisor, 'ticket_dispatch', { ticketId: request.ticketId })
    assert.equal(sent.ok, false, scenario + ': ' + JSON.stringify(sent))
    assert.equal(sent.code, 'specified_worker_unavailable')
    assert.equal(sent.status, 'blocked')
    assert.equal(sent.waitingOn, 'user')
    const ticket = fixture.service.tickets.ticket(request.ticketId)
    assert.equal(ticket.status, 'blocked')
    assert.equal(ticket.waitingOn, 'user')
    assert.ok(ticket.blockedReason.includes(target.sessionId))
    assert.match(ticket.blockedReason, /指定 worker.*不可用/)
    assert.equal(fixture.creates.length, beforeCreates)
    assert.equal(controller.v2.worker(alternative.sessionId).currentTicketId, null)
    assert.equal(fixture.prompts.slice(beforePrompts).some(prompt => prompt.sessionId === alternative.sessionId), false)
    assert.ok(fixture.prompts.slice(beforePrompts).some(prompt => prompt.sessionId === chatbot && prompt.content[0].text.includes('指定 worker')))
    const event = eventsFor(fixture, request.ticketId).find(event => event.event === 'dispatch.worker_unavailable')
    assert.ok(event)
    assert.equal(event.payload.workerId, target.sessionId)
    // A later resume remains pinned too (including initially failed dispatches).
    const resumed = await fixture.callAs(chatbot, 'chatbot_resume', { ticketId: request.ticketId })
    assert.equal(resumed.ok, false, JSON.stringify(resumed))
    assert.equal(fixture.creates.length, beforeCreates)
    assert.equal(fixture.service.tickets.ticket(request.ticketId).waitingOn, 'user')
  })
}

// Validate selectors without creating tickets or forwarding to the Advisor.
await withFixture(async fixture => {
  const controller = fixture.service.v2
  const chatbot = controller.v2.chatbotSessionId
  const target = await controller.ensureWorker('global')
  const before = fixture.service.tickets.tickets().length
  for (const args of [
    { workerId: target.sessionId, workerSeq: target.meta.seq }, { workerId: '' },
    { workerSeq: 0 }, { workerSeq: 1.5 }, { workerSeq: '1' },
    { workerSeq: 999999 },
  ]) {
    const result = await fixture.callAs(chatbot, 'chatbot_request', { goal: 'invalid selector', ...args })
    assert.equal(result.ok, false, JSON.stringify(result))
    assert.equal(fixture.service.tickets.tickets().length, before)
  }
  // The independent reflection sequence must not shadow work Worker seq=1.
  await controller.ensureReflectionWorker('global')
  const request = await fixture.callAs(chatbot, 'chatbot_request', { goal: 'work seq', workerSeq: target.meta.seq })
  assert.equal(request.ok, true)
  assert.equal(controller.v2.ticketMeta(request.ticketId).workerId, target.sessionId)
})

// work/reflection independently number from one. Create reflection first so
// an unfiltered seq lookup would choose the wrong kind.
await withFixture(async fixture => {
  const controller = fixture.service.v2
  const reflection = await controller.ensureReflectionWorker('global')
  const work = await controller.ensureWorker('global')
  assert.equal(reflection.meta.seq, work.meta.seq)
  const { request, advisor } = await plannedTicket(fixture, { workerSeq: work.meta.seq })
  assert.equal(controller.v2.ticketMeta(request.ticketId).workerId, work.sessionId)
  const sent = await fixture.callAs(advisor, 'ticket_dispatch', { ticketId: request.ticketId })
  assert.equal(sent.workerSessionId, work.sessionId)
})

// The flag is generic: reflection automatic reuse also opts out, while an
// explicitly selected reflection Worker is still legal for a reflection ticket.
await withFixture(async fixture => {
  const controller = fixture.service.v2
  const reflection = await controller.ensureReflectionWorker('global')
  controller.v2.addWorker(reflection.sessionId, { allowAutoDispatch: false })
  assert.notEqual((await controller.ensureReflectionWorker('global')).sessionId, reflection.sessionId)
  const request = await controller.requestTicket({ goal: 'reflection auto-dispatch' }, { agent: { id: controller.v2.chatbotSessionId } }, { mode: 'reflection' })
  assert.equal(request.ok, true, JSON.stringify(request))
  const advisor = controller.v2.advisor('global').sessionId
  assert.equal((await fixture.callAs(advisor, 'ticket_plan', { ticketId: request.ticketId, summary: 'read the logs', steps: ['session_list'] })).ok, true)
  const sent = await fixture.callAs(advisor, 'ticket_dispatch', {
    ticketId: request.ticketId, workerSessionId: reflection.sessionId,
  })
  assert.equal(sent.ok, true, JSON.stringify(sent))
  assert.equal(sent.workerSessionId, reflection.sessionId)
}, { extraGlobalTools: ['grep', 'glob'] })

// Switching off while assigned changes only eligibility for new auto work.
await withFixture(async fixture => {
  const controller = fixture.service.v2
  const { request, advisor, chatbot } = await plannedTicket(fixture)
  const sent = await fixture.callAs(advisor, 'ticket_dispatch', { ticketId: request.ticketId })
  const updated = await fixture.callAs(chatbot, 'chatbot_worker_config', {
    action: 'set', workerId: sent.workerSessionId, allowAutoDispatch: false,
  })
  assert.equal(updated.ok, true, JSON.stringify(updated))
  assert.equal(updated.worker.currentTicketId, request.ticketId)
  assert.equal(fixture.service.tickets.ticket(request.ticketId).status, 'working')
  assert.equal(fixture.cancelCalls.length, 0)
  const report = await fixture.callAs(sent.workerSessionId, 'worker_report', {
    ticketId: request.ticketId, status: 'done', summary: 'complete', evidence: ['test'],
  })
  assert.equal(report.ok, true)
  assert.equal(controller.v2.worker(sent.workerSessionId).allowAutoDispatch, false)
  assert.notEqual((await controller.ensureWorker('global')).sessionId, sent.workerSessionId)
})

// Disabling while the automatic candidate is being resolved affects this same
// selection attempt. Its reservation is released and another eligible worker wins.
await withFixture(async fixture => {
  const controller = fixture.service.v2
  const target = await controller.ensureWorker('global')
  const resolve = fixture.ctx.sessionController.resolveAgent.bind(fixture.ctx.sessionController)
  fixture.ctx.sessionController.resolveAgent = async id => {
    if (id === target.sessionId) controller.v2.addWorker(id, { allowAutoDispatch: false })
    return await resolve(id)
  }
  const next = await controller.ensureWorker('global')
  assert.notEqual(next.sessionId, target.sessionId)
  assert.equal(controller.workerReservations.size, 0)
})

// Preset recreation preserves opt-out; simultaneous model/flag updates emit
// distinct field events and get reflects both immediately.
await withFixture(async fixture => {
  const controller = fixture.service.v2
  const chatbot = controller.v2.chatbotSessionId
  const target = await controller.ensureWorker('global')
  const combined = await fixture.callAs(chatbot, 'chatbot_worker_config', {
    action: 'set', workerId: target.sessionId, model: 'model-fast', provider: 'provider-ok', allowAutoDispatch: false,
  })
  assert.equal(combined.ok, true, JSON.stringify(combined))
  assert.equal(combined.after.model, 'model-fast')
  assert.deepEqual(combined.autoDispatch, { before: true, after: false })
  assert.equal(combined.worker.allowAutoDispatch, false)
  const recreated = await fixture.callAs(chatbot, 'chatbot_worker_config', {
    action: 'set', workerId: target.sessionId, preset: 'minimal', recreate: true,
  })
  assert.equal(recreated.ok, true, JSON.stringify(recreated))
  assert.equal(recreated.worker.allowAutoDispatch, false)
  assert.notEqual((await controller.ensureWorker('global')).sessionId, recreated.worker.sessionId)
})

// The shipped stateless Advisor dispatches directly after planning; neither
// success nor an unavailable explicit Worker may be routed through auto reuse.
for (const unavailable of [false, true]) {
  await withFixture(async fixture => {
    const controller = fixture.service.v2
    const chatbot = controller.v2.chatbotSessionId
    const target = await controller.ensureWorker('global')
    controller.v2.addWorker(target.sessionId, { allowAutoDispatch: false })
    const alternative = await controller.ensureWorker('global')
    if (unavailable) fixture.archivedSessions.push(target.sessionId)
    const beforeCreates = fixture.creates.length
    const made = await fixture.callAs(chatbot, 'chatbot_request', {
      goal: 'stateless explicit selection', workerSeq: target.meta.seq,
    })
    const ticket = fixture.service.tickets.ticket(made.ticketId)
    assert.ok(ticket, JSON.stringify(made))
    assert.equal(controller.v2.ticketMeta(made.ticketId).workerId, target.sessionId)
    assert.equal(ticket.status, unavailable ? 'blocked' : 'working')
    assert.equal(ticket.waitingOn, unavailable ? 'user' : 'worker')
    assert.equal(ticket.executor, target.sessionId)
    assert.equal(fixture.creates.length, beforeCreates)
    assert.equal(controller.v2.worker(alternative.sessionId).currentTicketId, null)
  }, { advisorMode: 'stateless', llmReply: JSON.stringify({ action: 'plan', workOrder: { summary: 'plan', steps: ['execute'] } }) })
}

// A tool-supplied id is a deliberate reassignment, not a fallback; an
// unavailable ticket binding alone must never cause this alternative to run.
await withFixture(async fixture => {
  const controller = fixture.service.v2
  const original = await controller.ensureWorker('global')
  controller.v2.addWorker(original.sessionId, { allowAutoDispatch: false })
  const replacement = await controller.ensureWorker('global')
  controller.v2.addWorker(replacement.sessionId, { allowAutoDispatch: false })
  const { request, advisor } = await plannedTicket(fixture, { workerId: original.sessionId })
  fixture.archivedSessions.push(original.sessionId)
  const sent = await fixture.callAs(advisor, 'ticket_dispatch', {
    ticketId: request.ticketId, workerSessionId: replacement.sessionId,
  })
  assert.equal(sent.ok, true, JSON.stringify(sent))
  assert.equal(sent.workerSessionId, replacement.sessionId)
  assert.equal(controller.v2.ticketMeta(request.ticketId).workerId, replacement.sessionId)
})

// A seq-only legacy selector that no longer resolves blocks on the user and
// cannot fall through to the automatic pool.
await withFixture(async fixture => {
  const controller = fixture.service.v2
  const alternative = await controller.ensureWorker('global')
  const { request, advisor } = await plannedTicket(fixture)
  controller.v2.setTicketMeta(request.ticketId, { workerSeq: 999999 })
  const sent = await fixture.callAs(advisor, 'ticket_dispatch', { ticketId: request.ticketId })
  assert.equal(sent.code, 'specified_worker_unavailable')
  assert.match(sent.message, /seq=999999/)
  assert.equal(fixture.service.tickets.ticket(request.ticketId).waitingOn, 'user')
  assert.equal(controller.v2.worker(alternative.sessionId).currentTicketId, null)
})

// Immutable ticket reads (as in SQLite) must still follow legal environment
// blocked -> open -> user blocked edges after an explicit prompt failure.
await withFixture(async fixture => {
  const controller = fixture.service.v2
  const target = await controller.ensureWorker('global')
  const { request } = await plannedTicket(fixture, { workerId: target.sessionId })
  fixture.service.tickets.transitionTicket(request.ticketId, 'blocked', {
    actor: 'router', executor: target.sessionId, waitingOn: 'environment', blockedReason: 'prompt failed',
  })
  const readTicket = fixture.service.tickets.ticket
  fixture.service.tickets.ticket = id => {
    const ticket = readTicket(id)
    return ticket ? structuredClone(ticket) : ticket
  }
  try {
    const blocked = await controller.blockResumeWorker(request.ticketId, target.sessionId,
      { code: 'dispatch_failed', message: 'rejected' }, { code: 'specified_worker_unavailable' })
    assert.equal(blocked.status, 'blocked')
    assert.equal(readTicket(request.ticketId).waitingOn, 'user')
  } finally { fixture.service.tickets.ticket = readTicket }
})

// A concurrent Worker removal during the config read cannot recreate a stale
// binding or emit a successful flag-change event.
await withFixture(async fixture => {
  const controller = fixture.service.v2
  const chatbot = controller.v2.chatbotSessionId
  const target = await controller.ensureWorker('global')
  const view = controller.workerConfigView.bind(controller)
  controller.workerConfigView = async worker => {
    const snapshot = await view(worker)
    controller.v2.removeWorker(worker.sessionId)
    return snapshot
  }
  const updated = await fixture.callAs(chatbot, 'chatbot_worker_config', {
    action: 'set', workerId: target.sessionId, allowAutoDispatch: false,
  })
  assert.equal(updated.ok, false)
  assert.equal(updated.code, 'worker_missing')
  assert.equal(controller.v2.worker(target.sessionId), null)
  assert.equal(eventsFor(fixture).some(event => event.payload && event.payload.field === 'allowAutoDispatch'), false)
})

console.log('v2 auto-dispatch policy ok')
