import assert from 'node:assert/strict'
import { createFixture } from './support/ria-fixture.mjs'

const queued = [
  { id: 'item-queued', placement: 'queued', content: [{ type: 'text', text: '  第一行\n第二行  ' }] },
  { id: 'item-steering', placement: 'steering', rpcId: 'req_steer', content: [{ type: 'text', text: '当前轮插播' }, { type: 'image', mediaType: 'image/png', data: 'AAAA' }] },
  { id: 'item-context', placement: 'context', content: [{ type: 'text', text: '上下文' }] },
]
const fixture = await createFixture({ queues: { 'session-worker': queued } })
try {
  const listed = await fixture.call('ria_queue', { action: 'list', sessionId: 'session-worker' })
  assert.equal(listed.ok, true)
  assert.equal(listed.sessionId, 'session-worker')
  assert.equal(listed.running, true)
  assert.equal(listed.queue.length, 3)
  assert.deepEqual(listed.queue[0], { id: 'item-queued', placement: 'queued', preview: '第一行 第二行' })
  assert.deepEqual(listed.queue[1], { id: 'item-steering', placement: 'steering', rpcId: 'req_steer', preview: '当前轮插播 [image]' })
  assert.deepEqual(listed.queue[2], { id: 'item-context', placement: 'context', preview: '上下文' })

  const read = await fixture.call('ria_read', { sessionId: 'session-worker' })
  assert.equal(read.live, true)
  assert.deepEqual(read.queue, listed.queue)

  const both = await fixture.call('ria_queue', { action: 'remove', sessionId: 'session-worker', itemId: 'item-context', rpcId: 'req_steer' })
  assert.equal(both.ok, true)
  assert.deepEqual(both.removed, { id: 'item-context', placement: 'context', preview: '上下文' })
  assert.deepEqual(fixture.updateQueueCalls.at(-1), { sessionId: 'session-worker', itemId: 'item-context', action: { kind: 'remove' } })
  assert.deepEqual(fixture.queues.get('session-worker').map(item => item.id), ['item-queued', 'item-steering'])

  const removedByItem = await fixture.call('ria_queue', { action: 'remove', sessionId: 'session-worker', itemId: 'item-queued' })
  assert.equal(removedByItem.ok, true)
  assert.deepEqual(removedByItem.removed, { id: 'item-queued', placement: 'queued', preview: '第一行 第二行' })
  assert.equal(fixture.updateQueueCalls.at(-1).itemId, 'item-queued')

  const removedByRpc = await fixture.call('ria_queue', { action: 'remove', sessionId: 'session-worker', rpcId: 'req_steer' })
  assert.equal(removedByRpc.ok, true)
  assert.deepEqual(removedByRpc.removed, { id: 'item-steering', placement: 'steering', preview: '当前轮插播 [image]' })
  assert.equal(fixture.updateQueueCalls.at(-1).itemId, 'item-steering')

  const callsBeforeMissing = fixture.updateQueueCalls.length
  const missingItem = await fixture.call('ria_queue', { action: 'remove', sessionId: 'session-worker', itemId: 'item-nope' })
  assert.deepEqual([missingItem.ok, missingItem.code], [false, 'queue_item_not_found'])
  assert.match(missingItem.message, /item-nope/)
  const missingRpc = await fixture.call('ria_queue', { action: 'remove', sessionId: 'session-worker', rpcId: 'req_nope' })
  assert.deepEqual([missingRpc.ok, missingRpc.code], [false, 'queue_item_not_found'])
  assert.match(missingRpc.message, /req_nope/)
  assert.equal(fixture.updateQueueCalls.length, callsBeforeMissing)

  const absent = await fixture.call('ria_queue', { action: 'list', sessionId: 'session-missing' })
  assert.deepEqual([absent.ok, absent.code], [false, 'session_missing'])
  const self = await fixture.call('ria_queue', { action: 'list', sessionId: fixture.riaAgent.id })
  assert.deepEqual([self.ok, self.code], [false, 'not_top_level'])
  const subagent = await fixture.call('ria_queue', { action: 'list', sessionId: 'session-subagent' })
  assert.deepEqual([subagent.ok, subagent.code], [false, 'not_top_level'])

  const cold = await fixture.call('ria_queue', { action: 'list', sessionId: 'session-no-image' })
  assert.equal(cold.ok, true)
  assert.equal(cold.running, false)
  assert.equal(cold.queue, null)
  const coldRead = await fixture.call('ria_read', { sessionId: 'session-no-image' })
  assert.equal(coldRead.queue, null)
} finally {
  fixture.cleanup()
}

const archived = await createFixture({ archivedSessionIds: ['session-worker'], queues: { 'session-worker': queued } })
try {
  const result = await archived.call('ria_queue', { action: 'list', sessionId: 'session-worker' })
  assert.deepEqual([result.ok, result.code], [false, 'session_archived'])
  assert.equal(archived.updateQueueCalls.length, 0)
} finally {
  archived.cleanup()
}

const failing = await createFixture({ queues: { 'session-worker': queued }, failUpdateQueue: new Error('queue backend down') })
try {
  const result = await failing.call('ria_queue', { action: 'remove', sessionId: 'session-worker', itemId: 'item-queued' })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'queue_remove_failed')
  assert.match(result.message, /queue backend down/)
  assert.equal(failing.queues.get('session-worker').length, 3)
} finally {
  failing.cleanup()
}

const raced = await createFixture({
  queues: { 'session-worker': queued },
  failUpdateQueue: Object.assign(new Error('queued item is no longer pending'), { code: 'session/queue-item-not-found' }),
})
try {
  const result = await raced.call('ria_queue', { action: 'remove', sessionId: 'session-worker', itemId: 'item-queued' })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'queue_item_not_found')
} finally {
  raced.cleanup()
}
