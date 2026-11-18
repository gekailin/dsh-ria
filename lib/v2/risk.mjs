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

function rank(level) {
  return LEVEL_RANK[level] === undefined ? LEVEL_RANK.unknown : LEVEL_RANK[level]
}

function levelOf(hits) {
  let level = 'low'
  for (const hit of hits) if (rank(hit.level) > rank(level)) level = hit.level
  return level
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
  if (!match) return { command, target: '' }
  const index = command.lastIndexOf(match[2])
  const head = command.slice(0, index).trim()
  if (/[<>|]/.test(head)) return { command, target: '', bad: true }
  return { command: head, target: match[3] }
}

function tokenize(command) {
  const tokens = []
  let current = ''
  let quote = null
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]
    if (quote) {
      if (char === quote) quote = null
      else current += char
      continue
    }
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
  if (['status', 'diff', 'log', 'show', 'rev-parse', 'ls-files', 'blame', 'grep', 'describe', 'remote'].includes(sub)) return true
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

function classifyCommand(argv, workspace, cwd, hit, signals) {
  const first = commandName(argv)
  const sub = String(argv[1] || '').toLowerCase()
  signals.argv = argv.slice()

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
  if (first === 'sed' && !argv.includes('-i') && !argv.includes('--in-place')) hit('low', 'read-only-cmd', '只读 sed')

  const writeTargets = []
  if (['cp', 'mv', 'ln', 'install'].includes(first)) {
    const args = nonFlagTokens(argv)
    if (args.length >= 2) writeTargets.push(args[args.length - 1])
  } else if (['touch', 'mkdir', 'tee', 'truncate'].includes(first)) {
    writeTargets.push(...nonFlagTokens(argv))
  } else if (first === 'sed' && (argv.includes('-i') || argv.includes('--in-place'))) {
    const args = nonFlagTokens(argv).filter(token => !token.includes('/'))
    writeTargets.push(...args.slice(1))
  }
  if (writeTargets.length) pathRuleHits(writeTargets, { workspace, cwd }, hit)

  if (first === 'git' && sub === 'commit' && argv.includes('--amend')) hit('medium', 'git-write', '修正已有提交')
}

function classifyTool(toolName, args, workspace, cwd, hit, signals) {
  const lower = toolName.toLowerCase()
  const paths = []
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
  if (['read', 'grep', 'glob', 'session_list', 'session_events'].includes(lower)) {
    if (inspectCredentialPath(paths)) hit('high', 'credentials-path', '读取凭据/密钥文件')
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
  const cwd = absolutePath(input.cwd, '', '') || workspace
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
