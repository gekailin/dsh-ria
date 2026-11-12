import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createFixture } from './support/ria-fixture.mjs'

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lK3Q6wAAAABJRU5ErkJggg==', 'base64')
const fixture = await createFixture()
const imagePath = join(fixture.stateDir, 'shot.png')
const textPath = join(fixture.stateDir, 'notes.txt')
const bigPath = join(fixture.stateDir, 'big.png')
writeFileSync(imagePath, png)
writeFileSync(textPath, 'not an image')
const big = Buffer.alloc(2048)
png.copy(big, 0, 0, Math.min(png.length, 12))
writeFileSync(bigPath, big)

try {
  const before = fixture.prompts.length
  const probe = await fixture.call('ria_ticket', { goal: 'attachment probe', executor: 'session-worker' })
  const noImageTicket = await fixture.call('ria_ticket', { goal: 'model image probe', executor: 'session-no-image' })
  const missing = await fixture.call('ria_request', { targetSessionIds: ['session-worker'], message: 'look', attachments: [join(fixture.stateDir, 'missing.png')], ticketId: probe.ticket.ticketId, note: '把截图交给 Worker One 检查。' })
  assert.equal(missing.results[0].ok, false)
  assert.equal(missing.results[0].code, 'attachment_missing')
  assert.match(missing.results[0].message, /missing.png/)
  assert.equal(fixture.prompts.length, before)

  const invalid = await fixture.call('ria_request', { targetSessionIds: ['session-worker'], message: 'look', attachments: [textPath], ticketId: probe.ticket.ticketId, note: '把截图交给 Worker One 检查。' })
  assert.equal(invalid.results[0].code, 'attachment_invalid')
  assert.match(invalid.results[0].message, /不是支持的图片/)
  assert.equal(fixture.prompts.length, before)

  const oversized = await fixture.call('ria_request', { targetSessionIds: ['session-worker'], message: 'look', attachments: [bigPath], ticketId: probe.ticket.ticketId, note: '把截图交给 Worker One 检查。' })
  assert.equal(oversized.results[0].code, 'attachment_invalid')
  assert.match(oversized.results[0].message, /大小上限/)
  assert.equal(fixture.prompts.length, before)

  const noImage = await fixture.call('ria_request', { targetSessionIds: ['session-no-image'], message: 'look', attachments: [imagePath], ticketId: noImageTicket.ticket.ticketId, note: '把截图交给 Worker Two 检查。' })
  assert.equal(noImage.results[0].code, 'model_no_image')
  assert.match(noImage.results[0].message, /session-no-image/)
  assert.match(noImage.results[0].message, /provider-text\/model-text-only/)
  assert.equal(fixture.prompts.length, before)

  assert.equal((await fixture.call('ria_status', { scope: 'recent' })).workers.length, 0)

  fixture.resetConcluded()
  const task = await fixture.call('ria_ticket', { goal: 'inspect the screenshot', executor: 'session-worker' })
  const taskFailure = await fixture.call('ria_request', {
    targetSessionIds: ['session-worker'],
    message: 'look',
    ticketId: task.ticket.ticketId,
    note: '把截图交给 Worker One 检查。',
    attachments: [join(fixture.stateDir, 'missing.png')],
  })
  assert.equal(taskFailure.results[0].code, 'attachment_missing')
  assert.equal(fixture.prompts.length, before)
  assert.equal(fixture.concluded, 0)
  const tasks = await fixture.call('ria_status', { scope: 'tickets' })
  assert.equal(tasks.tickets.find(item => item.ticketId === task.ticket.ticketId).status, 'open')
  assert.equal((await fixture.call('ria_status', { scope: 'recent' })).workers.length, 0)

  fixture.resetConcluded()
  const partial = await fixture.call('ria_request', {
    targetSessionIds: ['session-worker', 'session-no-image'],
    message: 'look',
    ticketId: probe.ticket.ticketId,
    note: '把截图交给 Worker One 检查。',
    attachments: [imagePath],
  })
  assert.equal(partial.results.length, 2)
  assert.equal(partial.results[0].ok, true)
  assert.equal(partial.results[1].ok, false)
  assert.equal(partial.results[1].code, 'ticket_executor_mismatch')
  assert.equal(fixture.prompts.length, before + 1)
  assert.equal(fixture.concluded, 0)
  const partialNote = fixture.service.outbox.entries.find(entry => entry.kind === 'dispatch_note' && entry.payload.ticketId === probe.ticket.ticketId)
  assert.ok(partialNote, 'accepted partial dispatch must retain a user-visible confirmation')
  assert.match(partialNote.payload.note, /Worker One/)
  assert.match(partialNote.payload.note, /未投递的目标：session-no-image/)
  assert.deepEqual(partial.results[0].requestId, fixture.prompts.at(-1).requestId)

  fixture.resetConcluded()
  const sent = await fixture.call('ria_request', { targetSessionIds: ['session-worker'], message: 'please inspect', attachments: [imagePath], ticketId: probe.ticket.ticketId, note: '把截图交给 Worker One 检查。' })
  assert.equal(sent.results[0].ok, true)
  assert.equal(fixture.concluded, 1)
  const prompt = fixture.prompts.at(-1)
  assert.equal(prompt.content.length, 2)
  assert.deepEqual(prompt.content[0], { type: 'text', text: 'please inspect' })
  assert.equal(prompt.content[1].type, 'image')
  assert.equal(prompt.content[1].mediaType, 'image/png')
  assert.equal(prompt.content[1].name, 'shot.png')
  assert.equal(prompt.content[1].data, png.toString('base64'))

  fixture.resetConcluded()
  const imageOnly = await fixture.call('ria_request', { targetSessionIds: ['session-worker'], attachments: [imagePath], ticketId: probe.ticket.ticketId, note: '把截图交给 Worker One 检查。' })
  assert.equal(imageOnly.results[0].ok, true)
  const onlyPrompt = fixture.prompts.at(-1)
  assert.equal(onlyPrompt.content.length, 1)
  assert.equal(onlyPrompt.content[0].type, 'image')
  assert.equal(fixture.concluded, 1)
} finally {
  fixture.cleanup()
}

console.log('attachments ok')
