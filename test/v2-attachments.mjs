import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFixture } from './support/ria-fixture.mjs'

const oldDshHome = process.env.DSH_HOME
const dshHome = mkdtempSync(join(tmpdir(), 'ria-dsh-home-'))
process.env.DSH_HOME = dshHome
const imageRoot = join(dshHome, 'attachments', 'v1', 'objects')
const imagePath = (sha, bytes = 'png') => {
  const dir = join(imageRoot, sha.slice(0, 2))
  mkdirSync(dir, { recursive: true })
  const file = join(dir, sha)
  writeFileSync(file, bytes)
  return file
}
const imageRef = (sha, extra = {}) => ({
  type: 'image',
  attachment: { attachmentId: 'sha256:' + sha, mediaType: 'image/png', width: 1280, height: 720, ...extra },
})
const shaOf = text => createHash('sha256').update(text).digest('hex')

const fixture = await createFixture({ v2Default: true, advisorMode: 'stateless', llmReply: () => JSON.stringify({ action: 'plan', workOrder: { summary: 'inspect screenshot', steps: ['read image'] } }) })
try {
  const controller = fixture.service.v2
  const chatbot = fixture.service.v2.v2.chatbotSessionId
  const sendUser = (content) => fixture.service.onSessionEvent(
    { header: { id: chatbot } },
    { type: 'user/message', seq: 1, time: Date.now(), data: { content, source: { kind: 'user', rpcId: 'user-with-image' } } },
  )
  const request = (extra = {}) => fixture.callAs(chatbot, 'chatbot_request', { goal: 'inspect screenshot', ...extra })
  const created = id => fixture.service.routerEvents.query({ ticketId: id }).events.find(item => item.event === 'ticket.created')

  const sha1 = shaOf('image-one')
  imagePath(sha1)
  sendUser([{ type: 'text', text: 'look at this' }, imageRef(sha1)])
  const first = await request()
  assert.equal(first.ok, true, JSON.stringify(first))
  const meta = controller.v2.ticketMeta(first.ticketId)
  assert.equal(meta.attachments.length, 1)
  assert.equal(meta.attachments[0].path, join(imageRoot, sha1.slice(0, 2), sha1))
  assert.equal(meta.attachments[0].mime, 'image/png')
  assert.equal(meta.attachments[0].width, 1280)
  assert.equal(meta.attachments[0].height, 720)
  assert.equal(meta.attachments[0].sha256, sha1)
  const event = created(first.ticketId)
  assert.equal(event.payload.attachments.count, 1)
  assert.deepEqual(event.payload.attachments.sha256, [sha1])
  const workOrder = controller.v2.workOrder(first.ticketId)
  assert.equal(workOrder.attachments[0].path, meta.attachments[0].path)
  const workerPrompt = fixture.prompts.find(item => item.sessionId === fixture.service.store.ticket(first.ticketId).executor)
  assert.ok(workerPrompt && String(workerPrompt.content[0].text).includes(meta.attachments[0].path))
  assert.ok(String(workerPrompt.content[0].text).includes('需要时用 read 工具查看'))
  assert.equal(/base64/i.test(String(workerPrompt.content[0].text)), false)

  // Current message has no image: fallback one previous user message.
  sendUser([{ type: 'text', text: 'no image now' }])
  const fallback = await request()
  assert.equal(fallback.ok, true)
  assert.equal(controller.v2.ticketMeta(fallback.ticketId).attachments.length, 1)

  // N=0 disables fallback.
  fixture.service.options.attachmentFallbackMessages = 0
  sendUser([{ type: 'text', text: 'still no image' }])
  const noFallback = await request()
  assert.equal(noFallback.ok, true)
  assert.equal(controller.v2.ticketMeta(noFallback.ticketId).attachments.length, 0)

  // Current message with six images: truncate to five, dedupe same sha.
  const shas = [1, 2, 3, 4, 5, 6].map(index => shaOf('many-' + index))
  for (const sha of shas) imagePath(sha)
  sendUser([imageRef(shas[0]), imageRef(shas[0]), ...shas.slice(1).map(sha => imageRef(sha))])
  const many = await request()
  assert.equal(controller.v2.ticketMeta(many.ticketId).attachments.length, 5)
  const unique = new Set(controller.v2.ticketMeta(many.ticketId).attachments.map(item => item.sha256))
  assert.equal(unique.size, 5)

  // Oversized image keeps path and marks oversized.
  const largeSha = shaOf('large-image')
  imagePath(largeSha, Buffer.alloc(10 * 1024 * 1024 + 1))
  sendUser([imageRef(largeSha)])
  const large = await request()
  const largeAttachment = controller.v2.ticketMeta(large.ticketId).attachments[0]
  assert.equal(largeAttachment.oversized, true)
  const largeWorker = fixture.prompts.find(item => item.sessionId === fixture.service.store.ticket(large.ticketId).executor)
  assert.ok(String(largeWorker.content[0].text).includes('[oversized]'))
  assert.ok(String(largeWorker.content[0].text).includes('不建议读入'))

  // attachImages=false: no meta attachment and event count 0.
  sendUser([imageRef(shas[0])])
  const disabled = await request({ attachImages: false })
  assert.equal(controller.v2.ticketMeta(disabled.ticketId).attachments.length, 0)
  assert.equal(created(disabled.ticketId).payload.attachments.count, 0)

  // No-image message with default fallback from current empty: still empty.
  sendUser([{ type: 'text', text: 'no images at all' }])
  const none = await request()
  assert.equal(controller.v2.ticketMeta(none.ticketId).attachments.length, 0)

  await new Promise(resolve => setTimeout(resolve, 30))
  console.log('v2 attachments ok')
} finally {
  fixture.cleanup()
  if (oldDshHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = oldDshHome
  rmSync(dshHome, { recursive: true, force: true })
}
