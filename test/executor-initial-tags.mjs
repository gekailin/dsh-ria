import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { createFixture } from './support/ria-fixture.mjs'

const workspace = mkdtempSync(join(tmpdir(), 'ria-initial-tags-'))
const fixture = await createFixture({ stateDefault: true })
try {
  const controller = fixture.service.controller
  const first = await controller.ensureExecutor('global', null, undefined, null, null, null, { ticketTags: ['frontend'] })
  const firstMeta = controller.state.executor(first.sessionId)
  assert.equal(first.created, true)
  assert.ok(firstMeta.tags.length > 0, 'new work Executor must have non-empty initial tags')
  assert.deepEqual(firstMeta.tags, ['frontend'], 'explicit ticket tags should not be polluted by fallback tag')

  const second = await controller.ensureExecutor('global', 'proj-x', workspace, null, null, null, {
    avoidExecutorIds: new Set([first.sessionId]),
  })
  const secondMeta = controller.state.executor(second.sessionId)
  assert.equal(second.created, true)
  assert.ok(secondMeta.tags.length > 0, 'fallback tags must still be non-empty')
  assert.ok(secondMeta.tags.some(tag => ['proj-x', basename(workspace), 'general'].includes(tag)), JSON.stringify(secondMeta.tags))

  // Dispatching a tagged ticket to a managed work Executor actively updates tags
  // in LRU order (newest first, capped at 6) and replaces a bare 'general' fallback.
  controller.state.addExecutor(first.sessionId, { status: 'idle', currentTicketId: null, tags: ['general'] })
  const dispatchTagged = async (executorId, tags) => {
    const ticket = fixture.service.store.addTicket({ status: 'open', executor: 'advisor', goal: 'tag update ' + tags.join(','), acceptance: 'ok' })
    controller.state.setTicketMeta(ticket.ticketId, { phase: 'planned', scope: 'global', mode: 'work', routingTags: tags })
    controller.state.setWorkOrder(ticket.ticketId, { ticketId: ticket.ticketId, summary: 'plan', steps: ['run'], routing: { tags } })
    const res = await controller.dispatchTicket(ticket.ticketId, executorId)
    assert.equal(res.ok, true, JSON.stringify(res))
    fixture.service.store.transitionTicket(ticket.ticketId, 'done', { actor: 'executor', executor: executorId, resolution: { kind: 'done', summary: 'ok', evidence: [] }, reason: 'test' })
    controller.state.addExecutor(executorId, { status: 'idle', currentTicketId: null })
  }
  await dispatchTagged(first.sessionId, ['alpha', 'beta'])
  assert.deepEqual(controller.state.executor(first.sessionId).tags, ['alpha', 'beta'], 'replaces bare general fallback')
  await dispatchTagged(first.sessionId, ['gamma', 'delta', 'epsilon', 'zeta', 'eta'])
  assert.deepEqual(controller.state.executor(first.sessionId).tags, ['gamma', 'delta', 'epsilon', 'zeta', 'eta', 'alpha'], 'LRU keeps newest 6 and evicts oldest tail')
  // Empty routingTags leaves existing tags untouched.
  await dispatchTagged(first.sessionId, [])
  assert.deepEqual(controller.state.executor(first.sessionId).tags, ['gamma', 'delta', 'epsilon', 'zeta', 'eta', 'alpha'])

  // Preset recreate on a legacy empty-tags work Executor still guarantees non-empty tags.
  controller.state.addExecutor(second.sessionId, { status: 'idle', currentTicketId: null, tags: [] })
  const recreated = await controller.recreateExecutor(controller.state.executor(second.sessionId), { preset: 'ptc' })
  assert.equal(recreated.ok, true, JSON.stringify(recreated))
  assert.ok(controller.state.executor(recreated.executor.sessionId).tags.length > 0, 'recreated work executor must have non-empty tags')

  console.log('executor initial tags ok')
} finally {
  fixture.cleanup()
}
