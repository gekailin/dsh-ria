#!/usr/bin/env node
// One-shot migration for the pure-v2 state layout.
//
// Usage:
//   node scripts/migrate-state-rw.mjs --state <stateDir> [--backup <dir>] [--dry-run]
//   node scripts/migrate-state-rw.mjs --restore <backupDir>
//
// What it does (all of it in one idempotent entry point):
//   1. v2.json: chatbotSessionId -> chatSessionId; drop advisorMode.
//   2. v2.json: lastError.scope 'chatbot' -> 'chat'.
//   3. ria.json / co-management.json: historical role id 'chatbot' -> 'chat'
//      in ticket history, resolution.by and co-management addedBy.
//   4. cognition/chatbot/ -> cognition/chat/: move files, never overwrite.
//      A conflicting target keeps the old file in cognition/chatbot/ and is
//      reported; nothing is reset or deleted.
//
// Safety:
//   * A timestamped backup is written before the first change. The absolute
//     path is printed and stored in the manifest.
//   * Re-running is a no-op: the plan is computed first and no backup is made
//     when there is nothing to change.
//   * --restore copies the backed-up files back (rollback).
//   * --dry-run prints the plan and writes nothing.
//
// SQLite note: ticket_history is append-only (triggers reject UPDATE/DELETE),
// so historical 'chatbot' actors in ria.sqlite are normalized on read by
// normalizeTicket. The migration never rewrites the database.

import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const HISTORICAL_CHAT = 'chatbot'
const CURRENT_CHAT = 'chat'

function fail(message) {
  process.stderr.write('migrate-state: ' + message + '\n')
  process.exit(1)
}

function parseArgs(argv) {
  const out = { state: '', backup: '', restore: '', dryRun: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--state') out.state = argv[++index] || ''
    else if (arg === '--backup') out.backup = argv[++index] || ''
    else if (arg === '--restore') out.restore = argv[++index] || ''
    else if (arg === '--dry-run') out.dryRun = true
    else if (arg === '--help' || arg === '-h') {
      process.stdout.write('usage: node scripts/migrate-state-rw.mjs --state <stateDir> [--backup <dir>] [--dry-run]\n       node scripts/migrate-state-rw.mjs --restore <backupDir>\n')
      process.exit(0)
    } else fail('unknown argument: ' + arg)
  }
  return out
}

const stamp = () => new Date().toISOString().replace(/[:.]/g, '-')

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'))
}

function writeJsonAtomic(file, value) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  const temp = file + '.tmp-' + process.pid
  writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 })
  renameSync(temp, file)
}

function readJsonIfValid(file, warnings) {
  if (!existsSync(file)) return null
  try {
    return readJson(file)
  } catch (error) {
    warnings.push({ file, message: 'not valid JSON, left untouched: ' + String(error && error.message ? error.message : error) })
    return null
  }
}

function planV2(stateDir, warnings) {
  const file = join(stateDir, 'v2.json')
  const data = readJsonIfValid(file, warnings)
  if (!data || typeof data !== 'object' || Array.isArray(data)) return { file, data: null, changes: [], conflicts: [] }
  const changes = []
  const conflicts = []
  const legacyChat = data.chatbotSessionId
  if (legacyChat !== undefined && legacyChat !== null) {
    if (data.chatSessionId === undefined || data.chatSessionId === null) {
      data.chatSessionId = legacyChat
      delete data.chatbotSessionId
      changes.push({ field: 'chatbotSessionId', to: 'chatSessionId' })
    } else if (String(data.chatSessionId) === String(legacyChat)) {
      delete data.chatbotSessionId
      changes.push({ field: 'chatbotSessionId', to: 'chatSessionId', note: 'equal values deduped' })
    } else {
      conflicts.push({ kind: 'chat_session_id', kept: 'chatSessionId', keptValue: String(data.chatSessionId), legacyValue: String(legacyChat) })
    }
  }
  if (Object.prototype.hasOwnProperty.call(data, 'advisorMode')) {
    delete data.advisorMode
    changes.push({ field: 'advisorMode', to: '(removed)' })
  }
  if (data.lastError && typeof data.lastError === 'object' && data.lastError.scope === HISTORICAL_CHAT) {
    data.lastError.scope = CURRENT_CHAT
    changes.push({ field: 'lastError.scope', to: CURRENT_CHAT })
  }
  // A cached system prompt still points at cognition/chatbot/; drop it so the
  // next Sage start regenerates it from the current prompts.
  if (data.sagePromptText !== undefined && data.sagePromptText !== null) {
    delete data.sagePromptText
    changes.push({ field: 'sagePromptText', to: '(removed so it regenerates)' })
  }
  return { file, data, changes, conflicts }
}

function mapHistoricalRole(value) {
  return value === HISTORICAL_CHAT ? CURRENT_CHAT : value
}

function planTickets(stateDir, fileName, warnings) {
  const file = join(stateDir, fileName)
  const data = readJsonIfValid(file, warnings)
  if (!data || typeof data !== 'object') return { file, data: null, changes: [] }
  let changed = 0
  if (Array.isArray(data.tickets)) {
    for (const ticket of data.tickets) {
      if (!ticket || typeof ticket !== 'object') continue
      if (ticket.executor === HISTORICAL_CHAT) { ticket.executor = CURRENT_CHAT; changed += 1 }
      if (Array.isArray(ticket.history)) {
        for (const entry of ticket.history) {
          if (entry && entry.actor === HISTORICAL_CHAT) { entry.actor = CURRENT_CHAT; changed += 1 }
        }
      }
      if (ticket.resolution && ticket.resolution.by === HISTORICAL_CHAT) { ticket.resolution.by = CURRENT_CHAT; changed += 1 }
      if (ticket.attempt && ticket.attempt.actor === HISTORICAL_CHAT) { ticket.attempt.actor = CURRENT_CHAT; changed += 1 }
    }
  }
  return { file, data: changed ? data : null, changes: changed ? [{ field: fileName, actors: changed }] : [] }
}

function planCoManagement(stateDir, warnings) {
  const file = join(stateDir, 'co-management.json')
  const data = readJsonIfValid(file, warnings)
  if (!data) return { file, data: null, changes: [] }
  let changed = 0
  const visit = list => {
    if (!Array.isArray(list)) return
    for (const item of list) {
      if (item && item.addedBy === HISTORICAL_CHAT) { item.addedBy = CURRENT_CHAT; changed += 1 }
    }
  }
  for (const value of Object.values(data)) {
    if (Array.isArray(value)) visit(value)
    else if (value && typeof value === 'object') {
      visit(value.items)
      visit(value.sessions)
    }
  }
  return { file, data: changed ? data : null, changes: changed ? [{ field: 'co-management.json', actors: changed }] : [] }
}

function planCognition(stateDir, warnings) {
  const fromDir = join(stateDir, 'cognition', HISTORICAL_CHAT)
  const toDir = join(stateDir, 'cognition', CURRENT_CHAT)
  const moves = []
  const conflicts = []
  if (!existsSync(fromDir) || !statSync(fromDir).isDirectory()) return { fromDir, toDir, moves, conflicts }
  for (const name of readdirSync(fromDir).sort()) {
    const source = join(fromDir, name)
    if (!statSync(source).isFile()) continue
    const target = join(toDir, name)
    if (existsSync(target)) conflicts.push({ kind: 'cognition_file', name, kept: 'cognition/chatbot/' + name })
    else moves.push({ name, source, target })
  }
  return { fromDir, toDir, moves, conflicts }
}

function backupState(stateDir, backupRoot, plan) {
  const dir = join(resolve(backupRoot), 'state-rw-' + stamp())
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const copied = []
  for (const name of ['v2.json', 'ria.json', 'co-management.json']) {
    const source = join(stateDir, name)
    if (!existsSync(source)) continue
    copyFileSync(source, join(dir, name))
    copied.push(name)
  }
  const cognition = join(stateDir, 'cognition')
  if (existsSync(cognition)) {
    cpSync(cognition, join(dir, 'cognition'), { recursive: true })
    copied.push('cognition/')
  }
  const manifest = {
    version: 1,
    createdAt: new Date().toISOString(),
    stateDir: resolve(stateDir),
    backupDir: dir,
    copied,
    changes: plan.changes,
    conflicts: plan.conflicts,
    moves: plan.moves || [],
  }
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 })
  return dir
}

function restore(backupDir) {
  const dir = resolve(backupDir)
  const manifestFile = join(dir, 'manifest.json')
  if (!existsSync(manifestFile)) fail('not a migration backup (manifest.json missing): ' + dir)
  const manifest = readJson(manifestFile)
  const stateDir = resolve(manifest.stateDir)
  if (!existsSync(stateDir)) fail('original state dir no longer exists: ' + stateDir)
  const restored = []
  for (const name of ['v2.json', 'ria.json', 'co-management.json']) {
    if (!existsSync(join(dir, name))) continue
    copyFileSync(join(dir, name), join(stateDir, name))
    restored.push(name)
  }
  if (existsSync(join(dir, 'cognition'))) {
    cpSync(join(dir, 'cognition'), join(stateDir, 'cognition'), { recursive: true })
    restored.push('cognition/')
  }
  // Remove files this migration created in cognition/chat/. They were only
  // written when the target was absent, so deleting them is a true rollback.
  for (const move of Array.isArray(manifest.moves) ? manifest.moves : []) {
    const target = join(stateDir, 'cognition', CURRENT_CHAT, move.name)
    if (existsSync(target)) unlinkSync(target)
  }
  try {
    const chatDir = join(stateDir, 'cognition', CURRENT_CHAT)
    if (existsSync(chatDir) && !readdirSync(chatDir).length) rmdirSync(chatDir)
  } catch { /* a leftover empty dir is harmless */ }
  process.stdout.write(JSON.stringify({ restored, stateDir, backupDir: dir }, null, 2) + '\n')
}

const args = parseArgs(process.argv.slice(2))
if (args.restore) {
  restore(args.restore)
  process.exit(0)
}
if (!args.state) fail('--state is required (pass the Ria state directory explicitly)')
const stateDir = resolve(args.state)
if (!existsSync(stateDir) || !statSync(stateDir).isDirectory()) fail('state dir does not exist: ' + stateDir)

const warnings = []
const v2 = planV2(stateDir, warnings)
const ria = planTickets(stateDir, 'ria.json', warnings)
const co = planCoManagement(stateDir, warnings)
const cognition = planCognition(stateDir, warnings)
const changes = [...v2.changes, ...ria.changes, ...co.changes, ...cognition.moves.map(move => ({ field: 'cognition', move: move.name + ' -> cognition/chat/' + move.name }))]
const conflicts = [...v2.conflicts, ...cognition.conflicts]
const plan = { changes, conflicts, moves: cognition.moves.map(move => ({ name: move.name })) }
if (existsSync(join(stateDir, 'ria.sqlite'))) {
  warnings.push({ file: 'ria.sqlite', message: 'SQLite ticket_history is append-only; historical chatbot actors are normalized on read, not rewritten' })
}

if (args.dryRun) {
  process.stdout.write(JSON.stringify({ dryRun: true, stateDir, plan, warnings }, null, 2) + '\n')
  process.exit(0)
}
if (!changes.length) {
  process.stdout.write(JSON.stringify({ stateDir, changed: false, backupDir: null, plan, warnings }, null, 2) + '\n')
  process.exit(0)
}
const backupDir = backupState(stateDir, args.backup || join(dirname(stateDir), 'ria-migration-backups'), plan)
if (v2.data) writeJsonAtomic(v2.file, v2.data)
if (ria.data) writeJsonAtomic(ria.file, ria.data)
if (co.data) writeJsonAtomic(co.file, co.data)
if (cognition.moves.length) {
  mkdirSync(cognition.toDir, { recursive: true, mode: 0o700 })
  for (const move of cognition.moves) renameSync(move.source, move.target)
  try {
    if (!readdirSync(cognition.fromDir).length) rmdirSync(cognition.fromDir)
  } catch { /* a leftover empty dir is harmless */ }
}
process.stdout.write(JSON.stringify({ stateDir, changed: true, backupDir, plan, warnings }, null, 2) + '\n')
