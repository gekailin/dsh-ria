// WeChat "Claw" channel: the iLink bot protocol used by Tencent's
// openclaw-weixin plugin.
//
// Pairing is a QR login. The QR payload is a URL returned by
// /ilink/bot/get_bot_qrcode. After the user confirms on the phone the server
// returns a bot token and account id; those credentials are stored locally
// and reused on the next DSH start. Inbound messages are long-polled with
// getupdates and replies are sent with sendmessage.

import { randomBytes, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { assistantText } from '../wechat/service.mjs'
import { Outbound } from '../wechat/outbound.mjs'
import { ensureDir, errorText, qrDataUrl, readJson, removeFile, requestJson, sleep, userFacingError, writeAtomic } from './common.mjs'
import { isWechatClawRequestId, WECHAT_CLAW_REQUEST_PREFIX } from './request-ids.mjs'

const DEFAULT_BASE = 'https://ilinkai.weixin.qq.com'
const BOT_TYPE = '3'
const CHANNEL_VERSION = '1.0.3'
const LONG_POLL_TIMEOUT_MS = 45000
const LOGIN_TIMEOUT_MS = 480000
const DEFAULT_QR_POLL_MS = 1200
const QR_REFRESH_LIMIT = 3
const SEEN_LIMIT = 500
const USER_SOURCE_LIMIT = 500
const PAUSE_BY_MANUAL = 'manual'
const PAUSE_BY_CHANNEL = 'channel'

function qrPollMs() {
  const value = Number(process.env.WX_CLAW_QR_POLL_MS)
  return Number.isFinite(value) && value >= 10 ? value : DEFAULT_QR_POLL_MS
}

function baseInfo() {
  return { channel_version: CHANNEL_VERSION }
}

function botHeaders(token, extra = {}) {
  const uin = randomBytes(4).readUInt32BE(0)
  return {
    'content-type': 'application/json',
    AuthorizationType: 'ilink_bot_token',
    'X-WECHAT-UIN': Buffer.from(String(uin), 'utf8').toString('base64'),
    ...(token ? { authorization: 'Bearer ' + token } : {}),
    ...extra,
  }
}

export function normalizeAccountId(value) {
  const raw = String(value || '')
  if (raw.endsWith('-im-bot')) return raw.slice(0, -'-im-bot'.length) + '@im.bot'
  if (raw.endsWith('-im-wechat')) return raw.slice(0, -'-im-wechat'.length) + '@im.wechat'
  return raw
}

function textOf(message) {
  const items = Array.isArray(message && message.item_list) ? message.item_list : []
  const parts = []
  for (const item of items) {
    if (item && item.type === 1 && item.text_item && typeof item.text_item.text === 'string') {
      parts.push(item.text_item.text)
    }
  }
  return parts.join('\n').trim()
}

function messageIdOf(message) {
  return String(
    (message && (message.message_id || message.msg_id || message.client_id)) || '',
  )
}

export class WechatClawService {
  constructor({ ctx, stateDir, ensureRia, getRiaId, log }) {
    this.ctx = ctx
    this.ensureRia = ensureRia
    this.getRiaId = getRiaId
    this.log = typeof log === 'function' ? log : () => {}
    this.dir = join(stateDir, 'wechat-claw')
    this.credsFile = join(this.dir, 'creds.json')
    this.stateFile = join(this.dir, 'state.json')
    this.cursorFile = join(this.dir, 'cursor.json')
    this.login = { phase: 'idle', message: '未连接微信 Claw' }
    this.loginNonce = 0
    this.loginAbort = undefined
    this.session = undefined
    this.outbound = undefined
    this.peer = undefined
    this.lastError = ''
    this.started = false
    this.timer = undefined
    this.paused = false
    this.pausedBy = ''
    this.pauseReason = ''
    this.pausedAt = ''
    this.resumedAt = ''
    this.resumedBy = ''
    this.seenUserSources = new Set()
    this.seenMessages = new Set()
    this.deliveryAbort = new AbortController()
    this.loadState()
  }

  loadState() {
    try {
      const state = readJson(this.stateFile)
      if (!state || typeof state !== 'object') return
      this.paused = state.paused === true
      this.pausedBy = typeof state.pausedBy === 'string' ? state.pausedBy : ''
      this.pauseReason = typeof state.pauseReason === 'string' ? state.pauseReason : ''
      this.pausedAt = typeof state.pausedAt === 'string' ? state.pausedAt : ''
      this.resumedAt = typeof state.resumedAt === 'string' ? state.resumedAt : ''
      this.resumedBy = typeof state.resumedBy === 'string' ? state.resumedBy : ''
    } catch (error) {
      this.log('warn', 'could not read WeChat Claw state: ' + errorText(error))
    }
  }

  saveState() {
    writeAtomic(this.stateFile, JSON.stringify({
      version: 1,
      paused: this.paused,
      pausedBy: this.pausedBy,
      pauseReason: this.pauseReason,
      pausedAt: this.pausedAt,
      resumedAt: this.resumedAt,
      resumedBy: this.resumedBy,
    }, null, 2) + '\n')
  }

  subscribe() {
    return this.ctx.on('session/event', (session, event) => this.onSessionEvent(session, event))
  }

  onSessionEvent(session, event) {
    const riaId = this.getRiaId()
    if (!riaId || !session || !event || session.header.id !== riaId) return
    if (event.type === 'user/message' || event.type === 'agent/inbox/spliced') {
      this.observeUserMessage(event.data && event.data.message ? event.data.message : event.data)
      return
    }
    if (event.type === 'assistant/message' && !(event.data && event.data.interrupted)) {
      const text = assistantText(event)
      if (text) this.forwardAssistant(text)
    }
  }

  observeUserMessage(message) {
    if (!message || !message.source || message.source.kind !== 'user') return
    const rpcId = message.rpcId
    if (typeof rpcId !== 'string' || !rpcId || rpcId.startsWith('host_')) return
    if (this.seenUserSources.has(rpcId)) return
    this.seenUserSources.add(rpcId)
    if (this.seenUserSources.size > USER_SOURCE_LIMIT) {
      this.seenUserSources.delete(this.seenUserSources.values().next().value)
    }
    if (isWechatClawRequestId(rpcId)) this.autoResume('微信 Claw 消息')
    else this.autoPause('非微信 Claw 通道消息')
  }

  autoPause(reason) {
    if (this.paused && this.pausedBy === PAUSE_BY_MANUAL) return
    this.setPaused(true, { by: PAUSE_BY_CHANNEL, reason })
  }

  autoResume(reason) {
    if (!this.paused) return
    if (this.pausedBy === PAUSE_BY_CHANNEL) this.setPaused(false, { by: PAUSE_BY_CHANNEL, reason })
  }

  setPaused(paused, { by = PAUSE_BY_MANUAL, reason = '' } = {}) {
    const next = Boolean(paused)
    this.paused = next
    this.pausedBy = next ? by : ''
    this.pauseReason = next ? reason : ''
    if (next) {
      this.pausedAt = new Date().toISOString()
      this.resumedAt = ''
      this.resumedBy = ''
    } else {
      this.resumedAt = new Date().toISOString()
      this.resumedBy = by
    }
    try {
      this.saveState()
    } catch (error) {
      this.log('warn', 'could not save WeChat Claw pause state: ' + errorText(error))
    }
    if (this.outbound) this.outbound.setPaused(next, { onDrop: job => this.log('info', 'dropped queued Claw message: ' + JSON.stringify(job)) })
    return this.statusView()
  }

  start(delayMs = 1600) {
    if (this.started) return
    this.started = true
    this.timer = setTimeout(() => { void this.autoStart() }, delayMs)
    if (this.timer.unref) this.timer.unref()
  }

  async autoStart() {
    // A QR login may already be running if the panel opened right after DSH
    // started; never overwrite its phase with the idle placeholder.
    if (this.session) return
    if (this.login && ['connecting', 'waiting', 'scanned', 'starting'].includes(this.login.phase)) return
    const creds = this.readCreds()
    if (!creds) {
      this.login = { phase: 'idle', message: '未连接微信 Claw' }
      return
    }
    try {
      await this.startSession(creds)
    } catch (error) {
      const message = userFacingError(error)
      this.lastError = message
      this.login = { phase: 'error', message: '上次的微信 Claw 登录不可用：' + message }
      this.log('warn', 'could not restore WeChat Claw session: ' + message)
    }
  }

  readCreds() {
    try {
      const creds = readJson(this.credsFile)
      if (!creds || typeof creds.token !== 'string' || !creds.token) return null
      return creds
    } catch (error) {
      this.log('warn', 'could not read WeChat Claw credentials: ' + errorText(error))
      return null
    }
  }

  async startFromCreds() {
    if (this.session) return this.statusView()
    const creds = this.readCreds()
    if (!creds) {
      this.login = { phase: 'idle', message: '未连接微信 Claw' }
      return this.statusView()
    }
    try {
      await this.startSession(creds)
    } catch (error) {
      const message = userFacingError(error)
      this.login = { phase: 'error', message: '微信 Claw 登录不可用：' + message }
    }
    return this.statusView()
  }

  async startSession(creds) {
    this.stopSession()
    ensureDir(this.dir)
    this.login = { phase: 'starting', message: '正在连接微信 Claw…' }
    const session = {
      accountId: normalizeAccountId(creds.accountId || creds.ilinkBotId),
      token: creds.token,
      baseUrl: String(creds.baseUrl || DEFAULT_BASE).replace(/\/$/, ''),
      userId: creds.userId || '',
      startedAt: new Date().toISOString(),
      abort: new AbortController(),
      stopping: false,
      error: '',
    }
    this.session = session
    this.lastError = ''
    this.outbound = new Outbound({
      send: text => this.sendText(text),
      log: this.log,
      prefix: '🌊 ',
    })
    if (this.paused) this.outbound.setPaused(true)
    this.login = {
      phase: 'success',
      message: '已连接微信 Claw：' + (session.accountId || '当前账号'),
    }
    this.log('info', 'WeChat Claw connected as ' + session.accountId)
    void this.monitor(session)
    return this.statusView()
  }

  async monitor(session) {
    let cursor = ''
    try {
      const saved = readJson(this.cursorFile)
      if (saved && typeof saved.cursor === 'string') cursor = saved.cursor
    } catch {
      /* start from an empty cursor */
    }
    let failures = 0
    let lastPersisted = cursor
    while (!session.abort.signal.aborted) {
      try {
        const data = await requestJson(session.baseUrl + '/ilink/bot/getupdates', {
          method: 'POST',
          headers: botHeaders(session.token),
          body: { get_updates_buf: cursor, base_info: baseInfo() },
          signal: session.abort.signal,
          timeoutMs: LONG_POLL_TIMEOUT_MS,
        })
        if (data && typeof data.ret === 'number' && data.ret !== 0) {
          throw new Error('getupdates ret=' + data.ret + (data.errcode ? ' errcode=' + data.errcode : ''))
        }
        if (data && typeof data.errcode === 'number' && data.errcode !== 0) {
          throw new Error('getupdates errcode=' + data.errcode)
        }
        failures = 0
        session.error = ''
        this.lastError = ''
        if (typeof data.get_updates_buf === 'string') {
          cursor = data.get_updates_buf
          if (cursor !== lastPersisted) {
            writeAtomic(this.cursorFile, JSON.stringify({ cursor, savedAt: new Date().toISOString() }, null, 2) + '\n')
            lastPersisted = cursor
          }
        }
        const messages = Array.isArray(data.msgs) ? data.msgs : []
        for (const message of messages) {
          if (session.abort.signal.aborted) break
          await this.handleMessage(session, message)
        }
        if (messages.length === 0) await sleep(300, session.abort.signal)
      } catch (error) {
        if (session.abort.signal.aborted) break
        failures += 1
        session.error = errorText(error)
        this.lastError = session.error
        this.log('warn', 'WeChat Claw getupdates failed: ' + session.error)
        const delay = failures < 3 ? 2000 : 30000
        try {
          await sleep(delay, session.abort.signal)
        } catch {
          break
        }
      }
    }
    this.sessionClosed(session, session.error)
  }

  async handleMessage(session, message) {
    if (!message || typeof message !== 'object') return
    if (message.message_type === 2) return
    const from = typeof message.from_user_id === 'string' ? message.from_user_id : ''
    if (!from) return
    const id = messageIdOf(message)
    if (id) {
      if (this.seenMessages.has(id)) return
      this.seenMessages.add(id)
      if (this.seenMessages.size > SEEN_LIMIT) this.seenMessages.delete(this.seenMessages.values().next().value)
    }
    const contextToken = typeof message.context_token === 'string' ? message.context_token : ''
    if (contextToken) this.peer = { userId: from, contextToken }
    // A message from this channel is the user asking for it again, so resume
    // the mirror even when the previous pause was manual.
    this.setPaused(false, { by: PAUSE_BY_CHANNEL, reason: '微信 Claw 消息' })
    const text = textOf(message)
    if (!text) {
      await this.notify('目前只能接收文本消息。')
      return
    }
    try {
      const sessionId = await this.ensureRia()
      await this.ctx.sessionController.prompt({
        requestId: WECHAT_CLAW_REQUEST_PREFIX + randomUUID().replace(/-/g, '').slice(0, 24),
        sessionId,
        mode: 'queue',
        content: [{ type: 'text', text }],
      }, this.deliveryAbort.signal)
    } catch (error) {
      this.log('warn', 'could not deliver WeChat Claw message: ' + errorText(error))
      await this.notify('消息未能交给 Ria：' + userFacingError(error)).catch(() => {})
    }
  }

  async sendText(text) {
    const session = this.session
    if (!session) throw new Error('微信 Claw 未登录')
    const peer = this.peer
    if (!peer || !peer.userId || !peer.contextToken) return undefined
    const payload = {
      msg: {
        from_user_id: '',
        to_user_id: peer.userId,
        client_id: 'dsh-ria-' + randomUUID().replace(/-/g, '').slice(0, 24),
        message_type: 2,
        message_state: 2,
        item_list: [{ type: 1, text_item: { text } }],
        context_token: peer.contextToken,
      },
      base_info: baseInfo(),
    }
    const data = await requestJson(session.baseUrl + '/ilink/bot/sendmessage', {
      method: 'POST',
      headers: botHeaders(session.token),
      body: payload,
      signal: session.abort.signal,
      timeoutMs: 20000,
    })
    if (data && typeof data.ret === 'number' && data.ret !== 0) {
      throw new Error('sendmessage ret=' + data.ret)
    }
    return data
  }

  async notify(text) {
    if (!this.outbound) throw new Error('微信 Claw 未登录')
    return this.outbound.enqueue(text)
  }

  forwardAssistant(text) {
    if (!this.outbound) return
    if (this.paused) {
      this.log('info', 'WeChat Claw outbound paused; skipped assistant text')
      return
    }
    try {
      this.outbound.enqueue(text).catch(error => {
        this.log('warn', 'could not send assistant text to WeChat Claw: ' + errorText(error))
      })
    } catch (error) {
      this.log('warn', 'could not send assistant text to WeChat Claw: ' + errorText(error))
    }
  }

  sessionClosed(session, error) {
    if (this.session !== session) return
    const message = error ? userFacingError(error) : '连接已关闭'
    this.lastError = message
    this.session = undefined
    this.outbound = undefined
    this.login = { phase: 'idle', message: '微信 Claw 连接已断开：' + message }
    this.log('info', 'WeChat Claw session closed: ' + message)
  }

  stopSession() {
    const session = this.session
    if (!session) return
    session.stopping = true
    session.abort.abort()
    this.session = undefined
    this.outbound = undefined
  }

  async fetchQr(base, signal) {
    const start = await requestJson(base + '/ilink/bot/get_bot_qrcode?bot_type=' + BOT_TYPE, {
      headers: botHeaders(''),
      signal,
      timeoutMs: 20000,
    })
    const qrcode = String(start.qrcode || '')
    if (!qrcode) throw new Error('微信 Claw 没有返回二维码')
    const content = String(start.qrcode_img_content || qrcode)
    return { qrcode, qr: await qrDataUrl(content) }
  }

  async startLogin() {
    const phase = this.login && this.login.phase
    if (this.session || phase === 'connecting' || phase === 'starting') return this.statusView()
    this.loginNonce += 1
    const nonce = this.loginNonce
    if (this.loginAbort) this.loginAbort.abort()
    const abort = new AbortController()
    this.loginAbort = abort
    this.lastError = ''
    this.login = { phase: 'connecting', message: '正在获取二维码…' }
    const base = String(process.env.WX_CLAW_BASE || DEFAULT_BASE).replace(/\/$/, '')
    const deadline = Date.now() + LOGIN_TIMEOUT_MS
    try {
      const { qrcode, qr } = await this.fetchQr(base, abort.signal)
      if (nonce !== this.loginNonce) return this.statusView()
      if (abort.signal.aborted) return this.statusView()
      this.login = { phase: 'waiting', message: '使用微信扫描二维码，以完成连接。', qr }
      void this.waitForLogin({ nonce, abort, base, qrcode, deadline })
    } catch (error) {
      if (nonce !== this.loginNonce || abort.signal.aborted) return this.statusView()
      const message = userFacingError(error)
      this.lastError = message
      this.login = { phase: 'error', message: '无法连接微信 Claw：' + message }
      this.log('warn', 'WeChat Claw login failed: ' + message)
      if (this.loginNonce === nonce) this.loginAbort = undefined
    }
    return this.statusView()
  }

  async waitForLogin({ nonce, abort, base, qrcode: firstQr, deadline }) {
    let qrcode = firstQr
    try {
      for (let refresh = 0; refresh <= QR_REFRESH_LIMIT; refresh += 1) {
        let refreshed = false
        while (Date.now() < deadline) {
          if (abort.signal.aborted) return
          await sleep(qrPollMs(), abort.signal)
          const status = await requestJson(base + '/ilink/bot/get_qrcode_status?qrcode=' + encodeURIComponent(qrcode), {
            headers: { 'iLink-App-ClientVersion': '1' },
            signal: abort.signal,
            timeoutMs: 25000,
          })
          if (nonce !== this.loginNonce) return
          const state = String(status.status || '')
          if (state === 'scaned') {
            this.login = { phase: 'scanned', message: '已扫码，请在微信继续操作…', qr: this.login.qr }
            continue
          }
          if (state === 'expired') {
            this.login = { phase: 'waiting', message: '二维码已过期，正在刷新…', qr: this.login.qr }
            refreshed = true
            break
          }
          if (state === 'confirmed') {
            const creds = {
              version: 1,
              accountId: normalizeAccountId(status.ilink_bot_id),
              rawAccountId: String(status.ilink_bot_id || ''),
              token: String(status.bot_token || ''),
              baseUrl: String(status.baseurl || base).replace(/\/$/, ''),
              userId: String(status.ilink_user_id || ''),
              savedAt: new Date().toISOString(),
            }
            if (!creds.token) throw new Error('微信 Claw 没有返回登录凭证')
            writeAtomic(this.credsFile, JSON.stringify(creds, null, 2) + '\n')
            this.login = { phase: 'starting', message: '正在连接微信 Claw…' }
            await this.startSession(creds)
            return
          }
          // wait: keep polling
        }
        if (!refreshed || Date.now() >= deadline) break
        const next = await this.fetchQr(base, abort.signal)
        if (nonce !== this.loginNonce) return
        qrcode = next.qrcode
        this.login = { phase: 'waiting', message: '使用微信扫描二维码，以完成连接。', qr: next.qr }
      }
      throw new Error('二维码已失效，请重新获取')
    } catch (error) {
      if (nonce !== this.loginNonce || abort.signal.aborted) return
      const message = userFacingError(error)
      this.lastError = message
      this.login = { phase: 'error', message: '无法连接微信 Claw：' + message }
      this.log('warn', 'WeChat Claw login failed: ' + message)
    } finally {
      if (this.loginNonce === nonce) this.loginAbort = undefined
    }
  }

  async logout() {
    this.loginNonce += 1
    if (this.loginAbort) {
      this.loginAbort.abort()
      this.loginAbort = undefined
    }
    this.stopSession()
    removeFile(this.credsFile)
    removeFile(this.cursorFile)
    this.lastError = ''
    this.peer = undefined
    this.login = { phase: 'idle', message: '已退出登录' }
    return this.statusView()
  }

  async shutdown() {
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    this.loginNonce += 1
    if (this.loginAbort) {
      this.loginAbort.abort()
      this.loginAbort = undefined
    }
    this.deliveryAbort.abort()
    this.stopSession()
  }

  statusView() {
    const session = this.session
    return {
      ok: true,
      id: 'wechat-claw',
      loggedIn: Boolean(session),
      accountId: session ? session.accountId : '',
      nick: session ? session.accountId : '',
      user: session ? session.userId : '',
      since: session ? session.startedAt : '',
      error: this.lastError,
      paused: this.paused,
      pausedBy: this.pausedBy,
      pauseReason: this.pauseReason,
      pausedAt: this.pausedAt,
      resumedAt: this.resumedAt,
      resumedBy: this.resumedBy,
      login: { ...this.login },
    }
  }
}
