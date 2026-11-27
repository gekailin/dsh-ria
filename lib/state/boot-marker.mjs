// Process-lifetime boot marker: the durable evidence that separates a restart
// from a first boot, and a clean stop from a crash.
//
// One small JSON file per Ria state directory:
//   { "pid": 1234, "startedAt": 1795..., "cleanExit": false }
//
// Written at plugin construction (cleanExit=false), flipped to true by the exit
// hooks on SIGTERM/SIGINT/exit/beforeExit. The NEXT boot reads it: a different
// pid means this process replaced another one, and cleanExit decides whether
// the previous one stopped on purpose or was killed/crashed.
//
// Nothing here throws: a boot marker is diagnostics, never a startup gate.

import { join } from 'node:path'
import { readJsonSafe, writeJsonAtomic } from '../shared/fs.mjs'

export const BOOT_FILE_NAME = 'boot.json'

/** Absolute path of the boot marker inside one state directory. */
export function bootMarkerPath(stateDir) {
  return join(String(stateDir || ''), BOOT_FILE_NAME)
}

/**
 * Read the previous boot marker.
 * @param {string} stateDir - Ria state directory.
 * @returns {{pid: number, startedAt: number, cleanExit: boolean} | null} the
 *   marker, or null when the file is missing, unreadable, or not a marker.
 */
export function readBootMarker(stateDir) {
  if (!stateDir) return null
  const value = readJsonSafe(bootMarkerPath(stateDir), null)
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const pid = Number(value.pid)
  if (!Number.isSafeInteger(pid) || pid <= 0) return null
  const startedAt = Number(value.startedAt)
  return {
    pid,
    startedAt: Number.isSafeInteger(startedAt) && startedAt > 0 ? startedAt : 0,
    cleanExit: value.cleanExit === true,
  }
}

/**
 * Publish one boot marker atomically (tmp + rename, see shared/fs.mjs).
 * @param {string} stateDir - Ria state directory.
 * @param {{pid?: number, startedAt?: number, cleanExit?: boolean}} marker - values to write.
 * @param {{pid?: number, now?: () => number}} options - test seams.
 * @returns {{pid: number, startedAt: number, cleanExit: boolean} | null} the written marker, null on failure.
 */
export function writeBootMarker(stateDir, marker = {}, options = {}) {
  if (!stateDir) return null
  const fallbackPid = Number.isSafeInteger(options.pid) && options.pid > 0 ? options.pid : process.pid
  const requestedPid = Number(marker.pid === undefined ? fallbackPid : marker.pid)
  const pid = Number.isSafeInteger(requestedPid) && requestedPid > 0 ? requestedPid : fallbackPid
  const now = typeof options.now === 'function' ? options.now : Date.now
  const requestedAt = Number(marker.startedAt)
  const startedAt = Number.isSafeInteger(requestedAt) && requestedAt > 0 ? requestedAt : Math.trunc(now())
  const data = { pid, startedAt, cleanExit: marker.cleanExit === true }
  try {
    writeJsonAtomic(bootMarkerPath(stateDir), data)
    return data
  } catch {
    return null
  }
}

/**
 * Flip the CURRENT process's marker to cleanExit=true. Idempotent, and a no-op
 * when the marker belongs to another pid (a stale file must never be rewritten
 * by whichever process happens to exit last).
 * @param {string} stateDir - Ria state directory.
 * @param {{pid?: number}} options - test seam.
 * @returns {boolean} whether the marker now says cleanExit=true.
 */
export function markCleanExit(stateDir, options = {}) {
  const pid = Number.isSafeInteger(options.pid) && options.pid > 0 ? options.pid : process.pid
  const prev = readBootMarker(stateDir)
  if (!prev) return false
  if (prev.pid !== pid) return prev.cleanExit
  if (prev.cleanExit) return true
  const written = writeBootMarker(stateDir, { pid: prev.pid, startedAt: prev.startedAt, cleanExit: true })
  return written !== null
}

/**
 * Decide what this boot is, from the previous marker and the current pid.
 * @param {{pid: number, cleanExit: boolean} | null} prev - previous marker.
 * @param {number} pid - current process id.
 * @returns {{kind: 'first' | 'same_process' | 'restart', reason: 'clean_restart' | 'abnormal_exit' | null}} classification.
 */
export function classifyBoot(prev, pid = process.pid) {
  if (!prev) return { kind: 'first', reason: null }
  if (Number(prev.pid) === Number(pid)) return { kind: 'same_process', reason: null }
  return { kind: 'restart', reason: prev.cleanExit === true ? 'clean_restart' : 'abnormal_exit' }
}

/**
 * One self-contained Chat notice line (queueChatNotice collapses whitespace, so
 * the separator is explicit and the whole notice stays one message).
 * @param {{prevPid: number, newPid: number, reason: string, recoveredTickets?: number, startupMs?: number}} details - notice facts.
 * @returns {string} the notice text.
 */
export function formatRestartNotice(details = {}) {
  const prevPid = Number.isSafeInteger(details.prevPid) ? details.prevPid : '?'
  const newPid = Number.isSafeInteger(details.newPid) ? details.newPid : '?'
  const label = details.reason === 'abnormal_exit' ? '异常退出' : '正常重启'
  const recovered = Number.isSafeInteger(details.recoveredTickets) && details.recoveredTickets > 0
    ? details.recoveredTickets
    : 0
  const seconds = Number.isFinite(details.startupMs) && details.startupMs >= 0
    ? (details.startupMs / 1000).toFixed(1)
    : '0.0'
  return '🔔 Ria 已重启（PID ' + prevPid + ' → ' + newPid + '，' + label + '） · 恢复工单 ' + recovered + ' 张 · 启动耗时 ' + seconds + ' s'
}

/**
 * Read the previous marker, classify this boot, then publish the current one
 * (cleanExit=false). The read MUST happen before the write, so the previous
 * process's verdict is never overwritten by this one.
 * @param {string} stateDir - Ria state directory.
 * @param {{pid?: number, now?: () => number}} options - test seams.
 * @returns {{prev: object | null, current: object | null, classification: object, capturedAt: number}} boot record.
 */
export function captureBoot(stateDir, options = {}) {
  const pid = Number.isSafeInteger(options.pid) && options.pid > 0 ? options.pid : process.pid
  const now = typeof options.now === 'function' ? options.now : Date.now
  const prev = readBootMarker(stateDir)
  const classification = classifyBoot(prev, pid)
  const current = writeBootMarker(stateDir, { pid, startedAt: now(), cleanExit: false })
  return { prev, current, classification, capturedAt: now() }
}

// The hook targets the most recently started Ria instance. Install is
// process-wide and idempotent: a plugin loaded twice must not register two
// SIGTERM handlers, and a test that re-points the state directory must not leak
// listeners.
let activeStateDir = ''
let hooksInstalled = false

const runCleanExit = () => {
  if (!activeStateDir) return
  try {
    markCleanExit(activeStateDir)
  } catch { /* a boot marker must never break shutdown */ }
}

/**
 * Install the process exit hooks ONCE and point them at this state directory.
 * Signals keep their default behaviour: when ours is the only listener we
 * re-raise the signal after writing the marker, so the host's shutdown path is
 * never blocked by a diagnostics file.
 * @param {string} stateDir - Ria state directory (the latest instance wins).
 * @param {{proc?: NodeJS.Process, logger?: (level: string, message: string) => void}} options - test seams.
 * @returns {() => void} idempotent disposer (removes the hooks only if this call installed them).
 */
export function installBootExitHooks(stateDir, options = {}) {
  activeStateDir = String(stateDir || '')
  const proc = options.proc || process
  if (hooksInstalled) return () => {}
  hooksInstalled = true
  const log = typeof options.logger === 'function' ? options.logger : () => {}
  const handlers = new Map()
  const fail = error => {
    try { log('warn', 'boot clean-exit hook failed: ' + String(error && error.message ? error.message : error)) } catch { /* logging must not throw */ }
  }
  const installSignal = signal => {
    const handler = () => {
      runCleanExit()
      try {
        // Another listener owns shutdown (the host): leave it alone.
        if (proc.listenerCount(signal) > 1) return
        proc.removeListener(signal, handler)
        handlers.delete(signal)
        // Restore the signal's default termination; without this a registered
        // listener would swallow SIGTERM and the process would never stop.
        proc.kill(proc.pid, signal)
      } catch (error) { fail(error) }
    }
    handlers.set(signal, handler)
    proc.on(signal, handler)
  }
  installSignal('SIGTERM')
  installSignal('SIGINT')
  const onExit = () => runCleanExit()
  proc.on('exit', onExit)
  proc.on('beforeExit', onExit)
  return () => {
    if (!hooksInstalled) return
    hooksInstalled = false
    for (const [signal, handler] of handlers) {
      try { proc.removeListener(signal, handler) } catch { /* already gone */ }
    }
    try { proc.removeListener('exit', onExit) } catch { /* already gone */ }
    try { proc.removeListener('beforeExit', onExit) } catch { /* already gone */ }
    handlers.clear()
  }
}
