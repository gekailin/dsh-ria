import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFixture } from './support/ria-fixture.mjs'

const cwd = mkdtempSync(join(tmpdir(), 'ria-new-session-'))
const fixture = await createFixture({ stateDefault: true })
try {
  const chatbot = fixture.service.controller.state.chatSessionId
  const events = () => {
    try {
      return readFileSync(join(fixture.stateDir, 'router-events.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
    } catch { return [] }
  }

  const created = await fixture.callAs(chatbot, 'chatbot_new_session', {
    title: 'New Regular Session',
    cwd,
    firstMessage: 'hello new session',
  })
  assert.equal(created.ok, true, JSON.stringify(created))
  assert.equal(created.title, 'New Regular Session')
  assert.equal(created.cwd, cwd)
  assert.ok(created.sessionId)
  assert.equal(created.firstMessageSent, true)
  assert.ok(fixture.prompts.some(item => item.sessionId === created.sessionId && String(item.content[0].text) === 'hello new session'))
  const listed = await fixture.callAs(chatbot, 'chatbot_sessions', {})
  assert.ok(listed.sessions.some(item => item.sessionId === created.sessionId && item.title === 'New Regular Session'))
  assert.equal(fixture.visibleTools(chatbot).includes('chatbot_talk'), false)
  const createdEvents = events().filter(item => item.event === 'session.created.by_chatbot' && item.sessionId === created.sessionId)
  assert.equal(createdEvents.length, 1)
  assert.equal(createdEvents[0].payload.title, 'New Regular Session')
  assert.equal(createdEvents[0].payload.cwd, cwd)
  assert.equal(createdEvents[0].payload.preset, 'standard')

  const missing = await fixture.callAs(chatbot, 'chatbot_new_session', { title: 'Missing', cwd: join(cwd, 'nope') })
  assert.equal(missing.ok, false)
  assert.equal(missing.code, 'cwd_missing')
  const state = await fixture.callAs(chatbot, 'chatbot_new_session', { title: 'State', cwd: fixture.stateDir })
  assert.equal(state.ok, false)
  assert.equal(state.code, 'cwd_forbidden')
  const system = await fixture.callAs(chatbot, 'chatbot_new_session', { title: 'System', cwd: '/etc' })
  assert.equal(system.ok, false)
  assert.equal(system.code, 'cwd_forbidden')
  const file = join(cwd, 'file.txt')
  writeFileSync(file, 'x')
  const notDir = await fixture.callAs(chatbot, 'chatbot_new_session', { title: 'File', cwd: file })
  assert.equal(notDir.ok, false)
  assert.equal(notDir.code, 'cwd_not_directory')
  const longTitle = await fixture.callAs(chatbot, 'chatbot_new_session', { title: 'x'.repeat(81), cwd })
  assert.equal(longTitle.ok, false)
  assert.equal(longTitle.code, 'title_too_long')
  const badPreset = await fixture.callAs(chatbot, 'chatbot_new_session', { title: 'Bad', cwd, preset: 'danger' })
  assert.equal(badPreset.ok, false)
  assert.equal(badPreset.code, 'preset_invalid')

  // Other roles have no such tool.
  const advisor = await fixture.advisorSession()
  await assert.rejects(() => fixture.callAs(advisor, 'chatbot_new_session', { title: 'No', cwd }), /tool not installed|forbidden/)

  // Rate limit: the normal create above already used one slot; four more hit 5,
  // the sixth returns rate_limited.
  for (let index = 0; index < 4; index += 1) {
    const item = await fixture.callAs(chatbot, 'chatbot_new_session', { title: 'Rate ' + index, cwd })
    assert.equal(item.ok, true, JSON.stringify(item))
  }
  const limited = await fixture.callAs(chatbot, 'chatbot_new_session', { title: 'Rate 5', cwd })
  assert.equal(limited.ok, false)
  assert.equal(limited.code, 'session_rate_limited')

  console.log('state new session ok')
} finally {
  fixture.cleanup()
  rmSync(cwd, { recursive: true, force: true })
}

// Host create failure is returned as a readable error.
{
  const failCwd = mkdtempSync(join(tmpdir(), 'ria-new-session-fail-'))
  const failing = await createFixture({ stateDefault: true })
  try {
    const chatbot = failing.service.controller.state.chatSessionId
    failing.service.ctx.sessionController.create = async () => { throw new Error('host denied') }
    const result = await failing.callAs(chatbot, 'chatbot_new_session', { title: 'Fail', cwd: failCwd })
    assert.equal(result.ok, false)
    assert.equal(result.code, 'session_create_failed')
    assert.match(result.message, /host denied/)
    console.log('state new session failure ok')
  } finally {
    failing.cleanup()
    rmSync(failCwd, { recursive: true, force: true })
  }
}