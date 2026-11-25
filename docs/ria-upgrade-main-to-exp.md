# Ria main → exp 升级说明（可转交外部 Agent）

> 本文是自包含操作手册。除特别说明外，命令中的 `<repo>`、`<备份路径>`、`<ts>`、`<host>:<port>`、`<profile 目录>` 都是占位符，执行前必须替换为实际值。本文不假设当前机器路径、端口或 profile 布局。

## A. 前置检查与完整备份

### A.1 确认当前在 main 并记录 HEAD

```bash
cd <repo>
git rev-parse --abbrev-ref HEAD        # 期望 main
git rev-parse HEAD                     # 记为 MAIN_HEAD
git status --porcelain=v1              # 先记录，不要覆盖未提交改动
git fetch origin --prune
git rev-parse origin/main              # 记录远端 main
```

若不是 `main`，先切回并确认工作树状态：

```bash
git checkout main
git pull --ff-only origin main
```

把 `MAIN_HEAD` 写入本次操作记录，回滚时要用它比对。

### A.2 完整备份 state

先确认没有活跃工单（见 E 节）；能停 Ria 时优先停机备份。至少完整保留以下内容：

```bash
STATE_DIR="$HOME/.dsh/state/ria"
BACKUP_ROOT="<备份路径>"
TS="<ts>"
mkdir -p "$BACKUP_ROOT"

# 目录整份复制（不要删源目录）
cp -a "$STATE_DIR" "$BACKUP_ROOT/ria-$TS"

# 单独保留控制面与数据库副本，便于快速回滚
cp -a "$STATE_DIR/state.json" "$BACKUP_ROOT/state-$TS.json"
cp -a "$STATE_DIR/ria.sqlite" "$BACKUP_ROOT/ria-$TS.sqlite"

# 备份库完整性必须是 ok
sqlite3 -readonly "$BACKUP_ROOT/ria-$TS/ria.sqlite" 'PRAGMA integrity_check;'

# 记录原始与备份的 sha256/大小
sha256sum "$STATE_DIR/state.json" "$STATE_DIR/ria.sqlite" \
  "$BACKUP_ROOT/state-$TS.json" "$BACKUP_ROOT/ria-$TS.sqlite"
stat -c '%s %y %n' "$STATE_DIR/state.json" "$STATE_DIR/ria.sqlite" \
  "$BACKUP_ROOT/state-$TS.json" "$BACKUP_ROOT/ria-$TS.sqlite"
```

要求：

- `PRAGMA integrity_check` 输出必须为 `ok`；
- 备份路径和时间戳写进操作记录；
- 备份目录在数据核对完成前**不要删除**；
- 如果 Ria 仍在线且有 WAL，优先停机后复制，或使用 `sqlite3 "$STATE_DIR/ria.sqlite" ".backup '$BACKUP_ROOT/ria-$TS.sqlite'"` 并同时保留 WAL/SHM；不要用热库的不完整副本做唯一备份。

### A.3 记录 profile 的 dsh-ria 形态

```bash
ls -ld "<profile 目录>/node_modules/dsh-ria"
readlink -f "<profile 目录>/node_modules/dsh-ria"
stat -c '%d:%i %s %n' "<profile 目录>/node_modules/dsh-ria"
```

明确记录它是：

- symlink：升级/回滚后必须重新指向新目录；
- 实物拷贝：`dsh plugin add` 可能复制旧内容，必须用 `diff -rq` 或双侧 sha256 验证。

## B. 升级 5 步

### 1. 停用 Ria

先确认没有活跃工单；停止正在工作的 turn 会被 dispose，未完成的对话可能丢失上下文。

```bash
# 查找用户级单元（不同安装可能是不同 unit 名）
systemctl --user list-units --all | grep -i ria
systemctl --user stop <unit>
# 若是通过 supervisor/daemon 管理，先停 supervisor，再停 web
# systemctl --user stop <supervisor-unit>
# systemctl --user stop <web-unit>
```

如果不用 systemd，用实际进程管理器/pid 文件停止 web；不要用模糊的 `pkill` 杀其它进程。记录停止前的 web PID。

### 2. 目录改名备份（不要删）

```bash
cd <repo>/..
mv <repo> <repo>.bak-<ts>
```

**不要删除 `<repo>.bak-<ts>`**；后续回滚依赖它。

### 3. 安装 exp 分支并重新链接 profile

方式一（干净 clone）：

```bash
git clone -b exp <repo-url> <repo>
```

方式二（在原有工作树切换；注意不要丢失本地未提交改动）：

```bash
cd <repo>
git fetch origin
git checkout exp
git pull --ff-only origin exp
```

重新安装/链接 profile：

```bash
# 具体命令按 DSH 安装方式选择；file: 后缀指向 exp 目录
dsh plugin add file:<repo>
```

**关键校验**：`dsh plugin add` 返回 0 **不代表** profile 内 `node_modules/dsh-ria` 已经是 exp 内容；若 profile 是实物拷贝，旧副本可能仍在：

```bash
diff -rq "<profile 目录>/node_modules/dsh-ria" <repo>
# 或者对关键文件比较 sha256
sha256sum "<profile 目录>/node_modules/dsh-ria/lib/client.js" <repo>/lib/client.js
```

不一致时删除 profile 内的旧副本（确认路径后再删）并重新 `dsh plugin add file:<repo>`；如果 profile 是 symlink，确认它指向 `<repo>`。

### 4. 启动 Ria 并做两个 HTTP 检查

```bash
# 按实际安装方式启动 web / 对应 systemd unit
# systemctl --user start <web-unit>
# 或 dsh web --port <host>:<port>

curl -s -o /dev/null -w '%{http_code}\n' http://<host>:<port>/health
curl -s -o /dev/null -w '%{http_code}\n' http://<host>:<port>/plugins/dsh-ria/api/executors
```

两个 HTTP 状态码都必须为 `200`；若为 000，先检查进程、端口、防火墙和启动日志，不要继续做数据恢复。

### 5. 确认版本为 exp HEAD

```bash
git -C <repo> log --oneline -1
git -C <repo> rev-parse HEAD
git ls-remote origin refs/heads/exp
```

记录的 `<repo> HEAD` 必须与远端 `refs/heads/exp` 相同；如果本地已 checkout exp 但不是最新，先 `git pull --ff-only origin exp`。

## C. 数据恢复

Ria 自带迁移/导入能力，升级后由 Ria 自己处理数据（不要手工覆盖在线库）。把下面整段原话复制给 Ria：

```text
我刚把 Ria 从 main 升级到 exp。旧数据在 <备份路径>/ria-<ts>。请尽可能多地从备份目录恢复数据（工单、主题、认知、协管登记、执行者标签等），能自动就自动，需要我确认的先列清单。恢复前请先只读盘点备份库，不要直接覆盖在线库；完成后把工单、主题、认知条目、执行者的数量与备份并排对比，并告诉我哪些恢复成功、哪些需要确认。
```

### C.1 数量对比（表名以实际 schema 为准）

先列出备份库和在线库的真实表名，不要猜表名：

```bash
sqlite3 -readonly "<备份路径>/ria-<ts>/ria.sqlite" '.tables'
sqlite3 -readonly "$HOME/.dsh/state/ria/ria.sqlite" '.tables'
```

按实际表名替换下列占位符后，对备份库与在线库并排计数：

```bash
# 工单
sqlite3 -readonly "<备份路径>/ria-<ts>/ria.sqlite" 'SELECT COUNT(*) FROM <工单表>;'
sqlite3 -readonly "$HOME/.dsh/state/ria/ria.sqlite" 'SELECT COUNT(*) FROM <工单表>;'

# 主题
sqlite3 -readonly "<备份路径>/ria-<ts>/ria.sqlite" 'SELECT COUNT(*) FROM <主题表>;'
sqlite3 -readonly "$HOME/.dsh/state/ria/ria.sqlite" 'SELECT COUNT(*) FROM <主题表>;'

# 认知条目
sqlite3 -readonly "<备份路径>/ria-<ts>/ria.sqlite" 'SELECT COUNT(*) FROM <认知条目表>;'
sqlite3 -readonly "$HOME/.dsh/state/ria/ria.sqlite" 'SELECT COUNT(*) FROM <认知条目表>;'

# 执行者
sqlite3 -readonly "<备份路径>/ria-<ts>/ria.sqlite" 'SELECT COUNT(*) FROM <执行者表>;'
sqlite3 -readonly "$HOME/.dsh/state/ria/ria.sqlite" 'SELECT COUNT(*) FROM <执行者表>;'
```

记录每组“备份 / 在线 / 差额”。差额必须由 Ria 清单解释；不要在没有核对的情况下删除备份。

## D. 回滚

```bash
# 1) 停 web / systemd 单元
systemctl --user stop <web-unit>

# 2) 保留 exp 目录，恢复 main 备份目录
cd <repo>/..
mv <repo> <repo>.exp-<ts>
mv <repo>.bak-<ts> <repo>

# 3) 重新链接 profile 到恢复目录
dsh plugin add file:<repo>
# 或重建 symlink；必须确认指向 <repo>
ls -ld "<profile 目录>/node_modules/dsh-ria"

# 4) 启动并验证
# systemctl --user start <web-unit>
curl -s -o /dev/null -w '%{http_code}\n' http://<host>:<port>/health
curl -s -o /dev/null -w '%{http_code}\n' http://<host>:<port>/plugins/dsh-ria/api/executors

# 5) 版本回到 MAIN_HEAD
git -C <repo> log --oneline -1
git -C <repo> rev-parse HEAD
```

回滚后两个接口必须均为 `200`，且 HEAD 必须等于升级前记录的 `MAIN_HEAD`。不要删除 `<repo>.bak-<ts>` 或 `<repo>.exp-<ts>`，直到确认恢复完成。

## E. 注意事项

- **备份不要删**：`<repo>.bak-<ts>` 与 `<备份路径>/ria-<ts>` 在工单数、主题数、认知条目数、执行者数全部核对完成前必须保留。
- **profile symlink**：升级和回滚都必须重新指向实际目录；只改目录不改 symlink 会继续跑旧代码。
- **实物拷贝陷阱**：`dsh plugin add file:` 成功不代表 profile 内代码更新；用 `diff -rq` 或双侧 sha256 复核。
- **活跃工单**：停止前先确认没有正在执行的 turn；必须停时先记录 ticketId/状态，避免直接 dispose 未完成工作。
- **停止/启动分离**：不要在一次长等待中依赖会被 dispose 的执行回合完成升级；先停、再换目录、再启动、再独立验证。
- **nvm/PATH**：文档中的 `dsh` 应按安装方式使用绝对路径（例如 nvm 的 `<node-bin>/dsh`），不要在 systemd 单元里假设交互 shell 的 PATH。
- **bus 不可用**：`systemctl --user` 报 `Failed to connect to bus` 时不要用猜测的进程名强杀生产服务；停止升级并报告原始 stderr。
- **不改无关文件**：升级/回滚窗口只处理 Ria 目录、profile 链接、state 备份，不做迁移以外的业务变更。

## 检查清单

- [ ] 已在 main 记录 `MAIN_HEAD`
- [ ] state 目录 + state.json + ria.sqlite 已完整备份
- [ ] 备份库 `PRAGMA integrity_check` 为 `ok`
- [ ] 已记录备份 sha256/大小与 profile dsh-ria 是 symlink 还是实物拷贝
- [ ] 已确认无活跃工单并停止 Ria
- [ ] `<repo>` 已改名为 `<repo>.bak-<ts>`，未删除
- [ ] 已安装 exp 且 `git log --oneline -1` 为远端 exp HEAD
- [ ] profile 实际内容已用 diff/sha256 核对（不是只看安装命令退出码）
- [ ] `/health` 与 `/plugins/dsh-ria/api/executors` 均为 200
- [ ] 工单/主题/认知条目/执行者数量已与备份库并排对比
- [ ] 恢复清单中需要人工确认的项目已记录
- [ ] 备份目录与旧目录仍保留，直到核对完成
