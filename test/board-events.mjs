import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import { createFixture } from './support/ria-fixture.mjs'

const fixture = await createFixture()

function openStream(headers = {}) {
  const route = fixture.routes.find(item => item.path === '/plugins/dsh-ria/api')
  assert.ok(route, 'API route registered')
  const req = new EventEmitter()
  req.method = 'GET'
  req.url = '/plugins/dsh-ria/api/board/events'
  req.headers = { host: '127.0.0.1:3080', ...headers }
  const res = new EventEmitter()
  res.statusCode = 0
  res.headers = {}
  res.chunks = []
  res.writableEnded = false
  res.setHeader = function (name, value) { this.headers[name] = value }
  res.writeHead = function (status, values) {
    this.statusCode = status
    Object.assign(this.headers, values || {})
    return this
  }
  res.flushHeaders = function () {}
  res.write = function (chunk) {
    if (this.writableEnded) return false
    this.chunks.push(String(chunk))
    return true
  }
  res.end = function (chunk) {
    if (chunk) this.write(chunk)
    this.writableEnded = true
    this.emit('close')
    return this
  }
  route.handler(req, res)
  return { req, res, text: () => res.chunks.join('') }
}

try {
  const service = fixture.service
  const store = service.store
  const opened = openStream()
  assert.equal(opened.res.statusCode, 200)
  assert.match(String(opened.res.headers['content-type']), /^text\/event-stream/)
  assert.equal(opened.res.headers['cache-control'], 'no-store')
  assert.equal(opened.res.headers['x-accel-buffering'], 'no')
  assert.match(opened.text(), /^retry: 3000\n\n/)
  const ready = opened.text().match(/event: ready\ndata: (.*)\n\n/)
  assert.ok(ready, 'ready event')
  const readyBody = JSON.parse(ready[1])
  assert.equal(typeof readyBody.revision, 'number')
  assert.equal(readyBody.revision, service.boardRevision)
  assert.equal(service.boardStreams.size, 1)

  const beforeCreate = opened.text().length
  const created = store.addTicket({ goal: 'auto refresh on create', executor: 'session-worker' })
  assert.ok(created && created.ticketId)
  const createEvent = opened.text().slice(beforeCreate)
  assert.match(createEvent, /event: board\ndata: /)
  const createBody = JSON.parse(createEvent.match(/event: board\ndata: (.*)\n\n/)[1])
  assert.ok(createBody.revision > readyBody.revision)
  assert.equal(createBody.revision, service.boardRevision)
  assert.equal(typeof createBody.at, 'number')

  const beforeTransition = opened.text().length
  const transition = store.transitionTicket(created.ticketId, 'working', { executor: 'session-worker' })
  assert.equal(transition.ok, true)
  const transitionEvent = opened.text().slice(beforeTransition)
  assert.match(transitionEvent, /event: board\ndata: /)
  const transitionBody = JSON.parse(transitionEvent.match(/event: board\ndata: (.*)\n\n/)[1])
  assert.ok(transitionBody.revision > createBody.revision)
  assert.equal(transitionBody.revision, service.boardRevision)

  // Closing the response removes the stream: later writes must not touch it.
  const sizeBeforeClose = opened.text().length
  opened.res.emit('close')
  assert.equal(service.boardStreams.size, 0)
  assert.equal(opened.res.writableEnded, true)
  const closedTicket = store.addTicket({ goal: 'no stream after close', executor: 'session-worker' })
  assert.equal(opened.text().length, sizeBeforeClose)
  assert.equal(service.boardStreams.size, 0)
  assert.ok(closedTicket.ticketId)

  // A cross-origin EventSource request is rejected before it can subscribe.
  const blocked = openStream({ origin: 'http://evil.example' })
  assert.equal(blocked.res.statusCode, 403)
  assert.equal(service.boardStreams.size, 0)
  assert.match(blocked.text(), /cross-origin request rejected/)

  // Multiple concurrent boards each get their own stream.
  const one = openStream()
  const two = openStream()
  assert.equal(service.boardStreams.size, 2)
  const revisionBefore = service.boardRevision
  store.addTicket({ goal: 'fan out one revision', executor: 'session-worker' })
  for (const stream of [one, two]) {
    assert.match(stream.text(), /event: board\ndata: /)
    const body = JSON.parse(stream.text().match(/event: board\ndata: (.*)\n\n/)[1])
    assert.ok(body.revision > revisionBefore)
  }
  service.shutdownBoardStreams()
  assert.equal(service.boardStreams.size, 0)

  const client = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  assert.match(client, /new window\.EventSource\(API \+ "\/board\/events"\)/)
  assert.match(client, /addEventListener\("board"/)
  assert.match(client, /scheduleBoardRefresh\(300\)/)
  assert.match(client, /document\.addEventListener\("visibilitychange", onVisibilityChange\)/)
  assert.match(client, /if \(opened\) scheduleBoardRefresh\(300\)/)
  assert.match(client, /refreshQueuedRef\.current = true/)
  assert.match(client, /"data-ria-board-updated"/)
  assert.doesNotMatch(client, /data-ria-board-refresh/)
  assert.doesNotMatch(client, /刷新中/)
  assert.doesNotMatch(client, /刷新失败/)

  console.log('board-events ok')
} finally {
  fixture.service.shutdownBoardStreams()
  fixture.cleanup()
}
