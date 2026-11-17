import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { createFixture } from './support/ria-fixture.mjs'
import { readReflectionState } from '../lib/reflection.mjs'

const REFLECTION_DEFAULTS = {
  enabled: false,
  cadence: 'daily',
  time: '23:40',
  weekday: 1,
  model: null,
  provider: null,
  reasoningEffort: null,
}

function request(route, method, path, payload) {
  const req = new EventEmitter()
  req.method = method
  req.url = path
  req.headers = { host: '127.0.0.1:3080' }
  const res = {
    statusCode: 0,
    headers: {},
    setHeader(name, value) { this.headers[name] = value },
    end(body) { this.body = body; this.done(body) },
  }
  const done = new Promise(resolve => { res.done = resolve })
  route.handler(req, res)
  setImmediate(() => {
    if (payload !== undefined) req.emit('data', Buffer.from(JSON.stringify(payload)))
    req.emit('end')
  })
  return done.then(body => ({ status: res.statusCode, body: JSON.parse(body) }))
}

const fixture = await createFixture({})
const route = fixture.routes[0]
const api = (method, path, payload) => request(route, method, path, payload)

try {
  const initial = await api('GET', '/plugins/dsh-ria/api/settings')
  assert.equal(initial.status, 200)
  assert.deepEqual(initial.body.reflection, REFLECTION_DEFAULTS)
  assert.deepEqual(initial.body.reflectionStatus, {
    lastCompletedDate: null,
    lastStatus: null,
    lastError: null,
    activeRunId: null,
    workerSessionId: null,
    scheduleId: null,
    enabled: false,
    scheduleAvailable: true,
    scheduleError: null,
  })

  const status = await api('GET', '/plugins/dsh-ria/api/reflection/status')
  assert.equal(status.status, 200)
  assert.deepEqual(status.body, {
    lastCompletedDate: null,
    lastStatus: null,
    lastError: null,
    activeRunId: null,
    workerSessionId: null,
    scheduleId: null,
  })

  const before = await api('GET', '/plugins/dsh-ria/api/settings')
  const invalids = [
    { reflection: { enabled: 'yes' } },
    { reflection: { cadence: 'monthly' } },
    { reflection: { time: '24:00' } },
    { reflection: { time: '7:40' } },
    { reflection: { weekday: 0 } },
    { reflection: { weekday: 8 } },
    { reflection: { weekday: 1.5 } },
    { reflection: { enabled: true, cadence: 'weekly', time: 'bad' } },
    { reflection: { model: '' } },
  ]
  for (const payload of invalids) {
    const bad = await api('POST', '/plugins/dsh-ria/api/settings', payload)
    assert.equal(bad.status, 400, JSON.stringify(payload))
    assert.match(bad.body.error, /reflection/)
  }
  const after = await api('GET', '/plugins/dsh-ria/api/settings')
  assert.deepEqual(after.body, before.body)
  assert.equal(fixture.schedules.length, 0)

  const unknown = await api('POST', '/plugins/dsh-ria/api/settings', { reflection: { enabled: false, extraOption: 'kept' } })
  assert.equal(unknown.status, 200)
  assert.equal(unknown.body.reflection.extraOption, 'kept')
  assert.equal(unknown.body.reflection.enabled, false)
  const kept = await api('GET', '/plugins/dsh-ria/api/settings')
  assert.equal(kept.body.reflection.extraOption, 'kept')

  const riaId = fixture.service.store.riaSessionId
  const enabled = await api('POST', '/plugins/dsh-ria/api/settings', { reflection: { enabled: true } })
  assert.equal(enabled.status, 200)
  assert.equal(enabled.body.reflection.enabled, true)
  assert.equal(enabled.body.reflectionStatus.scheduleId, fixture.schedules[0].id)
  assert.equal(fixture.schedules.length, 1)
  const daily = fixture.schedules[0]
  assert.equal(daily.title, 'Ria: 定期反思')
  assert.deepEqual(daily.target, { kind: 'session', sessionId: riaId })
  assert.equal(daily.status, 'active')
  assert.match(daily.rrule, /^DTSTART;TZID=Asia\/Shanghai:\d{8}T234000$/m)
  assert.match(daily.rrule, /^RRULE:FREQ=DAILY$/m)
  assert.ok(new Date(daily.scheduledAt).getTime() > Date.now())
  assert.equal(readReflectionState(fixture.stateDir).scheduleId, daily.id)

  const edited = await api('POST', '/plugins/dsh-ria/api/settings', { reflection: { time: '08:15' } })
  assert.equal(edited.status, 200)
  assert.equal(fixture.schedules.length, 1)
  assert.equal(fixture.schedules[0].id, daily.id)
  assert.match(fixture.schedules[0].rrule, /T081500$/m)
  assert.equal(fixture.schedules[0].status, 'active')

  const weekly = await api('POST', '/plugins/dsh-ria/api/settings', { reflection: { cadence: 'weekly', weekday: 3, time: '09:30' } })
  assert.equal(weekly.status, 200)
  assert.equal(fixture.schedules.length, 1)
  assert.match(fixture.schedules[0].rrule, /^RRULE:FREQ=WEEKLY;BYDAY=WE$/m)

  fixture.setRiaSession('session-ria-2')
  await fixture.service.ensureReflectionSchedule('test-rebuild')
  assert.equal(fixture.schedules.length, 1)
  assert.equal(fixture.schedules[0].id, daily.id)
  assert.equal(fixture.schedules[0].target.sessionId, 'session-ria-2')
  assert.equal(fixture.service.store.riaSessionId, 'session-ria-2')

  const manual = await api('POST', '/plugins/dsh-ria/api/reflection/run', { force: true, forDate: '2026-11-13' })
  assert.equal(manual.status, 202)
  assert.deepEqual(manual.body, { queued: true, forDate: '2026-11-13' })
  const injection = fixture.prompts.find(item => String(item.requestId).startsWith('host_'))
  assert.ok(injection, 'manual run must inject a host prompt')
  assert.equal(injection.sessionId, 'session-ria-2')
  assert.equal(injection.mode, 'queue')
  assert.equal(injection.content[0].text, '[REFLECTION MANUAL] forDate=2026-11-13 force=true — 请用 ria_reflect status/begin/dispatch/finish 跑一次反思')
  const statusAfterManual = await api('GET', '/plugins/dsh-ria/api/reflection/status')
  assert.equal(statusAfterManual.status, 200)
  assert.equal(statusAfterManual.body.scheduleId, daily.id)
  assert.equal(statusAfterManual.body.lastCompletedDate, null)

  fixture.setPromptFailure(new Error('prompt down'))
  const injectionFailed = await api('POST', '/plugins/dsh-ria/api/reflection/run', { forDate: '2026-11-13' })
  assert.equal(injectionFailed.status, 500)
  assert.match(injectionFailed.body.error, /prompt down/)
  fixture.setPromptFailure(undefined)

  const schedulesBeforeCatchup = fixture.schedules.length
  await fixture.service.reflectionStartupCheck()
  assert.equal(fixture.schedules.length, schedulesBeforeCatchup + 1)
  const catchup = fixture.schedules[fixture.schedules.length - 1]
  assert.match(catchup.title, /^Ria: 反思补跑 \d{4}-\d{2}-\d{2}$/)
  assert.equal(catchup.timing.kind, 'after')
  assert.equal(catchup.timing.after_seconds, 90)
  assert.match(catchup.prompt, /^\[REFLECTION CATCHUP\] forDate=\d{4}-\d{2}-\d{2}/)
  const stateAfterCatchup = readReflectionState(fixture.stateDir)
  assert.match(stateAfterCatchup.lastReminderForDate, /^\d{4}-\d{2}-\d{2}$/)
  await fixture.service.reflectionStartupCheck()
  assert.equal(fixture.schedules.length, schedulesBeforeCatchup + 1)
  assert.equal(readReflectionState(fixture.stateDir).lastReminderForDate, stateAfterCatchup.lastReminderForDate)

  const paused = await api('POST', '/plugins/dsh-ria/api/settings', { reflection: { enabled: false } })
  assert.equal(paused.status, 200)
  assert.equal(paused.body.reflection.enabled, false)
  assert.equal(paused.body.reflectionStatus.scheduleId, daily.id)
  const main = fixture.schedules.find(item => item.id === daily.id)
  assert.equal(main.status, 'paused')
  assert.equal(fixture.schedules.length, schedulesBeforeCatchup + 1)
  assert.equal(readReflectionState(fixture.stateDir).scheduleId, daily.id)
} finally {
  fixture.cleanup()
}

const migratedDir = mkdtempSync(join(tmpdir(), 'dsh-ria-reflection-migrate-'))
writeFileSync(join(migratedDir, 'ria.json'), JSON.stringify({
  version: 3,
  riaSessionId: null,
  settings: {
    wechatAutoPause: false,
    reflection: { cadence: 'weekly', time: '07:05', weekday: 3, custom: 'keep' },
  },
}))
const migrated = await createFixture({ stateDir: migratedDir })
try {
  const settings = await request(migrated.routes[0], 'GET', '/plugins/dsh-ria/api/settings')
  assert.equal(settings.status, 200)
  assert.equal(settings.body.wechatAutoPause, false)
  assert.equal(settings.body.reflection.enabled, false)
  assert.equal(settings.body.reflection.cadence, 'weekly')
  assert.equal(settings.body.reflection.time, '07:05')
  assert.equal(settings.body.reflection.weekday, 3)
  assert.equal(settings.body.reflection.custom, 'keep')
} finally {
  migrated.cleanup()
  rmSync(migratedDir, { recursive: true, force: true })
}

const unavailable = await createFixture({ noSchedule: true })
try {
  const result = await request(unavailable.routes[0], 'POST', '/plugins/dsh-ria/api/settings', { reflection: { enabled: true } })
  assert.equal(result.status, 200)
  assert.equal(result.body.reflection.enabled, true)
  assert.equal(result.body.reflectionStatus.scheduleAvailable, false)
  assert.match(result.body.reflectionStatus.scheduleError, /schedule/)
  assert.match(result.body.warning, /schedule/)
  const status = await request(unavailable.routes[0], 'GET', '/plugins/dsh-ria/api/reflection/status')
  assert.equal(status.status, 200)
  assert.equal(status.body.scheduleId, null)
} finally {
  unavailable.cleanup()
}

const busy = await createFixture({})
try {
  const configured = await request(busy.routes[0], 'POST', '/plugins/dsh-ria/api/settings', { reflection: { model: 'model-fast', provider: 'provider-ok' } })
  assert.equal(configured.status, 200)
  const begun = await busy.call('ria_reflect', { action: 'begin', forDate: '2026-11-13', trigger: 'manual' })
  assert.equal(begun.ok, true, JSON.stringify(begun))
  assert.equal(begun.locked, false)
  assert.equal(begun.spawn.model, 'model-fast')
  assert.equal(begun.spawn.provider, 'provider-ok')
  const conflict = await request(busy.routes[0], 'POST', '/plugins/dsh-ria/api/reflection/run', {})
  assert.equal(conflict.status, 409)
  assert.match(conflict.body.error, /already active/)
} finally {
  busy.cleanup()
}

console.log('reflection-schedule ok')
