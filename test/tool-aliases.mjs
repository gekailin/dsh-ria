import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createFixture } from './support/ria-fixture.mjs'

const fixture = await createFixture({ stateDefault: true })
try {
  const chat = fixture.service.controller.state.chatSessionId
  const tools = fixture.visibleTools(chat).sort()
  assert.ok(tools.includes('ria_chat_status'))
  assert.ok(tools.includes('ria_chat_request'))
  assert.equal(tools.includes('chat_status'), false)
  assert.equal(tools.includes('chatbot_status'), false)

  const legacy = await fixture.callAs(chat, 'chat_status', {})
  assert.equal(legacy.ok, true, JSON.stringify(legacy))
  const oldest = await fixture.callAs(chat, 'chatbot_status', {})
  assert.equal(oldest.ok, true, JSON.stringify(oldest))
  const current = await fixture.callAs(chat, 'ria_chat_status', {})
  assert.equal(current.ok, true, JSON.stringify(current))
  const warnings = fixture.service.routerEvents.query({ types: ['tool.alias_warn'], limit: 100 }).events
  const warning = warnings.find(item => item.payload && item.payload.alias === 'chat_status' && item.payload.replacement === 'ria_chat_status')
  assert.ok(warning, JSON.stringify(warnings))
  assert.equal(warning.payload.caller, chat)
  assert.ok(warnings.some(item => item.payload && item.payload.alias === 'chatbot_status' && item.payload.replacement === 'ria_chat_status'))
  console.log('tool aliases ok')
} finally {
  fixture.cleanup()
}
