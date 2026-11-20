#!/usr/bin/env bash
# Host-side collect window: backup -> stop -> domains migration -> deploy -> start -> verify.
# Must run from a systemd user unit, never from inside dsh web.
# Every success/rollback check must require /health 200 AND
# /plugins/dsh-ria/api/state 200 AND /plugins/dsh-ria/api/board 200. Health alone
# is insufficient: a profile with a missing lib/prompts directory can answer
# health while the Ria plugin itself failed to load.
set -uo pipefail
NODE=/home/gkl/.nvm/versions/node/v26.2.0/bin/node
DSH=/home/gkl/.nvm/versions/node/v26.2.0/bin/dsh
DAEMON=/home/gkl/.nvm/versions/node/v26.2.0/bin/dsh-daemon
REPO=/home/gkl/Desktop/vibe_proj/dsh-ria
DSH_HOME=/home/gkl/.dsh
STATE_DIR=/home/gkl/.dsh/state/ria
PROFILE=/home/gkl/.dsh/profiles/web/node_modules/dsh-ria
PORT=3080
HEALTH_URL=
RESULT=/home/gkl/.dsh/state/ria-maintenance-result-collect2.json
LOG=/home/gkl/.dsh/state/ria-collect2-window.log
BACKUP_ROOT=/home/gkl/.dsh/state
STOP_CMD=
START_CMD=
DEPLOY_CMD=
NO_DEPLOY=0
FAIL_AT=
EXPECT_TOPICS=28
EXPECT_LINKS=306
EXPECT_LESSONS=8
EXPECT_BOARD_TOPICS=8
EXPECT_BOARD_TOTAL=256
while [ $# -gt 0 ]; do
  case "$1" in
    --dsh-home) DSH_HOME="$2"; shift 2 ;;
    --state-dir) STATE_DIR="$2"; shift 2 ;;
    --repo) REPO="$2"; shift 2 ;;
    --profile) PROFILE="$2"; shift 2 ;;
    --port) PORT="$2"; shift 2 ;;
    --health-url) HEALTH_URL="$2"; shift 2 ;;
    --result) RESULT="$2"; shift 2 ;;
    --log) LOG="$2"; shift 2 ;;
    --backup-root) BACKUP_ROOT="$2"; shift 2 ;;
    --stop-cmd) STOP_CMD="$2"; shift 2 ;;
    --start-cmd) START_CMD="$2"; shift 2 ;;
    --deploy-cmd) DEPLOY_CMD="$2"; shift 2 ;;
    --no-deploy) NO_DEPLOY=1; shift ;;
    --fail-at) FAIL_AT="$2"; shift 2 ;;
    --expect-topics) EXPECT_TOPICS="$2"; shift 2 ;;
    --expect-links) EXPECT_LINKS="$2"; shift 2 ;;
    --expect-lessons) EXPECT_LESSONS="$2"; shift 2 ;;
    --expect-board-topics) EXPECT_BOARD_TOPICS="$2"; shift 2 ;;
    --expect-board-total) EXPECT_BOARD_TOTAL="$2"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
if [ -z "$HEALTH_URL" ]; then HEALTH_URL="http://127.0.0.1:$PORT/health"; fi
if [ -z "$STOP_CMD" ]; then STOP_CMD="$DAEMON stop"; fi
if [ -z "$START_CMD" ]; then START_CMD="$DAEMON start"; fi
mkdir -p "$(dirname "$LOG")" "$(dirname "$RESULT")"
exec >>"$LOG" 2>&1
TS=$(date +%Y%m%dT%H%M%S)
BACKUP="$BACKUP_ROOT/ria-backup-collect2-$TS"
PROFILE_TGZ="$BACKUP/profile-dsh-ria.tgz"
STEPS="$BACKUP/steps.tsv"
CONCLUSION=running
FAILED_STEP=
CURRENT=
STARTED=$(date +%s)
log(){ printf '[%s] %s\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')" "$*"; }
step(){ CURRENT="$1"; log "STEP $CURRENT"; }
ok(){ printf '%s\tok\t%s\n' "$CURRENT" "$1" >>"$STEPS"; log "OK $CURRENT: $1"; }
fail(){ printf '%s\tfailed\t%s\n' "$CURRENT" "$1" >>"$STEPS"; log "FAIL $CURRENT: $1"; FAILED_STEP="$CURRENT"; rollback "$1"; exit 1; }
maybe_fail(){ if [ "$FAIL_AT" = "$1" ]; then fail "injected failure at $1"; fi; }

write_result(){
  python3 - "$RESULT" "$STEPS" "$BACKUP" "$CONCLUSION" "$FAILED_STEP" "$(date +%s)" "$STARTED" "$TS" <<'PY'
import json,os,sys
path,steps,backup,conclusion,failed,now,started,ts=sys.argv[1:9]
rows=[]
if os.path.exists(steps):
    for line in open(steps,encoding='utf-8'):
        parts=line.rstrip('\n').split('\t')
        if len(parts)>=3: rows.append({'name':parts[0],'status':parts[1],'message':'\t'.join(parts[2:])})
data={'conclusion':conclusion,'failedStep':failed or None,'backupDir':backup,'startedAt':int(started),'finishedAt':int(now),
      'durationSeconds':int(now)-int(started),'windowTimestamp':ts,'steps':rows}
tmp=path+'.tmp'
open(tmp,'w',encoding='utf-8').write(json.dumps(data,ensure_ascii=False,indent=2)+'\n')
os.replace(tmp,path)
PY
}

wait_health(){ local i; for i in $(seq 1 "$1"); do if curl -fsS --max-time 3 "$HEALTH_URL" >/dev/null 2>&1; then return 0; fi; sleep 1; done; return 1; }
wait_stopped(){ local i pid; for i in $(seq 1 30); do pid=""; [ -f "$DSH_HOME/daemon/.dsh-web.pid" ] && pid=$(cat "$DSH_HOME/daemon/.dsh-web.pid" 2>/dev/null); if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then sleep 1; continue; fi; if ! curl -fsS --max-time 2 "$HEALTH_URL" >/dev/null 2>&1; then return 0; fi; sleep 1; done; return 1; }

rollback(){
  local reason="$1"
  CONCLUSION=rolled_back
  set +e
  log "ROLLBACK start: $reason"
  eval "$STOP_CMD" >/dev/null 2>&1 || true
  wait_stopped || true
  if [ -f "$BACKUP/ria/ria.json" ]; then
    rm -rf "$STATE_DIR"
    mkdir -p "$STATE_DIR"
    cp -a "$BACKUP/ria/." "$STATE_DIR/"
    printf 'rollback\tok\tstate restored from %s\n' "$BACKUP/ria" >>"$STEPS"
  else
    printf 'rollback\tfailed\tno state backup\n' >>"$STEPS"
  fi
  if [ -f "$PROFILE_TGZ" ]; then
    rm -rf "$PROFILE"
    mkdir -p "$(dirname "$PROFILE")"
    tar -xzf "$PROFILE_TGZ" -C "$(dirname "$PROFILE")"
    printf 'rollback\tok\tprofile restored from %s\n' "$PROFILE_TGZ" >>"$STEPS"
  fi
  eval "$START_CMD" >/dev/null 2>&1 || true
  local rollback_ok=1
  if wait_health 60; then printf 'rollback\tok\thealth 200\n' >>"$STEPS"; else printf 'rollback\tfailed\thealth timeout\n' >>"$STEPS"; rollback_ok=0; fi
  local state_code board_code
  state_code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "http://127.0.0.1:$PORT/plugins/dsh-ria/api/state" 2>/dev/null || true)
  if [ "$state_code" = 200 ]; then printf 'rollback\tok\tstate 200\n' >>"$STEPS"; else printf 'rollback\tfailed\tstate %s\n' "${state_code:-000}" >>"$STEPS"; rollback_ok=0; fi
  board_code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "http://127.0.0.1:$PORT/plugins/dsh-ria/api/board" 2>/dev/null || true)
  if [ "$board_code" = 200 ]; then printf 'rollback\tok\tboard 200\n' >>"$STEPS"; else printf 'rollback\tfailed\tboard %s\n' "${board_code:-000}" >>"$STEPS"; rollback_ok=0; fi
  if [ "$rollback_ok" = 1 ]; then
    CONCLUSION=rolled_back
    log "ROLLBACK done: $CONCLUSION (health/state/board 200)"
  else
    CONCLUSION=rolled_back_degraded
    if [ "$state_code" != 200 ]; then
      log "插件未加载（/api/state 非 200，HTTP ${state_code:-000}）"
    else
      log "插件未加载（回滚后 health/board 非 200）"
    fi
    log "ROLLBACK done: $CONCLUSION"
  fi
  write_result
}

mkdir -p "$BACKUP"
: >"$STEPS"
log "collect window start repo=$REPO state=$STATE_DIR profile=$PROFILE port=$PORT failAt=$FAIL_AT"

step baseline
HEAD=$(git -C "$REPO" rev-parse HEAD 2>/dev/null || echo unknown)
for sha in 7e836d5 2882660 1bf31c0 0acc153 bbd5980 3570cf9; do
  git -C "$REPO" merge-base --is-ancestor "$sha" HEAD || fail "HEAD $HEAD missing commit $sha"
done
curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$HEALTH_URL" >"$BACKUP/health-before.txt"
curl -s -o /dev/null -w '%{http_code}' --max-time 5 "http://127.0.0.1:$PORT/plugins/dsh-ria/api/state" >"$BACKUP/state-before-code.txt" 2>/dev/null || true
curl -s -o /dev/null -w '%{http_code}' --max-time 5 "http://127.0.0.1:$PORT/plugins/dsh-ria/api/board" >"$BACKUP/board-before-code.txt" 2>/dev/null || true
printf '%s\n' "$HEAD" >"$BACKUP/head.txt"
sha256sum "$STATE_DIR/state.json" "$STATE_DIR/ria.json" "$STATE_DIR/ria.sqlite" >"$BACKUP/sha256-before.txt" 2>/dev/null || true
"$NODE" "$REPO/scripts/sqlite-verify.mjs" --state-dir "$STATE_DIR" >"$BACKUP/verify-before.json" 2>&1 || true
ok "HEAD $HEAD; health $(cat "$BACKUP/health-before.txt") state $(cat "$BACKUP/state-before-code.txt") board $(cat "$BACKUP/board-before-code.txt"); hashes in $BACKUP"
maybe_fail baseline

step backup
mkdir -p "$BACKUP/ria"
cp -a "$STATE_DIR/." "$BACKUP/ria/"
COUNT=$(find "$BACKUP/ria" -type f | wc -l)
SIZE=$(du -sh "$BACKUP/ria" | awk '{print $1}')
printf '%s files=%s size=%s\n' "$BACKUP/ria" "$COUNT" "$SIZE" >"$BACKUP/backup.txt"
if [ -d "$PROFILE" ]; then
  tar -czf "$PROFILE_TGZ" -C "$(dirname "$PROFILE")" "$(basename "$PROFILE")" || fail "profile backup failed"
  printf 'profile %s %s\n' "$PROFILE_TGZ" "$(sha256sum "$PROFILE_TGZ" | awk '{print $1}')" >>"$BACKUP/backup.txt"
fi
ok "backup $BACKUP/ria files=$COUNT size=$SIZE profile=$([ -f "$PROFILE_TGZ" ] && echo tgz || echo none)"
maybe_fail backup

step stop
eval "$STOP_CMD" || fail "stop command failed"
if ! wait_stopped; then fail "web still running after 30s"; fi
ok "service stopped"

step dry-run
"$NODE" "$REPO/scripts/sqlite-migrate-domains.mjs" --state-dir "$STATE_DIR" --dry-run >"$BACKUP/domains-dry.json" 2>&1 || fail "domain dry-run failed"
python3 - "$BACKUP/domains-dry.json" "$EXPECT_TOPICS" "$EXPECT_LINKS" "$EXPECT_LESSONS" <<'PY'
import json,sys
d=json.load(open(sys.argv[1]))
exp={'topics':int(sys.argv[2]),'topicLinks':int(sys.argv[3]),'lessons':int(sys.argv[4])}
if d.get('counts')!=exp:
    raise SystemExit('dry-run counts %s != expected %s' % (d.get('counts'),exp))
PY
[ $? -eq 0 ] || fail "dry-run counts mismatch"
ok "dry-run counts $(tr '\n' ' ' <"$BACKUP/domains-dry.json")"
maybe_fail dry-run

step migrate
"$NODE" "$REPO/scripts/sqlite-migrate-domains.mjs" --state-dir "$STATE_DIR" >"$BACKUP/domains-migrate.json" 2>&1 || fail "domains migration failed"
ok "domains migration $(tr '\n' ' ' <"$BACKUP/domains-migrate.json")"
maybe_fail migrate

step deploy
if [ -d "$PROFILE" ]; then tar -czf "$PROFILE_TGZ" -C "$(dirname "$PROFILE")" "$(basename "$PROFILE")" || fail "profile backup failed"; fi
rm -rf "$PROFILE"
if [ "$NO_DEPLOY" = 1 ]; then
  :
elif [ -n "$DEPLOY_CMD" ]; then
  eval "$DEPLOY_CMD" || fail "deploy command failed"
else
  "$DSH" plugin --profile web add "file:$REPO" >"$BACKUP/deploy.log" 2>&1 || fail "dsh plugin add failed"
fi
if [ "$NO_DEPLOY" = 0 ]; then
  diff -rq "$REPO/lib" "$PROFILE/lib" >"$BACKUP/diff.txt" 2>&1 || fail "profile lib differs from repo lib"
  for f in lib/state/sqlite/domain-migration.mjs lib/state/naming-migration.mjs lib/state/operation-log.mjs; do
    [ -f "$REPO/$f" ] || continue
    [ -f "$PROFILE/$f" ] || fail "profile missing $f"
    [ "$(sha256sum "$REPO/$f" | awk '{print $1}')" = "$(sha256sum "$PROFILE/$f" | awk '{print $1}')" ] || fail "sha256 mismatch $f"
  done
fi
ok "deployed $PROFILE"
maybe_fail deploy

step start
eval "$START_CMD" || fail "start command failed"
if ! wait_health 60; then fail "health timeout"; fi
ok "health 200"

step verify
"$NODE" "$REPO/scripts/sqlite-verify.mjs" --state-dir "$STATE_DIR" >"$BACKUP/verify-after.json" 2>&1 || fail "sqlite-verify failed"
python3 - "$BACKUP/verify-after.json" "$EXPECT_TOPICS" "$EXPECT_LINKS" "$EXPECT_LESSONS" <<'PY'
import json,sys
d=json.load(open(sys.argv[1]))
if d.get('ok') is not True: raise SystemExit('ok != true')
if d.get('countsMatch') is not True: raise SystemExit('countsMatch != true')
exp={'topics':int(sys.argv[2]),'topicLinks':int(sys.argv[3]),'lessons':int(sys.argv[4])}
dom=d.get('domains') or {}
if dom.get('counts')!=exp or dom.get('issues')!=[]: raise SystemExit('domains %s issues %s' % (dom.get('counts'),dom.get('issues')))
PY
[ $? -eq 0 ] || fail "post verify checks failed"
python3 - "$STATE_DIR/state.json" <<'PY'
import json,sys
d=json.load(open(sys.argv[1]))
if 'tickets' in d or 'ticketMirror' in d: raise SystemExit('state.json still has tickets/ticketMirror')
PY
[ $? -eq 0 ] || fail "state.json still has removed keys"
ls "$STATE_DIR"/v2.json.bak-* >/dev/null 2>&1 || fail "v2.json.bak missing"
curl -s -o "$BACKUP/board.json" -w '%{http_code}' --max-time 10 "http://127.0.0.1:$PORT/plugins/dsh-ria/api/board" >"$BACKUP/board-code.txt"
[ "$(cat "$BACKUP/board-code.txt")" = 200 ] || fail "board not 200"
# Board grouping numbers are informational for collect2: the endpoint returning
# 200 with a parseable payload is the contract; counts legitimately shift when
# topics/links move to the SQLite domains tables.
python3 - "$BACKUP/board.json" "$BACKUP/board-counts.txt" <<'PY'
import json,sys
d=json.load(open(sys.argv[1])); c=d.get('counts') or {}
open(sys.argv[2],'w').write(json.dumps(c,sort_keys=True))
PY
log "board counts $(cat "$BACKUP/board-counts.txt" 2>/dev/null || echo unknown) (informational, expected topics>=$EXPECT_BOARD_TOPICS total>=$EXPECT_BOARD_TOTAL)"
# Success requires all three surfaces, not just health: a healthy web with a
# plugin that failed to load must not pass the window.
STATE_CODE=$(curl -s -o "$BACKUP/state.json.body" -w '%{http_code}' --max-time 10 "http://127.0.0.1:$PORT/plugins/dsh-ria/api/state" 2>/dev/null || true)
[ "$STATE_CODE" = 200 ] || fail "state endpoint not 200 (HTTP ${STATE_CODE:-000}); 插件未加载"
BOARD_CODE=$(cat "$BACKUP/board-code.txt" 2>/dev/null || true)
[ "$BOARD_CODE" = 200 ] || fail "board not 200 (HTTP ${BOARD_CODE:-000}); 插件未加载"
ok "verify ok: health 200, state 200, board 200, domains migrated, state.json clean"

step result
CONCLUSION=ok
write_result
log "collect window success"
exit 0
