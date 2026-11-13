import assert from 'node:assert/strict'
import { createFixture } from './support/ria-fixture.mjs'

// The working-ticket guard reads session state through workerBusy(). The host
// sessionController.state() dereferences its AbortSignal unconditionally, so
// these tests fail if the guard forgets to pass one.
{
  const fixture = await createFixture()
  try {
    fixture.setRunning('session-worker', false)
    const idle = await fixture.call('ria_ticket', { goal: 'track an idle worker', executor: 'session-worker', status: 'working' })
    assert.equal(idle.ok, false)
    assert.equal(idle.code, 'executor_idle')
    assert.equal(fixture.service.store.tickets().length, 0)
  } finally {
    fixture.cleanup()
  }
}

{
  const fixture = await createFixture()
  try {
    fixture.setRunning('session-worker', true)
    const running = await fixture.call('ria_ticket', { goal: 'track a running worker', executor: 'session-worker', status: 'working' })
    assert.equal(running.ticket.status, 'working')
  } finally {
    fixture.cleanup()
  }
}

{
  const fixture = await createFixture({ stateFailure: new Error('state read exploded') })
  try {
    const unknown = await fixture.call('ria_ticket', { goal: 'track an unknown worker', executor: 'session-worker', status: 'working' })
    assert.equal(unknown.ok, false)
    assert.equal(unknown.code, 'executor_state_unknown')
    assert.equal(fixture.service.store.tickets().length, 0)
  } finally {
    fixture.cleanup()
  }
}

console.log('working-guard ok')
