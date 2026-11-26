import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createFixture } from './support/ria-fixture.mjs'

const fixture = await createFixture({ stateDefault: true })
const server = createServer((req, res) => fixture.service.httpHandler(req, res))
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const base = 'http://127.0.0.1:' + server.address().port + '/plugins/dsh-ria/api'
const post = async (path, payload) => {
  const response = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) })
  return { status: response.status, body: await response.json() }
}
try {
  const text = 'hello board upload'
  const uploaded = await post('/board-upload', {
    name: 'hello.txt',
    mime: 'text/plain',
    data: Buffer.from(text).toString('base64'),
  })
  assert.equal(uploaded.status, 200, JSON.stringify(uploaded.body))
  assert.equal(uploaded.body.ok, true)
  assert.equal(uploaded.body.name, 'hello.txt')
  assert.equal(uploaded.body.size, text.length)
  assert.equal(uploaded.body.path.startsWith(join(fixture.stateDir, 'board-uploads') + '/'), true)
  assert.equal(readFileSync(uploaded.body.path, 'utf8'), text)

  let tooLargeError = null
  try {
    await fixture.service.boardUpload({ name: 'big.txt', mime: 'text/plain', data: Buffer.alloc(10 * 1024 * 1024 + 1).toString('base64') })
  } catch (error) { tooLargeError = error }
  assert.equal(tooLargeError && tooLargeError.code, 'upload_too_large')

  const badType = await post('/board-upload', { name: 'x.exe', mime: 'application/x-msdownload', data: 'AA==' })
  assert.equal(badType.status, 400)
  assert.equal(badType.body.code, 'upload_type_rejected')

  const topic = fixture.service.store.addTopic({ title: 'say dialog topic' })
  const asked = await post('/ask', {
    source: 'card', topicId: topic.topicId, projectTitle: 'say project', text: '', attachments: [uploaded.body],
  })
  assert.equal(asked.status, 200, JSON.stringify(asked.body))
  assert.equal(asked.body.ok, true)
  assert.equal(asked.body.attachments[0].name, 'hello.txt')

  const client = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  assert.match(client, /function SayDialog\(props\)/)
  assert.match(client, /data-ria-say-dialog/)
  assert.match(client, /data-ria-say-input/)
  assert.match(client, /data-ria-say-attach/)
  assert.match(client, /data-ria-say-send/)
  assert.match(client, /onOpenSay: openSay/)
  assert.equal(client.includes('data-ria-project-ask-form'), false)
  assert.equal(client.includes('data-ria-topic-ask-form'), false)
  assert.equal(client.includes('onClick: ask'), false)
  // The only send path is the explicit button; keyboard events only stop propagation.
  assert.equal(client.includes('if (event.key === "Enter") submitAsk(event)'), false)
  console.log('board say dialog/upload ok')
} finally {
  await new Promise(resolve => server.close(resolve))
  fixture.cleanup()
}