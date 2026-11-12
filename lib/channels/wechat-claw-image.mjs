// WeChat Claw (iLink bot) image support.
//
// Inbound: an image_item carries CDN coordinates (media.full_url or an
// encrypted_query_param) plus an AES-128-ECB key. We download the ciphertext,
// decrypt it, check the magic bytes, and keep a copy under
// <stateDir>/wechat-claw-inbound before handing the host a normal image part.
//
// Outbound: the iLink bot cannot send a URL or base64 directly. The flow is
// getuploadurl -> AES-128-ECB encrypt -> POST to the CDN -> read the
// x-encrypted-param response header -> sendmessage an image_item that points at
// that encrypted query parameter. See Tencent/openclaw-weixin
// src/cdn/upload.ts and src/messaging/send.ts.
//
// The protocol details here were taken from the public openclaw-weixin client
// reference implementation, not guessed from a sample payload.

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { closeSync, mkdirSync, openSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import { imageMediaType, IMAGE_PLACEHOLDER, pruneInboundImages } from '../wechat/image.mjs'
import { requestJson } from './common.mjs'

export const DEFAULT_WECHAT_CLAW_IMAGE_OPTIONS = Object.freeze({ inbound: true, outbound: true })
export const DEFAULT_CLAW_CDN_BASE = 'https://novac2c.cdn.weixin.qq.com/c2c'
export const CLAW_INBOUND_IMAGE_DIR = 'wechat-claw-inbound'
export const DEFAULT_CLAW_IMAGE_MAX_BYTES = 20 * 1024 * 1024

const DOWNLOAD_TIMEOUT_MS = 60000
const UPLOAD_TIMEOUT_MS = 60000
const UPLOAD_ATTEMPTS = 3

export class ClawImageError extends Error {
  constructor(message, code, reason) {
    super(message)
    this.name = 'ClawImageError'
    this.code = code
    this.reason = reason || message
  }
}

export function normalizeWechatClawImageOptions(raw) {
  const source = raw && typeof raw === 'object' ? raw : {}
  return {
    inbound: typeof source.inbound === 'boolean' ? source.inbound : DEFAULT_WECHAT_CLAW_IMAGE_OPTIONS.inbound,
    outbound: typeof source.outbound === 'boolean' ? source.outbound : DEFAULT_WECHAT_CLAW_IMAGE_OPTIONS.outbound,
  }
}

/** Image items in an iLink message; type 2 is image_item. */
export function clawImageItems(message) {
  const items = Array.isArray(message && message.item_list) ? message.item_list : []
  const found = []
  items.forEach((item, index) => {
    if (item && Number(item.type) === 2 && item.image_item && typeof item.image_item === 'object') {
      found.push({ item: item.image_item, index })
    }
  })
  return found
}

export function clawInboundText(caption, savedPaths = [], failures = []) {
  const lines = [String(caption || '').trim() || IMAGE_PLACEHOLDER]
  for (const path of savedPaths) lines.push('（图片已保存：' + path + '）')
  for (const reason of failures) lines.push('[图片接收失败：' + reason + ']')
  return lines.join('\n')
}

/** Parse either base64(16 raw bytes) or base64(32 hex chars) into a raw AES key. */
export function parseAesKey(value) {
  const source = String(value == null ? '' : value).trim()
  if (!source) return undefined
  const decoded = Buffer.from(source, 'base64')
  if (decoded.length === 16) return decoded
  if (decoded.length === 32 && /^[0-9a-fA-F]{32}$/.test(decoded.toString('utf8'))) {
    return Buffer.from(decoded.toString('utf8'), 'hex')
  }
  throw new ClawImageError('微信 Claw 图片密钥格式无法识别', 'image_decrypt_failed', '图片密钥格式无法识别')
}

function aesKeyOf(item) {
  const direct = String((item && item.aeskey) || '').trim()
  if (direct) {
    if (!/^[0-9a-fA-F]{32}$/.test(direct)) {
      throw new ClawImageError('微信 Claw 图片密钥格式无法识别', 'image_decrypt_failed', '图片密钥格式无法识别')
    }
    return Buffer.from(direct, 'hex')
  }
  const mediaKey = item && item.media && item.media.aes_key
  return parseAesKey(mediaKey)
}

export function aesEcbPaddedSize(size) {
  return Math.ceil((Number(size) + 1) / 16) * 16
}

export function encryptAesEcb(buffer, key) {
  const cipher = createCipheriv('aes-128-ecb', key, null)
  return Buffer.concat([cipher.update(buffer), cipher.final()])
}

export function decryptAesEcb(buffer, key) {
  const decipher = createDecipheriv('aes-128-ecb', key, null)
  return Buffer.concat([decipher.update(buffer), decipher.final()])
}

function cdnBase(value) {
  return String(value || DEFAULT_CLAW_CDN_BASE).replace(/\/$/, '')
}

function imageUrl(item, base) {
  const media = (item && item.media) || {}
  const full = typeof media.full_url === 'string' ? media.full_url.trim() : ''
  if (full) return full
  const param = typeof media.encrypt_query_param === 'string' ? media.encrypt_query_param.trim() : ''
  if (param) return cdnBase(base) + '/download?encrypted_query_param=' + encodeURIComponent(param)
  const legacy = typeof item.url === 'string' ? item.url.trim() : ''
  if (legacy) return legacy
  throw new ClawImageError('微信 Claw 图片没有下载地址', 'image_invalid', '图片没有下载地址')
}

function abortFor(signal, timeoutMs) {
  const timeout = AbortSignal.timeout(timeoutMs)
  if (!signal) return timeout
  return AbortSignal.any([signal, timeout])
}

async function readLimited(response, maxBytes, label) {
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new ClawImageError(label + '超过上限', 'image_too_large', '图片超过 ' + Math.round(maxBytes / 1024 / 1024) + 'MB')
  }
  if (!response.body || typeof response.body.getReader !== 'function') {
    const buffer = Buffer.from(await response.arrayBuffer())
    if (buffer.length > maxBytes) throw new ClawImageError(label + '超过上限', 'image_too_large', '图片超过上限')
    return buffer
  }
  const reader = response.body.getReader()
  const chunks = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    const chunk = Buffer.from(value)
    total += chunk.length
    if (total > maxBytes) {
      try { await reader.cancel() } catch { /* best effort */ }
      throw new ClawImageError(label + '超过上限', 'image_too_large', '图片超过 ' + Math.round(maxBytes / 1024 / 1024) + 'MB')
    }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

function safeSegment(value, fallback) {
  const text = String(value || '').replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 80)
  return text || fallback
}

function timestamp(date = new Date()) {
  const pad = n => String(n).padStart(2, '0')
  return String(date.getFullYear()) + pad(date.getMonth() + 1) + pad(date.getDate()) +
    '-' + pad(date.getHours()) + pad(date.getMinutes()) + pad(date.getSeconds())
}

function extensionFor(mediaType) {
  if (mediaType === 'image/png') return 'png'
  if (mediaType === 'image/jpeg') return 'jpg'
  if (mediaType === 'image/gif') return 'gif'
  if (mediaType === 'image/webp') return 'webp'
  return 'bin'
}

function saveBytes(dir, messageId, bytes, mediaType) {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const stem = timestamp() + '-' + safeSegment(messageId, 'image')
  const ext = extensionFor(mediaType)
  for (let index = 1; index <= 1000; index += 1) {
    const suffix = index === 1 ? '' : '-' + index
    const file = join(dir, stem + suffix + '.' + ext)
    try {
      const fd = openSync(file, 'wx', 0o600)
      try { writeSync(fd, bytes) } finally { closeSync(fd) }
      return file
    } catch (error) {
      if (error && error.code === 'EEXIST') continue
      throw error
    }
  }
  throw new ClawImageError('无法保存图片', 'image_save_failed', '文件名冲突过多')
}

/**
 * Download and decrypt one inbound image item.
 * Returns { part, path, mediaType, name, bytes } where part is a host image part.
 */
export async function receiveInboundClawImage({
  item,
  messageId,
  stateDir,
  maxBytes = DEFAULT_CLAW_IMAGE_MAX_BYTES,
  signal,
  cdnBaseUrl,
  fetchImpl = fetch,
} = {}) {
  if (!stateDir) throw new ClawImageError('缺少状态目录', 'image_no_state', '缺少状态目录')
  if (!item || typeof item !== 'object') throw new ClawImageError('图片结构无效', 'image_invalid', '图片结构无效')
  const url = imageUrl(item, cdnBaseUrl)
  const key = aesKeyOf(item)
  // The CDN holds ciphertext, which is at most one AES block longer than the
  // plaintext; enforce the real limit again after decryption.
  const downloadLimit = key ? aesEcbPaddedSize(maxBytes) : maxBytes
  let response
  try {
    response = await fetchImpl(url, { method: 'GET', signal: abortFor(signal, DOWNLOAD_TIMEOUT_MS) })
  } catch (error) {
    if (error && error.name === 'AbortError') throw error
    throw new ClawImageError('图片下载失败', 'image_download_failed', error && error.message ? error.message : '下载失败')
  }
  if (!response || !response.ok) {
    throw new ClawImageError('图片下载失败', 'image_download_failed', '图片下载失败（HTTP ' + (response ? response.status : '无响应') + '）')
  }
  let bytes
  try {
    bytes = await readLimited(response, downloadLimit, '图片')
  } catch (error) {
    if (error instanceof ClawImageError) throw error
    throw new ClawImageError('图片下载失败', 'image_download_failed', error && error.message ? error.message : '下载失败')
  }
  if (!bytes.length) throw new ClawImageError('图片为空', 'image_empty', '图片内容为空')
  if (key) {
    try {
      bytes = decryptAesEcb(bytes, key)
    } catch {
      throw new ClawImageError('图片解密失败', 'image_decrypt_failed', '图片解密失败')
    }
  }
  if (bytes.length > maxBytes) {
    throw new ClawImageError('图片超过上限', 'image_too_large', '图片超过 ' + Math.round(maxBytes / 1024 / 1024) + 'MB')
  }
  const mediaType = imageMediaType(bytes)
  if (!mediaType) {
    throw new ClawImageError('不支持的图片格式', 'image_unsupported', '只支持 PNG/JPEG/GIF/WebP')
  }
  const path = saveBytes(join(stateDir, CLAW_INBOUND_IMAGE_DIR), messageId, bytes, mediaType)
  return {
    part: { type: 'image', mediaType, data: bytes.toString('base64'), name: path.split(/[\\/]/).pop() },
    path,
    mediaType,
    name: path.split(/[\\/]/).pop(),
    bytes: bytes.length,
  }
}

/** Delete old Claw inbound images; the generic WeChat prune helper already does the policy. */
export function pruneClawInboundImages(stateDir, options = {}) {
  return pruneInboundImages(join(stateDir, CLAW_INBOUND_IMAGE_DIR), options)
}

async function uploadToCdn(url, ciphertext, signal, log, fetchImpl = fetch) {
  let lastError
  for (let attempt = 1; attempt <= UPLOAD_ATTEMPTS; attempt += 1) {
    let response
    try {
      response = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
        body: ciphertext,
        signal: abortFor(signal, UPLOAD_TIMEOUT_MS),
      })
    } catch (error) {
      if (error && error.name === 'AbortError') throw error
      lastError = error
      if (log) log('warn', '[claw outbound] image upload attempt ' + attempt + ' failed: ' + (error && error.message ? error.message : error))
      continue
    }
    if (response.ok) {
      const param = response.headers.get('x-encrypted-param')
      if (param) return param
      lastError = new Error('CDN 没有返回 x-encrypted-param')
      if (log) log('warn', '[claw outbound] image upload returned no x-encrypted-param')
      continue
    }
    // 4xx is permanent; retrying the exact same request cannot help.
    if (response.status >= 400 && response.status < 500) {
      throw new ClawImageError('图片上传被拒绝', 'image_upload_failed', 'HTTP ' + response.status)
    }
    lastError = new Error('HTTP ' + response.status)
    if (log) log('warn', '[claw outbound] image upload attempt ' + attempt + ' got HTTP ' + response.status)
  }
  throw new ClawImageError('图片上传失败', 'image_upload_failed', lastError && lastError.message ? lastError.message : '上传失败')
}

/**
 * Upload one image to the iLink CDN and return the coordinates sendmessage needs.
 */
export async function uploadClawImage({
  baseUrl,
  cdnBaseUrl,
  headers,
  baseInfo,
  toUserId,
  buffer,
  signal,
  log,
  fetchImpl = fetch,
} = {}) {
  if (!baseUrl) throw new ClawImageError('微信 Claw 未登录', 'image_upload_failed', '未登录')
  if (!toUserId) throw new ClawImageError('微信 Claw 缺少回复目标', 'image_upload_failed', '缺少回复目标')
  if (!Buffer.isBuffer(buffer) || !buffer.length) {
    throw new ClawImageError('图片为空', 'image_upload_failed', '图片为空')
  }
  const key = randomBytes(16)
  const filekey = randomBytes(16).toString('hex')
  const rawsize = buffer.length
  const filesize = aesEcbPaddedSize(rawsize)
  let start
  try {
    start = await requestJson(String(baseUrl).replace(/\/$/, '') + '/ilink/bot/getuploadurl', {
      method: 'POST',
      headers,
      body: {
        filekey,
        media_type: 1,
        to_user_id: toUserId,
        rawsize,
        rawfilemd5: createHash('md5').update(buffer).digest('hex'),
        filesize,
        no_need_thumb: true,
        aeskey: key.toString('hex'),
        base_info: baseInfo || {},
      },
      signal,
      timeoutMs: 20000,
    })
  } catch (error) {
    throw new ClawImageError('获取图片上传地址失败', 'image_upload_failed', error && error.message ? error.message : '上传地址失败')
  }
  if (start && typeof start.ret === 'number' && start.ret !== 0) {
    throw new ClawImageError('获取图片上传地址失败', 'image_upload_failed', 'ret=' + start.ret)
  }
  const fullUrl = typeof start.upload_full_url === 'string' ? start.upload_full_url.trim() : ''
  const param = typeof start.upload_param === 'string' ? start.upload_param.trim() : ''
  if (!fullUrl && !param) {
    throw new ClawImageError('获取图片上传地址失败', 'image_upload_failed', '响应没有 upload_full_url/upload_param')
  }
  const url = fullUrl || (cdnBase(cdnBaseUrl) + '/upload?encrypted_query_param=' + encodeURIComponent(param) + '&filekey=' + encodeURIComponent(filekey))
  const ciphertext = encryptAesEcb(buffer, key)
  const encryptedParam = await uploadToCdn(url, ciphertext, signal, log, fetchImpl)
  return {
    downloadEncryptedQueryParam: encryptedParam,
    aeskey: key.toString('hex'),
    ciphertextSize: ciphertext.length,
    rawsize,
  }
}
