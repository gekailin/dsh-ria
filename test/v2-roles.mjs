// Role identity rename: 'chatbot' -> 'chat'.
//
// The role id, prompt self-reference and docs say Chat; tool names stay
// `chatbot_*` and the persisted key stays `chatbotSessionId`. Historical
// values persisted as 'chatbot' must stay readable through normalizeRole.
import assert from 'node:assert/strict'
import { normalizeTicket } from '../lib/tickets.mjs'
import { LEGACY_ROLE_CHAT, ROLE_CHAT, isChatRole, normalizeRole } from '../lib/v2/roles.mjs'
import { roleSessionTitle } from '../lib/v2/controller.mjs'
import { chatPrompt, roleLabel, sagePrompt } from '../lib/v2/prompts.mjs'

// --- role ids ------------------------------------------------------------
assert.equal(ROLE_CHAT, 'chat')
assert.equal(LEGACY_ROLE_CHAT, 'chatbot')
assert.equal(normalizeRole('chatbot'), 'chat')
assert.equal(normalizeRole('chat'), 'chat')
assert.equal(normalizeRole('advisor'), 'advisor')
assert.equal(normalizeRole('ticket:ticket_x'), 'ticket:ticket_x')
assert.equal(normalizeRole('session-abc'), 'session-abc')
assert.equal(normalizeRole(null), null)
assert.equal(normalizeRole(undefined), undefined)
assert.equal(isChatRole('chat'), true)
assert.equal(isChatRole('chatbot'), true)
assert.equal(isChatRole('advisor'), false)
assert.equal(isChatRole(undefined), false)

// --- labels and session titles ------------------------------------------
assert.equal(roleLabel('chat'), 'Chat')
assert.equal(roleLabel('chatbot'), 'Chat', 'historical role label normalizes to Chat')
assert.equal(roleLabel('sage'), 'Sage')
// Chat keeps the user-facing session title 'Ria' under either spelling.
assert.equal(roleSessionTitle('chat'), 'Ria')
assert.equal(roleSessionTitle('chatbot'), 'Ria')
assert.equal(roleSessionTitle('sage'), 'Sage')

// --- prompts carry the fast-brain/slow-brain positioning ----------------
const chatBrief = chatPrompt()
assert.match(chatBrief, /你是 Chat（Ria 的快脑）/)
assert.match(chatBrief, /快脑负责响应与编排，慢脑负责沉淀与裁断/)
assert.match(chatBrief, /直面用户、快速调度、派发与转述/)
assert.doesNotMatch(chatBrief, /你是 Chatbot/)
const sageBrief = sagePrompt()
assert.match(sageBrief, /你是 Sage（Ria 的慢脑）/)
assert.match(sageBrief, /长期记忆与认知维护、冲突裁决、深度思考/)
assert.match(sageBrief, /快脑负责响应与编排，慢脑负责沉淀与裁断/)

// --- tickets written before the rename still load -----------------------
const legacy = normalizeTicket({
  ticketId: 'ticket_legacy_roles',
  status: 'cancelled',
  executor: 'session-worker',
  waitingOn: 'user',
  goal: 'historical ticket',
  createdAt: 1,
  updatedAt: 2,
  history: [
    { at: 1, from: 'open', to: 'working', actor: 'chatbot' },
    { at: 2, from: 'working', to: 'cancelled', actor: 'user' },
  ],
  resolution: { kind: 'cancelled', reason: 'user asked', by: 'chatbot' },
})
assert.equal(legacy.history[0].actor, 'chat')
assert.equal(legacy.history[1].actor, 'user')
assert.equal(legacy.resolution.by, 'chat')
// Older names keep their own migration rule and must not be disturbed.
const thinker = normalizeTicket({
  ticketId: 'ticket_legacy_thinker',
  status: 'done',
  executor: 'thinker',
  waitingOn: 'none',
  goal: 'older ticket',
  createdAt: 1,
  updatedAt: 2,
  history: [{ at: 1, from: 'open', to: 'done', actor: 'thinker' }],
  resolution: { kind: 'done', summary: 'ok', by: 'thinker' },
})
assert.equal(thinker.executor, 'advisor')
assert.equal(thinker.history[0].actor, 'advisor')
assert.equal(thinker.resolution.by, 'advisor')

console.log('v2 roles ok')
