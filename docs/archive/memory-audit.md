# memory.md 审计归档：哪些规则该进主提示词或代码

> 状态：已落地（2026-11-12，prompt 侧）；memory 条目清理、路由拆分与 P1 代码 guard 未落地。
> 现行文档见 `docs/operations.md`、`docs/memory-budget.md`、`docs/tools.md`，以及 `lib/index.js` 的 `managerPrompt()` 实现。

## 背景与目标

- 审计对象：`/home/gkl/.dsh/state/ria/memory.md`（2026-11-12，3175 bytes，11 条 bullet，内有 2 组重复条）。
- 对照面：`lib/index.js` 的 `managerPrompt()`、`startup()`、`toolRequest()`，以及 `lib/worker-idle.mjs`。
- 核心判据：**memory 只记「这个安装的偏好与环境事实」，不记「Ria 本来就应该这样工作」的规则**。后者每轮都该生效，应进静态 prompt 或有硬强制点的代码。
- 二级判据：是否有强制点、是否易变（sessionId、命令）、是否只对 manager 生效。
- 目标：给出 11 条的分类与去向、可直接粘贴的迁移文案、以及需要新增代码 guard 的清单。

## 关键决策（含理由）

- **分流结果 3 / 3 / 1 / 5**：留 memory 3 条（含拆分出的路由映射）、进主提示词 3 条、拆分 1 条、删除 5 条，合计仍是 11。
- **restart-consent 进 prompt**：插件无 `ria_restart`，但 Ria 是 PTC，`run_code` 里的 `bash` 仍能执行 `dsh-daemon restart`，不存在结构性禁止。shell 层关键词拦截不可靠（别名、脚本、`systemd-run` 都能绕过），还会误伤正常诊断命令；唯一每轮都在的强制点就是 manager prompt。未来若加 `ria_restart` 并要求 `userConfirmed: true`，也不能替代这条 prompt，因为 bash 旁路仍在。
- **delegate-only-explicit 直接删**：`lib/index.js:1642` 已逐字覆盖（explicitly asks 才自己动手），留着只会让模型在两套措辞间二选一。
- **设计原则「有始有终」删**：`subscribeIntake()` 已硬机制覆盖，`lib/index.js:1646` 也已写。
- **worker 拒绝/取消处理删**：`:1647`、`:1661` 已写，且用户取消已由 `lib/worker-idle.mjs` 的 `isUserCancelled(lastTurn)` 硬处理。
- **worker-notify-steer 进 prompt**：`:1657` 只说 steer 不得夹带新任务、`:1659` 只说需求变化先问 queue/steer，缺的是正面用法「信息同步用 steer」，补一句后整条 memory 可删。
- **关注某个 worker 进 prompt**：与既有 `[Worker idle]` 机制同源。措辞必须写明「用 status=working 的 ticket，不要额外挂 schedule timer」，否则会与 `:1662` 的 keep watching 规则双重触发。
- **路由拆两半**：通用规则（standing routing preference 优先于 recent 默认）进 prompt；具体 sessionId 映射留 memory。理由：本插件是通用插件，个人 worker 名与 ID 属于安装数据，写进 lib 会在 ID 过期后留下死引用。
- **必须先改 `lib/index.js:1649`**：`never pick a worker that has not been used recently` 与路由 memory 直接冲突，不改这一句，模型很可能按 prompt 否掉 memory。这是整份审计最容易漏的一处。
- **restart-method 不进 prompt**：命令长、平台相关、低频，进 prompt 只增前缀体积；放 memory 精简版 + `docs/operations.md` 背景。

## 关键机制与数字

- manager prompt 是动态 section：`name: ria-manager`、`order: 40`、`interpolate: false`、`text: () => managerPrompt(sessionId, this.store.readMemory())`（`lib/index.js:2318-2325`）。
- memory 注入在 section 最末尾（`lib/index.js:1677-1679`）：改 memory 只动尾部，前面大段规则仍是稳定前缀。把规则从 memory 挪进静态 prompt 是一次性前缀变更，之后不再随 memory 编辑而变，对缓存是净收益；**不要**把 memory 或本轮状态插到 `## How you work` 之前。
- 「事不能丢」已有硬机制：`agent/pre-step` 自动 captureIntake 并注入 `[Task intake]`；`agent/turn-stopping` 第一次 steer 提醒、第二次自动 blocked。
- 取消语义：`worker-idle.mjs` 检测 `isUserCancelled` 后把 working ticket 转 blocked，blockedReason 为「用户取消了 worker turn（aborted(user)）；等待用户决定下一步」，idleText 明确不自动续派。
- 缺口：`toolRequest()`（`lib/index.js:3311-3424`）只检查 `isTerminal(ticket.status)`，`blocked + waitingOn=user` 的工单仍可被再次 `ria_request`。
- steer 无目标预检：`ria_request` 的 busy 预检只对 `mode === queue` 生效；DSH controller 在 `dsh-api-session-controller/lib/index.js:857` 对 steer 直接 `agent.steer()`，`:932` 才检查目标必须 running。
- 重启回执无强制点：`startup()` 在无未收敛 ticket / pending delivery 时于 `lib/index.js:4253` 直接 return，干净重启不产生任何回执。
- restart-method 实测命令：`systemd-run --user --collect --on-active=6s --property=KillMode=process --unit=ria-restart-$(date +%H%M%S) dsh-daemon restart`，预期 down ≈ 4–5s。
- 两个失败模式的实测代价：`setsid + nohup` 会被 web 关闭时的 `--kill-who=all` 连坐杀掉，watchdog 等 120s 锁过期，实测 128s 空窗；不带 `KillMode=process` 时 systemd 按 control-group 回收，实测 24s 空窗（首代 web 被回收后由 watchdog 补起）。
- restart-report 的现行做法：重启前用 `schedule_create` 挂约 60s 的一次性任务（`target=this_session`），触发后核验 health 与插件 HEAD 再汇报；2026-11-11 决定不为此改插件代码。

## 实现状态

- 已落地（2026-11-12，只改 prompt 与测试，未动 memory）：
  - restart-consent → `lib/index.js:1658`，`## How you work` 第一条。
  - worker-notify-steer → `lib/index.js:1674`，只插入前两句；`Steer must never carry a new task` 的语义已存在于 `:1671`，未重复粘贴。
  - 关注 worker → `lib/index.js:1677`，紧跟 `[Worker idle]` 那条（`:1676`）。
  - 断言：`test/smoke.mjs:655-657` 三条分别覆盖上述三条。
- 未落地：路由拆分（`lib/index.js:1663` 仍是原句，通用路由 bullet 未加，memory 映射未改）；restart-report / restart-method 两组重复条未合并；5 条冗余条未删（`memory.md` 由用户维护）；`ria_request` 的 blocked guard、`steer_requires_running`、startup restart receipt 三个 P1 均未做。
- 迁移后的 memory 目标形态：只留 3 条，顺序为路由映射在前（最常用）、restart-report 与 restart-method 在后（低频），后者只留命令 + 一句原因，背景移到运维文档。

## 仍未实现 / 风险

- **P1 blocked guard**：对外 `ria_request` 检查 `status === blocked && waitingOn === user`，要求先 reopen。必须只拦对外入口，内部 `retryDeliveries` 与审批恢复路径不能被挡。
- **P1 steer running guard**：新增 `steer_requires_running`，防止 steer 落在 idle worker 上悄悄变成一轮新 turn。
- **P1 startup receipt**：重启前写 `stateDir/restart-intent.json`（requestedAt、pluginHead、reason），`startup()` 在 `:4253` early return 前读取、算停机时长，投一条 `restart_receipt`。这样只对「有重启意图」的重启回执，且能区分 Ria 主动重启与用户手动重启；没有 intent 文件之前 restart-report 只能留在 memory。
- **迁移顺序**：先落 prompt 改动，再删 memory 对应条目，反过来会出现规则空窗；建议分两次提交/两次 memory 编辑，prompt 行为不对时先回滚 prompt。
- **多工单串味**：路由是默认归属而非强制。owner 正在跑时第二张同类工单不能 queue 进去，应用 `dependsOn` 或问用户；已有 executor 的工单不得因路由改派；owner 归档、cwd 失效或非 top-level 时回落到 recent 或问用户（预检会返回 `session_archived` / `workspace_missing` / `session_missing`）。
- **两条文档不一致（当时未处理）**：`lib/index.js:1649` 写 `scope=recent` 返回 up to 5，`docs/tools.md` 写最多 10；`ria.json` 的 recentWorkers 仍有已死引用 `session-2accf2cd`（cwd `/home/gkl/Desktop/vibe_proj/dsh-super-session` 已不存在），按 recent 选到会报 `workspace_missing`。
- **明确不做的方向**：关键词扫描 bash 强制 restart-consent；用模型语义判断「worker 拒绝」；把 Ria 开发/文档治理的 sessionId 写进 lib。

## 现行文档

- 规则原文：`lib/index.js` 的 `managerPrompt()`（行号已随改动漂移，以上面的符号为准）。
- 运维流程（重启、恢复、审批等待）：`docs/operations.md`。
- memory 容量与形态的后续方案（core 预算、archive）：`docs/memory-budget.md`（2026-11-16 起以 core 2400 字符 / 12 条 / 单条 300 字符为目标，真实 memory.md 尚未迁移）。
- 工具语义（`ria_status`、`ria_request` 的 scope 与 mode）：`docs/tools.md`。
