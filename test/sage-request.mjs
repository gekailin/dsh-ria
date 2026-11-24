import assert from 'node:assert/strict'
import { createFixture } from './support/ria-fixture.mjs'

const fixture = await createFixture({ stateDefault: true })
try {
  const controller = fixture.service.controller
  const sage = (await controller.ensureSage()).sessionId
  const result = await fixture.callAs(sage, 'ria_sage_request', {
    mode: 'work', goal: 'check entry', acceptance: 'evidence', workspace: '/home/gkl/Desktop/vibe_proj/dsh-ria',
    relatedEntryIds: ['cog_1', 'cog_2'], relatedProposalId: 'prop_1',
  })
  assert.equal(result.ok, true, JSON.stringify(result))
  const meta = controller.state.ticketMeta(result.ticketId)
  assert.equal(meta.origin, 'sage')
  assert.deepEqual(meta.relatedEntryIds, ['cog_1', 'cog_2'])
  assert.equal(meta.relatedProposalId, 'prop_1')
  const ticket = fixture.service.tickets.ticket(result.ticketId)
  assert.equal(controller.notifySageResearchResult(ticket, 'done', { summary: 'checked', evidence: ['file:1'] }), true)
  assert.ok(fixture.prompts.some(item => String(item.content?.[0]?.text || '').includes('[Sage 核查回执]') && String(item.content?.[0]?.text || '').includes(result.ticketId)))
  console.log('sage request callback ok')
} finally { fixture.cleanup() }
