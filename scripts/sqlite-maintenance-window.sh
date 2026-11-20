#!/usr/bin/env bash
# SQLite P1 maintenance window: backup -> stop -> verify -> migrate -> switch
# storage to sqlite -> start -> smoke. Any failure restores ria.json and DB
# files from the pre-window backup, restarts the service, and records the result.
#
# MUST run from a host-side one-shot unit, not from inside the dsh web process:
# stopping dsh-daemon would kill the caller. Example:
#   systemd-run --user --collect --on-active=60s --property=KillMode=process \
#     --unit=ria-sqlite-window-HHMMSS /bin/bash "$0"
#
# Drill hooks (all optional): --dsh-home, --state-dir, --health-url, --state-url,
# --pid-file, --stop-cmd, --start-cmd, --result-file, --log-file, --fail-at.
set -euo pipefail
export PATH="/home/gkl/.nvm/versions/node/v26.2.0/bin:$PATH"

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NODE_BIN="/home/gkl/.nvm/versions/node/v26.2.0/bin/node"
DAEMON_BIN="/home/gkl/.nvm/versions/node/v26.2.0/bin/dsh-daemon"
DSH_HOME=""
STATE_DIR=""
PORT=3080
HEALTH_URL=""
STATE_URL=""
PID_FILE=""
STOP_CMD=""
START_CMD=""
RESULT_FILE=""
LOG_FILE=""
FAIL_AT=""
DRY_RUN=0
UNIT_NAME=""
BACKUP_DIR_OVERRIDE=""
EXPECTED_DOWNTIME="窗口开始后约 3–5 分钟服务不可用"

usage() {
  cat <<'USAGE'
Usage: sqlite-maintenance-window.sh [options]
  --dsh-home DIR       DSH home (default: $HOME/.dsh)
  --state-dir DIR      Ria state dir (default: <dsh-home>/state/ria)
  --port N             web port (default: 3080)
  --health-url URL     health endpoint (default: http://127.0.0.1:<port>/health)
  --state-url URL      plugin state endpoint (default: .../plugins/dsh-ria/api/state)
  --pid-file FILE      dsh web pid file (default: <dsh-home>/daemon/.dsh-web.pid)
  --stop-cmd CMD       command to stop service (default: dsh-daemon stop)
  --start-cmd CMD      command to start service (default: dsh-daemon start)
  --result-file FILE   result JSON (default: <dsh-home>/state/ria-maintenance-result.json)
  --log-file FILE      log file (default: <dsh-home>/state/ria-maintenance-window.log)
  --unit NAME          transient unit name recorded in the result
  --backup-dir DIR     explicit backup directory (default: timestamped)
  --fail-at STEP       drill only: inject failure after STEP
  --dry-run            print the plan and exit without touching the service
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --dsh-home) DSH_HOME="$2"; shift 2 ;;
    --state-dir) STATE_DIR="$2"; shift 2 ;;
    --port) PORT="$2"; shift 2 ;;
    --health-url) HEALTH_URL="$2"; shift 2 ;;
    --state-url) STATE_URL="$2"; shift 2 ;;
    --pid-file) PID_FILE="$2"; shift 2 ;;
    --stop-cmd) STOP_CMD="$2"; shift 2 ;;
    --start-cmd) START_CMD="$2"; shift 2 ;;
    --result-file) RESULT_FILE="$2"; shift 2 ;;
    --log-file) LOG_FILE="$2"; shift 2 ;;
    --unit) UNIT_NAME="$2"; shift 2 ;;
    --backup-dir) BACKUP_DIR_OVERRIDE="$2"; shift 2 ;;
    --fail-at) FAIL_AT="$2"; shift 2 ;;
    --fail-at=*) FAIL_AT="${1#*=}"; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

if [ -z "$DSH_HOME" ]; then DSH_HOME="$HOME/.dsh"; fi
if [ -z "$STATE_DIR" ]; then STATE_DIR="$DSH_HOME/state/ria"; fi
if [ -z "$HEALTH_URL" ]; then HEALTH_URL="http://127.0.0.1:$PORT/health"; fi
if [ -z "$STATE_URL" ]; then STATE_URL="http://127.0.0.1:$PORT/plugins/dsh-ria/api/state"; fi
if [ -z "$PID_FILE" ]; then PID_FILE="$DSH_HOME/daemon/.dsh-web.pid"; fi
if [ -z "$STOP_CMD" ]; then STOP_CMD="$DAEMON_BIN stop"; fi
if [ -z "$START_CMD" ]; then START_CMD="$DAEMON_BIN start"; fi
if [ -z "$RESULT_FILE" ]; then RESULT_FILE="$DSH_HOME/state/ria-maintenance-result.json"; fi
if [ -z "$LOG_FILE" ]; then LOG_FILE="$DSH_HOME/state/ria-maintenance-window.log"; fi
STORAGE_FILE="$STATE_DIR/ria.json"

mkdir -p "$(dirname "$LOG_FILE")" "$(dirname "$RESULT_FILE")"
exec >>"$LOG_FILE" 2>&1
log() { printf '[%s] %s\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')" "$*"; }

jsonq() { python3 -c 'import json,sys; print(json.dumps(sys.argv[1]))' "$1"; }

STEPS_FILE="$DSH_HOME/state/.ria-maintenance-steps.$$.jsonl"
ROLLBACK_FILE="$DSH_HOME/state/.ria-maintenance-rollback.$$.jsonl"
: > "$STEPS_FILE"
: > "$ROLLBACK_FILE"
CURRENT_STEP=0
CURRENT_NAME=""
CURRENT_START=""
RB_STATUS="not-needed"
RB_MESSAGE=""
CONCLUSION=""
FAILED_STEP=""
GIT_HEAD=""
STORAGE_BEFORE=""
STORAGE_AFTER=""
BACKUP_DIR=""
PRE_SWITCH_COPY=""
STATE_SIZE_BEFORE=""
NODE_VERSION=""
RESOLVED_NODE_PATH=""
DB_CREATED=0
SERVICE_STOPPED=0
CONFIG_CHANGED=0
MIGRATION_STARTED=0
ROLLING_BACK=0
START_TIME="$(date '+%Y-%m-%dT%H:%M:%S%z')"
TOTAL_STEPS=9

record_step() {
  python3 -c 'import json,sys
with open(sys.argv[1],"a",encoding="utf-8") as f:
 f.write(json.dumps({"step":int(sys.argv[2]),"name":sys.argv[3],"status":sys.argv[4],"startedAt":sys.argv[5],"endedAt":sys.argv[6],"message":sys.argv[7]},ensure_ascii=False)+"\n")' "$STEPS_FILE" "$1" "$2" "$3" "$4" "$5" "$6"
}

step_start() {
  CURRENT_STEP=$((CURRENT_STEP + 1))
  CURRENT_NAME="$1"
  CURRENT_START="$(date '+%Y-%m-%dT%H:%M:%S%z')"
  record_step "$CURRENT_STEP" "$CURRENT_NAME" running "$CURRENT_START" "" ""
  log "STEP $CURRENT_STEP/$TOTAL_STEPS: $CURRENT_NAME"
}
step_end() {
  local status="$1" message="$2" ended
  ended="$(date '+%Y-%m-%dT%H:%M:%S%z')"
  python3 -c 'import json,sys
path, step, status, ended, message = sys.argv[1], int(sys.argv[2]), sys.argv[3], sys.argv[4], sys.argv[5]
rows=[]
with open(path,encoding="utf-8") as f:
 for line in f:
  if line.strip(): rows.append(json.loads(line))
for row in rows:
 if row["step"]==step:
  row["status"]=status; row["endedAt"]=ended; row["message"]=message
with open(path,"w",encoding="utf-8") as f:
 for row in rows: f.write(json.dumps(row,ensure_ascii=False)+"\n")' "$STEPS_FILE" "$CURRENT_STEP" "$status" "$ended" "$message"
  log "STEP $CURRENT_STEP $status: $message"
}
step_ok() { step_end ok "$1"; }
step_skip() { step_end skipped "$1"; }
step_fail() { step_end failed "$1"; }

rb_action() {
  python3 -c 'import json,sys
with open(sys.argv[1],"a",encoding="utf-8") as f: f.write(json.dumps({"action":sys.argv[2],"message":sys.argv[3]},ensure_ascii=False)+"\n")' "$ROLLBACK_FILE" "$1" "$2"
  log "ROLLBACK [$1] $2"
}

wait_health() {
  local timeout="$1" i
  for ((i = 1; i <= timeout; i++)); do
    if curl -fsS --max-time 3 "$HEALTH_URL" >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  return 1
}

wait_stopped() {
  local timeout="$1" i pid
  for ((i = 1; i <= timeout; i++)); do
    pid=""
    if [ -f "$PID_FILE" ]; then pid="$(cat "$PID_FILE" 2>/dev/null)"; fi
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then sleep 1; continue; fi
    if ! curl -fsS --max-time 2 "$HEALTH_URL" >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  return 1
}

check_web_env() {
  local pid envline value
  pid=""
  if [ -f "$PID_FILE" ]; then pid="$(cat "$PID_FILE" 2>/dev/null)"; fi
  if [ -z "$pid" ] || [ ! -r "/proc/$pid/environ" ]; then return 0; fi
  envline="$(tr '\0' '\n' <"/proc/$pid/environ" 2>/dev/null | grep '^DSH_RIA_STORAGE=' | head -1 || true)"
  if [ -z "$envline" ]; then return 0; fi
  value="${envline#DSH_RIA_STORAGE=}"
  value="$(printf '%s' "$value" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
  if [ -z "$value" ]; then return 0; fi
  printf '%s' "$value"
}

write_result() {
  local meta
  meta=$(cat <<EOF
{
  "schemaVersion": 1,
  "conclusion": $(jsonq "$CONCLUSION"),
  "startedAt": $(jsonq "$START_TIME"),
  "finishedAt": $(jsonq "$(date '+%Y-%m-%dT%H:%M:%S%z')"),
  "expectedDowntime": $(jsonq "$EXPECTED_DOWNTIME"),
  "unit": $(jsonq "$UNIT_NAME"),
  "gitHead": $(jsonq "$GIT_HEAD"),
  "nodeVersion": $(jsonq "$NODE_VERSION"),
  "resolvedNodePath": $(jsonq "$RESOLVED_NODE_PATH"),
  "PATH": $(jsonq "$PATH"),
  "repoRoot": $(jsonq "$REPO_ROOT"),
  "dshHome": $(jsonq "$DSH_HOME"),
  "stateDir": $(jsonq "$STATE_DIR"),
  "backupDir": $(jsonq "$BACKUP_DIR"),
  "storageConfigPath": $(jsonq "$STORAGE_FILE"),
  "storageBefore": $(jsonq "$STORAGE_BEFORE"),
  "storageAfter": $(jsonq "$STORAGE_AFTER"),
  "preSwitchCopy": $(jsonq "$PRE_SWITCH_COPY"),
  "stateSizeBefore": $(jsonq "$STATE_SIZE_BEFORE"),
  "dbCreatedByWindow": $DB_CREATED,
  "failedStep": $(jsonq "$FAILED_STEP"),
  "rollbackStatus": $(jsonq "$RB_STATUS"),
  "rollbackMessage": $(jsonq "$RB_MESSAGE")
}
EOF
)
  printf '%s' "$meta" | python3 -c '
import json, os, sys, tempfile
path, steps_path, rb_path = sys.argv[1], sys.argv[2], sys.argv[3]
meta = json.load(sys.stdin)
def rows(p):
    if not os.path.exists(p): return []
    with open(p, encoding="utf-8") as f:
        return [json.loads(line) for line in f if line.strip()]
meta["steps"] = rows(steps_path)
meta["rollbackActions"] = rows(rb_path)
fd, tmp = tempfile.mkstemp(prefix=".ria-maintenance-result.", dir=os.path.dirname(path))
try:
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        json.dump(meta, handle, ensure_ascii=False, indent=2)
        handle.write("\n")
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(tmp, path)
finally:
    if os.path.exists(tmp): os.unlink(tmp)
' "$RESULT_FILE" "$STEPS_FILE" "$ROLLBACK_FILE"
  log "RESULT written: $RESULT_FILE"
}

rollback() {
  if [ "$ROLLING_BACK" = 1 ]; then return 0; fi
  ROLLING_BACK=1
  # Nothing was backed up, stopped, migrated or switched: treat as no-op.
  if [ -z "$BACKUP_DIR" ] && [ "$SERVICE_STOPPED" = 0 ] && [ "$MIGRATION_STARTED" = 0 ] && [ "$CONFIG_CHANGED" = 0 ]; then
    RB_STATUS="no-op"
    RB_MESSAGE="no changes were made by this window; rollback is a no-op"
    log "ROLLBACK no-op: $RB_MESSAGE"
    return 0
  fi
  RB_STATUS="attempted"
  log "ROLLBACK start"
  set +e
  if [ -n "$BACKUP_DIR" ] && [ -f "$BACKUP_DIR/ria.json" ]; then
    if [ -n "$PRE_SWITCH_COPY" ] && [ -f "$PRE_SWITCH_COPY" ]; then
      cp -a "$PRE_SWITCH_COPY" "$STORAGE_FILE"
      rb_action ok "restored exact pre-switch ria.json from $PRE_SWITCH_COPY"
    else
      cp -a "$BACKUP_DIR/ria.json" "$STORAGE_FILE"
      rb_action ok "restored ria.json from backup $BACKUP_DIR"
    fi
    if python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); sys.exit(0 if d.get("storage") in (None,"json") else 1)' "$STORAGE_FILE"; then
      rb_action ok "storage config restored to json/absent"
    else
      rb_action failed "storage config still not json"
    fi
  else
    rb_action failed "no backup ria.json available to restore"
  fi
  if [ "$MIGRATION_STARTED" = 1 ]; then
    if ls "$BACKUP_DIR"/ria.sqlite* >/dev/null 2>&1; then
      cp -a "$BACKUP_DIR"/ria.sqlite* "$STATE_DIR"/ 2>/dev/null
      rb_action ok "restored DB files from backup"
    else
      rm -f "$STATE_DIR"/ria.sqlite "$STATE_DIR"/ria.sqlite-wal "$STATE_DIR"/ria.sqlite-shm "$STATE_DIR"/ria.sqlite.tmp "$STATE_DIR"/ria.sqlite.tmp-wal "$STATE_DIR"/ria.sqlite.tmp-shm
      rb_action ok "removed DB files created by the window; JSON remains authoritative"
    fi
  fi
  if [ "$SERVICE_STOPPED" = 1 ] || ! curl -fsS --max-time 2 "$HEALTH_URL" >/dev/null 2>&1; then
    if eval "$START_CMD"; then rb_action ok "start command executed"; else rb_action failed "start command failed"; fi
    if wait_health 60; then rb_action ok "health returned 200 after rollback"; else rb_action failed "health did not return 200 after rollback"; fi
  else
    rb_action ok "service was not stopped; health already 200"
  fi
  if curl -fsS --max-time 5 "$STATE_URL" >/dev/null 2>&1; then rb_action ok "state endpoint readable after rollback"; else rb_action failed "state endpoint unreadable after rollback"; fi
  set -e
  if python3 -c 'import json,sys; sys.exit(0 if any(json.loads(l).get("action")=="failed" for l in open(sys.argv[1],encoding="utf-8") if l.strip()) else 1)' "$ROLLBACK_FILE"; then
    RB_STATUS="failed"
    RB_MESSAGE="rollback had failures; see rollbackActions"
  else
    RB_STATUS="ok"
    RB_MESSAGE="config restored, DB files handled, service healthy, state readable"
  fi
  log "ROLLBACK $RB_STATUS: $RB_MESSAGE"
}

finish_failure() {
  local message="$1"
  step_fail "$message"
  FAILED_STEP="$CURRENT_NAME"
  CONCLUSION="rolled_back"
  rollback
  if [ "$CURRENT_STEP" -lt 9 ]; then
    step_start "write-result"
  fi
  step_end ok "result written"
  write_result
  if [ "$RB_STATUS" = "no-op" ]; then exit 0; fi
  exit 1
}

maybe_fail() {
  if [ "$FAIL_AT" = "$1" ]; then finish_failure "injected failure at $1 (drill)"; fi
  return 0
}

if [ "$DRY_RUN" = 1 ]; then
  cat <<EOF
DRY RUN
repo=$REPO_ROOT
dshHome=$DSH_HOME
stateDir=$STATE_DIR
storageFile=$STORAGE_FILE
backup=<stateDir parent>/ria-backup-<timestamp>
stop=$STOP_CMD
migrate=$NODE_BIN $REPO_ROOT/scripts/sqlite-migrate.mjs --state-dir $STATE_DIR
nodeBin=$NODE_BIN
resolvedNode=$(command -v node || true)
nodeVersion=$("$NODE_BIN" --version 2>&1 || true)
path=$PATH
start=$START_CMD
health=$HEALTH_URL
state=$STATE_URL
result=$RESULT_FILE
log=$LOG_FILE
failAt=$FAIL_AT
EOF
  exit 0
fi

log "maintenance window start: dshHome=$DSH_HOME stateDir=$STATE_DIR unit=$UNIT_NAME failAt=$FAIL_AT"

# 1. Baseline
step_start "baseline"
if [ ! -f "$STORAGE_FILE" ]; then finish_failure "missing $STORAGE_FILE"; fi
GIT_HEAD="$(git -C "$REPO_ROOT" rev-parse HEAD)"
STORAGE_BEFORE="$(python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); v=d.get("storage"); print("json" if v in (None,"") else str(v))' "$STORAGE_FILE")"
STATE_SIZE_BEFORE="$(du -sh "$STATE_DIR" | awk '{print $1}')"
WEB_ENV_STORAGE="$(check_web_env)"
if [ -n "$WEB_ENV_STORAGE" ]; then
  finish_failure "web process has explicit $WEB_ENV_STORAGE; changing ria.json storage would not take effect"
fi
# Preflight before pre-verify/stop: a systemd unit has a minimal PATH.
RESOLVED_NODE_PATH="$(command -v node || true)"
if [ -z "$RESOLVED_NODE_PATH" ]; then
  finish_failure "preflight failed: node not found in PATH=$PATH (expected /home/gkl/.nvm/versions/node/v26.2.0/bin/node)"
fi
if ! NODE_VERSION="$("$NODE_BIN" --version 2>&1)"; then
  finish_failure "preflight failed: cannot execute node at $NODE_BIN: $NODE_VERSION"
fi
if ! command -v dsh-daemon >/dev/null 2>&1; then
  finish_failure "preflight failed: dsh-daemon not found in PATH=$PATH (expected $DAEMON_BIN)"
fi
step_ok "git=$GIT_HEAD storage=$STORAGE_BEFORE stateSize=$STATE_SIZE_BEFORE node=$NODE_VERSION path=$RESOLVED_NODE_PATH"
maybe_fail baseline

# 2. Backup
step_start "backup"
TS="$(date '+%Y%m%dT%H%M%S')"
if [ -n "$BACKUP_DIR_OVERRIDE" ]; then BACKUP_DIR="$BACKUP_DIR_OVERRIDE"; else BACKUP_DIR="$DSH_HOME/state/ria-backup-$TS"; fi
if [ -e "$BACKUP_DIR" ]; then finish_failure "backup target already exists: $BACKUP_DIR"; fi
mkdir -p "$BACKUP_DIR"
cp -a "$STATE_DIR/." "$BACKUP_DIR/"
for pattern in ria.json v2.json outbox.json 'tickets*.jsonl' 'ria.sqlite*'; do
  for src in "$STATE_DIR"/$pattern; do
    if [ ! -f "$src" ]; then continue; fi
    rel="$(basename "$src")"
    if [ ! -f "$BACKUP_DIR/$rel" ]; then finish_failure "backup missing $rel"; fi
    if [ "$(stat -c%s "$src")" != "$(stat -c%s "$BACKUP_DIR/$rel")" ]; then finish_failure "backup size mismatch for $rel"; fi
  done
done
step_ok "backup=$BACKUP_DIR"
maybe_fail backup

# 3. Stop service
step_start "stop-service"
if ! eval "$STOP_CMD"; then finish_failure "stop command failed: $STOP_CMD"; fi
SERVICE_STOPPED=1
if ! wait_stopped 30; then finish_failure "web process still running or /health still 200 after 30s"; fi
step_ok "service stopped; pid file=$PID_FILE"
maybe_fail stop-service

# 4. Pre-verify (existing DB only; no DB is a valid pre-migration state)
step_start "pre-verify"
set +e
PRE_OUT="$("$NODE_BIN" "$REPO_ROOT/scripts/sqlite-migrate.mjs" --state-dir "$STATE_DIR" --verify-only 2>&1)"
PRE_CODE=$?
set -e
if [ "$PRE_CODE" -eq 0 ]; then
  step_ok "existing DB verified"
elif printf '%s' "$PRE_OUT" | grep -q 'sqlite_missing'; then
  step_skip "no existing DB; pre-verify not applicable (first migration)"
else
  finish_failure "pre-verify failed (exit $PRE_CODE): $(printf '%s' "$PRE_OUT" | tail -3 | tr '\n' ' ')"
fi
maybe_fail pre-verify

# 5. Migrate
step_start "migrate"
MIGRATION_STARTED=1
set +e
MIG_OUT="$("$NODE_BIN" "$REPO_ROOT/scripts/sqlite-migrate.mjs" --state-dir "$STATE_DIR" 2>&1)"
MIG_CODE=$?
set -e
if [ "$MIG_CODE" -ne 0 ]; then finish_failure "migration failed (exit $MIG_CODE): $(printf '%s' "$MIG_OUT" | tail -3 | tr '\n' ' ')"; fi
if [ ! -f "$STATE_DIR/ria.sqlite" ]; then finish_failure "migration returned success but ria.sqlite is missing"; fi
DB_CREATED=1
set +e
VERIFY_OUT="$("$NODE_BIN" "$REPO_ROOT/scripts/sqlite-migrate.mjs" --state-dir "$STATE_DIR" --verify-only 2>&1)"
VERIFY_CODE=$?
set -e
if [ "$VERIFY_CODE" -ne 0 ]; then finish_failure "post-migration verify failed (exit $VERIFY_CODE): $(printf '%s' "$VERIFY_OUT" | tail -3 | tr '\n' ' ')"; fi
step_ok "migrated; ria.sqlite verified"
maybe_fail migrate

# 6. Switch storage
step_start "switch-storage"
PRE_SWITCH_COPY="$BACKUP_DIR/ria.json.pre-storage-switch"
cp -a "$BACKUP_DIR/ria.json" "$PRE_SWITCH_COPY"
if [ "$(sha256sum "$STORAGE_FILE" | awk '{print $1}')" != "$(sha256sum "$PRE_SWITCH_COPY" | awk '{print $1}')" ]; then finish_failure "ria.json changed after backup; refusing to switch"; fi
"$NODE_BIN" --input-type=module -e "import { readFileSync } from 'node:fs'; import { writeAtomic } from '$REPO_ROOT/lib/state/atomic-file.mjs'; const p=process.argv[1]; const d=JSON.parse(readFileSync(p,'utf8')); d.storage='sqlite'; writeAtomic(p, JSON.stringify(d,null,2)+'\n');" "$STORAGE_FILE"
CONFIG_CHANGED=1
STORAGE_AFTER="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("storage"))' "$STORAGE_FILE")"
if [ "$STORAGE_AFTER" != "sqlite" ]; then finish_failure "storage switch did not persist sqlite"; fi
step_ok "storage=sqlite; original copy=$PRE_SWITCH_COPY"
maybe_fail switch-storage

# 7. Start service
step_start "start-service"
if ! eval "$START_CMD"; then finish_failure "start command failed: $START_CMD"; fi
if ! wait_health 60; then finish_failure "health did not return 200 within 60s"; fi
step_ok "health 200"
maybe_fail start-service

# 8. Smoke
step_start "smoke"
SMOKE_FILE="$DSH_HOME/state/ria-maintenance-smoke.json"
if ! curl -fsS --max-time 10 "$STATE_URL" -o "$SMOKE_FILE"; then finish_failure "state endpoint failed"; fi
if ! "$NODE_BIN" --input-type=module -e "
import { readFileSync, existsSync } from 'node:fs';
import { openDatabase } from '$REPO_ROOT/lib/state/sqlite/db.mjs';
import { SqliteTicketAdapter } from '$REPO_ROOT/lib/state/sqlite/adapter.mjs';
const [stateFile, riaFile, dbFile] = process.argv.slice(1);
const state = JSON.parse(readFileSync(stateFile, 'utf8'));
if (!Array.isArray(state.tickets)) throw new Error('state.tickets is not an array');
if (!state.v2 || typeof state.v2 !== 'object') throw new Error('state.v2 missing');
const mirror = JSON.parse(readFileSync(riaFile, 'utf8'));
if (mirror.storage !== 'sqlite') throw new Error('ria.json storage is not sqlite');
if (!existsSync(riaFile)) throw new Error('ria.json mirror missing');
if (!existsSync(dbFile)) throw new Error('ria.sqlite missing');
const db = openDatabase(dbFile, { readOnly: true });
const adapter = new SqliteTicketAdapter(db);
const counts = adapter.counts();
db.close();
if (!counts || counts.tickets <= 0) throw new Error('sqlite DB has no tickets');
if (!counts.hot) throw new Error('sqlite DB has no hot tickets');
if (state.tickets.length > 0 && !state.tickets[0].ticketId) throw new Error('state ticket missing ticketId');
" "$SMOKE_FILE" "$STORAGE_FILE" "$STATE_DIR/ria.sqlite"; then finish_failure "smoke checks failed"; fi
step_ok "state readable; storage=sqlite; DB and ria.json mirror present"
maybe_fail smoke

# 9. Result
step_start "write-result"
CONCLUSION="success"
step_ok "maintenance window completed"
write_result
log "maintenance window success"
exit 0
