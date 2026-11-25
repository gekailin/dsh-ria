# Ria `main` → `exp` 升级说明

核心思路：**停掉 DSH → 把旧代码和旧 state 目录直接 `mv` 走作为只读备份 → 装 `exp` 全新启动 → 让新 Ria 只读读取旧 state 导入数据**。旧目录全程不动，新目录写坏了直接删掉重来，随时可 `mv` 回滚。

> 下文 `<repo>`、`<repo-url>` 替换为实际路径/地址。

---

## 1. 升级步骤

### 1.1 停止 DSH

尽量等当前活跃工单结束再停，避免打断进行中的 turn。按你平时的运行方式停止即可：

- **dsh-desktop**：直接完全退出桌面端应用；
- **命令行 `dsh` / `dsh web`**：在对应终端按 `Ctrl+C` 停止；
- **后台托管**：`dsh-daemon stop` 或 `systemctl --user stop <unit>`。

### 1.2 移走旧代码与旧 state（不要删）

```bash
mv <repo> <repo>.bak
mv ~/.dsh/state/ria ~/.dsh/state/ria.bak
```

> 之后 `~/.dsh/state/ria.bak` 与 `<repo>.bak` **严格只读**，确认升级完成前不要修改或删除。

### 1.3 拉取 `exp` 并安装到 profile

```bash
git clone -b exp <repo-url> <repo>
dsh plugin add file:<repo>
```

确认 profile 里实际生效的是新目录（symlink 检查指向，实物拷贝用 `diff -rq` 核对）：

```bash
ls -ld ~/.dsh/profiles/*/node_modules/dsh-ria
```

### 1.4 启动 DSH 并确认插件正常加载

按平时的运行方式重新启动（打开 `dsh-desktop` / 命令行运行 `dsh web` / `dsh-daemon start`）。

如果运行的是 Web 版，可顺手检查接口是否都返回 `200`（端口按实际修改）：

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3080/health
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3080/plugins/dsh-ria/api/executors
```

桌面端或 CLI 只要能正常打开 Ria 会话即可进入下一步。

### 1.5 让新 Ria 导入旧数据

把下面这段话直接发给新启动的 Ria：

```text
我刚把 Ria 从 main 升级到 exp。旧版本的 state 目录在 ~/.dsh/state/ria.bak（请严格只读，不要修改其中的任何文件）。
请从中尽可能完整地导入数据（工单、主题、认知条目、协管登记、执行者标签、设置等），能自动导入的直接导入，需要我确认的先列清单。完成后汇报各项导入数量。
```

如果导入过程中新目录写坏了，停掉 DSH 后删掉新的 `~/.dsh/state/ria`，重启再重导一次即可，旧目录完好无损。

---

## 2. 回滚

```bash
# 1. 先按平时的运行方式停止 DSH（退出 desktop / Ctrl+C / dsh-daemon stop）

# 2. 删掉新目录，把旧目录 mv 回来
rm -rf <repo> ~/.dsh/state/ria
mv <repo>.bak <repo>
mv ~/.dsh/state/ria.bak ~/.dsh/state/ria

# 3. 重新链接 profile，然后按平时方式重新启动 DSH
dsh plugin add file:<repo>
```

---

## 3. 几个注意点

- **旧目录全程只读**：导入时绝不改 `~/.dsh/state/ria.bak`，核对无误前也不要删。
- **确认 profile 确实更新了**：`dsh plugin add file:<repo>` 返回 0 不一定覆盖了实物拷贝，留意 `ls -ld` / `diff -rq`。
- **等工单空闲再停**：避免把正在执行的 turn 直接中断。
