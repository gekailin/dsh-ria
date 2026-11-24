import assert from 'node:assert/strict'
import { reflectionInstruction } from '../lib/prompts/reflection.mjs'
import { advisorPlanSystemPrompt } from '../lib/prompts/advisor.mjs'
import { advisorPrompt, lessonsBrief, sagePrompt } from '../lib/prompts/shared.mjs'

const reflection = reflectionInstruction({
  runId: 'run-phase2', forDate: '2026-11-24', windowStart: 1, windowEnd: 2, deadlineAt: 3,
  executorSessionId: 'session-r', attempt: 1,
})
assert.equal(/lessons/i.test(reflection), false, 'reflection prompt must not mention lessons')
assert.ok(reflection.includes('accepted / rejected / deferred / merged') || reflection.includes('accepted/rejected/deferred/merged'))
assert.ok(reflection.includes('回执由 Sage 写'))

const sage = sagePrompt({ principles: 'principles' })
assert.ok(sage.includes('ria_sage_decide'))
assert.ok(sage.includes('accepted/rejected/deferred/merged'))
assert.ok(sage.includes('targetEntryId'))
assert.ok(sage.includes('工具面只有五个'))

const advisor = advisorPrompt()
const advisorSystem = advisorPlanSystemPrompt()
for (const text of [advisor, advisorSystem]) {
  assert.ok(text.includes('相关历史经验'))
  assert.ok(/最多 5 条|<= *5|≤ *5/.test(text))
  assert.ok(text.includes('id/source'))
}
assert.ok(advisorPlanSystemPrompt().includes('相关历史经验'))
const rendered = lessonsBrief([{ id: 'cog_1', source: 'lib/x.mjs:1', text: 'experience text' }], 800)
assert.ok(rendered.includes('[cog_1]') && rendered.includes('experience text') && rendered.includes('lib/x.mjs:1'))
console.log('cognition prompts phase2 ok')
