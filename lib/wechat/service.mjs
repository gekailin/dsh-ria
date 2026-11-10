// In-process WeChat File Transfer Helper connection for the Super Session.
//
// There is no bridge process and no port: the DSH host owns the WebWax client,
// receives user text, injects it into the Super Session as an ordinary user
// message, and forwards every assistant text message back to WeChat.

import { randomUUID } from 'node:crypto'
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { beginLogin } from './login.mjs'
import { Outbound } from './outbound.mjs'
import { FILEHELPER_APPID, FILEHELPER_BASE, FILEHELPER_LOGIN, WebWxClient } from './wxweb.mjs'

const PEER = 'filehelper'
const SEEN_LIMIT = 500
const OUTBOX_LIMIT = 50
const LOGIN_PHASES = new Set(['connecting', 'waiting', 'scanned', 'starting'])
const FATAL_CODES = new Set([1100, 1101, 1102])

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

/** Small persisted state: inbound dedupe and failed outbound text. */
class WechatState {
  constructor(file) {
    this.file = file
    this.data = { version: 1, seen: [], outbox: [] }
    const loaded = readJson(file)
    if (loaded && typeof loaded === 'object') {
      if (Array.isArray(loaded.seen)) this.data.seen = loaded.seen.filter(item => typeof item === 'string').slice(-SEEN_LIMIT)
      if (Array.isArray(loaded.outbox)) {
        this.data.outbox = loaded.outbox
          .filter(item => item && typeof item.text === 'string')
          .slice(-OUTBOX_LIMIT)
      }
    }
  }

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
    if (message.type !== 1) {
      if (![51, 10000, 10002].includes(message.type) && Date.now() - this.lastUnsupportedAt > 60_000) {
        this.lastUnsupportedAt = Date.now()
        this.service.notifyWechat('目前只能接收文本消息。').catch(() => {})
      }
      return
    }
    const text = String(message.text == null ? '' : message.text)
    if (!text.trim()) return
    const key = String(message.id)
    if (this.inFlight.has(key) || this.service.state.hasSeen(key)) return
    this.inFlight.add(key)
    try {
      await this.service.deliverFromWechat(text)
    } catch (error) {
      const reason = String(error && error.message ? error.message : error)
      this.service.log('warn', 'could not deliver WeChat message: ' + reason)
      try { await this.service.notifyWechat('消息未能交给 Super Session：' + reason) } catch { /* no session */ }
    } finally {
      this.inFlight.delete(key)
      this.service.state.markSeen(key)
    }
  }
}

export class WechatService {
  constructor({ ctx, stateDir, ensureSuper, getSuperId, log = () => {} }) {
    this.ctx = ctx
    this.stateDir = stateDir
    this.ensureSuper = ensureSuper
    this.getSuperId = getSuperId
    this.log = log
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
  }

  log(level, message) {
    if (typeof this.log === 'function') this.log(level, message)
  }

  subscribe() {
    return this.ctx.on('session/event', (session, event) => this.onSessionEvent(session, event))
  }

  onSessionEvent(session, event) {
    if (!this.session || event.type !== 'assistant/message') return
    if (event.data && event.data.interrupted === true) return
    const superId = this.getSuperId && this.getSuperId()
    if (!superId || String(session.header.id) !== String(superId)) return
    const text = assistantText(event)
    if (!text) return
    this.forwardAssistant(text)
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
      log: message => this.log('warn', '[wx outbound] ' + message),
      prefix: '',
    })
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
    if (!this.ensureSuper) throw new Error('Super Session service is unavailable')
    const sessionId = await this.ensureSuper()
    await this.ctx.sessionController.prompt({
      requestId: 'req_' + randomUUID().replace(/-/g, '').slice(0, 20),
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text }],
    })
  }

  async notifyWechat(text) {
    const outbound = this.outbound
    if (!outbound) throw new Error('微信未登录')
    return await outbound.enqueue(text)
  }

  forwardAssistant(text) {
    const outbound = this.outbound
    if (!outbound) return
    outbound.enqueue(text).catch(error => {
      const message = String(error && error.message ? error.message : error)
      this.log('warn', 'could not send assistant text to WeChat: ' + message)
      this.state.addOutbox(text)
    })
  }

  async flushOutbox() {
    if (this.flushing) return
    this.flushing = true
    try {
      const backlog = this.state.data.outbox.length
      if (this.outbound && backlog > 10) {
        const skipped = backlog - 10
        await this.outbound.enqueue('（微信重连：跳过 ' + skipped + ' 条积压消息，只补发最后 10 条）', { prefix: false })
        this.state.dropOutbox(skipped)
      }
      while (this.outbound && this.state.data.outbox.length) {
        const item = this.state.data.outbox[0]
        await this.outbound.enqueue(item.text, { prefix: false })
        this.state.shiftOutbox()
      }
    } catch (error) {
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
