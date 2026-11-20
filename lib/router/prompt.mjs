import { ROUTER_SYSTEM_PROMPT } from '../prompts/router.mjs'
export const ROUTER_PROMPT_VERSION = 'router-v1'

export const SCORE_SCHEMA = {
  scores: [
    {
      candidate_id: 'string',
      score: 'number 0-10',
      confidence: 'number 0-1',
      reason: 'string <= 30 chars',
    },
  ],
  no_fit: 'number 0-10',
  needs_clarification: 'boolean',
}

export function buildRoutingPrompt({ mode, candidates, request }) {
  if (mode !== 'project' && mode !== 'session') {
    throw new TypeError('unknown routing mode: ' + String(mode))
  }
  if (!Array.isArray(candidates) || candidates.length === 0) {
    throw new TypeError('candidates must be a non-empty array')
  }
  const text = String(request || '').trim()
  if (!text) throw new TypeError('request is required')

  const candidateLines = candidates
    .map((candidate, index) => {
      return [
        String(index + 1) + '. ' + String(candidate.id),
        String(candidate.kind || 'unknown'),
        String(candidate.label || candidate.id),
        String(candidate.description || ''),
      ].join(' | ')
    })
    .join('\n')

  const system = ROUTER_SYSTEM_PROMPT

  const user = [
    '<候选>',
    candidateLines,
    '</候选>',
    '',
    '<待路由内容>',
    text,
    '</待路由内容>',
    '',
    '输出格式：',
    JSON.stringify(SCORE_SCHEMA, null, 2),
  ].join('\n')

  return { system, user, mode, promptVersion: ROUTER_PROMPT_VERSION }
}
