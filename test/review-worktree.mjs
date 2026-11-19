import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// Exercises scripts/review-worktree.sh against a throwaway repository:
// add -> worktree exists with the requested HEAD -> idempotent re-add ->
// cleanup -> directory gone -> cleanup again succeeds. The script is a review
// tool only; no runtime code of the plugin is imported here.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SCRIPT = join(ROOT, 'scripts', 'review-worktree.sh')

function run(args) {
  const result = spawnSync('bash', [SCRIPT, ...args], { encoding: 'utf8' })
  return { status: result.status, stdout: (result.stdout || '').trim(), stderr: (result.stderr || '').trim() }
}

function git(cwd, ...args) {
  const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' })
  assert.equal(result.status, 0, 'git ' + args.join(' ') + ' failed: ' + (result.stderr || ''))
  return (result.stdout || '').trim()
}

function parseAddOutput(stdout) {
  const worktree = /^worktree=(.+)$/m.exec(stdout)
  const head = /^head=([0-9a-f]{40})$/m.exec(stdout)
  assert.ok(worktree, 'add output must contain worktree=<path>: ' + stdout)
  assert.ok(head, 'add output must contain head=<full sha>: ' + stdout)
  return { worktree: worktree[1], head: head[1] }
}

function worktreeList(repo) {
  return git(repo, 'worktree', 'list', '--porcelain')
    .split('\n')
    .filter(line => line.startsWith('worktree '))
    .map(line => line.slice('worktree '.length))
}

const tmp = mkdtempSync(join(tmpdir(), 'ria-review-worktree-'))
const repo = join(tmp, 'repo')
mkdirSync(repo)
git(repo, 'init', '-q')
git(repo, 'config', 'user.email', 'review-test@example.com')
git(repo, 'config', 'user.name', 'Review Test')
writeFileSync(join(repo, 'a.txt'), 'one\n')
git(repo, 'add', 'a.txt')
git(repo, 'commit', '-qm', 'one')
const first = git(repo, 'rev-parse', 'HEAD')
writeFileSync(join(repo, 'b.txt'), 'two\n')
git(repo, 'add', 'b.txt')
git(repo, 'commit', '-qm', 'two')
const second = git(repo, 'rev-parse', 'HEAD')
assert.notEqual(first, second)

try {
  // 1. Explicit --dir: the worktree exists and its HEAD is the requested commit.
  const explicit = join(tmp, 'wt-explicit')
  const added = run(['--repo', repo, '--commit', first, '--dir', explicit])
  assert.equal(added.status, 0, added.stderr)
  const parsed = parseAddOutput(added.stdout)
  assert.equal(parsed.worktree, explicit)
  assert.equal(parsed.head, first)
  assert.equal(existsSync(explicit), true)
  assert.equal(git(explicit, 'rev-parse', 'HEAD'), first)
  assert.ok(worktreeList(repo).includes(explicit))

  // 2. Repeating the same add is idempotent: same output, one worktree entry.
  const again = run(['--repo', repo, '--commit', first, '--dir', explicit])
  assert.equal(again.status, 0, again.stderr)
  assert.deepEqual(parseAddOutput(again.stdout), parsed)
  assert.equal(worktreeList(repo).filter(item => item === explicit).length, 1)

  // 3. Cleanup removes the directory and its worktree registration.
  const cleaned = run(['--repo', repo, '--cleanup', explicit])
  assert.equal(cleaned.status, 0, cleaned.stderr)
  assert.equal(existsSync(explicit), false)
  assert.equal(worktreeList(repo).includes(explicit), false)

  // 4. Cleanup is idempotent when the directory is already gone (repo optional).
  const cleanedAgain = run(['--cleanup', explicit])
  assert.equal(cleanedAgain.status, 0, cleanedAgain.stderr)

  // 5. Default directory lives next to the repository and uses the documented name.
  const defaulted = run(['--repo', repo, '--commit', second])
  assert.equal(defaulted.status, 0, defaulted.stderr)
  const defaultParsed = parseAddOutput(defaulted.stdout)
  assert.equal(dirname(defaultParsed.worktree), tmp)
  assert.match(defaultParsed.worktree, /ria-review-[0-9a-f]{8}-\d{14}$/)
  assert.equal(defaultParsed.head, second)
  assert.equal(git(defaultParsed.worktree, 'rev-parse', 'HEAD'), second)
  assert.equal(run(['--repo', repo, '--cleanup', defaultParsed.worktree]).status, 0)

  // 6. Error paths are readable and non-zero.
  const missingCommit = run(['--repo', repo])
  assert.notEqual(missingCommit.status, 0)
  assert.match(missingCommit.stderr, /--commit is required/)

  const notRepo = run(['--repo', join(tmp, 'missing-repo'), '--commit', first])
  assert.notEqual(notRepo.status, 0)
  assert.match(notRepo.stderr, /not a git repository/)

  const badCommit = run(['--repo', repo, '--commit', 'deadbeef'])
  assert.notEqual(badCommit.status, 0)
  assert.match(badCommit.stderr, /cannot resolve commit/)

  // 7. An existing worktree with another HEAD is refused instead of overwritten.
  const conflict = join(tmp, 'wt-conflict')
  assert.equal(run(['--repo', repo, '--commit', first, '--dir', conflict]).status, 0)
  const conflicting = run(['--repo', repo, '--commit', second, '--dir', conflict])
  assert.notEqual(conflicting.status, 0)
  assert.match(conflicting.stderr, /different HEAD/)
  assert.equal(run(['--repo', repo, '--cleanup', conflict]).status, 0)

  // 8. Review worktrees must stay outside the main working tree.
  const inside = run(['--repo', repo, '--commit', first, '--dir', join(repo, 'wt-inside')])
  assert.notEqual(inside.status, 0)
  assert.match(inside.stderr, /outside the repository/)

  console.log('review worktree ok')
} finally {
  rmSync(tmp, { recursive: true, force: true })
}
