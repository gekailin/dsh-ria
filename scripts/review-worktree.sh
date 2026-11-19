#!/usr/bin/env bash
# scripts/review-worktree.sh — 为代码 review 创建/清理独立 git worktree
#
# Review 约定（与 docs/operations.md「代码 review 的标准流程」一致）：
#   - 每次 review 新开专用 worker，不复用；
#   - 模型固定 mccodex/ide/gpt-6.1-sol，reasoningEffort=max；
#   - review worker 在独立 worktree 中只读审查指定 commit，基线 commit 必须写进报告开头；
#   - review worker 一次性使用，任务结束即归档；其它类型任务不得派给它。
#
# 用法示例：
#   # 1) 默认目录：<repo 父目录>/ria-review-<短sha>-<yyyymmddHHMMSS>
#   scripts/review-worktree.sh --repo /path/to/dsh-ria --commit 9ad03f389897055da1739abe9b74b99bac05b581
#   # 输出：
#   # worktree=/path/to/ria-review-9ad03f38-20261119190500
#   # head=9ad03f389897055da1739abe9b74b99bac05b581
#
#   # 2) 指定目录（可重复执行；目录已存在且 HEAD 一致时复用）
#   scripts/review-worktree.sh --repo /path/to/dsh-ria --commit <sha> --dir /tmp/ria-review-foo
#
#   # 3) review 结束后清理（可重复执行；目录已不存在视为成功）
#   scripts/review-worktree.sh --repo /path/to/dsh-ria --cleanup /tmp/ria-review-foo
#   # 只给 --cleanup 时，脚本从目录自身反推仓库：
#   scripts/review-worktree.sh --cleanup /tmp/ria-review-foo
#
# 约束：只创建/删除 worktree，不改主工作树、不切换分支、不重启服务。
# 失败时向 stderr 输出一行可读原因并以非 0 退出。
set -euo pipefail

PROG=review-worktree

die() {
  printf '%s: %s\n' "$PROG" "$*" >&2
  exit 1
}

usage() {
  sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//'
}

REPO=''
COMMIT=''
DIR=''
CLEANUP=''

while [ $# -gt 0 ]; do
  case "$1" in
    --repo)
      [ $# -ge 2 ] || die '--repo requires a value'
      REPO=$2
      shift 2
      ;;
    --commit)
      [ $# -ge 2 ] || die '--commit requires a value'
      COMMIT=$2
      shift 2
      ;;
    --dir)
      [ $# -ge 2 ] || die '--dir requires a value'
      DIR=$2
      shift 2
      ;;
    --cleanup)
      [ $# -ge 2 ] || die '--cleanup requires a worktree directory'
      CLEANUP=$2
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      die "unknown argument: $1 (use --help)"
      ;;
  esac
done

repo_root() {
  local path=$1
  [ -e "$path" ] || return 1
  git -C "$path" rev-parse --show-toplevel 2>/dev/null
}

absolute_dir() {
  local path=$1
  case "$path" in
    /*) printf '%s\n' "$path" ;;
    *) printf '%s/%s\n' "$PWD" "$path" ;;
  esac
}

# Cleanup mode: --cleanup <dir>, optionally with --repo to name the main repository.
if [ -n "$CLEANUP" ]; then
  [ -z "$COMMIT" ] || die '--cleanup cannot be combined with --commit'
  [ -z "$DIR" ] || die 'use either --cleanup <dir> or --dir <dir>, not both'
  target=$(absolute_dir "$CLEANUP")
  if [ ! -e "$target" ]; then
    # Already gone: prune stale metadata when the repository is known, then succeed.
    if [ -n "$REPO" ]; then
      root=$(repo_root "$REPO") || die "not a git repository: $REPO"
      git -C "$root" worktree prune >/dev/null 2>&1 || true
    fi
    printf 'worktree already absent: %s\n' "$target"
    exit 0
  fi
  if [ -z "$REPO" ]; then
    common=$(git -C "$target" rev-parse --path-format=absolute --git-common-dir 2>/dev/null) \
      || die "not a git worktree: $target (pass --repo to name the main repository)"
    REPO=$(dirname "$common")
  fi
  root=$(repo_root "$REPO") || die "not a git repository: $REPO"
  # Refuse to remove the main working tree or a worktree of another repository.
  target_common=$(git -C "$target" rev-parse --path-format=absolute --git-common-dir 2>/dev/null) \
    || die "not a git worktree: $target"
  root_common=$(git -C "$root" rev-parse --path-format=absolute --git-common-dir 2>/dev/null) \
    || die "not a git repository: $root"
  [ "$target_common" = "$root_common" ] \
    || die "worktree $target does not belong to repository $root"
  [ "$(git -C "$root" rev-parse --show-toplevel 2>/dev/null)" != "$target" ] \
    || die "refusing to remove the main working tree: $target"
  git -C "$root" worktree remove --force "$target" >/dev/null 2>&1 \
    || die "could not remove worktree $target (run 'git -C $root worktree prune' and retry)"
  git -C "$root" worktree prune >/dev/null 2>&1 || true
  [ ! -e "$target" ] || die "worktree directory still exists after cleanup: $target"
  printf 'cleaned worktree: %s\n' "$target"
  exit 0
fi

# Add mode: --repo <path> --commit <sha> [--dir <path>].
[ -n "$REPO" ] || die '--repo is required (usage: --repo <path> --commit <sha> [--dir <path>])'
[ -n "$COMMIT" ] || die '--commit is required (usage: --repo <path> --commit <sha> [--dir <path>])'
root=$(repo_root "$REPO") || die "not a git repository: $REPO"
full=$(git -C "$root" rev-parse --verify --quiet "${COMMIT}^{commit}") \
  || die "cannot resolve commit: $COMMIT (not a commit in $root)"
short=${full:0:8}
timestamp=$(date +%Y%m%d%H%M%S)

if [ -n "$DIR" ]; then
  target=$(absolute_dir "$DIR")
else
  parent=$(dirname "$root")
  target="$parent/ria-review-$short-$timestamp"
fi

# Keep review checkouts outside the main working tree so they never pollute it.
case "$target" in
  "$root"|"$root"/*) die "review worktree must be outside the repository: $target" ;;
esac

if [ -e "$target" ]; then
  existing=$(git -C "$target" rev-parse HEAD 2>/dev/null) \
    || die "target exists but is not a git worktree: $target"
  [ "$existing" = "$full" ] \
    || die "target exists with different HEAD: $target (HEAD $existing, wanted $full)"
  target_common=$(git -C "$target" rev-parse --path-format=absolute --git-common-dir 2>/dev/null || true)
  root_common=$(git -C "$root" rev-parse --path-format=absolute --git-common-dir 2>/dev/null || true)
  [ "$target_common" = "$root_common" ] \
    || die "target is a worktree of another repository: $target"
else
  parent=$(dirname "$target")
  mkdir -p "$parent" || die "could not create parent directory: $parent"
  git -C "$root" worktree add --detach "$target" "$full" >/dev/null 2>&1 \
    || die "git worktree add failed for $target at $full"
fi

actual=$(git -C "$target" rev-parse HEAD 2>/dev/null) \
  || die "worktree was created but HEAD cannot be read: $target"
[ "$actual" = "$full" ] \
  || die "worktree HEAD mismatch: $target has $actual, wanted $full"
printf 'worktree=%s\n' "$target"
printf 'head=%s\n' "$actual"
