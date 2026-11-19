import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createFixture } from './support/ria-fixture.mjs'
import { PTC_TRANSPORTS, parseTransportCall } from '../lib/v2/risk.mjs'

const BT = String.fromCharCode(96)
const probe = '/home/gkl/Desktop/ria-risk-probe.txt'

// 1. Static parser: literals are extracted, dynamic code falls back.
{
  assert.ok(PTC_TRANSPORTS.has('run_code'))
  const low = parseTransportCall('run_code', { code: "const r = await tools.bash({ command: 'git status' })" })
  assert.equal(low.parsed, true)
  assert.deepEqual(low.commands, ['git status'])
  const write = parseTransportCall('run_code', { code: "await tools.write({ file_path: '/tmp/x' })" })
  assert.equal(write.parsed, true)
  assert.deepEqual(write.paths, ['/tmp/x'])
  const multi = parseTransportCall('run_code', {
    code: "await tools.bash({ command: 'git status', cwd: '/repo', sandbox_permissions: 'danger-full-access' }); await tools.write({ file_path: '/tmp/x' })",
  })
  assert.deepEqual(multi.commands, ['git status'])
  assert.deepEqual(multi.paths, ['/tmp/x'])
  assert.equal(multi.cwd, '/repo')
  assert.equal(multi.sandboxPermissions, 'danger-full-access')
  const template = parseTransportCall('run_code', { code: 'await tools.bash({ command: ' + BT + 'git status' + BT + ' })' })
  assert.equal(template.parsed, true)
  assert.deepEqual(template.commands, ['git status'])
  const variable = parseTransportCall('run_code', { code: "const cmd = 'git status'; await tools.bash({ command: cmd })" })
  assert.equal(variable.parsed, false)
  assert.match(variable.reason, /变量|动态/)
  const interpolated = parseTransportCall('run_code', { code: "await tools.bash({ command: 'echo " + '$' + "{ts}' })" })
  assert.equal(interpolated.parsed, false)
  assert.match(interpolated.reason, /插值|动态/)
  const missing = parseTransportCall('run_code', {})
  assert.equal(missing.parsed, false)
  assert.match(missing.reason, /缺少/)
}

const fixture = await createFixture({ v2Default: true })
const settle = () => new Promise(resolve => setTimeout(resolve, 20))
const chatbot = fixture.service.v2.v2.chatbotSessionId
const notices = () => fixture.prompts.filter(item => String(item.sessionId) === String(chatbot)).map(item => String(item.content[0].text))
const auditLines = () => {
  const file = join(fixture.stateDir, 'audit.jsonl')
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
}
const transportAudits = () => auditLines().filter(item => item.event === 'approval/decision' && item.tool === 'run_code')

try {
  await fixture.service.ensure()
  const made = await fixture.callAs(chatbot, 'chatbot_request', { goal: 'run_code risk transport', acceptance: 'decisions' })
  const advisor = fixture.service.v2.v2.advisor('global').sessionId
  await fixture.callAs(advisor, 'ticket_plan', { ticketId: made.ticketId, summary: 'transport probes', steps: ['probe'] })
  const dispatched = await fixture.callAs(advisor, 'ticket_dispatch', { ticketId: made.ticketId })
  const ticketId = made.ticketId
  const worker = dispatched.workerSessionId
  const ticket = () => fixture.service.store.ticket(ticketId)
  const cache = (callId, code) => fixture.emit(
    'tools/pre-execute',
    { agent: { id: worker }, name: 'run_code', callId, arguments: code === undefined ? {} : { code } },
    async () => ({ kind: 'enter' }),
  )
  const asked = (id, callId, reason = 'transport probe') => fixture.service.onSessionEvent(
    { header: { id: worker } },
    { type: 'approval/asked', time: Date.now(), data: { id, toolName: 'run_code', callId, reason } },
  )
  const request = (callId, next) => fixture.emit(
    'approval/request',
    { agent: { id: worker }, toolName: 'run_code', callId, reason: 'transport probe', signal: new AbortController().signal },
    next,
  )
  const decided = (id, outcome = 'allowed-once') => fixture.service.onSessionEvent(
    { header: { id: worker } },
    { type: 'approval/decided', time: Date.now(), data: { id, outcome } },
  )
  const next = async () => 'rejected'
  const auditFor = callId => transportAudits().find(item => item.callId === callId)

  // Low: run_code wrapping git status is classified from the inner command.
  await cache('rc-low', "const r = await tools.bash({ command: 'git status' })")
  asked('apr_rc_low', 'rc-low')
  assert.equal(ticket().status, 'working')
  assert.equal(await request('rc-low', next), 'allowed-once')
  const lowAudit = auditFor('rc-low')
  assert.equal(lowAudit.level, 'low')
  assert.equal(lowAudit.decision, 'auto-allow')
  assert.equal(lowAudit.transport, 'run_code')
  assert.equal(lowAudit.argv, 'git status')
  assert.ok(lowAudit.reasons.some(reason => reason.includes('[via-run_code] 经由 run_code，实际命令')))
  assert.ok(lowAudit.reasons.some(reason => reason.includes('read-only-git')))
  await settle()
  assert.ok(notices().some(text => text.includes('git status') && text.includes('run_code')))
  decided('apr_rc_low')

  // High: redirect outside the workspace blocks and records the inner command/path.
  await cache('rc-high', "const r = await tools.bash({ command: 'echo probe > " + probe + "' })")
  asked('apr_rc_high', 'rc-high', '写工作区外')
  assert.equal(ticket().status, 'blocked')
  assert.equal(ticket().waitingOn, 'approval')
  assert.match(ticket().blockedReason, /risk:high/)
  assert.match(ticket().blockedReason, /run_code（实际命令：echo probe/)
  assert.equal(await request('rc-high', next), 'rejected')
  const highAudit = auditFor('rc-high')
  assert.equal(highAudit.level, 'high')
  assert.equal(highAudit.decision, 'ask')
  assert.equal(highAudit.transport, 'run_code')
  assert.equal(highAudit.argv, 'echo probe > ' + probe)
  assert.ok(highAudit.paths.includes(probe))
  assert.ok(highAudit.reasons.some(reason => reason.includes('write-outside-workspace')))
  await settle()
  assert.ok(notices().some(text => text.includes('risk:high') && text.includes('run_code')))
  decided('apr_rc_high')
  assert.equal(ticket().status, 'working')

  // High: tools.write path is also classified from the inner path.
  await cache('rc-write', "await tools.write({ file_path: '/home/gkl/Desktop/ria-risk-write.txt' })")
  asked('apr_rc_write', 'rc-write', '写工作区外')
  assert.equal(ticket().status, 'blocked')
  assert.equal(await request('rc-write', next), 'rejected')
  const writeAudit = auditFor('rc-write')
  assert.equal(writeAudit.level, 'high')
  assert.equal(writeAudit.argv, 'write /home/gkl/Desktop/ria-risk-write.txt')
  assert.ok(writeAudit.paths.includes('/home/gkl/Desktop/ria-risk-write.txt'))
  decided('apr_rc_write')

  // Dynamic inner command falls back to unknown with an explicit reason.
  await cache('rc-dynamic', "const cmd = 'git status'; await tools.bash({ command: cmd })")
  asked('apr_rc_dynamic', 'rc-dynamic', '动态命令')
  assert.equal(ticket().status, 'blocked')
  assert.equal(await request('rc-dynamic', next), 'rejected')
  const dynamicAudit = auditFor('rc-dynamic')
  assert.equal(dynamicAudit.level, 'unknown')
  assert.equal(dynamicAudit.decision, 'ask')
  assert.ok(dynamicAudit.reasons.some(reason => reason.includes('无法解析 run_code 内部命令')))
  decided('apr_rc_dynamic')

  // Missing code falls back to unknown too.
  await cache('rc-missing', undefined)
  asked('apr_rc_missing', 'rc-missing', '缺失 code')
  assert.equal(ticket().status, 'blocked')
  assert.equal(await request('rc-missing', next), 'rejected')
  const missingAudit = auditFor('rc-missing')
  assert.equal(missingAudit.level, 'unknown')
  assert.ok(missingAudit.reasons.some(reason => reason.includes('无法解析 run_code 内部命令')))
  decided('apr_rc_missing')

  // Multiple inner commands take the highest risk.
  await cache('rc-multi', "await tools.bash({ command: 'git status' }); await tools.bash({ command: 'echo x > /home/gkl/Desktop/ria-risk-multi.txt' })")
  asked('apr_rc_multi', 'rc-multi', '多命令')
  assert.equal(ticket().status, 'blocked')
  assert.equal(await request('rc-multi', next), 'rejected')
  const multiAudit = auditFor('rc-multi')
  assert.equal(multiAudit.level, 'high')
  assert.ok(multiAudit.reasons.some(reason => reason.includes('经由 run_code，实际命令：git status；echo x')))
  assert.ok(multiAudit.reasons.some(reason => reason.includes('write-outside-workspace')))
  decided('apr_rc_multi')

  // Existing outer-tool classification still works unchanged.
  await cache('bash-low', "ignored")
  fixture.service.onSessionEvent(
    { header: { id: worker } },
    { type: 'approval/asked', time: Date.now(), data: { id: 'apr_bash_low', toolName: 'bash', callId: 'bash-low', reason: 'ordinary bash' } },
  )
  // No bash args were cached under this call id, so it must stay unknown.
  assert.equal(await request('bash-low', next), 'rejected')
  const bashAudit = auditLines().find(item => item.event === 'approval/decision' && item.callId === 'bash-low')
  assert.equal(bashAudit.level, 'unknown')

  console.log('v2 risk transport ok')
} finally {
  fixture.cleanup()
}
