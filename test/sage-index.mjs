import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createFixture } from './support/ria-fixture.mjs'
import { SAGE_PRINCIPLES_MAX_CHARS } from '../lib/core/prompts.mjs'

const fixture = await createFixture({ stateDefault: true })
try {
  const controller = fixture.service.controller
  fixture.service.options.cognitionIndexNotifyDebounceMs = 15
  fixture.service.options.cognitionIndexNotifyMinIntervalMs = 0
  const events = () => {
    try {
      return readFileSync(join(fixture.stateDir, 'router-events.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
    } catch { return [] }
  }
  controller.cognition.ensure()
  controller.cognition.write('principles.md', '原则：' + '很长'.repeat(500), { reason: 'test' })
  controller.cognition.write('projects/project-static.md', '静态项目事实', { reason: 'test' })
  const sage = (await controller.ensureSage()).sessionId
  const prompt = fixture.systemPrompts.get(sage)
  assert.ok(prompt.includes('你是 Sage（Ria 的慢脑）'))
  assert.ok(prompt.includes('[PRINCIPLES 摘要]'))
  assert.ok(prompt.includes('cognition/INDEX.md'))
  assert.ok(prompt.includes('需要最新认知时用 sage_read'))
  assert.equal(prompt.includes('[COGNITION INDEX]'), false)
  assert.equal(prompt.includes('project-static.md'), false)
  assert.equal(prompt.includes('上限 ' + SAGE_PRINCIPLES_MAX_CHARS), true)

  const beforeNotify = events().filter(item => item.event === 'cognition.index.notified').length
  controller.cognition.write('projects/one.md', 'one', { reason: 'test' })
  await new Promise(resolve => setTimeout(resolve, 40))
  const changed = events().filter(item => item.event === 'cognition.index.changed')
  assert.ok(changed.length >= 1)
  assert.ok(changed.at(-1).payload.version)
  assert.ok(changed.at(-1).payload.changedFiles.includes('projects/one.md'))
  const notices = events().filter(item => item.event === 'cognition.index.notified')
  assert.equal(notices.length, beforeNotify + 1)
  const noticePrompt = fixture.prompts.find(item => item.sessionId === sage && String(item.content[0].text).includes('INDEX 已更新'))
  assert.ok(noticePrompt)
  assert.ok(String(noticePrompt.content[0].text).includes('one.md'))
  assert.ok(String(noticePrompt.content[0].text).includes('不强制'))

  // Same version is not notified twice.
  const version = changed.at(-1).payload.version
  controller.onCognitionIndexChanged({ version, changedFiles: ['same.md'], timestamp: new Date().toISOString() })
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.equal(events().filter(item => item.event === 'cognition.index.notified').length, notices.length)

  // Multiple changes within the debounce window merge into one notice.
  controller.cognition.write('projects/two.md', 'two', { reason: 'test' })
  controller.cognition.write('projects/three.md', 'three', { reason: 'test' })
  await new Promise(resolve => setTimeout(resolve, 45))
  const merged = events().filter(item => item.event === 'cognition.index.notified')
  assert.equal(merged.length, notices.length + 1)
  const mergedPrompt = fixture.prompts.filter(item => item.sessionId === sage && String(item.content[0].text).includes('INDEX 已更新')).at(-1)
  assert.ok(String(mergedPrompt.content[0].text).includes('two.md'))
  assert.ok(String(mergedPrompt.content[0].text).includes('three.md'))

  // Delivery failure must not affect the cognition write and only records an event.
  fixture.setPromptFailure(new Error('sage unavailable'))
  const write = controller.cognition.write('projects/four.md', 'four', { reason: 'test' })
  assert.equal(write.ok, true)
  await new Promise(resolve => setTimeout(resolve, 40))
  assert.ok(events().some(item => item.event === 'cognition.index.notify_failed'))
  fixture.setPromptFailure(undefined)

  console.log('state sage prompt ok')
} finally {
  fixture.cleanup()
}
