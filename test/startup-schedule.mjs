import assert from 'node:assert/strict'
import { createFixture } from './support/ria-fixture.mjs'
import { REFLECTION_SCHEDULE_PROMPT } from '../lib/prompts/reflection.mjs'

const TITLE = 'Ria: 定期反思'
const RRULE = 'DTSTART;TZID=Asia/Shanghai:20261125T234000\nRRULE:FREQ=DAILY'

const fixture = await createFixture({ state: true })
try {
  const service = fixture.service
  const controller = service.controller
  assert.ok(controller, 'state:true fixture has a controller')
  assert.ok(service.schedule, 'fixture injected the schedule service')
  service.store.setSettings({ reflection: { enabled: true, cadence: 'daily', time: '23:40' } })
  const chat = controller.state.chatSessionId
  const old = await service.schedule.create({
    title: TITLE,
    prompt: 'OLD REFLECTION PROMPT',
    timing: { kind: 'rrule', rrule: RRULE },
    target: { kind: 'session', sessionId: chat },
  })
  await new Promise(resolve => setTimeout(resolve, 15))

  // state:true startup must bootstrap the schedule, not return before it.
  await service.startup()
  const afterStartup = (await service.schedule.list({ limit: 50 })).items.find(item => item.title === TITLE)
  assert.ok(afterStartup, 'reflection schedule exists after startup')
  assert.equal(afterStartup.prompt, REFLECTION_SCHEDULE_PROMPT)
  assert.notEqual(afterStartup.updatedAt, old.updatedAt, 'stale prompt must be updated')

  // Same prompt: no edit and no updatedAt churn.
  const beforeIdle = afterStartup.updatedAt
  const idle = await service.ensureReflectionSchedule('test-idle')
  assert.equal(idle.ok, true)
  assert.equal(idle.unchanged, true)
  const afterIdle = (await service.schedule.list({ limit: 50 })).items.find(item => item.title === TITLE)
  assert.equal(afterIdle.prompt, REFLECTION_SCHEDULE_PROMPT)
  assert.equal(afterIdle.updatedAt, beforeIdle, 'unchanged prompt must not bump updatedAt')

  // A stale prompt is the only case that edits.
  await service.schedule.edit({ id: afterIdle.id, action: 'update', patch: { prompt: 'STALE AGAIN' } })
  await new Promise(resolve => setTimeout(resolve, 15))
  const stale = (await service.schedule.list({ limit: 50 })).items.find(item => item.title === TITLE)
  const updated = await service.ensureReflectionSchedule('test-update')
  assert.equal(updated.ok, true)
  assert.equal(updated.unchanged, undefined)
  const fresh = (await service.schedule.list({ limit: 50 })).items.find(item => item.title === TITLE)
  assert.equal(fresh.prompt, REFLECTION_SCHEDULE_PROMPT)
  assert.notEqual(fresh.updatedAt, stale.updatedAt, 'changed prompt must bump updatedAt')

  console.log('startup schedule ok')
} finally { fixture.cleanup() }
