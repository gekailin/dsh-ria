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
  const warnings = readFileSync(join(fixture.stateDir, 'operation-events.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line)).filter(item => item.event === 'tool.alias_warn')
  const warning = warnings.find(item => item.alias === 'chat_status' && item.replacement === 'ria_chat_status')
  assert.ok(warning, JSON.stringify(warnings))
  assert.equal(warning.caller, chat)
  assert.ok(warnings.some(item => item.alias === 'chatbot_status' && item.replacement === 'ria_chat_status'))
  console.log('tool aliases ok')
} finally {
  fixture.cleanup()
}
