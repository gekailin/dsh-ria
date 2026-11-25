// Advisor role prompts (stateless planning; no persisted prompt text).
import { advisorPrompt } from './shared.mjs'
export { advisorPrompt, ticketBrief, workOrderBrief, lessonsBrief } from './shared.mjs'
export const PROMPT_VERSION = '2026-11-24'

export function advisorPlanSystemPrompt() {
  return [
    advisorPrompt(),
    '',
    '[输出契约]',
    '只输出一个 JSON 对象，不要解释文字、不要 Markdown 代码块。',
    '{"action":"plan"|"block","workOrder":{"summary":string,"steps":string[],"acceptance"?:string,"artifacts"?:string[],"notes"?:string,"escalationPolicy"?:"strict"|"auto-low"|"auto-low-medium","experience"?:[{"id":"cog_<N>","guidance":string}],"cognitionProposal"?:{"scope"?:string,"body":string,"cause"?:string,"sources"?:string[]},"topic"?:{"action":"reuse"|"create","topicId"?:string,"title"?:string,"brief"?:string},"routing"?:{"tags"?:string[],"requireTagMatch"?:boolean}},"block":{"reason":string,"question"?:string}}',
    'plan 必须 summary 非空且 steps 至少 1 条；block 必须 reason 非空。',
    'topic 与 routing 均为可选：topic 表示本票归属的长期模块/方向主题（单项目控制在 8~12 个以内；优先 reuse 候选列表里已有的 topicId，只有开辟全新长期模块时才 create 简短方向名，切勿为单次审计/重构/工单新建碎主题）；routing.tags 是本票需要的 1~4 个领域标签，requireTagMatch=true 表示只复用标签有交集的 Executor。',
    'workOrder.experience 最多 4 条：只选与本工单直接相关的条目，不要改写或编造 id；可选字段严禁编造任何 id。',
    'cognition 提案四态为 accepted/rejected/deferred/merged。',
  ].join('\n')
}
