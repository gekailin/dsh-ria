import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createFixture } from './support/ria-fixture.mjs'

const fixture = await createFixture({ stateDefault: true })
const server = createServer((req, res) => fixture.service.httpHandler(req, res))
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const base = 'http://127.0.0.1:' + server.address().port + '/plugins/dsh-ria/api/settings'
const call = async (method, body) => {
  const response = await fetch(base, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  return { status: response.status, body: await response.json() }
}
const eventLines = () => {
  try { return readFileSync(fixture.service.routerEvents.file, 'utf8').trim().split(/\n/).filter(Boolean).map(line => JSON.parse(line)) } catch { return [] }
}

try {
  const before = fixture.service.store.settings()
  const get = await call('GET')
  assert.equal(get.status, 200)
  assert.equal(get.body.cognition.backend, 'file')
  assert.equal(get.body.cognition.voice, null)

  const accepted = await call('POST', { cognition: { backend: 'sqlite' } })
  assert.equal(accepted.status, 200, JSON.stringify(accepted.body))
  assert.equal(accepted.body.cognition.backend, 'sqlite')
  assert.equal(fixture.service.store.settings().cognition.backend, 'sqlite')
  const after = fixture.service.store.settings()
  assert.deepEqual({ ...after, cognition: undefined }, { ...before, cognition: undefined }, 'other settings unchanged')
  const event = eventLines().filter(item => item.event === 'settings.changed').at(-1)
  assert.equal(event.payload.from, 'file')
  assert.equal(event.payload.to, 'sqlite')
  assert.equal(event.payload.cognition.backend.to, 'sqlite')

  const voice = await call('POST', { cognition: { voice: 'brief voice' } })
  assert.equal(voice.status, 200)
  assert.equal(voice.body.cognition.backend, 'sqlite')
  assert.equal(voice.body.cognition.voice, 'brief voice')
  const backendOnly = await call('POST', { cognition: { backend: 'file' } })
  assert.equal(backendOnly.status, 200)
  assert.equal(backendOnly.body.cognition.backend, 'file')
  assert.equal(backendOnly.body.cognition.voice, 'brief voice', 'voice survives shallow merge')
  const last = eventLines().filter(item => item.event === 'settings.changed').at(-1)
  assert.equal(last.payload.from, 'sqlite')
  assert.equal(last.payload.to, 'file')

  const invalidValue = await call('POST', { cognition: { backend: 'postgres' } })
  assert.equal(invalidValue.status, 400)
  assert.equal(invalidValue.body.code, 'invalid_argument')
  assert.match(invalidValue.body.error, /file, sqlite/)
  const invalidVoice = await call('POST', { cognition: { voice: 42 } })
  assert.equal(invalidVoice.status, 400)
  assert.equal(invalidVoice.body.code, 'invalid_argument')
  const invalidShape = await call('POST', { cognition: [] })
  assert.equal(invalidShape.status, 400)
  assert.equal(invalidShape.body.code, 'invalid_argument')
  assert.equal(fixture.service.store.settings().cognition.backend, 'file')
  console.log('settings cognition API ok')
} finally {
  await new Promise(resolve => server.close(resolve))
  fixture.cleanup()
}
