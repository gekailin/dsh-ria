import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createFixture } from './support/ria-fixture.mjs'
import { advisorPrompt, chatPrompt, workerPrompt } from '../lib/v2/prompts.mjs'
import {
  DEFAULT_ESCALATION_POLICY,
  ESCALATION_POLICIES,
  classify,
  decideEscalation,
  mergeRiskLevels,
  resolveEscalationPolicy,
} from '../lib/v2/risk.mjs'

const WORKSPACE = process.cwd()

// 1. Classifier: four levels, stable rule ids and readable reasons.
{
  const low = [
    { label: 'read-only', input: { toolName: 'bash', command: 'ls -la' } },
    { label: 'git-read-only', input: { toolName: 'bash', command: 'git status' } },
    { label: 'tests', input: { toolName: 'bash', command: 'npm test' } },
    { label: 'node-tests', input: { toolName: 'bash', command: 'node test/v2.mjs' } },
  ]
  for (const item of low) {
    const risk = classify({ ...item.input, cwd: WORKSPACE, workspace: WORKSPACE })
    assert.equal(risk.level, 'low', item.label + ': ' + JSON.stringify(risk))
    assert.ok(risk.reasons.length > 0)
    assert.ok(risk.reasons.every(reason => reason.startsWith('[')))
    assert.ok(risk.signals.ruleIds.length > 0)
  }

  const medium = [
    { label: 'write-lib', input: { toolName: 'write', args: { file_path: WORKSPACE + '/lib/v2/a.mjs' } }, rule: 'write-tracked-source' },
    { label: 'edit-package', input: { toolName: 'edit', args: { file_path: WORKSPACE + '/package.json' } }, rule: 'write-tracked-source' },
    { label: 'git-commit', input: { toolName: 'bash', command: 'git commit -m x' }, rule: 'git-write' },
    { label: 'install', input: { toolName: 'bash', command: 'npm install left-pad' }, rule: 'install-deps' },
    { label: 'config', input: { toolName: 'write', args: { file_path: '/home/gkl/.dsh/ria.json' } }, rule: 'config-write' },
  ]
  for (const item of medium) {
    const risk = classify({ ...item.input, cwd: WORKSPACE, workspace: WORKSPACE })
    assert.equal(risk.level, 'medium', item.label + ': ' + JSON.stringify(risk))
    assert.ok(risk.signals.ruleIds.includes(item.rule), item.label + ': ' + risk.signals.ruleIds.join(','))
  }

  const high = [
    { label: 'etc', input: { toolName: 'write', args: { file_path: '/etc/hosts' } } },
    { label: 'outside-echo', input: { toolName: 'bash', command: 'echo probe > /home/gkl/Desktop/ria-risk-probe.txt' } },
    { label: 'sudo', input: { toolName: 'bash', command: 'sudo chmod 777 /tmp/x' } },
    { label: 'rm', input: { toolName: 'bash', command: 'rm -rf build' } },
    { label: 'systemctl', input: { toolName: 'bash', command: 'systemctl restart dsh' } },
    { label: 'network', input: { toolName: 'bash', command: 'curl https://example.com' } },
    { label: 'git-push', input: { toolName: 'bash', command: 'git push origin main' } },
  ]
  for (const item of high) {
    const risk = classify({ ...item.input, cwd: WORKSPACE, workspace: WORKSPACE })
    assert.equal(risk.level, 'high', item.label + ': ' + JSON.stringify(risk))
    assert.ok(risk.signals.ruleIds.length > 0)
  }

  const unknown = [
    { label: 'shell-c', input: { toolName: 'bash', command: 'sh -c "echo hi"' } },
    { label: 'pipe', input: { toolName: 'bash', command: 'cat a | grep b' } },
    { label: 'variable', input: { toolName: 'bash', command: 'echo $HOME' } },
    { label: 'path-escape', input: { toolName: 'write', args: { file_path: '../../etc/passwd' } } },
    { label: 'missing-args', input: { toolName: 'bash' } },
  ]
  for (const item of unknown) {
    const risk = classify({ ...item.input, cwd: WORKSPACE, workspace: WORKSPACE })
    assert.equal(risk.level, 'unknown', item.label + ': ' + JSON.stringify(risk))
    assert.ok(risk.reasons.some(reason => /无法|缺少|未识别/.test(reason)))
  }

  // Multiple hits keep the worst level and list every reason.
  const mixed = classify({ toolName: 'bash', command: 'sudo rm -rf /tmp/x', cwd: WORKSPACE, workspace: WORKSPACE })
  assert.equal(mixed.level, 'high')
  assert.ok(mixed.signals.ruleIds.includes('privileged-command'))
  assert.ok(mixed.reasons.length >= 2)
}

// Unsafe arguments/shell forms cannot inherit the command-name allow-list.
{
  const dangerous = [
    'rm -rf build', 'git checkout -- .', 'git checkout -f main', 'git restore .',
    'ls --force', 'git branch -D topic', 'git branch --list --delete topic',
    'echo x > /etc/hosts', 'echo x > /etc/hosts ignored', 'echo x >/etc/hosts ignored',
    'echo x >"/etc/hosts"', 'echo x 2>/etc/hosts', 'echo x >/etc/hosts >out',
    'echo x &>/etc/hosts', 'echo x >|/etc/hosts', 'echo x <>/etc/hosts',
    'sudo ls', 'ls; rm -rf build', 'ls && sudo id', 'ls || rm -rf build',
    'echo script | sh', 'printf script | /bin/bash', 'ls | xargs rm -rf',
    'xargs rm -rf', 'xargs -I{} sh -c "rm -rf {}"', 'echo $(rm -rf build)',
    'echo <(rm -rf build)', 'echo hi\nrm -rf build',
    'sort -o /etc/hosts input', 'sort --output=/etc/hosts input', 'uniq input /etc/hosts',
    'sed -i.bak s/a/b/ /etc/hosts', 'sed --in-place=.bak s/a/b/ /etc/hosts',
    'awk "BEGIN {system(\"id\")}"', 'rg --pre=id text',
    'node --eval "1" test/v2.mjs', 'git diff --ext-diff', 'command rm -rf build',
    'git remote set-url origin https://example.com', 'cat .env',
  ]
  dangerous.push('echo ' + String.fromCharCode(96) + 'rm -rf build' + String.fromCharCode(96))
  for (const command of dangerous) {
    const risk = classify({ toolName: 'bash', command, cwd: WORKSPACE, workspace: WORKSPACE })
    assert.notEqual(risk.level, 'low', command + ': ' + JSON.stringify(risk))
    assert.ok(risk.reasons.length > 0)
  }
  for (const command of ['rm -rf build', 'git checkout -- .', 'ls --force', 'sudo ls', 'echo x > /etc/hosts']) {
    const risk = classify({ toolName: 'bash', command, cwd: WORKSPACE, workspace: WORKSPACE })
    assert.equal(risk.level, 'high', command)
    assert.equal(decideEscalation(risk.level, 'auto-low-medium'), 'ask')
  }
  for (const command of ['ls -la', 'git status', 'git remote -v', 'git branch --list', 'npm test', 'node --check lib/v2/risk.mjs', 'sort input', 'sed -n 1p input']) {
    assert.equal(classify({ toolName: 'bash', command, cwd: WORKSPACE, workspace: WORKSPACE }).level, 'low', command)
  }
  const missing = classify({ toolName: 'bash', command: 'ls -la' })
  assert.equal(missing.level, 'unknown')
  assert.ok(missing.reasons.some(reason => reason.includes('workdir')))
  assert.equal(classify({ toolName: 'bash', command: 'echo x > probe.txt', args: { workdir: '/etc' }, cwd: WORKSPACE, workspace: WORKSPACE }).level, 'high')
}

// Risk aggregation must be order-independent, with missing/invalid levels fail-closed.
{
  for (const levels of [['high', 'low'], ['low', 'high'], ['medium', 'high', 'low'], ['high', 'low', 'medium']]) {
    assert.equal(mergeRiskLevels(levels), 'high', JSON.stringify(levels))
  }
  assert.equal(mergeRiskLevels(['medium', 'low']), 'medium')
  assert.equal(mergeRiskLevels(['low', 'low']), 'low')
  for (const invalid of ['unknown', 'invalid', '', null, undefined, 'toString', '__proto__']) {
    assert.equal(mergeRiskLevels([invalid, 'high', 'low']), 'unknown')
    assert.equal(mergeRiskLevels(['low', 'high', invalid]), 'unknown')
    assert.equal(decideEscalation(mergeRiskLevels(['low', invalid]), 'auto-low-medium'), 'ask')
  }
  assert.equal(mergeRiskLevels([]), 'unknown')
}

// 2. Policy priority and the decision matrix. High/unknown never auto-allow.
{
  assert.deepEqual(resolveEscalationPolicy({ ticket: { escalationPolicy: 'strict' }, settings: { escalationPolicy: 'auto-low-medium' } }), { policy: 'strict', source: 'ticket' })
  assert.deepEqual(resolveEscalationPolicy({ ticket: {}, settings: { escalationPolicy: 'auto-low-medium' } }), { policy: 'auto-low-medium', source: 'global' })
  assert.deepEqual(resolveEscalationPolicy({ ticket: {}, settings: {} }), { policy: DEFAULT_ESCALATION_POLICY, source: 'default' })
  assert.equal(DEFAULT_ESCALATION_POLICY, 'auto-low')
  assert.deepEqual(ESCALATION_POLICIES, ['strict', 'auto-low', 'auto-low-medium'])

  for (const level of ['high', 'unknown']) {
    for (const policy of ESCALATION_POLICIES) assert.equal(decideEscalation(level, policy), 'ask', level + '/' + policy)
  }
  assert.equal(decideEscalation('low', 'strict'), 'ask')
  assert.equal(decideEscalation('low', 'auto-low'), 'auto-allow')
  assert.equal(decideEscalation('low', 'auto-low-medium'), 'auto-allow')
  assert.equal(decideEscalation('medium', 'strict'), 'ask')
  assert.equal(decideEscalation('medium', 'auto-low'), 'ask')
  assert.equal(decideEscalation('medium', 'auto-low-medium'), 'auto-allow')
}

const fixture = await createFixture({ v2Default: true })
const settle = () => new Promise(resolve => setTimeout(resolve, 20))
const chatbot = fixture.service.v2.v2.chatSessionId
const notices = () => fixture.prompts.filter(item => String(item.sessionId) === String(chatbot))
const bodyOf = prompt => String(prompt && prompt.content && prompt.content[0] ? prompt.content[0].text : '')
const auditLines = () => {
  const file = join(fixture.stateDir, 'audit.jsonl')
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
}
const riskAudits = () => auditLines().filter(item => item.event === 'approval/decision' && item.kind === 'risk')

try {
  await fixture.service.ensure()
  const request = await fixture.callAs(chatbot, 'chatbot_request', { goal: 'risk approval probe', acceptance: 'none' })
  const advisor = fixture.service.v2.v2.advisor('global').sessionId
  await fixture.callAs(advisor, 'ticket_plan', { ticketId: request.ticketId, summary: 'probe risk', steps: ['probe'] })
  const dispatch = await fixture.callAs(advisor, 'ticket_dispatch', { ticketId: request.ticketId })
  assert.equal(dispatch.ok, true)
  const ticketId = request.ticketId
  const worker = dispatch.workerSessionId
  const workerCwd = fixture.service.v2.v2.worker(worker).cwd
  const setTicketPolicy = policy => fixture.service.v2.v2.setTicketMeta(ticketId, { escalationPolicy: policy })
  const cache = (callId, toolName, args) => fixture.emit(
    'tools/pre-execute',
    { agent: { id: worker }, name: toolName, callId, arguments: args },
    async () => ({ kind: 'enter' }),
  )
  const approval = (callId, toolName, next) => fixture.emit(
    'approval/request',
    { agent: { id: worker }, toolName, callId, reason: 'risk probe', signal: new AbortController().signal },
    next,
  )
  let askedCalls = 0
  const next = async () => { askedCalls += 1; return 'rejected' }

  // default auto-low: low auto-allow, medium/high/unknown ask.
  await cache('c-low', 'bash', { command: 'git status' })
  assert.equal(await approval('c-low', 'bash', next), 'allowed-once')
  assert.equal(askedCalls, 0)
  const lowAudit = riskAudits().find(item => item.callId === 'c-low')
  assert.equal(lowAudit.level, 'low')
  assert.equal(lowAudit.decision, 'auto-allow')
  assert.equal(lowAudit.policy, 'auto-low')
  assert.equal(lowAudit.policySource, 'default')
  assert.ok(lowAudit.reasons.some(reason => reason.includes('read-only-git')))
  assert.equal(lowAudit.ticketId, ticketId)
  assert.equal(lowAudit.sessionId, worker)

  await cache('c-medium', 'write', { file_path: workerCwd + '/lib/probe.mjs' })
  assert.equal(await approval('c-medium', 'write', next), 'rejected')
  assert.equal(askedCalls, 1)
  assert.equal(riskAudits().find(item => item.callId === 'c-medium').level, 'medium')

  await cache('c-high', 'write', { file_path: '/etc/hosts' })
  assert.equal(await approval('c-high', 'write', next), 'rejected')
  assert.equal(riskAudits().find(item => item.callId === 'c-high').level, 'high')

  await cache('c-unknown', 'bash', { command: 'sh -c "echo hi"' })
  assert.equal(await approval('c-unknown', 'bash', next), 'rejected')
  assert.equal(riskAudits().find(item => item.callId === 'c-unknown').level, 'unknown')

  // global auto-low-medium: medium now auto-allows; high and unknown still ask.
  fixture.service.store.setSettings({ escalationPolicy: 'auto-low-medium' })
  await cache('c-medium-global', 'write', { file_path: workerCwd + '/lib/probe2.mjs' })
  assert.equal(await approval('c-medium-global', 'write', next), 'allowed-once')
  const globalAudit = riskAudits().find(item => item.callId === 'c-medium-global')
  assert.equal(globalAudit.policy, 'auto-low-medium')
  assert.equal(globalAudit.policySource, 'global')
  await cache('c-high-global', 'write', { file_path: '/etc/hosts' })
  assert.equal(await approval('c-high-global', 'write', next), 'rejected')
  assert.equal(riskAudits().find(item => item.callId === 'c-high-global').level, 'high')

  // ticket strict beats global auto-low-medium: even low asks.
  setTicketPolicy('strict')
  await cache('c-low-strict', 'bash', { command: 'git status' })
  assert.equal(await approval('c-low-strict', 'bash', next), 'rejected')
  const strictAudit = riskAudits().find(item => item.callId === 'c-low-strict')
  assert.equal(strictAudit.decision, 'ask')
  assert.equal(strictAudit.policy, 'strict')
  assert.equal(strictAudit.policySource, 'ticket')

  // ticket auto-low-medium beats global strict: medium auto-allows.
  fixture.service.store.setSettings({ escalationPolicy: 'strict' })
  setTicketPolicy('auto-low-medium')
  await cache('c-medium-ticket', 'write', { file_path: workerCwd + '/lib/probe3.mjs' })
  assert.equal(await approval('c-medium-ticket', 'write', next), 'allowed-once')
  const ticketAudit = riskAudits().find(item => item.callId === 'c-medium-ticket')
  assert.equal(ticketAudit.policySource, 'ticket')
  assert.equal(ticketAudit.policy, 'auto-low-medium')

  // State machine: asked first (host order), high blocks with risk in the reason.
  fixture.service.store.setSettings({ escalationPolicy: 'auto-low' })
  setTicketPolicy('auto-low-medium')
  await cache('c-state-high', 'write', { file_path: '/etc/hosts' })
  fixture.service.onSessionEvent(
    { header: { id: worker } },
    { type: 'approval/asked', time: Date.now(), data: { id: 'apr_high', toolName: 'write', callId: 'c-state-high', reason: '写工作区外' } },
  )
  assert.equal(fixture.service.store.ticket(ticketId).status, 'blocked')
  assert.equal(fixture.service.store.ticket(ticketId).waitingOn, 'approval')
  assert.match(fixture.service.store.ticket(ticketId).blockedReason, /\[risk:high/)
  assert.match(fixture.service.store.ticket(ticketId).blockedReason, /write-outside-workspace/)
  assert.equal(await approval('c-state-high', 'write', next), 'rejected')
  await settle()
  assert.match(bodyOf(notices().at(-1)), /risk:high/)
  assert.match(bodyOf(notices().at(-1)), /write-outside-workspace/)

  const highAudit = riskAudits().find(item => item.callId === 'c-state-high' && item.decision === 'ask')
  assert.ok(highAudit)
  assert.equal(highAudit.level, 'high')
  assert.ok(highAudit.reasons.length > 0)
  assert.equal(highAudit.policySource, 'ticket')

  // Human allow: blocked -> open -> working, and a human-allow audit line.
  fixture.service.onSessionEvent(
    { header: { id: worker } },
    { type: 'approval/decided', time: Date.now(), data: { id: 'apr_high', outcome: 'allowed-once' } },
  )
  assert.equal(fixture.service.store.ticket(ticketId).status, 'working')
  const humanAudit = riskAudits().find(item => item.decision === 'human-allow')
  assert.ok(humanAudit)
  assert.equal(humanAudit.approvalId, 'apr_high')
  assert.equal(humanAudit.level, 'high')

  // Human deny is audited too and leaves the ticket parked.
  await cache('c-state-deny', 'write', { file_path: '/etc/hosts' })
  fixture.service.onSessionEvent(
    { header: { id: worker } },
    { type: 'approval/asked', time: Date.now(), data: { id: 'apr_deny', toolName: 'write', callId: 'c-state-deny', reason: '写工作区外' } },
  )
  fixture.service.onSessionEvent(
    { header: { id: worker } },
    { type: 'approval/decided', time: Date.now(), data: { id: 'apr_deny', outcome: 'rejected' } },
  )
  assert.equal(fixture.service.store.ticket(ticketId).status, 'blocked')
  assert.equal(fixture.service.store.ticket(ticketId).failure.code, 'approval_denied')
  const denyAudit = riskAudits().find(item => item.decision === 'human-deny' && item.approvalId === 'apr_deny')
  assert.ok(denyAudit)
  assert.equal(denyAudit.level, 'high')
  const resumed = await fixture.callAs(chatbot, 'chatbot_resume', { ticketId })
  assert.equal(resumed.ok, true, JSON.stringify(resumed))

  // Low auto-allow with the host's real event order: asked first, then request.
  const beforeLowNotice = notices().length
  await cache('c-state-low', 'bash', { command: 'git status' })
  fixture.service.onSessionEvent(
    { header: { id: worker } },
    { type: 'approval/asked', time: Date.now(), data: { id: 'apr_low', toolName: 'bash', callId: 'c-state-low', reason: '只读命令' } },
  )
  assert.equal(fixture.service.store.ticket(ticketId).status, 'working')
  assert.equal(await approval('c-state-low', 'bash', next), 'allowed-once')
  await settle()
  const lowNotices = notices().slice(beforeLowNotice).map(bodyOf)
  assert.ok(lowNotices.some(text => text.includes('已自动放行低风险提权')))
  assert.ok(lowNotices.some(text => text.includes('git status')))
  assert.ok(lowNotices.some(text => text.includes('read-only-git')))
  // The low-risk command really executes after allowed-once.
  const status = execFileSync('git', ['status', '--porcelain'], { cwd: WORKSPACE, encoding: 'utf8' })
  assert.equal(typeof status, 'string')

  // Low-risk audit is auto-allow and the ticket never entered blocked.
  const lowStateAudit = riskAudits().find(item => item.callId === 'c-state-low' && item.decision === 'auto-allow')
  assert.ok(lowStateAudit)
  assert.equal(lowStateAudit.level, 'low')

  // 3. chatbot_grant is debug/emergency only and leaves grant_kind in audit.
  const granted = await fixture.callAs(chatbot, 'chatbot_grant', {
    action: 'set',
    sessionId: worker,
    sandboxMode: 'read-only',
    reason: 'risk approval debug probe',
    kind: 'emergency',
  })
  assert.equal(granted.ok, true, JSON.stringify(granted))
  assert.equal(granted.grantKind, 'emergency')
  const grantAudit = auditLines().find(item => item.event === 'grant/set' && item.sessionId === worker)
  assert.ok(grantAudit)
  assert.equal(grantAudit.grant_kind, 'emergency')
  await fixture.callAs(chatbot, 'chatbot_grant', { action: 'reset', grantId: granted.grant.grantId })

  // 4. Prompt/docs positioning is part of the contract.
  assert.match(chatPrompt(), /调试\/应急/)
  assert.match(advisorPrompt(), /escalationPolicy/)
  assert.match(advisorPrompt(), /chatbot_grant 仅调试\/应急/)
  assert.match(workerPrompt({}), /提权按风险逐条审批/)
  assert.match(readFileSync('docs/design-v2.md', 'utf8'), /提权风险分级与逐条审批/)
  assert.match(readFileSync('docs/tools.md', 'utf8'), /仅调试\/应急/)
  assert.equal(existsSync('/home/gkl/Desktop/ria-risk-probe.txt'), false)

  console.log('v2 risk approval ok')
} finally {
  fixture.cleanup()
}
