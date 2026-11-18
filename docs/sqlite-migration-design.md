# 控制面 SQLite 迁移设计（草案）

> 目标设计，不替代根 `DESIGN.md`；本轮只出设计与分阶段方案，不改存储实现。与 [project-advisor-design.md](project-advisor-design.md)、[design-v2.md](design-v2.md) §6 的 Router 事件日志配套阅读。

## 背景与问题

控制面目前全是文件：

| 文件 | 内容 |
|---|---|
| `stateDir/ria.json` | Ria 会话、tickets、grants、settings、pending deliveries、dispatch notes |
| `stateDir/v2.json` | Chatbot/Advisor/Worker 绑定、Request、WorkOrder、reports、manager inbox、ticket meta |
| `stateDir/outbox.json` | 副作用投递队列 |
| `stateDir/tickets.log.jsonl` + `tickets-YYYY-MM.jsonl` | 归档工单（含 history 快照） |
| `stateDir/router-events.jsonl` + 月文件 | Router 过程事件 |
| `stateDir/audit.jsonl` | 审批/授权决策审计 |

文件写入用 `writeAtomic`（tmp + fsync + rename）。单进程单文件时足够；一旦**多个 Advisor/Worker 各自持有一份内存副本并写同一文件**，就是最后写入者覆盖：丢 ticket meta、丢 WorkOrder、丢经验、丢绑定。rename 的原子性保证「文件不会写一半」，不保证「两个写者不互相覆盖」。

同时，一次逻辑操作往往跨多个文件：改 ticket 状态（ria.json）+ 写 history（tickets.log）+ 记 Router 事件（router-events.jsonl）+ 入 outbox（outbox.json）。文件方案没有跨文件事务，崩溃点不同会留下不一致的组合。

## 目标 / 非目标

**目标**

- 控制面数据进 SQLite：单写者、事务、WAL、可备份。
- 一次逻辑操作一个事务：状态、history、outbox 入队等原子提交；事件作为过程流可后置、失败不阻断。
- 查询按 ticketId/状态/executor/时间走索引，不再全量读 JSON。
- JSON 保留为只读备份/导出，迁移与回滚可演练。
- 行为与现有 API 尽量不变：工具名、返回结构、状态机、审批语义不动。

**非目标**

- 不迁移 transcript/reflections/memory/附件。
- 不做跨机、Postgres、多进程写同一库、每 Advisor 独立库。
- 不引入 ORM；不重写状态机；不改 UI。
- 本轮不写代码、不写 SQL DDL、不改 schema 版本。

## 1. 范围与权威源

### 1.1 进库 / 留文件

| 数据 | 去向 | 理由 |
|---|---|---|
| tickets（含 status/waitingOn/executor/goal/acceptance/blockedReason/failure/resolution/attempt/meta/revision/createdAt/updatedAt/closedAt） | DB `tickets` | 高频写、并发敏感、需要按状态/executor/时间查询 |
| ticket history | DB `ticket_history` | 与状态迁移同事务，复盘要按 seq 读 |
| Router/审批/lesson 注入等事件流 | DB `ticket_events` | 需要按 ticket/type/时间查询；与 ticket 状态一起构成可追溯时间线 |
| outbox | DB `outbox` | 重复投递敏感；`dedupe_key` 唯一约束比文件去重可靠 |
| reports | DB `reports` | 按 ticket/worker/时间查询；写入频繁 |
| work_orders | DB `work_orders` | ticket 完成后仍要读；与 ticket 强关联 |
| workers/registry | DB `workers` | 当前 executor/状态/currentTicketId 查询 |
| advisors/bindings | DB `advisors` | 项目级 Advisor 的 key/scope 需要唯一约束与并发安全 |
| lessons + lesson_candidates | DB `lessons` / `lesson_candidates` | 按 scope/tags/status 查询；候选审阅是事务 |
| audit（`audit.jsonl`） | DB `audit_events` + 继续导出 jsonl 一个版本 | 决策审计需要事务内写；jsonl 兼容旧工具/人工查看 |
| DSH transcript / session log | 留文件 | 宿主所有，体量大，Ria 不应接管 |
| reflections/*.md、reflection run 文件 | 留文件 | 大块 Markdown，低频写，人类可读优先 |
| memory.md + memory-archive | 留文件 | 用户可编辑、人类可读、调试友好 |
| 附件/产物/截图 | 留文件 | 大块二进制，路径由会话/Workspace 管理 |
| profile 配置、通道凭据（wechat/claw/qq） | 留文件 | 属于宿主/profile，权限模型不同 |

**补充取舍**：`ria.json` 里还有 topics/links/ticketFeedback/deliveries/dispatchNotes/grants/settings。它们不是本轮进库清单的强制项；P1–P3 先不迁，继续留 `ria.json`，等 P3 收口后再评估（topics/links 与看板查询关系较深，届时可单独一票）。**不要为了“一次全迁”把这些表塞进 P1**。

### 1.2 权威源

| 阶段 | 权威源 | JSON 的地位 |
|---|---|---|
| 迁移前 | JSON | 正常读写 |
| P1 切换后 | DB（tickets/history） | 只读导出/备份，不再接受写 |
| P2 切换后 | DB（ticket_events） | `router-events.jsonl` 只读导出，保留一个版本 |
| P3 切换后 | DB（对应域） | 对应 JSON 只读导出 |

**推荐**：切换后 DB 是唯一权威源；JSON 导出只读，只用于回滚、人工查看和兼容旧工具。**禁止**切换后再让 JSON 与 DB 双向写——那会重新引入丢更新。

**不一致处理**：

- DB 缺失或损坏、但 JSON 备份存在：**拒绝启动**，给出恢复指引（`state/backup/<timestamp>/` 或从导出重建），不自动把 JSON 导回 DB。自动导入会把“后来在 DB 里发生但导出前”的写入静默丢掉。
- DB schema 版本高于当前代码：拒绝启动，要求升级/回滚代码，不做隐式降级。
- DB 正常、导出 JSON 落后：告警并重新导出，不阻断主流程。
- 迁移窗口内（DB 刚导入、尚未切换读）：JSON 仍是权威，DB 只用于校验；切换点必须是一次明确的配置变更，不能在运行中“看谁新用谁”。

## 2. Schema 草案

只列表名、关键列与索引倾向，不写 SQL DDL。时间统一建议 INTEGER（epoch ms）；JSON 结构列先用 TEXT 存，避免一次性拆全字段。

### 2.1 核心表

| 表 | 关键列（类型倾向） | 说明 |
|---|---|---|
| `schema_meta` | `key TEXT PK, value TEXT, updated_at INTEGER` | schema_version、迁移标记；只向前 |
| `tickets` | `id TEXT PK, status TEXT, waiting_on TEXT, executor TEXT, goal TEXT, acceptance TEXT, revision INTEGER, created_at INTEGER, updated_at INTEGER, closed_at INTEGER, attempt_json TEXT, failure_json TEXT, resolution_json TEXT, meta_json TEXT` | 一行一张票；checklist/dependsOn 等先放 `meta_json` 或后续加 JSON 列，不拆成关系表 |
| `ticket_history` | `ticket_id TEXT, seq INTEGER, at INTEGER, from_status TEXT, to_status TEXT, actor TEXT, reason TEXT`，PK `(ticket_id, seq)` | 与状态迁移同事务；seq 按迁移/写入顺序递增 |
| `ticket_events` | `event_id TEXT PK, ticket_id TEXT, ts INTEGER, type TEXT, session_id TEXT, actor TEXT, reason TEXT, payload_json TEXT` | **append-only**：只 INSERT；不 UPDATE/DELETE。保留期归档到月表 |
| `outbox` | `entry_id TEXT PK, kind TEXT, dedupe_key TEXT UNIQUE, payload_json TEXT, status TEXT, attempts INTEGER, due_at INTEGER, created_at INTEGER, delivered_at INTEGER` | `dedupe_key` 唯一约束是硬保证 |
| `reports` | `report_id TEXT PK, ticket_id TEXT, worker_id TEXT, status TEXT, summary TEXT, evidence_json TEXT, at INTEGER` | 报告不覆盖；需要追加 |
| `work_orders` | `ticket_id TEXT PK, summary TEXT, steps_json TEXT, acceptance TEXT, artifacts_json TEXT, notes TEXT, by TEXT, created_at INTEGER` | 一票一 WorkOrder |
| `workers` | `session_id TEXT PK, worker_type TEXT, scope TEXT, project_id TEXT, project_cwd TEXT, cwd TEXT, status TEXT, current_ticket_id TEXT, artifact_dir TEXT, created_at INTEGER, last_used_at INTEGER` | workerType 含 work/reflection |
| `advisors` | `scope TEXT PK, session_id TEXT, cwd TEXT, project_key TEXT, project_root TEXT, status TEXT, created_at INTEGER, last_used_at INTEGER` | scope=global 或 project key；与项目级 Advisor 设计对齐 |
| `lessons` | `id TEXT PK, scope TEXT, tags_json TEXT, condition TEXT, scenario TEXT, pitfall TEXT, approach TEXT, source_json TEXT, hits INTEGER, status TEXT, created_at INTEGER, updated_at INTEGER` | scope=global 或 project key；项目/全局同表不同 scope |
| `lesson_candidates` | `id TEXT PK, status TEXT, scenario TEXT, pitfall TEXT, approach TEXT, evidence TEXT, report_id TEXT, ticket_id TEXT, session_id TEXT, created_at INTEGER` | 审阅 accept/reject 是状态变更，不是删除 |
| `audit_events` | `at INTEGER, kind TEXT, ticket_id TEXT, session_id TEXT, payload_json TEXT` | 可选 P3；jsonl 继续导出一个版本 |

### 2.2 索引

| 索引 | 用途 |
|---|---|
| `tickets(status, updated_at)` | 看板/状态扫描、最近更新 |
| `tickets(executor)` | 按 worker 查在跑票 |
| `ticket_history(ticket_id, seq)` | 单票时间线 |
| `ticket_events(ticket_id, ts)` | 单票事件流 |
| `ticket_events(type, ts)` | 按事件类型前缀/时间查询 |
| `outbox(status, due_at)` | 到期投递扫描 |
| `reports(ticket_id, at)` | 单票报告 |
| `lessons(scope, status)` | 经验检索 |
| `lesson_candidates(status, created_at)` | 待审阅队列 |
| `work_orders(ticket_id)` 由 PK 覆盖 | 单票 WorkOrder |

可选：`lessons` 上 FTS5（scenario/pitfall/approach）。**推荐 P3 再评估**：当前 LessonStore 已有倒排索引，先生成物化索引/再迁移，不要为了 FTS 把 P3 拖长。

### 2.3 事件表追加语义

- `ticket_events` 只 INSERT。事件一旦落库不改写；纠正用新事件（例如 `ticket.state` 再从 A→B），不 UPDATE 旧行。
- 保留期：热表保留 12 个月；更早的行按月归档到 `ticket_events_YYYY_MM` 月表，归档动作是一次受控 INSERT+DELETE（应用不 DELETE；只允许保留期维护）。查询层读热表 + 相关月表。
- `event_id`：正常写入用 `evt_<ts>_<random>`；迁移导入用确定性 hash（ts+type+ticketId+payload）保证重复导入幂等。
- 归档月表结构同热表；不写回热表，不跨月 UPDATE。

## 3. 写入路径与事务

### 3.1 单写者队列 + WAL（推荐）

- **一个进程、一个写者连接、一个进程内队列**。所有写操作（ticket 状态、history、outbox、reports、lessons、advisors）提交给 Router 的单写者；队列按提交顺序串行执行。
- 读用**独立只读连接**（每个查询短连接或连接池）。WAL 下读不阻塞写、写不阻塞读；但 SQLite 仍然只有一个写者，多写者 WAL 不会变成并行写。
- PRAGMA 建议：`journal_mode=WAL`、`synchronous=NORMAL`（迁移/关键阶段可临时 FULL）、`busy_timeout=5000`、`foreign_keys=ON`；启动时 `wal_checkpoint(TRUNCATE)`（或等价）并检查 `-wal/-shm`。
- 不引入多进程写同一库；若宿主未来多进程，只有 owner 进程写，其它进程通过 IPC 提交，不能各自开写连接。

**为什么不是多写者 + WAL**：SQLite 本身把写串行化；多写者只会增加 `SQLITE_BUSY` 和重试成本。真正的收益来自读并发、事务原子性和统一排序，不是“多个人一起写”。单写者队列还能天然保证 ticket 状态迁移/history/事件顺序。

### 3.2 事务边界

| 逻辑操作 | 同一事务 | 事务后（best-effort） |
|---|---|---|
| ticket 状态迁移 | `tickets` 更新 + `ticket_history` INSERT + 需要时 `outbox` 入队 | `ticket_events` 一条 `ticket.state` |
| 建票 | `tickets` INSERT + history 首条 | `ticket_events` `ticket.created` |
| plan | `work_orders` upsert + ticket meta 更新 | `ticket_events` `advisor.plan` |
| dispatch | ticket 状态 + attempt + meta + workers 状态 + outbox 入队（如需） | `dispatch.attempt/lesson.injected` |
| worker 报告 | `reports` INSERT + ticket 状态/attempt 更新（如 done/failed/blocked） | `ticket.state` / 报告事件 |
| approval asked/decided | 状态/审计（若审计进库） | `approval.asked/decided` 事件 |
| lesson 审阅 | `lessons` + `lesson_candidates` 状态 | 审计事件 |

**事件为什么后置**：事件是观测，不是控制流前提。把事件放进主事务会让“日志表写失败”反过来阻断派发/审批，违背现有“审计失败只告警”的契约。事件写失败可重试/补写，主操作不回滚。**outbox 入队是例外**：它是“至少一次投递”的耐久前提，必须与状态同事务。

### 3.3 与 `writeAtomic` 的关系

- `writeAtomic` 保留给非 DB 文件：memory、reflections、JSON 导出、备份、附件元数据等。
- 控制面 JSON 在切换后只由导出器**原子写**，不再由业务代码写。
- 双写/影子阶段：先 DB 事务提交，再原子导出 JSON；导出失败只告警并标记 lag，不回滚 DB。导出器必须幂等（按主键 upsert/全量重写）。
- 不用 ORM；SQL 集中在存储层，业务层只调用仓储接口（tickets/reports/outbox/…）。本轮不定义代码接口，只定边界。

## 4. JSON → SQLite 迁移与回滚

### 4.1 导入步骤

1. **停写/维护窗口**：停止 web 写路径或设置 `storage=maintenance`；记录当前 JSON 的 sha256。
2. **备份**：把 `ria.json`、`v2.json`、`outbox.json`、`tickets.log.jsonl`、`tickets-YYYY-MM.jsonl`（P2 再加 router-events/*.jsonl）复制到 `stateDir/backup/<timestamp>/`，生成 manifest（文件、大小、sha256）。
3. **导入**：读 JSON，按主键 upsert：
   - `ria.json.tickets` + `v2.json` 的 ticket meta 合并成 `tickets` 行；
   - 每个 ticket 的 `history` 按原顺序写 `ticket_history`，seq 从 0/1 递增；
   - 归档 JSONL 里的 ticket 快照去重后补 tickets/history；
   - reports/workOrders/workers/advisors/lessons/candidates 按各自主键；
   - outbox 按 `dedupe_key` 去重。
4. **幂等**：重复导入不重复写；`ticket_events.event_id` 用确定性 hash；outbox 重复 dedupe_key 跳过并记录冲突。
5. **导入期间写开关**：只读模式，业务不可写；导入完成后才允许切换。

### 4.2 校验

- 每表行数 vs JSON 源计数（tickets 去重后、history 按 ticket 求和、reports/workOrders/workers/advisors、outbox dedupe 数）。
- 随机抽 20 张票深比对：status/waitingOn/executor/attempt/failure/resolution/revision/时间戳/history 条数与 actor/reason。
- 外键完整性：`PRAGMA foreign_key_check`；孤儿 history/report/event 为 0。
- outbox `dedupe_key` 唯一；重复导入第二次行数不变。
- 查询抽样：按 status/executor/ticketId/时间范围各查一次，与 JSON 预期一致。
- 备份可恢复：在临时目录用 `state/backup/<timestamp>/` 试恢复一次。

### 4.3 回滚

| 阶段 | 回滚动作 | 前提 |
|---|---|---|
| P1 | `storage=json`，停 DB 写；用导出器把 tickets/history 写回 `ria.json`/`v2.json`（若 DB 更新）；再用备份恢复；重启 | JSON 导出器可用；备份完整 |
| P2 | 先把 `ticket_events` 导出回 `router-events.jsonl`；切回 jsonl sink；DB 事件表保留只读 | 导出器覆盖热表+月表 |
| P3 | 按域开关回 json（tickets/events 保持 DB 或先回滚）；逐域导出 | 每域独立 storage flag |

**切换点**：只有校验全过、回滚演练过，才把权威源从 JSON 切到 DB。切换后 JSON 只读；回滚是显式运维动作，不是自动 fallback。

## 5. 分阶段落地

### P1：tickets + history（推荐先做）

- 范围：`tickets`、`ticket_history`；ticket meta 合并；JSON 只读导出。
- 前置：P0 完成 schema/backup/import/export/storage flag。
- 验收：导入计数/20 票抽样一致；现有测试全绿；重启恢复；并发 plan/dispatch/report 不丢更新；按状态/executor/时间查询正确；导出 JSON 与 DB 对得上。
- 回滚：`storage=json` + 导出 + 备份恢复；保留 DB 文件（不删）供下次重试。
- 退出条件：连续一个发布周期无丢更新/一致性告警；导出 lag 可观测。

### P2：事件流

- 范围：`ticket_events`；接入 Router 事件、审批 asked/decided、lesson.injected；`router-events.jsonl` 双写/导出。
- 步骤：先 shadow（DB+jsonl 双写，查询读 DB 校验）→ 再 DB 权威、jsonl 导出。
- 验收：事件条数与顺序、按 ticket/type/时间查询、12 个月保留/归档、崩溃后重放、事件失败不阻断主流程。
- 回滚：导出 DB 事件到 jsonl，切回 jsonl sink；事件表保留只读。

### P3：其余

- 范围：outbox、reports、workOrders、workers、advisors、lessons/candidates；audit_events 可选。
- 顺序建议：outbox（幂等键）→ workers/advisors（项目级 Advisor 的前置）→ lessons/candidates → reports/workOrders → audit。
- 验收：全链路回归；outbox 不重复投递；多 Advisor 单写者不丢 binding/经验；重启恢复；逐域回滚演练。
- 回滚：按域 `storage.<domain>` 切回 JSON；已切域可单独回退。

**每阶段都要求**：迁移前备份、导入校验、切换点记录、回滚演练；不通过不进入下一阶段。

## 6. 与既有设计的依赖

### 6.1 路由事件日志

路由事件日志（[design-v2.md](design-v2.md) §6）已经定义了事件类型、字段与埋点位置，当前落 `router-events.jsonl`。迁移方案对它的取舍：

- **P1 不动**：P1 只迁 tickets/history，事件继续写 jsonl。
- **P2 进库**：`ticket_events` 接管事件流；`router-events.jsonl` 保留为只读导出一个版本，便于复盘/兼容/回滚。
- **为什么进库**：事件与 ticket 查询、保留期、审批风险字段同属控制面；进库后可按 type/时间走索引，不用扫月文件。文件层仍可作为导出/取证。
- **返工风险**：如果 Router 事件模块把 `appendFileSync` 写死在业务代码里，P2 换 sink 会改多处。缓解：现在就把写入收敛到可替换的 sink（jsonl / sqlite 两种实现），业务只发 `append(event)`。这是 P2 前的接口准备，不是本轮实现。

### 6.2 项目级 Advisor

项目级 Advisor 设计（[project-advisor-design.md](project-advisor-design.md)）明确写了：**SQLite 是项目级 Advisor 的前置条件**，多 Advisor 并发写 JSON 会丢更新。两者对齐方式：

- 设计稿说的“前置”拆成两层：P1 的**单写者/事务**（tickets 写入不再覆盖）+ P3a 的 **advisors/lessons/workers 表**（binding 与经验库进库）。
- 因此项目级 Advisor 落地不能“先按 JSON 多 Advisor 跑起来再迁库”，那必然返工。推荐把 Advisor 落地拆成：
  - A1（可在 P1 后）：项目 key 路由、读分层、单写者门禁；仍不创建多 Advisor 会话。
  - A2（必须在 P3a 后）：真正多 Advisor 并行、项目经验库写路径、休眠/回收。
- 本项目推荐主线：Router 事件日志 → 项目级 Advisor 设计（已完成）→ SQLite P1 → 项目级 Advisor A1 → SQLite P2（事件）→ SQLite P3a（advisors/lessons/workers）→ 项目级 Advisor A2 → SQLite P3b（其余）。这与 WorkOrder 的“P1 → 项目级 Advisor 落地 → P2/P3”一致，只是把“落地”拆成 A1/A2，避免在 JSON 上先做多例。

### 6.3 返工风险表

| 如果先做… | 风险 | 缓解 |
|---|---|---|
| Router 事件直接写死 jsonl，无 sink | P2 要改所有埋点 | 先收敛到 `append(event)` sink 接口 |
| 项目级 Advisor 先按 JSON 多例 | binding/经验/ticket meta 丢更新，P1/P3 返工 | 多例门禁：SQLite 前只允许单 Advisor 写；A2 等 P3a |
| 先迁 events 再迁 tickets | 事件与 ticket 状态无事务关联，时间线仍断 | P1 tickets 先；P2 events |
| 先迁 outbox | 状态与投递不同事务，重启重复/丢失窗口 | outbox 与 ticket 状态同事务，P3 一起或紧随 P1 |

## 7. 风险与未决问题

### 7.1 备份与恢复

- 备份必须在停写/checkpoint 后做；WAL 模式下直接复制 db 文件可能漏 `-wal`。推荐 `VACUUM INTO` 或 SQLite backup API，复制后校验 sha256。
- 每次迁移/DDL 前自动备份到 `state/backup/<timestamp>/`；保留最近 N 份 + 月备份。
- 恢复演练：至少在临时目录恢复一次并跑只读校验；不能只验证“文件存在”。

### 7.2 崩溃恢复

- WAL 崩溃后由 SQLite 自动重放；启动做 `integrity_check` + checkpoint；`-wal/-shm` 不手工编辑/删除（除明确恢复流程）。
- `synchronous=NORMAL` 在极端断电下可能丢最后一个事务（数据库仍一致）；迁移窗口/关键操作建议 FULL，稳态 NORMAL。
- 事件表是 best-effort 后置：崩溃可能缺最后几条事件，不回滚主操作；补写/审计可接受。若业务要求“事件绝不丢”，P2 再评估把关键事件并入事务（会牺牲可用性）。

### 7.3 DDL 变更

- `schema_meta` 记录版本；只向前迁移，禁止破坏性 DDL（DROP/RENAME 需新表+数据迁移+回滚脚本）。
- 每个 DDL 迁移前备份；迁移在事务中执行（SQLite DDL 事务性）；失败回滚到旧版本+备份。
- 代码启动时检查 schema 版本：低于代码→迁移；高于代码→拒绝启动。

### 7.4 文件与库不一致时的权威源

**推荐**：切换后 DB 权威；JSON 只读导出。启动检查：

- DB 不存在/损坏/版本过高 → 拒绝启动，提示恢复路径；不自动从 JSON 导入。
- DB 正常、导出 JSON 落后 → 告警并重建导出。
- 迁移窗口内（尚未切换）JSON 权威；切换后禁止双写。
- 人工修改 JSON 不会回流 DB；需要改数据必须走工具/API 或一次性导入脚本。

### 7.5 其他

- 单写者吞吐上限：当前量级足够；队列批处理/短事务；长读会拖 WAL，设置只读连接超时/定期 checkpoint。
- 迁移窗口停机/双写成本：P1 一次短停机；双写只在一个发布周期内，之后删旧写路径。
- JSON 列 vs 关系表：先保留 JSON 列（checklist/dependsOn/attempt 等），避免一次性大改；只把查询/唯一约束需要的列提出来。
- FTS5 可用性：P3 再评估，不阻塞主线。
- topics/links/grants/settings 暂留 ria.json：与 tickets 的关系未来可单独一票；不在本轮 scope。

### 7.6 明确不做

- 本轮不写实现代码、不改 schema、不改测试/配置。
- 不迁 transcript、reflections、memory、附件/产物。
- 不做跨机/Postgres、不做每 Advisor 独立库、不多进程写同一 SQLite。
- 不引入 ORM、不重写状态机/审批语义。
- 不做破坏性 DDL；不做 JSON/DB 双向写。
- 不在本项目内做 UI 迁移。

## 8. 推荐结论（一句话版）

先用文件/现有 JSON 把 **Router 事件日志** 与 **项目级 Advisor 设计** 固化；然后按 **P1 tickets+history（单写者+WAL）→ P2 事件流进 `ticket_events` → P3 其余（advisors/lessons/workers 优先）** 推进。项目级 Advisor 的多例落地必须等 P1 的单写者/事务与 P3a 的 advisors/lessons 表，不能在 JSON 上先并行写；`router-events.jsonl` 在 P2 进库、保留只读导出，不长期维持双权威。