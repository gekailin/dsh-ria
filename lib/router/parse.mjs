export class RouterError extends Error {
  constructor(code, message, details = {}) {
    super(message)
    this.name = 'RouterError'
    this.code = code
    this.details = details
  }
}

export function parseJsonObject(text) {
  const cleaned = String(text || '')
    .replace(/^\s*```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/i, '')
    .trim()
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  if (start < 0 || end < start) {
    throw new RouterError('invalid_model_output', 'model output contains no JSON object', { raw: String(text || '') })
  }
  let parsed
  try {
    parsed = JSON.parse(cleaned.slice(start, end + 1))
  } catch (error) {
    throw new RouterError('invalid_model_output', 'model output is not valid JSON: ' + String(error && error.message ? error.message : error), { raw: String(text || '') })
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new RouterError('invalid_model_output', 'model output must be a JSON object', { raw: String(text || '') })
  }
  return parsed
}

function inferKind(id) {
  if (id === 'global') return 'global'
  if (id.startsWith('project:')) return 'project'
  if (id.startsWith('session:')) return 'session'
  return 'action'
}

export function normalizeCandidates(input, mode) {
  if (!Array.isArray(input) || input.length === 0) {
    throw new RouterError('invalid_candidates', 'candidates must be a non-empty array')
  }
  const seen = new Set()
  return input.map((candidate, index) => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      throw new RouterError('invalid_candidates', 'candidate at index ' + index + ' must be an object')
    }
    const id = String(candidate.id || '').trim()
    if (!id) throw new RouterError('invalid_candidates', 'candidate at index ' + index + ' is missing id')
    if (seen.has(id)) throw new RouterError('invalid_candidates', 'duplicate candidate id: ' + id)
    seen.add(id)
    return {
      id,
      kind: String(candidate.kind || inferKind(id)),
      label: String(candidate.label || id),
      description: String(candidate.description || ''),
    }
  })
}
