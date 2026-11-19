import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createFixture } from './support/ria-fixture.mjs'

const fixture = await createFixture({ v2Default: true })
try {
  const controller = fixture.service.v2
  const events = () => {
    try {
      return readFileSync(join(fixture.stateDir, 'router-events.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
    } catch { return [] }
  }
  const sageInjections = () => events().filter(item => item.event === 'sage.index.injected')
  const promptsFor = id => fixture.prompts.filter(item => String(item.sessionId) === String(id) && String(item.content[0].text).includes('[认知 INDEX'))

  const first = await controller.ensureSage()
  const sage = first.sessionId
  assert.equal(first.created, true)
  assert.equal(promptsFor(sage).length, 1)
  const initial = sageInjections()
  assert.equal(initial.length, 1)
  assert.equal(initial[0].payload.reason, 'new-session')
  assert.equal(typeof initial[0].payload.indexVersion, 'string')
  assert.ok(String(fixture.prompts.find(item => item.sessionId === sage).content[0].text).includes('INDEX · ' + initial[0].payload.indexVersion))

  // Restarting/starting again with the same Sage session does not inject.
  const second = await controller.ensureSage()
  assert.equal(second.created, false)
  assert.equal(promptsFor(sage).length, 1)
  assert.equal(sageInjections().length, 1)

  // First compaction injects once; repeated compaction with the same version is deduped.
  controller.onSessionEvent({ header: { id: sage } }, { type: 'compaction/end', data: {} })
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(promptsFor(sage).length, 2)
  assert.equal(sageInjections().at(-1).payload.reason, 'after-compact')
  controller.onSessionEvent({ header: { id: sage } }, { type: 'compaction/end', data: {} })
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(promptsFor(sage).length, 2)
  assert.equal(sageInjections().length, 2)

  // index-changed is off by default.
  controller.cognition.write('principles.md', 'changed principles', { reason: 'test' })
  const third = await controller.ensureSage()
  assert.equal(third.created, false)
  assert.equal(promptsFor(sage).length, 2)
  assert.equal(sageInjections().length, 2)

  // Turning it on injects one index-changed notice for the new version.
  controller.service.options.sageInjectOnIndexChange = true
  controller.cognition.write('principles.md', 'changed again', { reason: 'test' })
  await controller.ensureSage()
  assert.equal(promptsFor(sage).length, 3)
  assert.equal(sageInjections().at(-1).payload.reason, 'index-changed')
  await controller.ensureSage()
  assert.equal(promptsFor(sage).length, 3)

  console.log('v2 sage index ok')
} finally {
  fixture.cleanup()
}
