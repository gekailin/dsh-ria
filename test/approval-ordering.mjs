import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { ApprovalObserver } from '../lib/approvals.mjs'

const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

const ticket = { ticketId: 'ticket-1', executor: 'session-worker' }

function makeObserver(ctx, diagnostics = []) {
  return new ApprovalObserver({
    ctx,
    store: {
      riaSessionId: 'session-ria',
      activeTickets: () => [ticket],
    },
    now: () => 1_800_000_000_000,
    automationEnabled: () => true,
    classify: () => ({ risk: 'low', auto: 'allow', allowable: false, summary: 'test allow' }),
    audit: async () => true,
    contextFor: async () => ({ cwd: '/work' }),
    notify: () => {},
    wake: async () => {},
    diagnose: entry => diagnostics.push(entry),
  })
}

function request(agentId, callId = 'call-1', signal = new AbortController().signal) {
  return {
    agent: agentId === undefined ? undefined : { id: agentId },
    toolName: 'bash',
    callId,
    reason: 'test request',
    signal,
  }
}

// The web bundle registers dsh-api-remotes before profile plugins. Its
// approval/request listener forwards the request to the browser and waits for
// the user's click without calling next(), so a normally appended listener is
// vetoed. Ria prepends its listener and must decide before that forwarder.
{
  const ctx = new Context()
  let forwarderCalls = 0
  ctx.on('approval/request', async () => {
    forwarderCalls += 1
    return new Promise(() => {})
  })
  const observer = makeObserver(ctx)
  observer.rememberArguments({ agent: { id: 'session-worker' }, callId: 'call-1', name: 'bash', arguments: { command: 'ls' } })
  const dispose = observer.subscribe()
  const outcome = await ctx.waterfall('approval/request', request('session-worker'), () => 'host-fallback')
  assert.equal(outcome, 'allowed-once')
  assert.equal(forwarderCalls, 0, 'the UI forwarder must not keep a worker request from Ria')
  dispose()
}

// Control: the same waterfall with an appended listener never reaches it.
{
  const ctx = new Context()
  let laterCalls = 0
  ctx.on('approval/request', () => new Promise(() => {}))
  ctx.on('approval/request', async (event, next) => {
    laterCalls += 1
    return await next()
  })
  const pending = ctx.waterfall('approval/request', request('session-worker'), () => 'host-fallback')
  const raced = await Promise.race([pending.then(() => 'resolved'), delay(20).then(() => 'pending')])
  assert.equal(raced, 'pending')
  assert.equal(laterCalls, 0)
}

// A request Ria does not own falls through to the next answerer and leaves one
// diagnostic line with the identity needed to debug it later.
{
  const ctx = new Context()
  const diagnostics = []
  const observer = makeObserver(ctx, diagnostics)
  const dispose = observer.subscribe()
  const outcome = await ctx.waterfall('approval/request', request('session-other', 'call-2'), () => 'host-fallback')
  assert.equal(outcome, 'host-fallback')
  assert.deepEqual(diagnostics, [{
    event: 'approval_unhandled',
    reason: 'no_active_ticket',
    agentId: 'session-other',
    toolName: 'bash',
    callId: 'call-2',
  }])
  dispose()
}

// Missing agent identity and Ria's own session are recorded separately.
{
  const ctx = new Context()
  const diagnostics = []
  const observer = makeObserver(ctx, diagnostics)
  const dispose = observer.subscribe()
  assert.equal(await ctx.waterfall('approval/request', request(undefined, 'call-3'), () => 'host'), 'host')
  assert.equal(await ctx.waterfall('approval/request', request('session-ria', 'call-4'), () => 'host'), 'host')
  assert.deepEqual(diagnostics.map(entry => entry.reason), ['no_agent', 'ria_session'])
  dispose()
}

console.log('approval ordering ok')
