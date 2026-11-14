// Read-only evidence tools for one daily-reflection run.
//
// A reflection worker gets these six tools only while it is bound to a run.
// Everything here is deliberately bounded: candidate sessions only, a window
// clipped to the run window, text budgets, and a single report file per run.

import { createHash, randomUUID } from 'node:crypto'
import { accessSync, closeSync, constants as fsConstants, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'
import { lastTurnEnd } from './turn-end.mjs'

export const REFLECTION_TOOLS = Object.freeze([
  'ria_reflect_status',
  'ria_reflect_read_tickets',
  'ria_reflect_read_sessions',
  'ria_reflect_read_session',
  'ria_reflect_read_context',
  'ria_reflect_report',
])

export const REFLECTION_DEFAULTS = Object.freeze({
  summaryMessages: 50,
  fullMessages: 20,
  summaryChars: 10000,
  fullChars: 40000,
  maxMessages: 200,
  maxChars: 40000,
  maxRefs: 50,
  ticketChars: 500,
  reportBytes: 30 * 1024,
  memoryBytes: 4096,
  outboxEntries: 50,
  deadlineMs: 15 * 60 * 1000,
})

const RUN_ID = /^[A-Za-z0-9._-]{1,124}$/
const REF = /^e(\d+)(?:-(\d+))?$/
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

export function charsOf(value) {
  return [...String(value == null ? '' : value)].length
}

export function clipChars(value, limit) {
  const text = String(value == null ? '' : value)
  const chars = [...text]
  if (chars.length <= limit) return text
  return chars.slice(0, limit).join('')
}

export function redact(value) {
  return String(value == null ? '' : value)
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, '[redacted]')
    .replace(/ghp_[A-Za-z0-9]{8,}/g, '[redacted]')
    .replace(/AKIA[0-9A-Z]{16}/g, '[redacted]')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]{6,}/gi, 'Bearer [redacted]')
    .replace(/((?:password|passwd|secret|api[_-]?key|cookie|token)\s*[:=]\s*)([^\s,;]+)/gi, '$1[redacted]')
}

export function textOfContent(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map(part => {
    if (!part || typeof part !== 'object') return ''
    if (part.type === 'text' || part.type === 'reasoning') return typeof part.text === 'string' ? part.text : ''
    if (part.type === 'image') return '[image]'
    if (part.type === 'file') return '[file' + (part.name ? ' ' + part.name : '') + ']'
    if (part.type === 'tool-call') return '[tool ' + (part.name || 'call') + ']'
    return ''
  }).filter(Boolean).join('\n')
}

export function normalizeEvents(records) {
  if (!Array.isArray(records)) return []
  const events = []
  for (const raw of records) {
    const event = raw && raw.type === 'event' && raw.event && typeof raw.event === 'object' ? raw.event : raw
    if (!event || typeof event !== 'object' || typeof event.type !== 'string') continue
    if (event.type === 'session') continue
    events.push(event)
  }
  return events
}

export function eventTime(event) {
  if (!event || typeof event !== 'object') return undefined
  if (Number.isFinite(event.time)) return event.time
  if (Number.isFinite(event.at)) return event.at
  if (event.data && Number.isFinite(event.data.time)) return event.data.time
  return undefined
}

export function eventTurn(event) {
  if (!event || typeof event !== 'object') return undefined
  if (Number.isSafeInteger(event.turn)) return event.turn
  if (event.data && Number.isSafeInteger(event.data.turn)) return event.data.turn
  return undefined
}

function eventData(event) {
  return event && event.data && typeof event.data === 'object' ? event.data : {}
}

function contentText(part) {
  if (!part || typeof part !== 'object') return ''
  if (part.type === 'text' || part.type === 'reasoning') return typeof part.text === 'string' ? part.text : ''
  if (part.type === 'image') return '[image]'
  if (part.type === 'file') return '[file' + (part.name ? ' ' + part.name : '') + ']'
  return ''
}

export function assistantParts(event) {
  const data = eventData(event)
  const content = data.message && Array.isArray(data.message.content) ? data.message.content : (Array.isArray(data.content) ? data.content : [])
  return content.filter(part => part && typeof part === 'object')
}

export function toolResultInfo(event) {
  const data = eventData(event)
  const message = data.message && typeof data.message === 'object' ? data.message : {}
  const text = textOfContent(message.content !== undefined ? message.content : data.content)
  const error = Boolean(
    data.isError === true || message.isError === true ||
    (data.error && typeof data.error === 'object') ||
    (typeof data.error === 'string' && data.error.trim()) ||
    (data.status === 'error')
  )
  return { text, ok: !error, callId: String(data.toolCallId || data.callId || (message.source && message.source.callId) || '') }
}

export function toolCallInfo(event) {
  const data = eventData(event)
  return {
    callId: String(data.callId || ''),
    name: String(data.name || 'tool'),
    arguments: typeof data.arguments === 'string' ? data.arguments : JSON.stringify(data.arguments === undefined ? {} : data.arguments),
  }
}

function previewOf(text) {
  return clipChars(String(text == null ? '' : text).replace(/\s+/g, ' ').trim(), 80)
}

function argumentPreview(argumentsText) {
  try {
    const value = JSON.parse(argumentsText)
    if (value && typeof value === 'object') {
      for (const key of ['description', 'goal', 'prompt', 'summary', 'file_path', 'path']) {
        if (typeof value[key] === 'string' && value[key].trim()) return value[key]
      }
      for (const item of Object.values(value)) if (typeof item === 'string' && item.trim()) return item
    }
  } catch {
    // Arguments are often truncated or not JSON; the raw text is still useful.
  }
  return argumentsText
}

export function refOf(start, end = start) {
  return start === end ? 'e' + start : 'e' + start + '-' + end
}

export function parseRef(value) {
  const match = REF.exec(String(value || ''))
  if (!match) return undefined
  const start = Number(match[1])
  const end = match[2] === undefined ? start : Number(match[2])
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start) return undefined
  return { start, end, ref: refOf(start, end) }
}

function toMs(value) {
  if (Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim()) {
    const parsed = Date.parse(value)
    if (!Number.isNaN(parsed)) return parsed
  }
  return undefined
}

function iso(value) {
  return new Date(value).toISOString()
}

export function localDate(ms = Date.now()) {
  const date = new Date(ms)
  const pad = number => String(number).padStart(2, '0')
  return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate())
}

export function makeReflectionRun(input = {}, options = {}) {
  const stateDir = String(options.stateDir || '')
  if (!stateDir) throw new Error('stateDir is required')
  const createdAt = Number.isFinite(input.createdAt) ? input.createdAt : (options.now ? options.now() : Date.now())
  const runId = String(input.runId || ('refl-' + localDate(createdAt).replace(/-/g, '') + '-' + randomUUID().replace(/-/g, '').slice(0, 6)))
  if (!RUN_ID.test(runId)) throw Object.assign(new Error('invalid reflection runId: ' + runId), { code: 'invalid_run' })
  const forDate = String(input.forDate || localDate(createdAt))
  const dayStart = toMs(input.windowStart)
  const dayEnd = toMs(input.windowEnd)
  const start = Number.isFinite(dayStart) ? dayStart : new Date(forDate + 'T00:00:00').getTime()
  const end = Number.isFinite(dayEnd) ? dayEnd : start + 24 * 60 * 60 * 1000
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    throw Object.assign(new Error('invalid reflection window'), { code: 'invalid_window' })
  }
  const base = join(stateDir, 'reflections')
  const runDir = join(base, 'runs', runId)
  const run = {
    schema: 1,
    runId,
    forDate,
    trigger: String(input.trigger || 'manual'),
    attempt: Number.isSafeInteger(input.attempt) && input.attempt > 0 ? input.attempt : 1,
    status: String(input.status || 'starting'),
    windowStart: start,
    windowEnd: end,
    createdAt,
    dispatchedAt: Number.isFinite(input.dispatchedAt) ? input.dispatchedAt : null,
    deadlineAt: Number.isFinite(input.deadlineAt) ? input.deadlineAt : createdAt + REFLECTION_DEFAULTS.deadlineMs,
    workerSessionId: input.workerSessionId ? String(input.workerSessionId) : null,
    candidates: Array.isArray(input.candidates) ? [...new Set(input.candidates.map(String).filter(Boolean))] : [],
    reportPartial: join(runDir, 'report.partial.md'),
    reportFinal: join(base, forDate + '.md'),
    attempts: Array.isArray(input.attempts) ? input.attempts.map(item => ({ ...item })) : [],
    error: input.error ? String(input.error) : null,
    refs: Object.create(null),
  }
  return run
}

export function runDirOf(run) {
  return dirname(run.reportPartial)
}

export function writeReflectionRun(run, stateDir) {
  const dir = join(stateDir, 'reflections', 'runs', run.runId)
  ensurePrivateDir(dir)
  const file = join(dir, 'run.json')
  writeFileAtomic(file, JSON.stringify(run, null, 2) + '\n')
  return file
}

function ensurePrivateDir(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  try { accessSync(dir, fsConstants.R_OK | fsConstants.W_OK | fsConstants.X_OK) } catch { /* writeFileAtomic reports the real error */ }
}

function writeFileAtomic(file, text) {
  ensurePrivateDir(dirname(file))
  const temp = file + '.' + process.pid + '.' + randomUUID().slice(0, 8) + '.tmp'
  const fd = openSync(temp, 'w', 0o600)
  try {
    writeSync(fd, text)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameSync(temp, file)
  try {
    const dfd = openSync(dirname(file), 'r')
    try { fsyncSync(dfd) } finally { closeSync(dfd) }
  } catch {
    // Directory fsync is best effort on platforms that do not allow it.
  }
}

export function readArchiveSession(sessionId, options = {}) {
  const id = String(sessionId || '')
  if (!id) return { events: [], corruptFrames: 0, file: undefined }
  const dshHome = String(options.dshHome || process.env.DSH_HOME || join(homedir(), '.dsh'))
  const root = join(dshHome, 'sessions')
  let workspaces = []
  try { workspaces = readdirSync(root) } catch { return { events: [], corruptFrames: 0, file: undefined } }
  let file
  for (const workspace of workspaces) {
    const candidate = join(root, workspace, id, 'session.v4.jsonl.zstd')
    try {
      if (statSync(candidate).isFile()) { file = candidate; break }
    } catch {
      // Not this workspace.
    }
  }
  if (!file) return { events: [], corruptFrames: 0, file: undefined }
  let buffer
  try { buffer = readFileSync(file) } catch { return { events: [], corruptFrames: 0, file } }
  const starts = []
  for (let index = 0; index <= buffer.length - ZSTD_MAGIC.length; index += 1) {
    if (buffer[index] === 0x28 && buffer[index + 1] === 0xb5 && buffer[index + 2] === 0x2f && buffer[index + 3] === 0xfd) starts.push(index)
  }
  let corruptFrames = 0
  const lines = []
  for (let index = 0; index < starts.length; index += 1) {
    const start = starts[index]
    const end = index + 1 < starts.length ? starts[index + 1] : buffer.length
    try {
      const raw = zstdDecompressSync(buffer.subarray(start, end)).toString('utf8')
      for (const line of raw.split('\n')) if (line.trim()) lines.push(line)
    } catch {
      corruptFrames += 1
    }
  }
  const events = []
  for (const line of lines) {
    try {
      const value = JSON.parse(line)
      if (value && typeof value === 'object') events.push(value)
    } catch {
      corruptFrames += 1
    }
  }
  return { events: normalizeEvents(events), corruptFrames, file }
}

function eventMatchesTime(event, from, to) {
  const at = eventTime(event)
  if (!Number.isFinite(at)) return false
  return at >= from && at < to
}

function resolveWindow(run, from, to, refs, mode, eventCount) {
  if (refs !== undefined && refs !== null) {
    if (from !== undefined || to !== undefined) return { error: 'refs cannot be combined with from/to' }
    return { kind: 'refs' }
  }
  const runFrom = Number.isFinite(run.windowStart) ? run.windowStart : -Infinity
  const runTo = Number.isFinite(run.windowEnd) ? run.windowEnd : Infinity
  if (from === undefined && to === undefined) {
    if (mode === 'full') return { error: 'full mode requires refs or from/to' }
    return { kind: 'time', from: runFrom, to: runTo }
  }
  const fromKind = from === undefined ? undefined : (typeof from === 'number' ? 'index' : (typeof from === 'string' ? 'time' : 'bad'))
  const toKind = to === undefined ? undefined : (typeof to === 'number' ? 'index' : (typeof to === 'string' ? 'time' : 'bad'))
  if (fromKind === 'bad' || toKind === 'bad') return { error: 'from/to must be ISO times or event indexes' }
  if (fromKind && toKind && fromKind !== toKind) return { error: 'from/to must use the same type' }
  const kind = fromKind || toKind
  if (kind === 'index') {
    const start = from === undefined ? 0 : Math.max(0, Math.min(eventCount, Math.trunc(from)))
    const end = to === undefined ? eventCount : Math.max(0, Math.min(eventCount, Math.trunc(to)))
    return { kind, from: start, to: end }
  }
  const startMs = from === undefined ? runFrom : toMs(from)
  const endMs = to === undefined ? runTo : toMs(to)
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return { error: 'from/to must be valid ISO times with a timezone' }
  return { kind: 'time', from: Math.max(runFrom, startMs), to: Math.min(runTo, endMs) }
}

function windowView(spec, selected) {
  if (spec.kind === 'index') return { from: spec.from, to: spec.to }
  if (spec.kind === 'refs') {
    if (!selected.length) return { from: 0, to: 0 }
    return { from: selected[0].index, to: selected[selected.length - 1].index + 1 }
  }
  return { from: iso(spec.from), to: iso(spec.to) }
}

function selectEvents(events, spec, refs, seenRefs) {
  const indexed = events.map((event, index) => ({ event, index }))
  if (spec.kind === 'refs') {
    const ranges = []
    let bad = 0
    for (const value of refs) {
      const parsed = parseRef(value)
      if (!parsed) { bad += 1; continue }
      if (seenRefs && !seenRefs.has(parsed.ref)) { bad += 1; continue }
      ranges.push(parsed)
    }
    const chosen = indexed.filter(item => ranges.some(range => item.index >= range.start && item.index <= range.end))
    return { selected: chosen, skippedRefs: bad }
  }
  if (spec.kind === 'index') return { selected: indexed.filter(item => item.index >= spec.from && item.index < spec.to), skippedRefs: 0 }
  return { selected: indexed.filter(item => eventMatchesTime(item.event, spec.from, spec.to)), skippedRefs: 0 }
}

function countRaw(selected) {
  let toolCalls = 0
  let toolResults = 0
  let thoughts = 0
  for (const item of selected) {
    const type = item.event.type
    if (type === 'tool/call') toolCalls += 1
    else if (type === 'tool/result') toolResults += 1
    else if (type === 'assistant/message') {
      for (const part of assistantParts(item.event)) if (part.type === 'reasoning') thoughts += 1
    }
  }
  return { toolCalls, toolResults, thoughts }
}

// Host notices sometimes arrive as ordinary user/message events with
// source.kind="user" (for example the [Worker idle] wake-up), so the source
// kind alone cannot separate a real person from the host. These prefixes are
// the ones lib/index.js and lib/worker-idle.mjs actually send.
const HOST_INJECTED_PREFIXES = Object.freeze([
  '[Worker idle]',
  '[Task intake]',
  '[Queue ready]',
  '[Queue blocked]',
  'DSH 刚刚重启。',
  'SCHEDULE REMINDER',
])

function looksHostInjected(text) {
  const head = String(text == null ? '' : text).trimStart()
  return HOST_INJECTED_PREFIXES.some(prefix => head.startsWith(prefix))
}

function sourceOfUser(event) {
  const data = eventData(event)
  const source = data.source && typeof data.source === 'object' ? data.source : {}
  const kind = typeof source.kind === 'string' ? source.kind : ''
  const injected = Boolean(kind && kind !== 'user' && kind !== 'wechat') || looksHostInjected(textOfContent(data.content))
  return { sourceKind: kind || undefined, injected }
}

function pushToolEntries(entries, selected, omitted) {
  const calls = []
  const results = new Map()
  for (const item of selected) {
    if (item.event.type === 'tool/result') {
      const info = toolResultInfo(item.event)
      if (info.callId) results.set(info.callId, { ...info, index: item.index })
    }
  }
  const groups = new Map()
  for (const item of selected) {
    if (item.event.type !== 'tool/call') continue
    const info = toolCallInfo(item.event)
    const result = results.get(info.callId)
    const ok = result ? result.ok : true
    const turn = eventTurn(item.event)
    const key = String(turn) + '\u0000' + info.name + '\u0000' + String(ok)
    const argsText = info.arguments || ''
    const resultText = result ? result.text : ''
    const detail = argsText + (resultText ? '\n' + resultText : '')
    let group = groups.get(key)
    if (!group) {
      group = {
        start: item.index,
        end: result ? result.index : item.index,
        turn,
        name: info.name,
        ok,
        count: 1,
        chars: charsOf(detail),
        preview: previewOf(argumentPreview(argsText) || resultText),
      }
      groups.set(key, group)
    } else {
      group.end = Math.max(group.end, result ? result.index : item.index)
      group.count += 1
      group.chars += charsOf(detail)
      omitted.chars += charsOf(detail)
    }
  }
  for (const group of groups.values()) entries.push({ kind: 'tool', ...group })
}

function pushThinkingEntries(entries, selected, omitted) {
  for (const item of selected) {
    if (item.event.type !== 'assistant/message') continue
    const turn = eventTurn(item.event)
    for (const part of assistantParts(item.event)) {
      if (part.type !== 'reasoning') continue
      const text = String(part.text || '')
      if (!text.trim()) continue
      entries.push({
        kind: 'thinking',
        start: item.index,
        end: item.index,
        turn,
        count: 1,
        chars: charsOf(text),
        preview: previewOf(text),
        text,
      })
    }
  }
}

function sortAndMerge(entries, omitted) {
  entries.sort((a, b) => a.start - b.start || a.end - b.end)
  const merged = []
  for (const entry of entries) {
    const previous = merged[merged.length - 1]
    if (entry.kind === 'thinking' && previous && previous.kind === 'thinking') {
      previous.end = Math.max(previous.end, entry.end)
      previous.count += entry.count
      previous.chars += entry.chars
      omitted.chars += entry.chars
      continue
    }
    merged.push({ ...entry })
  }
  return merged
}

function makeSummaryEntries(selected, omitted) {
  const entries = []
  const lastAssistant = new Map()
  for (const item of selected) {
    const event = item.event
    const turn = eventTurn(event)
    if (event.type === 'user/message') {
      const data = eventData(event)
      const text = textOfContent(data.content).trim()
      if (!text) continue
      const source = sourceOfUser(event)
      entries.push({ kind: 'user', start: item.index, end: item.index, at: eventTime(event), turn, text, ...source })
    } else if (event.type === 'assistant/message') {
      const parts = assistantParts(event)
      const text = parts.filter(part => part.type === 'text').map(part => contentText(part)).join('\n').trim()
      if (text) lastAssistant.set(String(turn === undefined ? item.index : turn), { index: item.index, at: eventTime(event), turn, text })
    }
  }
  for (const value of lastAssistant.values()) {
    entries.push({ kind: 'assistant', start: value.index, end: value.index, at: value.at, turn: value.turn, text: value.text })
  }
  pushThinkingEntries(entries, selected, omitted)
  pushToolEntries(entries, selected, omitted)
  return sortAndMerge(entries, omitted)
}

function budgetText(value, limit, budget) {
  const text = String(value == null ? '' : value)
  if (budget.used >= budget.max) return { text: '', truncated: true }
  const allowed = Math.min(limit, budget.max - budget.used)
  const clipped = clipChars(text, allowed)
  budget.used += charsOf(clipped)
  if (clipped !== text) budget.truncated = true
  budget.omitted += charsOf(text) - charsOf(clipped)
  return { text: clipped, truncated: clipped !== text }
}

export function querySession(input) {
  const run = input.run
  const events = Array.isArray(input.events) ? input.events : []
  const seenRefs = input.seenRefs instanceof Set ? input.seenRefs : new Set()
  const mode = input.mode === 'full' ? 'full' : 'summary'
  const maxMessages = Math.max(1, Math.min(REFLECTION_DEFAULTS.maxMessages, Number(input.maxMessages) || (mode === 'full' ? REFLECTION_DEFAULTS.fullMessages : REFLECTION_DEFAULTS.summaryMessages)))
  const maxChars = Math.max(1, Math.min(REFLECTION_DEFAULTS.maxChars, Number(input.maxChars) || (mode === 'full' ? REFLECTION_DEFAULTS.fullChars : REFLECTION_DEFAULTS.summaryChars)))
  const refs = input.refs === undefined || input.refs === null ? undefined : input.refs
  if (refs !== undefined && (!Array.isArray(refs) || refs.length < 1 || refs.length > REFLECTION_DEFAULTS.maxRefs)) {
    return { ok: false, code: 'invalid_refs', message: 'refs must contain 1-50 refs', error: 'refs must contain 1-50 refs' }
  }
  if (refs !== undefined && refs.some(value => typeof value !== 'string')) {
    return { ok: false, code: 'invalid_refs', message: 'refs must be strings', error: 'refs must be strings' }
  }
  const spec = resolveWindow(run, input.from, input.to, refs, mode, events.length)
  if (spec.error) return { ok: false, code: 'invalid_window', message: spec.error, error: spec.error }
  const picked = selectEvents(events, spec, refs || [], seenRefs)
  const selected = picked.selected
  const raw = countRaw(selected)
  const budget = { used: 0, max: maxChars, omitted: 0, truncated: false }
  const messages = []
  const omitted = { chars: 0 }
  let skippedRefs = picked.skippedRefs

  if (mode === 'summary') {
    const entries = makeSummaryEntries(selected, omitted)
    for (const entry of entries) {
      if (messages.length >= maxMessages) { budget.truncated = true; omitted.chars += entry.chars || charsOf(entry.text); continue }
      if (entry.kind === 'tool' || entry.kind === 'thinking') {
        const preview = budgetText(entry.preview, 80, budget)
        if (!preview.text) { budget.truncated = true; omitted.chars += entry.chars; continue }
        const at = eventTime(selected.find(item => item.index === entry.start)?.event)
        const item = { ref: refOf(entry.start, entry.end), role: entry.kind === 'thinking' ? 'thinking' : 'tool', ...(at === undefined ? {} : { at }), ...(entry.turn === undefined ? {} : { turn: entry.turn }), brief: { chars: entry.chars, preview: preview.text } }
        if (entry.kind === 'tool') { item.brief.name = entry.name; item.brief.ok = entry.ok }
        if (entry.count > 1) item.brief.count = entry.count
        messages.push(item)
        if (entry.kind === 'tool' || entry.kind === 'thinking') seenRefs.add(item.ref)
      } else {
        const text = budgetText(entry.text, 1000, budget)
        if (!text.text) { budget.truncated = true; omitted.chars += entry.chars || charsOf(entry.text); continue }
        const item = { ref: refOf(entry.start, entry.end), role: entry.kind, ...(entry.at === undefined ? {} : { at: entry.at }), ...(entry.turn === undefined ? {} : { turn: entry.turn }), text: text.text }
        if (entry.kind === 'user') {
          if (entry.sourceKind) item.source = entry.sourceKind
          if (entry.injected) item.injected = true
        }
        messages.push(item)
        seenRefs.add(item.ref)
      }
      // A single long message may be clipped to its per-item limit; that must
      // not end the whole summary. Only an exhausted character budget stops it.
      if (budget.used >= budget.max) break
    }
  } else {
    for (const item of selected) {
      if (messages.length >= maxMessages) { budget.truncated = true; break }
      const event = item.event
      const turn = eventTurn(event)
      const at = eventTime(event)
      const parts = []
      if (event.type === 'user/message') parts.push({ role: 'user', text: textOfContent(eventData(event).content) })
      else if (event.type === 'assistant/message') {
        for (const part of assistantParts(event)) {
          if (part.type === 'reasoning') parts.push({ role: 'thinking', text: part.text })
          else if (part.type === 'text') parts.push({ role: 'assistant', text: part.text })
        }
      } else if (event.type === 'tool/call') {
        const info = toolCallInfo(event)
        parts.push({ role: 'tool', text: info.name + ' ' + info.arguments })
      } else if (event.type === 'tool/result') {
        parts.push({ role: 'tool', text: toolResultInfo(event).text })
      }
      for (const part of parts) {
        if (messages.length >= maxMessages) { budget.truncated = true; break }
        const text = budgetText(part.text, 2000, budget)
        if (!text.text) { budget.truncated = true; break }
        const ref = refOf(item.index)
        messages.push({ ref, role: part.role, ...(at === undefined ? {} : { at }), ...(turn === undefined ? {} : { turn }), text: text.text, truncated: text.truncated })
        seenRefs.add(ref)
        // Per-item clipping is not budget exhaustion; keep returning events
        // until maxChars is actually used up.
        if (budget.used >= budget.max) break
      }
      if (budget.used >= budget.max) break
    }
  }

  const returnedMessages = messages.filter(item => item.role === 'user' || item.role === 'assistant').length
  const result = {
    ok: true,
    mode,
    messages,
    window: windowView(spec, selected),
    stats: {
      messages: returnedMessages,
      toolCalls: raw.toolCalls,
      toolResults: raw.toolResults,
      thoughts: raw.thoughts,
      omittedChars: Math.max(0, omitted.chars + budget.omitted),
    },
    corruptFrames: Number.isSafeInteger(input.corruptFrames) ? input.corruptFrames : 0,
    truncated: Boolean(budget.truncated || skippedRefs > 0),
    source: input.source || 'events',
  }
  const lastTurn = lastTurnEnd(events)
  if (lastTurn) result.lastTurn = lastTurn
  return result
}

export function reflectionStatusView(run, options = {}) {
  const now = Number.isFinite(options.now) ? options.now : Date.now()
  const sessions = Array.isArray(options.sessions) ? options.sessions : []
  const byId = new Map(sessions.map(item => [String(item.sessionId), item]))
  const candidates = (run.candidates || []).map(sessionId => {
    const item = byId.get(String(sessionId)) || {}
    return {
      sessionId: String(sessionId),
      title: typeof item.title === 'string' ? item.title : '',
      running: Boolean(item.running),
      blank: Boolean(item.blank),
      ...(Number.isFinite(item.lastUsedAt) ? { lastUsedAt: item.lastUsedAt } : {}),
      ticketIds: Array.isArray(item.ticketIds) ? item.ticketIds.slice() : [],
    }
  })
  return {
    runId: run.runId,
    forDate: run.forDate,
    window: { from: iso(run.windowStart), to: iso(run.windowEnd) },
    deadlineAt: iso(run.deadlineAt),
    remainingMs: Math.max(0, run.deadlineAt - now),
    candidates,
    limits: {
      maxMessages: REFLECTION_DEFAULTS.maxMessages,
      maxChars: REFLECTION_DEFAULTS.maxChars,
      maxRefs: REFLECTION_DEFAULTS.maxRefs,
      reportBytes: REFLECTION_DEFAULTS.reportBytes,
      memoryBytes: REFLECTION_DEFAULTS.memoryBytes,
    },
    memoryBytes: Number.isSafeInteger(options.memoryBytes) ? options.memoryBytes : 0,
    reportPath: run.reportPartial,
    state: run.status,
  }
}

export function reportPathFor(run) {
  return run && typeof run.reportPartial === 'string' ? run.reportPartial : ''
}

export function writeReflectionReport(input) {
  const run = input.run
  if (!run) return { ok: false, code: 'run_closed', message: 'reflection run is not available', error: 'reflection run is not available' }
  if (run.status !== 'running') return { ok: false, code: 'run_closed', message: 'reflection run is not running', error: 'reflection run is not running' }
  const markdown = typeof input.markdown === 'string' ? input.markdown : ''
  if (!markdown.trim()) return { ok: false, code: 'report_empty', message: 'markdown must not be empty', error: 'markdown must not be empty' }
  if (input.status !== 'complete' && input.status !== 'partial') {
    return { ok: false, code: 'report_status_invalid', message: 'status must be complete or partial', error: 'status must be complete or partial' }
  }
  if (!input.counts || typeof input.counts !== 'object' || Array.isArray(input.counts)) {
    return { ok: false, code: 'report_counts_invalid', message: 'counts must be an object', error: 'counts must be an object' }
  }
  if (input.degraded !== undefined && (!Array.isArray(input.degraded) || input.degraded.some(item => typeof item !== 'string'))) {
    return { ok: false, code: 'report_degraded_invalid', message: 'degraded must be an array of strings', error: 'degraded must be an array of strings' }
  }
  const bytes = Buffer.byteLength(markdown, 'utf8')
  if (bytes > REFLECTION_DEFAULTS.reportBytes) {
    return { ok: false, code: 'report_too_large', message: 'report exceeds ' + REFLECTION_DEFAULTS.reportBytes + ' bytes', error: 'report exceeds ' + REFLECTION_DEFAULTS.reportBytes + ' bytes' }
  }
  const file = reportPathFor(run)
  if (!file) return { ok: false, code: 'report_path_invalid', message: 'run has no report path', error: 'run has no report path' }
  writeFileAtomic(file, markdown)
  const sha256 = createHash('sha256').update(markdown, 'utf8').digest('hex')
  return { ok: true, path: file, bytes, sha256 }
}

export function memoryInfo(stateDir) {
  const file = join(stateDir, 'memory.md')
  try {
    const bytes = statSync(file).size
    return { file, bytes }
  } catch {
    return { file, bytes: 0 }
  }
}

export function readMemoryContext(stateDir) {
  const info = memoryInfo(stateDir)
  let text = ''
  try { text = readFileSync(info.file, 'utf8') } catch { text = '' }
  const clipped = clipChars(redact(text), REFLECTION_DEFAULTS.memoryBytes)
  return { text: clipped, bytes: Buffer.byteLength(clipped, 'utf8'), truncated: charsOf(text) > REFLECTION_DEFAULTS.memoryBytes }
}

export function readOutboxContext(entries, run, options = {}) {
  const list = (Array.isArray(entries) ? entries : [])
    .filter(entry => entry && (entry.status !== 'delivered' || (Number.isFinite(entry.createdAt) && entry.createdAt >= run.windowStart && entry.createdAt < run.windowEnd)))
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
  const limit = REFLECTION_DEFAULTS.outboxEntries
  const selected = list.slice(0, limit)
  const lines = selected.map(entry => {
    const payload = entry.payload && typeof entry.payload === 'object' ? entry.payload : {}
    const bits = ['kind=' + entry.kind, 'status=' + entry.status, 'attempts=' + (entry.attempts || 0)]
    if (payload.ticketId) bits.push('ticketId=' + payload.ticketId)
    if (entry.lastError) bits.push('lastError=' + clipChars(String(entry.lastError), 200))
    if (payload.text) bits.push('text=' + clipChars(String(payload.text), 200))
    if (payload.note) bits.push('note=' + clipChars(String(payload.note), 200))
    return bits.join(' | ')
  })
  const text = redact(lines.join('\n'))
  return { text, bytes: Buffer.byteLength(text, 'utf8'), truncated: list.length > limit }
}

export function ticketView(ticket, options = {}) {
  const limit = Number.isSafeInteger(options.limit) ? options.limit : REFLECTION_DEFAULTS.ticketChars
  const clip = value => clipChars(redact(value == null ? '' : String(value)), limit)
  const checklist = Array.isArray(ticket.checklist)
    ? ticket.checklist.map(item => ({ text: clip(item && item.text ? item.text : ''), done: Boolean(item && item.done) }))
    : []
  return {
    ticketId: ticket.ticketId,
    goal: clip(ticket.goal),
    acceptance: clip(ticket.acceptance),
    executor: ticket.executor || 'self',
    status: ticket.status,
    ...(ticket.waitingOn ? { waitingOn: ticket.waitingOn } : {}),
    ...(ticket.blockedReason ? { blockedReason: clip(ticket.blockedReason) } : {}),
    ...(ticket.attention ? { attention: ticket.attention } : {}),
    ...(ticket.parentTicketId ? { parentTicketId: ticket.parentTicketId } : {}),
    ...(Array.isArray(ticket.childTicketIds) && ticket.childTicketIds.length ? { childTicketIds: ticket.childTicketIds.slice() } : {}),
    ...(ticket.resolution ? { resolution: ticket.resolution } : {}),
    ...(ticket.failure ? { failure: ticket.failure } : {}),
    ...(ticket.archived ? { archived: true } : {}),
    createdAt: ticket.createdAt,
    updatedAt: ticket.updatedAt,
    ...(ticket.closedAt ? { closedAt: ticket.closedAt } : {}),
    dependsOn: Array.isArray(ticket.dependsOn) ? ticket.dependsOn.slice() : [],
    checklist,
    progress: ticket.progress || (checklist.length ? checklist.filter(item => item.done).length + '/' + checklist.length : ''),
  }
}

export function insideWindow(ticket, run) {
  for (const value of [ticket.createdAt, ticket.updatedAt, ticket.closedAt]) {
    if (Number.isFinite(value) && value >= run.windowStart && value < run.windowEnd) return true
  }
  return false
}

export function sha256File(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

export function isPrivateFile(file) {
  try { return (statSync(file).mode & 0o777) === 0o600 } catch { return false }
}

export const REFLECTION_TIMEZONE = 'Asia/Shanghai'
export const REFLECTION_LOCK_TTL_MS = 20 * 60 * 1000
const REFLECTION_DAY_MS = 24 * 60 * 60 * 1000
const REFLECTION_REQUIRED_HEADINGS = [
  '一句话',
  '做对了什么',
  '错漏清单',
  '教训',
  'memory 候选',
  '明日关注',
  '覆盖与成本',
  '未覆盖',
]
const REFLECTION_NUMBER_FIELDS = [
  'sessionsReviewed',
  'sessionsSkipped',
  'ticketsReviewed',
  'compressedBytesRead',
  'decompressedBytesRead',
  'durationMs',
]

export function reflectionsDir(stateDir) {
  return join(stateDir, 'reflections')
}

export function reflectionStatePath(stateDir) {
  return join(reflectionsDir(stateDir), 'state.json')
}

export function reflectionLockPath(stateDir) {
  return join(reflectionsDir(stateDir), '.lock')
}

export function reflectionRunPath(stateDir, runId) {
  return join(reflectionsDir(stateDir), 'runs', String(runId), 'run.json')
}

export function emptyReflectionState() {
  return {
    schema: 2,
    timezone: REFLECTION_TIMEZONE,
    lastCompletedDate: null,
    lastPartialDate: null,
    lastRunId: null,
    lastStatus: null,
    lastAttemptAt: null,
    lastError: null,
    scheduleId: null,
    activeRunId: null,
    updatedAt: null,
  }
}

export function readReflectionState(stateDir) {
  const base = emptyReflectionState()
  try {
    const parsed = JSON.parse(readFileSync(reflectionStatePath(stateDir), 'utf8'))
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return { ...base, ...parsed, schema: 2, timezone: REFLECTION_TIMEZONE }
    }
  } catch (error) {
    if (error && error.code !== 'ENOENT') throw error
  }
  return base
}

export function writeReflectionState(stateDir, state) {
  ensurePrivateDir(reflectionsDir(stateDir))
  const next = {
    ...emptyReflectionState(),
    ...(state || {}),
    schema: 2,
    timezone: REFLECTION_TIMEZONE,
    updatedAt: Date.now(),
  }
  writeFileAtomic(reflectionStatePath(stateDir), JSON.stringify(next, null, 2) + '\n')
  return next
}

export function readReflectionRun(stateDir, runId) {
  try {
    const parsed = JSON.parse(readFileSync(reflectionRunPath(stateDir, runId), 'utf8'))
    if (!parsed || parsed.runId !== runId) return null
    return parsed
  } catch (error) {
    if (error && error.code === 'ENOENT') return null
    throw error
  }
}

export function readReflectionLock(stateDir) {
  try {
    const parsed = JSON.parse(readFileSync(reflectionLockPath(stateDir), 'utf8'))
    if (!parsed || typeof parsed !== 'object') return null
    return parsed
  } catch (error) {
    if (error && error.code === 'ENOENT') return null
    return null
  }
}

export function acquireReflectionLock(stateDir, run) {
  ensurePrivateDir(reflectionsDir(stateDir))
  const lock = {
    runId: run.runId,
    forDate: run.forDate,
    attempt: run.attempt,
    startedAt: run.createdAt,
    deadlineAt: run.deadlineAt,
    workerSessionId: run.workerSessionId || null,
  }
  try {
    const fd = openSync(reflectionLockPath(stateDir), 'wx', 0o600)
    try {
      writeSync(fd, JSON.stringify(lock, null, 2) + '\n')
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    return { ok: true, lock }
  } catch (error) {
    if (error && error.code === 'EEXIST') {
      return { ok: false, lock: readReflectionLock(stateDir) }
    }
    throw error
  }
}

export function writeReflectionLock(stateDir, lock) {
  ensurePrivateDir(reflectionsDir(stateDir))
  writeFileAtomic(reflectionLockPath(stateDir), JSON.stringify(lock, null, 2) + '\n')
  return lock
}

export function removeReflectionLock(stateDir, runId) {
  const lock = readReflectionLock(stateDir)
  if (!lock) return false
  if (runId && lock.runId !== runId) return false
  try {
    unlinkSync(reflectionLockPath(stateDir))
    return true
  } catch (error) {
    if (error && error.code === 'ENOENT') return false
    throw error
  }
}

export function reflectionDate(ms = Date.now()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: REFLECTION_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(ms))
  const value = {}
  for (const part of parts) value[part.type] = part.value
  return String(value.year) + '-' + String(value.month) + '-' + String(value.day)
}

export function isReflectionDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const ms = Date.parse(value + 'T00:00:00Z')
  if (!Number.isFinite(ms)) return false
  return new Date(ms).toISOString().slice(0, 10) === value
}

export function reflectionWindow(forDate, occurrenceAt) {
  if (!isReflectionDate(forDate)) throw new Error('invalid reflection date: ' + String(forDate))
  const start = Date.parse(forDate + 'T00:00:00+08:00')
  const dayEnd = start + REFLECTION_DAY_MS
  let end = dayEnd
  if (Number.isFinite(occurrenceAt) && occurrenceAt >= start && occurrenceAt < dayEnd) {
    end = occurrenceAt + 1
  }
  return { start, end }
}

export function reflectionManualPath(stateDir, forDate, nowMs = Date.now()) {
  if (!isReflectionDate(forDate)) throw new Error('invalid reflection date: ' + String(forDate))
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: REFLECTION_TIMEZONE,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date(nowMs))
  const value = {}
  for (const part of parts) value[part.type] = part.value
  const hhmm = String(value.hour).padStart(2, '0') + String(value.minute).padStart(2, '0')
  const base = join(reflectionsDir(stateDir), forDate + '.manual-' + hhmm)
  let file = base + '.md'
  for (let index = 2; index < 100 && existsSync(file); index += 1) file = base + '-' + index + '.md'
  return file
}

export function reflectionReportPath(run, status) {
  if (status === 'partial') return join(dirname(run.reportFinal), run.forDate + '.partial.md')
  return run.reportFinal
}

export function parseReflectionFrontMatter(markdown) {
  if (typeof markdown !== 'string' || !markdown.trim()) {
    return { ok: false, code: 'report_front_matter', message: 'report is empty' }
  }
  const text = markdown.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')
  if (!text.startsWith('---\n')) {
    return { ok: false, code: 'report_front_matter', message: 'report must start with a YAML front matter block' }
  }
  const close = text.indexOf('\n---\n', 4)
  if (close < 0) {
    return { ok: false, code: 'report_front_matter', message: 'report front matter is not closed' }
  }
  const raw = text.slice(4, close)
  const body = text.slice(close + 5)
  const data = {}
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const at = trimmed.indexOf(':')
    if (at <= 0) {
      return { ok: false, code: 'report_front_matter', message: 'invalid front matter line: ' + trimmed }
    }
    const key = trimmed.slice(0, at).trim()
    let value = trimmed.slice(at + 1).trim()
    if (value.startsWith('[') && value.endsWith(']')) {
      const inner = value.slice(1, -1).trim()
      data[key] = inner
        ? inner.split(',').map(item => item.trim().replace(/^["']|["']$/g, '')).filter(Boolean)
        : []
    } else if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      data[key] = value.slice(1, -1)
    } else if (value === 'null' || value === '~') {
      data[key] = null
    } else if (value === 'true') {
      data[key] = true
    } else if (value === 'false') {
      data[key] = false
    } else {
      data[key] = value
    }
  }
  return { ok: true, data, body }
}

export function validateReflectionReport({ run, markdown, status }) {
  const parsed = parseReflectionFrontMatter(markdown)
  if (!parsed.ok) return parsed
  const fm = parsed.data
  const expectedStatus = status || fm.status
  const problems = []
  const textField = (key, expected) => {
    if (fm[key] === undefined || fm[key] === null || String(fm[key]) === '') {
      problems.push(key + ' is required')
    } else if (expected !== undefined && String(fm[key]) !== String(expected)) {
      problems.push(key + ' must be ' + String(expected))
    }
  }
  if (Number(fm.schema) !== 2) problems.push('schema must be 2')
  textField('date', run.forDate)
  textField('timezone', REFLECTION_TIMEZONE)
  textField('cadence', 'daily')
  textField('trigger', run.trigger)
  textField('runId', run.runId)
  textField('workerSessionId', run.workerSessionId || '')
  textField('status', expectedStatus)
  if (!['complete', 'partial'].includes(String(fm.status))) problems.push('status must be complete or partial')
  if (Number(fm.attempt) !== Number(run.attempt)) problems.push('attempt must be ' + String(run.attempt))
  for (const key of ['windowStart', 'windowEnd']) {
    const value = Date.parse(String(fm[key] || ''))
    const expected = key === 'windowStart' ? run.windowStart : run.windowEnd
    if (!Number.isFinite(value)) problems.push(key + ' must be an ISO timestamp')
    else if (Math.abs(value - expected) > 1000) problems.push(key + ' does not match the run window')
  }
  for (const key of REFLECTION_NUMBER_FIELDS) {
    if (fm[key] === undefined || fm[key] === null || fm[key] === '') problems.push(key + ' is required')
    else if (!Number.isFinite(Number(fm[key])) || Number(fm[key]) < 0) problems.push(key + ' must be a non-negative number')
  }
  if (!Array.isArray(fm.degraded)) problems.push('degraded must be an array')
  for (const heading of REFLECTION_REQUIRED_HEADINGS) {
    if (!parsed.body.includes('## ' + heading)) problems.push('missing heading: ' + heading)
  }
  if (parsed.body.split('\n').length > 200) problems.push('report is longer than 200 lines')
  if (Buffer.byteLength(markdown, 'utf8') > 30720) problems.push('report is larger than 30KB')
  if (problems.length) {
    return { ok: false, code: 'report_invalid', message: problems.slice(0, 5).join('; ') }
  }
  return { ok: true, frontMatter: fm, body: parsed.body, status: String(fm.status) }
}

export function writeReflectionFinalReport(markdown, file) {
  ensurePrivateDir(dirname(file))
  writeFileAtomic(file, markdown)
  return {
    path: file,
    bytes: Buffer.byteLength(markdown, 'utf8'),
    sha256: createHash('sha256').update(markdown).digest('hex'),
  }
}

export function reflectionInstruction(run, options = {}) {
  const deadlineAt = Number(options.deadlineAt) || run.deadlineAt
  const lines = [
    '你是一次定期反思（daily reflection）的只读 worker。你的任务是阅读证据、写一份反思报告，然后结束。',
    'runId: ' + run.runId,
    'forDate: ' + run.forDate,
    'windowStart: ' + new Date(run.windowStart).toISOString(),
    'windowEnd: ' + new Date(run.windowEnd).toISOString(),
    'deadline: ' + new Date(deadlineAt).toISOString(),
    '',
    '可用工具（只有这 6 个，全部只读）：ria_reflect_status、ria_reflect_read_tickets、ria_reflect_read_sessions、ria_reflect_read_session、ria_reflect_read_context、ria_reflect_report。',
    '不要尝试 shell、文件写入、网络、MCP 或任何其它工具；它们不可用。',
    '',
    '步骤：',
    '1. 先调用 ria_reflect_status 确认 run 与候选会话。',
    '2. 用 ria_reflect_read_tickets 和 ria_reflect_read_context 看窗口内工单、memory、outbox。',
    '3. 对候选会话最多 8 个使用 ria_reflect_read_session 的 summary 模式；仅对异常工单用 full 模式并给 refs 或 from/to，最多 3 个会话。',
    '4. 核对工单状态与交付，区分已对账与未验证。',
    '5. 每条结论必须给证据（session/事件 ref 或工单号）；没有证据的猜测不要写。',
    '6. 教训最多 5 条，memory 候选最多 3 条；不要直接改 memory。',
    '7. 最后调用 ria_reflect_report，status 为 complete 或 partial，markdown 使用下面的 front matter 与八个固定标题。',
    '8. 预算：10 分钟软上限、15 分钟硬上限、总读取约 90k 字符、最多 8 个会话。',
    '9. 完成后用一行说明结果，然后结束 turn。',
    '',
    '报告 front matter 模板：',
    '---',
    'schema: 2',
    'date: ' + run.forDate,
    'timezone: Asia/Shanghai',
    'cadence: daily',
    'windowStart: ' + new Date(run.windowStart).toISOString(),
    'windowEnd: ' + new Date(run.windowEnd).toISOString(),
    'trigger: ' + run.trigger,
    'runId: ' + run.runId,
    'attempt: ' + run.attempt,
    'workerSessionId: ' + (run.workerSessionId || '<你的 sessionId>'),
    'status: complete',
    'sessionsReviewed: 0',
    'sessionsSkipped: 0',
    'ticketsReviewed: 0',
    'compressedBytesRead: 0',
    'decompressedBytesRead: 0',
    'durationMs: 0',
    'degraded: []',
    '---',
    '## 一句话',
    '## 做对了什么',
    '## 错漏清单',
    '## 教训',
    '## memory 候选',
    '## 明日关注',
    '## 覆盖与成本',
    '## 未覆盖',
  ]
  return lines.join('\n')
}

export function basenameOf(file) {
  return basename(file)
}
