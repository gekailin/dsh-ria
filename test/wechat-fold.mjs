import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Outbox } from '../lib/outbox.mjs'
import { createFixture } from './support/ria-fixture.mjs'

// The queue itself folds only old WeChat notifications, leaves unrelated and
// newer entries alone, persists the cumulative counters, and is idempotent.
{
  const dir = mkdtempSync(join(tmpdir(), 'dsh-ria-fold-'))
  const file = join(dir, 'outbox.json')
  let clock = 1_000_000
  try {
    const box = new Outbox(file, { now: () => clock })
    const oldDispatch = box.enqueue({ kind: 'wechat_dispatch_note', dedupeKey: 'old-dispatch', payload: { note: 'old' } }).entry
    const oldApproval = box.enqueue({ kind: 'wechat_approval_note', dedupeKey: 'old-approval', payload: { note: 'allow?' } }).entry
    const oldPause = box.enqueue({ kind: 'wechat_pause_notice', dedupeKey: 'old-pause', payload: { text: 'paused' } }).entry
    const oldSummary = box.enqueue({ kind: 'wechat_fold_notice', dedupeKey: 'old-summary', payload: { count: 1, text: 'folded' } }).entry
    const oldCard = box.enqueue({ kind: 'dispatch_note', dedupeKey: 'old-card', payload: { note: 'card' } }).entry
    clock = 1_010_000
    const newDispatch = box.enqueue({ kind: 'wechat_dispatch_note', dedupeKey: 'new-dispatch', payload: { note: 'new' } }).entry
    for (const entry of [oldDispatch, oldApproval, oldPause, oldSummary, oldCard]) entry.createdAt = 900_000

    const folded = box.foldOlderWechat(1_000_000, 1_020_000)
    assert.equal(folded, 3)
    for (const entry of [oldDispatch, oldApproval, oldPause]) {
      assert.equal(box.entry(entry.id).status, 'delivered')
      assert.equal(box.entry(entry.id).deliveredAt, 1_020_000)
      assert.equal(box.entry(entry.id).folded, true)
    }
    assert.equal(box.entry(oldSummary.id).status, 'pending', 'a fold summary must not be folded')
    assert.equal(box.entry(oldCard.id).status, 'pending', 'non-WeChat entries must not be folded')
    assert.equal(box.entry(newDispatch.id).status, 'pending', 'notifications after the cutoff must not be folded')
    assert.deepEqual(box.outboxStats(), { folded: 3, lastFoldedAt: 1_020_000 })
    assert.equal(box.summary().folded, 3)
    assert.equal(box.summary().lastFoldedAt, 1_020_000)
    assert.equal(box.foldOlderWechat(1_000_000, 1_030_000), 0, 'a second fold must not count the same entries')

    const reloaded = new Outbox(file, { now: () => clock })
    assert.deepEqual(reloaded.outboxStats(), { folded: 3, lastFoldedAt: 1_020_000 })
    assert.equal(reloaded.summary().folded, 3)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// Service integration: while paused, three notes pile up. Resuming folds them,
// sends exactly one summary and lets later notes through. The same path runs for
// an automatic resume.
{
  const fixture = await createFixture()
  const service = fixture.service
  const sends = []
  service.wechat.session = { client: {}, abort: new AbortController() }
  service.wechat.outbound = {}
  service.wechat.sendDispatchNote = async note => { sends.push({ kind: 'dispatch', note }); return true }
  service.wechat.sendApprovalNote = async note => { sends.push({ kind: 'approval', note }); return true }
  service.wechat.sendRecoveryNotice = async (text, options) => {
    sends.push({ kind: 'recovery', text, options })
    return true
  }
  try {
    service.wechat.setPaused(true, { by: 'manual', reason: 'test pause' })
    const queued = [
      service.outbox.enqueue({ kind: 'wechat_dispatch_note', dedupeKey: 'pause-1', payload: { note: 'one' } }).entry,
      service.outbox.enqueue({ kind: 'wechat_approval_note', dedupeKey: 'pause-2', payload: { note: 'two' } }).entry,
      service.outbox.enqueue({ kind: 'wechat_dispatch_note', dedupeKey: 'pause-3', payload: { note: 'three' } }).entry,
    ]
    for (const entry of queued) entry.createdAt = Date.now() - 2_000

    service.wechat.setPaused(false, { by: 'manual', reason: 'test resume' })
    await service.pumpOutbox('test-fold')
    await new Promise(resolve => setImmediate(resolve))

    assert.deepEqual(sends.filter(item => item.kind === 'dispatch' || item.kind === 'approval'), [])
    const summaries = sends.filter(item => item.kind === 'recovery')
    assert.equal(summaries.length, 1)
    assert.match(summaries[0].text, /恢复推送：刚才 3 条任务通知已折叠/)
    for (const entry of queued) assert.equal(service.outbox.entry(entry.id).status, 'delivered')
    const summaryEntry = service.outbox.all().find(entry => entry.kind === 'wechat_fold_notice')
    assert.ok(summaryEntry)
    assert.equal(summaryEntry.status, 'delivered')

    const status = service.wechat.statusView()
    assert.equal(status.folded, 3)
    assert.equal(typeof status.lastFoldedAt, 'number')
    const riaStatus = await fixture.call('ria_status', {})
    assert.equal(riaStatus.outbox.folded, 3)
    assert.equal(riaStatus.outbox.lastFoldedAt, status.lastFoldedAt)

    const after = service.outbox.enqueue({ kind: 'wechat_dispatch_note', dedupeKey: 'after-resume', payload: { note: 'after' } }).entry
    await service.pumpOutbox('after-resume')
    assert.equal(after.status, 'delivered')
    assert.deepEqual(sends.filter(item => item.kind === 'dispatch').map(item => item.note), ['after'])

    service.wechat.setPaused(true, { by: 'channel', reason: 'auto pause' })
    const autoQueued = service.outbox.enqueue({ kind: 'wechat_dispatch_note', dedupeKey: 'auto-pause', payload: { note: 'auto' } }).entry
    autoQueued.createdAt = Date.now() - 2_000
    service.wechat.lastInboundAt = Date.now()
    service.wechat.autoResume('微信消息')
    await service.pumpOutbox('test-auto-fold')
    await new Promise(resolve => setImmediate(resolve))

    assert.equal(autoQueued.status, 'delivered')
    assert.equal(service.outbox.outboxStats().folded, 4)
    assert.match(sends.filter(item => item.kind === 'recovery').at(-1).text, /刚才 1 条任务通知已折叠/)
    assert.equal(service.wechat.statusView().folded, 4)
  } finally {
    fixture.cleanup()
  }
}

console.log('wechat-fold ok')
