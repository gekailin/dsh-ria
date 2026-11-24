import assert from 'node:assert/strict'
import * as chat from '../lib/prompts/chat.mjs'
import * as advisor from '../lib/prompts/advisor.mjs'
import * as sage from '../lib/prompts/sage.mjs'
import * as worker from '../lib/prompts/worker.mjs'
import * as reflection from '../lib/prompts/reflection.mjs'
import { RIA_SHARED_HEAD, chatPrompt, sagePrompt } from '../lib/prompts/shared.mjs'

assert.ok(RIA_SHARED_HEAD.includes('阿汐（Ria）是用户在 DSH 中的唯一超级助理'))
for (const mod of [chat, advisor, sage, worker, reflection]) assert.equal(mod.PROMPT_VERSION, '2026-11-24')
const chatText = chatPrompt()
assert.ok(chatText.startsWith(RIA_SHARED_HEAD))
assert.equal(chatText.includes('2. Answer'), false)
const sageText = sagePrompt()
assert.ok(sageText.startsWith(RIA_SHARED_HEAD))
assert.equal(sageText.includes('cognition/chat/'), false)
assert.ok(sageText.includes('accepted/rejected/deferred/merged'))
const advisorText = advisor.advisorPlanSystemPrompt()
assert.equal(advisorText.includes('2. Answer'), false)
assert.ok(advisorText.includes('experience'))
assert.ok(advisorText.includes('最多 4 条'))
assert.ok(worker.executorPrompt().includes('executor'))
assert.ok(reflection.reflectionInstruction({ runId: 'r', forDate: '2026-11-24', windowStart: 0, windowEnd: 1, deadlineAt: 2, trigger: 'manual', attempt: 1 }).includes('executor'))
console.log('prompt rewrite ok')
