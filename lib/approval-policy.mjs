// Approval policy for Ria's "strict auto-approval" mode.
//
// The host only exposes the tool name and an optional reason to an approval
// listener; the arguments must be cached from tools/pre-execute first. This
// module turns those arguments into a conservative risk decision. It never
// approves a high-risk request on its own: high risk is relayed to Ria, who
// may only send it to the user or deny it. Hard-denied commands are rejected
// without waking Ria.

import { createHash } from 'node:crypto'
import { isAbsolute, resolve, sep } from 'node:path'

const SECRET_KEY = /(token|secret|password|passwd|pwd|cookie|authorization|api[-_]?key|private[-_]?key|credential|session[-_]?key)/i
const SECRET_TEXT = /\b(token|secret|password|passwd|cookie|authorization|api[-_]?key|private[-_]?key|credential|session[-_]?key)\b\s*[:=]\s*[^\s,;]+/gi
const BEARER = /\bBearer\s+[A-Za-z0-9._~+\/-]+=*/g
const MAX_STRING = 180
const MAX_ARRAY = 20
const MAX_DEPTH = 4
const SENSITIVE_PATH = /(?:^|[^A-Za-z0-9_-])(?:\.env(?:\.[A-Za-z0-9._-]*)?|\.ssh|\.aws|\.gnupg|\.npmrc|\.netrc|\.pypirc|id_rsa|id_ed25519|credentials(?:\.[A-Za-z0-9._-]*)?|secrets?(?:\.[A-Za-z0-9._-]*)?|tokens?(?:\.[A-Za-z0-9._-]*)?)(?=$|[^A-Za-z0-9_-])/i

function canonical(value) {
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(canonical)
  const out = {}
  for (const key of Object.keys(value).sort()) out[key] = canonical(value[key])
  return out
}

export function approvalArgsDigest(args) {
  let text
  try {
    text = JSON.stringify(canonical(args === undefined ? {} : args))
  } catch {
    text = '{}'
  }
  return createHash('sha256').update(text).digest('hex').slice(0, 16)
}

function redactText(text) {
  return String(text)
    .replace(BEARER, 'Bearer [redacted]')
    .replace(SECRET_TEXT, '$1=[redacted]')
}

function sanitize(value, depth, seen) {
  if (value === null || value === undefined) return value
  if (typeof value === 'string') {
    const text = redactText(value)
    return text.length > MAX_STRING ? text.slice(0, MAX_STRING - 1) + '…' : text
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value
  if (typeof value !== 'object') return String(value)
  if (seen.has(value)) return '[circular]'
  if (depth >= MAX_DEPTH) return Array.isArray(value) ? '[array]' : '[object]'
  seen.add(value)
  try {
    if (Array.isArray(value)) {
      const items = value.slice(0, MAX_ARRAY).map(item => sanitize(item, depth + 1, seen))
      if (value.length > MAX_ARRAY) items.push('…+' + (value.length - MAX_ARRAY) + ' more')
      return items
    }
    const out = {}
    for (const [key, item] of Object.entries(value)) {
      if (SECRET_KEY.test(key)) {
        out[key] = '[redacted]'
        continue
      }
      out[key] = sanitize(item, depth + 1, seen)
    }
    return out
  } finally {
    seen.delete(value)
  }
}

export function approvalArgsPreview(args, limit = 400) {
  if (args === undefined || args === null) return '(无参数)'
  let text
  try {
    text = JSON.stringify(sanitize(args, 0, new WeakSet()))
  } catch {
    text = '[unserializable arguments]'
  }
  if (!text || text === '{}') return '(无参数)'
  return text.length > limit ? text.slice(0, Math.max(0, limit - 1)) + '…' : text
}

function sensitivePath(value) {
  return typeof value === 'string' && SENSITIVE_PATH.test(value)
}

function insideWorkspace(path, cwd) {
  if (typeof path !== 'string' || !path) return true
  // A leading ~ is expanded by the shell to the home directory, which is
  // outside the workspace; never treat it as a relative path.
  if (path.startsWith('~')) return false
  if (!cwd) return false
  const target = resolve(cwd, path)
  const root = resolve(cwd)
  return target === root || target.startsWith(root + sep)
}

function absolutePathsIn(command) {
  const found = []
  const tokens = String(command).match(/(?:[^\s"'\x60]+|"[^"]*"|'[^']*')/g) || []
  for (const raw of tokens) {
    const token = raw.replace(/^["']|["']$/g, '').replace(/^[^/\w~.-]+/, '')
    if (!token || token === '/dev/null') continue
    if (token.startsWith('/') || token.startsWith('~/')) found.push(token)
  }
  return found
}

function outsidePaths(command, cwd) {
  return absolutePathsIn(command).filter(path => !insideWorkspace(path, cwd))
}

function hardDenyReason(command) {
  const text = String(command || '')
  if (!text) return ''
  if (/(^|[;&|]\s*)(sudo|doas)\b/.test(text)) return 'sudo/doas'
  if (/(^|[;&|]\s*)rm\s+(-[a-zA-Z]*[rf][a-zA-Z]*\s+)+\/(?:\s|$)/.test(text)) return 'rm -rf /'
  if (/(^|[;&|]\s*)rm\s+(-[a-zA-Z]*[rf][a-zA-Z]*\s+)+~\/?\s*(?:$|[;&|])/.test(text)) return 'rm -rf ~'
  if (/(^|[;&|]\s*)(mkfs(?:\.[a-z0-9]+)?|dd\s+if=|shutdown|reboot|halt|poweroff)\b/.test(text)) return '磁盘/关机'
  if (/(^|[;&|]\s*)chmod\s+(-[a-zA-Z]+\s+)*777\s+\/(?:\s|$)/.test(text)) return 'chmod 777 /'
  if (/:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/.test(text)) return 'fork bomb'
  if (/(^|[;&|]\s*)dsh-daemon\s+(stop|uninstall|restart)\b/.test(text)) return '停止/重装 dsh-daemon'
  if (/(?:^|[\s"'\x60])(?:~|\$HOME|\/home\/[^/\s]+)\/\.ssh(?:\/|\s|$)/.test(text)) return '访问 ~/.ssh'
  if (/(?:^|[\s"'\x60])(?:~|\$HOME|\/home\/[^/\s]+)\/\.dsh\/(?:state|profiles)(?:\/|\s|$)/.test(text)) return '访问 ~/.dsh 核心状态'
  if (/(?:^|[\s"'\x60])state\/ria\/ria\.json(?:\s|$)/.test(text)) return '改 Ria 状态文件'
  if (/(^|[;&|]\s*)git\s+push\s+[^\n]*--force/.test(text)) return 'git push --force'
  return ''
}

function splitSegments(command) {
  return String(command || '')
    .split(/&&|\|\||;|\n|\|/)
    .map(item => item.trim())
    .filter(Boolean)
}

function commandRisk(tokens, cwd) {
  const name = tokens[0]
  if (!name) return { risk: 'low', reasons: [] }
  const rest = tokens.slice(1)
  if (sensitivePath(tokens.join(' '))) return { risk: 'high', reasons: ['敏感文件/凭据路径'] }
  const absoluteOutside = outsidePaths(tokens.join(' '), cwd)
  if (absoluteOutside.length) return { risk: 'high', reasons: ['工作区外路径：' + absoluteOutside[0]] }
  if (name === 'cd') {
    const target = rest[0] || ''
    if (!target || target === '.' || target === './') return { risk: 'low', reasons: [] }
    return insideWorkspace(target, cwd)
      ? { risk: 'low', reasons: [] }
      : { risk: 'high', reasons: ['cd 到工作区外'] }
  }
  if (['ls', 'pwd', 'cat', 'head', 'tail', 'wc', 'stat', 'file', 'du', 'df', 'date', 'uname', 'whoami', 'id', 'which', 'type', 'echo', 'printf', 'true', 'false', 'test', 'grep', 'rg'].includes(name)) {
    return { risk: 'low', reasons: ['只读命令 ' + name] }
  }
  if (name === 'find') {
    if (rest.some(item => ['-delete', '-exec', '-execdir', '-ok', '-okdir'].includes(item))) return { risk: 'high', reasons: ['find 删除/执行'] }
    return { risk: 'low', reasons: ['只读 find'] }
  }
  if (name === 'sed') {
    if (rest.some(item => item === '-i' || item.startsWith('-i') || item === '--in-place' || item.startsWith('--in-place='))) return { risk: 'high', reasons: ['sed 原地改写'] }
    return { risk: 'low', reasons: ['只读 sed'] }
  }
  if (name === 'git') {
    const sub = rest[0] || ''
    if (['status', 'diff', 'log', 'show', 'rev-parse', 'ls-files', 'blame'].includes(sub)) return { risk: 'low', reasons: ['只读 git ' + sub] }
    if (['push', 'pull', 'fetch', 'clone', 'submodule'].includes(sub)) return { risk: 'high', reasons: ['网络 git ' + sub] }
    if (['reset', 'clean', 'checkout', 'switch', 'restore', 'stash', 'rebase', 'merge'].includes(sub)) return { risk: 'high', reasons: ['改写 git 状态 ' + sub] }
    if (sub === 'config' || sub === 'branch' || sub === 'remote') {
      const writes = rest.slice(1)
      const globalConfig = sub === 'config' && writes.some(item => item === '--global' || item === '--system')
      const mutating = writes.some(item => ['--global', '--system', '--add', '--unset', '--unset-all', '--replace-all', '-d', '-D', '-m', '-M', 'add', 'remove', 'set-url', 'rename'].includes(item))
      if (globalConfig || mutating) return { risk: 'high', reasons: ['改写 git ' + sub] }
      return { risk: 'medium', reasons: ['git ' + sub + '（可能读写）'] }
    }
    return { risk: 'medium', reasons: ['git ' + (sub || '命令')] }
  }
  if (['npm', 'pnpm', 'yarn'].includes(name)) {
    const sub = rest[0] || ''
    if (sub === 'test' || sub === 't' || sub === 'lint' || sub === 'build' || sub === 'check' || sub === '--version' || sub === '--help') return { risk: 'low', reasons: ['构建/测试 ' + name + ' ' + sub] }
    if (sub === 'run' || sub === 'run-script') {
      const script = rest[1] || ''
      if (/^(test|lint|build|check|typecheck|coverage)(?::|$)/.test(script)) return { risk: 'low', reasons: ['构建/测试 ' + name + ' run ' + script] }
      return { risk: 'medium', reasons: [name + ' run ' + (script || '脚本')] }
    }
    if (['install', 'i', 'add', 'remove', 'uninstall', 'publish', 'exec', 'dlx', 'link'].includes(sub)) return { risk: 'high', reasons: ['安装/发布/执行依赖 ' + name + ' ' + sub] }
    return { risk: 'medium', reasons: [name + ' ' + (sub || '命令')] }
  }
  if (['npx', 'pnpx'].includes(name)) return { risk: 'high', reasons: ['临时执行包 ' + name] }
  if (name === 'node') {
    if (rest.includes('--check') || rest.includes('--test') || rest.includes('--test-only')) return { risk: 'low', reasons: ['Node 检查/测试'] }
    if (rest.some(item => item === '-e' || item === '--eval' || item === '-p' || item === '--print')) return { risk: 'high', reasons: ['Node 内联执行代码'] }
    return { risk: 'medium', reasons: ['Node 脚本'] }
  }
  if (name === 'python' || name === 'python3') {
    if (rest[0] === '-m' && ['pytest', 'unittest'].includes(rest[1])) return { risk: 'low', reasons: ['Python 测试'] }
    if (rest.some(item => item === '-c')) return { risk: 'high', reasons: ['Python 内联执行代码'] }
    return { risk: 'medium', reasons: ['Python 脚本'] }
  }
  if (name === 'pytest') return { risk: 'low', reasons: ['pytest'] }
  if (name === 'cargo') {
    if (['test', 'check', 'build'].includes(rest[0])) return { risk: 'low', reasons: ['cargo ' + rest[0]] }
    if (['install', 'publish'].includes(rest[0])) return { risk: 'high', reasons: ['cargo ' + rest[0]] }
    return { risk: 'medium', reasons: ['cargo ' + (rest[0] || '命令')] }
  }
  if (name === 'go') {
    if (['test', 'build', 'vet'].includes(rest[0])) return { risk: 'low', reasons: ['go ' + rest[0]] }
    return { risk: 'medium', reasons: ['go ' + (rest[0] || '命令')] }
  }
  if (name === 'make') {
    if (['test', 'lint', 'check'].includes(rest[0])) return { risk: 'low', reasons: ['make ' + rest[0]] }
    return { risk: 'medium', reasons: ['make'] }
  }
  if (name === 'rm' || name === 'mv' || name === 'truncate' || name === 'dd' || name === 'tee' || name === 'shred') {
    return { risk: 'high', reasons: ['删除/覆盖 ' + name] }
  }
  if (['cp', 'mkdir', 'touch', 'ln', 'chmod', 'chown', 'install'].includes(name)) {
    return { risk: 'medium', reasons: ['写文件系统 ' + name] }
  }
  if (['curl', 'wget', 'nc', 'ncat', 'ssh', 'scp', 'sftp', 'rsync', 'telnet'].includes(name)) {
    return { risk: 'high', reasons: ['网络访问 ' + name] }
  }
  if (['docker', 'podman', 'systemctl', 'service', 'mount', 'umount', 'iptables', 'nft'].includes(name)) {
    return { risk: 'high', reasons: ['系统操作 ' + name] }
  }
  if (name === 'dsh-daemon') return { risk: rest[0] === 'status' ? 'medium' : 'high', reasons: ['dsh-daemon ' + (rest[0] || '命令')] }
  if (['kill', 'pkill', 'killall'].includes(name)) return { risk: 'high', reasons: ['结束进程 ' + name] }
  return { risk: 'medium', reasons: ['未识别的命令 ' + name] }
}

function mergeRisk(current, next) {
  const order = { low: 0, medium: 1, high: 2, deny: 3 }
  return order[next] > order[current] ? next : current
}

export function classifyApproval({ toolName = '', args = {}, cwd = '' } = {}) {
  const name = String(toolName || '')
  const reasons = []
  let risk = 'low'

  if (name === 'bash') {
    const command = args && typeof args.command === 'string' ? args.command : ''
    const denied = hardDenyReason(command)
    if (denied) return { risk: 'deny', auto: 'deny', allowable: false, reasons: ['硬拒绝：' + denied], summary: '硬拒绝：' + denied }
    if (/[\x60]|\$\(/.test(command)) {
      risk = 'high'
      reasons.push('命令替换/反引号')
    }
    if (/[<>]/.test(command)) {
      risk = 'high'
      reasons.push('重定向写入')
    }
    if (/(^|[^\\])(?:\$|~[\/\s]|~$)/.test(command)) {
      risk = 'high'
      reasons.push('shell 变量或 ~ 展开')
    }
    // A relative path with .. can leave the workspace even though it does not
    // look absolute; treat it as high risk instead of silently allowing it.
    if (/(^|\s)\.\.(\/|\s|$)/.test(command)) {
      risk = 'high'
      reasons.push('上级目录路径')
    }
    for (const segment of splitSegments(command)) {
      const tokens = segment.match(/(?:[^\s"'\x60]+|"[^"]*"|'[^']*')/g) || []
      const verdict = commandRisk(tokens, cwd)
      risk = mergeRisk(risk, verdict.risk)
      if (verdict.reasons.length) reasons.push(...verdict.reasons.slice(0, 1))
    }
    if (!command.trim()) {
      risk = 'medium'
      reasons.push('空命令')
    }
  } else if (['read', 'glob', 'grep', 'ls', 'list', 'stat'].includes(name)) {
    const paths = [args && args.path, args && args.file, args && args.filePath, args && args.file_path].filter(item => typeof item === 'string')
    const outside = paths.filter(path => !insideWorkspace(path, cwd))
    if (outside.length) {
      risk = 'high'
      reasons.push('只读工具访问工作区外路径')
    } else if (paths.some(sensitivePath)) {
      risk = 'high'
      reasons.push('读取敏感文件/凭据')
    } else {
      risk = 'low'
      reasons.push('只读工具 ' + name)
    }
  } else if (['write', 'edit', 'apply_patch', 'patch'].includes(name)) {
    const paths = [args && args.path, args && args.file, args && args.filePath, args && args.file_path].filter(item => typeof item === 'string')
    if (paths.some(path => !insideWorkspace(path, cwd))) {
      risk = 'high'
      reasons.push('写工作区外路径')
    } else if (paths.some(sensitivePath)) {
      risk = 'high'
      reasons.push('写入敏感文件/凭据')
    } else {
      risk = 'medium'
      reasons.push('工作区内写文件')
    }
  } else if (name === 'web_fetch' || name === 'web_search') {
    risk = 'high'
    reasons.push('网络访问')
  } else if (name === 'run_code') {
    const code = args && typeof args.code === 'string' ? args.code : ''
    const outside = outsidePaths(code, cwd)
    if (outside.length || sensitivePath(code) || /\bfetch\s*\(|https?:\/\/|child_process|node:fs|fs\/promises|from ['"]fs['"]|require\(['"]fs['"]\)|\b(?:rmSync|unlinkSync|rmdirSync|writeFileSync|appendFileSync|renameSync|truncateSync|chmodSync|chownSync)\b|\b(?:writeFile|appendFile|unlink|rm|rmdir|rename|truncate|chmod|chown)\s*\(/.test(code)) {
      risk = 'high'
      reasons.push('run_code 含网络/删除/写盘或工作区外路径')
    } else {
      risk = 'medium'
      reasons.push('run_code 未识别的代码')
    }
  } else if (name === 'bash' || name === '') {
    risk = 'medium'
    reasons.push('未知工具')
  } else {
    risk = 'medium'
    reasons.push('未分类工具 ' + name)
  }

  if (risk === 'deny') return { risk, auto: 'deny', allowable: false, reasons, summary: reasons.join('；') }
  // Low risk may be approved by the host rule itself. Medium and high are
  // relayed to Ria; only high is non-allowable there (the tool refuses allow).
  return {
    risk,
    auto: risk === 'low' ? 'allow' : 'relay',
    allowable: risk !== 'high',
    reasons: [...new Set(reasons)].slice(0, 5),
    summary: [...new Set(reasons)].slice(0, 5).join('；'),
  }
}

function clip(text, limit) {
  const value = String(text === undefined || text === null ? '' : text)
  return value.length > limit ? value.slice(0, Math.max(0, limit - 1)) + '…' : value
}

export function approvalPrompt(record, ticket, classification) {
  const item = ticket || {}
  return [
    '【审批请求 ' + record.approvalId + '】',
    '工单：' + String(item.ticketId || record.ticketId) + ' · ' + clip(item.goal || '未记录目标', 300),
    '验收：' + clip(item.acceptance || '未记录验收', 300),
    '执行者：' + record.workerSessionId,
    '工具：' + record.toolName,
    '风险：' + (record.risk || classification.risk) + ' · ' + (classification.summary || '未分类'),
    '参数摘要：' + (record.argsPreview || '(无参数)'),
    '原因：' + (record.reason || '未说明'),
    '剩余：' + Math.max(0, Math.round((record.expiresAt - Date.now()) / 1000)) + ' 秒',
    '',
    '请调用 ria_approval_decision：approvalId="' + record.approvalId + '"，decision=allow|deny|ask-user。',
    classification.risk === 'high'
      ? '这是高风险请求：只能 ask-user 或 deny，allow 会被工具拒绝。'
      : '只有低风险可以直接 allow；不确定就 ask-user 或 deny。',
    '2 分钟内不决定会按拒绝处理并通知用户。不要用它放宽 sandbox 或 approval policy。',
  ].join('\n')
}

export function approvalDecisionQuestion(record, { decision, reason } = {}) {
  const head = '「' + record.workerSessionId + '」的审批（' + record.toolName + '）'
  const why = reason ? '：' + clip(reason, 160) : ''
  if (decision === 'allow') return head + '已由 Ria 放行' + why + '。'
  if (decision === 'deny') return head + '已拒绝' + why + '。'
  if (decision === 'ask-user') return head + '已转给你决定。请打开该会话允许或拒绝。' + why
  if (decision === 'timeout') return head + '在 2 分钟内没有决定，已按拒绝处理' + why + '。'
  if (decision === 'abort' || decision === 'cancel') return head + '已取消' + why + '。'
  return head + '已处理' + why + '。'
}
