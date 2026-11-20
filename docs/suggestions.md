下面是一份**可直接交给执行 Agent 落地的完整执行指南（Implementation Spec）**。指南严格对照当前仓库真实代码路径编写，分为**阶段一（去旧与解耦底座）**和**阶段二（两级 Project/Topic 自动归类 + Worker 打标与亲和路由）**，每个阶段都有明确的文件清单、Schema、算法契约和验收测试标准。

你可以直接把下面的 Markdown 复制发给执行 Agent（或保存为 `docs/exec-guide-pure-v2-topics-routing.md` 让它读取执行）。

---

```markdown
# dsh-ria 纯净 v2 收敛 + Project/Topic 自动分类 + Worker 打标路由 执行指南

## 0. 全局铁律（执行前必读）

1. **先读根 `DESIGN.md`**：遵守 `AGENTS.md` 约定，任何改动不得违背 `DESIGN.md` 的五条核心原则，且**严禁修改根目录 `DESIGN.md`**。
2. **零历史包袱策略**：当前无正式线上存量用户，**不兼容 v1（`{ v2: false }`），不保留任何历史数据迁移代码**。旧 schema 升级、旧角色别名兼容、旧状态备份逻辑一律彻底删除，保持代码最简。
3. **分阶段提交与验证**：严格按 `Phase 1 → Phase 2 → Phase 3 → Phase 4` 顺序推进；每完成一个 Phase，必须确保全量测试通过后再进入下一阶段。

---

## Phase 1：彻底清除 Legacy v1 与全部数据迁移代码

### 1.1 目标
移除单会话 PTC 管家（`{ v2: false }`）、旧有状态迁移分支、角色/字段改名兼容逻辑，使系统成为 **100% 纯 v2（Chat 快脑 + Sage 慢脑 + 无状态 Advisor + Router 控制面 + Worker）**。

### 1.2 必删文件与代码清单

1. **移除 `{ v2: false }` 模式与 v1 专属模块**
   - 删除文件：
     - `lib/approval-policy.mjs`（v1 审批启发式规则，v2 统一使用 `lib/v2/risk.mjs`）
     - `lib/approvals.mjs`（若确认 `V2Controller` 已完全自管审批则一并删除；若复用了 `approvalQuestion` 等纯格式化小函数，将其迁入 `lib/v2/risk.mjs` 后删除该文件）
     - `lib/worker-idle.mjs`（v1 `[Worker idle]` 监听器，v2 由 `V2Controller.onSessionEvent` 处理）
     - `scripts/sqlite-migrate.mjs`、`scripts/sqlite-maintenance-window.sh`（旧 JSON→SQLite 历史迁移脚本；保留 `scripts/sqlite-export.mjs` 供调试导出即可）
   - 清理 `lib/index.js`：
     - 删除 `apply(ctx, config)` 中的 `config.v2 === false` 分支，始终启动 `V2Controller`。
     - 删除 v1 单会话 `Ria` 的 `installManager`、`managerPrompt` 及 15 个 `ria_*` 工具（`ria_resolve`、`ria_ticket`、`ria_status`、`ria_spawn`、`ria_model`、`ria_title`、`ria_request`、`ria_read`、`ria_queue`、`ria_memory`、`ria_approval`、`ria_approval_decision`、`ria_grant`、`ria_send_file`、`ria_topic`）及其 `tool*` 方法。
     - 保留 `RiaService` 中被 v2、Web 看板（`/board*`）、设置页（`/settings`）、三大手机通道（WeChat / Claw / QQ）和 `Outbox` 复用的宿主能力。

2. **删除所有数据迁移与旧别名兼容代码**
   - `lib/tickets.mjs`：删除 `migrateV1State` 及 v1 `tasks` 字段兼容。
   - `lib/index.js`（`RiaStore`）：
     - 删除 `schemaVersion` 1/2/3/4 → 5 的逐级升级分支与 `.v1.bak` ~ `.v4.bak` 备份写入逻辑；直接读写当前唯一 schema。
     - 删除 `LEGACY_TICKET_LOG`（`tasks.log.jsonl`）与 `LEGACY_TICKET_LOG_PREFIX`（`tasks-`）兼容读取与重命名逻辑，仅保留 `tickets.log.jsonl` 与 `tickets-YYYY-MM.jsonl`。
   - `lib/v2/roles.mjs`：删除 `LEGACY_ROLE_CHAT = 'chatbot'`，角色 ID 严格使用 `'chat' | 'sage' | 'advisor' | 'worker' | 'reflection'`（注：`chatbot_*` 工具名可保留或按需整理，但内部 role/store 字段不再做双写双读兼容，store 中的 `chatbotSessionId` 可直接统一为 `chatSessionId`，`cognition/chatbot/` 统一为 `cognition/chat/`）。
   - `lib/v2/store.mjs` & `lib/v2/controller.mjs`：
     - 删除 `parsed.thinkers` → `advisors` 迁移、`meta.phase === 'thinker'` 归一化、`meta.mode === 'answer'` 兼容归一化。
     - 删除有状态 Advisor 遗留开关：`advisorMode`（`'legacy'` 分支）、`advisors` 字典、`ensureAdvisor`、`doEnsureAdvisor`、`retireLegacyAdvisor`、`sage.migrated`（旧 `stateDir/sage` 目录迁移）。Advisor 固定为**纯无状态调用**。
     - 删除 `bootstrapCognition()` 中从旧 `memory.md` 导入的兼容逻辑；若 v1 `lib/memory.mjs` 不再使用，一并清理并将设置页记忆视图对接到 `cognition/chat/`。

3. **清理对应的过时测试与 `package.json`**
   - 删除纯测 v1 `ria_*` 工具与迁移的测试文件（如 `test/v2-advisor-migration.mjs`、`test/sqlite-migrate.mjs`，以及仅针对 `{ v2: false }` 工具链的旧测试：`test/intake.mjs`、`test/spawn.mjs`、`test/model.mjs`、`test/title.mjs`、`test/recent-workers.mjs`、`test/worker-idle.mjs`、`test/working-guard.mjs`、`test/approval-automation.mjs` 等——删除前先核对其中是否有测试 `RiaStore`/`topics.mjs` 底层纯逻辑的用例，若有则保留纯 Store 测试或迁移为 v2 测试）。
   - 将 `package.json` 的超长串行 `"test"` 改为干净的测试运行脚本（如 `scripts/run-tests.mjs`，自动发现 `test/*.mjs` 并支持并发执行与失败汇总）。

---

## Phase 2：底座去重与巨石模块解耦（为新特性铺路）

### 2.1 统一共享底层工具 `lib/shared/`
消除当前散落在 7~10 个文件里的重复实现：
- `lib/shared/fs.mjs`（整合原 `lib/state/atomic-file.mjs`）：统一导出 `ensureDir`、`writeAtomic`、`writeJsonAtomic`、`readJsonSafe`。替换 `channels/common.mjs`、`wechat/service.mjs`、`outbox.mjs`、`v2/cognition.mjs`、`v2/lessons.mjs`、`v2/co-management.mjs`、`reflection.mjs` 中的手写 `openSync + fsyncSync + renameSync`。
- `lib/shared/text.mjs`（整合原 `lib/text-size.mjs`）：统一导出按 Unicode 码点安全截断的 `clip(value, maxChars, suffix = '…')`、`measureText`、图片魔数检测 `imageMediaType(bytes)`。

### 2.2 拆解 `lib/v2/controller.mjs`（按职责划清模块边界）
在写新路由逻辑前，将 `V2Controller` 拆分为职责单一的子模块（放在 `lib/v2/` 下）：
1. `lib/v2/worker-pool.mjs`：**（核心复用点）** 收拢所有 Worker 元数据管理、可用性硬过滤（`isWorkerSelectable`）、亲和度打分排序、失效绑定自动剔除（`selectResolvableWorker`）、新建/重建（`createIdleWorker` / `recreateWorker`）和启动对账（`reconcileWorkerBindings`）。
2. `lib/v2/approval-coordinator.mjs`：收拢 `tools/pre-execute` 参数缓存、`risk.mjs` 评估、挂起句柄结算（`pendingSettlers`）与审计。
3. `lib/v2/tools/`：将 `install(agent, role)` 拆分为 `chat-tools.mjs`、`sage-tools.mjs`、`worker-tools.mjs`、`reflection-tools.mjs` 与统一的权限收窄器 `tool-guard.mjs`。

---

## Phase 3：两级 `Project / Topic` 自动总结分类（弱关联设计）

### 3.1 领域模型与不变量

1. **两级结构：`Project (可空) / Topic`**
   - **`projectKey`（一级，可空 `string | null`）**：
     - 注意概念边界：**`Project` 不等同于物理 `Workspace`（目录）**，只是当前阶段默认用规范化后的项目标识来派生（复用 `projectKey(workspace)`，如 `dsh-ria-a1b2c3d4`，同时在 project 元信息或推导函数中保留可读标题 `basename(workspace)` 与 `cwd`；未来一个 Project 可对应多个 Workspace 或无目录项目）。
     - 当工单没有所属项目（全局事务）时，`projectKey = null`（在看板上投影为顶层的「未归属项目 / 全局」列）。
   - **`Topic`（二级，`lib/topics.mjs` 演进）**：
     ```js
     {
       topicId: 'topic_...',
       projectKey: string | null,     // 新增：所属一级 Project，可为 null；不做强外键阻塞
       title: string,                 // 主题标题（≤ 60 字，概括一组相关工单的方向，不复读单票）
       brief: string,                 // 可选人工/Sage 摘要；为空时由 topicSummaryInfo 动态从最新工单生成
       tags: string[],                // 新增：该主题关联的归一化领域标签（最多 6 个，供路由与检索参考）
       createdAt: number,
       updatedAt: number,
       archivedAt: number | null,
       mergedInto: string | null,
     }
     ```
     *注：去掉 v1 `Topic` 里未真正用起来的 `level: 1|2` 和 `parentId` 树嵌套，因为现在明确定义为清晰的 **`Project (可空) → Topic`** 两级结构。*

2. **Topic 与 Ticket 的弱关联契约（Weak Association）**
   - 保持独立关联表 `links: [{ topicId, ticketId, role: 'primary' | 'related', at }]`，一张 Ticket 最多 1 个 `primary` Topic。
   - **弱关联铁律**：
     - Topic 的创建、匹配、更新、合并或归档，**绝不影响 Ticket 状态机与 Worker 派发**；如果 Topic 处理发生任何异常，只记 `router-events.jsonl`（`topic.auto_assign.degraded`），工单照常派发并在看板落入对应 `projectKey` 下的合成 `unclassified` 桶。
     - Topic 不拥有 Worker，归档或合并 Topic 不停止、不销毁任何 Worker。

### 3.2 候选召回（`lib/topics.mjs` 升级）
升级纯函数 `topicSuggestions({ goal, projectKey = null, topics, links, tickets, limit = 8 })`：
- **同级优先过滤**：优先在 `topic.projectKey === projectKey`（同项目，或同为 `null`）的活跃 Topic 中用 `topicMatchScore`（汉字二元 gram + 英文数字词元 Dice 重叠度 + 标签命中加分）计算得分；若同 `projectKey` 下活跃 Topic 不足 `limit` 个，就算分很低也按 `updatedAt` 倒序把同项目的最近活跃 Topic（最多 8 个）一并返回给 Advisor 视野，**防止因用词不同导致 Advisor 看不见同项目刚建的 Topic 而重复创建**！

### 3.3 Advisor 零额外开销顺手归类（`lib/v2/advisor.mjs`）
**不增加任何额外的 LLM 调用**，直接合入无状态 Advisor 单次生成 `WorkOrder` 的输入输出契约：

1. **`buildAdvisorPlanInput` 新增输入段（严格控制在 500 字符内）**：
   ```text
   [候选主题 (Project: <projectKey || 'global'>)]
   - topic_xxx: 看板与主题视图 — 待执行 1 · 已完成 3 [tags: frontend, board]
   - topic_yyy: SQLite 控制面存储 — 执行中 1 [tags: sqlite, state]
   （若已有候选明显契合本票方向，优先 reuse 其 topicId；若无契合方向，用 create 新建简短方向标题，切勿把单张工单原话当标题）
   ```
2. **Advisor JSON 输出契约扩展**：
   在 `action === 'plan'` 的 `workOrder` 中新增可选对象 `topic`：
   ```json
   "topic": {
     "action": "reuse" | "create",
     "topicId": "topic_xxx",
     "title": "新主题短标题（create 时必填，≤40字）",
     "brief": "可选一句话方向说明（≤120字）"
   }
   ```
   *容错要求*：`parseAdvisorOutput` 对 `topic` 做宽容解析——即便模型漏填或填错 `topic` 字段，`workOrder` 本身依然 `ok: true`，绝不因为分类字段格式瑕疵导致整张工单 plan 失败！

3. **Router 确定性落盘与防重（`V2Controller` / `TopicService`）**：
   当 `planTicketStateless` 拿到 `parsed.workOrder` 后，在派发前同步执行确定性归类 `assignTicketTopic(ticket, meta, workOrder.topic)`：
   - **Case A（`action === 'reuse'`）**：校验 `topicId` 是否存在、未归档、未合并，且 `topic.projectKey === ticketProjectKey`；校验通过则 `linkTopic(ticketId, topicId, 'primary')`。
   - **Case B（`reuse` 的 ID 无效/幻觉，或 `action === 'create'`）**：
     - 取 `title`（若模型连 `topic` 都没输出，兜底尝试用 `topicSuggestions` 最高分且 `score >= 0.45` 的同项目 Topic 自动复用；若无高分匹配，则允许暂时不挂 Topic 留给看板 `unclassified` 或用精简标题创建）。
     - **防重守卫**：创建新 Topic 前，检查同 `projectKey` 下是否已有归一化标题完全相同或 `topicMatchScore(newTitle, existing.title) >= 0.75` 的活跃 Topic；若有，直接自动转为复用该已有 Topic！
     - 否则创建新 Topic（带上 `projectKey` 与本票的 `routing.tags`）并挂 `primary` 链接，记录 `routerEvent('topic.auto_assigned', { mode: 'reused'|'created', topicId, projectKey })`。

---

## Phase 4：Worker 打标体系与防错亲和路由

### 4.1 标签归一化规则（`lib/v2/tags.mjs` 新建纯函数模块）
所有进入系统的标签（无论来自用户、Advisor 还是自动习得）统一经过 `normalizeTags(input, max = 8)`：
- 转小写、trim、空白/下划线统一转为连字符 `-`，只保留 `[a-z0-9\u4e00-\u9fff._-]`，单标签长度 `1..32`，去重保序。

### 4.2 Worker 双层标签数据模型（`lib/v2/store.mjs`）
在 `v2.json` 的 `workers[sessionId]`（同时适用于 `kind: 'managed'` 和 `kind: 'co-managed'`）上扩展以下字段，`normalizeWorker` 给足默认值：
```js
{
  // ...既有字段 (sessionId, seq, kind, workerType, scope, projectId, projectCwd, cwd, preset, status, allowAutoDispatch...)
  tags: [],            // string[]：显式能力标签（由用户通过 Chat 设置，高权重，最多 12 个）
  roleNote: '',        // string：一句话职责备注（≤ 120 字，如“专职前端 UI 与样式调试”）
  dedicated: false,    // boolean：专职保护开关！为 true 时，自动派单仅当 ticket 命中其 tags 时才可选中它，绝不接无交集杂活
  autoTags: [],        // string[]：软性自动习得标签（新建时或完成工单后滚动吸收，低权重，最多 8 个）
  recentTopics: [],    // string[]：最近处理过的 primaryTopicId 列表（MRU 队列，最新在前，最多保留 5 个）
}
```

### 4.3 Advisor 路由标签输出（与 Phase 3 同一次调用）
1. **输入注入词表**：在 `buildAdvisorPlanInput` 中注入当前目标范围（同 `projectCwd` / `global`）内已有 Worker 的 `tags ∪ autoTags` 词表（如 `[可用 Worker 标签词表] frontend, sqlite, channels, docs`），引导 Advisor 优先使用已有标签词，避免同义词漂移；若有 `roleNote` 的专职 Worker，也简短列出（如 `Worker 2 [sqlite, dedicated]: 数据库事务专用`）。
2. **输出契约**：`workOrder` 中新增：
   ```json
   "routing": {
     "tags": ["frontend", "board"],
     "requireTagMatch": false
   }
   ```
   - `tags`：本票所需的 1~4 个领域/技能标签。
   - `requireTagMatch`：默认 `false`；仅当本票需要特定专长、宁可新建干净 Worker 也不应复用无关空闲 Worker 时设为 `true`。
   - 同时支持用户在 `chatbot_request` 中显式传入可选的 `preferredTags?: string[]`（与 Advisor 产出的 `routing.tags` 合并，用户显式传入的优先）。

### 4.4 Router 选人算法升级：硬过滤 + 亲和度打分（`lib/v2/worker-pool.mjs`）

将原先仅按 `lastUsedAt` 倒序盲选的逻辑，替换为确定性的两阶段路由算法 `rankCandidateWorkers(workers, context)`（纯函数，必须有独立单元测试）：

#### 第一阶段：硬过滤（Hard Filter —— 消除路由错误的底线）
候选 Worker 必须同时满足：
1. 既有安全条件：`status === 'idle'`、无 `currentTicketId`、无未关闭 turn、未归档、`workerType` 匹配（`work` vs `reflection`）、`cwd / projectCwd` 匹配、`allowAutoDispatch !== false`。
2. **专职 Worker 保护（核心防错）**：
   - 若 `worker.dedicated === true`：检查 `ticketTags ∩ worker.tags` 是否非空。**若交集为空（包括 `ticketTags` 为空的情况），直接淘汰该 Worker！**（确保用户设定的专职 Worker / 特殊模型 Worker 永远不会被普通杂活污染）。
3. **工单强标签要求**：
   - 若 `ticket.requireTagMatch === true` 且 `ticketTags.length > 0`：检查 `ticketTags ∩ (worker.tags ∪ worker.autoTags)` 是否非空。若为空，直接跳过该空闲 Worker（若所有空闲 Worker 都被跳过，Router 将走新建 Worker 分支）。

#### 第二阶段：软打分排序（Affinity Scoring —— 优先复用最对口、上下文最热的 Worker）
对通过硬过滤的每个候选 Worker 计算确定性总分 `score`：
- **显式标签命中**：每个命中的 `tag ∈ (ticketTags ∩ worker.tags)` **+100 分**；
- **主主题直接命中（最热上下文）**：若本票 `primaryTopicId` 等于 `worker.recentTopics[0]`（上一单刚干的就是这个 Topic） **+60 分**；若在 `worker.recentTopics[1..4]` 中 **+35 分**；
- **软性习得标签命中**：每个命中的 `tag ∈ (ticketTags ∩ worker.autoTags)`（排除已计入显式 `tags` 的词） **+25 分**；
- **未命中任何标签时的空闲通用度微调**：若本票没有特定标签或均未命中，优先选身上没有专长包袱的通用 Worker，最后以 `lastUsedAt` 新旧折算 **0 ~ 10 分** 作为 tie-breaker（同分再按 `seq` 升序保证完全确定性）。

Router 将排序后的候选列表交给 `selectResolvableWorker` 依次验证存活并占用，并把命中原因写入 `router-events.jsonl`（`dispatch.attempt` 的 `payload` 增加 `routing: { ticketTags, topicId, selectedScore, matchedExplicitTags, matchedAutoTags, matchedTopic, createdNew }`，方便事后审计为什么选了这个 Worker）。

#### 第三阶段：软标签与最近主题的自动演化（你的拍板策略）
1. **自动新建 Worker 时（`createIdleWorker`）**：
   - **不设显式 `tags`，`dedicated` 保持 `false`**（保持通用可复用性，防止池子无限膨胀）；
   - 将本票的 `ticketTags` 写入软性的 **`autoTags`**，将本票的 `primaryTopicId`（若有）写入 **`recentTopics: [topicId]`**。
2. **已有 Worker 派单 / 完结工单（`done`）时**：
   - 将本票 `primaryTopicId` 推入 `worker.recentTopics` 队首（去重，截断保留最近 5 个）；
   - 将本票 `ticketTags` 以 MRU 方式并入 `worker.autoTags`（排除已在显式 `worker.tags` 中的词，截断保留最近 8 个）。
3. **Preset 重建 Worker 时（`recreateWorker`）**：
   - 继承原 Worker 的 `tags`、`roleNote`、`dedicated`（除非同次 `chatbot_worker_config` 调用显式覆盖）；`autoTags` 与 `recentTopics` 清空（因为已是全新会话上下文）。

---

## Phase 5：Chat / Sage 工具面闭环与看板展示

### 5.1 Chat（快脑）工具扩展
1. **`chatbot_worker_config`（`get` / `set`）**：
   - `get` 返回每个 Worker 的 `tags`、`autoTags`、`recentTopics`、`roleNote`、`dedicated`。
   - `set` 支持修改 `tags: string[]`（传 `[]` 清空显式标签）、`roleNote: string`、`dedicated: boolean`，立即生效并记录 `worker.config.changed` 事件。
2. **`chatbot_co_manage`（`add` / `set` / `list`）**：
   - 将常规会话注册为协管执行者时，同样支持设置 `tags: string[]`、`roleNote: string`、`dedicated: boolean`（协管会话强烈建议用户可设 `dedicated: true` + `tags`，避免无关工单误入用户正在聊的常规会话）。
3. **`chatbot_request`**：
   - 新增可选参数 `preferredTags?: string[]`、`topicId?: string`（用户从看板某张主题卡点「说」发起需求时，或明确指定方向时可直接传入）。

### 5.2 Sage（慢脑）Topic 与标签园丁工具
在 `sage-tools.mjs` 中为 Sage 增加一个轻量治理工具 **`sage_topic`**（只管整理结构，不改 Ticket 状态、不派单）：
- 支持 `action: 'list' | 'update' | 'merge' | 'archive'`（直接调用底层 `RiaStore` / `topics.mjs` 的 `updateTopic`、`mergeTopic`、`archiveTopic`）。
- 在 `sagePrompt` 中补充职责：定期反思或收到整理请求时，检视同 `projectKey` 下语义重复的活跃 Topic 并执行 `merge`（自动迁移所有 `links`），对全部工单已完结且陈旧的 Topic 执行 `archive`，并将稳定下来的领域标签规范沉淀到 `cognition/projects/<key>.md`，供后续无状态 Advisor 对齐词表。

### 5.3 Web 看板适配（`lib/index.js` `/board` + `lib/client.js`）
- `/board` 接口在组装 `projects[]` 泳道时，优先按 Ticket/Topic 的 `projectKey` 归组（`projectKey === null` 归入独立的全局泳道），兼容展示项目的可读标题与 `cwd`。
- 在工单详情弹窗 / 执行者信息与设置或状态视图中，透出 Worker 的 `tags`（及 `dedicated` 标记），让用户一眼看清每个 Worker 的定位。

---

## 验收与测试清单（Definition of Done）

执行 Agent 完成全部阶段后，必须新增并通过以下自动化测试，且 `npm test` 全绿：

1. **纯 v2 验证（`test/pure-v2-boot.mjs`）**：
   - 验证仓库中已不存在 `v2: false`、`migrateV1State`、`advisorMode: 'legacy'`、`LEGACY_ROLE_CHAT`、`approval-policy.mjs`；启动后仅有纯 v2 角色与工具集。
2. **两级 Project/Topic 自动归类测试（`test/v2-topic-auto.mjs`）**：
   - 带 `workspace` 的工单自动派生 `projectKey`，无 `workspace` 的工单 `projectKey === null`；两者的候选 Topic 互不串台。
   - Advisor 返回 `topic.action = 'create'` 时自动建 Topic 并挂 `primary` 链接；返回同义近似标题时被 Router 防重守卫自动收敛为复用已有 Topic。
   - Advisor 返回不存在的幻觉 `topicId` 或漏填 `topic` 字段时，工单依然成功进入 `working`，绝不阻塞主流程。
3. **Worker 打标与防错亲和路由测试（`test/v2-worker-tag-routing.mjs`）**：
   - **专职防错**：Worker 1 设 `tags: ['sqlite'], dedicated: true` 且 `lastUsedAt` 最新；此时来一张 `tags: ['frontend']` 或无标签工单 → 断言 **绝不选中 Worker 1**，而是选中空闲通用 Worker 2 或自动新建 Worker 3。
   - **亲和度优先**：Worker 1（`tags: ['frontend']`，较早空闲）与 Worker 2（无标签，刚刚空闲）同时 idle；来一张 `tags: ['frontend']` 工单 → 断言按分数优先选中 Worker 1 而非盲选 `lastUsedAt` 最新的 Worker 2。
   - **软标签习得**：无可用空闲 Worker 时为 `tags: ['board']`、主题 `topic_1` 新建的 Worker 3，默认 `tags: []`、`dedicated: false`、`autoTags: ['board']`、`recentTopics: ['topic_1']`；下一张同属 `topic_1` 的工单优先复用 Worker 3；而当池中无其他空闲 Worker 且来了一张 `tags: ['docs']` 的普通票时，Worker 3 仍可作为通用 Worker 被复用。
4. **Sage 治理闭环测试（`test/v2-sage-topic.mjs`）**：
   - Sage 调用 `sage_topic { action: 'merge' }` 能正确合并两个碎片 Topic 的 `links`；对仍有未完成工单的 Topic 调 `archive` 返回 `topic_unfinished` 拒绝。
```

---

### 给你的使用建议

如果负责执行的 Agent 支持长任务推进（比如开启 Goal 或交给擅长重构的模型），你可以直接把上面整段文档喂给它，并交代一句：
> **「请先阅读根目录 `DESIGN.md`，然后严格按照这份执行指南分 Phase 1 ~ Phase 5 依次落地，每完成一个 Phase 跑通对应测试并提交一次清晰的 git commit。」**

如果你想把风险拆得更细，也可以让两个先后衔接的任务分别做：**第一单专做 Phase 1 + Phase 2（大扫除删掉几千行老代码 + 拆解 `V2Controller`）**，验收清爽后再派**第二单做 Phase 3 ~ Phase 5（Project/Topic 自动归类 + Worker 打标路由）**，这样代码 diff 最干净、最好 review。需要我直接把这份指南写入仓库里的 `docs/` 目录保存下来吗？