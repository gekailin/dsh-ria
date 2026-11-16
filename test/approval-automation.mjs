import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createFixture } from './support/ria-fixture.mjs'
import { approvalArgsPreview, classifyApproval } from '../lib/approval-policy.mjs'

const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

async function cacheArgs(fixture, agentId, toolName, args, callId) {
  const exec = { agent: { id: agentId }, callId, name: toolName, arguments: args }
  await fixture.emit('tools/pre-execute', exec, async () => ({ kind: 'allow' }))
}

function request(agentId, toolName, callId, reason = 'test request') {
  return {
    agent: { id: agentId },
    toolName,
    callId,
    reason,
    signal: new AbortController().signal,
  }
}

function addTicket(fixture, goal) {
  return fixture.service.store.addTicket({
    goal,
    acceptance: 'verified by approval-automation test',
    executor: 'session-worker',
    status: 'working',
  })
}

function auditEvents(fixture) {
  const file = join(fixture.stateDir, 'audit.jsonl')
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line))
    .filter(event => event.event === 'approval/decision')
}

async function withFixture(options, run) {
  const fixture = await createFixture(options)
  try {
    await run(fixture)
  } finally {
    fixture.cleanup()
  }
}

// Low risk is approved by the host rule itself: no wake, no block, no followup.
await withFixture({ approvalAutomation: true }, async fixture => {
  const ticket = addTicket(fixture, 'run the test suite')
  await cacheArgs(fixture, 'session-worker', 'bash', { command: 'npm test' }, 'call_low')
  let nextCalls = 0
  const result = await fixture.emit(
    'approval/request',
    request('session-worker', 'bash', 'call_low'),
    async () => { nextCalls += 1; return 'unavailable' },
  )
  assert.equal(result, 'allowed-once')
  assert.equal(nextCalls, 0)
  assert.equal(fixture.followups.length, 0)
  assert.equal(fixture.service.store.ticket(ticket.ticketId).status, 'working')
  const events = auditEvents(fixture)
  assert.equal(events.length, 1)
  assert.equal(events[0].actor, 'system')
  assert.equal(events[0].outcome, 'allowed-once')
  assert.equal(events[0].ticketId, ticket.ticketId)
})

// A hard-denied command is rejected without waking Ria and without a UI relay.
await withFixture({ approvalAutomation: true }, async fixture => {
  addTicket(fixture, 'remove everything')
  await cacheArgs(fixture, 'session-worker', 'bash', { command: 'rm -rf /' }, 'call_deny')
  let nextCalls = 0
  const result = await fixture.emit(
    'approval/request',
    request('session-worker', 'bash', 'call_deny', 'clean disk'),
    async () => { nextCalls += 1; return 'unavailable' },
  )
  assert.equal(result, 'rejected')
  assert.equal(nextCalls, 0)
  assert.equal(fixture.followups.length, 0)
  const events = auditEvents(fixture)
  assert.equal(events.length, 1)
  assert.equal(events[0].actor, 'system')
  assert.equal(events[0].decision, 'deny')
  assert.match(events[0].basis, /硬拒绝/)
})

// Medium risk wakes Ria, blocks the ticket, and accepts a Ria allow.
await withFixture({ approvalAutomation: true }, async fixture => {
  const ticket = addTicket(fixture, 'write a file in the workspace')
  const path = join(fixture.stateDir, 'note.txt')
  await cacheArgs(fixture, 'session-worker', 'write', { file_path: path, content: 'x' }, 'call_write')
  let nextCalls = 0
  const pending = fixture.emit(
    'approval/request',
    request('session-worker', 'write', 'call_write'),
    async () => { nextCalls += 1; return 'unavailable' },
  )
  await delay(20)
  assert.equal(fixture.followups.length, 1)
  assert.equal(fixture.followups[0].source.kind, 'ria-approval')
  assert.match(fixture.followups[0].content[0].text, /审批请求/)
  const blocked = fixture.service.store.ticket(ticket.ticketId)
  assert.equal(blocked.status, 'blocked')
  assert.equal(blocked.waitingOn, 'approval')
  const listed = await fixture.call('ria_approval', { action: 'list' })
  assert.equal(listed.count, 1)
  assert.equal(listed.pending[0].risk, 'medium')
  assert.equal(listed.pending[0].decisionBy, 'pending')
  const decision = await fixture.call('ria_approval_decision', {
    approvalId: listed.pending[0].approvalId,
    decision: 'allow',
    reason: 'inside the workspace and needed by the goal',
  })
  assert.equal(decision.ok, true)
  assert.equal(decision.decision, 'allow')
  assert.equal(await pending, 'allowed-once')
  assert.equal(nextCalls, 0)
  assert.equal(fixture.service.store.ticket(ticket.ticketId).status, 'working')
  const events = auditEvents(fixture)
  assert.equal(events.length, 1)
  assert.equal(events[0].actor, 'ria')
  assert.equal(events[0].outcome, 'allowed-once')
})

// ask-user relays to the host UI and records who finally answered.
await withFixture({ approvalAutomation: true }, async fixture => {
  addTicket(fixture, 'write a file with a user decision')
  const path = join(fixture.stateDir, 'note.txt')
  await cacheArgs(fixture, 'session-worker', 'write', { file_path: path, content: 'x' }, 'call_ask')
  let nextCalls = 0
  const pending = fixture.emit(
    'approval/request',
    request('session-worker', 'write', 'call_ask'),
    async () => { nextCalls += 1; return 'allowed-once' },
  )
  await delay(20)
  const listed = await fixture.call('ria_approval', { action: 'list' })
  const decision = await fixture.call('ria_approval_decision', {
    approvalId: listed.pending[0].approvalId,
    decision: 'ask-user',
    reason: 'user should decide',
  })
  assert.equal(decision.ok, true)
  assert.equal(await pending, 'allowed-once')
  assert.equal(nextCalls, 1)
  const events = auditEvents(fixture)
  assert.equal(events.at(-1).actor, 'user')
  assert.equal(events.at(-1).outcome, 'allowed-once')
})

// If there is no user approval surface, ask-user falls back to a rejection.
await withFixture({ approvalAutomation: true }, async fixture => {
  addTicket(fixture, 'relay to a missing user surface')
  const path = join(fixture.stateDir, 'note.txt')
  await cacheArgs(fixture, 'session-worker', 'write', { file_path: path, content: 'x' }, 'call_no_ui')
  const pending = fixture.emit(
    'approval/request',
    request('session-worker', 'write', 'call_no_ui'),
    async () => 'unavailable',
  )
  await delay(20)
  const listed = await fixture.call('ria_approval', { action: 'list' })
  const decision = await fixture.call('ria_approval_decision', {
    approvalId: listed.pending[0].approvalId,
    decision: 'ask-user',
  })
  assert.equal(decision.ok, true)
  assert.equal(await pending, 'rejected')
  const events = auditEvents(fixture)
  assert.equal(events.at(-1).actor, 'system')
  assert.equal(events.at(-1).outcome, 'rejected')
})

// If the user UI allows but the final audit cannot be written, fail closed.
await withFixture({ approvalAutomation: true }, async fixture => {
  addTicket(fixture, 'write a file with an unauditable user decision')
  const path = join(fixture.stateDir, 'note.txt')
  await cacheArgs(fixture, 'session-worker', 'write', { file_path: path, content: 'x' }, 'call_ask_audit')
  const pending = fixture.emit(
    'approval/request',
    request('session-worker', 'write', 'call_ask_audit'),
    async () => 'allowed-once',
  )
  await delay(20)
  const listed = await fixture.call('ria_approval', { action: 'list' })
  fixture.service.auditApproval = () => { throw new Error('audit disk full') }
  const decision = await fixture.call('ria_approval_decision', {
    approvalId: listed.pending[0].approvalId,
    decision: 'ask-user',
  })
  assert.equal(decision.ok, true)
  assert.equal(await pending, 'rejected')
})

// No decision within the TTL is rejected and the user is notified.
await withFixture({ approvalAutomation: true }, async fixture => {
  const ticket = addTicket(fixture, 'write a file without a decision')
  fixture.service.approvals.decisionTtlMs = 30
  const path = join(fixture.stateDir, 'note.txt')
  await cacheArgs(fixture, 'session-worker', 'write', { file_path: path, content: 'x' }, 'call_timeout')
  const [result] = await Promise.all([
    fixture.emit(
      'approval/request',
      request('session-worker', 'write', 'call_timeout'),
      async () => 'unavailable',
    ),
    delay(160),
  ])
  assert.equal(result, 'rejected')
  assert.equal(fixture.followups.length, 1)
  assert.equal(fixture.service.store.ticket(ticket.ticketId).status, 'working')
  const decision = await fixture.call('ria_approval_decision', {
    approvalId: 'apr_missing',
    decision: 'allow',
  })
  assert.equal(decision.ok, false)
  assert.equal(decision.code, 'approval_not_found')
  const events = auditEvents(fixture)
  assert.equal(events.at(-1).decision, 'deny')
  assert.match(events.at(-1).basis, /timeout/)
})

// Audit failure turns even a low-risk allow into a rejection.
await withFixture({ approvalAutomation: true }, async fixture => {
  addTicket(fixture, 'run tests with a broken audit log')
  await cacheArgs(fixture, 'session-worker', 'bash', { command: 'npm test' }, 'call_audit')
  const original = fixture.service.auditApproval
  fixture.service.auditApproval = () => { throw new Error('disk full') }
  try {
    const result = await fixture.emit(
      'approval/request',
      request('session-worker', 'bash', 'call_audit'),
      async () => 'unavailable',
    )
    assert.equal(result, 'rejected')
    assert.equal(fixture.followups.length, 0)
  } finally {
    fixture.service.auditApproval = original
  }
})

// High risk can be relayed but never allowed by Ria.
await withFixture({ approvalAutomation: true }, async fixture => {
  addTicket(fixture, 'download a file from the network')
  await cacheArgs(fixture, 'session-worker', 'bash', { command: 'curl https://example.com' }, 'call_high')
  const pending = fixture.emit(
    'approval/request',
    request('session-worker', 'bash', 'call_high', 'network access'),
    async () => 'unavailable',
  )
  await delay(20)
  const listed = await fixture.call('ria_approval', { action: 'list' })
  assert.equal(listed.pending[0].risk, 'high')
  const refused = await fixture.call('ria_approval_decision', {
    approvalId: listed.pending[0].approvalId,
    decision: 'allow',
  })
  assert.equal(refused.ok, false)
  assert.equal(refused.code, 'risk_requires_user')
  const denied = fixture.service.approvals.decision(listed.pending[0].approvalId, 'deny', 'no network needed')
  assert.equal(denied.ok, true)
  const again = fixture.service.approvals.decision(listed.pending[0].approvalId, 'deny')
  assert.equal(again.ok, false)
  assert.equal(again.code, 'approval_already_decided')
  assert.equal(await pending, 'rejected')
})

// Redaction and a few pure rules.
{
  const preview = approvalArgsPreview({ token: 'super-secret', command: 'curl -H "Authorization: Bearer abc123" https://x' })
  assert.equal(preview.includes('super-secret'), false)
  assert.equal(preview.includes('abc123'), false)
  assert.match(preview, /\[redacted\]/)
  assert.equal(classifyApproval({ toolName: 'bash', args: { command: 'ls' } }).auto, 'allow')
  assert.equal(classifyApproval({ toolName: 'bash', args: { command: 'sudo ls' } }).auto, 'deny')
  assert.equal(classifyApproval({ toolName: 'write', args: { file_path: '/etc/passwd' }, cwd: '/work' }).risk, 'high')
  assert.equal(classifyApproval({ toolName: 'read', args: { file_path: 'README.md' }, cwd: '/work' }).auto, 'allow')
  assert.equal(classifyApproval({ toolName: 'run_code', args: { code: 'return 1' }, cwd: '/work' }).auto, 'relay')
  // Paths that leave the workspace through ~ or .. must not be low risk.
  assert.equal(classifyApproval({ toolName: 'bash', args: { command: 'cat ~/.aws/credentials' } }).risk, 'high')
  assert.equal(classifyApproval({ toolName: 'bash', args: { command: 'cat $HOME/.config/x' } }).risk, 'high')
  assert.equal(classifyApproval({ toolName: 'bash', args: { command: 'cd ..' } }).risk, 'high')
  assert.equal(classifyApproval({ toolName: 'read', args: { file_path: '../outside' }, cwd: '/work' }).risk, 'high')
  assert.equal(classifyApproval({ toolName: 'write', args: { file_path: '~/.aws/credentials' }, cwd: '/work' }).risk, 'high')
  // Commands that look read-only but can mutate local or global state.
  assert.equal(classifyApproval({ toolName: 'bash', args: { command: 'sed --in-place s/x/y/ a.txt' } }).risk, 'high')
  assert.equal(classifyApproval({ toolName: 'bash', args: { command: 'git config --global user.name x' } }).risk, 'high')
  assert.equal(classifyApproval({ toolName: 'bash', args: { command: 'git branch -D main' } }).risk, 'high')
  // Credential files stay high risk even inside the workspace.
  assert.equal(classifyApproval({ toolName: 'read', args: { file_path: '.env' }, cwd: '/work' }).risk, 'high')
  assert.equal(classifyApproval({ toolName: 'write', args: { file_path: 'config/secrets.json', content: 'x' }, cwd: '/work' }).risk, 'high')
  assert.equal(classifyApproval({ toolName: 'bash', args: { command: 'cat config/.env.local' }, cwd: '/work' }).risk, 'high')
  assert.equal(classifyApproval({ toolName: 'run_code', args: { code: 'const x = readFileSync(".env")' }, cwd: '/work' }).risk, 'high')
  assert.equal(classifyApproval({ toolName: 'run_code', args: { code: "import fs from 'node:fs'; fs.writeFileSync('a','b')" }, cwd: '/work' }).risk, 'high')
}


console.log('approval automation ok')
