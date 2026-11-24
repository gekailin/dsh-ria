// Pure prompt/parse helpers for the stateless Advisor. The controller owns the
// LLM call, persistence and dispatch; this module has no session/IO state.

import { advisorPrompt, ticketBrief } from './prompts.mjs'

const text = value => typeof value === 'string' ? value.trim() : ''

export const ADVISOR_MAX_TOKENS = 8000
export const ADVISOR_TIMEOUT_MS = 60_000
export const ADVISOR_TRUNCATED_REASONS = Object.freeze(['length', 'max_tokens', 'max_output_tokens', 'incomplete'])

export function isAdvisorTruncatedFinish(reason) {
  return ADVISOR_TRUNCATED_REASONS.includes(String(reason || '').toLowerCase())
}

export { advisorPlanSystemPrompt } from '../prompts/advisor.mjs'


export function buildAdvisorPlanInput({ ticket, request, meta = {}, extra = '', snapshot = null, degraded = false, experience = [] } = {}) {
  const lines = [ticketBrief(ticket, request, meta)]
  if (extra) lines.push('', extra)
  lines.push('', '[认知快照]', snapshot && snapshot.snapshot ? snapshot.snapshot : '（无可用认知）')
  const lessons = Array.isArray(experience) ? experience.slice(0, 5) : []
  if (lessons.length) {
    lines.push('', '[相关历史经验（Router 已注入，最多 5 条；每条带 id/source，正文 <=200 字）]')
    for (const lesson of lessons) {
      if (!lesson || !lesson.text) continue
      lines.push('- [' + (lesson.id || '?') + '] ' + String(lesson.text).slice(0, 200) + (lesson.source ? '  (' + lesson.source + ')' : ''))
    }
  }
  if (degraded) lines.push('', '[认知状态] degraded：认知检索失败，只按最小原则执行；WorkOrder 中显式标注 cognition_status: degraded。')
  return lines.join('\n')
}

function optionalTopic(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const action = text(value.action)
  if (action !== 'reuse' && action !== 'create') return undefined
  return {
    action,
    ...(text(value.topicId) ? { topicId: text(value.topicId) } : {}),
    ...(text(value.title) ? { title: text(value.title) } : {}),
    ...(text(value.brief) ? { brief: text(value.brief) } : {}),
  }
}

function optionalRouting(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const tags = Array.isArray(value.tags) ? value.tags.map(text).filter(Boolean).slice(0, 4) : []
  const requireTagMatch = value.requireTagMatch === true
  if (!tags.length && !requireTagMatch) return undefined
  return { ...(tags.length ? { tags } : {}), ...(requireTagMatch ? { requireTagMatch: true } : {}) }
}

function firstJsonObject(raw) {
  const body = String(raw == null ? '' : raw).trim()
  const start = body.indexOf('{')
  if (start < 0) return null
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = start; index < body.length; index += 1) {
    const char = body[index]
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') { inString = true; continue }
    if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) return body.slice(start, index + 1)
    }
  }
  return null
}

const TOOL_CALL_TRACE = /<(?:tool_call|function_call|grep|read|bash)\b/i

export function detectToolCallTraces(raw) {
  return TOOL_CALL_TRACE.test(String(raw == null ? '' : raw))
}

export function parseAdvisorOutput(raw) {
  const source = String(raw == null ? '' : raw).trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim()
  if (detectToolCallTraces(source)) {
    const fragment = source.slice(0, 200)
    return { ok: false, code: 'advisor_attempted_tool_call', message: 'Advisor attempted a tool call; output: ' + fragment, outputFragment: fragment }
  }
  const json = firstJsonObject(source)
  if (!json) return { ok: false, code: 'invalid_output', message: 'no JSON object found' }
  let value
  try { value = JSON.parse(json) } catch (error) {
    return { ok: false, code: 'invalid_output', message: 'invalid JSON: ' + String(error && error.message ? error.message : error) }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false, code: 'invalid_output', message: 'output must be a JSON object' }
  const action = text(value.action)
  if (action === 'plan') {
    const workOrder = value.workOrder && typeof value.workOrder === 'object' ? value.workOrder : {}
    const summary = text(workOrder.summary)
    const steps = Array.isArray(workOrder.steps) ? workOrder.steps.map(text).filter(Boolean) : []
    if (!summary) return { ok: false, code: 'summary_required', message: 'plan.summary is required' }
    if (!steps.length) return { ok: false, code: 'steps_required', message: 'plan.steps must contain at least one step' }
    // topic/routing are optional annotations: a malformed value is dropped, but
    // the WorkOrder itself stays valid and the plan is never blocked by it.
    const normalized = { ...workOrder, summary, steps }
    const topic = optionalTopic(workOrder.topic)
    if (topic) normalized.topic = topic
    else delete normalized.topic
    const routing = optionalRouting(workOrder.routing)
    if (routing) normalized.routing = routing
    else delete normalized.routing
    return { ok: true, action, workOrder: normalized }
  }
  if (action === 'block') {
    const block = value.block && typeof value.block === 'object' ? value.block : {}
    if (!text(block.reason)) return { ok: false, code: 'reason_required', message: 'block.reason is required' }
    return { ok: true, action, block: { ...block, reason: text(block.reason), ...(text(block.question) ? { question: text(block.question) } : {}) } }
  }
  return { ok: false, code: 'invalid_output', message: 'action must be plan or block' }
}
