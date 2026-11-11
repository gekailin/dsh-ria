// In-process WeChat File Transfer Helper connection for Ria.
//
// There is no bridge process and no port: the DSH host owns the WebWax client,
// receives user text, injects it into Ria as an ordinary user
// message, and forwards every assistant text message back to WeChat.

import { randomUUID } from 'node:crypto'
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { imageMediaType, imagePartFromMessage, isImageMessage, normalizeWechatImageOptions } from './image.mjs'
import { beginLogin } from './login.mjs'
import { decideMarkdownFile, markdownFileName, normalizeMarkdownFileOptions } from './markdown.mjs'
import { Outbound, PauseError } from './outbound.mjs'
import { WECHAT_REQUEST_PREFIX, isHostRequestId, isWechatRequestId } from './request-ids.mjs'
import { FILEHELPER_APPID, FILEHELPER_BASE, FILEHELPER_LOGIN, WebWxClient } from './wxweb.mjs'

const PEER = 'filehelper'
const SEEN_LIMIT = 500
const OUTBOX_LIMIT = 50
const LOGIN_PHASES = new Set(['connecting', 'waiting', 'scanned', 'starting'])
const FATAL_CODES = new Set([1100, 1101, 1102])
const FILE_NOTICE = '（内容较长，已转为 Markdown 文件发送）'
const FILE_FALLBACK_NOTICE = '（原回复已转为 Markdown 文件，但文件发送失败，以下改为文本）'
const DEFAULT_PAUSE_REASON = '微信推送已暂停'
const PAUSE_BY_MANUAL = 'manual'
const PAUSE_BY_CHANNEL = 'channel'
const USER_SOURCE_LIMIT = 500
const DROP_PREVIEW_LIMIT = 120
const MAX_IMAGE_BYTES = 20 * 1024 * 1024
const MARKDOWN_IMAGE_RE = /!\[([^\]\n]*)\]\(\s*(<[^>\n]+>|[^)\n]+?)\s*\)/g

function preview(text, limit = DROP_PREVIEW_LIMIT) {
  const value = String(text == null ? '' : text).replace(/\s+/g, ' ').trim()
  return value.length > limit ? value.slice(0, limit - 3) + '...' : value
}

function isPauseError(error) {
  return Boolean(error && error.code === 'WECHAT_PAUSED')
}

function ensureDir(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
}

function writeAtomic(file, text) {
  ensureDir(dirname(file))
  const temp = file + '.' + process.pid + '.' + randomUUID().slice(0, 8) + '.tmp'
  const fd = openSync(temp, 'w', 0o600)
  try {
    writeSync(fd, text)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameSync(temp, file)
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    if (error && error.code === 'ENOENT') return null
    throw error
  }
}

/** Small persisted state: inbound dedupe, failed outbound text, and push pause. */
class WechatState {
  constructor(file) {
    this.file = file
    this.data = {
      version: 2,
      seen: [],
      outbox: [],
      paused: false,
      pausedBy: null,
      pauseReason: null,
      pausedAt: null,
      resumedAt: null,
      resumedBy: null,
    }
    const loaded = readJson(file)
    if (loaded && typeof loaded === 'object') {
      if (Array.isArray(loaded.seen)) this.data.seen = loaded.seen.filter(item => typeof item === 'string').slice(-SEEN_LIMIT)
      if (Array.isArray(loaded.outbox)) {
        this.data.outbox = loaded.outbox
          .filter(item => item && typeof item.text === 'string')
          .slice(-OUTBOX_LIMIT)
      }
      if (loaded.paused === true) {
        this.data.paused = true
        this.data.pausedBy = loaded.pausedBy === PAUSE_BY_MANUAL ? PAUSE_BY_MANUAL : PAUSE_BY_CHANNEL
        this.data.pauseReason = typeof loaded.pauseReason === 'string' && loaded.pauseReason ? loaded.pauseReason : DEFAULT_PAUSE_REASON
        this.data.pausedAt = typeof loaded.pausedAt === 'string' ? loaded.pausedAt : null
      }
      if (typeof loaded.resumedAt === 'string') this.data.resumedAt = loaded.resumedAt
      if (loaded.resumedBy === PAUSE_BY_MANUAL || loaded.resumedBy === PAUSE_BY_CHANNEL) this.data.resumedBy = loaded.resumedBy
    }
  }

  get paused() { return this.data.paused === true }

  hasSeen(id) { return this.data.seen.includes(String(id)) }

  markSeen(id) {
    this.data.seen.push(String(id))
    if (this.data.seen.length > SEEN_LIMIT) this.data.seen.splice(0, this.data.seen.length - SEEN_LIMIT)
    this.save()
  }

  addOutbox(text) {
    this.data.outbox.push({ text, at: new Date().toISOString() })
    if (this.data.outbox.length > OUTBOX_LIMIT) this.data.outbox.splice(0, this.data.outbox.length - OUTBOX_LIMIT)
    this.save()
  }

  shiftOutbox() {
    this.data.outbox.shift()
    this.save()
  }

  dropOutbox(count) {
    this.data.outbox.splice(0, count)
    this.save()
  }

  save() {
    writeAtomic(this.file, JSON.stringify(this.data, null, 2) + '\n')
  }
}

/** Pull only the assistant text blocks out of one committed session event. */
export function assistantText(event) {
  const content = event && event.data && event.data.message && event.data.message.content
  if (!Array.isArray(content)) return ''
  return content
    .filter(block => block && block.type === 'text' && typeof block.text === 'string' && block.text.trim())
    .map(block => block.text)
    .join('\n')
}

function insideFence(text, index) {
  const before = text.slice(0, index)
  const fences = before.match(/^(?:```|~~~)/gm)
  return Boolean(fences && fences.length % 2 === 1)
}

function imageTarget(raw) {
  let target = String(raw || '').trim()
  if (target.startsWith('<') && target.endsWith('>')) return target.slice(1, -1).trim()
  target = target.replace(/\s+(?:"[^"]*"|'[^']*')$/, '').trim()
  return target
}

function localImage(raw, roots) {
  let target = String(raw || '').trim()
  try { target = decodeURIComponent(target) } catch { /* keep the literal path */ }
  if (!target || target.includes('\0')) return undefined
  if (/^[a-z][a-z0-9+.-]*:/i.test(target) && !target.startsWith('/')) return undefined
  const candidates = isAbsolute(target) ? [target] : roots.map(root => resolve(root, target))
  for (const file of candidates) {
    try {
      const info = statSync(file)
      if (!info.isFile() || info.size <= 0 || info.size > MAX_IMAGE_BYTES) continue
      const buffer = readFileSync(file)
      const mime = imageMediaType(buffer)
      if (!mime) continue
      return { name: basename(file), buffer, mime, path: file }
    } catch {
      // Missing or unreadable candidates fall through; the caller keeps the text.
    }
  }
  return undefined
}

/** Split assistant text into sendable local images and the remaining text. */
export function extractAssistantImages(text, roots = []) {
  const value = String(text == null ? '' : text)
  const matches = [...value.matchAll(MARKDOWN_IMAGE_RE)]
  if (!matches.length) return { text: value, images: [] }
  let out = ''
  let cursor = 0
  const images = []
  for (const match of matches) {
    const raw = match[0]
    if (insideFence(value, match.index)) {
      out += value.slice(cursor, match.index + raw.length)
      cursor = match.index + raw.length
      continue
    }
    out += value.slice(cursor, match.index)
    const image = localImage(imageTarget(match[2]), roots)
    if (image) images.push(image)
    else out += raw
    cursor = match.index + raw.length
  }
  out += value.slice(cursor)
  if (!images.length) return { text: value, images: [] }
  out = out.replace(/[ \t]+\n/g, '\n').replace(/\n[ \t]*\n(?:[ \t]*\n)+/g, '\n\n').trim()
  return { text: out, images }
}

/** Serial inbound message handling: one WeChat message at a time. Exported for tests. */
export class InboundBridge {
  constructor(service) {
    this.service = service
    this.chain = Promise.resolve()
    this.inFlight = new Set()
    this.lastUnsupportedAt = 0
  }

  submit(message) {
    this.chain = this.chain
      .then(() => this.handle(message))
      .catch(error => this.service.log('warn', 'WeChat inbound failed: ' + String(error && error.message ? error.message : error)))
    return this.chain
  }

  async handle(message) {
    if (!message || message.to !== PEER) return
    if (this.service.isOwnMessage(message)) return

    const image = isImageMessage(message) && this.service.image.inbound
    if (message.type !== 1 && !image) {
      if (![51, 10000, 10002].includes(message.type) && Date.now() - this.lastUnsupportedAt > 60_000) {
        this.lastUnsupportedAt = Date.now()
        this.service.notifyWechat('目前只能接收文本消息。').catch(() => {})
      }
      return
    }
    const text = image ? '' : String(message.text == null ? '' : message.text)
    if (!image && !text.trim()) return
    const key = String(message.id)
    if (this.inFlight.has(key) || this.service.state.hasSeen(key)) return
    this.inFlight.add(key)
    try {
      if (image) {
        await this.service.deliverImageFromWechat(message)
      } else {
        await this.service.deliverFromWechat(text)
      }
    } catch (error) {
      const reason = String(error && error.message ? error.message : error)
      this.service.log('warn', 'could not deliver WeChat message: ' + reason)
      try { await this.service.notifyWechat('消息未能交给 Ria：' + reason) } catch { /* no session */ }
    } finally {
      this.inFlight.delete(key)
      this.service.state.markSeen(key)
    }
  }
}

export class WechatService {
  constructor({ ctx, stateDir, ensureRia, getRiaId, log = () => {}, markdownFile, wechatImage } = {}) {
    this.ctx = ctx
    this.stateDir = stateDir
    this.ensureRia = ensureRia
    this.getRiaId = getRiaId
    this.log = log
    this.markdownOptions = normalizeMarkdownFileOptions(markdownFile)
    this.image = normalizeWechatImageOptions(wechatImage)
    this.workspaceRoots = [stateDir, process.cwd()]
    this.dir = join(stateDir, 'wechat')
    this.credsFile = join(this.dir, 'creds.json')
    this.state = new WechatState(join(this.dir, 'state.json'))
    this.session = undefined
    this.bridge = undefined
    this.outbound = undefined
    this.loginNonce = 0
    this.loginAbort = undefined
    this.login = { phase: 'idle', message: '' }
    this.lastError = undefined
    this.started = false
    this.timer = undefined
    this.flushing = false
    this.seenUserSources = new Set()
  }

  log(level, message) {
    if (typeof this.log === 'function') this.log(level, message)
  }

  subscribe() {
    return this.ctx.on('session/event', (session, event) => this.onSessionEvent(session, event))
  }

  onSessionEvent(session, event) {
    const riaId = this.getRiaId && this.getRiaId()
    if (!riaId || String(session.header.id) !== String(riaId)) return

    if (event.type === 'user/message') {
      this.observeUserMessage(event.data)
      return
    }
    if (event.type === 'agent/inbox/spliced') {
      const inserted = event.data && Array.isArray(event.data.inserted) ? event.data.inserted : []
      for (const message of inserted) this.observeUserMessage(message)
      return
    }
    if (!this.session || event.type !== 'assistant/message') return
    if (event.data && event.data.interrupted === true) return
    const text = assistantText(event)
    if (!text) return
    this.forwardAssistant(text)
  }

  /** Track one user message source. Host notifications and schedules are not channel activity. */
  observeUserMessage(message) {
    const source = message && message.source
    if (!source || source.kind !== 'user') return
    const rpcId = typeof source.rpcId === 'string' ? source.rpcId : ''
    if (!rpcId || isHostRequestId(rpcId)) return
    if (this.seenUserSources.has(rpcId)) return
    this.seenUserSources.add(rpcId)
    if (this.seenUserSources.size > USER_SOURCE_LIMIT) {
      const oldest = this.seenUserSources.values().next().value
      if (oldest !== undefined) this.seenUserSources.delete(oldest)
    }

    if (isWechatRequestId(rpcId)) {
      this.autoResume('微信消息')
    } else {
      this.autoPause('非微信通道消息')
    }
  }

  start(delayMs = 1200) {
    if (this.started) return
    this.started = true
    this.timer = setTimeout(() => { void this.autoStart() }, delayMs)
    if (this.timer.unref) this.timer.unref()
  }

  async autoStart() {
    if (!existsSync(this.credsFile)) {
      this.login = { phase: 'idle', message: '未连接微信' }
      return
    }
    try {
      await this.startFromCreds()
    } catch (error) {
      const message = String(error && error.message ? error.message : error)
      this.lastError = message
      this.login = { phase: 'error', message: '上次的微信登录不可用：' + message }
      this.log('warn', 'WeChat auto-start failed: ' + message)
    }
  }

  async startFromCreds() {
    if (this.session) return this.statusView()
    const creds = readJson(this.credsFile)
    if (!creds || typeof creds !== 'object') throw new Error('缺少微信登录凭据')
    await this.startSession(creds)
    return this.statusView()
  }

  async startSession(creds) {
    await this.stopSession()
    const client = new WebWxClient(creds, { log: message => this.log('info', '[wx] ' + message) })
    const init = await client.init()
    const session = {
      client,
      self: init.User,
      startedAt: new Date().toISOString(),
      lastError: undefined,
      abort: new AbortController(),
      stopping: false,
    }
    this.session = session
    this.outbound = new Outbound({
      send: text => client.sendText(PEER, text),
      sendFile: (name, buffer, mime) => client.sendFile(PEER, { name, buffer, mime }),
      sendImage: (name, buffer, mime) => client.sendImage(PEER, { name, buffer, mime }),
      log: message => this.log('warn', '[wx outbound] ' + message),
      prefix: '🌊 ',
    })
    if (this.state.paused) {
      this.outbound.setPaused(true, { onDrop: job => this.logDroppedJob(job) })
    }
    this.bridge = new InboundBridge(this)
    this.lastError = undefined
    this.login = { phase: 'success', message: '已登录: ' + (init.User && init.User.NickName ? init.User.NickName : '微信') }
    this.log('info', 'WeChat connected: ' + (init.User && init.User.NickName ? init.User.NickName : 'unknown'))
    void this.flushOutbox()
    client.run({
      signal: session.abort.signal,
      onMessage: message => { this.bridge.submit(message) },
      onError: error => {
        session.lastError = String(error && error.message ? error.message : error)
        this.log('warn', '[wx sync] ' + session.lastError)
      },
    }).catch(error => {
      if (session.stopping || session.abort.signal.aborted) return
      void this.sessionClosed(session, error)
    })
    return session
  }

  async sessionClosed(session, error) {
    if (this.session !== session) return
    const message = String(error && error.message ? error.message : error)
    const code = Number(error && error.code)
    this.lastError = message
    this.session = undefined
    this.outbound = undefined
    this.bridge = undefined
    this.login = { phase: 'idle', message: '微信连接已断开：' + message }
    this.log('warn', 'WeChat session closed: ' + message)
    if (FATAL_CODES.has(code)) {
      rmSync(this.credsFile, { force: true })
      this.login = { phase: 'error', message: '微信登录已失效，请重新扫码' }
    }
  }

  async stopSession({ notify = false } = {}) {
    const current = this.session
    if (!current) return { notified: null }
    current.stopping = true
    current.abort.abort()
    await this.bridge?.chain?.catch(() => {})
    let notified = null
    if (notify) {
      try { notified = await current.client.logout() } catch { notified = false }
    }
    this.session = undefined
    this.outbound = undefined
    this.bridge = undefined
    return { notified }
  }

  async shutdown() {
    if (this.timer) clearTimeout(this.timer)
    this.loginNonce += 1
    this.loginAbort?.abort()
    await this.stopSession()
  }

  isOwnMessage(message) {
    const client = this.session && this.session.client
    if (!client) return false
    const id = String(message.id)
    return Boolean(client.sentIds && client.sentIds.has(id))
  }

  async deliverFromWechat(text) {
    // A WeChat message is itself the signal that the user is back on the WeChat channel.
    this.setPaused(false, { by: PAUSE_BY_CHANNEL, reason: '微信消息' })
    if (!this.ensureRia) throw new Error('Ria service is unavailable')
    const sessionId = await this.ensureRia()
    await this.ctx.sessionController.prompt({
      requestId: WECHAT_REQUEST_PREFIX + randomUUID().replace(/-/g, '').slice(0, 20),
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text }],
    }, new AbortController().signal)
  }

  /**
   * Reserved inbound image path. Recognition is handled by InboundBridge; this
   * method owns download/convert/deliver. It is gated by wechatImage.inbound
   * (default false) and is not implemented yet, so it throws before delivery.
   *
   * TODO(inbound image): implement imagePartFromMessage first, then this method
   * already has the right prompt shape.
   */
  async deliverImageFromWechat(message) {
    // An inbound image is also a WeChat-channel signal, same as text.
    this.setPaused(false, { by: PAUSE_BY_CHANNEL, reason: '微信图片' })
    if (!this.ensureRia) throw new Error('Ria service is unavailable')
    const sessionId = await this.ensureRia()
    const signal = new AbortController().signal
    const part = await imagePartFromMessage(message, {
      client: this.session && this.session.client,
      signal,
    })
    await this.ctx.sessionController.prompt({
      requestId: WECHAT_REQUEST_PREFIX + randomUUID().replace(/-/g, '').slice(0, 20),
      sessionId,
      mode: 'queue',
      content: [part],
    }, signal)
  }

  /** Auto pause on a real non-WeChat channel message; never overwrite an explicit manual pause. */
  autoPause(reason) {
    if (this.state.paused) {
      if (this.state.data.pausedBy === PAUSE_BY_MANUAL) {
        this.log('info', 'auto pause ignored: manual pause is active')
      }
      return false
    }
    this.setPaused(true, { by: PAUSE_BY_CHANNEL, reason })
    return true
  }

  /** Auto resume on a WeChat message, including after a manual pause. */
  autoResume(reason) {
    if (!this.state.paused) return false
    this.setPaused(false, { by: PAUSE_BY_CHANNEL, reason })
    return true
  }

  /**
   * Manual or automatic pause/resume. Persist first, then gate the outbound queue:
   * queued messages are dropped with a log, an in-flight message finishes.
   */
  setPaused(paused, { by = PAUSE_BY_MANUAL, reason = '' } = {}) {
    const nextBy = by === PAUSE_BY_CHANNEL ? PAUSE_BY_CHANNEL : PAUSE_BY_MANUAL
    if (paused) {
      if (this.state.paused && this.state.data.pausedBy === PAUSE_BY_MANUAL && nextBy === PAUSE_BY_CHANNEL) {
        this.log('info', 'auto pause ignored: manual pause is active')
        return this.statusView()
      }
      const now = new Date().toISOString()
      const already = this.state.paused
      this.state.data.paused = true
      this.state.data.pausedBy = nextBy
      this.state.data.pauseReason = String(reason || '').trim() || DEFAULT_PAUSE_REASON
      // An automatic pause keeps the original start time; an explicit pause restarts it.
      this.state.data.pausedAt = already && nextBy === PAUSE_BY_CHANNEL && this.state.data.pausedAt
        ? this.state.data.pausedAt
        : now
      this.state.data.resumedAt = null
      this.state.data.resumedBy = null
      this.state.save()
      const dropped = this.outbound?.setPaused?.(true, { onDrop: job => this.logDroppedJob(job) }) || 0
      const record = {
        at: now,
        pausedBy: nextBy,
        reason: this.state.data.pauseReason,
        dropped,
        inFlight: Boolean(this.outbound && this.outbound.current),
      }
      this.log('warn', 'pause: ' + JSON.stringify(record))
      return this.statusView()
    }

    if (!this.state.paused) return this.statusView()
    const previousBy = this.state.data.pausedBy
    const now = new Date().toISOString()
    this.state.data.paused = false
    this.state.data.pausedBy = null
    this.state.data.pauseReason = null
    this.state.data.pausedAt = null
    this.state.data.resumedAt = now
    this.state.data.resumedBy = nextBy
    this.state.save()
    this.outbound?.setPaused?.(false)
    this.log('info', 'resume: ' + JSON.stringify({
      at: now,
      resumedBy: nextBy,
      reason: String(reason || ''),
      previousPausedBy: previousBy,
    }))
    void this.flushOutbox()
    return this.statusView()
  }

  logDroppedJob(job) {
    if (job.image) {
      this.logDropped('image', {
        name: job.name,
        bytes: Buffer.isBuffer(job.buffer) ? job.buffer.length : undefined,
      })
    } else if (job.file) {
      this.logDropped('file', {
        name: job.name,
        bytes: Buffer.isBuffer(job.buffer) ? job.buffer.length : undefined,
      })
    } else {
      this.logDropped('text', { chars: String(job.text || '').length, preview: preview(job.text) })
    }
  }

  logDropped(kind, details) {
    const record = {
      at: new Date().toISOString(),
      riaSessionId: (this.getRiaId && this.getRiaId()) || null,
      to: PEER,
      kind,
      pausedBy: this.state.data.pausedBy,
      reason: this.state.data.pauseReason,
      ...details,
    }
    this.log('warn', 'dropped outbound while paused: ' + JSON.stringify(record))
  }

  async notifyWechat(text) {
    const value = String(text == null ? '' : text)
    if (this.state.paused) {
      this.logDropped('system', { chars: value.length, preview: preview(value) })
      return null
    }
    const outbound = this.outbound
    if (!outbound) throw new Error('微信未登录')
    return await outbound.enqueue(value)
  }

  forwardAssistant(text) {
    const value = String(text == null ? '' : text)
    const outbound = this.outbound
    if (!outbound) return
    if (this.state.paused) {
      this.logDropped('assistant', { chars: value.length, preview: preview(value) })
      return
    }
    void this.deliverAssistant(outbound, value).catch(error => {
      if (isPauseError(error)) {
        this.logDropped('assistant', { chars: value.length, preview: preview(value) })
        return
      }
      const message = String(error && error.message ? error.message : error)
      this.log('warn', 'could not send assistant text to WeChat: ' + message)
      this.state.addOutbox(value)
    })
  }

  /**
   * Send the dispatch note to WeChat as an ordinary queued text message.
   *
   * The note is a user-facing confirmation, not an assistant reply, so it uses
   * the same Outbound queue and pause rules but never enters the retry outbox:
   * a failed notification is only logged and must not delay the dispatch.
   */
  async sendDispatchNote(note, { isTask = true } = {}) {
    const value = String(note == null ? '' : note).trim()
    if (!value) return false
    const message = (isTask ? '📌 任务已派发：' : '📌 消息已转交：') + value
    const outbound = this.outbound
    if (!outbound) {
      this.log('info', 'WeChat is not connected; skipped dispatch note')
      return false
    }
    if (this.state.paused) {
      this.logDropped('dispatch-note', { chars: message.length, preview: preview(message) })
      return false
    }
    try {
      await this.deliverAssistant(outbound, message)
      return true
    } catch (error) {
      if (isPauseError(error)) {
        this.logDropped('dispatch-note', { chars: message.length, preview: preview(message) })
        return false
      }
      const reason = String(error && error.message ? error.message : error)
      this.log('warn', 'could not send dispatch note to WeChat: ' + reason)
      return false
    }
  }

  async deliverAssistant(outbound, text) {
    if (this.state.paused) throw new PauseError()
    const value = String(text == null ? '' : text)
    const extracted = this.image.outbound && typeof outbound.enqueueImage === 'function'
      ? extractAssistantImages(value, this.workspaceRoots)
      : { text: value, images: [] }
    const clean = extracted.text
    const decision = decideMarkdownFile(clean, this.markdownOptions)
    if (!decision.file) {
      if (clean) await outbound.enqueue(clean)
      await this.sendAssistantImages(outbound, extracted.images)
      return
    }
    const name = markdownFileName(this.getRiaId && this.getRiaId())
    try { await outbound.enqueue(FILE_NOTICE) } catch { /* the file may still be deliverable */ }
    try {
      await outbound.enqueueFile({ name, buffer: Buffer.from(clean, 'utf8'), mime: 'text/markdown' })
    } catch (error) {
      if (isPauseError(error)) throw error
      this.log('warn', 'could not send Markdown file ' + name + ': ' + String(error && error.message ? error.message : error))
      await outbound.enqueue(FILE_FALLBACK_NOTICE + '\n\n' + clean)
    }
    await this.sendAssistantImages(outbound, extracted.images)
  }

  /** Send extracted local images after the text; one failure never fails the whole reply. */
  async sendAssistantImages(outbound, images) {
    for (const image of images || []) {
      try {
        await outbound.enqueueImage({ name: image.name, buffer: image.buffer, mime: image.mime })
      } catch (error) {
        if (isPauseError(error)) throw error
        this.log('warn', 'could not send image ' + image.path + ' to WeChat: ' + String(error && error.message ? error.message : error))
      }
    }
  }

  async flushOutbox() {
    if (this.flushing || this.state.paused) return
    this.flushing = true
    try {
      const backlog = this.state.data.outbox.length
      if (this.outbound && backlog > 10) {
        const skipped = backlog - 10
        await this.outbound.enqueue('（微信重连：跳过 ' + skipped + ' 条积压消息，只补发最后 10 条）')
        this.state.dropOutbox(skipped)
      }
      while (this.outbound && this.state.data.outbox.length) {
        if (this.state.paused) return
        const item = this.state.data.outbox[0]
        await this.outbound.enqueue(item.text)
        this.state.shiftOutbox()
      }
    } catch (error) {
      if (isPauseError(error)) return
      this.lastError = String(error && error.message ? error.message : error)
      this.log('warn', 'could not flush WeChat outbox: ' + this.lastError)
    } finally {
      this.flushing = false
    }
  }

  statusView() {
    const session = this.session
    const login = { phase: this.login.phase, message: this.login.message }
    if (this.login.qr) login.qr = this.login.qr
    return {
      ok: true,
      loggedIn: Boolean(session),
      ...(session && session.self ? { nick: session.self.NickName, user: session.self.UserName } : {}),
      ...(session ? { since: session.startedAt } : {}),
      ...(session && session.lastError ? { error: session.lastError } : this.lastError ? { error: this.lastError } : {}),
      pendingOutbox: this.state.data.outbox.length,
      paused: this.state.paused,
      pausedBy: this.state.data.pausedBy ?? null,
      pauseReason: this.state.data.pauseReason ?? null,
      pausedAt: this.state.data.pausedAt ?? null,
      resumedAt: this.state.data.resumedAt ?? null,
      resumedBy: this.state.data.resumedBy ?? null,
      login,
    }
  }

  async startLogin() {
    if (this.session) return this.statusView()
    if (LOGIN_PHASES.has(this.login.phase)) return this.statusView()
    const nonce = ++this.loginNonce
    this.loginAbort?.abort()
    const abort = new AbortController()
    this.loginAbort = abort
    this.login = { phase: 'connecting', message: '正在获取二维码…' }
    let flow
    try {
      flow = await beginLogin({
        loginBase: process.env.WX_LOGIN_BASE || FILEHELPER_LOGIN,
        base: process.env.WX_BASE || FILEHELPER_BASE,
        appId: process.env.WX_APPID || FILEHELPER_APPID,
        signal: abort.signal,
        onStatus: (text, phase) => {
          if (nonce !== this.loginNonce) return
          if (phase) this.login.phase = phase
          this.login.message = text
        },
      })
    } catch (error) {
      if (nonce === this.loginNonce) {
        this.login = { phase: 'error', message: String(error && error.message ? error.message : error) }
      }
      return this.statusView()
    }
    if (nonce !== this.loginNonce) {
      abort.abort()
      return this.statusView()
    }
    this.login.qr = 'data:image/jpeg;base64,' + flow.qr.toString('base64')
    const initial = flow.status()
    this.login.phase = initial.phase
    this.login.message = initial.message
    flow.done
      .then(async ({ creds, user }) => {
        if (nonce !== this.loginNonce) return
        this.login = { phase: 'starting', message: '登录成功，正在连接…' }
        writeAtomic(this.credsFile, JSON.stringify(creds, null, 2) + '\n')
        try {
          await this.startSession(creds)
          if (nonce !== this.loginNonce) {
            await this.stopSession({ notify: true })
            return
          }
          this.login = { phase: 'success', message: '已登录: ' + (user && user.NickName ? user.NickName : '微信') }
        } catch (error) {
          if (nonce !== this.loginNonce) return
          this.login = { phase: 'error', message: '连接失败: ' + String(error && error.message ? error.message : error) }
        }
      })
      .catch(error => {
        if (nonce !== this.loginNonce) return
        this.login = { phase: 'error', message: String(error && error.message ? error.message : error) }
      })
    return this.statusView()
  }

  async logout() {
    this.loginNonce += 1
    this.loginAbort?.abort()
    this.loginAbort = undefined
    const result = await this.stopSession({ notify: true })
    rmSync(this.credsFile, { force: true })
    this.login = {
      phase: 'idle',
      message: result.notified === false ? '已退出登录，但微信服务器未确认' : '已退出登录',
    }
    this.lastError = undefined
    return this.statusView()
  }
}
