import { RouterError } from './parse.mjs'

function failureText(failure) {
  if (!failure) return 'model request failed'
  if (typeof failure === 'string') return failure
  return String(failure.message || failure.code || 'model request failed')
}

export function createLlmModel({ llm, provider, model, maxTokens = 1000, temperature = 0, timeoutMs = 120000, reasoningEffort }) {
  if (!llm || typeof llm.stream !== 'function') {
    throw new RouterError('llm_unavailable', 'llm service is unavailable')
  }
  if (!provider || !model) {
    throw new RouterError('model_required', 'provider and model are required')
  }

  return {
    provider,
    model,
    ...(reasoningEffort ? { reasoningEffort } : {}),
    async generate({ system, user, maxTokens: callMaxTokens = maxTokens, temperature: callTemperature = temperature, timeoutMs: callTimeoutMs = timeoutMs, reasoningEffort: callReasoningEffort = reasoningEffort }) {
      const started = Date.now()
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(new Error('router model timeout')), callTimeoutMs)
      let text = ''
      let usage = null
      let finish = null
      try {
        for await (const chunk of llm.stream({
          provider,
          model,
          // One-shot callers inherit the effort the chat runs with, verbatim.
          // An absent effort means "no explicit effort" for the chat too, so
          // the adapter default applies on both sides.
          ...(callReasoningEffort ? { reasoningEffort: callReasoningEffort } : {}),
          system,
          messages: [{ role: 'user', content: [{ type: 'text', text: user }] }],
          temperature: callTemperature,
          maxTokens: callMaxTokens,
          signal: controller.signal,
        })) {
          if (!chunk || typeof chunk !== 'object') continue
          if (chunk.type === 'text-delta') text += String(chunk.text || '')
          else if (chunk.type === 'usage') usage = chunk.usage || null
          else if (chunk.type === 'finish') finish = chunk
        }
      } catch (error) {
        throw new RouterError('model_request_failed', failureText(error), { cause: error })
      } finally {
        clearTimeout(timer)
      }
      if (!finish) throw new RouterError('model_request_failed', 'model stream ended without a finish chunk')
      const kind = typeof finish.reason === 'string' ? finish.reason : finish.reason?.kind
      if (kind === 'error' || kind === 'aborted') {
        const failure = finish.reason && typeof finish.reason === 'object' ? finish.reason.failure : undefined
        throw new RouterError('model_' + kind, failureText(failure), { failure })
      }
      return { text, usage, finish, latencyMs: Date.now() - started }
    },
  }
}
