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
import { assistantText, extractAssistantImages } from '../wechat/service.mjs'
import { Outbound } from '../wechat/outbound.mjs'
import { DEFAULT_CLAW_CDN_BASE, DEFAULT_CLAW_IMAGE_MAX_BYTES, clawImageItems, clawInboundText, normalizeWechatClawImageOptions, pruneClawInboundImages, receiveInboundClawImage, uploadClawImage } from './wechat-claw-image.mjs'
import { ensureDir, errorText, qrDataUrl, readJson, removeFile, requestJson, sleep, userFacingError, writeAtomic } from './common.mjs'
import { isQqRequestId, isWechatClawRequestId, WECHAT_CLAW_REQUEST_PREFIX } from './request-ids.mjs'
import { isWechatRequestId } from '../wechat/request-ids.mjs'

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

export const DEFAULT_WECHAT_CLAW_TYPING_OPTIONS = Object.freeze({
  enabled: true,
  refreshMs: 5000,
  maxMs: 600000,
})

function typingMs(value, fallback) {
  const number = Number(value)
  if (!Number.isFinite(number) || number <= 0) return fallback
  return Math.max(10, Math.floor(number))
}

/** Normalize the channels.wechat-claw.typing config block. */
export function normalizeWechatClawTypingOptions(value) {
  const raw = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  const enabled = typeof raw.enabled === 'boolean' ? raw.enabled : DEFAULT_WECHAT_CLAW_TYPING_OPTIONS.enabled
  const refreshMs = typingMs(raw.refreshMs, DEFAULT_WECHAT_CLAW_TYPING_OPTIONS.refreshMs)
  let maxMs = typingMs(raw.maxMs, DEFAULT_WECHAT_CLAW_TYPING_OPTIONS.maxMs)
  if (maxMs < refreshMs) maxMs = refreshMs
  return { enabled, refreshMs, maxMs }
}

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
  constructor({ ctx, stateDir, ensureRia, getRiaId, log, imageOptions, typingOptions, onResume, getOutboxStats }) {
    this.ctx = ctx
    this.stateDir = stateDir
    this.ensureRia = ensureRia
    this.getRiaId = getRiaId
    this.log = typeof log === 'function' ? log : () => {}
    this.onResume = typeof onResume === 'function' ? onResume : undefined
    this.getOutboxStats = typeof getOutboxStats === 'function' ? getOutboxStats : undefined
    this.imageOptions = typeof imageOptions === 'function'
      ? () => normalizeWechatClawImageOptions(imageOptions())
      : () => normalizeWechatClawImageOptions()
    this.typingOptions = typeof typingOptions === 'function'
      ? () => normalizeWechatClawTypingOptions(typingOptions())
      : () => normalizeWechatClawTypingOptions()
    this.typingTickets = new Map()
    this.typingUsers = new Map()
    this.typingLocks = new Map()
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
    // Last inbound user message from this channel. Ria uses it to pick the
    // channel that should receive dispatch/approval notes.
    this.lastInboundAt = 0
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
    const rpcId = typeof message.rpcId === 'string'
      ? message.rpcId
      : (message.source && typeof message.source.rpcId === 'string' ? message.source.rpcId : '')
    if (!rpcId || rpcId.startsWith('host_')) return
    if (this.seenUserSources.has(rpcId)) return
    this.seenUserSources.add(rpcId)
    if (this.seenUserSources.size > USER_SOURCE_LIMIT) {
      this.seenUserSources.delete(this.seenUserSources.values().next().value)
    }
    if (isWechatClawRequestId(rpcId)) {
      this.lastInboundAt = Date.now()
      this.autoResume('微信 Claw 消息')
    } else if (isWechatRequestId(rpcId)) {
      this.autoPause('微信「文件传输助手」通道消息')
    } else if (isQqRequestId(rpcId)) {
      this.autoPause('QQ 通道消息')
    } else {
      this.autoPause('非微信 Claw 通道消息')
    }
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
    const wasPaused = this.paused
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
    if (next) this.cancelAllTyping('paused', { signal: null })
    if (wasPaused && !next) {
      try {
        this.onResume?.(this.statusView(), { at: Date.now(), lastInboundAt: this.lastInboundAt, reason: String(reason || '') })
      } catch (error) {
        this.log('warn', 'resume callback failed: ' + errorText(error))
      }
    }
    return this.statusView()
  }

  typingStateView() {
    const options = this.typingOptions()
    let active = 0
    for (const state of this.typingUsers.values()) {
      if (!state.cancelled) active += 1
    }
    return {
      enabled: options.enabled,
      refreshMs: options.refreshMs,
      maxMs: options.maxMs,
      ticketCache: this.typingTickets.size,
      active,
    }
  }

  typingRequestSignal(session, signal) {
    if (signal === null) return undefined
    if (signal) return signal
    return session && session.abort ? session.abort.signal : undefined
  }

  // Every typing request for one user runs in order. This keeps a cancel
  // (status=2) from overtaking the outbound message it was meant to precede.
  withTypingLock(userId, task) {
    const previous = this.typingLocks.get(userId) || Promise.resolve()
    const result = previous.catch(() => {}).then(task)
    this.typingLocks.set(userId, result)
    void result.finally(() => {
      if (this.typingLocks.get(userId) === result) this.typingLocks.delete(userId)
    }).catch(() => {})
    return result
  }

  /** Fire-and-forget start after a user message was delivered to Ria. */
  beginTyping(userId, contextToken = '') {
    if (!this.typingOptions().enabled) return
    void this.startTyping(userId, { contextToken })
  }

  async startTyping(userId, { contextToken = '' } = {}) {
    const options = this.typingOptions()
    if (!options.enabled) return false
    const session = this.session
    if (!session || !userId) return false
    const existing = this.typingUsers.get(userId)
    if (existing && !existing.cancelled) return true
    const state = {
      userId,
      contextToken: contextToken || (this.peer && this.peer.userId === userId ? this.peer.contextToken : ''),
      startedAt: Date.now(),
      started: false,
      cancelled: false,
      cancelSent: false,
      timer: undefined,
    }
    this.typingUsers.set(userId, state)
    try {
      await this.withTypingLock(userId, async () => {
        if (state.cancelled) return
        await this.sendTypingStatus(state, 1, session)
        state.started = true
        if (state.cancelled) {
          await this.flushTypingStop(state, 'cancelled', session)
          return
        }
        this.scheduleTypingRefresh(state)
      })
      return true
    } catch (error) {
      this.beginTypingStop(state)
      this.finishTypingStop(state)
      this.log('debug', 'WeChat Claw typing start failed: ' + errorText(error))
      return false
    }
  }

  scheduleTypingRefresh(state) {
    if (state.cancelled || this.typingUsers.get(state.userId) !== state) return
    const options = this.typingOptions()
    if (!options.enabled) {
      void this.cancelTyping(state.userId, 'typing disabled')
      return
    }
    const remaining = options.maxMs - (Date.now() - state.startedAt)
    if (remaining <= 0) {
      void this.cancelTyping(state.userId, 'max duration')
      return
    }
    if (state.timer) clearTimeout(state.timer)
    state.timer = setTimeout(() => {
      state.timer = undefined
      void this.refreshTyping(state)
    }, Math.min(options.refreshMs, remaining))
    if (state.timer.unref) state.timer.unref()
  }

  async refreshTyping(state) {
    if (state.cancelled || this.typingUsers.get(state.userId) !== state) return
    const session = this.session
    if (!session) {
      await this.cancelTyping(state.userId, 'connection closed')
      return
    }
    try {
      await this.withTypingLock(state.userId, async () => {
        if (state.cancelled || this.typingUsers.get(state.userId) !== state) return
        const options = this.typingOptions()
        const elapsed = Date.now() - state.startedAt
        if (!options.enabled || elapsed >= options.maxMs) {
          await this.stopTypingLocked(state.userId, 'refresh limit', session)
          return
        }
        try {
          await this.sendTypingStatus(state, 1, session)
          this.scheduleTypingRefresh(state)
        } catch (error) {
          this.log('debug', 'WeChat Claw typing refresh failed: ' + errorText(error))
          await this.stopTypingLocked(state.userId, 'refresh failed', session)
        }
      })
    } catch (error) {
      this.log('debug', 'WeChat Claw typing refresh failed: ' + errorText(error))
    }
  }

  beginTypingStop(state) {
    if (!state || state.cancelled) return false
    state.cancelled = true
    if (state.timer) {
      clearTimeout(state.timer)
      state.timer = undefined
    }
    return true
  }

  finishTypingStop(state) {
    if (this.typingUsers.get(state.userId) === state) this.typingUsers.delete(state.userId)
  }

  async flushTypingStop(state, reason, session, { signal } = {}) {
    if (!state.started || state.cancelSent) return
    state.cancelSent = true
    if (!session) return
    try {
      await this.sendTypingStatus(state, 2, session, { signal })
    } catch (error) {
      this.log('debug', 'WeChat Claw typing cancel failed (' + reason + '): ' + errorText(error))
    }
  }

  async stopTypingLocked(userId, reason, session = this.session, { signal } = {}) {
    const state = this.typingUsers.get(userId)
    if (!state) return
    this.beginTypingStop(state)
    await this.flushTypingStop(state, reason, session, { signal })
    this.finishTypingStop(state)
  }

  async cancelTyping(userId, reason = 'cancelled', { session = this.session, signal } = {}) {
    const state = this.typingUsers.get(userId)
    if (!state) return false
    this.beginTypingStop(state)
    try {
      await this.withTypingLock(userId, () => this.stopTypingLocked(userId, reason, session, { signal }))
    } catch (error) {
      this.log('debug', 'WeChat Claw typing cancel failed: ' + errorText(error))
    }
    return true
  }

  cancelAllTyping(reason, { session = this.session, signal } = {}) {
    for (const userId of [...this.typingUsers.keys()]) {
      void this.cancelTyping(userId, reason, { session, signal })
    }
  }

  async typingTicket(state, session, signal) {
    const cached = this.typingTickets.get(state.userId)
    if (cached) return cached
    const body = { ilink_user_id: state.userId, base_info: baseInfo() }
    if (state.contextToken) body.context_token = state.contextToken
    const data = await requestJson(session.baseUrl + '/ilink/bot/getconfig', {
      method: 'POST',
      headers: botHeaders(session.token),
      body,
      signal: this.typingRequestSignal(session, signal),
      timeoutMs: 15000,
    })
    if (data && typeof data.ret === 'number' && data.ret !== 0) {
      throw new Error('getconfig ret=' + data.ret)
    }
    const ticket = data && typeof data.typing_ticket === 'string' ? data.typing_ticket : ''
    if (!ticket) throw new Error('getconfig returned no typing_ticket')
    this.typingTickets.set(state.userId, ticket)
    return ticket
  }

  async sendTyping(state, status, ticket, session, signal) {
    const data = await requestJson(session.baseUrl + '/ilink/bot/sendtyping', {
      method: 'POST',
      headers: botHeaders(session.token),
      body: {
        ilink_user_id: state.userId,
        typing_ticket: ticket,
        status,
        base_info: baseInfo(),
      },
      signal: this.typingRequestSignal(session, signal),
      timeoutMs: 15000,
    })
    if (data && typeof data.ret === 'number' && data.ret !== 0) {
      throw new Error('sendtyping ret=' + data.ret)
    }
    return data
  }

  async sendTypingStatus(state, status, session, { signal } = {}) {
    let lastError
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const ticket = await this.typingTicket(state, session, signal)
        await this.sendTyping(state, status, ticket, session, signal)
        return
      } catch (error) {
        lastError = error
        this.typingTickets.delete(state.userId)
        if (error && (error.name === 'AbortError' || error.code === 'ABORT_ERR')) break
      }
    }
    throw lastError
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
      sendImage: (name, buffer) => this.sendImage(name, buffer),
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
    this.lastInboundAt = Date.now()
    // A message from this channel is the user asking for it again, so resume
    // the mirror even when the previous pause was manual.
    this.setPaused(false, { by: PAUSE_BY_CHANNEL, reason: '微信 Claw 消息' })
    const text = textOf(message)
    const images = clawImageItems(message)
    const options = this.imageOptions()
    if (!images.length || !options.inbound) {
      if (!text) {
        await this.notify('目前只能接收文本消息。')
        return
      }
      try {
        await this.deliverText(text)
        this.beginTyping(from, contextToken)
      } catch (error) {
        void this.cancelTyping(from, 'delivery failed', { signal: null })
        this.log('warn', 'could not deliver WeChat Claw message: ' + errorText(error))
        await this.notify('消息未能交给 Ria：' + userFacingError(error)).catch(() => {})
      }
      return
    }
    try {
      await this.deliverInbound(message, text, id)
      this.beginTyping(from, contextToken)
    } catch (error) {
      void this.cancelTyping(from, 'delivery failed', { signal: null })
      this.log('warn', 'could not deliver WeChat Claw message: ' + errorText(error))
      await this.notify('消息未能交给 Ria：' + userFacingError(error)).catch(() => {})
    }
  }

  requestId() {
    return WECHAT_CLAW_REQUEST_PREFIX + randomUUID().replace(/-/g, '').slice(0, 24)
  }

  async promptContent(sessionId, content) {
    await this.ctx.sessionController.prompt({
      requestId: this.requestId(),
      sessionId,
      mode: 'queue',
      content,
    }, this.deliveryAbort.signal)
  }

  async deliverText(text) {
    const sessionId = await this.ensureRia()
    await this.promptContent(sessionId, [{ type: 'text', text }])
  }

  inboundImageMaxBytes() {
    let limit = DEFAULT_CLAW_IMAGE_MAX_BYTES
    try {
      const store = typeof this.ctx.get === 'function' ? this.ctx.get('attachments') : undefined
      const hostLimit = store && store.imageLimits && store.imageLimits.maxImageBytes
      if (Number.isFinite(hostLimit) && hostLimit > 0) limit = Math.min(limit, hostLimit)
    } catch {
      /* keep the channel default when the host store is unavailable */
    }
    return limit
  }

  /** Mirror the host's own attachment checks before a prompt carries an image. */
  async validateInboundImage(part) {
    const store = typeof this.ctx.get === 'function' ? this.ctx.get('attachments') : undefined
    if (!store) return
    const input = {
      data: Buffer.from(part.data, 'base64'),
      mediaType: part.mediaType,
      name: part.name,
    }
    if (typeof store.validateImageBatch === 'function') store.validateImageBatch([input])
    if (typeof store.validateImage === 'function') await store.validateImage(input)
  }

  imageFailureReason(error) {
    if (error && typeof error.reason === 'string' && error.reason) return error.reason
    if (error && typeof error.message === 'string' && error.message) return error.message
    return '未知错误'
  }

  async deliverInbound(message, text, messageId) {
    const sessionId = await this.ensureRia()
    const signal = this.deliveryAbort.signal
    const saved = []
    const failures = []
    const parts = []
    const maxBytes = this.inboundImageMaxBytes()
    for (const { item, index } of clawImageItems(message)) {
      const label = (messageId || 'unknown') + (index ? '#' + index : '')
      try {
        const received = await receiveInboundClawImage({
          item,
          messageId: label,
          stateDir: this.stateDir,
          maxBytes,
          signal,
        })
        await this.validateInboundImage(received.part)
        saved.push(received.path)
        parts.push(received.part)
      } catch (error) {
        if (error && (error.name === 'AbortError' || error.code === 'ABORT_ERR')) throw error
        const reason = this.imageFailureReason(error)
        const code = (error && error.code) || 'image_error'
        this.log('warn', '[claw inbound] image ' + label + ' rejected (' + code + '): ' + reason)
        failures.push(reason)
      }
    }
    if (saved.length) {
      try {
        pruneClawInboundImages(this.stateDir)
      } catch (error) {
        this.log('warn', '[claw inbound] could not prune saved images: ' + errorText(error))
      }
    }
    const body = clawInboundText(text, saved, failures)
    if (!parts.length) {
      await this.promptContent(sessionId, [{ type: 'text', text: body }])
      return
    }
    try {
      await this.promptContent(sessionId, [{ type: 'text', text: body }, ...parts])
    } catch (error) {
      const reason = '投递失败：' + this.imageFailureReason(error)
      this.log('warn', '[claw inbound] image message could not be delivered as an image; retrying text only: ' + reason)
      await this.promptContent(sessionId, [{ type: 'text', text: clawInboundText(text, saved, [...failures, reason]) }])
    }
  }

  async sendItems(itemList) {
    const session = this.session
    if (!session) throw new Error('微信 Claw 未登录')
    const peer = this.peer
    if (!peer || !peer.userId || !peer.contextToken) return undefined
    const userId = peer.userId
    return this.withTypingLock(userId, async () => {
      const liveSession = this.session
      const livePeer = this.peer
      if (!liveSession) throw new Error('微信 Claw 未登录')
      if (!livePeer || livePeer.userId !== userId || !livePeer.contextToken) {
        throw new Error('微信 Claw 尚未收到可回复的消息')
      }
      // The typing indicator must stop before the reply lands. Waiting on the
      // per-user lock also keeps a concurrent cancel from arriving afterwards.
      await this.stopTypingLocked(userId, 'outbound', liveSession)
      const payload = {
        msg: {
          from_user_id: '',
          to_user_id: userId,
          client_id: 'dsh-ria-' + randomUUID().replace(/-/g, '').slice(0, 24),
          message_type: 2,
          message_state: 2,
          item_list: itemList,
          context_token: livePeer.contextToken,
        },
        base_info: baseInfo(),
      }
      const data = await requestJson(liveSession.baseUrl + '/ilink/bot/sendmessage', {
        method: 'POST',
        headers: botHeaders(liveSession.token),
        body: payload,
        signal: liveSession.abort.signal,
        timeoutMs: 20000,
      })
      if (data && typeof data.ret === 'number' && data.ret !== 0) {
        throw new Error('sendmessage ret=' + data.ret)
      }
      return data
    })
  }

  async sendText(text) {
    return this.sendItems([{ type: 1, text_item: { text } }])
  }

  /** Upload one image to the iLink CDN, then send an image_item that references it. */
  async sendImage(name, buffer) {
    const session = this.session
    if (!session) throw new Error('微信 Claw 未登录')
    const peer = this.peer
    if (!peer || !peer.userId || !peer.contextToken) throw new Error('微信 Claw 尚未收到可回复的消息')
    const uploaded = await uploadClawImage({
      baseUrl: session.baseUrl,
      cdnBaseUrl: process.env.WX_CLAW_CDN_BASE || DEFAULT_CLAW_CDN_BASE,
      headers: botHeaders(session.token),
      baseInfo: baseInfo(),
      toUserId: peer.userId,
      buffer,
      signal: session.abort.signal,
      log: this.log,
    })
    void name
    return this.sendItems([{
      type: 2,
      image_item: {
        media: {
          encrypt_query_param: uploaded.downloadEncryptedQueryParam,
          aes_key: Buffer.from(uploaded.aeskey, 'hex').toString('base64'),
          encrypt_type: 1,
        },
        mid_size: uploaded.ciphertextSize,
      },
    }])
  }

  async notify(text) {
    if (!this.outbound) throw new Error('微信 Claw 未登录')
    return this.outbound.enqueue(text)
  }

  noteTarget() {
    return Boolean(this.outbound && this.peer && this.peer.userId && this.peer.contextToken)
  }

  async sendNote(message, { durable = false, allowPaused = false } = {}) {
    const value = String(message == null ? '' : message).trim()
    if (!value) return false
    if (!this.noteTarget()) {
      this.log('info', 'WeChat Claw cannot send a note yet (no reply target)')
      return durable ? { deferred: true } : false
    }
    if (this.paused && !allowPaused) {
      this.log('info', 'WeChat Claw outbound paused; deferred note')
      return durable ? { deferred: true } : false
    }
    try {
      if (allowPaused && typeof this.outbound.enqueueSystem === 'function') {
        await this.outbound.enqueueSystem(value, { prefix: false })
      } else {
        await this.outbound.enqueue(value)
      }
      return true
    } catch (error) {
      this.log('warn', 'could not send WeChat Claw note: ' + errorText(error))
      if (durable) throw error
      return false
    }
  }

  async sendDispatchNote(note, { isTask = true, durable = false } = {}) {
    const value = String(note == null ? '' : note).trim()
    if (!value) return false
    return this.sendNote((isTask ? '📌 任务已派发：' : '📌 消息已转交：') + value, { durable })
  }

  async sendApprovalNote(note, { durable = false } = {}) {
    const value = String(note == null ? '' : note).trim()
    if (!value) return false
    return this.sendNote('🔐 等待权限审批：' + value, { durable })
  }

  async sendPauseNotice(text, { durable = false } = {}) {
    const value = String(text == null ? '' : text).trim()
    if (!value) return false
    return this.sendNote(value, { durable, allowPaused: true })
  }

  async sendRecoveryNotice(text, { durable = false } = {}) {
    const value = String(text == null ? '' : text).trim()
    if (!value) return false
    return this.sendNote(value, { durable })
  }

  forwardAssistant(text) {
    if (!this.outbound) return
    if (this.paused) {
      this.log('info', 'WeChat Claw outbound paused; skipped assistant text')
      return
    }
    void this.deliverAssistant(text).catch(error => {
      if (error && error.code === 'WECHAT_PAUSED') {
        this.log('info', 'WeChat Claw outbound paused; skipped assistant text')
        return
      }
      this.log('warn', 'could not send assistant text to WeChat Claw: ' + errorText(error))
    })
  }

  async deliverAssistant(text) {
    const outbound = this.outbound
    if (!outbound) return
    const value = String(text == null ? '' : text)
    if (!value.trim()) return
    const extracted = this.imageOptions().outbound
      ? extractAssistantImages(value, [this.stateDir, process.cwd()])
      : { text: value, images: [] }
    if (extracted.text.trim()) await outbound.enqueue(extracted.text)
    for (const image of extracted.images) {
      try {
        await outbound.enqueueImage({ name: image.name, buffer: image.buffer, mime: image.mime, ref: image.path })
      } catch (error) {
        if (error && error.code === 'WECHAT_PAUSED') throw error
        this.log('warn', '[claw outbound] image ' + image.name + ' failed: ' + errorText(error))
        await outbound.enqueue('（图片 ' + image.name + ' 发送失败，请在 Ria 会话中查看原图）')
      }
    }
  }

  sessionClosed(session, error) {
    if (this.session !== session) return
    this.cancelAllTyping('connection closed', { session, signal: null })
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
    this.cancelAllTyping('session stopped', { session, signal: null })
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

  foldedStatus() {
    if (!this.getOutboxStats) return { folded: 0, lastFoldedAt: null }
    try {
      const stats = this.getOutboxStats() || {}
      return {
        folded: Number.isSafeInteger(stats.folded) && stats.folded >= 0 ? stats.folded : 0,
        lastFoldedAt: Number.isFinite(stats.lastFoldedAt) ? stats.lastFoldedAt : null,
      }
    } catch {
      return { folded: 0, lastFoldedAt: null }
    }
  }

  statusView() {
    const session = this.session
    const folded = this.foldedStatus()
    return {
      ok: true,
      id: 'wechat-claw',
      loggedIn: Boolean(session),
      accountId: session ? session.accountId : '',
      nick: session ? session.accountId : '',
      user: session ? session.userId : '',
      since: session ? session.startedAt : '',
      error: this.lastError,
      paused: Boolean(session) && this.paused,
      pausedBy: this.pausedBy,
      pauseReason: this.pauseReason,
      pausedAt: this.pausedAt,
      resumedAt: this.resumedAt,
      resumedBy: this.resumedBy,
      folded: folded.folded,
      lastFoldedAt: folded.lastFoldedAt,
      wechatClawImage: this.imageOptions(),
      wechatClawTyping: this.typingStateView(),
      login: { ...this.login },
    }
  }
}
