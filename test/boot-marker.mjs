import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  bootMarkerPath, captureBoot, classifyBoot, formatRestartNotice,
  installBootExitHooks, markCleanExit, readBootMarker, writeBootMarker,
} from '../lib/state/boot-marker.mjs'

const dir = mkdtempSync(join(tmpdir(), 'ria-boot-marker-'))
try {
  // 1) Missing marker = first boot. captureBoot then publishes this process.
  assert.equal(readBootMarker(dir), null)
  assert.equal(readBootMarker(join(dir, 'missing')), null)
  const first = captureBoot(dir, { pid: 2222, now: () => 1000 })
  assert.equal(first.classification.kind, 'first')
  assert.equal(first.classification.reason, null)
  assert.deepEqual(first.current, { pid: 2222, startedAt: 1000, cleanExit: false })
  assert.deepEqual(readBootMarker(dir), { pid: 2222, startedAt: 1000, cleanExit: false })

  // 2) A corrupt marker is not a crash: it reads as null and boots as first.
  const corrupt = mkdtempSync(join(tmpdir(), 'ria-boot-corrupt-'))
  try {
    writeFileSync(bootMarkerPath(corrupt), '{not json')
    assert.equal(readBootMarker(corrupt), null)
    assert.equal(captureBoot(corrupt, { pid: 10, now: () => 5 }).classification.kind, 'first')
  } finally { rmSync(corrupt, { recursive: true, force: true }) }

  // 3) A marker without a usable pid is ignored (never a restart from garbage).
  const garbage = mkdtempSync(join(tmpdir(), 'ria-boot-garbage-'))
  try {
    writeFileSync(bootMarkerPath(garbage), JSON.stringify({ pid: 'abc', startedAt: 1, cleanExit: true }))
    assert.equal(readBootMarker(garbage), null)
  } finally { rmSync(garbage, { recursive: true, force: true }) }

  // 4) Different pid + cleanExit true = clean restart.
  writeBootMarker(dir, { pid: 1111, startedAt: 900, cleanExit: true })
  const clean = captureBoot(dir, { pid: 2222, now: () => 2000 })
  assert.equal(clean.prev.pid, 1111)
  assert.equal(clean.classification.kind, 'restart')
  assert.equal(clean.classification.reason, 'clean_restart')
  // The write replaces the previous process's marker with this one.
  assert.deepEqual(readBootMarker(dir), { pid: 2222, startedAt: 2000, cleanExit: false })

  // 5) Different pid + cleanExit false (or missing) = abnormal exit.
  writeBootMarker(dir, { pid: 3333, startedAt: 800, cleanExit: false })
  assert.equal(classifyBoot(readBootMarker(dir), 4444).reason, 'abnormal_exit')
  writeBootMarker(dir, { pid: 3333, startedAt: 800 })
  assert.equal(classifyBoot(readBootMarker(dir), 4444).reason, 'abnormal_exit')

  // 6) Same pid = same process (a service re-created in one process).
  writeBootMarker(dir, { pid: 5555, startedAt: 700, cleanExit: false })
  assert.equal(classifyBoot(readBootMarker(dir), 5555).kind, 'same_process')
  assert.equal(classifyBoot(null, 5555).kind, 'first')

  // 7) markCleanExit only touches this process's marker and is idempotent.
  writeBootMarker(dir, { pid: 6666, startedAt: 600, cleanExit: false })
  assert.equal(markCleanExit(dir, { pid: 7777 }), false, 'foreign pid must not rewrite the marker')
  assert.equal(readBootMarker(dir).cleanExit, false)
  assert.equal(markCleanExit(dir, { pid: 6666 }), true)
  assert.equal(readBootMarker(dir).cleanExit, true)
  assert.equal(readBootMarker(dir).startedAt, 600, 'startedAt survives the clean-exit flip')
  assert.equal(markCleanExit(dir, { pid: 6666 }), true, 'second mark is a no-op success')
  assert.equal(markCleanExit(join(dir, 'missing'), { pid: 6666 }), false)

  // 8) Notice format: single self-contained line with both PIDs and the facts.
  const cleanNotice = formatRestartNotice({ prevPid: 1111, newPid: 2222, reason: 'clean_restart', recoveredTickets: 2, startupMs: 1234 })
  assert.match(cleanNotice, /^🔔 Ria 已重启（PID 1111 → 2222，正常重启） · 恢复工单 2 张 · 启动耗时 1\.2 s$/)
  const abnormalNotice = formatRestartNotice({ prevPid: 3333, newPid: 4444, reason: 'abnormal_exit', recoveredTickets: 0, startupMs: 90_000 })
  assert.match(abnormalNotice, /异常退出/)
  assert.match(abnormalNotice, /恢复工单 0 张/)
  assert.match(abnormalNotice, /启动耗时 90\.0 s/)
  assert.equal(abnormalNotice.includes('\n'), false, 'queueChatNotice would flatten it anyway; keep one line')

  // 9) Exit hooks are process-wide and idempotent; the SIGTERM handler marks clean.
  const hookDir = mkdtempSync(join(tmpdir(), 'ria-boot-hooks-'))
  const dummy = () => {}
  const baseline = process.listenerCount('SIGTERM')
  process.on('SIGTERM', dummy)
  try {
    writeBootMarker(hookDir, { pid: process.pid, startedAt: 500, cleanExit: false })
    const dispose = installBootExitHooks(hookDir, {})
    const installed = process.listenerCount('SIGTERM')
    assert.equal(installed, baseline + 2, 'one SIGTERM handler for the first install only')
    // A second listener exists (dummy), so ours only writes the marker and
    // returns instead of re-raising the signal.
    const ours = () => {
      const handlers = process.listeners('SIGTERM')
      handlers[handlers.length - 1]()
    }
    ours()
    assert.equal(readBootMarker(hookDir).cleanExit, true, 'the hook flips this process marker')
    // Re-pointing at another instance keeps the same handlers and follows the
    // newest state directory (a second plugin load must not stack listeners).
    const secondDir = join(hookDir, 'second')
    writeBootMarker(secondDir, { pid: process.pid, startedAt: 550, cleanExit: false })
    installBootExitHooks(secondDir, {})
    assert.equal(process.listenerCount('SIGTERM'), installed, 'second install must not add handlers')
    ours()
    assert.equal(readBootMarker(secondDir).cleanExit, true, 'the hook follows the latest state directory')
    dispose()
    assert.equal(process.listenerCount('SIGTERM'), baseline + 1, 'dispose removes only our handlers')
  } finally {
    process.removeListener('SIGTERM', dummy)
    rmSync(hookDir, { recursive: true, force: true })
  }

  // 10) The marker file is valid JSON with the documented shape.
  const raw = JSON.parse(readFileSync(bootMarkerPath(dir), 'utf8'))
  assert.deepEqual(Object.keys(raw).sort(), ['cleanExit', 'pid', 'startedAt'])

  console.log('boot marker ok')
} finally {
  rmSync(dir, { recursive: true, force: true })
}
