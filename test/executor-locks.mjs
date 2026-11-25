import assert from 'node:assert/strict'
import { KeyedLock } from '../lib/core/locks.mjs'
import { createFixture } from './support/ria-fixture.mjs'

const tick = () => new Promise(resolve => setTimeout(resolve, 0))

// 1) The keyed lock is a real mutex: same key serializes, different keys stay
// independent, and a rejected task releases the key for the next waiter.
{
  const lock = new KeyedLock()
  let active = 0
  let max = 0
  const order = []
  const task = async label => {
    active += 1
    max = Math.max(max, active)
    order.push('start:' + label)
    await tick()
    order.push('end:' + label)
    active -= 1
  }
  await Promise.all([lock.run('T1', () => task('a')), lock.run('T1', () => task('b')), lock.run('T2', () => task('c'))])
  assert.equal(max, 2, 'different keys may overlap; the same key never does')
  assert.deepEqual(order.filter(item => item.endsWith(':a') || item.endsWith(':b')), ['start:a', 'end:a', 'start:b', 'end:b'])
  assert.equal(lock.active('T1'), false)
  await assert.rejects(lock.run('T1', async () => { throw new Error('boom') }), /boom/)
  assert.equal(lock.active('T1'), false, 'failed task releases the key')
  await lock.run('T1', () => task('after-failure'))
  assert.deepEqual(order.slice(-2), ['start:after-failure', 'end:after-failure'])
  console.log('keyed lock unit ok')
}

// 2) Controller integration: settlement and steer share the executor lock. A
// steer already inside the lock keeps settlement waiting until it finishes, so
// the pending steer is either delivered in T1 or observed before done.
{
  const fixture = await createFixture({ state: true })
  try {
    const controller = fixture.service.controller
    const chat = controller.state.chatSessionId
    const executor = (await controller.ensureExecutor('global')).sessionId
    const ticket = fixture.service.store.addTicket({ status: 'working', executor, goal: 'lock integration', acceptance: 'x' })
    controller.state.setTicketMeta(ticket.ticketId, { phase: 'working', executorId: executor })
    controller.state.addExecutor(executor, { status: 'idle', currentTicketId: null })
    controller.state.addReport({ reportId: 'report_lock_done', ticketId: ticket.ticketId, executorId: executor, status: 'done', summary: 'finished', evidence: ['test'], question: '', at: Date.now() })

    let entered
    const admitted = new Promise(resolve => { entered = resolve })
    let release
    const gate = new Promise(resolve => { release = resolve })
    const originalInject = controller.injectUserMessage.bind(controller)
    controller.injectUserMessage = async (sessionId, content, kind, requestId, extra) => {
      if (String(sessionId) !== executor) return await originalInject(sessionId, content, kind, requestId, extra)
      entered()
      await gate
      return await originalInject(sessionId, content, kind, requestId, extra)
    }
    try {
      const steering = fixture.callAs(chat, 'ria_chat_steer', { ticketId: ticket.ticketId, message: 'stay inside T1' })
      await admitted
      let settled = false
      const settling = controller.settleCompletedTurn(ticket, executor, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
        .then(result => { settled = true; return result })
      await tick()
      await tick()
      assert.equal(settled, false, 'settlement waits for the in-flight steer lock')
      assert.equal(fixture.service.store.ticket(ticket.ticketId).status, 'working')
      release()
      const steered = await steering
      assert.equal(steered.ok, true, JSON.stringify(steered))
      const result = await settling
      assert.equal(result.ok, true, JSON.stringify(result))
      assert.equal(result.status, 'done')
      assert.equal(fixture.service.store.ticket(ticket.ticketId).status, 'done')
      const events = fixture.service.routerEvents.query({ ticketId: ticket.ticketId, limit: 100 }).events.map(event => event.event)
      assert.ok(events.includes('steer.delivered'))
      assert.ok(events.includes('ticket.state'))
    } finally {
      controller.injectUserMessage = originalInject
    }
    console.log('executor steer/settle lock ok')
  } finally {
    fixture.cleanup()
  }
}

// 3) error/aborted turn/end settlement also enters the executor lock.
{
  const fixture = await createFixture({ state: true })
  try {
    const controller = fixture.service.controller
    const executor = (await controller.ensureExecutor('global')).sessionId
    const ticket = fixture.service.store.addTicket({ status: 'working', executor, goal: 'error lock', acceptance: 'x' })
    controller.state.setTicketMeta(ticket.ticketId, { phase: 'working', executorId: executor })
    controller.state.addExecutor(executor, { status: 'working', currentTicketId: ticket.ticketId })
    const calls = []
    const originalRun = controller.executorLock.run.bind(controller.executorLock)
    controller.executorLock.run = async (key, task) => { calls.push(String(key)); return await originalRun(key, task) }
    try {
      fixture.service.onSessionEvent({ header: { id: executor } }, {
        type: 'turn/end', data: { turn: 1, reason: { kind: 'error', error: { message: 'boom' } } },
      })
      await tick()
      await tick()
      assert.ok(calls.includes(executor), 'error turn/end acquires the executor lock: ' + JSON.stringify(calls))
      assert.equal(fixture.service.store.ticket(ticket.ticketId).status, 'failed')
    } finally {
      controller.executorLock.run = originalRun
    }
    console.log('executor error-turn lock ok')
  } finally {
    fixture.cleanup()
  }
}

// 4) Automatic dispatch locks the actual chosen executorId (not a synthetic
// ticket key), so dispatch serializes against steer/settle on that executor.
{
  const fixture = await createFixture({ state: true })
  try {
    const controller = fixture.service.controller
    const executor = (await controller.ensureExecutor('global')).sessionId
    controller.state.addExecutor(executor, { status: 'idle', currentTicketId: null })
    const ticket = fixture.service.store.addTicket({ status: 'open', executor: 'advisor', goal: 'auto dispatch lock', acceptance: 'ok' })
    controller.state.setTicketMeta(ticket.ticketId, { phase: 'planned', scope: 'global', mode: 'work' })
    controller.state.setWorkOrder(ticket.ticketId, { ticketId: ticket.ticketId, summary: 'plan', steps: ['run'], acceptance: 'ok' })
    const calls = []
    const originalRun = controller.executorLock.run.bind(controller.executorLock)
    controller.executorLock.run = async (key, task) => { calls.push(String(key)); return await originalRun(key, task) }
    try {
      const dispatched = await controller.dispatchTicket(ticket.ticketId, '')
      assert.equal(dispatched.ok, true, JSON.stringify(dispatched))
      assert.equal(dispatched.executorSessionId, executor)
      assert.ok(calls.includes(executor), 'automatic dispatch must lock the actual executorId: ' + JSON.stringify(calls))
      assert.equal(calls.some(key => key.startsWith('ticket:')), false, 'must not lock a synthetic ticket: key on executorLock: ' + JSON.stringify(calls))
    } finally {
      controller.executorLock.run = originalRun
    }
    console.log('executor auto-dispatch lock ok')
  } finally {
    fixture.cleanup()
  }
}


