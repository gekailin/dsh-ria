import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createFixture } from './support/ria-fixture.mjs'

const fixture = await createFixture({
  v2Default: true,
  extraSessions: [
    { sessionId: 'session-user', running: false, blank: false, updatedAt: 10, cwd: '/tmp', projections: { values: { title: 'User Session' } } },
  ],
})
try {
  const controller = fixture.service.v2
  const cognition = controller.cognition
  const sage = (await controller.ensureSage()).sessionId
  const sc = fixture.service.ctx.sessionController
  const titleOf = async id => {
    const projection = await sc.projections({ sessionId: id })
    return projection && projection.values ? projection.values.title : null
  }

  // Sage role and tool surface.
  assert.equal(await titleOf(sage), 'Ria Sage')
  assert.equal(controller.v2.sageSessionId, sage)
  const sageTools = fixture.visibleTools(sage)
  assert.deepEqual(sageTools.slice().sort(), ['sage_read', 'sage_request', 'sage_write'])
  assert.equal(sageTools.includes('bash'), false)
  assert.equal(sageTools.includes('write'), false)
  assert.equal(sageTools.includes('edit'), false)

  // A compaction event re-reads INDEX (no polling).
  const beforeCompact = fixture.prompts.filter(item => String(item.sessionId) === String(sage)).length
  controller.onSessionEvent({ header: { id: sage } }, { type: 'compaction/end', data: {} })
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.ok(fixture.prompts.filter(item => String(item.sessionId) === String(sage)).length > beforeCompact)

  // Cognition bootstrap is idempotent and creates the expected files.
  const first = await controller.bootstrapCognition()
  assert.equal(first.bootstrapped, true)
  for (const file of ['principles.md', 'projects/dsh-ria.md', 'chatbot/preferences.md', 'chatbot/agreements.md', 'chatbot/decisions.md', 'INDEX.md']) {
    assert.equal(existsSync(join(controller.stateDir, 'cognition', file)), true, file)
  }
  const second = await controller.bootstrapCognition()
  assert.equal(second.bootstrapped, false)
  assert.ok(readFileSync(join(controller.stateDir, 'cognition', 'principles.md'), 'utf8').includes('全局唯一'))

  // Path traversal is rejected; normal write updates INDEX and audits.
  assert.throws(() => cognition.read('../../ria.json'), /invalid|cognition/i)
  const written = await fixture.callAs(sage, 'sage_write', {
    path: 'chatbot/preferences.md',
    content: '用户偏好：回答简洁，先给结论。',
    mode: 'replace',
    reason: 'test',
  })
  assert.equal(written.ok, true, JSON.stringify(written))
  assert.ok(cognition.read('INDEX.md').includes('chatbot/preferences.md'))
  assert.equal(cognition.read('chatbot/preferences.md').includes('先给结论'), true)

  // User proposals are high priority and land in proposals/.
  const proposed = await fixture.callAs(fixture.service.v2.v2.chatbotSessionId, 'chatbot_propose', {
    text: '用户喜欢先给结论',
    evidence: ['conversation'],
  })
  assert.equal(proposed.ok, true, JSON.stringify(proposed))
  assert.equal(proposed.proposal.priority, 'high')
  assert.ok(cognition.listProposals().some(item => item.id === proposed.proposal.id && item.author === 'user'))
  const inbox = await fixture.callAs(sage, 'sage_read', { inbox: true })
  assert.ok(inbox.proposals.some(item => item.id === proposed.proposal.id))

  // Stateless Advisor: two tickets get two sessions and the second prompt does
  // not carry the first ticket's context.
  const chatbot = fixture.service.v2.v2.chatbotSessionId
  const firstTicket = await fixture.callAs(chatbot, 'chatbot_request', { goal: 'alpha task', acceptance: 'alpha done' })
  assert.equal(firstTicket.ok, true)
  const firstSession = controller.v2.ticketMeta(firstTicket.ticketId).advisorSessionId
  const planned = await fixture.callAs(firstSession, 'ticket_plan', {
    ticketId: firstTicket.ticketId,
    summary: 'alpha plan',
    steps: ['do alpha'],
    cognitionProposal: { text: 'alpha insight', evidence: ['alpha'] },
  })
  assert.equal(planned.ok, true, JSON.stringify(planned))
  assert.ok(planned.cognitionProposal && planned.cognitionProposal.author === 'advisor')
  assert.ok(cognition.listProposals().some(item => item.id === planned.cognitionProposal.id))
  const secondTicket = await fixture.callAs(chatbot, 'chatbot_request', { goal: 'beta task', acceptance: 'beta done' })
  assert.equal(secondTicket.ok, true)
  const secondSession = controller.v2.ticketMeta(secondTicket.ticketId).advisorSessionId
  assert.notEqual(firstSession, secondSession)
  const secondPrompts = fixture.prompts.filter(item => String(item.sessionId) === String(secondSession)).map(item => String(item.content[0].text))
  assert.ok(secondPrompts.some(text => text.includes('beta task')))
  assert.equal(secondPrompts.some(text => text.includes('alpha task')), false)

  // Retrieval failure is explicit in the Advisor prompt.
  const originalRetrieve = cognition.retrieve.bind(cognition)
  cognition.retrieve = () => ({ snapshot: '', degraded: true, files: [] })
  const degradedTicket = await fixture.callAs(chatbot, 'chatbot_request', { goal: 'gamma task' })
  assert.equal(degradedTicket.ok, true)
  const degradedSession = controller.v2.ticketMeta(degradedTicket.ticketId).advisorSessionId
  assert.ok(fixture.prompts.filter(item => String(item.sessionId) === String(degradedSession)).some(item => String(item.content[0].text).includes('cognition_status: degraded')))
  cognition.retrieve = originalRetrieve

  // Chatbot memory injection: first step, then unchanged, then changed.
  const chatAgent = fixture.agentFor(chatbot)
  const decision = () => ({ kind: 'enter', messages: [] })
  const firstStep = await controller.onPreStep({ agent: chatAgent, turn: 1 }, async () => decision())
  assert.ok(firstStep.messages.some(item => item && item.source && item.source.form === 'chatbot-memory'))
  const secondStep = await controller.onPreStep({ agent: chatAgent, turn: 2 }, async () => decision())
  assert.equal(secondStep.messages.length, 0)
  cognition.write('chatbot/preferences.md', '用户偏好：先给结论，再展开。', { reason: 'change' })
  const thirdStep = await controller.onPreStep({ agent: chatAgent, turn: 3 }, async () => decision())
  assert.ok(thirdStep.messages.some(item => item && item.source && item.source.form === 'chatbot-memory'))

  // Legacy retirement clears the binding and marks stateless mode.
  controller.v2.setAdvisor('global', 'session-legacy-advisor', { cwd: '/tmp' })
  const retired = await controller.retireLegacyAdvisor()
  assert.equal(retired.retired, true)
  assert.equal(controller.v2.advisor('global'), null)
  assert.equal(controller.v2.data.advisorMode, 'stateless')

  console.log('v2 sage ok')
} finally {
  fixture.cleanup()
}
