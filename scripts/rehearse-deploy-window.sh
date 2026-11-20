#!/usr/bin/env bash
# Rehearsal for scripts/deploy-migrate-window.sh.
# Builds an isolated /tmp DSH_HOME (copied profile + state), runs the window
# script twice: first with an injected post-deploy failure to exercise rollback,
# then a full success run. Never touches ~/.dsh/profile or the live state.
set -uo pipefail
REPO="/home/gkl/Desktop/vibe_proj/dsh-ria"
NODE="/home/gkl/.nvm/versions/node/v26.2.0/bin/node"
BASE="/tmp/ria-deploy-rehearsal-$(date +%Y%m%d-%H%M%S)"
PORT=3199
mkdir -p "$BASE/home/profiles" "$BASE/home/state" || exit 1
cp -a /home/gkl/.dsh/profiles/web "$BASE/home/profiles/web" || exit 1
cp -a /home/gkl/.dsh/state/ria "$BASE/home/state/ria" || exit 1
cp -a /home/gkl/.dsh/.credentials.yaml "$BASE/home/.credentials.yaml" 2>/dev/null || true
cp -a /home/gkl/.dsh/.agent-presets "$BASE/home/.agent-presets" 2>/dev/null || true
cp -a /home/gkl/.dsh/remote-web-ui-devices.json "$BASE/home/" 2>/dev/null || true
cp -a "$BASE/home/state/ria" "$BASE/original-state" || exit 1

stop_temp() {
  if command -v lsof >/dev/null 2>&1; then
    for pid in $(lsof -ti ":$PORT" 2>/dev/null); do kill "$pid" 2>/dev/null || true; done
    sleep 2
    for pid in $(lsof -ti ":$PORT" 2>/dev/null); do kill -9 "$pid" 2>/dev/null || true; done
  fi
}
health() { curl -sS -m 3 -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/health" 2>/dev/null || true; }
check() { node -e "const fs=require('fs');const j=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));if(!($1)){console.error(JSON.stringify(j).slice(0,300));process.exit(1)}" "$2"; }

stop_temp
echo "=== rehearsal base: $BASE ==="
echo "=== 1) injected failure: after-deploy -> rollback ==="
"$REPO/scripts/deploy-migrate-window.sh" --rehearse --dsh-home="$BASE/home" --state="$BASE/home/state/ria"   --profile="$BASE/home/profiles/web" --port="$PORT" --result="$BASE/result-rollback.json"   --inject-failure=after-deploy
RC=$?
echo "rollback run rc=$RC (expected 1)"
echo "--- result-rollback.json ---"; cat "$BASE/result-rollback.json" 2>/dev/null | head -60
echo "--- deploy logs ---"; tail -30 "$BASE/home/deploy-plugin.log" 2>/dev/null; tail -20 "$BASE/home/deploy-web.log" 2>/dev/null
[ "$RC" = "1" ] || { echo "FAIL: injected failure did not exit 1"; exit 1; }
check "j.conclusion==='rolled_back' && j.failedStep==='inject-after-deploy' && j.backupDir" "$BASE/result-rollback.json" || exit 1
[ "$(health)" = "200" ] || { echo "FAIL: /health not 200 after rollback"; exit 1; }
check "j.chatbotSessionId && !j.chatSessionId" "$BASE/home/state/ria/v2.json" || { echo "FAIL: rollback v2 keys"; exit 1; }
check "(j.topics||[]).some(t=>('level' in t)||('parentId' in t))" "$BASE/home/state/ria/ria.json" || { echo "FAIL: rollback topics not restored"; exit 1; }
[ -f "$BASE/home/state/ria/memory.md" ] || { echo "FAIL: rollback memory.md missing"; exit 1; }
[ -d "$BASE/home/state/ria/cognition/chatbot" ] || { echo "FAIL: rollback cognition/chatbot missing"; exit 1; }
echo "rollback checks ok"

stop_temp
echo "=== 2) full success run ==="
"$REPO/scripts/deploy-migrate-window.sh" --rehearse --dsh-home="$BASE/home" --state="$BASE/home/state/ria"   --profile="$BASE/home/profiles/web" --port="$PORT" --result="$BASE/result-deployed.json"
RC=$?
echo "success run rc=$RC"
[ "$RC" = "0" ] || { echo "FAIL: success run rc=$RC"; exit 1; }
check "j.conclusion==='deployed' && j.backupDir && j.profileBackup" "$BASE/result-deployed.json" || exit 1
[ "$(health)" = "200" ] || { echo "FAIL: /health not 200 after deploy"; exit 1; }
check "!!j.chatSessionId && !j.chatbotSessionId" "$BASE/home/state/ria/v2.json" || { echo "FAIL: v2 keys"; exit 1; }
check "(j.topics||[]).every(t=>!('level' in t)&&!('parentId' in t)&&('projectKey' in t)&&Array.isArray(t.tags))" "$BASE/home/state/ria/ria.json" || { echo "FAIL: topics"; exit 1; }
[ -d "$BASE/home/state/ria/cognition/chat" ] || { echo "FAIL: cognition/chat missing"; exit 1; }
[ "$(find "$BASE/home/state/ria/cognition/chat" -type f | wc -l)" -gt 0 ] || { echo "FAIL: cognition/chat empty"; exit 1; }
"$NODE" "$REPO/scripts/sqlite-migrate.mjs" --state-dir "$BASE/home/state/ria" --verify-only > "$BASE/sqlite-verify.json" || { echo "FAIL: sqlite verify rc"; exit 1; }
check "j.ok===true" "$BASE/sqlite-verify.json" || { echo "FAIL: sqlite verify ok"; exit 1; }
TOKEN="$(sed -n 's/.*token=\([^ ]*\).*/\1/p' "$BASE/home/deploy-web.log" | head -1)"
if [ -n "$TOKEN" ]; then curl -sS -m 5 -c "$BASE/cookies" "http://127.0.0.1:$PORT/?token=$TOKEN" -o /dev/null || true; fi
BOARD_CODE="$(curl -sS -m 8 -b "$BASE/cookies" -o "$BASE/board.json" -w '%{http_code}' "http://127.0.0.1:$PORT/plugins/dsh-ria/api/board?limit=5" 2>/dev/null || true)"
echo "board http=$BOARD_CODE"
[ "$BOARD_CODE" = "200" ] || { echo "FAIL: board http $BOARD_CODE"; exit 1; }
check "j.ok===true && (j.tickets||[]).length>0" "$BASE/board.json" || { echo "FAIL: board payload"; exit 1; }
PROFILE="$BASE/home/profiles/web/node_modules/dsh-ria"
[ -f "$PROFILE/lib/v2/roles.mjs" ] || { echo "FAIL: profile roles.mjs"; exit 1; }
[ -f "$PROFILE/scripts/run-tests.mjs" ] || { echo "FAIL: profile run-tests"; exit 1; }
[ "$(sha256sum "$REPO/lib/index.js" | cut -d' ' -f1)" = "$(sha256sum "$PROFILE/lib/index.js" | cut -d' ' -f1)" ] || { echo "FAIL: profile sha"; exit 1; }
echo "deployed checks ok"
stop_temp
echo "=== REHEARSAL PASSED ==="
echo "base=$BASE"
exit 0
