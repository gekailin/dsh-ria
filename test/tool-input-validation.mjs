import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createFixture } from './support/ria-fixture.mjs'

// Every Ria tool call crosses the same strict boundary: unknown, missing and
// mistyped parameters fail before the handler runs, and the rejection is
// audited without copying the input. The legacy workerId family is a hint,
// never an accepted alias.

const NL = String.fromCharCode(10)
const SECRET = 'sk-STRICT-VALIDATION-DO-NOT-LOG'
const fixture = await createFixture({ stateDefault: true, extraGlobalTools: ['grep', 'glob'] })
try {
  const controller = fixture.service.controller
  await fixture.service.ensure()
  const chat = controller.state.chatSessionId
  const ticketCount = () => fixture.service.tickets.tickets().length
  const operationEvents = () => {
    try {
      return readFileSync(join(fixture.stateDir, 'operation-events.jsonl'), 'utf8')
        .trim().split(NL).filter(Boolean).map(line => JSON.parse(line))
    } catch {
      return []
    }
  }
  const invalidEvents = () => fixture.service.routerEvents.query({ types: ['tool.input.invalid'], limit: 200 }).events
  const assertShape = (result, code, field) => {
    assert.equal(result.ok, false, JSON.stringify(result))
    assert.equal(result.code, code, JSON.stringify(result))
    assert.equal(result.field, field, JSON.stringify(result))
    assert.equal(typeof result.tool, 'string')
    assert.ok('expected' in result, JSON.stringify(result))
    assert.ok('got' in result, JSON.stringify(result))
    assert.ok(Array.isArray(result.allowed), JSON.stringify(result))
    assert.equal(typeof result.message, 'string')
  }

  const beforeInvalid = ticketCount()

  // 1. Unknown parameter on the canonical chat tool: workerId is rejected,
  //    the legal field list is returned, and the legacy hint names executorId.
  const unknown = await fixture.callAs(chat, 'ria_chat_request', { goal: 'strict', workerId: SECRET })
  assertShape(unknown, 'unknown_parameter', 'workerId')
  assert.equal(unknown.tool, 'ria_chat_request')
  assert.ok(unknown.allowed.includes('executorId'))
  assert.ok(unknown.allowed.includes('goal'))
  assert.equal(unknown.replacement, 'executorId')
  assert.match(unknown.message, /workerId/)
  assert.match(unknown.message, /executorId/)
  assert.match(unknown.message, /goal/)

  // 2. The same boundary applies to a deprecated tool alias, under its own
  //    name, with the matching legacy hint.
  const aliasUnknown = await fixture.callAs(chat, 'chat_request', { goal: 'alias', workerSeq: 2 })
  assertShape(aliasUnknown, 'unknown_parameter', 'workerSeq')
  assert.equal(aliasUnknown.tool, 'chat_request')
  assert.equal(aliasUnknown.replacement, 'executorSeq')
  assert.match(aliasUnknown.message, /executorSeq/)

  // 3. Missing required and type / enum failures are distinct codes.
  const missing = await fixture.callAs(chat, 'ria_chat_request', { acceptance: 'x' })
  assertShape(missing, 'missing_required', 'goal')
  assert.deepEqual(missing.missingFields, ['goal'])
  assert.match(missing.message, /goal/)

  const badType = await fixture.callAs(chat, 'ria_chat_request', { goal: 42 })
  assertShape(badType, 'invalid_argument', 'goal')
  assert.equal(badType.expected, 'string')
  assert.equal(badType.got, 'number')

  const badEnum = await fixture.callAs(chat, 'ria_chat_grant', { action: 'bogus' })
  assertShape(badEnum, 'invalid_argument', 'action')
  assert.deepEqual(badEnum.allowed, ['set', 'list', 'reset'])
  assert.equal(badEnum.got, 'bogus')

  // 4. Nested objects are strict too: the field path and nested legal keys are
  //    reported, not silently ignored.
  const nested = await fixture.callAs(chat, 'ria_chat_co_manage', { action: 'list', relay: { bogus: true } })
  assertShape(nested, 'unknown_parameter', 'relay.bogus')
  assert.ok(nested.allowed.includes('relayReplies'))

  // 5. None of the rejected chat calls created a ticket: no fallback dispatch.
  assert.equal(ticketCount(), beforeInvalid, 'rejected calls must not create a ticket')

  // 6. A valid call still works and yields the exact same shape as before.
  const valid = await fixture.callAs(chat, 'ria_chat_request', { goal: 'strict validation valid call' })
  assert.equal(valid.ok, true, JSON.stringify(valid))
  assert.equal(valid.mode, 'work')
  assert.ok(valid.ticketId)

  // 7. Advisor, Executor, Sage and reflection tools are covered as well.
  const advisor = controller.advisor('global').sessionId
  const advisorMissing = await fixture.callAs(advisor, 'ria_ticket_block', { ticketId: valid.ticketId })
  assertShape(advisorMissing, 'missing_required', 'reason')
  assert.equal(advisorMissing.tool, 'ria_ticket_block')

  const dispatchHint = await fixture.callAs(advisor, 'ria_ticket_dispatch', {
    ticketId: valid.ticketId, workerSessionId: 'session-legacy',
  })
  assertShape(dispatchHint, 'unknown_parameter', 'workerSessionId')
  assert.equal(dispatchHint.replacement, 'executorSessionId')

  const planned = await fixture.callAs(advisor, 'ria_ticket_plan', {
    ticketId: valid.ticketId, summary: 'strict executor coverage', steps: ['report'],
  })
  assert.equal(planned.ok, true, JSON.stringify(planned))
  const dispatched = await fixture.callAs(advisor, 'ria_ticket_dispatch', { ticketId: valid.ticketId })
  assert.equal(dispatched.ok, true, JSON.stringify(dispatched))
  const executor = dispatched.executorSessionId
  const executorUnknown = await fixture.callAs(executor, 'ria_executor_report', {
    ticketId: valid.ticketId, status: 'progress', summary: 'x', bogus: true,
  })
  assertShape(executorUnknown, 'unknown_parameter', 'bogus')
  assert.equal(executorUnknown.tool, 'ria_executor_report')

  const sage = (await controller.ensureSage()).sessionId
  const sageUnknown = await fixture.callAs(sage, 'ria_sage_read', { bogus: true })
  assertShape(sageUnknown, 'unknown_parameter', 'bogus')
  assert.equal(sageUnknown.tool, 'ria_sage_read')
  const sageAliasUnknown = await fixture.callAs(sage, 'sage_read', { bogus: true })
  assertShape(sageAliasUnknown, 'unknown_parameter', 'bogus')
  assert.equal(sageAliasUnknown.tool, 'sage_read')

  const reflectionRequest = await controller.requestTicket({
    goal: 'strict reflection coverage', acceptance: 'validation only',
  }, { agent: { id: chat } }, { mode: 'reflection' })
  assert.equal(reflectionRequest.ok, true, JSON.stringify(reflectionRequest))
  const reflectionPlan = await fixture.callAs(advisor, 'ria_ticket_plan', {
    ticketId: reflectionRequest.ticketId, summary: 'read', steps: ['ria_reflect_status'],
  })
  assert.equal(reflectionPlan.ok, true, JSON.stringify(reflectionPlan))
  const reflectionDispatch = await fixture.callAs(advisor, 'ria_ticket_dispatch', { ticketId: reflectionRequest.ticketId })
  assert.equal(reflectionDispatch.ok, true, JSON.stringify(reflectionDispatch))
  const reflectionExecutor = reflectionDispatch.executorSessionId

  const reflectUnknown = await fixture.callAs(reflectionExecutor, 'ria_reflect_status', { bogus: true })
  assertShape(reflectUnknown, 'unknown_parameter', 'bogus')
  assert.equal(reflectUnknown.tool, 'ria_reflect_status')

  const reflectEnum = await fixture.callAs(reflectionExecutor, 'ria_reflect_status', { scope: 'bogus' })
  assertShape(reflectEnum, 'invalid_argument', 'scope')
  assert.deepEqual(reflectEnum.allowed, ['candidates', 'all'])

  const sessionMissing = await fixture.callAs(reflectionExecutor, 'ria_session_events', {})
  assertShape(sessionMissing, 'missing_required', 'sessionId')
  assert.equal(sessionMissing.tool, 'ria_session_events')

  const reflectValid = await fixture.callAs(reflectionExecutor, 'ria_reflect_status', {})
  assert.equal(reflectValid.runId, reflectionRequest.ticketId, JSON.stringify(reflectValid))
  assert.equal(reflectValid.state, 'running')

  // 8. Audit is metadata-only: tool/code/field for each rejection and no input
  //    value. The unknown-parameter secret must never reach router-events.jsonl.
  const routerInvalid = invalidEvents()
  assert.ok(routerInvalid.length >= 9, JSON.stringify(routerInvalid))
  for (const code of ['unknown_parameter', 'missing_required', 'invalid_argument']) {
    assert.ok(routerInvalid.some(item => item.payload && item.payload.code === code), code)
  }
  const auditedTools = new Set(routerInvalid.map(item => item.payload && item.payload.tool))
  for (const tool of ['ria_chat_request', 'chat_request', 'ria_ticket_block', 'ria_executor_report', 'ria_sage_read', 'ria_reflect_status', 'ria_session_events']) {
    assert.ok(auditedTools.has(tool), 'missing audit for ' + tool)
  }
  const auditText = JSON.stringify(routerInvalid)
  assert.equal(auditText.includes(SECRET), false, 'audit must not contain input values')
  assert.equal(auditText.includes('987654321'), false, 'audit must not contain input values')
  for (const item of routerInvalid) {
    assert.equal(typeof item.payload.tool, 'string')
    assert.equal(typeof item.payload.code, 'string')
    assert.equal(typeof item.payload.field, 'string')
    assert.equal(typeof item.sessionId, 'string')
  }

  // 9. Every registered ria_* root schema is strict, so the validator always
  //    has a legal-field list and no tool can silently accept an extra key.
  const definitions = new Map()
  for (const map of [fixture.installed, ...fixture.agentTools.values()]) {
    if (!map || typeof map.values !== 'function') continue
    for (const [name, definition] of map) if (name.startsWith('ria_')) definitions.set(name, definition)
  }
  assert.ok(definitions.size >= 30, 'expected the role tool catalog, got ' + definitions.size)
  for (const [name, definition] of definitions) {
    assert.equal(definition.parameters && definition.parameters.additionalProperties, false, name + ' must set additionalProperties:false')
  }

  console.log('tool input validation ok')
} finally {
  fixture.cleanup()
}
