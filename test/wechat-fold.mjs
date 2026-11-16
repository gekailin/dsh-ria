import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Outbox, WECHAT_ASSISTANT_NOTE_KIND } from '../lib/outbox.mjs'
import { createFixture } from './support/ria-fixture.mjs'

const tick = () => new Promise(resolve => setImmediate(resolve))

// A resume is anchored on the newest real human message, not on the resume
// clock. Channel-visible entries at or before that message are retired without
// a send or a summary banner. Later entries are re-armed in event-time order so
// assistant text and dispatch/approval cards keep their original interleaving.
{
  const dir = mkdtempSync(join(tmpdir(), 'dsh-ria-resume-'))
  const file = join(dir, 'outbox.json')
  let clock = 1_000_000
  try {
    const box = new Outbox(file, { now: () => clock })
    const anchor = 1_000_000
    const at = 1_050_000
    const enqueue = (kind, dedupeKey, payload, eventAt) => box.enqueue({ kind, dedupeKey, payload, eventAt }).entry

    const oldDispatch = enqueue('wechat_dispatch_note', 'old-dispatch', { note: 'old card' }, anchor - 2_000)
    const oldApproval = enqueue('wechat_approval_note', 'old-approval', { note: 'old allow?' }, anchor - 1_000)
    const oldPause = enqueue('wechat_pause_notice', 'old-pause', { text: 'old pause' }, anchor - 500)
    const oldChannelPause = enqueue('channel_pause_notice', 'old-channel-pause', { text: 'old channel pause' }, anchor)
    const oldAssistant = enqueue(WECHAT_ASSISTANT_NOTE_KIND, 'old-assistant', { text: 'old reply' }, anchor - 100)
    // Legacy fold banners are always retired; the feature that produced them is gone.
    const oldFold = enqueue('wechat_fold_notice', 'old-fold', { count: 3, text: 'folded' }, anchor + 9_000)
    // Internal signals and queued files are not phone-visible backlog.
    const internal = enqueue('dispatch_note', 'internal-card', { note: 'Ria card' }, anchor - 1_500)
    const fileSend = enqueue('channel_file_send', 'file-send', { path: '/tmp/report.md' }, anchor - 1_200)

    const firstAssistant = enqueue(WECHAT_ASSISTANT_NOTE_KIND, 'assistant-1', { text: 'first reply' }, anchor + 100)
    const duplicate = box.enqueue({
      kind: WECHAT_ASSISTANT_NOTE_KIND,
      dedupeKey: 'assistant-1',
      payload: { text: 'first reply' },
      eventAt: anchor + 100,
    })
    assert.equal(duplicate.created, false, 'the same logical assistant note is enqueued once')
    assert.equal(duplicate.entry.id, firstAssistant.id)
    const secondAssistant = enqueue(WECHAT_ASSISTANT_NOTE_KIND, 'assistant-2', { text: 'second reply' }, anchor + 400)
    const approval = enqueue('wechat_approval_note', 'approval', { note: 'allow?' }, anchor + 700)
    const dispatch = enqueue('wechat_dispatch_note', 'dispatch', { note: 'card' }, anchor + 1_000)

    const result = box.resumeChannelBacklog(anchor, at)
    assert.deepEqual(result, { suppressed: 6, replay: 4 })
    assert.deepEqual(box.outboxStats(), { folded: 0, lastFoldedAt: null }, 'resume must not create fold counters')
    assert.equal(box.summary().folded, 0)

    for (const entry of [oldDispatch, oldApproval, oldPause, oldChannelPause, oldAssistant, oldFold]) {
      const stored = box.entry(entry.id)
      assert.equal(stored.status, 'delivered')
      assert.equal(stored.deliveredAt, at)
      assert.equal(stored.suppressedBy, 'resume')
      assert.equal(stored.suppressedAt, at)
      assert.equal(stored.replayOrder, undefined)
      assert.equal(stored.folded, undefined)
    }
    assert.equal(box.entry(internal.id).status, 'pending', 'internal dispatch cards keep their retry path')
    assert.equal(box.entry(fileSend.id).status, 'pending', 'queued files must not be suppressed')
    assert.equal(box.entry(oldFold.id).suppressedBy, 'resume', 'old fold banners never replay')

    const replayed = box.due(at).filter(entry => Number.isFinite(entry.replayOrder))
    assert.deepEqual(replayed.map(entry => entry.id), [firstAssistant.id, secondAssistant.id, approval.id, dispatch.id])
    assert.deepEqual(replayed.map(entry => entry.replayOrder), [1, 2, 3, 4])
    assert.equal(replayed[0].payload.text, 'first reply')
    assert.equal(replayed[1].payload.text, 'second reply')
    assert.equal(replayed[2].payload.note, 'allow?')
    assert.equal(replayed[3].payload.note, 'card')
    assert.equal(box.all().filter(entry => entry.kind === 'wechat_fold_notice').length, 1, 'resume adds no summary entry')

    const reloaded = new Outbox(file, { now: () => clock })
    assert.equal(reloaded.entry(oldDispatch.id).suppressedBy, 'resume')
    assert.equal(reloaded.entry(firstAssistant.id).eventAt, anchor + 100)
    assert.equal(reloaded.entry(firstAssistant.id).replayOrder, 1)
    assert.deepEqual(
      reloaded.due(at).filter(entry => Number.isFinite(entry.replayOrder)).map(entry => entry.id),
      [firstAssistant.id, secondAssistant.id, approval.id, dispatch.id],
      'event-time replay order survives a restart',
    )

    for (const entry of [firstAssistant, secondAssistant, approval, dispatch]) reloaded.markDelivered(entry.id, at + 1)
    assert.deepEqual(reloaded.resumeChannelBacklog(anchor, at + 2), { suppressed: 0, replay: 0 })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// The service reads the anchor from RiaStore, which is updated by a real user
// message on any channel. Host-injected notices do not move it. The replay sends
// assistant text and notification cards in causal order and never a fold banner.
{
  const fixture = await createFixture()
  const service = fixture.service
  const sends = []
  const anchor = Date.now() - 60_000
  const riaId = service.store.riaSessionId
  assert.ok(riaId)
  const originalAssistant = service.wechatClaw.sendAssistantNote
  const originalRecovery = service.wechat.sendRecoveryNotice
  service.wechat.session = { client: {}, abort: new AbortController() }
  service.wechat.outbound = {}
  service.wechat.lastInboundAt = anchor
  service.wechat.sendDispatchNote = async (note) => { sends.push({ kind: 'dispatch', note }); return true }
  service.wechat.sendApprovalNote = async (note) => { sends.push({ kind: 'approval', note }); return true }
  service.wechat.sendRecoveryNotice = async (text) => { sends.push({ kind: 'recovery', text }); return true }
  service.wechatClaw.peer = { userId: 'user-1', contextToken: 'token-1' }
  service.wechatClaw.lastInboundAt = anchor
  try {
    service.onSessionEvent(
      { header: { id: riaId } },
      { type: 'user/message', data: { source: { kind: 'user', rpcId: 'web_req_1' }, time: anchor, content: [] } },
    )
    assert.equal(service.store.lastHumanMessageAt, anchor)

    service.onSessionEvent(
      { header: { id: riaId } },
      { type: 'user/message', data: { source: { kind: 'user', rpcId: 'host_startup_1' }, time: anchor + 30_000, content: [] } },
    )
    assert.equal(service.store.lastHumanMessageAt, anchor, 'host-injected notices must not move the anchor')
    service.onSessionEvent(
      { header: { id: riaId } },
      { type: 'user/message', data: { source: { kind: 'schedule', rpcId: 'schedule_1' }, time: anchor + 40_000, content: [] } },
    )
    assert.equal(service.store.lastHumanMessageAt, anchor, 'non-user sources must not move the anchor')

    // A real assistant reply recorded by the Claw channel keeps its event time
    // even when delivery fails and the note is queued for later.
    const assistantAt = anchor + 300
    service.wechatClaw.sendAssistantNote = async () => ({ deferred: true })
    service.wechatClaw.recordAssistantForward('paused', 'claw reply', { seq: 42, time: assistantAt })
    await service.pumpOutbox('test-record-assistant')
    await tick()
    const assistantEntry = service.outbox.all().find(entry => entry.kind === WECHAT_ASSISTANT_NOTE_KIND && entry.payload.eventSeq === 42)
    assert.ok(assistantEntry)
    assert.equal(assistantEntry.status, 'pending')
    assert.equal(assistantEntry.eventAt, assistantAt)
    assert.equal(assistantEntry.payload.eventAt, assistantAt)
    service.wechatClaw.sendAssistantNote = async (text, options) => {
      sends.push({ kind: 'assistant', text, options })
      return true
    }

    const oldDispatch = service.outbox.enqueue({
      kind: 'wechat_dispatch_note', dedupeKey: 'old-dispatch', payload: { note: 'old card' }, eventAt: anchor - 2_000,
    }).entry
    const oldAssistant = service.outbox.enqueue({
      kind: WECHAT_ASSISTANT_NOTE_KIND, dedupeKey: 'old-assistant', payload: { text: 'old reply' }, eventAt: anchor - 100,
    }).entry
    const oldChannelPause = service.outbox.enqueue({
      kind: 'channel_pause_notice', dedupeKey: 'old-channel-pause', payload: { channel: 'wechat', text: 'old pause' }, eventAt: anchor - 500,
    }).entry
    const legacyFold = service.outbox.enqueue({
      kind: 'wechat_fold_notice', dedupeKey: 'legacy-fold', payload: { count: 2, text: 'folded' }, eventAt: anchor + 9_000,
    }).entry
    const newApproval = service.outbox.enqueue({
      kind: 'wechat_approval_note', dedupeKey: 'new-approval', payload: { note: 'allow?' }, eventAt: anchor + 700,
    }).entry
    const newDispatch = service.outbox.enqueue({
      kind: 'wechat_dispatch_note', dedupeKey: 'new-dispatch', payload: { note: 'card' }, eventAt: anchor + 1_000,
    })
    assert.equal(newDispatch.created, true)
    const duplicate = service.outbox.enqueue({
      kind: 'wechat_dispatch_note', dedupeKey: 'new-dispatch', payload: { note: 'card' }, eventAt: anchor + 1_000,
    })
    assert.equal(duplicate.created, false)

    const result = service.handleWechatResume({ id: 'wechat' })
    assert.deepEqual(result, { suppressed: 4, replay: 3 })
    await service.pumpOutbox('test-resume')
    await tick()

    assert.deepEqual(sends.map(item => item.kind + ':' + (item.text || item.note)), [
      'assistant:claw reply',
      'approval:allow?',
      'dispatch:card',
    ])
    assert.equal(sends.some(item => item.kind === 'recovery'), false, 'no fold banner is sent')
    assert.equal(assistantEntry.status, 'delivered')
    for (const entry of [oldDispatch, oldAssistant, oldChannelPause, legacyFold]) {
      assert.equal(service.outbox.entry(entry.id).status, 'delivered')
      assert.equal(service.outbox.entry(entry.id).suppressedBy, 'resume')
    }
    assert.equal(service.outbox.entry(newApproval.id).status, 'delivered')
    assert.equal(service.outbox.entry(newDispatch.entry.id).status, 'delivered')
    assert.equal(service.outbox.all().filter(entry => entry.kind === 'wechat_fold_notice').length, 1)

    assert.deepEqual(service.handleWechatResume({ id: 'wechat' }), { suppressed: 0, replay: 0 })
    await service.pumpOutbox('test-resume-again')
    await tick()
    assert.equal(sends.length, 3, 'an empty backlog stays silent')
  } finally {
    service.wechatClaw.sendAssistantNote = originalAssistant
    service.wechat.sendRecoveryNotice = originalRecovery
    fixture.cleanup()
  }
}

console.log('wechat-fold ok')
