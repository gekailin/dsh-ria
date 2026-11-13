// QQ bot channel: Tencent QQ Open Platform.
//
// Pairing uses the same QR bind flow as the official openclaw-qqbot plugin:
// create a bind task, show the resulting q.qq.com URL as a QR, poll for the
// user's confirmation, then decrypt the returned app secret with the local
// bind key. The decrypted appId/appSecret are stored under
// DSH_HOME/state/ria/qq-bot/ and reused by the WebSocket gateway.

import { createDecipheriv, randomBytes, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { assistantText } from '../wechat/service.mjs'
import { Outbound } from '../wechat/outbound.mjs'
import { ensureDir, errorText, qrDataUrl, readJson, removeFile, requestJson, sleep, userFacingError, writeAtomic } from './common.mjs'
import { isQqRequestId, QQ_REQUEST_PREFIX } from './request-ids.mjs'

const DEFAULT_BIND_HOST = 'https://q.qq.com'
const BIND_PATH = '/qqbot/openclaw/connect.html'
const DEFAULT_BIND_POLL_MS = 2000
const BIND_TIMEOUT_MS = 300000
const BIND_REFRESH_LIMIT = 3

function bindHost() {
  return String(process.env.QQ_BIND_HOST || DEFAULT_BIND_HOST).replace(/\/$/, '')
}

function bindPollMs() {
  const value = Number(process.env.QQ_BIND_POLL_MS)
  return Number.isFinite(value) && value >= 50 ? value : DEFAULT_BIND_POLL_MS
}
const SEEN_LIMIT = 500
const USER_SOURCE_LIMIT = 500
const PAUSE_BY_MANUAL = 'manual'
const PAUSE_BY_CHANNEL = 'channel'

export const DEFAULT_QQ_BOT_TYPING_OPTIONS = Object.freeze({
  enabled: true,
  durationSec: 30,
  refreshMs: 30000,
  maxMs: 600000,
})

function typingDuration(value, fallback) {
  const number = Number(value)
  if (!Number.isFinite(number) || number <= 0) return fallback
  return Math.max(1, Math.min(60, Math.floor(number)))
}

function typingMs(value, fallback) {
  const number = Number(value)
  if (!Number.isFinite(number) || number <= 0) return fallback
  return Math.max(1000, Math.floor(number))
}

/** Normalize the channels.qq-bot.typing config block. */
export function normalizeQqBotTypingOptions(value) {
  const raw = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  const enabled = typeof raw.enabled === 'boolean' ? raw.enabled : DEFAULT_QQ_BOT_TYPING_OPTIONS.enabled
  const durationSec = typingDuration(raw.durationSec, DEFAULT_QQ_BOT_TYPING_OPTIONS.durationSec)
  // QQ shows the indicator for input_second; refreshing faster than that only
  // adds traffic, so the interval never undercuts the advertised window.
  const refreshMs = Math.max(typingMs(raw.refreshMs, DEFAULT_QQ_BOT_TYPING_OPTIONS.refreshMs), durationSec * 1000)
  let maxMs = typingMs(raw.maxMs, DEFAULT_QQ_BOT_TYPING_OPTIONS.maxMs)
  if (maxMs < refreshMs) maxMs = refreshMs
  return { enabled, durationSec, refreshMs, maxMs }
}

function bindHeaders() {
  return {
    'content-type': 'application/json',
    'user-agent': 'dsh-ria/0.1 (+qq-bot)',
  }
}

export function decryptBindSecret(encryptedSecret, bindKey) {
  const payload = Buffer.from(String(encryptedSecret || ''), 'base64')
  const key = Buffer.from(String(bindKey || ''), 'base64')
  if (payload.length <= 28) throw new Error('QQ 返回的加密凭据格式无效')
  if (key.length !== 32) throw new Error('QQ 绑定密钥格式无效')
  const iv = payload.subarray(0, 12)
  const tag = payload.subarray(payload.length - 16)
  const ciphertext = payload.subarray(12, payload.length - 16)
  const decipher = createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
}

function bindStatusOf(data) {
  const value = data && data.status
  if (typeof value === 'number') return value
  if (typeof value === 'string') {
    const upper = value.toUpperCase()
    if (upper === 'COMPLETED') return 2
    if (upper === 'PENDING') return 1
    if (upper === 'EXPIRED') return 3
    return 0
  }
  return 0
}

export class QqBotService {
  constructor({ ctx, stateDir, ensureRia, getRiaId, log, typingOptions }) {
    this.ctx = ctx
    this.ensureRia = ensureRia
    this.getRiaId = getRiaId
    this.log = typeof log === 'function' ? log : () => {}
    this.typingOptions = typeof typingOptions === 'function'
      ? () => normalizeQqBotTypingOptions(typingOptions())
      : () => normalizeQqBotTypingOptions()
    this.typingTargets = new Map()
    this.typingLocks = new Map()
    this.typingSeq = 0
    this.dir = join(stateDir, 'qq-bot')
    this.credsFile = join(this.dir, 'creds.json')
    this.stateFile = join(this.dir, 'state.json')
    this.login = { phase: 'idle', message: '未连接 QQ 机器人' }
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
      this.log('warn', 'could not read QQ bot state: ' + errorText(error))
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
    if (isQqRequestId(rpcId)) this.autoResume('QQ 消息')
    else this.autoPause('非 QQ 通道消息')
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
      this.log('warn', 'could not save QQ bot pause state: ' + errorText(error))
    }
    if (this.outbound) this.outbound.setPaused(next, { onDrop: job => this.log('info', 'dropped queued QQ message: ' + JSON.stringify(job)) })
    if (next) this.stopAllTyping()
    return this.statusView()
  }

  typingStateView() {
    const options = this.typingOptions()
    let active = 0
    for (const state of this.typingTargets.values()) {
      if (!state.cancelled) active += 1
    }
    return {
      enabled: options.enabled,
      durationSec: options.durationSec,
      refreshMs: options.refreshMs,
      maxMs: options.maxMs,
      active,
    }
  }

  // Serialize typing refreshes with outbound replies for one target. QQ has no
  // explicit cancel, so stopping means "clear the timer before the reply".
  withTypingLock(key, task) {
    const previous = this.typingLocks.get(key) || Promise.resolve()
    const result = previous.catch(() => {}).then(task)
    this.typingLocks.set(key, result)
    void result.finally(() => {
      if (this.typingLocks.get(key) === result) this.typingLocks.delete(key)
    }).catch(() => {})
    return result
  }

  typingKey(peer) {
    return peer.scope + ':' + peer.targetId
  }

  /** C2C only: QQ groups and guilds do not support input notifications. */
  beginTyping(peer) {
    if (!peer || peer.scope !== 'c2c' || !peer.targetId) return
    if (!this.typingOptions().enabled) return
    const key = this.typingKey(peer)
    const existing = this.typingTargets.get(key)
    if (existing && !existing.cancelled) return
    const state = {
      key,
      peer: { scope: 'c2c', targetId: peer.targetId, ...(peer.msgId ? { msgId: peer.msgId } : {}) },
      startedAt: Date.now(),
      cancelled: false,
      timer: undefined,
    }
    this.typingTargets.set(key, state)
    void this.startTyping(state)
  }

  async startTyping(state) {
    const session = this.session
    if (!session) {
      this.stopTypingLocked(state.key)
      return
    }
    try {
      await this.withTypingLock(state.key, async () => {
        if (state.cancelled) return
        await this.sendTypingIndicator(state.peer, this.typingOptions().durationSec)
        if (state.cancelled) return
        this.scheduleTypingRefresh(state)
      })
    } catch (error) {
      this.log('debug', 'QQ typing start failed: ' + errorText(error))
      this.stopTypingLocked(state.key)
    }
  }

  scheduleTypingRefresh(state) {
    if (state.cancelled || this.typingTargets.get(state.key) !== state) return
    const options = this.typingOptions()
    if (!options.enabled) {
      this.stopTypingLocked(state.key)
      return
    }
    const remaining = options.maxMs - (Date.now() - state.startedAt)
    if (remaining <= 0) {
      this.stopTypingLocked(state.key)
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
    if (state.cancelled || this.typingTargets.get(state.key) !== state) return
    if (!this.session) {
      this.stopTypingLocked(state.key)
      return
    }
    try {
      await this.withTypingLock(state.key, async () => {
        if (state.cancelled || this.typingTargets.get(state.key) !== state) return
        const options = this.typingOptions()
        if (!options.enabled || Date.now() - state.startedAt >= options.maxMs) {
          this.stopTypingLocked(state.key)
          return
        }
        try {
          await this.sendTypingIndicator(state.peer, options.durationSec)
          if (!state.cancelled) this.scheduleTypingRefresh(state)
        } catch (error) {
          this.log('debug', 'QQ typing refresh failed: ' + errorText(error))
          this.stopTypingLocked(state.key)
        }
      })
    } catch (error) {
      this.log('debug', 'QQ typing refresh failed: ' + errorText(error))
      this.stopTypingLocked(state.key)
    }
  }

  stopTypingLocked(key) {
    const state = this.typingTargets.get(key)
    if (!state) return
    state.cancelled = true
    if (state.timer) {
      clearTimeout(state.timer)
      state.timer = undefined
    }
    this.typingTargets.delete(key)
  }

  stopAllTyping() {
    for (const key of [...this.typingTargets.keys()]) this.stopTypingLocked(key)
  }

  /** POST /v2/users/{openid}/messages with the SDK's public API primitives. */
  async sendTypingIndicator(peer, durationSec) {
    const session = this.session
    if (!session) throw new Error('QQ 机器人未登录')
    const bot = session.bot
    if (!bot || !bot.apiClient || !bot.tokenManager || !bot.creds) {
      throw new Error('QQ SDK 无法发送输入状态')
    }
    const token = await bot.tokenManager.getAccessToken(bot.creds.appId, bot.creds.clientSecret)
    this.typingSeq = (this.typingSeq + 1) % 65536
    if (!this.typingSeq) this.typingSeq = 1
    const body = {
      msg_type: 6,
      input_notify: { input_type: 1, input_second: durationSec },
      msg_seq: this.typingSeq,
    }
    if (peer.msgId) body.msg_id = peer.msgId
    await bot.apiClient.request(token, 'POST', '/v2/users/' + peer.targetId + '/messages', body)
  }

  start(delayMs = 2000) {
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
      this.login = { phase: 'idle', message: '未连接 QQ 机器人' }
      return
    }
    try {
      await this.startSession(creds)
    } catch (error) {
      const message = userFacingError(error)
      this.lastError = message
      this.login = { phase: 'error', message: '上次的 QQ 机器人登录不可用：' + message }
      this.log('warn', 'could not restore QQ bot session: ' + message)
    }
  }

  readCreds() {
    try {
      const creds = readJson(this.credsFile)
      if (!creds || typeof creds.appId !== 'string' || typeof creds.appSecret !== 'string') return null
      if (!creds.appId || !creds.appSecret) return null
      return creds
    } catch (error) {
      this.log('warn', 'could not read QQ bot credentials: ' + errorText(error))
      return null
    }
  }

  async startFromCreds() {
    if (this.session) return this.statusView()
    const creds = this.readCreds()
    if (!creds) {
      this.login = { phase: 'idle', message: '未连接 QQ 机器人' }
      return this.statusView()
    }
    try {
      await this.startSession(creds)
    } catch (error) {
      this.login = { phase: 'error', message: 'QQ 机器人登录不可用：' + userFacingError(error) }
    }
    return this.statusView()
  }

  async startSession(creds) {
    this.stopSession()
    ensureDir(this.dir)
    this.login = { phase: 'starting', message: '正在连接 QQ 机器人…' }
    let SDK
    try {
      SDK = await import('@tencent-connect/qqbot-nodejs')
    } catch (error) {
      throw new Error('缺少 @tencent-connect/qqbot-nodejs：' + errorText(error))
    }
    const { QQBot, messageFilter, mentionGate, contentSanitizer } = SDK
    const log = this.log
    const logger = {
      info: (message, meta) => log('info', 'qq sdk: ' + message + (meta ? ' ' + JSON.stringify(meta) : '')),
      error: (message, meta) => log('error', 'qq sdk: ' + message + (meta ? ' ' + JSON.stringify(meta) : '')),
      warn: (message, meta) => log('warn', 'qq sdk: ' + message + (meta ? ' ' + JSON.stringify(meta) : '')),
      debug: () => {},
    }
    const bot = new QQBot({
      appId: creds.appId,
      appSecret: creds.appSecret,
      logger,
      userAgent: 'dsh-ria/0.1',
    })
    bot.use(messageFilter())
    bot.use(contentSanitizer({ stripBotMention: true }))
    bot.use(mentionGate({ requireMentionInGroup: true, alwaysAnswerC2C: true }))
    const session = {
      bot,
      appId: creds.appId,
      userOpenid: creds.userOpenid || '',
      startedAt: new Date().toISOString(),
      abort: new AbortController(),
      stopping: false,
      error: '',
      ready: false,
    }
    this.session = session
    this.lastError = ''
    this.outbound = new Outbound({
      send: text => this.sendText(text),
      log: this.log,
      prefix: '🌊 ',
    })
    if (this.paused) this.outbound.setPaused(true)

    bot.on('message', (middlewareCtx, message) => {
      void this.handleMessage(session, message).catch(error => {
        this.log('warn', 'QQ inbound failed: ' + errorText(error))
      })
    })
    bot.on('ready', () => {
      session.ready = true
      session.error = ''
      this.lastError = ''
      this.log('info', 'QQ gateway ready: ' + session.appId)
    })
    bot.on('resumed', () => {
      session.ready = true
      session.error = ''
      this.lastError = ''
      this.log('info', 'QQ gateway resumed')
    })
    bot.on('disconnected', event => {
      session.ready = false
      this.lastError = 'QQ 网关连接已断开'
      this.log('warn', 'QQ gateway disconnected: ' + JSON.stringify(event))
    })
    bot.on('error', error => {
      session.error = errorText(error)
      this.lastError = session.error
      this.log('warn', 'QQ gateway error: ' + session.error)
    })

    this.login = { phase: 'success', message: '已连接 QQ 机器人：' + session.appId }
    this.log('info', 'QQ bot connected as ' + session.appId)
    void bot.start(session.abort.signal).then(() => {
      this.sessionClosed(session, session.error ? new Error(session.error) : undefined)
    }).catch(error => {
      this.sessionClosed(session, error)
    })
    return this.statusView()
  }

  async handleMessage(session, message) {
    if (!message || typeof message !== 'object') return
    if (message.senderIsBot) return
    if (!message.replyTarget || !message.replyTarget.targetId) return
    const scope = message.replyTarget.scope
    if (scope !== 'c2c' && scope !== 'group') return
    const id = String(message.messageId || '')
    if (id) {
      if (this.seenMessages.has(id)) return
      this.seenMessages.add(id)
      if (this.seenMessages.size > SEEN_LIMIT) this.seenMessages.delete(this.seenMessages.values().next().value)
    }
    this.peer = { scope, targetId: message.replyTarget.targetId, ...(id ? { msgId: id } : {}) }
    // A message from this channel is the user asking for it again, so resume
    // the mirror even when the previous pause was manual.
    this.setPaused(false, { by: PAUSE_BY_CHANNEL, reason: 'QQ 消息' })
    const text = typeof message.content === 'string' ? message.content.trim() : ''
    if (!text) {
      await this.notify('目前只能接收文本消息。')
      return
    }
    try {
      const sessionId = await this.ensureRia()
      await this.ctx.sessionController.prompt({
        requestId: QQ_REQUEST_PREFIX + randomUUID().replace(/-/g, '').slice(0, 24),
        sessionId,
        mode: 'queue',
        content: [{ type: 'text', text }],
      }, this.deliveryAbort.signal)
      this.beginTyping(this.peer)
    } catch (error) {
      this.log('warn', 'could not deliver QQ message: ' + errorText(error))
      await this.notify('消息未能交给 Ria：' + userFacingError(error)).catch(() => {})
    }
  }

  async sendText(text) {
    const session = this.session
    if (!session) throw new Error('QQ 机器人未登录')
    const peer = this.peer
    if (!peer) throw new Error('QQ 机器人尚未收到可回复的消息')
    const key = this.typingKey(peer)
    return this.withTypingLock(key, async () => {
      const liveSession = this.session
      if (!liveSession) throw new Error('QQ 机器人未登录')
      // Stop the keepalive before the reply; QQ clears the indicator itself.
      this.stopTypingLocked(key)
      return liveSession.bot.sendText({ scope: peer.scope, targetId: peer.targetId }, text)
    })
  }

  async notify(text) {
    if (!this.outbound) throw new Error('QQ 机器人未登录')
    this.outbound.enqueue(text)
  }

  forwardAssistant(text) {
    if (!this.outbound) return
    if (this.paused) {
      this.log('info', 'QQ bot outbound paused; skipped assistant text')
      return
    }
    try {
      this.outbound.enqueue(text)
    } catch (error) {
      this.log('warn', 'could not send assistant text to QQ: ' + errorText(error))
    }
  }

  sessionClosed(session, error) {
    if (this.session !== session) return
    this.stopAllTyping()
    const message = error ? userFacingError(error) : '连接已关闭'
    this.lastError = message
    this.session = undefined
    this.outbound = undefined
    this.login = { phase: 'idle', message: 'QQ 机器人连接已断开：' + message }
    this.log('info', 'QQ bot session closed: ' + message)
  }

  stopSession() {
    const session = this.session
    if (!session) return
    this.stopAllTyping()
    session.stopping = true
    try { session.bot.stop() } catch { /* already stopped */ }
    session.abort.abort()
    this.session = undefined
    this.outbound = undefined
  }

  async createBindTask(signal) {
    const bindKey = randomBytes(32).toString('base64')
    const created = await requestJson(bindHost() + '/lite/create_bind_task', {
      method: 'POST',
      headers: bindHeaders(),
      body: { key: bindKey },
      signal,
      timeoutMs: 20000,
    })
    if (!created || created.retcode !== 0 || !created.data || !created.data.task_id) {
      throw new Error('创建绑定任务失败：' + JSON.stringify(created))
    }
    const taskId = String(created.data.task_id)
    const source = String(process.env.QQ_BIND_SOURCE || 'dsh-ria')
    const url = bindHost() + BIND_PATH + '?task_id=' + encodeURIComponent(taskId) + '&source=' + encodeURIComponent(source) + '&_wv=2'
    return { bindKey, taskId, qr: await qrDataUrl(url) }
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
    this.login = { phase: 'connecting', message: '正在创建 QQ 绑定任务…' }
    const deadline = Date.now() + BIND_TIMEOUT_MS
    try {
      const task = await this.createBindTask(abort.signal)
      if (nonce !== this.loginNonce) return this.statusView()
      if (abort.signal.aborted) return this.statusView()
      this.login = { phase: 'waiting', message: '请使用手机 QQ 扫描二维码完成绑定。', qr: task.qr }
      void this.waitForBind({ nonce, abort, bindKey: task.bindKey, taskId: task.taskId, deadline })
    } catch (error) {
      if (nonce !== this.loginNonce || abort.signal.aborted) return this.statusView()
      const message = userFacingError(error)
      this.lastError = message
      this.login = { phase: 'error', message: '无法连接 QQ 机器人：' + message }
      this.log('warn', 'QQ bot login failed: ' + message)
      if (this.loginNonce === nonce) this.loginAbort = undefined
    }
    return this.statusView()
  }

  async waitForBind({ nonce, abort, bindKey: firstKey, taskId: firstTask, deadline }) {
    let bindKey = firstKey
    let taskId = firstTask
    try {
      for (let refresh = 0; refresh <= BIND_REFRESH_LIMIT; refresh += 1) {
        let refreshed = false
        while (Date.now() < deadline) {
          if (abort.signal.aborted) return
          await sleep(bindPollMs(), abort.signal)
          const result = await requestJson(bindHost() + '/lite/poll_bind_result', {
            method: 'POST',
            headers: bindHeaders(),
            body: { task_id: taskId },
            signal: abort.signal,
            timeoutMs: 20000,
          })
          if (nonce !== this.loginNonce) return
          if (!result || result.retcode !== 0 || !result.data) {
            throw new Error('查询绑定结果失败：' + JSON.stringify(result))
          }
          const status = bindStatusOf(result.data)
          if (status === 1) {
            // PENDING covers both "not scanned yet" and "scanned but not
            // confirmed", so keep the QR visible without claiming a scan.
            this.login = { phase: 'waiting', message: '等待手机 QQ 完成绑定…', qr: this.login.qr }
            continue
          }
          if (status === 3) {
            this.login = { phase: 'waiting', message: '二维码已过期，正在刷新…', qr: this.login.qr }
            refreshed = true
            break
          }
          if (status === 2) {
            const data = result.data
            if (!data.bot_appid || !data.bot_encrypt_secret) {
              throw new Error('QQ 没有返回机器人凭据')
            }
            const appSecret = decryptBindSecret(data.bot_encrypt_secret, bindKey)
            const creds = {
              version: 1,
              appId: String(data.bot_appid),
              appSecret,
              userOpenid: String(data.user_openid || ''),
              savedAt: new Date().toISOString(),
            }
            writeAtomic(this.credsFile, JSON.stringify(creds, null, 2) + '\n')
            this.login = { phase: 'starting', message: '正在连接 QQ 机器人…' }
            await this.startSession(creds)
            return
          }
        }
        if (!refreshed || Date.now() >= deadline) break
        const next = await this.createBindTask(abort.signal)
        if (nonce !== this.loginNonce) return
        bindKey = next.bindKey
        taskId = next.taskId
        this.login = { phase: 'waiting', message: '请使用手机 QQ 扫描二维码完成绑定。', qr: next.qr }
      }
      throw new Error('二维码已失效，请重新获取')
    } catch (error) {
      if (nonce !== this.loginNonce || abort.signal.aborted) return
      const message = userFacingError(error)
      this.lastError = message
      this.login = { phase: 'error', message: '无法连接 QQ 机器人：' + message }
      this.log('warn', 'QQ bot login failed: ' + message)
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
      id: 'qq-bot',
      loggedIn: Boolean(session),
      accountId: session ? session.appId : '',
      nick: session ? 'QQ · ' + session.appId : '',
      user: session ? session.userOpenid : '',
      since: session ? session.startedAt : '',
      error: this.lastError,
      paused: Boolean(session) && this.paused,
      pausedBy: this.pausedBy,
      pauseReason: this.pauseReason,
      pausedAt: this.pausedAt,
      resumedAt: this.resumedAt,
      resumedBy: this.resumedBy,
      qqTyping: this.typingStateView(),
      login: { ...this.login },
    }
  }
}
