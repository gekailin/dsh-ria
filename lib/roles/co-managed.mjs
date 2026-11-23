import { isAbsolute, relative } from 'node:path'
import { lessonsBrief, executorBrief, workOrderBrief } from '../core/prompts.mjs'

/**
 * Co-managed transport: a normal DSH session registered as a ticket executor.
 *
 * It is deliberately not a managed Executor: no executor preset, no ria_* tools, no
 * session creation. The session keeps its own context/model/tools and the Router
 * talks to it the way a user would - one [WorkOrder #ticketId] message per
 * dispatch, then it reads the session's own events for progress.
 */
export const CO_MANAGED_KIND = 'co-managed'

export function isCoManaged(executor) {
  return Boolean(executor && executor.kind === CO_MANAGED_KIND)
}

/**
 * Hard filter against mis-dispatch: a co-managed session may only run tickets
 * whose projectCwd is non-empty and equal to / inside the session cwd. Global
 * tickets (projectCwd=null) never enter its candidate set.
 */
export function acceptsProjectCwd(executor, projectCwd) {
  if (!projectCwd || typeof projectCwd !== 'string') return false
  if (!executor || typeof executor.cwd !== 'string' || !executor.cwd) return false
  if (!isAbsolute(projectCwd) || !isAbsolute(executor.cwd)) return false
  const rel = relative(executor.cwd, projectCwd)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

const SECTION_ALIASES = [
  ['summary', ['结论', '摘要', 'summary', 'result']],
  ['evidence', ['证据', 'evidence']],
  ['artifacts', ['产物', 'artifact', 'artifacts', '文件']],
  ['todo', ['未做项', '未做', 'todo', 'remaining', 'followup', '下一步']],
]

const headingOf = line => {
  const match = /^\s{0,3}(?:#{1,6}\s*|[-*]\s*)?(\S{2,20}?)\s*[:：]\s*(.*)$/.exec(line)
  return match ? { name: match[1].toLowerCase(), rest: match[2] } : null
}

/**
 * Turn one assistant reply into a ticket report. Structured replies (结论/证据/
 * 产物/未做项) keep their sections; anything else is archived verbatim and marked
 * unstructured so the Chat can still see what the session said.
 */
export function parseAssistantReport(value, { limit = 8000 } = {}) {
  const raw = String(value == null ? '' : value).trim()
  const clipped = raw.length > limit ? raw.slice(0, limit) + '…' : raw
  const sections = { summary: '', evidence: '', artifacts: '', todo: '' }
  let current = null
  const touching = []
  for (const line of clipped.split(/\r?\n/)) {
    const heading = headingOf(line)
    const matched = heading
      ? SECTION_ALIASES.find(([, aliases]) => aliases.includes(heading.name))
      : null
    if (matched) {
      current = matched[0]
      if (heading.rest) sections[current] += (sections[current] ? '\n' : '') + heading.rest
      continue
    }
    if (current) sections[current] += (sections[current] ? '\n' : '') + line
    else touching.push(line)
  }
  const body = { ...sections }
  for (const key of Object.keys(body)) body[key] = body[key].trim()
  const structured = Boolean(body.summary || body.evidence || body.artifacts || body.todo)
  const preamble = touching.join('\n').trim()
  const summary = (body.summary || preamble || clipped).trim()
  return {
    structured,
    summary: summary.length > 2000 ? summary.slice(0, 2000) + '…' : summary,
    evidence: body.evidence ? body.evidence.split(/\r?\n/).map(item => item.replace(/^\s*[-*\d.、]+\s*/, '').trim()).filter(Boolean) : [],
    artifacts: body.artifacts ? body.artifacts.split(/\r?\n/).map(item => item.replace(/^\s*[-*\d.、]+\s*/, '').trim()).filter(Boolean) : [],
    todo: body.todo ? body.todo.split(/\r?\n/).map(item => item.replace(/^\s*[-*\d.、]+\s*/, '').trim()).filter(Boolean) : [],
    raw: clipped,
    unstructured: !structured,
  }
}

/**
 * The only message a co-managed session receives for a dispatch: the Advisor
 * WorkOrder, never Chat-authored prose. The ticket id is in the first line so
 * the session can quote it back in replies.
 */
export function coManagedBrief(ticket, workOrder, executor = {}, lessons = []) {
  if (!ticket || !ticket.ticketId) throw Object.assign(new Error('ticket is required'), { code: 'ticket_missing' })
  if (!workOrder || typeof workOrder !== 'object') throw Object.assign(new Error('co-managed dispatch requires an Advisor WorkOrder'), { code: 'work_order_required' })
  const order = workOrderBrief(ticket, workOrder).split('\n').slice(1).join('\n')
  const lines = [
    '[WorkOrder #' + ticket.ticketId + ']',
    'ticketId: ' + ticket.ticketId,
    '目标: ' + (ticket.goal || workOrder.summary || ''),
    '验收: ' + (workOrder.acceptance || ticket.acceptance || '未填写'),
    '工作目录: ' + (executor.cwd || '(未知)'),
    ...(executor.artifactDir ? ['产物目录: ' + executor.artifactDir] : []),
    '',
    order,
  ]
  const lessonsBlock = lessonsBrief(lessons, 800)
  if (lessonsBlock) lines.push('', lessonsBlock)
  lines.push(
    '',
    '执行说明：按上面的步骤推进；每完成一个里程碑用一条普通回复写清 结论/证据/产物/未做项，Router 会把回复记录成工单进度。遇到必须由用户决定的事项就停下来问。',
  )
  return lines.join('\n')
}

/** A managed Executor brief is still the default; only co-managed gets the work-order header. */
export function dispatchBrief({ executor, ticket, workOrder, lessons = [] }) {
  if (isCoManaged(executor)) return coManagedBrief(ticket, workOrder, executor, lessons)
  return executorBrief(ticket, workOrder, executor, lessons)
}
