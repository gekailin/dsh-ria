// WeChat Claw (iLink bot) file support.
//
// Inbound: a file_item (type 4) carries CDN coordinates plus file_name/len.
// The CDN payload is AES-128-ECB encrypted with media.aes_key, exactly like
// images. Files are saved under <stateDir>/wechat-claw-inbound-files and handed
// to Ria as an explicit text reference (the host's file part needs a receipt
// that a channel plugin cannot mint).
//
// Outbound: getuploadurl with media_type=3 -> AES encrypt -> POST to the CDN ->
// x-encrypted-param -> sendmessage a file_item. Taken from
// Tencent/openclaw-weixin src/cdn/upload.ts, src/messaging/send.ts and
// src/api/types.ts; not guessed from a sample payload.

import { createCipheriv, createHash, randomBytes } from 'node:crypto'
import { closeSync, mkdirSync, openSync, writeSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import { pruneInboundImages } from '../wechat/image.mjs'
import { requestJson } from './common.mjs'
import {
  DEFAULT_CLAW_CDN_BASE,
  aesEcbPaddedSize,
  decryptAesEcb,
  encryptAesEcb,
  parseAesKey,
} from './wechat-claw-image.mjs'

export const DEFAULT_WECHAT_CLAW_FILE_OPTIONS = Object.freeze({ enabled: true, maxBytes: 20 * 1024 * 1024 })
export const CLAW_INBOUND_FILE_DIR = 'wechat-claw-inbound-files'
export const DEFAULT_CLAW_FILE_MAX_BYTES = 20 * 1024 * 1024
export const FILE_PLACEHOLDER = '（用户发来一个文件）'

// Keep this list deliberately boring: documents, archives, text and images.
// It is an allowlist at both ends, so a renamed executable is still rejected
// when its extension is not here.
const FILE_TYPES = {
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  zip: 'application/zip',
  gz: 'application/gzip',
  tar: 'application/x-tar',
  '7z': 'application/x-7z-compressed',
  rar: 'application/vnd.rar',
  txt: 'text/plain',
  md: 'text/markdown',
  csv: 'text/csv',
  json: 'application/json',
  html: 'text/html',
  xml: 'application/xml',
  yml: 'text/yaml',
  yaml: 'text/yaml',
  log: 'text/plain',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
}
export const CLAW_FILE_EXTENSIONS = Object.freeze(Object.keys(FILE_TYPES))

const DOWNLOAD_TIMEOUT_MS = 60000
const UPLOAD_TIMEOUT_MS = 60000
const UPLOAD_ATTEMPTS = 3

export class ClawFileError extends Error {
  constructor(message, code, reason) {
    super(message)
    this.name = 'ClawFileError'
    this.code = code
    this.reason = reason || message
  }
}

export function normalizeWechatClawFileOptions(raw) {
  const source = raw && typeof raw === 'object' ? raw : {}
  const max = Number(source.maxBytes)
  return {
    enabled: typeof source.enabled === 'boolean' ? source.enabled : DEFAULT_WECHAT_CLAW_FILE_OPTIONS.enabled,
    maxBytes: Number.isFinite(max) && max > 0
      ? Math.min(Math.floor(max), 100 * 1024 * 1024)
      : DEFAULT_WECHAT_CLAW_FILE_OPTIONS.maxBytes,
  }
}

/** File items in an iLink message; type 4 is file_item. */
export function clawFileItems(message) {
  const items = Array.isArray(message && message.item_list) ? message.item_list : []
  const found = []
  items.forEach((item, index) => {
    if (item && Number(item.type) === 4 && item.file_item && typeof item.file_item === 'object') {
      found.push({ item: item.file_item, index })
    }
  })
  return found
}

export function formatFileSize(bytes) {
  const size = Number(bytes)
  if (!Number.isFinite(size) || size < 0) return '未知大小'
  if (size < 1024) return size + ' B'
  if (size < 1024 * 1024) return (size / 1024).toFixed(1).replace(/\.0$/, '') + ' KB'
  if (size < 1024 * 1024 * 1024) return (size / 1024 / 1024).toFixed(1).replace(/\.0$/, '') + ' MB'
  return (size / 1024 / 1024 / 1024).toFixed(2).replace(/\.00$/, '') + ' GB'
}

export function fileExtensionOf(name) {
  return extname(String(name || '')).replace(/^\./, '').toLowerCase()
}

export function clawFileMime(name) {
  return FILE_TYPES[fileExtensionOf(name)] || 'application/octet-stream'
}

export function isAllowedClawFile(name) {
  return Boolean(FILE_TYPES[fileExtensionOf(name)])
}

/** Strip directories and characters that are unsafe on Linux or Windows. */
export function safeClawFileName(raw, fallback = 'file') {
  const base = basename(String(raw == null ? '' : raw).replace(/\\/g, '/'))
  const cleaned = base
    .replace(/[\u0000-\u001f\u007f/\\:*?"<>|]+/g, '_')
    .replace(/^\.+/, '')
    .replace(/[. ]+$/g, '')
    .trim()
    .slice(0, 120)
  return cleaned || fallback
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

export function clawInboundFileText(caption, files = [], failures = []) {
  const lines = [String(caption || '').trim() || FILE_PLACEHOLDER]
  for (const file of files) {
    lines.push('📎 文件：' + file.name + '（' + formatFileSize(file.bytes) + '）')
    lines.push('   路径：' + file.path)
  }
  for (const reason of failures) lines.push('[文件接收失败：' + reason + ']')
  return lines.join('\n')
}

function aesKeyOf(item) {
  const mediaKey = item && item.media && item.media.aes_key
  const direct = String((item && item.aeskey) || '').trim()
  if (direct) return parseAesKey(direct)
  return parseAesKey(mediaKey)
}

function cdnBase(value) {
  return String(value || DEFAULT_CLAW_CDN_BASE).replace(/\/$/, '')
}

function fileUrl(item, base) {
  const media = (item && item.media) || {}
  const full = typeof media.full_url === 'string' ? media.full_url.trim() : ''
  if (full) return full
  const param = typeof media.encrypt_query_param === 'string' ? media.encrypt_query_param.trim() : ''
  if (param) return cdnBase(base) + '/download?encrypted_query_param=' + encodeURIComponent(param)
  const legacy = typeof item.url === 'string' ? item.url.trim() : ''
  if (legacy) return legacy
  throw new ClawFileError('微信 Claw 文件没有下载地址', 'file_invalid', '文件没有下载地址')
}

function abortFor(signal, timeoutMs) {
  const timeout = AbortSignal.timeout(timeoutMs)
  if (!signal) return timeout
  return AbortSignal.any([signal, timeout])
}

async function readLimited(response, maxBytes, label) {
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new ClawFileError(label + '超过上限', 'file_too_large', '文件超过 ' + formatFileSize(maxBytes))
  }
  if (!response.body || typeof response.body.getReader !== 'function') {
    const buffer = Buffer.from(await response.arrayBuffer())
    if (buffer.length > maxBytes) throw new ClawFileError(label + '超过上限', 'file_too_large', '文件超过上限')
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
      throw new ClawFileError(label + '超过上限', 'file_too_large', '文件超过 ' + formatFileSize(maxBytes))
    }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

function saveBytes(dir, messageId, bytes, name) {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const stem = timestamp() + '-' + safeSegment(messageId, 'file')
  const dot = name.lastIndexOf('.')
  const base = dot > 0 ? name.slice(0, dot) : name
  const ext = dot > 0 ? name.slice(dot) : ''
  for (let index = 1; index <= 1000; index += 1) {
    const suffix = index === 1 ? '' : '-' + index
    const file = join(dir, stem + '-' + base + suffix + ext)
    try {
      const fd = openSync(file, 'wx', 0o600)
      try { writeSync(fd, bytes) } finally { closeSync(fd) }
      return file
    } catch (error) {
      if (error && error.code === 'EEXIST') continue
      throw error
    }
  }
  throw new ClawFileError('无法保存文件', 'file_save_failed', '文件名冲突过多')
}

/**
 * Download and decrypt one inbound file item.
 * Returns { path, name, bytes }.
 */
export async function receiveInboundClawFile({
  item,
  messageId,
  stateDir,
  maxBytes = DEFAULT_CLAW_FILE_MAX_BYTES,
  signal,
  cdnBaseUrl,
  fetchImpl = fetch,
} = {}) {
  if (!stateDir) throw new ClawFileError('缺少状态目录', 'file_no_state', '缺少状态目录')
  if (!item || typeof item !== 'object') throw new ClawFileError('文件结构无效', 'file_invalid', '文件结构无效')
  const name = safeClawFileName(item.file_name, 'file.bin')
  if (!isAllowedClawFile(name)) {
    throw new ClawFileError('不支持的文件类型', 'file_unsupported', '不支持的文件类型：' + fileExtensionOf(name))
  }
  const declared = Number(item.len)
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new ClawFileError('文件超过上限', 'file_too_large', '文件 ' + name + ' 超过 ' + formatFileSize(maxBytes) + ' 上限')
  }
  const url = fileUrl(item, cdnBaseUrl)
  const key = aesKeyOf(item)
  const downloadLimit = key ? aesEcbPaddedSize(maxBytes) : maxBytes
  let response
  try {
    response = await fetchImpl(url, { method: 'GET', signal: abortFor(signal, DOWNLOAD_TIMEOUT_MS) })
  } catch (error) {
    if (error && error.name === 'AbortError') throw error
    throw new ClawFileError('文件下载失败', 'file_download_failed', error && error.message ? error.message : '下载失败')
  }
  if (!response || !response.ok) {
    throw new ClawFileError('文件下载失败', 'file_download_failed', '文件下载失败（HTTP ' + (response ? response.status : '无响应') + '）')
  }
  let bytes
  try {
    bytes = await readLimited(response, downloadLimit, '文件')
  } catch (error) {
    if (error instanceof ClawFileError) throw error
    throw new ClawFileError('文件下载失败', 'file_download_failed', error && error.message ? error.message : '下载失败')
  }
  if (!bytes.length) throw new ClawFileError('文件为空', 'file_empty', '文件内容为空')
  if (key) {
    try {
      bytes = decryptAesEcb(bytes, key)
    } catch {
      throw new ClawFileError('文件解密失败', 'file_decrypt_failed', '文件解密失败')
    }
  }
  if (bytes.length > maxBytes) {
    throw new ClawFileError('文件超过上限', 'file_too_large', '文件 ' + name + ' 超过 ' + formatFileSize(maxBytes) + ' 上限')
  }
  const path = saveBytes(join(stateDir, CLAW_INBOUND_FILE_DIR), messageId, bytes, name)
  return { path, name: basename(path), originalName: name, bytes: bytes.length }
}

/** Delete old Claw inbound files; the generic WeChat prune helper already does the policy. */
export function pruneClawInboundFiles(stateDir, options = {}) {
  return pruneInboundImages(join(stateDir, CLAW_INBOUND_FILE_DIR), options)
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
      if (log) log('warn', '[claw outbound] file upload attempt ' + attempt + ' failed: ' + (error && error.message ? error.message : error))
      continue
    }
    if (response.ok) {
      const param = response.headers.get('x-encrypted-param')
      if (param) return param
      lastError = new Error('CDN 没有返回 x-encrypted-param')
      if (log) log('warn', '[claw outbound] file upload returned no x-encrypted-param')
      continue
    }
    if (response.status >= 400 && response.status < 500) {
      let body = ''
      try { body = await response.text() } catch { /* keep empty body */ }
      throw new ClawFileError('文件上传被拒绝', 'file_upload_failed', body || ('HTTP ' + response.status))
    }
    let body = ''
    try { body = await response.text() } catch { /* keep empty body */ }
    lastError = new Error(body || ('HTTP ' + response.status))
    if (log) log('warn', '[claw outbound] file upload attempt ' + attempt + ' got HTTP ' + response.status)
  }
  throw new ClawFileError('文件上传失败', 'file_upload_failed', lastError && lastError.message ? lastError.message : '上传失败')
}

/**
 * Upload one file to the iLink CDN and return the coordinates sendmessage needs.
 */
export async function uploadClawFile({
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
  if (!baseUrl) throw new ClawFileError('微信 Claw 未登录', 'file_upload_failed', '未登录')
  if (!toUserId) throw new ClawFileError('微信 Claw 缺少回复目标', 'file_upload_failed', '缺少回复目标')
  if (!Buffer.isBuffer(buffer) || !buffer.length) {
    throw new ClawFileError('文件为空', 'file_upload_failed', '文件为空')
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
        media_type: 3,
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
    throw new ClawFileError('获取文件上传地址失败', 'file_upload_failed', error && error.message ? error.message : '上传地址失败')
  }
  if (start && typeof start.ret === 'number' && start.ret !== 0) {
    throw new ClawFileError('获取文件上传地址失败', 'file_upload_failed', 'ret=' + start.ret)
  }
  const fullUrl = typeof start.upload_full_url === 'string' ? start.upload_full_url.trim() : ''
  const param = typeof start.upload_param === 'string' ? start.upload_param.trim() : ''
  if (!fullUrl && !param) {
    throw new ClawFileError('获取文件上传地址失败', 'file_upload_failed', '响应没有 upload_full_url/upload_param')
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

/** Build the file_item sendmessage expects from an uploadClawFile result. */
export function clawFileItem(upload, name) {
  return {
    type: 4,
    file_item: {
      media: {
        encrypt_query_param: upload.downloadEncryptedQueryParam,
        aes_key: Buffer.from(upload.aeskey, 'utf8').toString('base64'),
        encrypt_type: 1,
      },
      file_name: name,
      len: String(upload.rawsize),
    },
  }
}
