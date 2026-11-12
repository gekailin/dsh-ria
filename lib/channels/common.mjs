// Shared helpers for the Ria chat channels.
//
// A channel is a chat transport that turns inbound chat messages into
// ordinary user messages for Ria and mirrors Ria's replies back to the
// chat. State and credentials stay under DSH_HOME/state/ria/<channel>/.

import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from 'node:fs'
import { dirname } from 'node:path'
import QRCode from 'qrcode'

export function ensureDir(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
}

export function writeAtomic(file, text) {
  ensureDir(dirname(file))
  const temp = file + '.' + process.pid + '.' + Date.now() + '.tmp'
  const fd = openSync(temp, 'w', 0o600)
  try {
    writeSync(fd, text)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameSync(temp, file)
}

export function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    if (error && error.code === 'ENOENT') return null
    throw error
  }
}

export function removeFile(file) {
  try {
    rmSync(file, { force: true })
  } catch {
    /* already gone */
  }
}

export function errorText(error) {
  if (!error) return '未知错误'
  const message = String(error.message ? error.message : error)
  const cause = error.cause
  if (!cause) return message
  const detail = String(cause.message || cause.code || '')
  if (!detail || message.includes(detail)) return message
  return message + ': ' + detail
}

export function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) {
      reject(signal.reason || new Error('aborted'))
      return
    }
    const timer = setTimeout(() => {
      cleanup()
      resolve()
    }, ms)
    function cleanup() {
      clearTimeout(timer)
      if (signal) signal.removeEventListener('abort', onAbort)
    }
    function onAbort() {
      cleanup()
      reject(signal.reason || new Error('aborted'))
    }
    if (signal) signal.addEventListener('abort', onAbort, { once: true })
  })
}

// Render a login URL as a PNG data URL. The QR is shown by the settings UI,
// so it never has to touch disk.
export async function qrDataUrl(text) {
  if (typeof text !== 'string' || !text.trim()) throw new Error('二维码内容为空')
  const buffer = await QRCode.toBuffer(text.trim(), {
    type: 'png',
    width: 320,
    margin: 1,
    errorCorrectionLevel: 'M',
  })
  return 'data:image/png;base64,' + buffer.toString('base64')
}

// requestJson performs one HTTP request and parses a JSON response. Timeouts
// are composed with the channel abort signal so shutdown never waits for a
// long poll.
export async function requestJson(url, options = {}) {
  const { method = 'GET', headers = {}, body, signal, timeoutMs = 20000 } = options
  const signals = []
  if (signal) signals.push(signal)
  if (timeoutMs > 0) signals.push(AbortSignal.timeout(timeoutMs))
  const composed = signals.length === 0 ? undefined : signals.length === 1 ? signals[0] : AbortSignal.any(signals)
  const response = await fetch(url, {
    method,
    headers,
    body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
    signal: composed,
  })
  const text = await response.text()
  let json
  try {
    json = text ? JSON.parse(text) : {}
  } catch {
    throw new Error('HTTP ' + response.status + ' 返回了非 JSON 内容')
  }
  if (!response.ok) {
    const detail = json && (json.message || json.msg || json.error)
    throw new Error('HTTP ' + response.status + (detail ? ': ' + detail : ''))
  }
  return json
}

export function userFacingError(error) {
  if (!error) return '未知错误'
  if (error.name === 'TimeoutError') return '请求超时'
  if (error.name === 'AbortError') return '已取消'
  return errorText(error)
}
