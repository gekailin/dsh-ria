// Risk classification for one escalation request.
//
// Pure functions: no IO, no timers, no host services. The controller feeds the
// tool name, cached tool arguments, worker cwd/workspace and the ticket, then
// turns the returned level + reasons into an approval decision. Every rule has
// a stable id so audit lines and tests can explain a decision after the fact.

import { basename, isAbsolute, normalize, relative, resolve, sep } from 'node:path'

export const ESCALATION_POLICIES = ['strict', 'auto-low', 'auto-low-medium']
export const DEFAULT_ESCALATION_POLICY = 'auto-low'

const LEVEL_RANK = { low: 0, medium: 1, high: 2, unknown: 3 }

const READ_ONLY_COMMANDS = new Set([
  'ls', 'cat', 'head', 'tail', 'grep', 'rg', 'wc', 'stat', 'file', 'jq',
  'pwd', 'echo', 'printf', 'true', 'false', 'which', 'type', 'tree', 'du',
  'df', 'diff', 'cut', 'sort', 'uniq', 'awk', 'basename', 'dirname', 'realpath',
  'readlink', 'date', 'id', 'whoami', 'uname', 'ps', 'free', 'uptime', 'lsblk',
])

const PRIVILEGED_COMMANDS = new Set([
  'sudo', 'doas', 'su', 'chmod', 'chown', 'chgrp', 'dd', 'mount', 'umount',
  'systemctl', 'service', 'launchctl', 'dsh-daemon', 'kill', 'pkill', 'killall',
  'reboot', 'shutdown', 'poweroff', 'mkfs', 'fdisk', 'iptables', 'ufw', 'sysctl',
])

const DESTRUCTIVE_COMMANDS = new Set(['rm', 'rmdir', 'unlink', 'shred'])
const NETWORK_COMMANDS = new Set(['curl', 'wget', 'nc', 'netcat', 'ssh', 'scp', 'rsync', 'ftp', 'telnet'])
const PACKAGE_MANAGERS = new Set(['npm', 'pnpm', 'yarn', 'bun'])
const TEST_COMMANDS = new Set(['pytest', 'jest', 'vitest', 'mocha', 'phpunit'])

const SENSITIVE_PATH = /(^|\/)(\.env(\.[^/]*)?|\.credentials|\.ssh\/|id_rsa|id_ed25519|\.aws\/|\.config\/gcloud|credentials\.json)(\/|$)/i
const SOURCE_PATH = /(^|\/)(lib|src|test|tests|docs|packages|apps|scripts)\//i
const CONFIG_FILE = /(^|\/)(package\.json|package-lock\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|tsconfig[^/]*\.json|eslint[^/]*|prettier[^/]*|vite\.config\.[cm]?[jt]s|vitest\.config\.[cm]?[jt]s|cordis\.patch\.yml|README\.md|\.github\/)/i
const ARTIFACT_PATH = /(^|\/)(ria-runs|runs|dist|build|coverage|\.tmp|tmp|node_modules)\//i
const ARTIFACT_FILE = /\.(log|tmp|out|pid|lock|swp)$/i
const SOURCE_FILE = /\.(mjs|cjs|js|jsx|ts|tsx|json|md|ya?ml|toml|css|scss|html|vue|svelte)$/i

export function normalizeEscalationPolicy(value) {
  const policy = typeof value === 'string' ? value.trim().toLowerCase() : ''
  return ESCALATION_POLICIES.includes(policy) ? policy : null
}

/** Priority: ticket meta > global settings > built-in default. */
export function resolveEscalationPolicy({ ticket, settings } = {}) {
  const ticketValue = ticket && (ticket.escalationPolicy || (ticket.meta && ticket.meta.escalationPolicy))
  const fromTicket = normalizeEscalationPolicy(ticketValue)
  if (fromTicket) return { policy: fromTicket, source: 'ticket' }
  const fromSettings = normalizeEscalationPolicy(settings && settings.escalationPolicy)
  if (fromSettings) return { policy: fromSettings, source: fromSettings === DEFAULT_ESCALATION_POLICY ? 'default' : 'global' }
  return { policy: DEFAULT_ESCALATION_POLICY, source: 'default' }
}

/** High and unknown are never auto-allowed, whatever the policy says. */
export function decideEscalation(level, policy) {
  const effective = normalizeEscalationPolicy(policy) || DEFAULT_ESCALATION_POLICY
  if (level === 'low') return effective === 'strict' ? 'ask' : 'auto-allow'
  if (level === 'medium') return effective === 'auto-low-medium' ? 'auto-allow' : 'ask'
  return 'ask'
}

/** Merge conservatively: low's rank is zero, and invalid/missing levels are unknown. */
export function mergeRiskLevels(levels) {
  if (!Array.isArray(levels) || levels.length === 0) return 'unknown'
  let highest = 'low'
  for (const value of levels) {
    const level = typeof value === 'string' && Object.hasOwn(LEVEL_RANK, value) ? value : 'unknown'
    if (LEVEL_RANK[level] > LEVEL_RANK[highest]) highest = level
  }
  return highest
}

function levelOf(hits) {
  return mergeRiskLevels(hits.map(hit => hit.level))
}

function absolutePath(value, cwd, workspace) {
  const raw = String(value == null ? '' : value).trim()
  if (!raw) return ''
  if (raw.startsWith('~/')) return ''
  if (isAbsolute(raw)) return normalize(raw)
  const base = cwd || workspace
  if (!base) return ''
  return resolve(base, raw)
}

function inside(workspace, target) {
  if (!workspace || !target) return false
  const root = resolve(workspace)
  const value = resolve(target)
  return value === root || value.startsWith(root.endsWith(sep) ? root : root + sep)
}

function relativePath(workspace, target) {
  if (!workspace || !target) return ''
  return relative(resolve(workspace), resolve(target)).split(sep).join('/')
}

function hasShellMeta(value) {
  return /[|;&\n]|\|\||&&|\$\(|\$\{|\x60|\$[A-Za-z_]/.test(value)
}

/** Simple single trailing output redirection: "cmd > path" / "cmd >> path". */
function splitRedirection(command) {
  const match = /(^|[^<>])(>>?)\s*([^\s<>]+)\s*$/.exec(command)
  if (!match) return { command, target: '', bad: /[<>]/.test(command) }
  const index = command.lastIndexOf(match[2])
  const head = command.slice(0, index).trim()
  if (/[<>|]/.test(head)) return { command, target: '', bad: true }
  const target = tokenize(match[3])
  if (!target || target.length !== 1) return { command, target: '', bad: true }
  return { command: head, target: target[0] }
}

function tokenize(command) {
  const tokens = []
  let current = ''
  let quote = null
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]
    if (quote) {
      if (char === '\\' && quote !== "'") return null
      if (char === quote) quote = null
      else current += char
      continue
    }
    if (char === '\\') return null
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current)
        current = ''
      }
      continue
    }
    current += char
  }
  if (quote) return null
  if (current) tokens.push(current)
  return tokens
}

function commandName(argv) {
  return basename(String(argv[0] || '')).toLowerCase()
}

function nonFlagTokens(argv, start = 1) {
  return argv.slice(start).filter(token => token && !token.startsWith('-'))
}

function isGitReadOnly(argv) {
  if (commandName(argv) !== 'git') return false
  const sub = String(argv[1] || '').toLowerCase()
  if (['status', 'diff', 'log', 'show', 'rev-parse', 'ls-files', 'blame', 'grep', 'describe'].includes(sub)) return true
  if (sub === 'remote') return ['', '-v', '--verbose', 'get-url'].includes(String(argv[2] || ''))
  if (sub === 'branch') return argv.length === 2 || argv.includes('--list') || argv.includes('-a') || argv.includes('-r')
  return false
}

function inspectCredentialPath(paths) {
  return paths.some(item => SENSITIVE_PATH.test(String(item || '').split(sep).join('/')))
}

function pathRuleHits(paths, { workspace, cwd }, hit) {
  for (const path of paths) {
    if (!path) {
      hit('unknown', 'path-missing', '路径为空，无法判定写入目标')
      continue
    }
    if (hasShellMeta(path) || path.startsWith('~/')) {
      hit('unknown', 'path-unparsed', '路径含变量或未展开的 ~，无法静态判定')
      continue
    }
    const target = absolutePath(path, cwd, workspace)
    if (!target) {
      hit('unknown', 'path-unparsed', '相对路径缺少 cwd/workspace，无法判定目标')
      continue
    }
    if (!isAbsolute(path) && path.split(/[\\/]/).includes('..') && !inside(workspace, target)) {
      hit('unknown', 'path-escape', '相对路径含 .. 且逃出工作区，无法判定目标')
      continue
    }
    if (inspectCredentialPath([target])) {
      hit('high', 'credentials-path', '访问凭据/密钥文件：' + target)
      continue
    }
    if (!workspace) {
      hit('unknown', 'workspace-missing', '没有工作区，无法判断路径是否越界')
      continue
    }
    if (!inside(workspace, target)) {
      if (/[\\/]\.dsh([\\/]|$)/.test(target)) hit('medium', 'config-write', '修改 ~/.dsh 配置：' + target)
      else hit('high', 'write-outside-workspace', '写入工作区外路径：' + target)
      continue
    }
    const rel = relativePath(workspace, target)
    if (ARTIFACT_PATH.test(rel) || ARTIFACT_FILE.test(rel)) hit('low', 'write-artifact', '写入工作区内产物/临时文件：' + rel)
    else if (SOURCE_PATH.test(rel) || CONFIG_FILE.test(rel) || SOURCE_FILE.test(rel)) hit('medium', 'write-tracked-source', '写入工作区内源码/配置文件：' + rel)
    else hit('low', 'write-workspace-file', '写入工作区内非关键文件：' + rel)
  }
}

/** Only literal, single commands reach the allow-list; wrappers/side effects ask. */
function dangerousCommandHits(argv, hit) {
  const first = commandName(argv)
  const sub = String(argv[1] || '').toLowerCase()
  if (argv.some(token => /^--(?:force(?:[-=]|$)|hard$|delete(?:=|$)|remove(?:=|$)|exec(?:=|$))/.test(token))) {
    hit('high', 'dangerous-argument', '命令包含强制/删除/执行参数')
  }
  if (['xargs', 'eval', 'exec', 'command', 'nohup', 'timeout', 'busybox'].includes(first)) {
    hit('unknown', 'command-wrapper', '间接执行命令（' + first + '），无法完整判定参数与目标')
  }
  if (first === 'git') {
    if ((sub === 'checkout' && (argv.includes('--') || argv.includes('-f'))) || sub === 'restore') {
      hit('high', 'destructive-git', '覆盖工作区文件：git ' + sub)
    }
    if (sub === 'branch' && argv.some(token => /^-[dDmMcCf]/.test(token) || /^--(?:delete|move|copy)/.test(token))) {
      hit('high', 'destructive-git', '删除/覆盖 Git 分支')
    }
    if (sub === 'remote' && !['', '-v', '--verbose', 'get-url'].includes(String(argv[2] || ''))) {
      hit('medium', 'git-write', '修改/更新 Git remote：' + String(argv[2] || ''))
    }
    if (argv.some(token => token === '--ext-diff' || token === '--textconv' || token === '--exec-path' || token.startsWith('--exec-path='))) {
      hit('high', 'dangerous-argument', 'Git 参数可调用外部执行器')
    }
  }
  if (first === 'sed' && argv.some(token => /^-i/.test(token) || /^--in-place(?:=|$)/.test(token))) {
    hit('high', 'in-place-write', 'sed 原地覆盖文件')
  }
  if (first === 'sed' && argv.some(token => /(?:^|[;\s])(?:e|w|W)(?:\s|$)|[\/]e(?:\s|$)/.test(token))) {
    hit('unknown', 'script-side-effect', 'sed 脚本包含执行/写入动作，无法完整判定')
  }
  if (first === 'awk' && argv.some(token => /\b(system|getline)\b|[>|]/.test(token))) {
    hit('unknown', 'script-side-effect', 'awk 脚本可能执行命令或写入文件')
  }
  if (first === 'jq' && argv.some(token => token === '-L' || token.startsWith('-L') || /^--(?:argfile|rawfile|slurpfile)/.test(token))) {
    hit('unknown', 'script-side-effect', 'jq 参数会间接读取文件，目标未完整解析')
  }
  if (['grep', 'rg'].includes(first) && argv.some(token => token === '--pre' || token.startsWith('--pre='))) {
    hit('high', 'dangerous-argument', '搜索命令调用预处理执行器')
  }
  if (first === 'node' && argv.some(token => /^-(?:e|p|r)$|^--(?:eval|print|require|import)(?:=|$)/.test(token))) {
    hit('unknown', 'dynamic-script', 'Node 内嵌代码/预加载不能套用只读或测试白名单')
  }
  if (READ_ONLY_COMMANDS.has(first) && argv.some(token => /^--(?:output|write)(?:=|$)/.test(token) || (['sort', 'diff'].includes(first) && /^-o/.test(token)))) {
    hit('high', 'output-argument', '只读命令包含文件输出参数')
  }
  if (first === 'uniq' && nonFlagTokens(argv).length > 1) hit('high', 'output-argument', 'uniq 带输出文件参数')
  const paths = nonFlagTokens(argv).map(path => path.split('=').pop())
  if (inspectCredentialPath(paths)) hit('high', 'credentials-path', '命令参数访问凭据/密钥路径')
}

function classifyCommand(argv, workspace, cwd, hit, signals) {
  const first = commandName(argv)
  const sub = String(argv[1] || '').toLowerCase()
  signals.argv = argv.slice()
  dangerousCommandHits(argv, hit)

  if (first === 'dsh' && sub === 'plugin') {
    let action = ''
    let profile = ''
    for (let index = 2; index < argv.length; index += 1) {
      const token = String(argv[index] || '')
      if (token === '--profile') {
        profile = String(argv[index + 1] || '')
        index += 1
      } else if (token.startsWith('--profile=')) {
        profile = token.slice('--profile='.length)
      } else if (!action && !token.startsWith('-') && !token.startsWith('file:') && !token.includes('/')) {
        action = token.toLowerCase()
      }
    }
    const fileTarget = argv.find(token => String(token).startsWith('file:')) || ''
    const profileTarget = argv.find(token => String(token).includes('.dsh/profiles')) || ''
    const target = profile || fileTarget || profileTarget || '(未命名 profile)'
    if (['add', 'update', 'remove', 'install'].includes(action)) {
      hit('medium', 'plugin-install', '向 profile 安装/更新插件：dsh plugin ' + action + ' ' + target)
    } else {
      hit('unknown', 'plugin-install-unknown', 'dsh plugin 子命令无法识别：' + String(argv.slice(2).join(' ')).slice(0, 120))
    }
  }
  if (first === 'env' || first === 'printenv') {
    hit('high', 'credentials-env', '读取环境变量，可能包含凭据')
  }
  if (PRIVILEGED_COMMANDS.has(first)) {
    hit('high', 'privileged-command', '使用高权限/系统命令：' + first)
  }
  if (first === 'sudo' || first === 'doas' || first === 'su') {
    hit('high', 'privileged-escalation', '通过 ' + first + ' 提权执行命令')
  }
  if (DESTRUCTIVE_COMMANDS.has(first)) {
    hit('high', 'destructive-command', '删除类命令：' + first)
  }
  if (first === 'find' && argv.some(token => token === '-delete' || token === '-exec' || token === '-execdir')) {
    hit('high', 'destructive-command', 'find 带删除/执行动作')
  }
  if (first === 'git' && (sub === 'push' || sub === 'clean' || (sub === 'reset' && argv.includes('--hard')))) {
    hit('high', 'destructive-command', '破坏性或远端 Git 操作：git ' + sub)
  }
  if (NETWORK_COMMANDS.has(first) || (first === 'git' && sub === 'push')) {
    hit('high', 'network-egress', '网络出口命令：' + first)
  }
  if (PACKAGE_MANAGERS.has(first) && ['install', 'add', 'ci', 'i'].includes(sub)) {
    if (argv.includes('-g') || argv.includes('--global')) hit('high', 'system-install', '全局安装依赖到系统')
    else hit('medium', 'install-deps', '安装项目依赖')
  }
  if (first === 'pip' || first === 'pip3') {
    if (sub === 'install') {
      if (argv.includes('--system') || argv.includes('--break-system-packages')) hit('high', 'system-install', '系统级 Python 依赖安装')
      else hit('medium', 'install-deps', '安装 Python 依赖')
    }
  }
  if (first === 'npm' && sub === 'publish') hit('high', 'network-egress', '发布到 npm registry')

  if (first === 'git') {
    if (isGitReadOnly(argv)) hit('low', 'read-only-git', '只读 Git 命令：git ' + sub)
    else if (['add', 'commit', 'stash', 'merge', 'rebase', 'cherry-pick', 'switch', 'checkout', 'restore', 'tag'].includes(sub)) {
      hit('medium', 'git-write', '修改 Git 状态：git ' + sub)
    }
  }

  if (PACKAGE_MANAGERS.has(first)) {
    if (sub === 'test') hit('low', 'run-tests', '运行测试：' + first + ' test')
    else if (sub === 'run' && String(argv[2] || '').includes('test')) hit('low', 'run-tests', '运行测试脚本：' + argv.slice(1).join(' '))
    else if (sub && !['install', 'add', 'ci', 'i', 'publish'].includes(sub)) hit('medium', 'package-script', '执行包脚本：' + first + ' ' + sub)
  }
  if (TEST_COMMANDS.has(first)) hit('low', 'run-tests', '运行测试：' + first)
  if (first === 'go' && sub === 'test') hit('low', 'run-tests', '运行测试：go test')
  if (first === 'cargo' && sub === 'test') hit('low', 'run-tests', '运行测试：cargo test')
  if (first === 'node') {
    if (argv.includes('--check')) hit('low', 'read-only-cmd', 'Node 语法检查')
    else if (nonFlagTokens(argv).some(token => token.includes('test/'))) hit('low', 'run-tests', '运行 node 测试')
    else hit('medium', 'run-script', '执行 Node 脚本：' + argv.slice(1).join(' '))
  }
  if (READ_ONLY_COMMANDS.has(first)) hit('low', 'read-only-cmd', '只读命令：' + first)
  if (first === 'sed' && !argv.some(token => /^-i|^--in-place(?:=|$)/.test(token))) hit('low', 'read-only-cmd', '只读 sed')

  const writeTargets = []
  if (['cp', 'mv', 'ln', 'install'].includes(first)) {
    const args = nonFlagTokens(argv)
    if (args.length >= 2) writeTargets.push(args[args.length - 1])
  } else if (['touch', 'mkdir', 'tee', 'truncate'].includes(first)) {
    writeTargets.push(...nonFlagTokens(argv))
  } else if (first === 'sed' && argv.some(token => /^-i|^--in-place(?:=|$)/.test(token))) {
    writeTargets.push(...nonFlagTokens(argv).slice(1))
  }
  if (writeTargets.length) pathRuleHits(writeTargets, { workspace, cwd }, hit)

  if (first === 'git' && sub === 'commit' && argv.includes('--amend')) hit('medium', 'git-write', '修正已有提交')
}

export const PTC_TRANSPORTS = new Set(['run_code'])
const BACKTICK = String.fromCharCode(96)
const INTERPOLATION = '$' + '{'

function skipSpace(source, index) {
  let at = index
  while (at < source.length && /\s/.test(source[at])) at += 1
  return at
}

/** Read one quoted string literal. Backtick templates with interpolation are dynamic. */
function readLiteral(source, index) {
  const quote = source[index]
  if (quote !== "'" && quote !== '"' && quote !== BACKTICK) return null
  let value = ''
  for (let at = index + 1; at < source.length; at += 1) {
    const char = source[at]
    if (char === '\\') {
      if (at + 1 < source.length) {
        const escape = source[at + 1]
        const simple = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', '0': '\0' }
        if (escape === 'x' || escape === 'u') {
          const size = escape === 'x' ? 2 : 4
          const digits = source.slice(at + 2, at + 2 + size)
          if (digits.length !== size || !/^[0-9a-f]+$/i.test(digits)) {
            return { dynamic: true, value: '', reason: 'run_code 内部转义无法静态解析', end: source.length }
          }
          value += String.fromCharCode(parseInt(digits, 16))
          at += size + 1
        } else {
          if (escape !== '\n') value += simple[escape] ?? escape
          at += 1
        }
      }
      continue
    }
    if (quote === BACKTICK && char === '$' && source[at + 1] === '{') {
      return { dynamic: true, value: '', reason: 'run_code 内部含模板插值，无法静态解析', end: source.length }
    }
    if (char === quote) return { dynamic: false, value, end: at + 1 }
    value += char
  }
  return { dynamic: true, value: '', reason: 'run_code 内部字符串未闭合，无法静态解析', end: source.length }
}

/** Extract the first {...} object body starting at openIndex. */
function extractObjectBody(source, openIndex) {
  let depth = 0
  let quote = null
  for (let at = openIndex; at < source.length; at += 1) {
    const char = source[at]
    if (quote) {
      if (char === '\\') { at += 1; continue }
      if (char === quote) quote = null
      continue
    }
    if (char === "'" || char === '"' || char === BACKTICK) {
      quote = char
      continue
    }
    if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) return source.slice(openIndex + 1, at)
    }
  }
  return null
}

/** Parse top-level key:value pairs from an object body; values are literals or dynamic. */
function parseObjectProperties(body) {
  const props = new Map()
  const incomplete = reason => { props.set('$incomplete', { type: 'dynamic', reason }); return props }
  let at = 0
  while (at < body.length) {
    at = skipSpace(body, at)
    if (at >= body.length) break
    const keyLiteral = readLiteral(body, at)
    const keyMatch = /^[A-Za-z_$][\w$]*/.exec(body.slice(at))
    if ((!keyLiteral || keyLiteral.dynamic) && !keyMatch) return incomplete('run_code 参数键/展开/计算属性无法完整解析')
    const key = keyLiteral ? keyLiteral.value : keyMatch[0]
    at = skipSpace(body, keyLiteral ? keyLiteral.end : at + key.length)
    if (body[at] !== ':' || props.has(key)) return incomplete('run_code 参数包含简写/重复属性，无法完整解析')
    at = skipSpace(body, at + 1)
    if (body[at] === '[') {
      const values = []
      at = skipSpace(body, at + 1)
      while (at < body.length && body[at] !== ']') {
        const literal = readLiteral(body, at)
        if (!literal || literal.dynamic) return incomplete('run_code 内部数组含变量/动态值，无法静态解析')
        values.push(literal.value)
        at = skipSpace(body, literal.end)
        if (body[at] === ',') at = skipSpace(body, at + 1)
        else if (body[at] !== ']') return incomplete('run_code 内部数组含表达式，无法静态解析')
      }
      if (body[at] !== ']') return incomplete('run_code 内部数组未闭合')
      at += 1
      props.set(key, { type: 'array', value: values })
    } else {
      const literal = readLiteral(body, at)
      const scalar = /^(?:true|false|null|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)(?=\s*(?:,|$))/.exec(body.slice(at))
      if (literal && !literal.dynamic) {
        props.set(key, { type: 'string', value: literal.value })
        at = literal.end
      } else if (scalar) {
        props.set(key, { type: 'scalar', value: scalar[0] })
        at += scalar[0].length
      } else return incomplete(literal && literal.reason || 'run_code 内部 ' + key + ' 含变量或动态值，无法静态解析')
    }
    at = skipSpace(body, at)
    if (at < body.length && body[at] !== ',') return incomplete('run_code 内部 ' + key + ' 含字符串拼接/表达式，无法静态解析')
    if (body[at] === ',') at += 1
  }
  return props
}

export const PTC_MAX_NESTING = 8
const PTC_WRITE_TOOLS = new Set(['write', 'edit', 'multi_edit', 'apply_patch', 'notebook_edit'])
const PTC_READ_TOOLS = new Set(['read', 'grep', 'glob', 'ria_session_list', 'ria_session_events'])

/** Mask literals/comments so text resembling a tool call cannot hide real calls. */
function transportCodeMask(code) {
  let masked = ''
  const nesting = []
  for (let at = 0; at < code.length;) {
    const literal = readLiteral(code, at)
    if (literal) {
      if (literal.dynamic) return { reason: literal.reason }
      masked += ' '.repeat(literal.end - at)
      at = literal.end
      continue
    }
    if (code.startsWith('//', at) || code.startsWith('/*', at)) {
      const line = code.startsWith('//', at)
      const close = code.indexOf(line ? '\n' : '*/', at + 2)
      if (!line && close < 0) return { reason: 'run_code 内部注释未闭合' }
      const end = close < 0 ? code.length : close + (line ? 0 : 2)
      masked += ' '.repeat(end - at)
      at = end
      continue
    }
    const char = code[at]
    if ('([{'.includes(char)) {
      nesting.push(char)
      if (nesting.length > PTC_MAX_NESTING) return { reason: 'run_code 嵌套超限（最多 ' + PTC_MAX_NESTING + ' 层）' }
    } else if (')]}'.includes(char)) {
      if (nesting.pop() !== { ')': '(', ']': '[', '}': '{' }[char]) return { reason: 'run_code 结构未闭合' }
    }
    masked += char
    at += 1
  }
  return nesting.length ? { reason: 'run_code 结构未闭合' } : { masked, reason: '' }
}

/**
 * Parse only a bounded, literal subset. Any unrecognized call/property is
 * incomplete; partial findings remain available for audit but cannot auto-allow.
 */
export function parseTransportCall(toolName, args = {}) {
  const transport = String(toolName || '')
  const result = { parsed: false, complete: false, calls: [], commands: [], paths: [], cwd: '', workdir: '', sandboxPermissions: '', justification: '', reason: '', transport }
  const incomplete = reason => ({ ...result, parsed: result.calls.length > 0, reason })
  if (!PTC_TRANSPORTS.has(transport)) return incomplete('不是 PTC 传输层')
  if (!args || typeof args !== 'object' || Array.isArray(args)) return incomplete('缺少 run_code 参数对象')
  const code = typeof args.code === 'string' ? args.code : ''
  if (!code.trim()) return incomplete('缺少 run_code code 参数')
  if (code.includes(INTERPOLATION)) return incomplete('run_code 内部命令含动态插值，无法静态解析')
  const scan = transportCodeMask(code)
  if (scan.reason) return incomplete(scan.reason)
  const masked = scan.masked
  if (/\beval\s*\(|new\s+Function\b|\bimport\s*\(/.test(masked)) return incomplete('run_code 内部使用 eval/动态构造/import，无法静态解析')
  if (/\b(?:process|require|globalThis)\b/.test(masked)) return incomplete('run_code 内部有未识别的执行/目录上下文')
  const references = [...masked.matchAll(/\btools\b/g)]
  for (const reference of references) {
    const start = reference.index
    const match = /^tools\s*\.\s*([A-Za-z_$][\w$]*)\s*\(/.exec(masked.slice(start))
    if (!match) return incomplete('run_code 存在未识别的内嵌 tools 调用（动态索引/别名）')
    const innerTool = match[1]
    if (PTC_TRANSPORTS.has(innerTool)) return incomplete('run_code 嵌套传输无法完整解析（嵌套超限保护）')
    if (innerTool !== 'bash' && !PTC_WRITE_TOOLS.has(innerTool) && !PTC_READ_TOOLS.has(innerTool)) {
      return incomplete('run_code 存在未识别的内嵌调用：tools.' + innerTool)
    }
    const brace = skipSpace(code, start + match[0].length)
    if (code[brace] !== '{') return incomplete('run_code 内部工具参数不是对象字面量，无法静态解析')
    const body = extractObjectBody(code, brace)
    if (body === null) return incomplete('run_code 内部工具参数未闭合，无法静态解析')
    const bodyMask = masked.slice(brace + 1, brace + 1 + body.length)
    if (/\.\.\.|(?:^|,)\s*\[|\bget\s+|\bset\s+/.test(bodyMask)) return incomplete('run_code 内部参数含展开/计算属性，无法完整解析')
    const props = parseObjectProperties(body)
    if (props.has('$incomplete')) return incomplete(props.get('$incomplete').reason)
    let dynamicReason = ''
    const readString = key => {
      const prop = props.get(key)
      if (!prop) return ''
      if (prop.type === 'string') return prop.value
      dynamicReason = prop.reason || 'run_code 内部 ' + key + ' 含变量或动态值，无法静态解析'
      return ''
    }
    const command = readString('command')
    const cwd = readString('cwd')
    const workdir = readString('workdir')
    const sandbox = readString('sandbox_permissions')
    const justification = readString('justification')
    const paths = []
    for (const key of ['file_path', 'path', 'target', 'dest', 'destination']) {
      const path = readString(key)
      if (path) paths.push(path)
    }
    const list = props.get('paths')
    if (list) {
      if (list.type === 'array') paths.push(...list.value)
      else dynamicReason = list.reason || 'run_code 内部 paths 无法静态解析'
    }
    if (dynamicReason) return incomplete(dynamicReason)
    if (cwd && workdir && cwd !== workdir) return incomplete('run_code 内部 workdir/cwd 冲突，无法确定工作目录')
    const directory = workdir || cwd
    if (directory && (hasShellMeta(directory) || directory.startsWith('~'))) return incomplete('run_code 内部 workdir 含变量/~，无法确定工作目录')
    if (innerTool === 'bash' && !command) return incomplete('run_code 内部 bash 缺少命令')
    if (PTC_WRITE_TOOLS.has(innerTool) && paths.length === 0) return incomplete('run_code 内部写调用缺少目标路径')
    result.calls.push({ toolName: innerTool, command, paths, cwd, workdir, sandboxPermissions: sandbox, justification })
    if (innerTool === 'bash') result.commands.push(command)
    if (PTC_WRITE_TOOLS.has(innerTool)) result.paths.push(...paths)
    if (directory) result.cwd = directory
    if (workdir) result.workdir = workdir
    if (sandbox) result.sandboxPermissions = sandbox
    if (justification) result.justification = justification
  }
  if (!result.calls.length) return incomplete('未找到可静态解析的 tools.bash/tools.write 调用')
  return { ...result, parsed: true, complete: true }
}

function classifyTool(toolName, args, workspace, cwd, hit, signals) {
  const lower = toolName.toLowerCase()
  const paths = signals.paths.slice()
  for (const key of ['file_path', 'path', 'target', 'dest', 'destination']) {
    if (typeof args[key] === 'string' && args[key]) paths.push(args[key])
  }
  if (Array.isArray(args.paths)) paths.push(...args.paths.filter(item => typeof item === 'string' && item))
  signals.paths = paths

  if (['write', 'edit', 'multi_edit', 'apply_patch', 'notebook_edit'].includes(lower)) {
    if (!paths.length) {
      hit('unknown', 'path-missing', '写工具缺少目标路径')
      return
    }
    pathRuleHits(paths, { workspace, cwd }, hit)
    return
  }
  if (['read', 'grep', 'glob', 'ria_session_list', 'ria_session_events'].includes(lower)) {
    if (inspectCredentialPath(paths.map(path => absolutePath(path, cwd, workspace) || path))) hit('high', 'credentials-path', '读取凭据/密钥文件')
    else hit('low', 'read-only-tool', '只读工具：' + toolName)
    return
  }
  hit('unknown', 'unknown-tool', '未识别的工具：' + toolName)
}

/**
 * classify({ toolName, args?, command?, argv?, paths?, cwd?, workspace?, justification?, ticket? })
 * -> { level, reasons, signals }
 *
 * Reasons are formatted as "[rule-id] readable Chinese" and signals.ruleIds is
 * the same ids without prose, so an audit line can be filtered by rule.
 */
export function classify(input = {}) {
  const toolName = String(input.toolName || '').trim()
  const args = input.args && typeof input.args === 'object' && !Array.isArray(input.args) ? input.args : {}
  const workspace = absolutePath(input.workspace, '', '') || absolutePath(input.cwd, '', '') || ''
  const baseCwd = absolutePath(input.cwd, '', '') || workspace
  const declaredCwd = input.workdir ?? args.workdir ?? args.cwd
  const cwd = declaredCwd === undefined ? baseCwd
    : (typeof declaredCwd === 'string' && !hasShellMeta(declaredCwd) ? absolutePath(declaredCwd, baseCwd, workspace) : '')
  const hits = []
  const hit = (level, id, reason) => hits.push({ level, id, reason })
  const signals = {
    toolName,
    command: '',
    argv: Array.isArray(input.argv) ? input.argv.map(String) : [],
    paths: Array.isArray(input.paths) ? input.paths.map(String) : [],
    cwd,
    workspace,
    ruleIds: [],
  }

  if (!cwd) hit('unknown', 'workdir-missing', '缺少或无法确定 workdir/cwd，不能静默假定工作目录')
  if (cwd && inspectCredentialPath([cwd])) hit('high', 'credentials-path', '工作目录位于凭据/密钥路径：' + cwd)
  if (!toolName) {
    hit('unknown', 'unknown-tool', '没有工具名，无法判定风险')
  } else if (toolName === 'bash') {
    const raw = String(input.command !== undefined ? input.command : (args.command !== undefined ? args.command : '')).trim()
    signals.command = raw
    if (!raw) {
      hit('unknown', 'missing-arguments', '缺少 bash 命令，无法判定风险')
    } else if (hasShellMeta(raw)) {
      hit('unknown', 'unparsed-shell', '命令含管道/变量/命令替换，无法静态解析')
    } else if (/^\s*(?:sh|bash|zsh|dash|fish)\s+-c(?:\s|$)/.test(raw) || raw.includes(' -c ')) {
      hit('unknown', 'unparsed-shell', '通过 shell -c 套娃执行，无法静态解析')
    } else {
      const split = splitRedirection(raw)
      if (split.bad) {
        hit('unknown', 'unparsed-shell', '复合重定向无法静态解析')
      } else {
        const argv = tokenize(split.command)
        if (!argv || argv.length === 0) {
          hit('unknown', 'unparsed-shell', '命令无法分词')
        } else {
          signals.command = split.command
          classifyCommand(argv, workspace, cwd, hit, signals)
          if (split.target) {
            signals.paths.push(split.target)
            pathRuleHits([split.target], { workspace, cwd }, hit)
          }
        }
      }
    }
  } else {
    classifyTool(toolName, args, workspace, cwd, hit, signals)
  }

  if (hits.length === 0) hit('unknown', 'unrecognized-call', '没有匹配到任何风险规则，按未知高风险处理')
  const level = levelOf(hits)
  const reasons = hits.map(item => '[' + item.id + '] ' + item.reason)
  signals.ruleIds = [...new Set(hits.map(item => item.id))]
  signals.level = level
  return { level, reasons, signals }
}
