import assert from 'node:assert/strict'
import { createFixture } from './support/ria-fixture.mjs'

const long = 'L'.repeat(4200)
const records = Array.from({ length: 40 }, (_, index) => ({
  type: 'event',
  event: {
    type: index % 2 === 0 ? 'user/message' : 'assistant/message',
    seq: index + 1,
    at: index + 1,
    data: index % 2 === 0
      ? { content: [{ type: 'text', text: index === 0 ? long : 'user-' + index }] }
      : { message: { content: [{ type: 'text', text: index === 1 ? long : 'assistant-' + index }] } },
  },
}))
const fixture = await createFixture({
  stateDefault: true,
  extraSessions: [{ sessionId: 'session-read-long', running: false, blank: false, updatedAt: 1, cwd: '/work/read', projections: { values: { title: 'Long Read' } } }],
  sessionEvents: { 'session-read-long': records },
})
try {
  const chat = fixture.service.controller.state.chatSessionId
  const read = await fixture.callAs(chat, 'ria_chat_read', { sessionId: 'session-read-long', limit: 50 })
  assert.equal(read.ok, true, JSON.stringify(read))
  assert.equal(read.messages.length, 40, 'limit above 30 is honored')
  const longMessages = read.messages.filter(message => message.text.startsWith('LLLL'))
  assert.equal(longMessages.length, 2, 'both long messages are returned')
  for (const message of longMessages) {
    assert.equal(message.text.length, 4200, 'message text is not truncated at 3000 chars')
    assert.equal(message.text.endsWith('...'), false)
  }
  const tool = fixture.visibleTools(chat).includes('ria_chat_read')
  assert.equal(tool, true)
  console.log('chat read full content ok')
} finally {
  fixture.cleanup()
}
