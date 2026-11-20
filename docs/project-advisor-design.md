# 项目级 Advisor 设计（草案，已取代）

> **已被 [Sage（大脑）+ 无状态 Advisor 设计](sage-advisor-design.md) 取代（2026-11-19），保留作历史方案。** 本方案按项目分会话的做法不再采用；项目差异改由共享认知库的 project 片段承载，Advisor 无状态化。

> 目标设计，不替代根 DESIGN.md；与 [design-v2.md](design-v2.md) 互补。本文只回答四件事：一张票什么时候有自己的 Advisor、它住在哪、经验怎么分层、怎么迁移。不写实现代码。

## 背景与问题

现在只有一个 Global Advisor。`v2.json` 的 `advisors` 本来就是按键存的（`advisor(scope)` / `setAdvisor(scope, …)`），但实际只用了 `global` 一个键。

两个问题会随项目变多而放大：

- **跨项目经验污染**：全局经验库把某个仓库的坑位（例如某项目的构建脚本、部署路径）当成通用规律，注入到其它项目的 WorkOrder。
- **单例并发瓶颈**：所有项目的票都排队进同一个 Advisor 会话；一个长 WorkOrder 期间，别的项目只能等。

## 目标 / 非目标

目标：

- 一张票按 `ticket.workspace` 找到「最贴切」的 Advisor：精确项目 → 父目录归属 → Global 兜底。
- 项目 Advisor 的会话不落真实项目目录，读项目靠绝对路径（只读），写权限天然隔离。
- 经验分两级（项目 / 全局），项目优先；跨项目复现的经验才晋升全局。
- 全程事件驱动：懒创建、休眠、回收都在路由/启动事件里判定，不加定时器。
- 迁移分阶段、可回滚，默认行为仍是 Global。

非目标：

- 不做 per-topic / per-ticket Advisor。
- 不做 Advisor 之间的通信或协商。
- 不引入独立进程、端口或第二个服务。
- 不改 Worker 派发、审批状态机与 ticket 状态机。
- 不在本设计里迁移 SQLite（只写清依赖）。

## 1. 路由与项目 key

**输入**：`ticket.workspace`（可选）。先规范化：`realpathSync` 解析符号链接、去掉尾部分隔符、拒绝空值。

**匹配顺序**（命中即停）：

1. **精确匹配**已有的项目根：某条 binding 的 `projectRoot` 与规范化后的 workspace 完全相等。
2. **最长已知项目根前缀**：workspace 落在某个已登记项目根之下（`root/` 前缀），取最长的那条。这样 `/a/b` 与 `/a/b/c` 同时登记时，`/a/b/c/x` 的票归 `/a/b/c`，不会被父项目抢走。
3. **懒创建**：workspace 存在但没有任何匹配 → 允许为该目录创建项目 Advisor（同时写一条审计/日志：时间、workspace、生成的 key、判定理由）。是否立即建会话见 §4 的冷启动门槛。
4. **Global 兜底**：无 workspace、workspace 不可规范化、或命中 `stateDir` 等敏感路径（与 `chatbot_request` 的 `workspace_overlaps_state` 同口径）→ 一律走 Global。

**项目 key**：

```text
key = slug(basename(realpath(workspace))) + '-' + sha1(realpath(workspace)).slice(0, 8)
```

理由：

- 可读：`dsh-ria-1a2b3c4d` 能一眼看出是哪个项目；
- 抗同名：不同路径的同名目录（`~/work/api` 与 `~/lab/api`）hash 不同，不互相覆盖；
- 稳定：同一路径反复路由得到同一个 key，便于 `v2.json` 持久化。

key 作为 `v2.json.advisors` 的键；binding 内保存 `projectRoot`（realpath 原文）与 `projectKey`，避免只靠 key 反推路径。

**目录移动/改名**：key 不会自动跟随。移动后按「新 key + 显式迁移」处理：新 binding 指向新路径，项目经验库复制或合并到新 key，旧 key 标 `retired`（保留只读，不删除）。不要用 basename 猜测迁移。

| 场景 | 路由结果 |
|---|---|
| workspace 与某项目根完全一致 | 该项目 Advisor |
| workspace 是某项目根的子目录 | 最长前缀所属 Advisor |
| workspace 存在但未登记 | 懒创建（受 §4 门槛约束） |
| 无 workspace / 不可读 / 指向 stateDir | Global Advisor |
| workspace 在已 `retired` 的项目根下 | Global（或提示显式迁移后再路由） |

## 2. 会话放置

| | Global Advisor | Project Advisor |
|---|---|---|
| cwd | `stateDir/advisors/global` | `stateDir/advisors/<project-key>` |
| 标题 | `Advisor` | `Advisor · <项目名>` |
| 读项目 | 只读绝对路径 | 只读绝对路径 |
| 写项目 | 不写 | 不写 |

**不落真实项目目录**，理由来自今天的实测教训（ticket_mwmdxkm3 部署收尾、ticket_mwmd51p3 审批状态机）：

- 部署类工单 `projectCwd=null` 时 worker 的 cwd 落在 `stateDir/workers`，仓库对它就是沙箱外只读：`npm test` / `commit` / 装插件全部报 EROFS，只能逐次发 `danger-full-access` 提权；审批无人应答时空等（实测 119.9s / 600s 预算被取消），而这期间工单看起来还在 working。
- Advisor 的职责是「定方案」：读项目用 `read` / `grep` / `glob` 的绝对路径即可，从不需要写项目。cwd 放在 state 下，等于**读得到、写不进**，权限天然隔离，也不会因为项目目录被删/改名而让会话失效。
- 会话 cwd 绑到用户项目还会污染 `git status`（产物、临时文件），并可能让项目目录被会话长期占用。

产物仍放该会话自己的 `runs/`；项目 WorkOrder 里如需 Worker 写仓库，仍按既有规则用 `ticket.projectCwd` 单独派单（见 §3.1 经验里的部署教训）。

## 3. 经验分层与检索

### 3.1 两级库

| 库 | 路径 | 作用 |
|---|---|---|
| 全局 | `stateDir/lessons.json` | 跨项目适用：流程、协议、工具行为 |
| 项目 | `stateDir/lessons/<project-key>.json` | 该项目专属：目录结构、构建/部署坑位、隐性约定 |

项目库文件结构与现有 `lessons.json` 完全一致（`schemaVersion` + `entries`），便于同一套 `LessonStore` 读写与迁移。**不把两级库混写进一个文件**：项目库可以整体备份/删除，不会牵连全局。

### 3.2 检索顺序与注入

- 先查项目库，再查全局库；**项目条目优先**。
- 去重键不变：`scenario` slug + `pitfall` 归一化后的 hash。项目与全局出现同义条目时，只注入项目条，全局条跳过。
- 注入上限：项目 ≤3 条、全局 ≤2 条，合计总长 ≤800 字符（与现有 `[Lessons]` 段一致）。
- 注入时标注来源与 id：`- [project:<key>/les_x] 场景 → 坑位 → 做法`、`- [global/les_x] …`。`ticket meta.usedLessons` 同步记录带来源的 id，报告里可追溯。

### 3.3 去重与晋升

- 每条经验仍只能由 Advisor 的 `lesson_review` accept 入库；Worker 只能提候选。
- **晋升规则**（复制，不是移动）：
  1. 同一条经验在 **≥2 个不同项目**被 accept 或命中（按去重键归并）；
  2. 或 Advisor 显式 `accept as global`。
- 晋升时保留各项目来源证据（`sources[]`），全局目条目加 `promotedFrom`；项目条目继续存在，两条各自命中。
- **不自动晋升**：晋升也算一次审阅动作，必须经 Advisor 确认，避免把项目特例变成全局规律。
- 降级/冲突：项目条永远优先；全局条被多个项目的项目条覆盖时，提示审阅是否收敛全局条。

## 4. 生命周期

- **懒创建**：第一张该项目的「工作票」（work 或 reflection）到达时创建项目 Advisor；没有 answer 模式，纯问答由 Chatbot 直接答。
- **冷启动门槛（防洪）**：同一项目 24h 内只有 1 张短问答票 → 不创建项目 Advisor，先用 Global；一旦出现工作票立即创建。门槛按「项目 key + 时间窗」判定，只在路由事件里计算。
- **休眠**：项目 30 天没有票 → binding 保留、经验保留，但会话不再保活（下次用票时重新 ensure）。休眠不是删除。
- **回收**：只在启动 reconcile 与路由事件中判定；不引入定时器、不轮询。回收只回收会话（可配置是否删除），不删 binding、不删经验库；每次回收写审计。
- **状态字段建议**：`advisors[key] = { scope, projectKey, projectRoot, sessionId, createdAt, lastUsedAt, status: 'active' | 'dormant' | 'retired' }`。

## 5. 并发与一致性

现状是**单进程 + 单文件 JSON 原子写**：`v2.json` 与 `lessons.json` 都在内存里维护整份数据，写入用 tmp + fsync + rename。多个 Advisor 并行时，各自持有自己的内存副本，谁最后写谁覆盖——会丢 ticket meta、丢经验、丢 binding。

因此多 Advisor 的前提是下面二者之一：

1. **同进程单写者队列/互斥**：Router 把 `v2.json` / `lessons.json` 的写操作串行化，Advisor 只提交意图，不直接落盘；
2. **SQLite 事务**：[design-v2.md](design-v2.md) §7 的目标形态（单写者、事务、WAL、可备份）；当前处于「暂缓」。

在 SQLite 落地前：

- P1 只做「读分层 + 路由判定」，不新增并发写；
- P2 起，路由层同一时间只允许一个 Advisor 进入写路径（plan / dispatch / lesson_review），其余排队；把「跨 Advisor 的 lessons / v2.json 写入」列为 P2 的阻塞项，未解决不开启多例。
- 读路径（`lesson_search`）可并行：内存索引只读快照，不改文件。

| 写操作 | 当前风险 | 缓解 |
|---|---|---|
| `ticket_plan` / dispatch 写 WorkOrder 与 meta | 最后写入者覆盖 | 单写者队列或 SQLite |
| `lesson_review` 写经验库 | 条目丢失/回退 | 每库单写者；项目库按 key 分文件，天然隔离 |
| binding 创建/休眠/回收 | binding 丢失 | 路由层串行 + 启动 reconcile |

## 6. 迁移路径与回滚

| 阶段 | 做什么 | 验证点 |
|---|---|---|
| **P0（现状）** | 只有 Global Advisor | 现有行为不变 |
| **P1 经验分层** | 引入 project key 路由与两级检索，但**所有项目仍由 Global 处理**；只在 `meta` 记录「将来会归属哪个 key」 | 同一项目票检索到项目库；Global 行为不变；经验可回滚 |
| **P2 项目会话** | 按需创建项目 Advisor 会话并派发 WorkOrder（依赖 §5 单写者保障） | 路由正确、WorkOrder 归属正确、失败可回落 Global |
| **P3 生命周期** | 休眠/回收、晋升自动化（仍需审阅） | 回收不删 binding/经验；晋升有审计 |

**回滚开关**：`advisorScope: 'global' | 'project'`，**默认 `global`**（保底）。关闭时：

- 项目票立即回落 Global，不新建项目会话；
- 已有 project binding 保留不删（下次开启可复用），项目经验库保留只读；
- 已派发的 ticket 不回滚（避免重复执行），由 Router 按当前 executor 收口。

**数据兼容**：`v2.json.advisors` 新增键不影响旧读取；`advisor('global')` 语义不变；旧文件缺少 `projectRoot` 的 binding 一律按 Global 处理，不做猜测。

## 7. 风险与取舍

**明确不做**：

- 不做 per-topic / per-ticket Advisor（会话数爆炸，收益低）。
- 不做绕过审阅的自动晋升。
- 不引入独立进程、端口或第二个服务。
- 不改 Worker 派发、审批状态机与 ticket 状态机。
- 不做 Advisor 之间互相通信或协商。
- 不在本设计内迁移 SQLite（只作为并发前提引用）。
- 不把 Advisor 会话 cwd 放到真实项目目录。

| 风险 | 说明 | 缓解 |
|---|---|---|
| 经验重复/漂移 | 项目条与全局条同义、项目间复制 | 统一去重键；晋升需审阅；定期复盘合并 |
| 会话数膨胀 | 项目多导致 Advisor 会话多 | 懒创建 + 冷启动门槛 + 休眠 |
| `v2.json` 写竞争 | 多 Advisor 并行写覆盖 | P2 前单写者队列；长期迁 SQLite |
| 目录重命名导致 key 失效 | key 绑定旧 realpath | 显式迁移 + 旧 key `retired` |
| 用户不知道谁在处理 | 多 Advisor 后归属不直观 | 看板/通知标注 `Advisor · <项目>` |
| 项目库缺失/损坏 | 单项目文件损坏 | 与全局库同款原子写 + 启动告警；不阻塞派单 |

## 8. 目录与状态结构（建议）

```text
stateDir/
├── v2.json                     # advisors[key] = { scope, projectKey, projectRoot, sessionId, lastUsedAt, status }
├── advisors/
│   ├── global/                 # Global Advisor 会话 cwd
│   └── <project-key>/          # 项目 Advisor 会话 cwd（read 用绝对路径读项目）
├── lessons.json                # 全局经验库（现有结构）
├── lessons/
│   └── <project-key>.json      # 项目经验库（同 schema）
├── workers/                    # 现有：work Worker 的 cwd 根
└── reflection-workers/         # 现有：reflection Worker 的 cwd 根
```

- `advisors/` 与 `workers/`、`reflection-workers/` 同级，语义一致：**会话都不落在用户项目里**。
- 项目经验库与项目 Advisor 会话共用 `project-key`，便于一起备份/迁移/回收。
- 旧 `v2.json` 的 `thinkers` 兼容读取保持不变（见 design-v2 改名说明）。

## 9. 开放问题

- 项目根从哪里来：只信 `ticket.workspace`，还是允许用户显式登记项目根（类似 workspace registry）？建议后者作为 P2 的可选项。
- 冷启动门槛的阈值（24h / 1 张短问答）是否需要配置化？
- 晋升阈值「≥2 个项目」是否够，是否需要按命中次数加权？
- 休眠回收是否删除会话日志？建议只删会话，日志交给 DSH 保留期。
- 看板如何展示「这张票归哪个 Advisor」？建议在卡片上标注 `Advisor · <项目>` 并提供筛选。
- 同一 realpath 通过不同挂载点访问时，hash 不同 → 会产生两个 key；是否需要按 inode/设备号去重，留待实测。
