import assert from 'node:assert/strict'
import { createFixture } from './support/ria-fixture.mjs'

const BASE_WORKER_TOOLS = ['bash', 'edit', 'read', 'run_code', 'worker_report', 'write']
const ADVISOR_TOOLS = ['lesson_review', 'lesson_search', 'read', 'ticket_block', 'ticket_dispatch', 'ticket_plan', 'ticket_read']
const CHAT_TOOLS = ['chat_co_manage', 'chat_direct', 'chat_grant', 'chat_models', 'chat_new_session', 'chat_propose', 'chat_read', 'chat_request', 'chat_resume', 'chat_send_image', 'chat_sessions', 'chat_status', 'chat_steer', 'chat_stop_ticket', 'chat_watch', 'chat_worker_config']
const FULL_DENY = ['subagent', 'subagent_fork', 'list_agents', 'send_message', 'interrupt_agent']

async function dispatchWorker(fixture) {
  const chat = fixture.service.controller.state.chatSessionId
  const made = await fixture.callAs(chat, 'chat_request', { goal: 'delegation deny test' })
  assert.equal(made.ok, true)
  const advisor = fixture.service.controller.state.advisor('global').sessionId
  const plan = await fixture.callAs(advisor, 'ticket_plan', { ticketId: made.ticketId, summary: 'do the work' })
  assert.equal(plan.ok, true)
  const sent = await fixture.callAs(advisor, 'ticket_dispatch', { ticketId: made.ticketId })
  assert.equal(sent.ok, true)
  return { chat, advisor, worker: sent.workerSessionId }
}

// 1. Every delegation tool the profile mounts is denied on the Worker. The
// Advisor and Chat surfaces in the same fixture stay untouched.
{
  const fixture = await createFixture({ stateDefault: true, extraGlobalTools: FULL_DENY })
  try {
    const { chat, advisor, worker } = await dispatchWorker(fixture)
    const workerTools = fixture.visibleTools(worker).sort()
    assert.deepEqual(workerTools, BASE_WORKER_TOOLS)
    for (const name of FULL_DENY) assert.equal(workerTools.includes(name), false, name + ' must not be visible to a Worker')
    const restriction = fixture.restrictions.get(worker)
    assert.deepEqual(restriction, { deny: FULL_DENY })
    // Role isolation: only the Worker lost the delegation family.
    assert.deepEqual(fixture.visibleTools(advisor).sort(), ADVISOR_TOOLS)
    assert.deepEqual(fixture.visibleTools(chat).sort(), CHAT_TOOLS)
  } finally {
    fixture.cleanup()
  }
}

// 2. Partial availability: the mask is the intersection with what the profile
// actually exposes, so only the mounted delegation tools are denied.
{
  const fixture = await createFixture({ stateDefault: true, extraGlobalTools: ['subagent_fork', 'list_agents'] })
  try {
    const { worker } = await dispatchWorker(fixture)
    assert.deepEqual(fixture.visibleTools(worker).sort(), BASE_WORKER_TOOLS)
    assert.deepEqual(fixture.restrictions.get(worker), { deny: ['subagent_fork', 'list_agents'] })
  } finally {
    fixture.cleanup()
  }
}

// 3. No delegation tools mounted at all: no restriction is installed and the
// Worker surface is unchanged (this is the default fixture behaviour).
{
  const fixture = await createFixture({ stateDefault: true })
  try {
    const { worker } = await dispatchWorker(fixture)
    assert.deepEqual(fixture.visibleTools(worker).sort(), BASE_WORKER_TOOLS)
    assert.equal(fixture.restrictions.has(worker), false)
  } finally {
    fixture.cleanup()
  }
}

// 4. Only one member mounted: only that name reaches the host restriction.
// dsh-tools rejects unknown global names, so the unused names must have been
// dropped by the intersection instead of being passed through.
{
  const fixture = await createFixture({ stateDefault: true, extraGlobalTools: ['subagent'] })
  try {
    const { worker } = await dispatchWorker(fixture)
    assert.deepEqual(fixture.visibleTools(worker).sort(), BASE_WORKER_TOOLS)
    assert.deepEqual(fixture.restrictions.get(worker), { deny: ['subagent'] })
  } finally {
    fixture.cleanup()
  }
}

console.log('state worker subagent deny ok')
