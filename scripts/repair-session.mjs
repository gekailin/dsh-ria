#!/usr/bin/env node
// scripts/repair-session.mjs — 修复「会话日志被截断成单帧后从 session/list 消失」
//
// 背景：DSH 用 zstd 前缀（header）解码读取会话日志。截断脚本若把整段内容重压成
// 单个大 frame，前缀解码会失败，session/list 静默跳过该会话；同时过期的
// session_projcache 仍引用旧 seq，会让投影与日志不一致。
//
// 本工具默认 dry-run，--apply 才写。步骤：
//   1. 备份日志（copy，.bak-reframe-<ts>），不删除正文
//   2. 只有 1 个 frame 时，按 --chunk-size（默认 64KB）逐块压缩（每帧带 XXH64
//      checksum，第一帧含 header 行）后拼接；校验解压内容的 sha256 与原地一致，
//      再 fsync + 原子 rename
//   3. 备份并移除该会话的 projcache（让宿主冷读重建），--keep-projcache 可跳过
//
// 用法：
//   node scripts/repair-session.mjs --session <id> [--dsh-home ~/.dsh]
//        [--projcache-dir <dir>] [--chunk-size 65536] [--keep-projcache] [--apply]
//
// 约束：不访问网络、不重启服务。

import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, openSync, fsyncSync, closeSync, chmodSync } from 'node:fs'
import { constants as zc, zstdCompressSync } from 'node:zlib'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

function parseArgs(argv) {
  const out = { apply: false, chunkSize: 64 * 1024, keepProjcache: false, dshHome: join(homedir(), '.dsh') }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--apply') out.apply = true
    else if (a === '--keep-projcache') out.keepProjcache = true
    else if (a === '--session') out.session = argv[++i]
    else if (a === '--dsh-home') out.dshHome = argv[++i]
    else if (a === '--projcache-dir') out.projcacheDir = argv[++i]
    else if (a === '--chunk-size') out.chunkSize = Number(argv[++i])
    else throw new Error('unknown argument: ' + a)
  }
  if (!out.session) throw new Error('--session <id> is required')
  if (!Number.isFinite(out.chunkSize) || out.chunkSize < 4096) throw new Error('--chunk-size must be >= 4096')
  return out
}

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { maxBuffer: 1024 * 1024 * 1024, ...opts })
const zstdcat = (path) => run('zstdcat', [path])

function findSessionDir(dshHome, sessionId) {
  const root = join(dshHome, 'sessions')
  for (const ws of readdirSync(root)) {
    const dir = join(root, ws, sessionId)
    if (existsSync(dir)) return dir
  }
  throw new Error('session dir not found for ' + sessionId)
}

function frameCount(path) {
  const m = run('zstd', ['-l', path]).toString().match(/^\s*(\d+)\s+\d+\s/m)
  return m ? Number(m[1]) : -1
}

function reframe(content, chunkSize) {
  const frames = []
  for (let off = 0; off < content.length; off += chunkSize) {
    const chunk = content.subarray(off, Math.min(off + chunkSize, content.length))
    frames.push(zstdCompressSync(chunk, { params: { [zc.ZSTD_c_checksumFlag]: 1 } }))
  }
  return Buffer.concat(frames)
}

function main() {
  const opts = parseArgs(process.argv.slice(2))
  const dir = findSessionDir(opts.dshHome, opts.session)
  const logPath = join(dir, 'session.v4.jsonl.zstd')
  const projcacheDir = opts.projcacheDir || join(opts.dshHome, 'storages', 'session_projcache', 'sessions')
  const projcachePath = join(projcacheDir, opts.session + '.json')
  const ts = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)

  console.log('session dir   :', dir)
  console.log('log           :', logPath, statSync(logPath).size, 'bytes')
  const framesBefore = frameCount(logPath)
  const content = zstdcat(logPath)
  const contentSha = sha256(content)
  const text = content.toString('utf8')
  const lines = text.split('\n')
  const lastLine = JSON.parse(lines[lines.length - 1] || lines[lines.length - 2])
  console.log('frames before :', framesBefore)
  console.log('content sha256:', contentSha)
  console.log('lines         :', text.split('\n').filter(Boolean).length)
  console.log('last event    :', JSON.stringify({ type: lastLine.type, seq: lastLine.seq, time: lastLine.time }))
  console.log('projcache     :', existsSync(projcachePath) ? projcachePath : '(absent)')
  console.log('mode          :', opts.apply ? 'APPLY' : 'dry-run (add --apply to write)')

  const needReframe = framesBefore === 1
  if (!needReframe) console.log('reframe       : skipped (frames > 1)')
  if (!opts.apply) {
    console.log('would reframe :', needReframe)
    if (!opts.keepProjcache) console.log('would remove  :', projcachePath)
    return
  }

  if (needReframe) {
    const bak = logPath + '.bak-reframe-' + ts
    copyFileSync(logPath, bak)
    if (statSync(bak).size !== statSync(logPath).size) throw new Error('backup size mismatch')
    console.log('backup        :', bak)

    const packed = reframe(content, opts.chunkSize)
    const tmp = join(dir, '.session.v4.jsonl.zstd.reframe-' + ts)
    writeFileSync(tmp, packed)
    const fd = openSync(tmp, 'r')
    fsyncSync(fd)
    closeSync(fd)
    chmodSync(tmp, 0o600)
    const framesAfter = frameCount(tmp)
    if (framesAfter <= 1) throw new Error('reframed file still has <= 1 frame')
    if (sha256(zstdcat(tmp)) !== contentSha) throw new Error('reframed content sha256 mismatch — aborting')
    console.log('frames after  :', framesAfter)
    renameSync(tmp, logPath)
    console.log('replaced      :', logPath)
  }

  if (!opts.keepProjcache && existsSync(projcachePath)) {
    const pjBak = projcachePath + '.bak-' + ts
    copyFileSync(projcachePath, pjBak)
    if (sha256(readFileSync(pjBak)) !== sha256(readFileSync(projcachePath))) throw new Error('projcache backup mismatch')
    console.log('projcache bak :', pjBak)
    rmSync(projcachePath)
    console.log('projcache     : removed (rebuilt on next cold read)')
  }
  console.log('done')
}

main()
