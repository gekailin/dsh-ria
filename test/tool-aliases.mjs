import assert from 'node:assert/strict'
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
  console.log('tool aliases ok')
} finally {
  fixture.cleanup()
}
