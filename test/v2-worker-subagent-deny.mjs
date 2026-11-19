import assert from 'node:assert/strict'
import { createFixture } from './support/ria-fixture.mjs'

const BASE_WORKER_TOOLS = ['bash', 'edit', 'read', 'run_code', 'worker_checkpoint', 'worker_report', 'write']
const ADVISOR_TOOLS = ['lesson_review', 'lesson_search', 'read', 'ticket_answer', 'ticket_block', 'ticket_dispatch', 'ticket_plan', 'ticket_read']
const CHATBOT_TOOLS = ['chatbot_direct', 'chatbot_grant', 'chatbot_propose', 'chatbot_read', 'chatbot_request', 'chatbot_resume', 'chatbot_sessions', 'chatbot_status', 'chatbot_steer', 'chatbot_talk', 'chatbot_watch']
const FULL_DENY = ['subagent', 'subagent_fork', 'list_agents', 'send_message', 'interrupt_agent']

async function dispatchWorker(fixture) {
  const chatbot = fixture.service.v2.v2.chatbotSessionId
  const made = await fixture.callAs(chatbot, 'chatbot_request', { goal: 'delegation deny test' })
  assert.equal(made.ok, true)
  const advisor = fixture.service.v2.v2.advisor('global').sessionId
  const plan = await fixture.callAs(advisor, 'ticket_plan', { ticketId: made.ticketId, summary: 'do the work' })
  assert.equal(plan.ok, true)
  const sent = await fixture.callAs(advisor, 'ticket_dispatch', { ticketId: made.ticketId })
  assert.equal(sent.ok, true)
  return { chatbot, advisor, worker: sent.workerSessionId }
}

// 1. Every delegation tool the profile mounts is denied on the Worker. The
// Advisor and Chatbot surfaces in the same fixture stay untouched.
{
  const fixture = await createFixture({ v2Default: true, extraGlobalTools: FULL_DENY })
  try {
    const { chatbot, advisor, worker } = await dispatchWorker(fixture)
    const workerTools = fixture.visibleTools(worker).sort()
    assert.deepEqual(workerTools, BASE_WORKER_TOOLS)
    for (const name of FULL_DENY) assert.equal(workerTools.includes(name), false, name + ' must not be visible to a Worker')
    const restriction = fixture.restrictions.get(worker)
    assert.deepEqual(restriction, { deny: FULL_DENY })
    // Role isolation: only the Worker lost the delegation family.
    assert.deepEqual(fixture.visibleTools(advisor).sort(), ADVISOR_TOOLS)
    assert.deepEqual(fixture.visibleTools(chatbot).sort(), CHATBOT_TOOLS)
  } finally {
    fixture.cleanup()
  }
}

// 2. Partial availability: the mask is the intersection with what the profile
// actually exposes, so only the mounted delegation tools are denied.
{
  const fixture = await createFixture({ v2Default: true, extraGlobalTools: ['subagent_fork', 'list_agents'] })
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
  const fixture = await createFixture({ v2Default: true })
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
  const fixture = await createFixture({ v2Default: true, extraGlobalTools: ['subagent'] })
  try {
    const { worker } = await dispatchWorker(fixture)
    assert.deepEqual(fixture.visibleTools(worker).sort(), BASE_WORKER_TOOLS)
    assert.deepEqual(fixture.restrictions.get(worker), { deny: ['subagent'] })
  } finally {
    fixture.cleanup()
  }
}

console.log('v2 worker subagent deny ok')
