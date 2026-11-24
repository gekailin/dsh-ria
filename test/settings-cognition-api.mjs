import assert from 'node:assert/strict'
import { createServer } from 'node:http'
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

try {
  const before = await call('GET')
  assert.equal(before.status, 200)
  assert.equal(Object.hasOwn(before.body, 'storage'), false)
  assert.equal(Object.hasOwn(before.body, 'cognition'), false)

  const rejected = await call('POST', { cognition: { backend: 'sqlite' } })
  assert.equal(rejected.status, 400)
  assert.equal(rejected.body.code, 'invalid_argument')
  assert.match(rejected.body.error, /body\.style|body\.memory|body\.reflection/)

  const after = await call('GET')
  assert.equal(after.status, 200)
  assert.equal(Object.hasOwn(after.body, 'storage'), false)
  assert.equal(Object.hasOwn(after.body, 'cognition'), false)
  assert.deepEqual(after.body.style, before.body.style)
  assert.deepEqual(after.body.memory, before.body.memory)
  console.log('settings no cognition backend ok')
} finally {
  await new Promise(resolve => server.close(resolve))
  fixture.cleanup()
}
