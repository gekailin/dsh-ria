#!/usr/bin/env node
/**
 * archive-workers.mjs — archive Ria worker sessions through the canonical DSH
 * Connection RPC channel (no state-file editing, no session deletion).
 *
 * Channel (see reports/done.md for the full evidence chain):
 *   POST http://<dsh-web>/api/workspace/archiveSession
 *   body: { type: "client-request", rpcId, method: "workspace/archiveSession",
 *           payload: { args: { request: { sessionId, stopActivity } } } }
 *   -> dsh-api-gateway dispatchRpc -> workspaceController.archiveSession
 *   -> ctx.workspaceRegistry.archiveSession(sessionId, { stopActivity })
 *
 * Auth: the DSH web process launch token is exchanged once for the browser
 * session cookie, exactly as a browser opening the printed URL does.
 *
 * Usage:
 *   node scripts/archive-workers.mjs --seqs 7,9,10 --dry-run
 *   node scripts/archive-workers.mjs --sessions session-a,session-b --apply
 *   node scripts/archive-workers.mjs --seqs 7,9 --apply
 *   node scripts/archive-workers.mjs --readback 7,9,10
 *
 * Options:
 *   --seqs <a,b,c>        Ria worker seq numbers (resolved from GET /plugins/dsh-ria/api/state)
 *   --sessions <a,b,c>    explicit session ids (overrides --seqs)
 *   --base <url>          DSH web base URL (default http://127.0.0.1:3080)
 *   --token <token>       launch token (default: $DSH_WEB_TOKEN, then
 *                         ~/.dsh/daemon/.web-auth-url)
 *   --dry-run             probe only: read session state, do not archive
 *   --apply               archive each target (stopActivity: true)
 *   --readback            re-call archiveSession for each id: an already
 *                         archived id is an idempotent no-op that returns the
 *                         live archive set, so membership is read back from the
 *                         running host (no side effect)
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const args = process.argv.slice(2)
const flag = name => args.includes('--' + name)
const value = name => {
  const at = args.indexOf('--' + name)
  return at === -1 ? undefined : args[at + 1]
}
const list = name => (value(name) || '').split(',').map(item => item.trim()).filter(Boolean)

const base = value('base') || 'http://127.0.0.1:3080'
const dryRun = flag('dry-run')
const apply = flag('apply')
const readback = flag('readback')
const sessionIds = list('sessions')
const seqs = list('seqs').map(Number)

function launchToken() {
  if (value('token')) return value('token')
  if (process.env.DSH_WEB_TOKEN) return process.env.DSH_WEB_TOKEN
  const raw = readFileSync(join(homedir(), '.dsh/daemon/.web-auth-url'), 'utf8').trim()
  const token = new URL(raw).searchParams.get('token')
  if (!token) throw new Error('no launch token in ~/.dsh/daemon/.web-auth-url')
  return token
}

async function connect() {
  // Same handshake a browser performs: the process launch token mints the
  // authority-bound session cookie.
  const response = await fetch(base + '/?token=' + encodeURIComponent(launchToken()), { redirect: 'manual' })
  const cookies = (response.headers.getSetCookie?.() || []).map(item => item.split(';')[0])
  if (!cookies.length) throw new Error('launch token exchange returned no cookie (status ' + response.status + ')')
  const cookie = cookies.join('; ')
  async function rpc(method, payloadArgs, rpcId) {
    const response = await fetch(base + '/api/' + method, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({
        type: 'client-request',
        rpcId: rpcId || 'archive-workers-' + method.replace('/', '-'),
        method,
        payload: { args: payloadArgs },
      }),
    })
    if (!response.ok) throw new Error(method + ' HTTP ' + response.status + ': ' + (await response.text()))
    const body = await response.json()
    if (body.type !== 'server-response') throw new Error(method + ' returned an unexpected envelope')
    return body.result
  }
  return { rpc, cookie }
}

const { rpc, cookie } = await connect()

let targets = []
if (sessionIds.length) {
  targets = sessionIds.map(id => ({ sessionId: id, seq: null }))
} else if (seqs.length) {
  // Ria's own HTTP state projection lists every bound worker with its seq.
  const response = await fetch(base + '/plugins/dsh-ria/api/state', { headers: { cookie } }).catch(() => null)
  const state = response && response.ok ? await response.json() : null
  const workers = (state && state.v2 && state.v2.workers) || []
  for (const seq of seqs) {
    const row = workers.find(item => Number(item.seq) === seq)
    if (!row) {
      console.error('seq ' + seq + ': not present in Ria /state workers')
      continue
    }
    targets.push({ sessionId: String(row.sessionId), seq })
  }
}

if (!targets.length) {
  console.error('nothing to do: pass --seqs or --sessions')
  process.exit(1)
}

const out = { base, mode: dryRun ? 'dry-run' : (apply ? 'apply' : (readback ? 'readback' : 'probe')), targets: [] }

for (const target of targets) {
  const entry = { seq: target.seq, sessionId: target.sessionId }
  const state = await rpc('session/state', { request: { sessionId: target.sessionId } }, 'state-' + target.sessionId)
  if (state && state.ok) {
    const value = state.value || {}
    entry.before = { running: value.running, active: value.active, queue: (value.queue || []).length, pendingInput: value.pendingInput || [] }
  } else {
    entry.before = { error: state && state.error ? state.error : state }
  }
  if (apply && !dryRun) {
    const result = await rpc('workspace/archiveSession', {
      request: { sessionId: target.sessionId, stopActivity: true },
    }, 'archive-' + target.sessionId)
    entry.archive = result && result.ok
      ? { ok: true, archived: (result.value.archivedSessionIds || []).includes(target.sessionId), archivedCount: (result.value.archivedSessionIds || []).length }
      : { ok: false, error: result && result.error ? result.error : result }
  } else if (readback) {
    const result = await rpc('workspace/archiveSession', {
      request: { sessionId: target.sessionId, stopActivity: true },
    }, 'readback-' + target.sessionId)
    entry.readback = result && result.ok
      ? { ok: true, archived: (result.value.archivedSessionIds || []).includes(target.sessionId), archivedSessionIds: result.value.archivedSessionIds }
      : { ok: false, error: result && result.error ? result.error : result }
  }
  out.targets.push(entry)
}

console.log(JSON.stringify(out, null, 2))
