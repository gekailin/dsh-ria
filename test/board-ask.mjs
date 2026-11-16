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

  // The workspace header is the primary entry: one ordinary message, naming
  // the project it came from, not a topic card.
  const workspace = await request('POST', '/plugins/dsh-ria/api/ask', {
    projectId: 'workspace:demo',
    projectTitle: '  dsh-ria   board  ',
    text: '  Check the empty state before the next review  ',
    source: 'workspace',
  })
  assert.equal(workspace.status, 200, JSON.stringify(workspace.body))
  assert.equal(workspace.body.ok, true)
  assert.equal(workspace.body.projectId, 'workspace:demo')
  assert.equal(workspace.body.source, 'workspace')
  assert.ok(workspace.body.sessionId, 'the response names the Ria session')
  assert.equal(fixture.prompts.length, 1)
  const workspacePrompt = fixture.prompts[0]
  assert.equal(workspacePrompt.sessionId, workspace.body.sessionId)
  assert.equal(workspacePrompt.mode, 'queue')
  assert.match(workspacePrompt.requestId, /^host_/)
  assert.equal(promptText(workspacePrompt), '【看板 · 工作区】dsh-ria board Check the empty state before the next review')

  // A missing title falls back to the project id rather than dropping the
  // source label.
  const fallbackTitle = await request('POST', '/plugins/dsh-ria/api/ask', {
    projectId: 'workspace:demo',
    text: 'fallback title',
    source: 'workspace',
  })
  assert.equal(fallbackTitle.status, 200, JSON.stringify(fallbackTitle.body))
  assert.equal(promptText(fixture.prompts[1]), '【看板 · 工作区】workspace:demo fallback title')

  const card = await request('POST', '/plugins/dsh-ria/api/ask', {
    topicId: child.topic.topicId,
    text: 'Where does this sub-topic stand?',
    source: 'card',
  })
  assert.equal(card.status, 200, JSON.stringify(card.body))
  assert.equal(card.body.source, 'card')
  assert.equal(promptText(fixture.prompts[2]), '【看板 · 主题卡】【Design】（子主题）Where does this sub-topic stand?')

  const topCard = await request('POST', '/plugins/dsh-ria/api/ask', {
    topicId: root.topic.topicId,
    text: 'Top level question',
    source: 'card',
  })
  assert.equal(topCard.status, 200, JSON.stringify(topCard.body))
  assert.equal(promptText(fixture.prompts[3]), '【看板 · 主题卡】【Roadmap】Top level question')

  const empty = await request('POST', '/plugins/dsh-ria/api/ask', {
    projectId: 'workspace:demo',
    text: '   ',
    source: 'workspace',
  })
  assert.equal(empty.status, 400)
  assert.equal(empty.body.code, 'text_empty')

  const tooLong = await request('POST', '/plugins/dsh-ria/api/ask', {
    projectId: 'workspace:demo',
    text: 'x'.repeat(1001),
    source: 'workspace',
  })
  assert.equal(tooLong.status, 400)
  assert.equal(tooLong.body.code, 'text_too_long')

  const atLimit = await request('POST', '/plugins/dsh-ria/api/ask', {
    topicId: root.topic.topicId,
    text: 'x'.repeat(1000),
    source: 'card',
  })
  assert.equal(atLimit.status, 200, JSON.stringify(atLimit.body))
  assert.equal(fixture.prompts.length, 5)

  const missingProject = await request('POST', '/plugins/dsh-ria/api/ask', {
    text: 'hello',
    source: 'workspace',
  })
  assert.equal(missingProject.status, 400)
  assert.equal(missingProject.body.code, 'project_required')

  const missingTopic = await request('POST', '/plugins/dsh-ria/api/ask', {
    topicId: 'topic_missing',
    text: 'hello',
    source: 'card',
  })
  assert.equal(missingTopic.status, 404)
  assert.equal(missingTopic.body.code, 'topic_missing')

  const unclassified = await request('POST', '/plugins/dsh-ria/api/ask', {
    topicId: 'unclassified:inbox',
    text: 'hello',
    source: 'card',
  })
  assert.equal(unclassified.status, 400)
  assert.equal(unclassified.body.code, 'topic_unclassified')

  // The removed panel entry and any unknown source are rejected rather than
  // silently treated as a card.
  const panel = await request('POST', '/plugins/dsh-ria/api/ask', {
    topicId: root.topic.topicId,
    text: 'hello',
    source: 'panel',
  })
  assert.equal(panel.status, 400)
  assert.equal(panel.body.code, 'source_invalid')

  const badSource = await request('POST', '/plugins/dsh-ria/api/ask', {
    topicId: root.topic.topicId,
    text: 'hello',
    source: 'somewhere',
  })
  assert.equal(badSource.status, 400)
  assert.equal(badSource.body.code, 'source_invalid')
  assert.equal(fixture.prompts.length, 5, 'rejected asks do not reach Ria')

  // A busy Ria must still receive a queued prompt: /ask never steers or
  // interrupts, and it never creates a ticket or dispatches a worker.
  fixture.service.currentRiaTurn = 7
  const busy = await request('POST', '/plugins/dsh-ria/api/ask', {
    projectId: 'workspace:demo',
    text: 'While you are busy',
    source: 'workspace',
  })
  assert.equal(busy.status, 200, JSON.stringify(busy.body))
  assert.equal(fixture.prompts[5].mode, 'queue')
  fixture.service.currentRiaTurn = undefined

  assert.equal(fixture.service.store.tickets().length, ticketsBefore, 'asking the board never creates a ticket')
  assert.equal(fixture.service.store.deliveries().length, deliveriesBefore, 'asking the board never dispatches')
  assert.equal(fixture.creates.length, createsBefore, 'asking the board never creates a worker')

  const sourceText = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  assert.match(sourceText, /function ProjectHeader/)
  assert.match(sourceText, /"data-ria-project-header"/)
  assert.match(sourceText, /"data-ria-project-ask"/)
  assert.match(sourceText, /"data-ria-project-ask-form"/)
  assert.match(sourceText, /"data-ria-project-ask-input"/)
  assert.match(sourceText, /"data-ria-project-ask-send"/)
  assert.match(sourceText, /"data-ria-project-ask-error"/)
  assert.match(sourceText, /"data-ria-project-stats"/)
  assert.match(sourceText, /function projectStatsText/)
  assert.match(sourceText, /function boardStatsSummary/)
  assert.match(sourceText, /"data-ria-board-refresh"/)
  assert.match(sourceText, /"data-ria-board-updated"/)
  assert.match(sourceText, /"data-ria-board-scroller"/)
  assert.match(sourceText, /function refreshBoard/)
  assert.match(sourceText, /"data-ria-topic-ask"/)
  assert.match(sourceText, /data-ria-topic-ask-form/)
  assert.match(sourceText, /data-ria-board-ask-toast/)
  assert.match(sourceText, /function boardAskToast/)
  assert.match(sourceText, /function sendAsk/)
  assert.equal(sourceText.split('"data-ria-topic-ask-form"').length - 1, 1, 'only topic cards keep an ask form')
  assert.doesNotMatch(sourceText, /【看板 · 主题面板】/)
  assert.doesNotMatch(sourceText, /function TicketComposeDialog/)
  assert.doesNotMatch(sourceText, /data-ria-topic-compose/)
  assert.doesNotMatch(sourceText, /data-ria-ticket-created/)
  assert.doesNotMatch(sourceText, /board\/ticket/)

  const serverText = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
  assert.match(serverText, /async askBoardTopic/)
  assert.match(serverText, /BOARD_ASK_TEXT_LIMIT/)
  assert.match(serverText, /project_required/)
  assert.match(serverText, /【看板 · 工作区】/)
  assert.match(serverText, /topicsActive/)
  assert.match(serverText, /topicsBlocked/)
  assert.doesNotMatch(serverText, /【看板 · 主题面板】/)
  assert.doesNotMatch(serverText, /createBoardTicket/)
  assert.doesNotMatch(serverText, /ticket_created/)
  assert.doesNotMatch(serverText, /board\/ticket/)

  console.log('board-ask ok')
} finally {
  fixture.cleanup()
}
