import { buildRoutingPrompt, ROUTER_PROMPT_VERSION } from './prompt.mjs'
import { decideRoute, decisionMatches, normalizeRouterScores } from './decide.mjs'
import { cases, defaultCandidates, ROUTER_MODES } from './cases.mjs'
import { normalizeCandidates, parseJsonObject, RouterError } from './parse.mjs'
import { createLlmModel } from './llm-model.mjs'

export {
  buildRoutingPrompt,
  cases,
  decideRoute,
  decisionMatches,
  defaultCandidates,
  normalizeCandidates,
  normalizeRouterScores,
  parseJsonObject,
  ROUTER_MODES,
  ROUTER_PROMPT_VERSION,
  RouterError,
  createLlmModel,
}

export async function routeWithModel({ model, mode, request, candidates, options = {} }) {
  if (!ROUTER_MODES.includes(mode)) {
    throw new RouterError('invalid_mode', 'mode must be project or session')
  }
  if (!model || typeof model.generate !== 'function') {
    throw new RouterError('model_required', 'model adapter is required')
  }
  const text = String(request || '').trim()
  if (!text) throw new RouterError('request_required', 'request is required')

  const list = candidates === undefined ? defaultCandidates(mode) : normalizeCandidates(candidates, mode)
  const built = buildRoutingPrompt({ mode, candidates: list, request: text })
  const started = Date.now()

  let response
  try {
    response = await model.generate({
      system: built.system,
      user: built.user,
      maxTokens: options.maxTokens ?? 1000,
      temperature: options.temperature ?? 0,
      timeoutMs: options.timeoutMs ?? 120000,
    })
  } catch (error) {
    if (error instanceof RouterError) throw error
    throw new RouterError('model_request_failed', String(error && error.message ? error.message : error), { cause: error })
  }

  let parsed
  try {
    parsed = parseJsonObject(response.text)
  } catch (error) {
    if (error instanceof RouterError) throw error
    throw new RouterError('invalid_model_output', String(error && error.message ? error.message : error), { raw: response.text })
  }

  const decision = decideRoute({ mode, candidates: list, parsed, options })
  return {
    ok: true,
    mode,
    request: text,
    promptVersion: ROUTER_PROMPT_VERSION,
    provider: model.provider || null,
    model: model.model || null,
    // The effort is the chat's, like the model; null means "no explicit effort".
    reasoningEffort: model.reasoningEffort || null,
    latencyMs: Number.isFinite(response.latencyMs) ? response.latencyMs : Date.now() - started,
    decision,
    scores: decision.ranked,
    parsed,
    usage: response.usage ?? null,
    raw: response.text,
  }
}

export async function routeWithLlm({ llm, provider, model, mode, request, candidates, options = {} }) {
  const adapter = createLlmModel({
    llm,
    provider,
    model,
    maxTokens: options.maxTokens,
    temperature: options.temperature,
    timeoutMs: options.timeoutMs,
    ...(options.reasoningEffort ? { reasoningEffort: options.reasoningEffort } : {}),
  })
  return routeWithModel({ model: adapter, mode, request, candidates, options })
}
