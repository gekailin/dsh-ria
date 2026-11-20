import assert from 'node:assert/strict'
import * as core from '../lib/core/prompts.mjs'
import { advisorPlanSystemPrompt as coreAdvisorSystem } from '../lib/core/advisor.mjs'
import { reflectionInstruction as reflectionInstructionFromModule } from '../lib/reflection.mjs'
import * as chat from '../lib/prompts/chat.mjs'
import * as advisor from '../lib/prompts/advisor.mjs'
import * as sage from '../lib/prompts/sage.mjs'
import * as worker from '../lib/prompts/worker.mjs'
import * as reflection from '../lib/prompts/reflection.mjs'
import { ROUTER_SYSTEM_PROMPT } from '../lib/prompts/router.mjs'
import { buildRoutingPrompt } from '../lib/router/prompt.mjs'

for (const mod of [chat, advisor, sage, worker, reflection]) assert.equal(typeof mod.PROMPT_VERSION, 'string')

assert.equal(chat.chatPrompt(), core.chatPrompt())
assert.equal(advisor.advisorPrompt(), core.advisorPrompt())
assert.equal(sage.sagePrompt({ principles: 'p' }), core.sagePrompt({ principles: 'p' }))
assert.equal(worker.workerPrompt({ workerSeq: 1 }), core.workerPrompt({ workerSeq: 1 }))
assert.equal(typeof chat.STYLE_PRESET_PROMPTS.concise, 'string')
assert.equal(advisor.advisorPlanSystemPrompt(), coreAdvisorSystem())

const run = { runId: 'refl-test', forDate: '2026-11-20', windowStart: 1, windowEnd: 2, deadlineAt: 3, workerSessionId: 's', attempt: 1, reportFinal: '/tmp/x' }
assert.equal(reflection.reflectionInstruction(run), reflectionInstructionFromModule(run))
assert.ok(reflection.reflectionInstruction(run).includes('ria_reflect_read_context'))
assert.equal(buildRoutingPrompt({ mode: 'session', candidates: [{ id: 'a' }], request: 'x' }).system, ROUTER_SYSTEM_PROMPT)
console.log('prompts centralized ok')
