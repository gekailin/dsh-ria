import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createFixture } from './support/ria-fixture.mjs'
import { SAGE_INDEX_MAX_CHARS, SAGE_PRINCIPLES_MAX_CHARS } from '../lib/v2/prompts.mjs'

const fixture = await createFixture({ v2Default: true })
try {
  const controller = fixture.service.v2
  controller.cognition.ensure()
  controller.cognition.write('principles.md', '原则：' + '很长'.repeat(500), { reason: 'test' })
  for (let index = 0; index < 24; index += 1) {
    controller.cognition.write('projects/project-' + index + '.md', '项目事实 ' + index + '：' + '细节'.repeat(80), { reason: 'test' })
  }
  const events = () => {
    try {
      return readFileSync(join(fixture.stateDir, 'router-events.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
    } catch { return [] }
  }
  const sage = (await controller.ensureSage()).sessionId
  const prompt = fixture.systemPrompts.get(sage)
  assert.ok(prompt, 'missing Sage system prompt')
  assert.ok(prompt.includes('你是 Sage（大脑）'))
  assert.ok(prompt.includes('你不执行任务、不写代码'))
  assert.ok(prompt.includes('[PRINCIPLES 摘要]'))
  assert.ok(prompt.includes('[COGNITION INDEX]'))
  assert.ok(prompt.includes('INDEX 可能滞后；以实际文件为准'))
  assert.ok(prompt.includes('sage_read'))
  assert.ok(prompt.includes('project-0.md'))
  assert.ok(prompt.includes('上限 ' + SAGE_PRINCIPLES_MAX_CHARS))
  assert.ok(prompt.includes('上限 ' + SAGE_INDEX_MAX_CHARS))

  const principlesPart = prompt.split('[PRINCIPLES 摘要]')[1].split('[COGNITION INDEX]')[0]
  assert.ok(principlesPart.length <= SAGE_PRINCIPLES_MAX_CHARS + 120, String(principlesPart.length))
  const indexPart = prompt.split('[COGNITION INDEX]')[1].split('\n\n语气')[0]
  assert.ok(indexPart.length <= SAGE_INDEX_MAX_CHARS + 180, String(indexPart.length))
  assert.equal(controller.v2.sagePromptText, prompt)

  // The prompt is rebuilt for each assembly, so an INDEX change is visible on
  // the next turn without rebuilding the Sage session.
  const createsBefore = fixture.creates.length
  controller.cognition.write('projects/added-after-creation.md', '新增项目事实', { reason: 'test' })
  const refreshed = controller.sageSystemPrompt(sage, { fresh: true })
  assert.ok(refreshed.includes('added-after-creation.md'))
  assert.equal(fixture.creates.length, createsBefore)

  // The persisted creation snapshot remains available as a fallback.
  assert.equal(controller.sageSystemPrompt(sage), prompt)

  // No old injection messages/events; repeat ensure and compact do nothing.
  const beforePrompts = fixture.prompts.length
  await controller.ensureSage()
  controller.onSessionEvent({ header: { id: sage } }, { type: 'compaction/end', data: {} })
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(fixture.prompts.length, beforePrompts)

  // sage_read still reads INDEX.
  const read = await fixture.callAs(sage, 'sage_read', { path: 'INDEX.md' })
  assert.equal(read.ok, true, JSON.stringify(read))
  assert.ok(String(read.content).toLowerCase().includes('cognition index'))

  console.log('v2 sage prompt ok')
} finally {
  fixture.cleanup()
}
