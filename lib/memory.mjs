// cognition/chat memory core budget.
//
// All comparisons here go through measureText(): chars means Unicode code
// points, bytes means UTF-8 bytes. Field names always carry their unit.

import { measureText } from './text-size.mjs'

export const MEMORY_SETTINGS_DEFAULTS = Object.freeze({
  maxChars: 2400,
  maxEntries: 12,
  maxEntryChars: 300,
})

export const MEMORY_SETTINGS_RANGES = Object.freeze({
  maxChars: Object.freeze({ min: 500, max: 20000 }),
  maxEntries: Object.freeze({ min: 1, max: 50 }),
  maxEntryChars: Object.freeze({ min: 50, max: 2000 }),
})

export function normalizeMemorySettings(value) {
  const raw = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  const next = {}
  for (const key of Object.keys(MEMORY_SETTINGS_DEFAULTS)) {
    const range = MEMORY_SETTINGS_RANGES[key]
    const candidate = raw[key]
    next[key] = Number.isInteger(candidate) && candidate >= range.min && candidate <= range.max
      ? candidate
      : MEMORY_SETTINGS_DEFAULTS[key]
  }
  return next
}

export function memoryEntryKey(line) {
  const match = /^- \*\*([^*]+)\*\*/.exec(String(line || ''))
  return match ? match[1].trim() : ''
}

export function memoryEntries(text) {
  const entries = []
  for (const line of String(text === null || text === undefined ? '' : text).split(/\r?\n/)) {
    if (!line.startsWith('- ')) continue
    entries.push({
      line,
      key: memoryEntryKey(line),
      chars: measureText(line).chars,
    })
  }
  return entries
}

// Count the file without its final newline. Empty and heading lines count
// toward maxChars; only column-zero "- " lines count as entries.
export function inspectMemory(text, settings) {
  const source = String(text === null || text === undefined ? '' : text)
  const counted = source.endsWith('\n') ? source.slice(0, -1) : source
  const countedMeasure = measureText(counted)
  const fileMeasure = measureText(source)
  const memoryBudget = normalizeMemorySettings(settings)
  const entries = memoryEntries(source)
  let longestEntryKey = null
  let longestEntryChars = 0
  const overEntryKeys = []
  const overEntryDetails = []
  entries.forEach((entry, index) => {
    if (entry.chars > longestEntryChars) {
      longestEntryChars = entry.chars
      longestEntryKey = entry.key || null
    }
    if (entry.chars > memoryBudget.maxEntryChars) {
      const key = entry.key || '(unnamed)'
      overEntryKeys.push(key)
      overEntryDetails.push({
        index,
        key,
        chars: entry.chars,
        maxChars: memoryBudget.maxEntryChars,
        overChars: entry.chars - memoryBudget.maxEntryChars,
      })
    }
  })
  const overChars = Math.max(0, countedMeasure.chars - memoryBudget.maxChars)
  const overEntries = Math.max(0, entries.length - memoryBudget.maxEntries)
  const overEntryChars = Math.max(0, longestEntryChars - memoryBudget.maxEntryChars)
  const warnCharsAt = Math.ceil(memoryBudget.maxChars * 0.9)
  const warnEntriesAt = Math.ceil(memoryBudget.maxEntries * 0.9)
  const warnEntryCharsAt = Math.ceil(memoryBudget.maxEntryChars * 0.9)
  const warnings = []
  if (countedMeasure.chars >= warnCharsAt) {
    warnings.push('cognition/chat memory is at ' + countedMeasure.chars + '/' + memoryBudget.maxChars + ' chars; consider consolidating long details.')
  }
  if (entries.length >= warnEntriesAt) {
    warnings.push('cognition/chat memory has ' + entries.length + '/' + memoryBudget.maxEntries + ' entries; consider merging or moving detail out.')
  }
  if (longestEntryChars >= warnEntryCharsAt) {
    warnings.push('The longest memory entry is ' + longestEntryChars + '/' + memoryBudget.maxEntryChars + ' chars (' + (longestEntryKey || 'unnamed') + '); consider moving detail into cognition/chat/decisions.md.')
  }
  return {
    chars: countedMeasure.chars,
    bytes: fileMeasure.bytes,
    entries: entries.length,
    maxChars: memoryBudget.maxChars,
    maxEntries: memoryBudget.maxEntries,
    maxEntryChars: memoryBudget.maxEntryChars,
    warnCharsAt,
    warnEntriesAt,
    warnEntryCharsAt,
    longestEntryKey,
    longestEntryChars,
    overEntryKeys,
    overEntryDetails,
    overChars,
    overEntries,
    overEntryChars,
    overBudget: overChars > 0 || overEntries > 0 || overEntryChars > 0,
    warnings,
  }
}

export function memoryStatusView(text, settings) {
  const stats = inspectMemory(text, settings)
  return {
    chars: stats.chars,
    bytes: stats.bytes,
    entries: stats.entries,
    maxChars: stats.maxChars,
    maxEntries: stats.maxEntries,
    maxEntryChars: stats.maxEntryChars,
    longestEntryKey: stats.longestEntryKey,
    longestEntryChars: stats.longestEntryChars,
    overBudget: stats.overBudget,
    warnings: stats.warnings,
  }
}

// Everything the model needs to repair a rejected write, in a form that also
// survives as structured JSON in a tool result.
export function memoryBudgetReport(stats) {
  const overEntryDetails = Array.isArray(stats.overEntryDetails) ? stats.overEntryDetails : []
  return {
    chars: stats.chars,
    maxChars: stats.maxChars,
    overChars: stats.overChars,
    entries: stats.entries,
    maxEntries: stats.maxEntries,
    overEntries: stats.overEntries,
    maxEntryChars: stats.maxEntryChars,
    longestEntryKey: stats.longestEntryKey,
    longestEntryChars: stats.longestEntryChars,
    overEntryChars: stats.overEntryChars,
    overEntryKeys: Array.isArray(stats.overEntryKeys) ? stats.overEntryKeys.slice() : [],
    overEntryDetails: overEntryDetails.map(entry => ({ ...entry })),
    totalOnly: stats.overChars > 0 && stats.overEntries === 0 && stats.overEntryChars === 0,
    overBudget: Boolean(stats.overBudget),
  }
}

export function memoryBudgetFailure(stats) {
  const message = memoryBudgetError(stats)
  return {
    ok: false,
    code: 'memory_over_budget',
    message,
    error: message,
    diagnostics: memoryBudgetReport(stats),
  }
}

export function memoryBudgetError(stats) {
  const report = memoryBudgetReport(stats)
  const overDetails = report.overEntryDetails
  const overNames = overDetails.length
    ? overDetails.map(entry => '"' + entry.key + '"').join(', ')
    : (stats.longestEntryKey ? '"' + stats.longestEntryKey + '"' : '(none)')
  const pointer = 'cognition/chat/decisions.md'
  const action = overDetails.length
    ? 'Shorten ' + overNames + ' to at most ' + stats.maxEntryChars + ' chars or move the detail to ' + pointer + '.'
    : (stats.overEntries > 0
      ? 'Merge or remove entries, or move detail to ' + pointer + '.'
      : 'Shorten entries or move detail to ' + pointer + '.')
  const lines = [
    'cognition/chat memory not written: ' +
      report.chars + '/' + report.maxChars + ' chars (+' + report.overChars + ')' + (report.totalOnly ? ', total only' : '') + ', ' +
      report.entries + '/' + report.maxEntries + ' entries (+' + report.overEntries + '), ' +
      overDetails.length + (overDetails.length === 1 ? ' entry over ' : ' entries over ') + report.maxEntryChars + ' chars.',
    'Longest entry ' + (report.longestEntryKey ? '"' + report.longestEntryKey + '"' : (report.longestEntryChars > 0 ? '(unnamed)' : '(none)')) + ': ' +
      report.longestEntryChars + '/' + report.maxEntryChars + ' chars' +
      (report.overEntryChars > 0 ? ' (+' + report.overEntryChars + ')' : '') + '.',
  ]
  if (overDetails.length) {
    lines.push('Over-limit entries: ' + overDetails.map(entry =>
      '"' + entry.key + '" ' + entry.chars + '/' + entry.maxChars + ' chars (+' + entry.overChars + ')'
    ).join('; ') + '.')
  }
  lines.push(action + ' Inspect cognition/chat memory files, then retry.')
  lines.push('No changes were made.')
  return lines.join('\n')
}

export function memoryWarningText(stats) {
  if (!stats || !stats.warnings || !stats.warnings.length) return ''
  return 'cognition/chat memory is near budget: ' + stats.warnings.join(' ')
}

// Manual edits can bypass the budget check. When the content is over budget, inject
// only complete lines that fit, then say so explicitly. Never silently clip a
// line or the middle of an entry.
export function memoryPromptPayload(text, settings) {
  const stats = inspectMemory(text, settings)
  if (!stats.overBudget) return { text: String(text || ''), notice: '', stats }
  const source = String(text || '')
  const lines = source.split(/\r?\n/)
  const kept = []
  let chars = 0
  let entries = 0
  let omittedEntries = 0
  let omittedLines = 0
  for (const line of lines) {
    const isEntry = line.startsWith('- ')
    const lineChars = measureText(line).chars
    if (isEntry && lineChars > stats.maxEntryChars) {
      omittedEntries += 1
      continue
    }
    if (isEntry && entries + 1 > stats.maxEntries) {
      omittedEntries += 1
      continue
    }
    const nextChars = chars + (kept.length ? 1 : 0) + lineChars
    if (nextChars > stats.maxChars) {
      if (isEntry) omittedEntries += 1
      else omittedLines += 1
      continue
    }
    kept.push(line)
    chars = nextChars
    if (isEntry) entries += 1
  }
  const loaded = kept.join('\n').replace(/\n+$/, '')
  const notice = '[cognition/chat memory is over budget: ' + stats.chars + '/' + stats.maxChars + ' chars, ' +
    stats.entries + '/' + stats.maxEntries + ' entries, longest entry ' + stats.longestEntryChars + '/' +
    stats.maxEntryChars + ' chars. Loaded only ' + entries + ' complete entries and omitted ' +
    (omittedEntries + omittedLines) + ' lines; move detail to cognition/chat/decisions.md.]'
  return {
    text: loaded,
    notice,
    stats: inspectMemory(loaded, settings),
  }
}
