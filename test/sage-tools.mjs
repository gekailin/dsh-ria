import assert from 'node:assert/strict'
import { createFixture } from './support/ria-fixture.mjs'

// Sage must see exactly its four cognition/governance tools. The restriction is an empty
// allow-list: dsh-tools only validates/removes INHERITED (global/preset) tools
// there, while the agent's own scoped registrations stay visible (see
// lib/core/controller.mjs restrictSage and dsh-tools/lib/index.js:453-467).
//
// The other roles are snapshotted here from the pre-change behaviour so a
// regression in their agent creation/restriction paths fails this test too.
// Router is not an agent or a session: lib/router/cli.mjs is a standalone
// classifier process that registers no tools, so it has no surface to snapshot.
const SAGE_TOOLS = ['ria_sage_read', 'ria_sage_request', 'ria_sage_topic', 'ria_sage_write']
const SAGE_FORBIDDEN = [
  'bash', 'write', 'edit', 'read', 'read_image', 'grep', 'glob', 'task',
  'run_code', 'subagent', 'subagent_fork', 'list_agents', 'send_message',
  'interrupt_agent', 'web_fetch', 'web_search', 'plugin_manager', 'present',
  'schedule_create', 'skill', 'todo_write', 'workflow', 'working_directory',
]
const CHAT_TOOLS = [
  'ria_chat_co_manage', 'ria_chat_direct', 'ria_chat_grant', 'ria_chat_models', 'ria_chat_new_session',
  'ria_chat_propose', 'ria_chat_read', 'ria_chat_request', 'ria_chat_resume',
  'ria_chat_send_image', 'ria_chat_sessions', 'ria_chat_status', 'ria_chat_steer', 'ria_chat_stop_ticket',
  'ria_chat_watch', 'ria_chat_worker_config',
]
// Preset/global tools this fixture mounts. It deliberately mirrors the families
// the deployed standard/ptc presets expose (shell, fs, search, delegation,
// web, schedule) so a leaked inherited tool is visible.
const MOUNTED_GLOBALS = [
  'grep', 'glob', 'read_image', 'subagent', 'subagent_fork', 'list_agents',
  'send_message', 'interrupt_agent', 'task', 'web_fetch', 'web_search',
  'plugin_manager', 'present', 'schedule_create', 'skill', 'todo_write',
  'workflow', 'working_directory', 'create_goal', 'get_goal', 'update_goal',
  'ask_user_question', 'job_list', 'list_subagent_models', 'exit_plan_mode',
]
const ADVISOR_TOOLS = [
  'glob', 'grep', 'read', 
  'ria_ticket_block', 'ria_ticket_dispatch', 'ria_ticket_plan', 'ria_ticket_read',
]
const EXECUTOR_DENY = ['subagent', 'subagent_fork', 'list_agents', 'send_message', 'interrupt_agent']

const fixture = await createFixture({ stateDefault: true, extraGlobalTools: MOUNTED_GLOBALS })
try {
  const controller = fixture.service.controller
  const chat = (await controller.ensureChat()).sessionId
  const created = await fixture.callAs(chat, 'ria_chat_request', { goal: 'role tool surface baseline' })
  assert.equal(created.ok, true, JSON.stringify(created))
  const advisor = created.advisorResult.sessionId

  // Baseline for the roles this ticket must not change, captured before Sage
  // is installed. Sage's installation runs through the same install() path.
  const chatBefore = fixture.visibleTools(chat).sort()
  const advisorBefore = fixture.visibleTools(advisor).sort()

  const sage = (await controller.ensureSage()).sessionId

  // 1. Sage sees exactly the three scoped tools, and none of the forbidden
  //    inherited/preset tools (including the PTC transport run_code).
  const sageTools = fixture.visibleTools(sage).sort()
  assert.deepEqual(sageTools, SAGE_TOOLS)
  for (const name of SAGE_FORBIDDEN) {
    assert.equal(sageTools.includes(name), false, name + ' must not be visible to Sage')
  }
  // The mechanism is the name-free empty allow-list, not a scope-local list
  // that the host would reject as "unknown global tool".
  assert.deepEqual(fixture.restrictions.get(sage), { allow: [] })
  assert.equal(controller.restrictToTools, undefined, 'the swallowing helper must be gone')
  assert.equal(typeof controller.restrictSage, 'function')

  // 2. The old wrong-namespace call really fails against a host-faithful
  //    restrict(): this is why Sage used to keep every global tool.
  assert.throws(
    () => fixture.agentFor(sage).ctx.tools.restrict({ allow: ['ria_sage_read'] }),
    /unknown global tool/,
  )

  // 3. Chat and Advisor surfaces are unchanged by Sage's installation.
  assert.deepEqual(fixture.visibleTools(chat).sort(), chatBefore)
  assert.deepEqual(fixture.visibleTools(advisor).sort(), advisorBefore)
  assert.deepEqual(chatBefore, CHAT_TOOLS)
  assert.deepEqual(advisorBefore, ADVISOR_TOOLS)

  // 4. Executor baseline: untouched by this ticket. The Executor is created only
  //    after Sage is installed, so its surface also proves install() for Sage
  //    did not alter the shared tool registry.
  const planned = await fixture.callAs(advisor, 'ria_ticket_plan', { ticketId: created.ticketId, summary: 'do the work', steps: ['x'] })
  assert.equal(planned.ok, true, JSON.stringify(planned))
  const dispatched = await fixture.callAs(advisor, 'ria_ticket_dispatch', { ticketId: created.ticketId })
  assert.equal(dispatched.ok, true, JSON.stringify(dispatched))
  const executor = dispatched.executorSessionId
  const executorTools = fixture.visibleTools(executor).sort()
  assert.deepEqual(executorTools, [
    'bash', 'edit', 'glob', 'grep', 'read', 'read_image', 'run_code',
    'task', 'web_fetch', 'web_search', 'plugin_manager', 'present',
    'schedule_create', 'skill', 'todo_write', 'workflow', 'working_directory',
    'create_goal', 'get_goal', 'update_goal', 'ask_user_question', 'job_list',
    'list_subagent_models', 'exit_plan_mode', 'ria_worker_report', 'write',
  ].sort())
  for (const name of EXECUTOR_DENY) {
    assert.equal(executorTools.includes(name), false, name + ' must stay denied to Executors')
  }
  assert.deepEqual(fixture.restrictions.get(executor), { deny: EXECUTOR_DENY })

  // 5. Fail-closed: a missing or failing restrict() must abort Sage instead of
  //    silently leaving it unrestricted.
  assert.throws(() => controller.restrictSage({ id: 'no-tools', ctx: {} }), /cannot be restricted/)
  assert.throws(
    () => controller.restrictSage({ id: 'boom', ctx: { tools: { restrict() { throw new Error('restrict boom') } } } }),
    /restrict boom/,
  )
  // An own-scope tool that restrictions cannot mask is a real leak.
  assert.throws(
    () => controller.restrictSage({
      id: 'leak',
      ctx: { tools: { restrict() {}, view() { return { visible: new Map([['bash', {}], ['ria_sage_read', {}]]) } } } },
    }),
    /unexpected tools: bash/,
  )
  // Verification errors are fatal too; no surface is accepted on trust.
  assert.throws(
    () => controller.restrictSage({
      id: 'unverifiable',
      ctx: { tools: { restrict() {}, view() { throw new Error('view boom') } } },
    }),
    /could not be verified: view boom/,
  )

  console.log('state sage tools ok')
} finally {
  fixture.cleanup()
}
