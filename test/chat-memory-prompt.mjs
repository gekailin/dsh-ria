import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { createFixture } from './support/ria-fixture.mjs'

// Chat long-term memory is a dynamic system-prompt section: every assembly
// re-reads cognition/chat/, so a write is visible on the next prompt with no
// event, version hash, restart, or injected host message.
const fixture = await createFixture({ stateDefault: true })
try {
  const controller = fixture.service.controller
  const cognition = controller.cognition
  const chat = controller.state.chatSessionId
  const chatAgent = fixture.agentFor(chat)
  const prompt = () => fixture.assembleSystemPrompt(chat, { scope: chatAgent })

  // 1. The system prompt carries the digest and the fixed disclaimer.
  cognition.write('chat/preferences.md', '用户偏好：先给结论，再展开。', { reason: 'test' })
  const first = prompt()
  assert.ok(first.includes('你是 Chat（Ria 的快脑）'), 'base Chat prompt is still present')
  assert.ok(first.includes('以下为长期记忆摘要，可能滞后；细节以 cognition 文件为准'))
  assert.ok(first.includes('用户偏好：先给结论，再展开。'))

  // 2. Re-assembling reflects a later file change without any event.
  cognition.write('chat/preferences.md', '用户偏好：先给结论，再展开；回复要短。', { reason: 'test' })
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
  assert.ok(degraded.includes('以下为长期记忆摘要，可能滞后；细节以 cognition 文件为准'))
  delete cognition.chatDigest
  assert.equal(cognition.chatDigest, originalDigest)

  // 4. Empty memory also degrades to a readable placeholder.
  for (const file of ['chat/preferences.md', 'chat/agreements.md', 'chat/decisions.md']) {
    cognition.write(file, '', { reason: 'test' })
  }
  const empty = prompt()
  assert.ok(empty.includes('长期记忆暂无内容'))
  assert.ok(empty.includes('不影响本次会话'))

  // 4b. A deleted memory file is reported as degraded, not silently ignored.
  rmSync(join(fixture.stateDir, 'cognition', 'chat', 'agreements.md'))
  const missing = prompt()
  assert.ok(missing.includes('长期记忆暂不可用'))
  assert.ok(missing.includes('不影响本次会话'))

  // 5. onPreStep no longer injects a memory host message.
  const step = await fixture.emit(
    'agent/pre-step',
    { agent: chatAgent, turn: 5, step: 2 },
    async () => ({ kind: 'enter', messages: [] }),
  )
  assert.equal(step.messages.length, 0)
  assert.equal(step.messages.some(item => item && item.source && item.source.form === 'chat-memory'), false)

  // 6. The 1.5k budget covers the whole memory block including the marker.
  cognition.write('chat/preferences.md', 'X'.repeat(3000), { reason: 'test' })
  const long = prompt()
  const block = long.slice(long.indexOf('[长期记忆摘要]'))
  assert.ok(block.length <= 1500, 'memory block length ' + block.length)
  assert.ok(block.includes('已截断'))
  assert.ok(block.includes('以下为长期记忆摘要，可能滞后；细节以 cognition 文件为准'))

  console.log('state chat memory prompt ok')
} finally {
  fixture.cleanup()
}
