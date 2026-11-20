// Pure prompt/parse helpers for the stateless Advisor. The controller owns the
// LLM call, persistence and dispatch; this module has no session/IO state.

import { advisorPrompt, ticketBrief } from './prompts.mjs'

const text = value => typeof value === 'string' ? value.trim() : ''

export { advisorPlanSystemPrompt } from '../prompts/advisor.mjs'


export function buildAdvisorPlanInput({ ticket, request, meta = {}, extra = '', snapshot = null, degraded = false } = {}) {
  const lines = [ticketBrief(ticket, request, meta)]
  if (extra) lines.push('', extra)
  lines.push('', '[认知快照]', snapshot && snapshot.snapshot ? snapshot.snapshot : '（无可用认知）')
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

export function parseAdvisorOutput(raw) {
  const source = String(raw == null ? '' : raw).trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim()
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
