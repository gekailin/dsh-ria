// WeChat "Claw" channel: the iLink bot protocol used by Tencent's
// openclaw-weixin plugin.
//
// Pairing is a QR login. The QR payload is a URL returned by
// /ilink/bot/get_bot_qrcode. After the user confirms on the phone the server
// returns a bot token and account id; those credentials are stored locally
// and reused on the next DSH start. Inbound messages are long-polled with
// getupdates and replies are sent with sendmessage.

import { randomBytes, randomUUID } from 'node:crypto'
import { appendFileSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { assistantText, extractAssistantImages } from '../wechat/service.mjs'
import { Outbound } from '../wechat/outbound.mjs'
import { DEFAULT_CLAW_CDN_BASE, DEFAULT_CLAW_IMAGE_MAX_BYTES, clawImageItems, normalizeWechatClawImageOptions, pruneClawInboundImages, receiveInboundClawImage, uploadClawImage } from './wechat-claw-image.mjs'
import { FILE_PLACEHOLDER, clawFileItem, clawFileItems, formatFileSize, normalizeWechatClawFileOptions, pruneClawInboundFiles, receiveInboundClawFile, uploadClawFile } from './wechat-claw-file.mjs'
import { ensureDir, errorText, qrDataUrl, readJson, removeFile, requestJson, sleep, userFacingError, writeAtomic } from './common.mjs'
import { isQqRequestId, isWechatClawRequestId, WECHAT_CLAW_REQUEST_PREFIX } from './request-ids.mjs'
import { deliverInboundPrompt } from './inbound-delivery.mjs'
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
const ASSISTANT_LOG = 'assistant.log.jsonl'
const ASSISTANT_LOG_LIMIT = 2 * 1024 * 1024

// A reply target loaded from disk is only trusted for a week. After that the
// token is likely stale; the next inbound message refreshes it.
export const WECHAT_CLAW_PEER_TTL_MS = 7 * 24 * 60 * 60 * 1000

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

function asEpoch(value) {
  if (Number.isFinite(value) && value > 0) return value
  if (typeof value === 'string' && value) {
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

function eventTimestamp(event) {
  if (!event || typeof event !== 'object') return undefined
  return asEpoch(event.time) ?? asEpoch(event.at) ?? (event.data ? asEpoch(event.data.time) : undefined)
}

function messageIdOf(message) {
  return String(
    (message && (message.message_id || message.msg_id || message.client_id)) || '',
  )
}

function redactPeerSecret(value, secret) {
  const text = typeof value === 'string' ? value : ''
  if (!text || !secret) return text
  return text.split(secret).join('[redacted]')
}

function redactPeerError(error, secret) {
  if (!error || !secret) return error
  if (typeof error.message === 'string') error.message = redactPeerSecret(error.message, secret)
  if (typeof error.errmsg === 'string') error.errmsg = redactPeerSecret(error.errmsg, secret)
  if (typeof error.stack === 'string') error.stack = redactPeerSecret(error.stack, secret)
  if (error.cause && typeof error.cause.message === 'string') {
    error.cause.message = redactPeerSecret(error.cause.message, secret)
  }
  return error
}

export class WechatClawService {
  constructor({ ctx, stateDir, ensureRia, getRiaId, log, isRiaBusy, imageOptions, fileOptions, typingOptions, onAutoPause, onResume, onHumanMessage, getOutboxStats, onAssistantUndelivered, onInbound, directRelay }) {
    this.ctx = ctx
    this.stateDir = stateDir
    this.ensureRia = ensureRia
    this.getRiaId = getRiaId
    this.log = typeof log === 'function' ? log : () => {}
    this.isRiaBusy = typeof isRiaBusy === 'function' ? isRiaBusy : () => false
    this.onAutoPause = typeof onAutoPause === 'function' ? onAutoPause : undefined
    this.onResume = typeof onResume === 'function' ? onResume : undefined
    this.onHumanMessage = typeof onHumanMessage === 'function' ? onHumanMessage : undefined
    this.getOutboxStats = typeof getOutboxStats === 'function' ? getOutboxStats : undefined
    this.onAssistantUndelivered = typeof onAssistantUndelivered === 'function' ? onAssistantUndelivered : undefined
    this.onInbound = typeof onInbound === 'function' ? onInbound : undefined
    // v2 direct mode: when it consumes an inbound message, Chatbot must not
    // receive it at all. The callback returns true only for messages it handled.
    this.directRelay = typeof directRelay === 'function' ? directRelay : undefined
    this.imageOptions = typeof imageOptions === 'function'
      ? () => normalizeWechatClawImageOptions(imageOptions())
      : () => normalizeWechatClawImageOptions()
    this.fileOptions = typeof fileOptions === 'function'
      ? () => normalizeWechatClawFileOptions(fileOptions())
      : () => normalizeWechatClawFileOptions()
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
    // When the peer was restored from state.json, peerAt records how old it is.
    // peerRestored stays true until a fresh inbound context_token replaces it,
    // so a rejection of a disk-restored token can be treated as stale.
    this.peerAt = 0
    this.peerRestored = false
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
    // Last assistant turn and what happened to its text. Kept in memory so the
    // status API can answer "why didn't my reply arrive?" without reading logs.
    this.lastAssistantForward = undefined
    this.lastFileSend = undefined
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
      this.lastInboundAt = typeof state.lastInboundAt === 'number' && Number.isFinite(state.lastInboundAt) && state.lastInboundAt > 0
        ? state.lastInboundAt
        : 0
      const peer = state.peer
      if (peer && typeof peer === 'object') {
        const userId = typeof peer.userId === 'string' ? peer.userId : ''
        const contextToken = typeof peer.contextToken === 'string' ? peer.contextToken : ''
        const at = Number.isFinite(peer.at) && peer.at > 0 ? peer.at : 0
        const age = at > 0 ? Date.now() - at : Infinity
        if (userId && contextToken && age >= 0 && age <= WECHAT_CLAW_PEER_TTL_MS) {
          this.peer = { userId, contextToken }
          this.peerAt = at
          this.peerRestored = true
          if (this.lastInboundAt < at) this.lastInboundAt = at
        } else {
          // A malformed or expired target must not keep sending into the void.
          // Drop it from disk as well, so the next restart starts clean.
          this.peer = undefined
          this.peerAt = 0
          this.peerRestored = false
          try {
            this.saveState()
          } catch (error) {
            this.log('warn', 'could not clear stale WeChat Claw reply target: ' + errorText(error))
          }
        }
      }
    } catch (error) {
      this.log('warn', 'could not read WeChat Claw state: ' + errorText(error))
    }
  }

  clearPeer() {
    this.peer = undefined
    this.peerAt = 0
    this.peerRestored = false
    try {
      this.saveState()
    } catch (error) {
      this.log('warn', 'could not clear WeChat Claw reply target: ' + errorText(error))
    }
  }

  saveState() {
    const peer = this.peer && typeof this.peer.userId === 'string' && this.peer.userId && typeof this.peer.contextToken === 'string' && this.peer.contextToken
      ? {
          userId: this.peer.userId,
          contextToken: this.peer.contextToken,
          at: this.peerAt || this.lastInboundAt || Date.now(),
        }
      : undefined
    const state = {
      version: 1,
      lastInboundAt: this.lastInboundAt,
      paused: this.paused,
      pausedBy: this.pausedBy,
      pauseReason: this.pauseReason,
      pausedAt: this.pausedAt,
      resumedAt: this.resumedAt,
      resumedBy: this.resumedBy,
    }
    if (peer) state.peer = peer
    writeAtomic(this.stateFile, JSON.stringify(state, null, 2) + '\n')
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
      if (text) this.forwardAssistant(text, event)
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
    // Move the cross-channel resume anchor before autoResume reads it.
    this.onHumanMessage?.(asEpoch(message.time) ?? Date.now())
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
    if (this.paused) {
      if (this.pausedBy === PAUSE_BY_MANUAL) this.log('info', 'auto pause ignored: manual pause is active')
      return false
    }
    this.setPaused(true, { by: PAUSE_BY_CHANNEL, reason })
    // statusView() reports paused=false without a live session; this transition
    // is real regardless, and the notice has its own reply-target preflight.
    const status = { ...this.statusView(), paused: true }
    try {
      this.onAutoPause?.(status)
    } catch (error) {
      this.log('warn', 'auto-pause callback failed: ' + errorText(error))
    }
    return true
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
      sendFile: (name, buffer) => this.sendFile(name, buffer),
      log: this.log,
      prefix: '🌊 ',
      // The iLink server rejects a single sendmessage once it gets long
      // (community reports put the limit near 5000 characters). Long reports
      // must be split before they reach the endpoint.
      maxChunk: 4000,
      maxChunks: 8,
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
    const now = Date.now()
    if (contextToken) {
      this.peer = { userId: from, contextToken }
      this.peerAt = now
      // This token came from a real message, not from disk. It is fresh until
      // the next restart restores it.
      this.peerRestored = false
    }
    this.lastInboundAt = now
    try {
      this.saveState()
    } catch (error) {
      this.log('warn', 'could not save WeChat Claw inbound time: ' + errorText(error))
    }
    // A message from this channel is the user asking for it again, so resume
    // the mirror even when the previous pause was manual. The anchor moves
    // first: handleWechatResume reconciles the backlog against it.
    this.onHumanMessage?.(this.lastInboundAt)
    this.setPaused(false, { by: PAUSE_BY_CHANNEL, reason: '微信 Claw 消息' })
    // A fresh inbound message usually carries a fresh context_token. Pending
    // fallback replies were deferred on a stale token, so give them a retry now.
    if (this.onInbound) {
      try {
        Promise.resolve(this.onInbound()).catch(error => {
          this.log('warn', '[claw outbound] inbound retry failed: ' + errorText(error))
        })
      } catch (error) {
        this.log('warn', '[claw outbound] inbound retry failed: ' + errorText(error))
      }
    }
    const text = textOf(message)
    const images = clawImageItems(message)
    const files = clawFileItems(message)
    const options = this.imageOptions()
    const fileOptions = this.fileOptions()
    const acceptsImages = images.length > 0 && options.inbound
    const acceptsFiles = files.length > 0 && fileOptions.enabled
    if (!acceptsImages && !acceptsFiles) {
      if (!text) {
        await this.notify(files.length ? '目前文件接收已关闭。' : '目前只能接收文本消息。')
        return
      }
      const notes = []
      if (images.length && !options.inbound) notes.push('[图片接收失败：图片接收已关闭]')
      if (files.length && !fileOptions.enabled) notes.push('[文件接收失败：文件接收已关闭]')
      try {
        await this.deliverText(notes.length ? text + '\n' + notes.join('\n') : text)
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
    if (this.directRelay) {
      let handled = false
      try {
        handled = await this.directRelay(content, sessionId)
      } catch (error) {
        // A broken relay must not leak the message into the Chatbot; report it
        // through the channel log and treat the message as consumed.
        this.log('warn', '[claw direct] relay failed: ' + errorText(error))
        handled = true
      }
      if (handled) return
    }
    return deliverInboundPrompt({
      sessionController: this.ctx.sessionController,
      sessionId,
      content,
      requestId: this.requestId(),
      isRiaBusy: this.isRiaBusy,
      signal: this.deliveryAbort.signal,
      log: this.log,
      channel: 'wechat-claw',
    })
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

  inboundFileMaxBytes() {
    return this.fileOptions().maxBytes
  }

  async deliverInbound(message, text, messageId) {
    const sessionId = await this.ensureRia()
    const signal = this.deliveryAbort.signal
    const saved = []
    const failures = []
    const parts = []
    const images = clawImageItems(message)
    const files = clawFileItems(message)
    const imageOptions = this.imageOptions()
    const fileOptions = this.fileOptions()
    const maxBytes = this.inboundImageMaxBytes()
    if (!imageOptions.inbound && images.length) failures.push('图片接收已关闭')
    for (const { item, index } of (imageOptions.inbound ? images : [])) {
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
    const fileSaved = []
    const fileFailures = []
    const fileMaxBytes = fileOptions.maxBytes
    if (!fileOptions.enabled && files.length) fileFailures.push('文件接收已关闭')
    for (const { item, index } of (fileOptions.enabled ? files : [])) {
      const label = (messageId || 'unknown') + (index ? '#' + index : '')
      try {
        const received = await receiveInboundClawFile({
          item,
          messageId: label,
          stateDir: this.stateDir,
          maxBytes: fileMaxBytes,
          signal,
        })
        fileSaved.push(received)
      } catch (error) {
        if (error && (error.name === 'AbortError' || error.code === 'ABORT_ERR')) throw error
        const reason = this.imageFailureReason(error)
        const code = (error && error.code) || 'file_error'
        this.log('warn', '[claw inbound] file ' + label + ' rejected (' + code + '): ' + reason)
        fileFailures.push(reason)
      }
    }
    if (saved.length) {
      try {
        pruneClawInboundImages(this.stateDir)
      } catch (error) {
        this.log('warn', '[claw inbound] could not prune saved images: ' + errorText(error))
      }
    }
    if (fileSaved.length) {
      try {
        pruneClawInboundFiles(this.stateDir)
      } catch (error) {
        this.log('warn', '[claw inbound] could not prune saved files: ' + errorText(error))
      }
    }
    const lines = []
    const caption = String(text || '').trim()
    if (caption) lines.push(caption)
    else if (saved.length) lines.push('（用户发来一张图片）')
    else if (fileSaved.length) lines.push(FILE_PLACEHOLDER)
    else lines.push('（用户发来一条消息）')
    for (const path of saved) lines.push('（图片已保存：' + path + '）')
    for (const file of fileSaved) {
      lines.push('📎 文件：' + file.originalName + '（' + formatFileSize(file.bytes) + '）')
      lines.push('   路径：' + file.path)
    }
    for (const reason of failures) lines.push('[图片接收失败：' + reason + ']')
    for (const reason of fileFailures) lines.push('[文件接收失败：' + reason + ']')
    const body = lines.join('\n')
    if (!parts.length) {
      await this.promptContent(sessionId, [{ type: 'text', text: body }])
      return
    }
    try {
      await this.promptContent(sessionId, [{ type: 'text', text: body }, ...parts])
    } catch (error) {
      const reason = '投递失败：' + this.imageFailureReason(error)
      this.log('warn', '[claw inbound] image message could not be delivered as an image; retrying text only: ' + reason)
      const retryLines = lines.concat('[图片接收失败：' + reason + ']')
      await this.promptContent(sessionId, [{ type: 'text', text: retryLines.join('\n') }])
    }
  }

  async sendItems(itemList) {
    const session = this.session
    if (!session) throw new Error('微信 Claw 未登录')
    const peer = this.peer
    if (!peer || !peer.userId || !peer.contextToken) {
      const error = new Error('微信 Claw 尚未收到可回复的消息')
      error.code = 'WECHAT_CLAW_NO_PEER'
      throw error
    }
    const userId = peer.userId
    return this.withTypingLock(userId, async () => {
      const liveSession = this.session
      const livePeer = this.peer
      if (!liveSession) throw new Error('微信 Claw 未登录')
      if (!livePeer || livePeer.userId !== userId || !livePeer.contextToken) {
        const error = new Error('微信 Claw 尚未收到可回复的消息')
        error.code = 'WECHAT_CLAW_NO_PEER'
        throw error
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
      let data
      try {
        data = await requestJson(liveSession.baseUrl + '/ilink/bot/sendmessage', {
          method: 'POST',
          headers: botHeaders(liveSession.token),
          body: payload,
          signal: liveSession.abort.signal,
          timeoutMs: 20000,
        })
      } catch (error) {
        throw redactPeerError(error, livePeer.contextToken)
      }
      if (data && typeof data.ret === 'number' && data.ret !== 0) {
        // The server can echo the context token back in an error; it is a
        // credential, so keep it out of messages and the assistant log.
        const errmsg = redactPeerSecret(typeof data.errmsg === 'string' ? data.errmsg : '', livePeer.contextToken)
        const error = new Error('sendmessage ret=' + data.ret + (errmsg ? ' errmsg=' + errmsg : ''))
        error.ret = data.ret
        error.errmsg = errmsg
        if (this.peerRestored) {
          // A token restored from disk was rejected. Forget it so the next
          // inbound message is required to supply a fresh one; the host's
          // fallback queue retries after that inbound.
          error.code = 'WECHAT_CLAW_PEER_REJECTED'
          error.message = '微信 Claw 的回复凭据已失效（ret=' + data.ret + '），请先发一条微信消息刷新' + (errmsg ? '：' + errmsg : '')
          this.clearPeer()
        } else {
          error.code = 'WECHAT_CLAW_SEND_REJECTED'
        }
        throw error
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
          // iLink wants base64 of the 32-char hex string, not base64 of the
          // 16 raw key bytes: base64(raw) renders as a black thumbnail that
          // then reports "expired or cleaned" (measured 2026-11-14 against a
          // live account; matches Tencent/openclaw-weixin src/messaging/send.ts).
          aes_key: Buffer.from(uploaded.aeskey, 'utf8').toString('base64'),
          encrypt_type: 1,
        },
        mid_size: uploaded.ciphertextSize,
      },
    }])
  }

  /** Upload one file to the iLink CDN, then send a file_item that references it. */
  async sendFile(name, buffer) {
    const session = this.session
    if (!session) throw new Error('微信 Claw 未登录')
    if (this.paused) {
      const error = new Error('微信 Claw 推送已暂停')
      error.code = 'WECHAT_PAUSED'
      throw error
    }
    const peer = this.peer
    if (!peer || !peer.userId || !peer.contextToken) throw new Error('微信 Claw 尚未收到可回复的消息')
    const uploaded = await uploadClawFile({
      baseUrl: session.baseUrl,
      cdnBaseUrl: process.env.WX_CLAW_CDN_BASE || DEFAULT_CLAW_CDN_BASE,
      headers: botHeaders(session.token),
      baseInfo: baseInfo(),
      toUserId: peer.userId,
      buffer,
      signal: session.abort.signal,
      log: this.log,
    })
    return this.sendItems([clawFileItem(uploaded, name)])
  }

  /** Remember the outcome of a tool-triggered file send for status and logs. */
  recordFileSend(record) {
    const value = record && typeof record === 'object' ? record : {}
    this.lastFileSend = {
      at: new Date().toISOString(),
      delivered: value.delivered === true,
      name: String(value.name || ''),
      bytes: Number.isFinite(value.bytes) ? value.bytes : 0,
      path: String(value.path || ''),
      ...(value.code ? { code: String(value.code) } : {}),
      ...(value.error ? { error: String(value.error) } : {}),
      ...(Number.isFinite(value.ret) ? { ret: value.ret } : {}),
      ...(value.errmsg ? { errmsg: String(value.errmsg) } : {}),
    }
    return this.lastFileSend
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

  async sendAssistantNote(text, { durable = true } = {}) {
    const value = String(text == null ? '' : text).trim()
    if (!value) return false
    return this.sendNote('（补发）\n' + value, { durable })
  }

  assistantFailure(error) {
    const fields = { error: errorText(error) }
    if (error && error.code) fields.errorCode = error.code
    if (error && Number.isFinite(error.ret)) fields.ret = error.ret
    if (error && typeof error.errmsg === 'string' && error.errmsg) fields.errmsg = error.errmsg
    if (error && Number.isFinite(error.deliveredChunks)) fields.deliveredChunks = error.deliveredChunks
    if (error && Number.isFinite(error.totalChunks)) fields.totalChunks = error.totalChunks
    return fields
  }

  appendAssistantLog(record) {
    try {
      ensureDir(this.dir)
      const file = join(this.dir, ASSISTANT_LOG)
      try {
        if (statSync(file).size > ASSISTANT_LOG_LIMIT) {
          // One-generation rotation keeps long-running installs bounded without
          // adding a logger dependency. rename overwrites the old generation.
          renameSync(file, file + '.1')
        }
      } catch { /* file does not exist yet */ }
      appendFileSync(file, JSON.stringify(record) + '\n', { mode: 0o600 })
    } catch (error) {
      this.log('warn', '[claw outbound] could not write assistant log: ' + errorText(error))
    }
  }

  recordAssistantForward(reason, text, event, extra = {}, options = {}) {
    const value = String(text == null ? '' : text)
    const record = {
      at: new Date().toISOString(),
      reason,
      chars: value.length,
      preview: value.slice(0, 120),
      ...extra,
    }
    if (event && Number.isFinite(event.seq)) record.eventSeq = event.seq
    // The causal time of the assistant reply, not the time delivery was tried.
    // Resume replay uses it to interleave text with dispatch cards correctly.
    const happenedAt = eventTimestamp(event)
    if (happenedAt) record.eventAt = happenedAt
    if (reason === 'delivered') {
      this.log('info', '[claw outbound] assistant text delivered chars=' + record.chars)
    } else {
      const level = reason === 'paused' || reason === 'no_outbound' ? 'info' : 'warn'
      this.log(level, '[claw outbound] assistant text ' + reason + ' chars=' + record.chars
        + (record.error ? ' error=' + record.error : ''))
    }
    // A skipped or failed reply must still reach the user eventually. The
    // fallback is queued durably; no_text has nothing to resend.
    if (options.fallback !== false && reason !== 'delivered' && reason !== 'no_text' && this.onAssistantUndelivered) {
      try {
        record.fallbackQueued = this.onAssistantUndelivered({ ...record, text: value }) !== false
      } catch (error) {
        record.fallbackQueued = false
        record.fallbackError = errorText(error)
      }
    }
    this.appendAssistantLog(record)
    this.lastAssistantForward = record
    return record
  }

  forwardAssistant(text, event, options = {}) {
    const value = String(text == null ? '' : text)
    if (!value.trim()) return this.recordAssistantForward('no_text', value, event, {}, options)
    if (!this.outbound) return this.recordAssistantForward('no_outbound', value, event, {}, options)
    if (this.paused) return this.recordAssistantForward('paused', value, event, {}, options)
    void this.deliverAssistant(value).then(result => {
      this.recordAssistantForward('delivered', value, event, {
        images: result.images,
        imagesFailed: result.imagesFailed,
      })
    }).catch(error => {
      const reason = error && error.code === 'WECHAT_PAUSED'
        ? 'paused'
        : error && error.code === 'WECHAT_CLAW_EXTRACT'
          ? 'extract_failed'
          : 'send_failed'
      this.recordAssistantForward(reason, value, event, this.assistantFailure(error), options)
    })
  }

  async deliverAssistant(text) {
    const outbound = this.outbound
    if (!outbound) return { chars: 0, images: 0, imagesFailed: 0 }
    const value = String(text == null ? '' : text)
    if (!value.trim()) return { chars: 0, images: 0, imagesFailed: 0 }
    let extracted
    try {
      extracted = this.imageOptions().outbound
        ? extractAssistantImages(value, [this.stateDir, process.cwd()])
        : { text: value, images: [] }
    } catch (error) {
      if (error && !error.code) error.code = 'WECHAT_CLAW_EXTRACT'
      throw error
    }
    if (extracted.text.trim()) {
      try {
        await outbound.enqueue(extracted.text)
      } catch (error) {
        if (error && !error.code) error.code = 'WECHAT_CLAW_SEND_FAILED'
        throw error
      }
    }
    let imagesFailed = 0
    for (const image of extracted.images) {
      try {
        await outbound.enqueueImage({ name: image.name, buffer: image.buffer, mime: image.mime, ref: image.path })
      } catch (error) {
        if (error && error.code === 'WECHAT_PAUSED') throw error
        imagesFailed += 1
        this.log('warn', '[claw outbound] image ' + image.name + ' failed: ' + errorText(error))
        try {
          await outbound.enqueue('（图片 ' + image.name + ' 发送失败，请在 Ria 会话中查看原图）')
        } catch (fallbackError) {
          if (fallbackError && fallbackError.code === 'WECHAT_PAUSED') throw fallbackError
          this.log('warn', '[claw outbound] image failure note failed: ' + errorText(fallbackError))
        }
      }
    }
    return { chars: extracted.text.length, images: extracted.images.length, imagesFailed }
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
    this.clearPeer()
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
      lastAssistantForward: this.lastAssistantForward || null,
      lastFileSend: this.lastFileSend || null,
      wechatClawImage: this.imageOptions(),
      wechatClawFile: this.fileOptions(),
      wechatClawTyping: this.typingStateView(),
      login: { ...this.login },
    }
  }
}
