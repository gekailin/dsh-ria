import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { createFixture } from './support/ria-fixture.mjs'

const fixture = await createFixture()

function request(method, path, payload) {
  const route = fixture.routes.find(item => item.path === '/plugins/dsh-ria/api')
  assert.ok(route, 'API route registered')
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

function promptText(prompt) {
  return (prompt.content || []).map(part => part && part.text ? part.text : '').join('\n')
}

try {
  const root = await fixture.call('ria_topic', { action: 'create', title: 'Roadmap', brief: 'Top level work', level: 1, executor: 'self' })
  const child = await fixture.call('ria_topic', {
    action: 'create',
    title: 'Design',
    brief: 'Second level work',
    level: 2,
    parentId: root.topic.topicId,
    executor: 'self',
  })
  const createsBefore = fixture.creates.length
  const ticketsBefore = fixture.service.store.tickets().length
  const deliveriesBefore = fixture.service.store.deliveries().length

  const panel = await request('POST', '/plugins/dsh-ria/api/ask', {
    topicId: root.topic.topicId,
    text: '  Check the empty state before the next review  ',
    source: 'panel',
  })
  assert.equal(panel.status, 200, JSON.stringify(panel.body))
  assert.equal(panel.body.ok, true)
  assert.equal(panel.body.topicId, root.topic.topicId)
  assert.equal(panel.body.source, 'panel')
  assert.ok(panel.body.sessionId, 'the response names the Ria session')
  assert.equal(fixture.prompts.length, 1)
  const panelPrompt = fixture.prompts[0]
  assert.equal(panelPrompt.sessionId, panel.body.sessionId)
  assert.equal(panelPrompt.mode, 'queue')
  assert.match(panelPrompt.requestId, /^host_/)
  assert.equal(promptText(panelPrompt), '【看板 · 主题面板】【Roadmap】\nCheck the empty state before the next review')

  const card = await request('POST', '/plugins/dsh-ria/api/ask', {
    topicId: child.topic.topicId,
    text: 'Where does this sub-topic stand?',
    source: 'card',
  })
  assert.equal(card.status, 200, JSON.stringify(card.body))
  assert.equal(card.body.source, 'card')
  assert.equal(promptText(fixture.prompts[1]), '【看板 · 主题卡】【Design】（子主题）\nWhere does this sub-topic stand?')

  const empty = await request('POST', '/plugins/dsh-ria/api/ask', {
    topicId: root.topic.topicId,
    text: '   ',
    source: 'panel',
  })
  assert.equal(empty.status, 400)
  assert.equal(empty.body.code, 'text_empty')

  const tooLong = await request('POST', '/plugins/dsh-ria/api/ask', {
    topicId: root.topic.topicId,
    text: 'x'.repeat(1001),
    source: 'panel',
  })
  assert.equal(tooLong.status, 400)
  assert.equal(tooLong.body.code, 'text_too_long')

  const atLimit = await request('POST', '/plugins/dsh-ria/api/ask', {
    topicId: root.topic.topicId,
    text: 'x'.repeat(1000),
    source: 'card',
  })
  assert.equal(atLimit.status, 200, JSON.stringify(atLimit.body))
  assert.equal(fixture.prompts.length, 3)

  const missingTopic = await request('POST', '/plugins/dsh-ria/api/ask', {
    topicId: 'topic_missing',
    text: 'hello',
    source: 'panel',
  })
  assert.equal(missingTopic.status, 404)
  assert.equal(missingTopic.body.code, 'topic_missing')

  const unclassified = await request('POST', '/plugins/dsh-ria/api/ask', {
    topicId: 'unclassified:inbox',
    text: 'hello',
    source: 'panel',
  })
  assert.equal(unclassified.status, 400)
  assert.equal(unclassified.body.code, 'topic_unclassified')

  const badSource = await request('POST', '/plugins/dsh-ria/api/ask', {
    topicId: root.topic.topicId,
    text: 'hello',
    source: 'somewhere',
  })
  assert.equal(badSource.status, 400)
  assert.equal(badSource.body.code, 'source_invalid')
  assert.equal(fixture.prompts.length, 3, 'rejected asks do not reach Ria')

  // A busy Ria must still receive a queued prompt: /ask never steers or
  // interrupts, and it never creates a ticket or dispatches a worker.
  fixture.service.currentRiaTurn = 7
  const busy = await request('POST', '/plugins/dsh-ria/api/ask', {
    topicId: root.topic.topicId,
    text: 'While you are busy',
    source: 'panel',
  })
  assert.equal(busy.status, 200, JSON.stringify(busy.body))
  assert.equal(fixture.prompts[3].mode, 'queue')
  fixture.service.currentRiaTurn = undefined

  assert.equal(fixture.service.store.tickets().length, ticketsBefore, 'asking the board never creates a ticket')
  assert.equal(fixture.service.store.deliveries().length, deliveriesBefore, 'asking the board never dispatches')
  assert.equal(fixture.creates.length, createsBefore, 'asking the board never creates a worker')

  const sourceText = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  assert.match(sourceText, /data-ria-topic-ask"/)
  assert.match(sourceText, /data-ria-topic-ask-form/)
  assert.match(sourceText, /data-ria-topic-ask-input/)
  assert.match(sourceText, /data-ria-topic-ask-send/)
  assert.match(sourceText, /data-ria-topic-ask-error/)
  assert.match(sourceText, /data-ria-board-ask-toast/)
  assert.match(sourceText, /function boardAskToast/)
  assert.match(sourceText, /function sendAsk/)
  assert.doesNotMatch(sourceText, /function TicketComposeDialog/)
  assert.doesNotMatch(sourceText, /data-ria-topic-compose/)
  assert.doesNotMatch(sourceText, /data-ria-ticket-created/)
  assert.doesNotMatch(sourceText, /board\/ticket/)

  const serverText = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
  assert.match(serverText, /async askBoardTopic/)
  assert.match(serverText, /BOARD_ASK_TEXT_LIMIT/)
  assert.doesNotMatch(serverText, /createBoardTicket/)
  assert.doesNotMatch(serverText, /ticket_created/)
  assert.doesNotMatch(serverText, /board\/ticket/)

  console.log('board-ask ok')
} finally {
  fixture.cleanup()
}
