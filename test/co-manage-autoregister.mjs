import assert from 'node:assert/strict'
import { chatPrompt } from '../lib/prompts/shared.mjs'

// The Chat must not guess/auto-dispatch just because it auto-registers a session.
const prompt = chatPrompt()

assert.match(prompt, /让 X 做 Y/)
assert.match(prompt, /若 X 已在协管列表.*直接建 work 票.*显式指定 executorId/)
assert.match(prompt, /不在协管列表.*先调用 ria_chat_co_manage action=add.*allowDispatch=false.*cwd 取该会话的 cwd.*再建 work 票.*显式指定 executorId/)
assert.match(prompt, /allowDispatch=false 的语义.*只承接这一张显式工单.*不参与后续自动派单/)
assert.match(prompt, /自动纳管 ≠ 自动派单/)
assert.match(prompt, /匹配多个会话时不要猜.*列出候选让用户选/)
assert.match(prompt, /managed executor.*无需纳管.*executorSeq/)
assert.match(prompt, /纳管失败.*会话不存在.*角色会话.*不派单/)

console.log('co-manage autoregister prompt ok')
