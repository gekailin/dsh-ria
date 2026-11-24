// Advisor role prompts (stateless planning; no persisted prompt text).
import { advisorPrompt } from './shared.mjs'
export { advisorPrompt, ticketBrief, workOrderBrief, lessonsBrief } from './shared.mjs'
export const PROMPT_VERSION = '2026-11-20'

export function advisorPlanSystemPrompt() {
  return [
    advisorPrompt(),
    '',
    '[输出契约]',
    '只输出一个 JSON 对象，不要解释文字、不要 Markdown 代码块。',
    '{"action":"plan"|"block","workOrder":{"summary":string,"steps":string[],"acceptance"?:string,"artifacts"?:string[],"notes"?:string,"escalationPolicy"?:"strict"|"auto-low"|"auto-low-medium","cognitionProposal"?:{"scope"?:string,"text":string,"evidence"?:string[]},"topic"?:{"action":"reuse"|"create","topicId"?:string,"title"?:string,"brief"?:string},"routing"?:{"tags"?:string[],"requireTagMatch"?:boolean}},"block":{"reason":string,"question"?:string}}',
    'plan 必须 summary 非空且 steps 至少 1 条；block 必须 reason 非空。没有 answer 动作：每张票都要有 WorkOrder 交给 Executor。',
    'topic 与 routing 均为可选：topic 表示本票归属的候选主题（优先 reuse 输入里已有的 topicId；没有契合方向才 create，标题用简短方向名，不要复读工单原话）；routing.tags 是本票需要的 1~4 个领域标签，requireTagMatch=true 表示只复用标签有交集的 Executor。',
    '可选字段不许编造 id。',
    '输入中的 [相关历史经验] 是 Router 注入的 cognition 经验（最多 5 条，每条带 id/source，正文 <=200 字）；规划时参考，但不要改写或编造经验。',
  ].join('\n')
}
