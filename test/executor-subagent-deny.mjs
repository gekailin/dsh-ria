import assert from 'node:assert/strict'
import { createFixture } from './support/ria-fixture.mjs'

const BASE_EXECUTOR_TOOLS = ['bash', 'edit', 'read', 'ria_executor_report', 'run_code', 'write']
const ADVISOR_TOOLS = ['read', 'ria_ticket_block', 'ria_ticket_dispatch', 'ria_ticket_plan', 'ria_ticket_read']
const CHAT_TOOLS = ['ria_chat_answer', 'ria_chat_approval_decide', 'ria_chat_co_manage', 'ria_chat_cognition_search', 'ria_chat_executor_config', 'ria_chat_forward', 'ria_chat_grant', 'ria_chat_models', 'ria_chat_new_session', 'ria_chat_propose', 'ria_chat_read', 'ria_chat_reflect', 'ria_chat_request', 'ria_chat_resume', 'ria_chat_send_file', 'ria_chat_send_image', 'ria_chat_session_config', 'ria_chat_sessions', 'ria_chat_status', 'ria_chat_steer', 'ria_chat_stop_ticket']
const FULL_DENY = ['subagent', 'subagent_fork', 'list_agents', 'send_message', 'interrupt_agent']

async function dispatchExecutor(fixture) {
  const chat = fixture.service.controller.state.chatSessionId
  const made = await fixture.callAs(chat, 'ria_chat_request', { goal: 'delegation deny test' })
  assert.equal(made.ok, true)
  const advisor = fixture.service.controller.advisor('global').sessionId
  const plan = await fixture.callAs(advisor, 'ria_ticket_plan', { ticketId: made.ticketId, summary: 'do the work' })
  assert.equal(plan.ok, true)
  const sent = await fixture.callAs(advisor, 'ria_ticket_dispatch', { ticketId: made.ticketId })
  assert.equal(sent.ok, true)
  return { chat, advisor, executor: sent.executorSessionId }
}

// 1. Every delegation tool the profile mounts is denied on the Executor. The
// Advisor and Chat surfaces in the same fixture stay untouched.
{
  const fixture = await createFixture({ stateDefault: true, extraGlobalTools: FULL_DENY })
  try {
    const { chat, advisor, executor } = await dispatchExecutor(fixture)
    const executorTools = fixture.visibleTools(executor).sort()
    assert.deepEqual(executorTools, BASE_EXECUTOR_TOOLS)
    for (const name of FULL_DENY) assert.equal(executorTools.includes(name), false, name + ' must not be visible to a Executor')
    const restriction = fixture.restrictions.get(executor)
    assert.deepEqual(restriction, { deny: FULL_DENY })
    // Role isolation: only the Executor lost the delegation family.
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
    const { executor } = await dispatchExecutor(fixture)
    assert.deepEqual(fixture.visibleTools(executor).sort(), BASE_EXECUTOR_TOOLS)
    assert.deepEqual(fixture.restrictions.get(executor), { deny: ['subagent_fork', 'list_agents'] })
  } finally {
    fixture.cleanup()
  }
}

// 3. No delegation tools mounted at all: no restriction is installed and the
// Executor surface is unchanged (this is the default fixture behaviour).
{
  const fixture = await createFixture({ stateDefault: true })
  try {
    const { executor } = await dispatchExecutor(fixture)
    assert.deepEqual(fixture.visibleTools(executor).sort(), BASE_EXECUTOR_TOOLS)
    assert.equal(fixture.restrictions.has(executor), false)
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
    const { executor } = await dispatchExecutor(fixture)
    assert.deepEqual(fixture.visibleTools(executor).sort(), BASE_EXECUTOR_TOOLS)
    assert.deepEqual(fixture.restrictions.get(executor), { deny: ['subagent'] })
  } finally {
    fixture.cleanup()
  }
}

console.log('state executor subagent deny ok')
