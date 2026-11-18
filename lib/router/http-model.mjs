export const PROVIDER_CONFIGS = {
  friday: {
    name: 'friday',
    label: 'FRIDAY',
    protocol: 'chat-completions',
    model: 'deepseek-v4-flash',
    url: 'http://localhost:8787/chat/completions',
    modelsUrl: 'http://localhost:8787/v1/models',
    headers: () => {
      const key = globalThis.process?.env?.FRIDAY_API_KEY || ''
      return key ? { Authorization: 'Bearer ' + key } : {}
    },
  },
  mccodex: {
    name: 'mccodex',
    label: 'MCCODEX',
    protocol: 'responses',
    model: 'deepseek-v4.1-flash',
    url: 'http://localhost:7878/v1/responses',
    modelsUrl: 'http://localhost:7878/v1/models',
    headers: () => {
      const key = globalThis.process?.env?.MCCODEX_API_KEY || 'mccodex'
      return { Authorization: 'Bearer ' + key }
    },
  },
}

async function fetchWithTimeout(url, options, timeoutMs) {
  return fetch(url, { ...options, signal: AbortSignal.timeout(timeoutMs) })
}

export async function probeProvider(name, timeoutMs = 1500) {
  const config = PROVIDER_CONFIGS[name]
  if (!config) throw new Error('unknown provider: ' + String(name))
  try {
    const response = await fetchWithTimeout(config.modelsUrl, { method: 'GET', headers: config.headers() }, timeoutMs)
    return {
      ok: response.ok,
      status: response.status,
      detail: response.ok ? 'ok' : (await response.text()).slice(0, 200),
    }
  } catch (error) {
    return { ok: false, status: 0, detail: String(error && error.message ? error.message : error) }
  }
}

export async function resolveProvider(requested = 'auto') {
  if (requested !== 'auto') {
    if (!PROVIDER_CONFIGS[requested]) throw new Error('unknown provider: ' + String(requested))
    return { name: requested, fallback: null, probe: { ok: true, skipped: true, detail: 'explicit provider; checked at call time' } }
  }
  const friday = await probeProvider('friday')
  if (friday.ok) return { name: 'friday', fallback: null, probe: friday }
  const mccodex = await probeProvider('mccodex')
  if (mccodex.ok) {
    return { name: 'mccodex', fallback: { from: 'friday', reason: friday.detail }, probe: mccodex }
  }
  throw new Error('no model endpoint available: friday=' + friday.detail + '; mccodex=' + mccodex.detail)
}

function contentToText(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .filter(part => part && (part.type === 'text' || part.type === 'output_text'))
      .map(part => part.text || '')
      .join('')
  }
  return ''
}

function extractText(json, protocol) {
  if (protocol === 'chat-completions') {
    return contentToText(json?.choices?.[0]?.message?.content) || ''
  }
  if (typeof json?.output_text === 'string') return json.output_text
  const parts = []
  for (const item of json?.output || []) {
    if (item?.type !== 'message') continue
    parts.push(contentToText(item.content))
  }
  return parts.join('')
}

export function createHttpModel(name, { timeoutMs = 120000, maxTokens = 1000 } = {}) {
  const config = PROVIDER_CONFIGS[name]
  if (!config) throw new Error('unknown provider: ' + String(name))
  return {
    provider: config.name,
    model: config.model,
    async generate({ system, user, maxTokens: callMaxTokens = maxTokens, timeoutMs: callTimeoutMs = timeoutMs }) {
      const headers = { 'Content-Type': 'application/json', ...config.headers() }
      const body = config.protocol === 'chat-completions'
        ? {
            model: config.model,
            messages: [
              { role: 'system', content: system },
              { role: 'user', content: user },
            ],
            temperature: 0,
            stream: false,
            max_tokens: callMaxTokens,
          }
        : {
            model: config.model,
            input: [
              { role: 'system', content: system },
              { role: 'user', content: user },
            ],
            max_output_tokens: callMaxTokens,
            reasoning: { effort: 'low' },
          }
      const started = Date.now()
      const response = await fetchWithTimeout(config.url, { method: 'POST', headers, body: JSON.stringify(body) }, callTimeoutMs)
      const latencyMs = Date.now() - started
      const raw = await response.text()
      if (!response.ok) {
        throw new Error(config.name + ' request failed (' + response.status + '): ' + raw.slice(0, 500))
      }
      let json
      try {
        json = JSON.parse(raw)
      } catch (error) {
        throw new Error(config.name + ' returned non-JSON body: ' + raw.slice(0, 500))
      }
      const text = extractText(json, config.protocol)
      if (!text) throw new Error(config.name + ' returned no text content')
      return { text, usage: json.usage || null, raw, latencyMs }
    },
  }
}
