import assert from 'node:assert/strict'
import { formatStatusNotice, formatTicketRef } from '../lib/core/notifications.mjs'
import { chunk, protectChunkBoundary } from '../lib/wechat/outbound.mjs'
import { createFixture } from './support/ria-fixture.mjs'

// Every user-facing ticket notice must carry the COMPLETE ticket id, because the
// reader resumes the ticket from the notice alone. The short tail may appear
// only as a derived display form (formatTicketRef), and chunking must never cut
// an id in half.

/** The durable ticket id shape: ticket_<8>_<10 hex>. */
const FULL_ID = /^ticket_[0-9a-z]{8}_[0-9a-f]{10}$/
const ID_LIKE = /ticket_[0-9a-z_]+/g
const TICKET = 'ticket_mwye6o6z_e5521cce0e'

/** Every "ticket_…" run in the text must be a complete known id. */
function assertWholeIds(text, known, label) {
  for (const match of String(text).match(ID_LIKE) || []) {
    assert.ok(known.includes(match), label + ': found a truncated or unknown ticket id fragment ' + JSON.stringify(match))
    assert.match(match, FULL_ID)
  }
}

/** A notice never carries only the short tail: the full id must be present too. */
function assertCarriesFullId(text, id, label) {
  assert.ok(String(text).includes(id), label + ': full ticket id is missing from ' + JSON.stringify(text))
  assertWholeIds(text, [id], label)
}

// --- 1) The four status notices (done / blocked / failed / cancelled) ---------
for (const status of ['done', 'blocked', 'failed', 'cancelled']) {
  const notice = formatStatusNotice({
    ticketId: TICKET,
    status,
    summary: '已实现并提交（commit fb2f191，5 files +470/−2）',
    waitingOn: status === 'blocked' ? 'user' : undefined,
    reason: status === 'blocked' ? '等你确认是否部署' : undefined,
  })
  assert.equal(notice.ticketId, TICKET)
  assert.equal(notice.ref, '#1cce0e（' + TICKET + '）')
  assertCarriesFullId(notice.text, TICKET, status + ' notice')
  // The short tail is derived, never a separate input.
  assert.ok(notice.text.startsWith('#1cce0e（' + TICKET + '） ' + status + ' · '))
}

// A very long summary must lose summary text, never ticket identity.
{
  const notice = formatStatusNotice({ ticketId: TICKET, status: 'done', summary: '很长的摘要'.repeat(300) })
  assertCarriesFullId(notice.text, TICKET, 'long-summary notice')
  assert.ok([...notice.text].length <= 120, 'the cap still applies')
  assert.ok(notice.text.includes('…'), 'overflow is marked')
}

// Missing id stays harmless (no truncated fake).
assert.equal(formatTicketRef(''), '#------')
assert.equal(formatTicketRef(null), '#------')

// --- 2) Controller-rendered notices: approval and needs-your-decision --------
const fixture = await createFixture({ stateDefault: true })
try {
  const service = fixture.service
  const controller = service.controller
  const executor = 'session-ticket-id'
  const working = service.store.addTicket({ status: 'working', executor, goal: 'notice id work' })
  const ticket = service.store.addTicket({
    status: 'blocked',
    executor,
    waitingOn: 'user',
    blockedReason: '需要你决定：是否允许重启',
    goal: 'blocked notice id work',
  })

  // 需要你决定 (blocked.user edge) goes through blockedUserNoticeText.
  const needsYou = controller.renderTicketNotice(ticket, { edge: 'blocked.user', ticketId: ticket.ticketId })
  assertCarriesFullId(needsYou, ticket.ticketId, 'blocked.user notice')

  // 审批 (approval.asked edge) goes through formatStatusNotice.
  const approval = controller.renderTicketNotice(ticket, { edge: 'approval.asked', ticketId: ticket.ticketId, approvalId: 'approval_missing' })
  assertCarriesFullId(approval, ticket.ticketId, 'approval.asked notice')
  assert.match(approval, /waitingOn=approval/)

  // Session-level approval notice names the bound ticket with its full id.
  const notices = []
  controller.queueChatNotice = message => { notices.push(String(message)) }
  controller.notifySessionApproval(executor, { toolName: 'bash', reason: '需要写文件' })
  assert.equal(notices.length, 1)
  // The session-level notice names the ticket bound to the executor, with its
  // complete id (workingTicketFor() is the source).
  assertCarriesFullId(notices[0], working.ticketId, 'session approval notice')

  // Dedupe guard for the same approval key keeps one notice (repeated edges must
  // not spam), and the notice still carries the id.
  controller.notifySessionApproval(executor, { toolName: 'bash', reason: '需要写文件' })
  assert.equal(notices.length, 1)
} finally {
  fixture.cleanup()
}

// --- 3) Chunking never cuts an id -------------------------------------------
{
  const ids = [
    'ticket_aaaaaaaa_1111111111',
    'ticket_bbbbbbbb_2222222222',
    'ticket_cccccccc_3333333333',
  ]
  // Lay ids out so a naive 400-char cut would land inside each of them.
  // Uppercase filler keeps each lowercase ticket id a separate token.
  let body = 'X'.repeat(390) + ids[0] + 'Y'.repeat(20)
  body += 'Z'.repeat(395) + ids[1] + 'W'.repeat(30)
  body += 'V'.repeat(370) + ids[2] + 'U'.repeat(10)
  body += 'Q'.repeat(4000) // push the notice past 5000 chars
  const parts = chunk(body, 400, 100)
  assert.ok(parts.join('').length >= 5000, 'the sample really is a long notice')
  const seen = []
  for (const part of parts) {
    for (const match of part.match(ID_LIKE) || []) {
      assert.ok(ids.includes(match), 'chunk boundary split a ticket id: ' + JSON.stringify(match))
      seen.push(match)
    }
  }
  assert.deepEqual([...new Set(seen)].sort(), [...ids].sort(), 'every id survives intact')
  // The concatenation still carries the whole original text (no dropped ids).
  assert.ok(parts.join('').includes(ids[0]) && parts.join('').includes(ids[1]) && parts.join('').includes(ids[2]))
}

// Boundary helper behaviour: inside -> token start; outside -> unchanged.
{
  const text = 'HEAD ' + TICKET + ' TAIL'
  const start = text.indexOf(TICKET)
  assert.equal(protectChunkBoundary(text, start), start, 'a cut at the token start is already safe')
  assert.equal(protectChunkBoundary(text, start + 5), start, 'a cut inside the token moves to its start')
  assert.equal(protectChunkBoundary(text, start + TICKET.length), start + TICKET.length, 'a cut at the token end is safe')
  assert.equal(protectChunkBoundary(text, 3), 3, 'unrelated cuts are untouched')
  // A token that starts the remaining text is kept whole in this chunk.
  assert.equal(protectChunkBoundary(TICKET + ' TAIL', 10), TICKET.length)
}

// --- 4) No short-only notice form remains -----------------------------------
{
  const notice = formatStatusNotice({ ticketId: TICKET, status: 'done', summary: 'ok' })
  // The old shape "#1cce0e done · …" (short tail with nothing else) must not exist.
  assert.equal(/#[0-9a-f]{6} done · /.test(notice.text), false, 'short-only form is gone')
  assert.ok(notice.text.includes(TICKET))
}

console.log('notice ticket id ok')
