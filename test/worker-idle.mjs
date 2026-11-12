import assert from 'node:assert/strict'
import { normalizeWorkerIdleOptions, WorkerIdleWatcher } from '../lib/worker-idle.mjs'

const settle = () => new Promise(resolve => setTimeout(resolve, 10))

function setup({ tickets = [], options = {}, riaId = 'session-ria', transitionTicket } = {}) {
  let handler
  let clock = 1_000
  const prompts = []
  const logs = []
  const ctx = {
    on(event, listener) {
      assert.equal(event, 'agent/status')
      handler = listener
      return () => { handler = undefined }
    },
    sessionController: {
      async prompt(request, signal) {
        assert.ok(signal instanceof AbortSignal)
        prompts.push(request)
        return { accepted: true }
      },
    },
  }
  const watcher = new WorkerIdleWatcher({
    ctx,
    store: { tickets: () => tickets, transitionTicket: transitionTicket || (() => ({ ok: true })) },
    ensureRia: async () => riaId,
    getRiaId: () => riaId,
    log: (level, message) => logs.push(level + ': ' + message),
    now: () => clock,
    options,
  })
  const dispose = watcher.subscribe()
  return {
    watcher,
    prompts,
    logs,
    emit: payload => handler && handler(payload),
    advance: ms => { clock += ms },
    dispose,
    hasHandler: () => Boolean(handler),
  }
}

const workerTicket = (overrides = {}) => ({
  ticketId: 'ticket_1',
  goal: 'finish the report',
  acceptance: 'tests pass',
  executor: 'session-worker',
  status: 'working',
  ...overrides,
})

{
  const h = setup({ tickets: [workerTicket()] })
  h.emit({ agent: { id: 'session-worker' }, status: 'idle' })
  await settle()
  assert.equal(h.prompts.length, 1)
  const request = h.prompts[0]
  assert.equal(request.sessionId, 'session-ria')
  assert.equal(request.mode, 'queue')
  const text = request.content[0].text
  assert.match(text, /\[Worker idle\]/)
  assert.match(text, /session-worker 的 turn 已结束/)
  assert.match(text, /ticketId=ticket_1/)
  assert.match(text, /finish the report/)
  assert.match(text, /ria_read/)
  assert.match(text, /不要假设已完成/)
  assert.match(text, /blockedReason/)
  assert.match(h.logs.join('\n'), /notify Ria: session-worker idle for ticket_1/)
}

{
  const h = setup({ tickets: [workerTicket({ executor: 'session-ria' })] })
  h.emit({ agent: { id: 'session-ria' }, status: 'idle' })
  await settle()
  assert.equal(h.prompts.length, 0)
}

{
  const h = setup({ tickets: [workerTicket({ status: 'done' })] })
  h.emit({ agent: { id: 'session-worker' }, status: 'idle' })
  await settle()
  assert.equal(h.prompts.length, 0)
}

{
  const h = setup({ tickets: [workerTicket()] })
  h.emit({ agent: { id: 'session-worker' }, status: 'running' })
  await settle()
  assert.equal(h.prompts.length, 0)
}

{
  const h = setup({ tickets: [workerTicket()] })
  h.emit({ agent: { id: 'session-worker' }, status: 'idle' })
  await settle()
  h.emit({ agent: { id: 'session-worker' }, status: 'idle' })
  await settle()
  assert.equal(h.prompts.length, 1)
  assert.match(h.logs.join('\n'), /throttled/)
  h.advance(30_001)
  h.emit({ agent: { id: 'session-worker' }, status: 'idle' })
  await settle()
  assert.equal(h.prompts.length, 2)
}

{
  const updates = []
  const h = setup({ tickets: [workerTicket()], transitionTicket: (ticketId, to, patch) => { updates.push({ ticketId, to, patch }); return { ok: true } } })
  h.emit({
    agent: { id: 'session-worker', session: { snapshotEvents: () => [{ type: 'turn/end', data: { turn: 3, reason: { kind: 'completed' } } }] } },
    status: 'idle',
  })
  await settle()
  assert.equal(h.prompts.length, 1)
  const text = h.prompts[0].content[0].text
  assert.match(text, /最后一轮结束原因：completed（turn 3）/)
  assert.match(text, /如果还需要继续：用 ria_request 发送 continuation/)
  assert.equal(updates.length, 0)
}

{
  const ticket = workerTicket()
  const updates = []
  const h = setup({
    tickets: [ticket],
    transitionTicket: (ticketId, to, patch) => {
      updates.push({ ticketId, to, patch })
      ticket.status = to
      return { ok: true, ticket }
    },
  })
  h.emit({
    agent: { id: 'session-worker', session: { snapshotEvents: () => [{ type: 'turn/end', data: { turn: 7, reason: { kind: 'aborted', reason: { kind: 'user' } } } }] } },
    status: 'idle',
  })
  await settle()
  assert.equal(h.prompts.length, 1)
  const text = h.prompts[0].content[0].text
  assert.match(text, /最后一轮结束原因：aborted\(user\)（turn 7）/)
  assert.match(text, /用户手动取消/)
  assert.match(text, /必须停下来等用户决定/)
  assert.match(text, /不要自动续派、重发、改派/)
  assert.match(text, /向用户报告并询问下一步/)
  assert.doesNotMatch(text, /发送 continuation/)
  assert.equal(updates.length, 1)
  assert.equal(updates[0].ticketId, 'ticket_1')
  assert.equal(updates[0].to, 'blocked')
  assert.match(updates[0].patch.blockedReason, /用户取消了 worker turn/)
  assert.equal(ticket.status, 'blocked')
  assert.match(h.logs.join('\n'), /user cancelled turn on session-worker; blocked ticket_1/)
}

{
  const updates = []
  const h = setup({ tickets: [workerTicket()], transitionTicket: (ticketId, to, patch) => { updates.push({ ticketId, to, patch }); return { ok: true } } })
  h.emit({
    agent: { id: 'session-worker', session: { snapshotEvents: () => [{ type: 'turn/end', data: { turn: 5, reason: { kind: 'aborted', reason: { kind: 'disposed' } } } }] } },
    status: 'idle',
  })
  await settle()
  assert.equal(h.prompts.length, 1)
  const text = h.prompts[0].content[0].text
  assert.match(text, /aborted\(disposed\)/)
  assert.match(text, /发送 continuation/)
  assert.equal(updates.length, 0)
}

{
  const h = setup({ tickets: [workerTicket()], options: { notifyOnWorkerIdle: false } })
  assert.equal(h.hasHandler(), false)
  assert.match(h.logs.join('\n'), /disabled/)
}

{
  const tickets = [workerTicket(), workerTicket({ ticketId: 'ticket_2', goal: 'second' })]
  const h = setup({ tickets })
  h.emit({ agent: { id: 'session-worker' }, status: 'idle' })
  await settle()
  assert.equal(h.prompts.length, 1)
  const text = h.prompts[0].content[0].text
  assert.match(text, /ticketId=ticket_1/)
  assert.match(text, /ticketId=ticket_2/)
  tickets.length = 1
  h.emit({ agent: { id: 'session-worker' }, status: 'idle' })
  await settle()
  assert.equal(h.prompts.length, 1)
  h.advance(30_001)
  h.emit({ agent: { id: 'session-worker' }, status: 'idle' })
  await settle()
  assert.equal(h.prompts.length, 2)
}

{
  assert.deepEqual(normalizeWorkerIdleOptions({}, {}), { enabled: true, throttleMs: 30_000 })
  assert.equal(normalizeWorkerIdleOptions({ notifyOnWorkerIdle: false }, {}).enabled, false)
  assert.equal(normalizeWorkerIdleOptions({ notifyOnWorkerIdle: true }, { DSH_RIA_WORKER_IDLE: '0' }).enabled, false)
  assert.equal(normalizeWorkerIdleOptions({}, { DSH_RIA_WORKER_IDLE: 'off' }).enabled, false)
  assert.equal(normalizeWorkerIdleOptions({ workerIdleThrottleMs: 5 }, {}).throttleMs, 1_000)
  assert.equal(normalizeWorkerIdleOptions({}, { DSH_RIA_WORKER_IDLE_THROTTLE_MS: '900000' }).throttleMs, 600_000)
}

// A user cancellation in the previous notification's throttle window still blocks.
{
  const ticket = workerTicket()
  const updates = []
  const h = setup({ tickets: [ticket], transitionTicket: (id, to, patch) => {
    updates.push({ id, to, patch })
    ticket.status = to
    return { ok: true, ticket }
  } })
  const events = [{ type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } }]
  const payload = { status: 'idle', agent: { id: 'session-worker', session: { snapshotEvents: () => events } } }
  await h.watcher.handle(payload)
  assert.equal(h.prompts.length, 1)
  h.advance(1)
  events.push({ type: 'turn/end', data: { turn: 2, reason: { kind: 'aborted', reason: { kind: 'user' } } } })
  await h.watcher.handle(payload)
  assert.equal(ticket.status, 'blocked')
  assert.equal(updates.length, 1)
  assert.equal(updates[0].patch.waitingOn, 'user')
  assert.equal(h.prompts.length, 2)
  assert.match(h.prompts[1].content[0].text, /必须停下来等用户决定/)
  assert.doesNotMatch(h.prompts[1].content[0].text, /发送 continuation/)
  await h.watcher.handle(payload)
  assert.equal(updates.length, 1)
  assert.equal(h.prompts.length, 2)
  h.dispose()
}

console.log('worker-idle ok')
