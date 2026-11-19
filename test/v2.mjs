import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFixture } from './support/ria-fixture.mjs'

const independentCwd = mkdtempSync(join(tmpdir(), 'ria-independent-'))
const fixture = await createFixture({
  v2Default: true,
  rejectDuplicateTools: true,
  extraSessions: [
    { sessionId: 'session-independent', running: false, blank: false, updatedAt: 10, cwd: independentCwd, projections: { values: { title: 'Alpha Session' } } },
    { sessionId: 'session-busy', running: true, blank: false, updatedAt: 9, cwd: independentCwd, projections: { values: { title: 'Busy Session' } } },
    // Dormant sessions have no live agent until the next prompt; they must stay
    // visible instead of disappearing after a Host restart.
    { sessionId: 'session-dormant', running: false, blank: false, agentAvailable: false, updatedAt: 8, cwd: independentCwd, projections: { values: { title: 'Alpha Dormant' } } },
    // Sessions parked on a pending approval, question or forwarded request: the
    // list projection still says "idle", the state read is what knows better.
    { sessionId: 'session-pending-approval', running: true, blank: false, updatedAt: 7, cwd: independentCwd, projections: { values: { title: 'Pending Approval' } } },
    { sessionId: 'session-pending-question', running: true, blank: false, updatedAt: 6, cwd: independentCwd, projections: { values: { title: 'Pending Question' } } },
    { sessionId: 'session-pending-other', running: true, blank: false, updatedAt: 5, cwd: independentCwd, projections: { values: { title: 'Pending Other' } } },
    { sessionId: 'session-idle', running: false, blank: false, updatedAt: 4, cwd: independentCwd, projections: { values: { title: 'Idle Session' } } },
    { sessionId: 'session-input-required', running: false, blank: false, updatedAt: 3, cwd: independentCwd, projections: { values: { title: 'Input Required' } } },
  ],
  pendingInputs: {
    'session-pending-approval': ['approval'],
    'session-pending-question': ['question'],
    'session-pending-other': ['other'],
  },
  onWait: async request => request.sessionId === 'session-input-required'
    ? {
      reason: 'input-required',
      state: { cursor: 10, active: true, running: true, queue: null, pendingInput: ['question'] },
      output: { records: [], truncated: false },
    }
    : undefined,
  waitRecords: {
    'session-independent': [
      { type: 'event', event: { type: 'assistant/message', seq: 7, time: 2, data: { message: { content: [{ type: 'text', text: 'Alpha here, all good.' }] } } } },
    ],
  },
  sessionEvents: {
    'session-independent': [
      { type: 'event', event: { type: 'user/message', seq: 5, time: 1, data: { content: [{ type: 'text', text: 'status?' }] } } },
      { type: 'event', event: { type: 'assistant/message', seq: 7, time: 2, data: { message: { content: [{ type: 'text', text: 'Alpha here, all good.' }] } } } },
    ],
  },
})
fixture.setRunning('session-busy', true)
for (const id of ['session-pending-approval', 'session-pending-question', 'session-pending-other']) fixture.setRunning(id, true)
try {
  const ensured = await fixture.service.ensure()
  const chatbot = fixture.service.v2.v2.chatbotSessionId
  assert.equal(ensured.sessionId, chatbot)
  assert.deepEqual(fixture.visibleTools(chatbot).sort(), ['chatbot_direct', 'chatbot_grant', 'chatbot_models', 'chatbot_new_session', 'chatbot_propose', 'chatbot_read', 'chatbot_request', 'chatbot_resume', 'chatbot_send_image', 'chatbot_sessions', 'chatbot_status', 'chatbot_steer', 'chatbot_stop_ticket', 'chatbot_talk', 'chatbot_watch', 'chatbot_worker_config'])
  // WeChat Claw resolves its peer session through these two callbacks. In v2
  // they must point at the Chatbot, not at the retired legacy manager.
  assert.equal(fixture.service.wechatClaw.getRiaId(), chatbot)
  assert.equal(await fixture.service.wechatClaw.ensureRia(), chatbot)
  assert.equal(fixture.service.v2.status().lastError, null)

  // Ordinary independent sessions can be listed and addressed by the Chatbot.
  // Managed Workers and the Chatbot itself stay out of this channel.
  const listed = await fixture.callAs(chatbot, 'chatbot_sessions', { query: 'Alpha' })
  if (!listed.ok) console.error('LISTED', listed)
  assert.equal(listed.ok, true)
  assert.equal(listed.sessions.length, 2)
  assert.equal(listed.sessions[0].sessionId, 'session-independent')
  assert.equal(listed.sessions[0].title, 'Alpha Session')
  assert.equal(listed.sessions[1].sessionId, 'session-dormant')
  assert.equal(listed.sessions[1].title, 'Alpha Dormant')
  const selfTalk = await fixture.callAs(chatbot, 'chatbot_talk', { sessionId: chatbot, message: 'hello' })
  assert.equal(selfTalk.code, 'session_not_independent')
  const busyTalk = await fixture.callAs(chatbot, 'chatbot_talk', { sessionId: 'session-busy', message: 'hello' })
  assert.equal(busyTalk.code, 'session_busy')
  const talk = await fixture.callAs(chatbot, 'chatbot_talk', { sessionId: 'session-independent', message: 'status?' })
  assert.equal(talk.ok, true)
  assert.equal(talk.reply, 'Alpha here, all good.')
  const sent = fixture.prompts.find(item => item.sessionId === 'session-independent' && item.content[0].text === 'status?')
  assert.ok(sent)
  assert.equal(sent.mode, 'queue')
  const read = await fixture.callAs(chatbot, 'chatbot_read', { sessionId: 'session-independent', afterSeq: 6 })
  assert.equal(read.ok, true)
  assert.deepEqual(read.messages.map(item => item.text), ['Alpha here, all good.'])
  assert.equal(read.cursor, 7)

  // A session that stopped for a human is not "idle": the Chatbot needs the
  // pending input kind to tell the user what it is waiting for.
  {
    const pending = await fixture.callAs(chatbot, 'chatbot_sessions', { query: 'Pending' })
    assert.equal(pending.ok, true)
    const byId = new Map(pending.sessions.map(item => [item.sessionId, item]))
    assert.deepEqual(byId.get('session-pending-approval').pendingInput, ['approval'])
    assert.equal(byId.get('session-pending-approval').running, true)
    assert.deepEqual(byId.get('session-pending-question').pendingInput, ['question'])
    assert.equal(byId.get('session-pending-question').running, true)
    assert.deepEqual(byId.get('session-pending-other').pendingInput, ['other'])
    assert.equal(byId.get('session-pending-other').running, true)
    const idle = await fixture.callAs(chatbot, 'chatbot_sessions', { query: 'Idle Session' })
    assert.equal(idle.sessions.length, 1)
    assert.equal(idle.sessions[0].running, false)
    assert.deepEqual(idle.sessions[0].pendingInput, [])
    const readPending = await fixture.callAs(chatbot, 'chatbot_read', { sessionId: 'session-pending-approval' })
    assert.equal(readPending.ok, true)
    assert.equal(readPending.running, true)
    assert.deepEqual(readPending.pendingInput, ['approval'])
    assert.equal(readPending.queue, null)
    assert.equal(readPending.queueLength, 0)
    const busyApproval = await fixture.callAs(chatbot, 'chatbot_talk', { sessionId: 'session-pending-approval', message: 'hello' })
    assert.equal(busyApproval.code, 'session_busy')
    assert.equal(busyApproval.running, true)
    assert.deepEqual(busyApproval.pendingInput, ['approval'])
    assert.match(busyApproval.message, /approval/)
    const busyQuestion = await fixture.callAs(chatbot, 'chatbot_talk', { sessionId: 'session-pending-question', message: 'hello' })
    assert.equal(busyQuestion.code, 'session_busy')
    assert.deepEqual(busyQuestion.pendingInput, ['question'])
    assert.match(busyQuestion.message, /question/)
    const busyOther = await fixture.callAs(chatbot, 'chatbot_talk', { sessionId: 'session-pending-other', message: 'hello' })
    assert.equal(busyOther.code, 'session_busy')
    assert.deepEqual(busyOther.pendingInput, ['other'])
    // input-required is a stop, not a timeout: the reply is pending and names
    // the request kind instead of pretending the turn is still running.
    const inputRequired = await fixture.callAs(chatbot, 'chatbot_talk', { sessionId: 'session-input-required', message: 'deploy now?' })
    assert.equal(inputRequired.ok, true)
    assert.equal(inputRequired.replied, false)
    assert.equal(inputRequired.pending, true)
    assert.equal(inputRequired.reason, 'input-required')
    assert.deepEqual(inputRequired.pendingInput, ['question'])
    assert.match(inputRequired.message, /waiting for a question answer/)
  }

  // Direct mode is a memory-only WeChat bypass: inbound text is steered into the
  // chosen independent session, and that session's assistant text is forwarded
  // back with a prefix. Commands are intercepted before Chatbot sees them.
  const directOn = await fixture.callAs(chatbot, 'chatbot_direct', { action: 'on', sessionId: 'session-independent' })
  assert.equal(directOn.ok, true)
  assert.equal(directOn.active, true)
  assert.equal(fixture.service.v2.status().direct.sessionId, 'session-independent')
  const directForwarded = []
  const directForward = fixture.service.wechatClaw.forwardAssistant
  fixture.service.wechatClaw.forwardAssistant = text => { directForwarded.push(text) }
  try {
    const beforeDirect = fixture.prompts.length
    await fixture.service.wechatClaw.deliverText('这条直接给 Alpha')
    const directPrompt = fixture.prompts.slice(beforeDirect).find(item => item.sessionId === 'session-independent')
    assert.ok(directPrompt)
    assert.equal(directPrompt.mode, 'steer')
    fixture.service.v2.onSessionEvent(
      { header: { id: 'session-independent' } },
      { type: 'assistant/message', data: { message: { content: [{ type: 'tool-call', name: 'run_code' }] } } },
    )
    fixture.service.v2.onSessionEvent(
      { header: { id: 'session-independent' } },
      { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '准备执行' }, { type: 'tool-call', name: 'run_code' }] } } },
    )
    assert.deepEqual(directForwarded, [])
    fixture.service.v2.onSessionEvent(
      { header: { id: 'session-independent' } },
      { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'Alpha 的直通回复' }] } } },
    )
    assert.deepEqual(directForwarded, ['【直通·Alpha Session】\nAlpha 的直通回复'])

    await fixture.service.wechatClaw.deliverText('/直通状态')
    assert.match(directForwarded.at(-1), /直通中：Alpha Session \(session-independent\)/)
    assert.match(directForwarded.at(-1), /切换目标：\/直通 <会话名>/)
    await fixture.service.wechatClaw.deliverText('/退出直通')
    assert.equal(fixture.service.v2.status().direct.active, false)
    assert.equal(directForwarded.at(-1), '已退出直通模式。')

    const beforeCommand = fixture.prompts.length
    await fixture.service.wechatClaw.deliverText('/直通 alphasession')
    assert.equal(fixture.service.v2.status().direct.active, true)
    assert.match(directForwarded.at(-1), /已进入直通模式：Alpha Session/)
    assert.match(directForwarded.at(-1), /切换目标：\/直通 <会话名>/)
    assert.equal(fixture.prompts.length, beforeCommand)
    const directOff = await fixture.callAs(chatbot, 'chatbot_direct', { action: 'off' })
    assert.equal(directOff.active, false)
  } finally {
    fixture.service.wechatClaw.forwardAssistant = directForward
  }

  // A restart notice goes to every channel that is connected. The controller
  // retries disconnected channels, but a connected one must be sent exactly once.
  {
    const notices = []
    const originals = []
    for (const name of ['wechatClaw', 'wechat', 'qqBot']) {
      const service = fixture.service[name]
      originals.push([service, service.statusView, service.sendPauseNotice])
      service.statusView = () => ({ loggedIn: true })
      service.sendPauseNotice = async text => { notices.push([name, text]); return name === 'wechatClaw' ? undefined : true }
    }
    try {
      fixture.service.v2.notifyRestart()
      await new Promise(resolve => setTimeout(resolve, 10))
      assert.deepEqual(notices.map(item => item[0]), ['wechatClaw', 'wechat', 'qqBot'])
      assert.equal(notices.length, 3)
      assert.match(notices[0][1], /Ria 已重启/)
    } finally {
      for (const [service, statusView, sendPauseNotice] of originals) {
        service.statusView = statusView
        service.sendPauseNotice = sendPauseNotice
      }
    }
  }

  // Inbound phone text reaches the Chatbot through the same prompt path, and a
  // committed Chatbot reply is what Claw forwards back to the phone.
  const beforeInbound = fixture.prompts.length
  await fixture.service.wechatClaw.deliverText('微信 Claw 联调消息')
  const inbound = fixture.prompts.slice(beforeInbound).find(item => item.sessionId === chatbot)
  assert.ok(inbound)
  assert.match(inbound.content[0].text, /微信 Claw 联调消息/)
  const forwarded = []
  const forward = fixture.service.wechatClaw.forwardAssistant
  fixture.service.wechatClaw.forwardAssistant = text => { forwarded.push(text) }
  try {
    fixture.service.wechatClaw.onSessionEvent(
      { header: { id: chatbot } },
      { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '收到' }] } } },
    )
  } finally {
    fixture.service.wechatClaw.forwardAssistant = forward
  }
  assert.deepEqual(forwarded, ['收到'])

  const created = await fixture.callAs(chatbot, 'chatbot_request', {
    goal: 'summarize the release notes',
    acceptance: 'one paragraph with links',
  })
  assert.equal(created.ok, true)
  assert.equal(created.status, 'open')
  assert.ok(created.ticketId)
  assert.equal(fixture.service.store.ticket(created.ticketId).status, 'open')
  assert.equal(fixture.service.store.ticket(created.ticketId).waitingOn, 'ria')

  const advisor = fixture.service.v2.v2.advisor('global').sessionId
  // Retrospective tools belong to reflection Workers, not the Advisor.
  assert.deepEqual(fixture.visibleTools(advisor).sort(), ['lesson_review', 'lesson_search', 'read', 'ticket_answer', 'ticket_block', 'ticket_dispatch', 'ticket_plan', 'ticket_read'])
  assert.equal(fixture.prompts.at(-1).sessionId, advisor)
  assert.match(fixture.prompts.at(-1).content[0].text, /Ticket brief/)

  await assert.rejects(
    fixture.callAs(chatbot, 'ticket_plan', { ticketId: created.ticketId, summary: 'nope' }),
    /tool not installed for .*: ticket_plan/,
  )

  const plan = await fixture.callAs(advisor, 'ticket_plan', {
    ticketId: created.ticketId,
    summary: 'read the notes and write a paragraph',
    steps: ['read notes', 'write paragraph'],
    artifacts: ['release-summary.md'],
  })
  assert.equal(plan.ok, true)

  const dispatch = await fixture.callAs(advisor, 'ticket_dispatch', { ticketId: created.ticketId })
  assert.equal(dispatch.ok, true)
  assert.ok(dispatch.workerSessionId)
  const working = fixture.service.store.ticket(created.ticketId)
  assert.equal(working.status, 'working')
  assert.equal(working.executor, dispatch.workerSessionId)
  assert.equal(working.attempt.legacy, false)

  const worker = dispatch.workerSessionId
  assert.deepEqual(fixture.visibleTools(worker).sort(), ['bash', 'edit', 'read', 'run_code', 'worker_checkpoint', 'worker_report', 'write'])
  const checkpoint = await fixture.callAs(worker, 'worker_checkpoint', { ticketId: created.ticketId })
  assert.equal(checkpoint.ok, true)
  assert.equal(checkpoint.ticket.status, 'working')
  assert.equal(checkpoint.workOrder.summary, 'read the notes and write a paragraph')
  assert.match(checkpoint.cwd, /workers$/)
  assert.match(checkpoint.artifactDir, /workers\/runs\//)

  // The Chatbot can change any top-level session's permissions on an explicit
  // user request, not just managed Workers. A pure downgrade is permanent: no
  // TTL, and neither ticket close nor a restart undoes it.
  const initialGrants = await fixture.callAs(chatbot, 'chatbot_grant', { action: 'list' })
  assert.equal(initialGrants.ok, true)
  assert.deepEqual(initialGrants.grants, [])
  const independentGrant = await fixture.callAs(chatbot, 'chatbot_grant', {
    action: 'set',
    sessionId: 'session-independent',
    sandboxMode: 'read-only',
    reason: 'the user asked to narrow an independent session',
  })
  assert.equal(independentGrant.ok, true)
  assert.equal(independentGrant.grant.sessionId, 'session-independent')
  assert.equal(independentGrant.grant.kind, 'permanent')
  assert.equal(independentGrant.grant.permanent, true)
  assert.equal(independentGrant.grant.expiresAt, null)
  const resetIndependent = await fixture.callAs(chatbot, 'chatbot_grant', { action: 'reset', grantId: independentGrant.grant.grantId })
  assert.equal(resetIndependent.ok, true)

  const granted = await fixture.callAs(chatbot, 'chatbot_grant', {
    action: 'set',
    sessionId: worker,
    ticketId: created.ticketId,
    sandboxMode: 'read-only',
    ttlSeconds: 60,
    reason: 'the user asked to test a narrower sandbox',
  })
  assert.equal(granted.ok, true)
  assert.equal(granted.grant.sessionId, worker)
  assert.equal(granted.grant.ticketId, created.ticketId)
  assert.equal(granted.grant.kind, 'permanent')
  assert.equal(granted.grant.expiresAt, null)
  const listedGrants = await fixture.callAs(chatbot, 'chatbot_grant', { action: 'list' })
  assert.equal(listedGrants.count, 1)
  const resetGrant = await fixture.callAs(chatbot, 'chatbot_grant', { action: 'reset', grantId: granted.grant.grantId })
  assert.equal(resetGrant.ok, true)
  assert.equal(resetGrant.restored, true)
  const afterReset = await fixture.callAs(chatbot, 'chatbot_grant', { action: 'list' })
  assert.deepEqual(afterReset.grants, [])

  const steer = await fixture.callAs(chatbot, 'chatbot_steer', {
    ticketId: created.ticketId,
    message: 'keep it under 120 words',
  })
  assert.equal(steer.ok, true)
  const afterSteer = await fixture.callAs(worker, 'worker_checkpoint', { ticketId: created.ticketId })
  // The Worker was idle, so chatbot_steer delivered directly and marked the
  // inbox entry delivered; checkpoint has nothing left to read.
  assert.deepEqual(afterSteer.messages, [])
  const repeated = await fixture.callAs(worker, 'worker_checkpoint', { ticketId: created.ticketId })
  assert.deepEqual(repeated.messages, [])

  const progress = await fixture.callAs(worker, 'worker_report', {
    ticketId: created.ticketId,
    status: 'progress',
    summary: 'notes read',
    next: 'write the paragraph',
  })
  assert.equal(progress.ok, true)
  assert.equal(fixture.service.store.ticket(created.ticketId).progress.lastPhase, 'notes read')

  const blockedReport = await fixture.callAs(worker, 'worker_report', {
    ticketId: created.ticketId,
    status: 'blocked',
    summary: 'need a format decision',
    question: 'Markdown or PDF?',
  })
  assert.equal(blockedReport.ok, true)
  assert.equal(fixture.service.store.ticket(created.ticketId).status, 'blocked')

  const resumed = await fixture.callAs(chatbot, 'chatbot_resume', {
    ticketId: created.ticketId,
    message: 'use Markdown',
  })
  assert.equal(resumed.ok, true)
  assert.equal(resumed.status, 'working')
  assert.equal(resumed.workerSessionId, worker)
  const afterResume = await fixture.callAs(worker, 'worker_checkpoint', { ticketId: created.ticketId })
  assert.deepEqual(afterResume.messages.map(item => item.message), ['use Markdown'])

  // A grant bound to a ticket must not outlive it. The next grant is still
  // active when the Worker reports done, so completion itself must restore it.
  const doneGrant = await fixture.callAs(chatbot, 'chatbot_grant', {
    action: 'set',
    sessionId: worker,
    ticketId: created.ticketId,
    approvalPolicy: 'never',
    ttlSeconds: 60,
    reason: 'the user asked to run without approval prompts for this ticket',
  })
  assert.equal(doneGrant.ok, true)

  const done = await fixture.callAs(worker, 'worker_report', {
    ticketId: created.ticketId,
    status: 'done',
    summary: 'summary written',
    evidence: ['release-summary.md'],
  })
  assert.equal(done.ok, true)
  const closed = fixture.service.store.ticket(created.ticketId)
  assert.equal(closed.status, 'done')
  assert.equal(closed.resolution.summary, 'summary written')
  assert.ok(fixture.prompts.some(item => item.sessionId === chatbot && /已完成/.test(item.content[0].text)))
  const afterDoneGrants = await fixture.callAs(chatbot, 'chatbot_grant', { action: 'list' })
  assert.deepEqual(afterDoneGrants.grants, [])

  const status = await fixture.callAs(chatbot, 'chatbot_status', { ticketId: created.ticketId })
  assert.equal(status.ok, true)
  assert.equal(status.ticket.status, 'done')

  // A real profile may announce agent/created before the PTC preset has mounted
  // its tools. The Advisor restriction must queue, then apply before the first
  // step instead of failing session creation.
  {
    const controller = fixture.service.v2
    const delayedId = 'session-delayed-advisor'
    const masks = []
    let mounted = false
    const delayed = {
      id: delayedId,
      ctx: {
        tools: {
          view(scope) {
            // Only a scoped view exposes preset tools; the unscoped global view
            // is empty. This is the bug that let an unrestricted Advisor run.
            const scoped = scope !== undefined && String(scope.id) === delayedId
            return { visible: new Map(), restrictableNames: mounted && scoped ? new Set(['read', 'grep', 'glob', 'bash']) : new Set() }
          },
          restrict(mask) { masks.push(mask) },
        },
      },
    }
    assert.equal(controller.restrictToReadOnly(delayed), false)
    assert.deepEqual(masks, [])
    controller.pendingRestrictions.set(delayedId, 'advisor')
    mounted = true
    await controller.onPreStep({ agent: delayed }, async () => ({ kind: 'enter' }))
    assert.deepEqual(masks, [{ allow: ['read', 'grep', 'glob'] }])
    assert.equal(controller.pendingRestrictions.has(delayedId), false)
  }

  // A request that names a project directory must give the Worker that cwd,
  // so its sandbox can actually edit the project instead of stateDir/workers.
  const workspace = mkdtempSync(join(tmpdir(), 'ria-v2-workspace-'))
  try {
    const refused = await fixture.callAs(chatbot, 'chatbot_request', {
      goal: 'try to escape',
      workspace: fixture.stateDir,
    })
    assert.equal(refused.ok, false)
    assert.equal(refused.code, 'workspace_overlaps_state')
    const project = await fixture.callAs(chatbot, 'chatbot_request', {
      goal: 'update the project README',
      acceptance: 'the README mentions the new endpoint',
      workspace,
    })
    assert.equal(project.ok, true)
    assert.equal(project.workspace, workspace)
    const projectAdvisor = fixture.service.v2.v2.ticketMeta(project.ticketId).advisorSessionId
    assert.ok(fixture.prompts.some(item => item.sessionId === projectAdvisor && item.content[0].text.includes('Workspace: ' + workspace)))
    await fixture.callAs(advisor, 'ticket_plan', {
      ticketId: project.ticketId,
      summary: 'edit README',
      steps: ['open README', 'add endpoint'],
    })
    const projectDispatch = await fixture.callAs(advisor, 'ticket_dispatch', { ticketId: project.ticketId })
    assert.equal(projectDispatch.ok, true)
    const projectCheckpoint = await fixture.callAs(projectDispatch.workerSessionId, 'worker_checkpoint', { ticketId: project.ticketId })
    assert.equal(projectCheckpoint.cwd, workspace)
    assert.equal(projectCheckpoint.artifactDir, join(workspace, 'ria-runs', projectDispatch.workerSessionId))
  } finally {
    rmSync(workspace, { recursive: true, force: true })
  }

  const blockedTicket = await fixture.callAs(chatbot, 'chatbot_request', { goal: 'needs a decision' })
  const blocked = await fixture.callAs(advisor, 'ticket_block', {
    ticketId: blockedTicket.ticketId,
    reason: 'choose a target format',
    question: 'PDF or Markdown?',
  })
  assert.equal(blocked.ok, true)
  assert.equal(fixture.service.store.ticket(blockedTicket.ticketId).status, 'blocked')
  assert.equal(fixture.service.store.ticket(blockedTicket.ticketId).attention.kind, 'question')
  const resumedAdvisor = await fixture.callAs(chatbot, 'chatbot_resume', {
    ticketId: blockedTicket.ticketId,
    message: 'use Markdown',
  })
  assert.equal(resumedAdvisor.ok, true)
  assert.equal(resumedAdvisor.status, 'open')
  assert.equal(fixture.service.store.ticket(blockedTicket.ticketId).status, 'open')
  const resumedAdvisorSession = fixture.service.v2.v2.ticketMeta(blockedTicket.ticketId).advisorSessionId
  assert.ok(fixture.prompts.some(item => item.sessionId === resumedAdvisorSession && /用户回复: use Markdown/.test(item.content[0].text)))

  // Stale direct-mode fallbacks (including “[tool run_code]”) must never be
  // replayed as a “补发” burst after a restart. Ordinary fallbacks stay.
  {
    const staleDirect = fixture.service.outbox.enqueue({
      kind: 'wechat_assistant_note',
      dedupeKey: 'stale-direct',
      payload: { text: '【直通·Alpha Session】\n[tool run_code]' },
    })
    const staleNormal = fixture.service.outbox.enqueue({
      kind: 'wechat_assistant_note',
      dedupeKey: 'stale-normal',
      payload: { text: 'a normal missed reply' },
    })
    const removed = fixture.service.v2.cleanupDirectBacklog()
    assert.ok(removed >= 1)
    assert.equal(fixture.service.outbox.entry(staleDirect.entry.id), undefined)
    assert.ok(fixture.service.outbox.entry(staleNormal.entry.id))
  }
} finally {
  fixture.cleanup()
  rmSync(independentCwd, { recursive: true, force: true })
}

// A restart must reuse the same Chatbot, restore role tools, and park work that
// was running when the process stopped instead of silently redispatching it.
const first = await createFixture({ v2: true })
const stateDir = first.stateDir
let workingTicketId
let workerId
try {
  const chatbot = first.service.v2.v2.chatbotSessionId
  const created = await first.callAs(chatbot, 'chatbot_request', { goal: 'long running task' })
  const advisor = first.service.v2.v2.advisor('global').sessionId
  await first.callAs(advisor, 'ticket_plan', { ticketId: created.ticketId, summary: 'do the work' })
  const dispatched = await first.callAs(advisor, 'ticket_dispatch', { ticketId: created.ticketId })
  workingTicketId = created.ticketId
  workerId = dispatched.workerSessionId
  assert.equal(first.service.store.ticket(workingTicketId).status, 'working')
} finally {
  first.cleanup({ keepState: true })
}

const second = await createFixture({ v2: true, stateDir })
try {
  const chatbot = second.service.v2.v2.chatbotSessionId
  assert.ok(chatbot)
  assert.equal(second.service.store.riaSessionId, chatbot)
  assert.deepEqual(second.visibleTools(chatbot).sort(), ['chatbot_direct', 'chatbot_grant', 'chatbot_models', 'chatbot_new_session', 'chatbot_propose', 'chatbot_read', 'chatbot_request', 'chatbot_resume', 'chatbot_send_image', 'chatbot_sessions', 'chatbot_status', 'chatbot_steer', 'chatbot_stop_ticket', 'chatbot_talk', 'chatbot_watch', 'chatbot_worker_config'])
  await second.service.startup()
  const parked = second.service.store.ticket(workingTicketId)
  assert.equal(parked.status, 'blocked')
  assert.equal(parked.waitingOn, 'environment')
  assert.match(parked.blockedReason, /重启/)
  assert.equal(second.service.v2.v2.worker(workerId).status, 'idle')
  const status = second.service.v2.status()
  assert.equal(status.chatbotSessionId, chatbot)
  assert.equal(status.lastError, null)
  assert.ok(status.tickets.some(item => item.ticketId === workingTicketId && item.status === 'blocked'))
  assert.ok(status.workers.some(item => item.sessionId === workerId && item.status === 'idle'))
} finally {
  second.cleanup()
  rmSync(stateDir, { recursive: true, force: true })
}

// A failed Chatbot install must leave a durable explanation and must not leave
// the channel-facing session id pointing at the half-installed session.
const errorDir = mkdtempSync(join(tmpdir(), 'dsh-ria-v2-error-'))
try {
  const { V2Store } = await import('../lib/v2/store.mjs')
  const store = new V2Store(errorDir)
  store.recordError('chatbot', new Error('install exploded'), { sessionId: 'session-bad', phase: 'create' })
  const reloaded = new V2Store(errorDir)
  assert.equal(reloaded.data.lastError.scope, 'chatbot')
  assert.equal(reloaded.data.lastError.message, 'install exploded')
  assert.equal(reloaded.data.lastError.sessionId, 'session-bad')
  assert.match(reloaded.data.lastError.stack, /install exploded/)
  reloaded.clearError('advisor')
  assert.ok(reloaded.data.lastError)
  reloaded.clearError('chatbot')
  assert.equal(reloaded.data.lastError, null)
} finally {
  rmSync(errorDir, { recursive: true, force: true })
}

console.log('v2 ok')
