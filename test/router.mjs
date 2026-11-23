import assert from 'node:assert/strict'
import { createFixture } from './support/ria-fixture.mjs'
import {
  buildRoutingPrompt,
  decideRoute,
  defaultCandidates,
  normalizeRouterScores,
  parseJsonObject,
  routeWithLlm,
  routeWithModel,
} from '../lib/router/index.mjs'

const projectCandidates = defaultCandidates('project')
const sessionCandidates = defaultCandidates('session')

// Prompt: every candidate is represented, the request is data, and the model is
// told to return only JSON.
{
  const built = buildRoutingPrompt({
    mode: 'project',
    candidates: projectCandidates,
    request: '把 Ria 看板按项目分组',
  })
  assert.match(built.system, /只输出一个 JSON 对象/)
  assert.match(built.user, /project:dsh-ria/)
  assert.match(built.user, /把 Ria 看板按项目分组/)
  assert.equal(built.promptVersion, 'router-v1')
}

// Parsing tolerates a Markdown fence and rejects prose without an object.
{
  const fence = String.fromCharCode(96).repeat(3)
  const parsed = parseJsonObject(fence + 'json\n{"scores":[]}\n' + fence)
  assert.deepEqual(parsed, { scores: [] })
  assert.throws(() => parseJsonObject('no json here'), /no JSON object/)
}

// Short labels returned by the model are normalized to the full candidate id.
{
  const normalized = normalizeRouterScores(projectCandidates, {
    scores: [{ candidate_id: 'dsh-ria', score: 9, confidence: 0.9, reason: 'fit' }],
  })
  const item = normalized.find(entry => entry.id === 'project:dsh-ria')
  assert.equal(item.rawScore, 9)
  assert.equal(item.missing, false)
}

// A clear winner routes directly.
{
  const decision = decideRoute({
    mode: 'project',
    candidates: projectCandidates,
    parsed: {
      scores: [
        { candidate_id: 'project:dsh-ria', score: 9 },
        { candidate_id: 'project:web-ui', score: 4 },
        { candidate_id: 'global', score: 2 },
        { candidate_id: 'ask', score: 1 },
      ],
      no_fit: 0,
      needs_clarification: false,
    },
  })
  assert.equal(decision.action, 'route')
  assert.equal(decision.candidateId, 'project:dsh-ria')
  assert.equal(decision.rule, 'clear-winner')
}

// All weak scores fall back to ask; nothing is dispatched on a guess.
{
  const decision = decideRoute({
    mode: 'project',
    candidates: projectCandidates,
    parsed: {
      scores: projectCandidates.map(candidate => ({
        candidate_id: candidate.id,
        score: candidate.id === 'ask' ? 1 : 3,
      })),
      no_fit: 8,
    },
  })
  assert.equal(decision.action, 'ask')
  assert.equal(decision.rule, 'below-threshold')
}

// new_session pays a small cost; a nearly equal existing session wins.
{
  const decision = decideRoute({
    mode: 'session',
    candidates: sessionCandidates,
    parsed: {
      scores: [
        { candidate_id: 'new_session', score: 8 },
        { candidate_id: 'session:impl', score: 7 },
      ],
    },
  })
  assert.equal(decision.action, 'route')
  assert.equal(decision.candidateId, 'session:impl')
  assert.equal(decision.rule, 'tie-existing-over-new')
}

// A close concrete project beats global.
{
  const decision = decideRoute({
    mode: 'project',
    candidates: projectCandidates,
    parsed: {
      scores: [
        { candidate_id: 'global', score: 8 },
        { candidate_id: 'project:dsh-ria', score: 7.7 },
      ],
    },
  })
  assert.equal(decision.action, 'route')
  assert.equal(decision.candidateId, 'project:dsh-ria')
  assert.equal(decision.rule, 'tie-specific-over-global')
}

// End-to-end routing with a fake model, no network or session.
{
  const model = {
    provider: 'fake',
    model: 'fake-router',
    async generate({ system, user }) {
      assert.match(system, /路由打分器/)
      assert.match(user, /project:dsh-ria/)
      return {
        text: JSON.stringify({
          scores: [
            { candidate_id: 'project:dsh-ria', score: 9, confidence: 0.9, reason: 'Ria work' },
            { candidate_id: 'project:web-ui', score: 3, confidence: 0.8, reason: 'not UI' },
            { candidate_id: 'global', score: 2, confidence: 0.7, reason: 'not cross-project' },
            { candidate_id: 'ask', score: 1, confidence: 0.9, reason: 'clear enough' },
          ],
          no_fit: 0,
          needs_clarification: false,
        }),
        latencyMs: 12,
      }
    },
  }
  const result = await routeWithModel({
    model,
    mode: 'project',
    request: '把 Ria 看板按项目分组',
  })
  assert.equal(result.ok, true)
  assert.equal(result.decision.action, 'route')
  assert.equal(result.decision.candidateId, 'project:dsh-ria')
  assert.equal(result.provider, 'fake')
  assert.equal(result.latencyMs, 12)
}

// The DSH llm path sends one hand-built request and never sets a sessionId.
{
  const llm = {
    async *stream(options) {
      assert.equal(options.sessionId, undefined)
      assert.match(options.system, /路由打分器/)
      yield { type: 'text-delta', index: 0, text: JSON.stringify({
        scores: [
          { candidate_id: 'project:dsh-ria', score: 9, confidence: 0.9, reason: 'Ria work' },
          { candidate_id: 'project:web-ui', score: 2, confidence: 0.8, reason: 'not UI' },
          { candidate_id: 'global', score: 1, confidence: 0.7, reason: 'not cross-project' },
          { candidate_id: 'ask', score: 1, confidence: 0.9, reason: 'clear enough' },
        ],
        no_fit: 0,
        needs_clarification: false,
      }) }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  const result = await routeWithLlm({
    llm,
    provider: 'fake',
    model: 'fake-router',
    mode: 'project',
    request: '把 Ria 看板按项目分组',
  })
  assert.equal(result.decision.action, 'route')
  assert.equal(result.decision.candidateId, 'project:dsh-ria')
  assert.equal(result.provider, 'fake')
}

// The host method uses the captured llm service and leaves Ria state untouched.
{
  const fixture = await createFixture()
  try {
    const service = fixture.service
    service.routerLlm = {
      async *stream(options) {
        assert.equal(options.sessionId, undefined)
        yield { type: 'text-delta', index: 0, text: JSON.stringify({
          scores: [
            { candidate_id: 'project:dsh-ria', score: 9, confidence: 0.9, reason: 'Ria work' },
            { candidate_id: 'project:web-ui', score: 2, confidence: 0.8, reason: 'not UI' },
            { candidate_id: 'global', score: 1, confidence: 0.7, reason: 'not cross-project' },
            { candidate_id: 'ask', score: 1, confidence: 0.9, reason: 'clear enough' },
          ],
          no_fit: 0,
          needs_clarification: false,
        }) }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    }
    const before = service.store.tickets().length
    const result = await service.routerScore({
      mode: 'project',
      request: '把 Ria 看板按项目分组',
      provider: 'fake',
      model: 'fake-router',
    })
    assert.equal(result.decision.candidateId, 'project:dsh-ria')
    assert.equal(service.store.tickets().length, before)
  } finally {
    fixture.cleanup()
  }
}

// Without an explicit provider/model the host method scores with the chat's
// model: switching the chat model switches the Router too.
{
  const fixture = await createFixture()
  try {
    const service = fixture.service
    const seen = []
    service.routerLlm = {
      async *stream(options) {
        seen.push({ provider: options.provider, model: options.model, reasoningEffort: options.reasoningEffort })
        yield { type: 'text-delta', index: 0, text: JSON.stringify({
          scores: [
            { candidate_id: 'project:dsh-ria', score: 9, confidence: 0.9, reason: 'Ria work' },
            { candidate_id: 'project:web-ui', score: 2, confidence: 0.8, reason: 'not UI' },
            { candidate_id: 'global', score: 1, confidence: 0.7, reason: 'not cross-project' },
            { candidate_id: 'ask', score: 1, confidence: 0.9, reason: 'clear enough' },
          ],
          no_fit: 0,
          needs_clarification: false,
        }) }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    }
    const result = await service.routerScore({ mode: 'project', request: '把 Ria 看板按项目分组' })
    assert.equal(seen.length, 1)
    assert.equal(seen[0].provider, 'provider-ok')
    assert.equal(seen[0].model, 'model-vision')
    assert.equal(seen[0].reasoningEffort, undefined)
    assert.equal(result.provider, 'provider-ok')
    assert.equal(result.reasoningEffort, null)

    // The chat's model AND thinking effort both follow the selection.
    await fixture.ctx.sessionController.selectModel({ sessionId: fixture.service.store.riaSessionId, provider: 'provider-ok', model: 'model-fast', reasoningEffort: 'high' })
    const switched = await service.routerScore({ mode: 'project', request: '把 Ria 看板按项目分组' })
    assert.equal(seen[1].model, 'model-fast')
    assert.equal(seen[1].reasoningEffort, 'high')
    assert.equal(switched.provider, 'provider-ok')
    assert.equal(switched.reasoningEffort, 'high')
  } finally {
    fixture.cleanup()
  }
}

console.log('router tests passed')
