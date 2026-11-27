import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { KINDS, makeNotice, renderNotice, isNotice, formatTicketRef } from '../lib/core/notice.mjs'
import { Outbox, WECHAT_ASSISTANT_NOTE_KIND } from '../lib/outbox.mjs'
import { chunk, protectChunkBoundary } from '../lib/wechat/outbound.mjs'
import { createFixture } from './support/ria-fixture.mjs'

// One structured notice is the source of truth; every rendered string is derived
// from it. These tests pin each kind's shape and text, the JSON contract that
// lets outbox entries and router events persist the object, and the chunk
// boundary protection that keeps a complete ticket id readable.

const TID = 'ticket_mwyej1xv_8f61c09382'
const REF = formatTicketRef(TID)
const AT = 1795712400000

/** Walk a value and reject anything JSON cannot reproduce. */
function assertPureJson(value, path = 'notice') {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return
  if (typeof value === 'number') { assert.ok(Number.isFinite(value), path + ' finite'); return }
  assert.equal(typeof value, 'object', path + ' must be JSON-only, got ' + typeof value)
  assert.ok(!(value instanceof Date), path + ' must not be a Date')
  if (Array.isArray(value)) { value.forEach((item, index) => assertPureJson(item, path + '[' + index + ']')); return }
  assert.equal(Object.getPrototypeOf(value), Object.prototype, path + ' must be a plain object')
  for (const [key, item] of Object.entries(value)) assertPureJson(item, path + '.' + key)
}

/** Sample objects: one per kind (approval.followup / grant.* have variants). */
const samples = [
  { kind: 'ticket.working', ticketId: TID, status: 'working', summary: '正在处理' },
  { kind: 'ticket.done', ticketId: TID, status: 'done', summary: '已完成' },
  { kind: 'ticket.blocked', ticketId: TID, status: 'blocked', summary: '需要确认', waitingOn: 'user', reason: '等你确认是否部署' },
  { kind: 'ticket.failed', ticketId: TID, status: 'failed', summary: '执行失败' },
  { kind: 'ticket.cancelled', ticketId: TID, status: 'cancelled', summary: '已取消' },
  { kind: 'approval.requested', ticketId: TID, tool: 'bash', reason: '需要写文件', risk: 'medium', policy: 'ask', askedAt: AT },
  { kind: 'session.approval', sessionId: 'session-abc123', tool: 'bash', reason: '需要写文件', role: 'executor', ticketId: TID },
  { kind: 'decision.needed', ticketId: TID, question: '是否允许重启' },
  { kind: 'approval.followup', outcome: 'resumed', ticketId: TID },
  { kind: 'approval.followup', outcome: 'restore_failed', ticketId: TID, code: 'working_lost' },
  { kind: 'approval.followup', outcome: 'denied', ticketId: TID, label: '拒绝', message: '审批被拒绝（bash：危险）' },
  { kind: 'grant.auto_allowed', scope: 'global', level: 'low', who: 'ticket ' + TID, tool: 'bash', toolLabel: 'bash', what: 'npm test', risk: 'command', policy: 'auto-low', policySource: 'settings' },
  { kind: 'grant.auto_allowed', scope: 'watch', title: '众源重建', tool: 'bash', reasons: ['low risk'] },
  { kind: 'grant.applied', phase: 'settled', grantId: 'grant_1', items: [{ tool: 'bash', ticketId: TID }] },
  { kind: 'grant.applied', phase: 'unresolved', grantId: 'grant_2', items: [{ tool: 'write' }] },
  { kind: 'grant.reattached', ticketId: TID, executorId: 'session-exec-1', grantId: 'grant_3' },
  { kind: 'ticket.steer_undelivered', ticketId: TID, detail: '工单已取消' },
  { kind: 'ticket.stopped', ticketId: TID, mode: 'hard', bound: true, reason: '用户取消' },
  { kind: 'ticket.stopped', ticketId: TID, mode: 'soft', bound: true, reason: '用户取消' },
  { kind: 'ticket.stopped', ticketId: TID, mode: 'plain', bound: false, reason: '用户取消' },
  { kind: 'session.blocked_reminder', sessionId: 'session-abc123', waiting: 'approval', title: '修复 bug', tool: 'bash', reason: '需要写文件', elapsedSeconds: 12 },
  { kind: 'session.blocked_reminder', sessionId: 'session-abc123', waiting: 'question', title: '修复 bug', question: '选择方案' },
  { kind: 'session.abnormal_end', sessionId: 'session-53d5a8bd-1111', reason: '进程被终止' },
  { kind: 'relay.hint', report: true, ticketId: TID },
  { kind: 'relay.hint', report: false },
  { kind: 'restart', prevPid: 111, newPid: 222, reason: 'abnormal_exit', recoveredTickets: 2, startupMs: 1234 },
  { kind: 'reflection', summary: '今日 56 张工单' },
  { kind: 'channel.pause', channel: 'wechat', reason: '非微信通道消息' },
  { kind: 'channel.degraded', channel: 'wechat-claw', code: 'WECHAT_CLAW_PEER_REJECTED', ret: -2 },
]

// 1) Every kind is covered by a sample, and each sample is pure JSON + round-trips.
assert.deepEqual([...new Set(samples.map(s => s.kind))].sort(), [...KINDS].sort(), 'every kind has a sample')
for (const sample of samples) {
  const notice = makeNotice({ ...sample, at: AT })
  assertPureJson(notice)
  assert.equal(isNotice(notice), true)
  assert.deepEqual(JSON.parse(JSON.stringify(notice)), notice, 'JSON round-trip must be lossless: ' + sample.kind)
  assert.ok(Object.isFrozen(notice), 'notice is frozen')
}

// 2) Exact render per kind (variants included).
const render = sample => renderNotice(makeNotice({ ...sample, at: AT }))
assert.equal(render({ kind: 'ticket.working', ticketId: TID, status: 'working', summary: '正在处理' }), REF + ' working · 正在处理')
assert.equal(render({ kind: 'ticket.done', ticketId: TID, status: 'done', summary: '已完成' }), REF + ' done · 已完成')
assert.equal(render({ kind: 'ticket.blocked', ticketId: TID, status: 'blocked', summary: '需要确认', waitingOn: 'user', reason: '等你确认是否部署' }),
  REF + ' blocked · 需要确认\nblocked(waitingOn=user) · 等你确认是否部署')
assert.equal(render({ kind: 'ticket.failed', ticketId: TID, status: 'failed', summary: '执行失败' }), REF + ' failed · 执行失败')
assert.equal(render({ kind: 'ticket.cancelled', ticketId: TID, status: 'cancelled', summary: '已取消' }), REF + ' cancelled · 已取消')
assert.match(render({ kind: 'approval.requested', ticketId: TID, tool: 'bash', reason: '需要写文件', risk: 'medium', policy: 'ask', askedAt: AT }),
  new RegExp('^' + REF.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ' blocked · 待审批：bash\nblocked\\(waitingOn=approval\\) · 需要写文件 · 请求于 \\d{2}:\\d{2}:\\d{2} \\+08:00 · risk:medium · policy:ask$'))
assert.equal(render({ kind: 'session.approval', sessionId: 'session-abc123', tool: 'bash', reason: '需要写文件', role: 'executor', ticketId: TID }),
  '🔔 #session-abc123 等待审批：bash（需要写文件） · 受影响：ticket ' + TID)
assert.equal(render({ kind: 'decision.needed', ticketId: TID, question: '是否允许重启' }),
  '🔔 #工单 需要你决定：' + REF + ' · 是否允许重启')
assert.equal(render({ kind: 'approval.followup', outcome: 'resumed', ticketId: TID }), 'ticket ' + TID + ' 审批通过，已回到 working，Executor 继续执行。')
assert.equal(render({ kind: 'approval.followup', outcome: 'restore_failed', ticketId: TID, code: 'working_lost' }),
  'ticket ' + TID + ' 审批通过，但恢复到 working 失败（working_lost）；请用 ria_chat_resume 处理。')
assert.equal(render({ kind: 'approval.followup', outcome: 'denied', ticketId: TID, label: '拒绝', message: '审批被拒绝（bash：危险）' }),
  'ticket ' + TID + ' 审批被拒绝：审批被拒绝（bash：危险），工单停在 blocked(waitingOn=approval)，可用 ria_chat_resume 重试。')
assert.equal(render({ kind: 'grant.auto_allowed', scope: 'global', level: 'low', who: 'ticket ' + TID, tool: 'bash', toolLabel: 'bash', what: 'npm test', risk: 'command', policy: 'auto-low', policySource: 'settings' }),
  '已自动放行低风险提权：ticket ' + TID + ' 工具 bash「npm test」；判为 command（策略 auto-low，来源 settings）。')
assert.equal(render({ kind: 'grant.auto_allowed', scope: 'watch', title: '众源重建', tool: 'bash', reasons: ['low risk'] }),
  '【协管·众源重建】已自动放行低风险提权：工具 bash（原因：low risk）。')
assert.equal(render({ kind: 'grant.applied', phase: 'settled', grantId: 'grant_1', items: [{ tool: 'bash', ticketId: TID }] }),
  '授权已生效，并已放行此前挂起的请求（grantId grant_1）：工具 bash（ticket ' + TID + '）。')
assert.equal(render({ kind: 'grant.applied', phase: 'unresolved', grantId: 'grant_2', items: [{ tool: 'write' }] }),
  '授权已生效（grantId grant_2），但此前挂起的请求无法直接放行，请 Executor 重试或在必要时 resume：工具 write。')
assert.equal(render({ kind: 'grant.reattached', ticketId: TID, executorId: 'session-exec-1', grantId: 'grant_3' }),
  '本票授权已自动重新应用到新 executor session-exec-1（ticket ' + TID + '，grantId grant_3，原 TTL 不变）。')
assert.equal(render({ kind: 'ticket.steer_undelivered', ticketId: TID, detail: '工单已取消' }),
  '工单 ' + TID + ' 的 steer 未投递：工单已取消。已丢弃，不重开旧单，也不会串到其它工单。')
assert.equal(render({ kind: 'ticket.stopped', ticketId: TID, mode: 'hard', bound: true, reason: '用户取消' }),
  '⛔ 已立即停止：ticket ' + TID + ' 已取消，Executor 当前回合已中断。 原因：用户取消')
assert.equal(render({ kind: 'ticket.stopped', ticketId: TID, mode: 'soft', bound: true, reason: '用户取消' }),
  '⛔ 已请求停止，当前步骤结束后生效：ticket ' + TID + ' 已取消，Executor 会在下一步开始前收到终止说明并结束回合。 原因：用户取消')
assert.equal(render({ kind: 'ticket.stopped', ticketId: TID, mode: 'plain', bound: false, reason: '用户取消' }),
  '⛔ 已停止：ticket ' + TID + ' 已取消（没有绑定 Executor）。 原因：用户取消')
assert.equal(render({ kind: 'session.blocked_reminder', sessionId: 'session-abc123', waiting: 'approval', title: '修复 bug', tool: 'bash', reason: '需要写文件', elapsedSeconds: 12 }),
  '「修复 bug」在等审批：bash（需要写文件），本轮已运行 12s。去该会话处理，Ria 不代答。')
assert.equal(render({ kind: 'session.blocked_reminder', sessionId: 'session-abc123', waiting: 'question', title: '修复 bug', question: '选择方案' }),
  '「修复 bug」在等回答：选择方案。去该会话回答。')
assert.equal(render({ kind: 'session.abnormal_end', sessionId: 'session-53d5a8bd-1111', reason: '进程被终止' }), '🔔 #会话 异常结束：53d5a8 · 进程被终止')
assert.equal(render({ kind: 'relay.hint', report: true, ticketId: TID }), '（报告较长，已折叠；完整内容见工单 ' + TID + '）')
assert.equal(render({ kind: 'relay.hint', report: false }), '…（完整内容已记入会话记录）')
assert.equal(render({ kind: 'restart', prevPid: 111, newPid: 222, reason: 'abnormal_exit', recoveredTickets: 2, startupMs: 1234 }),
  '🔔 Ria 已重启（PID 111 → 222，异常退出） · 恢复工单 2 张 · 启动耗时 1.2 s')
assert.equal(render({ kind: 'reflection', summary: '今日 56 张工单' }), '🔔 定期反思：今日 56 张工单')
assert.equal(render({ kind: 'channel.pause', channel: 'wechat', reason: '非微信通道消息' }),
  '🌊 Ria 已自动暂停微信「文件传输助手」推送（原因：非微信通道消息）。回一条微信「文件传输助手」消息即可恢复；也可在 Ria 设置里关掉「自动暂停」。')
assert.equal(render({ kind: 'channel.degraded', channel: 'wechat-claw', code: 'WECHAT_CLAW_PEER_REJECTED', ret: -2 }),
  '🔇 通道降级：wechat-claw · WECHAT_CLAW_PEER_REJECTED（ret=-2）')

// 3) Invalid notices are rejected, never silently repaired.
assert.throws(() => makeNotice({ kind: 'nope' }), /unknown notice kind/)
assert.throws(() => makeNotice({ kind: 'ticket.done' }), /requires field ticketId/)
assert.throws(() => makeNotice({ kind: 'ticket.done', ticketId: TID, fn: () => 1 }), /not JSON-serializable|plain JSON/)
assert.throws(() => makeNotice({ kind: 'ticket.done', ticketId: TID, at: undefined, summary: undefined }), /undefined/)
assert.throws(() => makeNotice({ kind: 'ticket.done', ticketId: TID, when: new Date() }), /plain JSON object/)
assert.throws(() => makeNotice(null), /plain object/)
assert.equal(renderNotice({ kind: 'ticket.done', ticketId: TID, status: 'done', summary: 'x' }).includes(TID), true)

// 4) Long summary keeps the complete ticket id (head-preserving clamp).
{
  const long = makeNotice({ kind: 'ticket.done', ticketId: TID, status: 'done', summary: '很长的摘要'.repeat(300), at: AT })
  const text = renderNotice(long)
  assert.ok(text.includes(TID), 'a 1000+ char summary must not cut the ticket id')
  assert.ok([...text].length <= 120, 'the notice stays within its cap')
  assert.match(text, /…$/)
}

// 5) Chunking cannot split a rendered id; boundary protection stays effective.
{
  // Put the id exactly where a naive hard cut at 1800 would land.
  const body = 'X'.repeat(1790) + TID + 'Y'.repeat(6000)
  const parts = chunk(body, 1800, 4)
  for (const part of parts) {
    for (const found of part.match(/ticket_[0-9a-z_]+/g) || []) {
      assert.equal(found, TID, 'chunk boundary split the ticket id: ' + JSON.stringify(found))
    }
  }
  assert.equal(protectChunkBoundary(body, 1790), 1790, 'a cut at the token start is already safe')
  assert.equal(protectChunkBoundary(body, 1795), 1790, 'a cut inside the id moves to the token start')
  assert.equal(protectChunkBoundary(body, 1790 + TID.length), 1790 + TID.length, 'a cut at the token end is safe')
}

// 6) Outbox persists the notice OBJECT, not just rendered text.
{
  const dir = mkdtempSync(join(tmpdir(), 'ria-notice-outbox-'))
  try {
    const file = join(dir, 'outbox.json')
    const notice = makeNotice({ kind: 'channel.pause', channel: 'wechat', reason: 'channel switched' })
    const box = new Outbox(file)
    box.enqueue({ kind: WECHAT_ASSISTANT_NOTE_KIND, dedupeKey: 'notice-object', payload: { text: renderNotice(notice), notice, chars: 1 } })
    const reloaded = new Outbox(file)
    const entry = reloaded.all().at(-1)
    assert.deepEqual(entry.payload.notice, notice, 'the structured notice survives the outbox round-trip')
    assertPureJson(entry.payload.notice)
  } finally { rmSync(dir, { recursive: true, force: true }) }
}

// 7) A delivered ticket notice records the object on its router events.
{
  const fixture = await createFixture({ stateDefault: true })
  const tick = () => new Promise(resolve => setTimeout(resolve, 40))
  try {
    const controller = fixture.service.controller
    controller.notifyChat = async () => true
    controller.notifyClawStatus = async () => true
    const ticket = fixture.service.store.addTicket({
      status: 'blocked', waitingOn: 'user', executor: 'session-notice',
      blockedReason: '需要你拍板', attention: { kind: 'question', question: '需要你拍板' }, goal: 'notice event',
    })
    controller.state.addExecutor('session-notice', { status: 'idle', currentTicketId: null, cwd: '/tmp' })
    controller.onTicketTransition(ticket, { from: 'working', to: 'blocked', reason: 'executor needs the user' })
    await tick()
    const delivered = fixture.service.routerEvents.query({ types: ['notice.delivered'], limit: 20 }).events
      .find(item => item.ticketId === ticket.ticketId)
    assert.ok(delivered, 'notice.delivered is written')
    assert.equal(delivered.payload.notice.kind, 'decision.needed')
    assert.deepEqual(JSON.parse(JSON.stringify(delivered.payload.notice)), delivered.payload.notice)
    assert.equal(delivered.payload.notice.ticketId, ticket.ticketId)
  } finally { fixture.cleanup() }
}

console.log('notice schema ok')
