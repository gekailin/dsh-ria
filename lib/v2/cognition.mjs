import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, writeSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'

const MAX_READ = 64 * 1024
const MAX_TOTAL = 6000
const MAX_DIGEST = 1500
const text = value => typeof value === 'string' ? value.trim() : ''
const clip = (value, max) => {
  const s = String(value == null ? '' : value)
  return s.length > max ? s.slice(0, max) + '\n…（截断）' : s
}

function atomicWrite(path, content) {
  mkdirSync(resolve(path, '..'), { recursive: true, mode: 0o700 })
  const temp = path + '.tmp-' + process.pid
  const fd = openSync(temp, 'w', 0o600)
  try {
    writeSync(fd, String(content))
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameSync(temp, path)
}

export function projectKey(workspace) {
  const raw = text(workspace)
  if (!raw) return 'global'
  let real = resolve(raw)
  try { real = realpathSync(real) } catch { /* keep resolved path */ }
  const base = real.split(sep).filter(Boolean).pop() || 'project'
  const slug = base.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'project'
  return slug + '-' + createHash('sha1').update(real).digest('hex').slice(0, 8)
}

export class CognitionStore {
  constructor({ stateDir, log = () => {}, audit = () => {} } = {}) {
    if (!stateDir) throw new Error('CognitionStore requires stateDir')
    this.stateDir = stateDir
    this.base = join(stateDir, 'cognition')
    this.log = log
    this.audit = audit
  }

  ensure() {
    mkdirSync(this.base, { recursive: true, mode: 0o700 })
    // cognition/chatbot/ keeps its directory name: existing memory files live
    // there and the Chat role's rename is an identity change, not a data move.
    for (const dir of ['projects', 'chatbot', 'proposals']) mkdirSync(join(this.base, dir), { recursive: true, mode: 0o700 })
    let created = false
    for (const file of ['principles.md', 'INDEX.md', 'chatbot/preferences.md', 'chatbot/agreements.md', 'chatbot/decisions.md']) {
      const path = join(this.base, file)
      if (!existsSync(path)) {
        atomicWrite(path, '')
        created = true
      }
    }
    if (created || !existsSync(join(this.base, 'INDEX.md'))) this.updateIndex()
    return this
  }

  safePath(relPath) {
    const raw = String(relPath == null ? '' : relPath).trim()
    if (!raw || raw.startsWith('/') || raw.includes('\u0000')) throw Object.assign(new Error('invalid cognition path'), { code: 'cognition_path_invalid' })
    const full = resolve(this.base, raw)
    const rel = relative(this.base, full)
    if (!rel || rel.startsWith('..') || rel.includes('..' + sep) || rel.startsWith(sep)) {
      throw Object.assign(new Error('cognition path escapes the store'), { code: 'cognition_path_invalid' })
    }
    return full
  }

  read(relPath = 'INDEX.md') {
    const full = this.safePath(relPath)
    if (!existsSync(full)) throw Object.assign(new Error('cognition file not found: ' + relPath), { code: 'cognition_missing' })
    const content = readFileSync(full, 'utf8')
    return content.length > MAX_READ ? content.slice(0, MAX_READ) : content
  }

  write(relPath, content, { mode = 'replace', reason = '', source = 'sage' } = {}) {
    const rel = String(relPath || '').trim()
    if (rel === 'INDEX.md' || rel.startsWith('proposals/')) throw Object.assign(new Error('INDEX.md and proposals/ are managed'), { code: 'cognition_path_reserved' })
    const full = this.safePath(rel)
    const body = String(content == null ? '' : content)
    if (body.length > MAX_READ) throw Object.assign(new Error('cognition file too large'), { code: 'cognition_too_large' })
    let next = body
    if (mode === 'append') {
      const previous = existsSync(full) ? readFileSync(full, 'utf8') : ''
      next = previous + (previous && !previous.endsWith('\n') ? '\n' : '') + body
      if (next.length > MAX_READ) throw Object.assign(new Error('cognition file too large after append'), { code: 'cognition_too_large' })
    }
    atomicWrite(full, next)
    const before = this.indexVersion()
    this.updateIndex()
    const version = this.indexVersion()
    this.audit({ event: 'cognition.write', path: rel, mode, reason: text(reason), source: text(source) || 'sage', bytes: Buffer.byteLength(next) })
    if (version !== before) {
      const changedAt = new Date().toISOString()
      const changedFiles = [rel, 'INDEX.md']
      this.audit({ event: 'cognition.index.changed', payload: { version, changedFiles, timestamp: changedAt } })
      try { if (typeof this.onIndexChanged === 'function') this.onIndexChanged({ version, changedFiles, timestamp: changedAt }) } catch { /* notification never blocks writes */ }
    }
    return { ok: true, path: rel, bytes: Buffer.byteLength(next), mode }
  }

  listFiles(dir = this.base, prefix = '') {
    const out = []
    for (const name of readdirSync(dir).sort()) {
      if (name === 'INDEX.md' || name.startsWith('.')) continue
      const full = join(dir, name)
      const rel = prefix ? prefix + '/' + name : name
      const stat = statSync(full)
      if (stat.isDirectory()) {
        if (name === 'proposals') continue
        out.push(...this.listFiles(full, rel))
      } else if (stat.isFile()) out.push({ path: rel, bytes: stat.size, updatedAt: stat.mtimeMs })
    }
    return out
  }

  updateIndex() {
    mkdirSync(this.base, { recursive: true, mode: 0o700 })
    const files = this.listFiles()
    const lessonsFile = join(this.stateDir, 'lessons.json')
    if (existsSync(lessonsFile)) {
      try {
        const stat = statSync(lessonsFile)
        files.push({ path: 'lessons.json (external)', bytes: stat.size, updatedAt: stat.mtimeMs })
      } catch { /* ignore */ }
    }
    const lines = ['# Cognition Index', '', 'Sage-owned memory. Advisors read snapshots; Chat reads a digest.', '', '| File | Bytes | Updated |', '|---|---:|---|']
    for (const file of files) lines.push('| ' + file.path + ' | ' + file.bytes + ' | ' + new Date(file.updatedAt || Date.now()).toISOString() + ' |')
    atomicWrite(join(this.base, 'INDEX.md'), lines.join('\n') + '\n')
  }

  readIfExists(relPath) {
    try { return this.read(relPath) } catch { return '' }
  }

  retrieve({ workspace, goal, lessons = [] } = {}) {
    this.ensure()
    let degraded = false
    let principles = ''
    try { principles = this.readIfExists('principles.md') } catch { degraded = true }
    const key = projectKey(workspace)
    const project = this.readIfExists('projects/' + key + '.md') || this.readIfExists('projects/dsh-ria.md') || this.readIfExists('projects/global.md')
    const decisionsRaw = this.readIfExists('chatbot/decisions.md')
    const decisions = decisionsRaw.split(/\n\s*\n/).filter(Boolean).slice(-10)
    const lessonLines = Array.isArray(lessons) ? lessons.slice(0, 5).map(item => {
      if (typeof item === 'string') return item
      return '- ' + [item.scenario, item.pitfall, item.approach].filter(Boolean).join(' → ')
    }) : []
    const sections = []
    if (principles) sections.push('[Principles]\n' + clip(principles, 1500))
    if (project) sections.push('[Project ' + key + ']\n' + clip(project, 2000))
    if (lessonLines.length) sections.push('[Lessons]\n' + clip(lessonLines.join('\n'), 2000))
    if (decisions.length) sections.push('[Decisions]\n' + clip(decisions.join('\n\n'), 1500))
    let snapshot = sections.join('\n\n')
    if (snapshot.length > MAX_TOTAL) snapshot = snapshot.slice(0, MAX_TOTAL) + '\n…（认知快照已截断）'
    if (!principles && !project && !lessonLines.length && !decisions.length) degraded = true
    return { snapshot, files: [principles ? 'principles.md' : '', project ? 'projects/' + key + '.md' : ''].filter(Boolean), degraded, budget: { total: MAX_TOTAL }, projectKey: key, goal: text(goal) }
  }

  /**
   * Chat memory digest. The text is bounded by MAX_DIGEST including the
   * truncation marker, and degraded reports a file that was missing or
   * unreadable (the caller renders a placeholder instead of failing the turn).
   */
  chatbotDigest() {
    const files = ['chatbot/preferences.md', 'chatbot/agreements.md', 'chatbot/decisions.md']
    // Report missing files as degraded even though ensure() recreates them as
    // empty below: the caller must know the memory may be incomplete.
    let degraded = files.some(rel => !existsSync(join(this.base, rel)))
    this.ensure()
    const parts = []
    for (const rel of files) {
      try {
        const content = this.read(rel)
        const trimmed = content.trim()
        if (trimmed) parts.push(trimmed)
      } catch {
        degraded = true
      }
    }
    if (!parts.length) return { text: '', degraded, truncated: false }
    const full = '长期记忆，仅供参考，当前用户消息优先。\n' + parts.join('\n\n')
    if (full.length <= MAX_DIGEST) return { text: full, degraded, truncated: false }
    const marker = '\n…（已截断）'
    return { text: full.slice(0, MAX_DIGEST - marker.length) + marker, degraded, truncated: true }
  }

  indexVersion() {
    try {
      return createHash('sha256').update(this.readIfExists('INDEX.md')).digest('hex').slice(0, 16)
    } catch { return '' }
  }

  indexDigest() {
    this.ensure()
    return clip(this.readIfExists('INDEX.md'), MAX_DIGEST)
  }

  sageIndexSnapshot(maxChars = 2000) {
    this.ensure()
    const entries = []
    for (const file of this.listFiles()) {
      let summary = ''
      let version = ''
      try {
        const content = this.readIfExists(file.path)
        const first = content.split('\n').map(line => line.trim()).find(line => line && !line.startsWith('#')) || ''
        summary = clip(first, 160)
        version = createHash('sha1').update(content).digest('hex').slice(0, 8)
      } catch { /* keep empty summary */ }
      entries.push({ path: file.path, summary, version, updatedAt: file.updatedAt })
    }
    const render = detailed => {
      const lines = ['[cognition INDEX 快照]', 'INDEX 可能滞后；以实际文件为准，需要最新内容用 sage_read。']
      for (const entry of entries) {
        if (!detailed) lines.push('- ' + entry.path)
        else lines.push('- ' + entry.path + ' — ' + (entry.summary || '（无摘要）') + ' (v:' + (entry.version || '?') + ', ' + new Date(entry.updatedAt || Date.now()).toISOString() + ')')
      }
      return lines.join('\n')
    }
    let text = render(true)
    if (text.length > maxChars) text = render(false)
    if (text.length > maxChars) text = clip(text, maxChars)
    return { text, truncated: text.length > maxChars, files: entries.map(item => item.path) }
  }

  propose({ author, source, ticketId = '', scope = 'global', text: body, evidence = [], priority = 'normal' } = {}) {
    this.ensure()
    const who = text(author) || 'unknown'
    const id = 'prop_' + Date.now().toString(36) + '_' + randomUUID().replace(/-/g, '').slice(0, 8)
    const proposal = { id, author: who, source: text(source) || who, ticketId: text(ticketId), scope: text(scope) || 'global', text: text(body), evidence: Array.isArray(evidence) ? evidence.map(String).slice(0, 10) : [], priority: who === 'user' ? 'high' : (text(priority) || 'normal'), status: 'pending', createdAt: Date.now() }
    if (!proposal.text) throw Object.assign(new Error('proposal text is required'), { code: 'proposal_empty' })
    atomicWrite(join(this.base, 'proposals', id + '.json'), JSON.stringify(proposal, null, 2) + '\n')
    this.updateIndex()
    this.audit({ event: 'cognition.proposal', proposalId: id, author: proposal.author, scope: proposal.scope, priority: proposal.priority, ticketId: proposal.ticketId })
    return proposal
  }

  listProposals() {
    this.ensure()
    const dir = join(this.base, 'proposals')
    const out = []
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.json')) continue
      try {
        const item = JSON.parse(readFileSync(join(dir, name), 'utf8'))
        if (item && item.status === 'pending') out.push(item)
      } catch { /* ignore corrupt */ }
    }
    return out.sort((a, b) => (a.priority === 'high' ? -1 : 0) - (b.priority === 'high' ? -1 : 0) || b.createdAt - a.createdAt)
  }

  resolveProposal(id, status = 'accepted') {
    const full = join(this.base, 'proposals', String(id) + '.json')
    if (!existsSync(full)) throw Object.assign(new Error('proposal not found'), { code: 'proposal_missing' })
    const item = JSON.parse(readFileSync(full, 'utf8'))
    item.status = status
    item.reviewedAt = Date.now()
    atomicWrite(full, JSON.stringify(item, null, 2) + '\n')
    this.audit({ event: 'cognition.proposal-' + status, proposalId: item.id, author: item.author })
    return item
  }
}
