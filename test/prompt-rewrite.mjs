import assert from 'node:assert/strict'
import * as chat from '../lib/prompts/chat.mjs'
import * as advisor from '../lib/prompts/advisor.mjs'
import * as sage from '../lib/prompts/sage.mjs'
import * as executor from '../lib/prompts/executor.mjs'
import * as reflection from '../lib/prompts/reflection.mjs'
import { RIA_SHARED_HEAD, chatPrompt, sagePrompt } from '../lib/prompts/shared.mjs'

assert.ok(RIA_SHARED_HEAD.includes('阿汐（Ria）是用户在 DSH 中的唯一超级助理'))
for (const mod of [chat, advisor, sage, executor, reflection]) assert.equal(mod.PROMPT_VERSION, '2026-11-24')

const chatText = chatPrompt()
assert.ok(chatText.startsWith(RIA_SHARED_HEAD))
assert.ok(chatText.includes('[说话风格]'))
assert.ok(chatText.includes('[活跃项目概况]'))
assert.ok(chatText.includes('ria_chat_propose'))
assert.equal(chatText.includes('2. Answer'), false)
assert.equal(chatText.includes('ria_ticket_plan'), false)
assert.equal(/\bworker\b/i.test(chatText), false)
assert.equal(chat.STYLE_BOUNDARIES.join('\n').includes('ria_request'), false)

const sageText = sagePrompt()
assert.ok(sageText.startsWith(RIA_SHARED_HEAD))
assert.equal(sageText.includes('cognition/chat/'), false)
assert.equal(sageText.includes('projects/<key>'), false)
assert.equal(sageText.includes('scope/title/正文/evidence'), false)
assert.ok(sageText.includes('accepted/rejected/deferred/merged'))
assert.ok(sageText.includes('user:preference'))
assert.ok(sageText.includes('body <= 250'))
assert.ok(sageText.includes('cause <= 600'))
assert.ok(sageText.includes('[Sage 核查回执]'))
assert.ok(sageText.includes('relatedEntryIds'))
assert.equal(/\bworker\b/i.test(sageText), false)

const advisorText = advisor.advisorPlanSystemPrompt()
assert.equal(advisorText.startsWith(RIA_SHARED_HEAD), false)
assert.equal(advisorText.includes('2. Answer'), false)
assert.equal(advisorText.includes('短问答只读调查后直接答复'), false)
assert.equal(advisorText.includes('产物只有两种'), false)
assert.ok(advisorText.includes('workOrder.experience'))
assert.ok(advisorText.includes('最多 4 条'))
assert.equal(/\bworker\b/i.test(advisorText), false)

const executorText = executor.executorPrompt()
assert.equal(executorText.startsWith(RIA_SHARED_HEAD), false)
assert.ok(executorText.includes('[相关历史经验（必读）]'))
assert.ok(executorText.includes('kind="correct"'))
assert.ok(executorText.includes('targetEntryId="cog_X"'))
assert.equal(executorText.includes('scope/title/正文/evidence'), false)
assert.ok(executorText.includes('executor'))
assert.equal(/\bworker\b/i.test(executorText), false)

const reflectionText = reflection.reflectionInstruction({ runId: 'r', forDate: '2026-11-24', windowStart: 0, windowEnd: 1, deadlineAt: 2, trigger: 'manual', attempt: 1 })
assert.equal(reflectionText.startsWith(RIA_SHARED_HEAD), false)
assert.ok(reflectionText.includes('认知条目 3 态') && reflectionText.includes('提案 4 态'))
assert.equal(reflectionText.includes('认知条目有 4 态'), false)
assert.equal(reflectionText.includes('scope/title/正文/evidence'), false)
assert.ok(reflectionText.includes('cognitionActions'))
assert.ok(reflectionText.includes('targetEntryId'))
assert.ok(reflectionText.includes('executor'))
assert.equal(/\bworker\b/i.test(reflectionText), false)
console.log('prompt rewrite ok')
