#!/usr/bin/env bash
# Host-side deploy + state migration window for dsh-ria.
#
# The worker runs inside dsh web and cannot stop its own host: this script is
# scheduled by systemd-run (or run manually for rehearsal) so it survives the
# web server stop. Every node/dsh command is absolute.
#
# Modes:
#   default            real window (stop daemon, migrate real state, deploy,
#                      start, verify, write result file)
#   --rehearse         temp DSH_HOME/profile/state is supplied by the caller;
#                      stops a temp server instead of the daemon; deploy is a
#                      real `dsh plugin add` into the temp profile
#   --dry-run-all      print every planned command/decision and exit
#   --inject-failure=S inject a failure after step S to exercise rollback
#
# Never exports DSH_RIA_STORAGE (an empty value is treated as invalid by the
# plugin runtime).
set -uo pipefail
unset DSH_RIA_STORAGE

NODE="/home/gkl/.nvm/versions/node/v26.2.0/bin/node"
DSH="/home/gkl/.nvm/versions/node/v26.2.0/bin/dsh"
DAEMON="/home/gkl/.nvm/versions/node/v26.2.0/bin/dsh-daemon"
REPO="/home/gkl/Desktop/vibe_proj/dsh-ria"

MODE="real"
DRY_ALL=0
INJECT=""
DEPLOY_MODE=""
STATE_DIR=""
DSH_HOME_DIR=""
PROFILE_DIR=""
PORT=""
RESULT_FILE=""
BACKUP_ROOT=""
while [ $# -gt 0 ]; do
  case "$1" in
    --rehearse) MODE="rehearse" ;;
    --dry-run-all) DRY_ALL=1 ;;
    --inject-failure=*) INJECT="${1#--inject-failure=}" ;;
    --deploy-mode=*) DEPLOY_MODE="${1#--deploy-mode=}" ;;
    --state=*) STATE_DIR="${1#--state=}" ;;
    --dsh-home=*) DSH_HOME_DIR="${1#--dsh-home=}" ;;
    --profile=*) PROFILE_DIR="${1#--profile=}" ;;
    --port=*) PORT="${1#--port=}" ;;
    --result=*) RESULT_FILE="${1#--result=}" ;;
    --backup-root=*) BACKUP_ROOT="${1#--backup-root=}" ;;
    --help|-h)
      grep '^#' "$0" | sed 's/^# \{0,1\}//' | head -30
      exit 0 ;;
    *) echo "deploy-window: unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done

if [ "$MODE" = "real" ]; then
  DEPLOY_MODE="${DEPLOY_MODE:-plugin}"
  DSH_HOME_DIR="${DSH_HOME_DIR:-/home/gkl/.dsh}"
  PROFILE_DIR="${PROFILE_DIR:-$DSH_HOME_DIR/profiles/web}"
  STATE_DIR="${STATE_DIR:-$DSH_HOME_DIR/state/ria}"
  PORT="${PORT:-3080}"
  RESULT_FILE="${RESULT_FILE:-$DSH_HOME_DIR/state/ria-maintenance-result-deploy.json}"
  BACKUP_ROOT="${BACKUP_ROOT:-$DSH_HOME_DIR/state}"
else
  [ -n "$DSH_HOME_DIR" ] || { echo "rehearse requires --dsh-home" >&2; exit 2; }
  PROFILE_DIR="${PROFILE_DIR:-$DSH_HOME_DIR/profiles/web}"
  STATE_DIR="${STATE_DIR:-$DSH_HOME_DIR/state/ria}"
  PORT="${PORT:-3199}"
  RESULT_FILE="${RESULT_FILE:-$DSH_HOME_DIR/state/ria-maintenance-result-rehearsal.json}"
  BACKUP_ROOT="${BACKUP_ROOT:-$DSH_HOME_DIR/state}"
  DEPLOY_MODE="${DEPLOY_MODE:-copy}"
  case "$STATE_DIR" in /tmp/*) ;; *) echo "rehearsal state must live under /tmp" >&2; exit 2 ;; esac
  [ "$PORT" != "3080" ] || { echo "rehearsal must use a non-3080 port" >&2; exit 2; }
fi

if [ "$MODE" = "rehearse" ] && [ -f "$PROFILE_DIR/cordis.patch.yml" ]; then
  # The composed profile pins the port in cordis.patch.yml; --port alone does
  # not override it. Rehearsal owns this temp profile, so pin its port too.
  sed -i "s/^\([[:space:]]*port: \)[0-9][0-9]*/\1$PORT/" "$PROFILE_DIR/cordis.patch.yml"
fi

TS="$(date +%Y%m%d-%H%M%S)"
TMP="$(mktemp -d "/tmp/ria-deploy-window-$TS.XXXXXX")"
BACKUP_DIR=""
PROFILE_BACKUP=""
PROFILE_SNAPSHOT=""
ROLLBACK_CODE=""
ROLLBACK_COMMIT="9d708ee"
TMP_PID="$TMP/web.pid"
FAILED_STEP=""
SERVER_STOPPED=0
DEPLOY_ATTEMPTED=0
STARTED_AT_MS=$(date +%s%3N)

if [ "$DRY_ALL" = "1" ]; then
  cat <<EOF
DRY-RUN PLAN (mode=$MODE)
  repo:        $REPO
  state:       $STATE_DIR
  dsh home:    $DSH_HOME_DIR
  profile:     $PROFILE_DIR
  port:        $PORT
  result:      $RESULT_FILE
  backup root: $BACKUP_ROOT
  steps: baseline -> backup -> stop -> migrate(state-rw,memory,topics; dry-run then apply)
         -> deploy(dsh plugin add file:$REPO; diff+sha verify) -> start/health
         -> verify(storage/sqlite/v2/cognition/topics/tickets/board) -> result
EOF
  exit 0
fi

log() { echo "[$(date +%H:%M:%S)] $*"; }
record() {
  "$NODE" -e '
    const fs = require("fs")
    const [file, step, status, detail] = process.argv.slice(1)
    let out = {}
    try { out = JSON.parse(fs.readFileSync(file, "utf8")) } catch {}
    out.steps = out.steps || {}
    out.steps[step] = { status, detail: detail || "", at: new Date().toISOString() }
    fs.writeFileSync(file, JSON.stringify(out, null, 2) + "\n")
  ' "$RESULT_FILE" "$1" "$2" "${3:-}"
}
meta() {
  "$NODE" -e '
    const fs = require("fs")
    const [file, key, value] = process.argv.slice(1)
    let out = {}
    try { out = JSON.parse(fs.readFileSync(file, "utf8")) } catch {}
    out[key] = value
    fs.writeFileSync(file, JSON.stringify(out, null, 2) + "\n")
  ' "$RESULT_FILE" "$1" "$2"
}
init_result() {
  "$NODE" -e '
    const fs = require("fs")
    const [file, mode, ts, repo, state, home, profile, port] = process.argv.slice(1)
    fs.writeFileSync(file, JSON.stringify({ tool: "scripts/deploy-migrate-window.sh", mode, startedAt: ts, repo, state, dshHome: home, profile, port, steps: {}, conclusion: "running" }, null, 2) + "\n")
  ' "$RESULT_FILE" "$MODE" "$TS" "$REPO" "$STATE_DIR" "$DSH_HOME_DIR" "$PROFILE_DIR" "$PORT"
}
finalize() {
  "$NODE" -e '
    const fs = require("fs")
    const [file, conclusion, failedStep, backupDir, profileBackup, durationMs] = process.argv.slice(1)
    let out = {}
    try { out = JSON.parse(fs.readFileSync(file, "utf8")) } catch {}
    out.conclusion = conclusion
    out.failedStep = failedStep || null
    out.backupDir = backupDir || null
    out.profileBackup = profileBackup || null
    out.durationMs = Number(durationMs) || null
    out.finishedAt = new Date().toISOString()
    fs.writeFileSync(file, JSON.stringify(out, null, 2) + "\n")
  ' "$RESULT_FILE" "$1" "${2:-}" "${3:-}" "${4:-}" "$(( $(date +%s%3N) - STARTED_AT_MS ))"
}
health_code() { curl -sS -m 2 -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/health" 2>/dev/null || true; }
wait_health() {
  local limit="${1:-60}" code=""
  for _ in $(seq 1 "$limit"); do
    code="$(health_code)"
    [ "$code" = "200" ] && return 0
    sleep 1
  done
  return 1
}
stop_server() {
  if [ "$MODE" = "rehearse" ]; then
    if [ -f "$TMP_PID" ]; then
      kill "$(cat "$TMP_PID")" 2>/dev/null || true
      for _ in $(seq 1 15); do kill -0 "$(cat "$TMP_PID")" 2>/dev/null || break; sleep 1; done
      kill -9 "$(cat "$TMP_PID")" 2>/dev/null || true
    fi
    # A previous rehearsal run may leave the temp server up; stop the listener.
    if command -v lsof >/dev/null 2>&1; then
      for pid in $(lsof -ti ":$PORT" 2>/dev/null); do kill "$pid" 2>/dev/null || true; done
    fi
  else
    "$DAEMON" stop >/dev/null 2>&1 || return 1
  fi
  for _ in $(seq 1 30); do
    [ "$(health_code)" != "200" ] && return 0
    sleep 1
  done
  return 1
}
start_server() {
  if [ "$MODE" = "rehearse" ]; then
    ( cd "$DSH_HOME_DIR" && DSH_HOME="$DSH_HOME_DIR" nohup "$DSH" web --port "$PORT" --no-open > "$DSH_HOME_DIR/deploy-web.log" 2>&1 & echo $! > "$TMP_PID" )
  else
    "$DAEMON" start >/dev/null 2>&1 || true
  fi
  wait_health 60
}
board_check() {
  local token="" code=""
  if [ "$MODE" = "real" ]; then
    token="$("$DAEMON" status 2>/dev/null | sed -n 's/.*token=\([^ ]*\).*/\1/p' | head -1)"
  fi
  if [ -z "$token" ] && [ -f "$DSH_HOME_DIR/deploy-web.log" ]; then
    token="$(sed -n 's/.*token=\([^ ]*\).*/\1/p' "$DSH_HOME_DIR/deploy-web.log" | head -1)"
  fi
  if [ -n "$token" ]; then
    curl -sS -m 5 -c "$TMP/cookies" "http://127.0.0.1:$PORT/?token=$token" -o /dev/null 2>/dev/null || true
  fi
  code="$(curl -sS -m 8 -b "$TMP/cookies" -o "$TMP/board.json" -w '%{http_code}' "http://127.0.0.1:$PORT/plugins/dsh-ria/api/board?limit=5" 2>/dev/null || true)"
  [ "$code" = "200" ] || { echo "board http $code" >> "$TMP/board.err"; return 1; }
  "$NODE" -e 'const fs=require("fs");const j=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));if(!j.ok)process.exit(1)' "$TMP/board.json" || return 1
  return 0
}
run_migration() {
  local name="$1"
  local script="$2"
  local dry="$TMP/$1-dry.json"
  local applied="$TMP/$1-applied.json"
  if ! "$NODE" "$REPO/$script" --state "$STATE_DIR" --backup "$BACKUP_DIR/migrations" --dry-run > "$dry" 2>"$TMP/$name-dry.err"; then
    record "$name" failed "dry-run failed: $(tail -2 "$TMP/$name-dry.err" | tr '\n' ' ')"
    return 1
  fi
  if ! "$NODE" -e 'const fs=require("fs");const j=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));if(!j.dryRun)process.exit(1)' "$dry"; then
    record "$name" failed "dry-run did not report dryRun"
    return 1
  fi
  if ! "$NODE" "$REPO/$script" --state "$STATE_DIR" --backup "$BACKUP_DIR/migrations" > "$applied" 2>"$TMP/$name-apply.err"; then
    record "$name" failed "apply failed: $(tail -2 "$TMP/$name-apply.err" | tr '\n' ' ')"
    return 1
  fi
  local detail
  detail="$("$NODE" -e 'const fs=require("fs");const j=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));console.log(JSON.stringify({changed:j.changed,reason:j.reason||null,backupDir:j.backupDir||null}))' "$applied")"
  record "$name" completed "$detail"
  return 0
}
verify_sha_file() {
  local rel="$1" src dst
  src="$REPO/$rel"; dst="$PROFILE_DIR/node_modules/dsh-ria/$rel"
  [ -f "$src" ] && [ -f "$dst" ] || { echo "missing $rel"; return 1; }
  [ "$(sha256sum "$src" | cut -d' ' -f1)" = "$(sha256sum "$dst" | cut -d' ' -f1)" ] || { echo "sha mismatch $rel"; return 1; }
  return 0
}

fail_step() {
  FAILED_STEP="$1"
  log "FAILED: $1"
  record "$1" failed "${2:-}"
  rollback
  finalize "rolled_back" "$FAILED_STEP" "$BACKUP_DIR" "$PROFILE_BACKUP"
  exit 1
}
rollback() {
  log "rollback: restoring state and profile"
  SERVER_STOPPED=0
  if [ "$DEPLOY_ATTEMPTED" = "1" ] && [ -n "$PROFILE_SNAPSHOT" ] && [ -d "$PROFILE_SNAPSHOT/node_modules" ]; then
    rm -rf "$PROFILE_DIR/node_modules"
    mv "$PROFILE_SNAPSHOT/node_modules" "$PROFILE_DIR/node_modules" || log "WARN: node_modules snapshot restore failed"
    for f in package.json cordis.patch.yml cordis.yml pnpm-lock.yaml; do
      [ -e "$PROFILE_SNAPSHOT/$f" ] && cp -a "$PROFILE_SNAPSHOT/$f" "$PROFILE_DIR/$f" || true
    done
  elif [ "$DEPLOY_ATTEMPTED" = "1" ] && [ -n "$PROFILE_BACKUP" ] && [ -f "$PROFILE_BACKUP" ]; then
    rm -rf "$PROFILE_DIR/node_modules/dsh-ria"
    tar -xzf "$PROFILE_BACKUP" -C "$PROFILE_DIR" 2>/dev/null || log "WARN: profile restore failed; manual restore from $PROFILE_BACKUP"
  fi
  if [ -n "$BACKUP_DIR" ] && [ -d "$BACKUP_DIR" ]; then
    rm -rf "$STATE_DIR"
    cp -a "$BACKUP_DIR" "$STATE_DIR"
  fi
  if start_server; then
    record rollback completed "state restored from $BACKUP_DIR"
    return 0
  fi
  # The live profile copy is a historical hybrid and may not boot. Fall back to
  # the known-bootable pre-deploy code snapshot built before the stop.
  if [ -n "$ROLLBACK_CODE" ] && [ -d "$ROLLBACK_CODE/node_modules/dsh-ria" ]; then
    log "rollback: old profile did not boot; falling back to $ROLLBACK_COMMIT code snapshot"
    rm -rf "$PROFILE_DIR/node_modules/dsh-ria"
    cp -a "$ROLLBACK_CODE/node_modules/dsh-ria" "$PROFILE_DIR/node_modules/dsh-ria"
    if start_server; then
      record rollback completed "state restored from $BACKUP_DIR; code fallback=$ROLLBACK_COMMIT"
      return 0
    fi
  fi
  record rollback failed "state restored but /health did not return 200 (fallback=$ROLLBACK_COMMIT)"
}

# ---- preconditions -------------------------------------------------------
for bin in "$NODE" "$DSH"; do
  [ -x "$bin" ] || { echo "missing executable: $bin" >&2; exit 3; }
done
command -v "$NODE" >/dev/null || { echo "node not found" >&2; exit 3; }
[ -d "$STATE_DIR" ] || { echo "state dir missing: $STATE_DIR" >&2; exit 3; }
[ -d "$PROFILE_DIR" ] || { echo "profile missing: $PROFILE_DIR" >&2; exit 3; }
[ -f "$REPO/scripts/migrate-state-rw.mjs" ] || { echo "missing migrate-state-rw" >&2; exit 3; }
[ -f "$REPO/scripts/migrate-memory.mjs" ] || { echo "missing migrate-memory" >&2; exit 3; }
[ -f "$REPO/scripts/migrate-topics.mjs" ] || { echo "missing migrate-topics" >&2; exit 3; }
if [ "$MODE" = "real" ]; then
  [ -x "$DAEMON" ] || { echo "missing dsh-daemon" >&2; exit 3; }
  [ "$(health_code)" = "200" ] || { echo "precondition: /health is not 200" >&2; exit 3; }
fi

init_result
mkdir -p "$(dirname "$RESULT_FILE")" 2>/dev/null || true

# ---- 1. baseline ---------------------------------------------------------
HEAD="$(git -C "$REPO" rev-parse HEAD 2>/dev/null || echo unknown)"
STORAGE="$("$NODE" -e 'const fs=require("fs");try{console.log(JSON.parse(fs.readFileSync(process.argv[1],"utf8")).storage||"")}catch{console.log("")}' "$STATE_DIR/ria.json")"
SQLITE_SHA="$(sha256sum "$STATE_DIR/ria.sqlite" 2>/dev/null | cut -d' ' -f1 || true)"
HEALTH="$(health_code)"
meta head "$HEAD"; meta storage "$STORAGE"; meta sqliteSha "$SQLITE_SHA"; meta baselineHealth "$HEALTH"; meta mode "$MODE"; meta ts "$TS"
record baseline completed "HEAD=$HEAD storage=$STORAGE health=$HEALTH"
if [ "$MODE" = "real" ] && { [ "$STORAGE" != "sqlite" ] || [ "$HEALTH" != "200" ]; }; then
  fail_step baseline "expected storage=sqlite and /health=200"
fi

# ---- 2. backup -----------------------------------------------------------
[ -n "$BACKUP_ROOT" ] || BACKUP_ROOT="$DSH_HOME_DIR/state"
BACKUP_DIR="$BACKUP_ROOT/ria-backup-deploy-$TS"
[ ! -e "$BACKUP_DIR" ] || fail_step backup "backup dir already exists: $BACKUP_DIR"
mkdir -p "$BACKUP_ROOT"
if ! cp -a "$STATE_DIR" "$BACKUP_DIR"; then fail_step backup "cp -a state failed"; fi
record backup completed "full state copy at $BACKUP_DIR"

# Build a known-bootable rollback code snapshot from the last pre-Phase1 commit.
# The live profile is a historical hybrid (some files newer than others and
# missing lib/shared), so it is kept for audit but cannot reliably boot; this
# snapshot is the code fallback when rollback health fails.
ROLLBACK_CODE="$DSH_HOME_DIR/ria-rollback-code-$TS"
mkdir -p "$ROLLBACK_CODE/node_modules/dsh-ria"
if ! git -C "$REPO" archive "$ROLLBACK_COMMIT" | tar -x -C "$ROLLBACK_CODE/node_modules/dsh-ria"; then
  ROLLBACK_CODE=""
fi

# ---- 3. stop -------------------------------------------------------------
if ! stop_server; then fail_step stop "web did not stop / port still healthy"; fi
SERVER_STOPPED=1
# Refresh the SQLite snapshot after the server is down so WAL is quiescent.
for f in ria.sqlite ria.sqlite-wal ria.sqlite-shm ria.json v2.json; do
  [ -e "$STATE_DIR/$f" ] && cp -a "$STATE_DIR/$f" "$BACKUP_DIR/$f" 2>/dev/null || true
done
record stop completed "server stopped; SQLite snapshot refreshed in backup"

# ---- 4. migrations (dry-run then apply) ----------------------------------
mkdir -p "$BACKUP_DIR/migrations"
if ! run_migration migrate-state-rw scripts/migrate-state-rw.mjs; then fail_step migrate-state-rw "dry-run/apply failed"; fi
if ! run_migration migrate-memory scripts/migrate-memory.mjs; then fail_step migrate-memory "dry-run/apply failed"; fi
if ! run_migration migrate-topics scripts/migrate-topics.mjs; then fail_step migrate-topics "dry-run/apply failed"; fi
[ "$INJECT" = "after-migrate" ] && fail_step inject-after-migrate "injected failure for rehearsal"

# ---- 5. deploy -----------------------------------------------------------
DEPLOY_ATTEMPTED=1
PROFILE_BACKUP="$DSH_HOME_DIR/profile-backup-$TS.tgz"
tar_files=()
for f in node_modules/dsh-ria package.json cordis.patch.yml cordis.yml pnpm-lock.yaml; do
  [ -e "$PROFILE_DIR/$f" ] && tar_files+=("$f")
done
if ! tar -czf "$PROFILE_BACKUP" -C "$PROFILE_DIR" "${tar_files[@]}"; then fail_step deploy "profile backup failed"; fi
# Real deployment can mutate more than node_modules/dsh-ria (pnpm prunes the
# store/links before it fails), so keep a cheap hardlink snapshot of the whole
# node_modules tree plus the profile metadata. Rehearsal copy mode only touches
# node_modules/dsh-ria, but the same snapshot is harmless.
PROFILE_SNAPSHOT="$DSH_HOME_DIR/profile-backup-$TS-snapshot"
mkdir -p "$PROFILE_SNAPSHOT"
cp -al "$PROFILE_DIR/node_modules" "$PROFILE_SNAPSHOT/node_modules" 2>/dev/null || cp -a "$PROFILE_DIR/node_modules" "$PROFILE_SNAPSHOT/node_modules"
for f in package.json cordis.patch.yml cordis.yml pnpm-lock.yaml; do
  [ -e "$PROFILE_DIR/$f" ] && cp -a "$PROFILE_DIR/$f" "$PROFILE_SNAPSHOT/$f" || true
done
rm -rf "$PROFILE_DIR/node_modules/dsh-ria"
if [ "$DEPLOY_MODE" = "copy" ]; then
  mkdir -p "$PROFILE_DIR/node_modules/dsh-ria"
  if ! ( cd "$REPO" && tar cf - --exclude=./node_modules --exclude=./.git --exclude=./ria-runs --exclude=./.analysis-work --exclude=./storage . ) | ( cd "$PROFILE_DIR/node_modules/dsh-ria" && tar xf - ); then
    fail_step deploy "equivalent copy failed"
  fi
else
  if ! DSH_HOME="$DSH_HOME_DIR" "$DSH" plugin --profile web add "file:$REPO" > "$TMP/plugin-add.log" 2>&1; then
    fail_step deploy "dsh plugin add failed: $(tail -3 "$TMP/plugin-add.log" | tr '\n' ' ')"
  fi
fi
if [ ! -d "$PROFILE_DIR/node_modules/dsh-ria" ]; then fail_step deploy "profile has no node_modules/dsh-ria after add"; fi
# Compare the installed package surface (the npm "files" list) rather than the
# whole worktree: test/ and repo metadata are intentionally not published.
if ! diff -rq "$REPO/lib" "$PROFILE_DIR/node_modules/dsh-ria/lib" > "$TMP/diff.log" 2>&1; then
  fail_step deploy "lib diff mismatch: $(head -3 "$TMP/diff.log" | tr '\n' ' ')"
fi
if ! diff -rq "$REPO/scripts" "$PROFILE_DIR/node_modules/dsh-ria/scripts" >> "$TMP/diff.log" 2>&1; then
  fail_step deploy "scripts diff mismatch: $(head -3 "$TMP/diff.log" | tr '\n' ' ')"
fi
for rel in package.json cordis.patch.yml DESIGN.md README.md; do
  cmp -s "$REPO/$rel" "$PROFILE_DIR/node_modules/dsh-ria/$rel" || fail_step deploy "installed copy differs at $rel"
done
for rel in package.json lib/index.js lib/v2/roles.mjs scripts/run-tests.mjs scripts/migrate-memory.mjs scripts/migrate-topics.mjs scripts/migrate-state-rw.mjs; do
  if ! verify_sha_file "$rel"; then fail_step deploy "installed copy differs at $rel"; fi
done
record deploy completed "deployMode=$DEPLOY_MODE; lib/scripts diff and sha256 verified"
[ "$INJECT" = "after-deploy" ] && fail_step inject-after-deploy "injected failure for rehearsal"

# ---- 6. start ------------------------------------------------------------
if ! start_server; then fail_step start "/health did not return 200 within 60s"; fi
record start completed "/health=200 on port $PORT"

# ---- 7. verify -----------------------------------------------------------
STORAGE2="$("$NODE" -e 'const fs=require("fs");console.log(JSON.parse(fs.readFileSync(process.argv[1],"utf8")).storage||"")' "$STATE_DIR/ria.json")"
[ "$STORAGE2" = "sqlite" ] || fail_step verify "storage is not sqlite: $STORAGE2"
if ! "$NODE" "$REPO/scripts/sqlite-migrate.mjs" --state-dir "$STATE_DIR" --verify-only > "$TMP/sqlite-verify.json" 2>"$TMP/sqlite-verify.err"; then
  fail_step verify "sqlite-migrate --verify-only exited non-zero: $(tail -2 "$TMP/sqlite-verify.err" | tr '\n' ' ')"
fi
"$NODE" -e 'const fs=require("fs");const j=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));if(j.ok!==true)process.exit(1)' "$TMP/sqlite-verify.json" || fail_step verify "sqlite verify ok!=true"
V2_CHECK="$("$NODE" -e '
  const fs=require("fs");const d=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
  const bad=[];if(!d.chatSessionId)bad.push("chatSessionId empty");if(d.chatbotSessionId)bad.push("chatbotSessionId still set");
  console.log(bad.join("; "));' "$STATE_DIR/v2.json")"
[ -z "$V2_CHECK" ] || fail_step verify "v2.json: $V2_CHECK"
[ -d "$STATE_DIR/cognition/chat" ] || fail_step verify "cognition/chat missing"
[ "$(find "$STATE_DIR/cognition/chat" -type f | wc -l)" -gt 0 ] || fail_step verify "cognition/chat is empty"
[ ! -d "$STATE_DIR/cognition/chatbot" ] || [ "$(find "$STATE_DIR/cognition/chatbot" -type f | wc -l)" -eq 0 ] || fail_step verify "cognition/chatbot still has files"
TOPIC_CHECK="$("$NODE" -e '
  const fs=require("fs");const d=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
  const topics=Array.isArray(d.topics)?d.topics:[];const bad=[];
  for(const t of topics){if("level" in t||"parentId" in t)bad.push("legacy field "+(t.topicId||"?"));if(!("projectKey" in t))bad.push("no projectKey "+(t.topicId||"?"));if(!Array.isArray(t.tags))bad.push("no tags "+(t.topicId||"?"));}
  console.log(bad.slice(0,5).join("; "));' "$STATE_DIR/ria.json")"
[ -z "$TOPIC_CHECK" ] || fail_step verify "topics: $TOPIC_CHECK"
TICKETS="$("$NODE" -e 'const fs=require("fs");const d=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));console.log((d.tickets||[]).length)' "$STATE_DIR/ria.json")"
[ "$TICKETS" -gt 0 ] || fail_step verify "no tickets readable"
if ! board_check; then fail_step verify "board endpoint failed: $(cat "$TMP/board.err" 2>/dev/null || echo unknown)"; fi
record verify completed "storage=sqlite; sqlite verify ok; v2 chatSessionId set; cognition/chat non-empty; topics migrated; tickets=$TICKETS; board ok"

finalize "deployed" "" "$BACKUP_DIR" "$PROFILE_BACKUP"
log "DEPLOYED successfully"
exit 0
