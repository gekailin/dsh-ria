import assert from 'node:assert/strict'
import { createFixture } from './support/ria-fixture.mjs'

// Chat long-term memory is a dynamic system-prompt section backed by SQLite.
const fixture = await createFixture({ stateDefault: true })
try {
  const controller = fixture.service.controller
  const cognition = controller.cognition
  const chat = controller.state.chatSessionId
  const chatAgent = fixture.agentFor(chat)
  const prompt = () => fixture.assembleSystemPrompt(chat, { scope: chatAgent })
  const replaceMemory = body => {
    const db = cognition.openDb()
    db.prepare("DELETE FROM cognition_entries WHERE scope='user:preference'").run()
    const result = cognition.upsertEntry({ scope: 'user:preference', body, cause: 'test', sources: [{ type: 'file', ref: 'test' }] })
    assert.equal(result.ok, true, JSON.stringify(result))
  }

  // 1. The system prompt carries the SQLite digest and the fixed disclaimer.
  replaceMemory('用户偏好：先给结论，再展开。')
  const first = prompt()
  assert.ok(first.includes('你是 Chat（Ria 的快脑）'), 'base Chat prompt is still present')
  assert.ok(first.includes('以下为长期记忆摘要，可能滞后'))
  assert.ok(first.includes('用户偏好：先给结论，再展开。'))

  // 2. Re-assembling reflects a later SQLite change without any event.
  replaceMemory('用户偏好：先给结论，再展开；回复要短。')
  const second = prompt()
  assert.ok(second.includes('回复要短'))
  assert.ok(!second.includes('用户偏好：先给结论，再展开。\n'), 'old block replaced on next assembly')

  // 3. A read failure degrades to a placeholder instead of throwing.
  const originalDigest = cognition.chatDigest
  cognition.chatDigest = () => { throw new Error('cognition store unavailable') }
  let degraded
  assert.doesNotThrow(() => { degraded = prompt() })
  assert.ok(degraded.includes('长期记忆暂不可用'))
  assert.ok(degraded.includes('不影响本次会话'))
  delete cognition.chatDigest
  assert.equal(cognition.chatDigest, originalDigest)

  // 4. Empty memory degrades to a readable placeholder.
  cognition.openDb().prepare("DELETE FROM cognition_entries WHERE scope='user:preference'").run()
  const empty = prompt()
  assert.ok(empty.includes('长期记忆暂无内容'))
  assert.ok(empty.includes('不影响本次会话'))

  // 5. onPreStep does not inject a memory host message.
  const step = await fixture.emit(
    'agent/pre-step',
    { agent: chatAgent, turn: 5, step: 2 },
    async () => ({ kind: 'enter', messages: [] }),
  )
  assert.equal(step.messages.length, 0)
  assert.equal(step.messages.some(item => item && item.source && item.source.form === 'chat-memory'), false)

  // 6. The 2.8k budget covers the whole memory block including the marker;
  // chatDigest itself caps SQLite memory at 1600 chars.
  const db = cognition.openDb()
  for (let index = 0; index < 20; index += 1) {
    cognition.upsertEntry({ scope: 'user:preference', body: 'X'.repeat(200), cause: 'test', sources: [{ type: 'file', ref: 'test' }] })
  }
  const long = prompt()
  const block = long.slice(long.indexOf('[长期记忆摘要]'))
  assert.ok(block.length <= 2800, 'memory block length ' + block.length)
  assert.ok(block.includes('已截断'))

  console.log('state chat memory prompt ok')
} finally {
  fixture.cleanup()
}
