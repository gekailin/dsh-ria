# 认知沉淀重构：缺口审计与收尾实施清单

> 本文档基于截至 `8f93bd4` 的实际代码与本机 `~/.dsh/state/ria/ria.sqlite` 核验结果编写，列出与 [cognition-redesign-plan.md](./cognition-redesign-plan.md) 对照后**尚未完成或存在断路**的全部事项，可直接交给其他 Agent 按优先级逐项收尾。
>
> **合规约束**：实施前先读根目录 `DESIGN.md`（不得直接修改）；改动完成后必须跑通全量 `npm test`（含 `test/pack-integrity.mjs`）。

---

## 一、总览：已完成 vs 未完成

已完成（基线可复用）：
- SQLite 四表已建：`cognition_entries`、`cognition_projects`、`cognition_proposals`、`cognition_receipts`（`lib/state/sqlite/schema.mjs:81-141`）。
- `ria_sage_decide` 四态裁决（`accepted`/`rejected`/`deferred`/`merged` + 必填 `rationale` + `cognition_receipts`）已实现。
- Chat 动态注入 `voicePrompt(settings.style)` 已接入（`lib/core/controller.mjs:1179-1193`）。
- `executorReport` 的提案 `author` 已区分 `reflection` 与 `executor:<id>`（`lib/core/controller.mjs:6550-6551`）。
- `ria_reflect_read_sage_context` 已切换读取 SQLite。

**未完成 / 严重断路（共 4 大项，按实施顺序排列）**：
1. **P0 — 修断路**：`propose()` 仍在写旧文件不进 SQLite；`chatDigest()` / `retrieve()` 仍在读旧 Markdown；`chatProjectSummary()` 永远为空；经验检索与 `workOrder.experience` 精选未打通。
2. **P1 — 补闭环**：`ria_sage_request` 缺少参数扩展与终态回传 Sage 闭环；`ria_sage_write`/`ria_sage_read` 缺少项目维护与状态变更；`ria_reflect_report` 缺少 `cognitionActions` 直通 Sage。
3. **P1 — 落 Prompt**：`RIA_SHARED_HEAD` 与五套 Prompt 尚未按方案重写，旧术语与矛盾描述仍在。
4. **P2 — 洗存量数据**：本机 `ria.sqlite` 里 107 条 `cognition_entries` 全为非法 `cog_md_*` ID、65 条被截断、`cognition_projects` 为空（0 行）。

---

## 二、P0：修复半切换断路（最优先）

### 2.1 `CognitionStore.propose()` 切换写 SQLite，且新提案直接唤醒 Sage

- **状态：已实现。** `propose()` 直接 INSERT `cognition_proposals`（`lib/roles/cognition.mjs:558`），支持 kind/target/body/cause/sources；controller `notifySageProposal` 对所有来源以 queue 唤醒 Sage（`lib/core/controller.mjs:3477`），schema 扩展见 `lib/tools/registry.mjs:381`。测试：`test/sage.mjs`、`test/cognition-wiring.mjs`。
- **现状问题**：`lib/roles/cognition.mjs:549-559` 的 `propose()` 仍在往 `cognition/proposals/<id>.json` 写文件，而 `listProposals()` / `getProposal()` / `decideProposal()` 均从 SQLite `cognition_proposals` 读取。**所有新提交的提案对 Sage 不可见**。
- **改动要求**：
  1. `propose({ author, source, kind = 'add', targetEntryId = null, ticketId = '', scope = 'global', body, text, cause = '', sources = [], evidence = [], priority = 'normal' })`：
     - 兼容入参：`body` 缺省回退 `text`；`sources` 缺省时将 `evidence` 字符串数组转为 `[{ type: 'file'|'ticket'|'session'|'commit'|'reflection'|'user', ref }]`（可按前缀解析，无前缀默认 `file` 或 `ticket`）。
     - 直接 `INSERT INTO cognition_proposals(...)` 写入 SQLite（不再写 `proposals/*.json`）。
     - 校验 `kind` 为 `add` | `correct` | `retire`；`targetEntryId`（若提供）校验格式 `^cog_\d+$`。
  2. **所有提案来源统一唤醒 Sage（不做防抖）**：
     - 在 `controller.mjs` 封装 `notifySageProposal(proposal)`：只要写入新提案（来自 `ria_chat_propose`、Advisor `persistWorkOrder`、`executorReport` 或 Reflection），立即以 `queue` 模式 `promptSession(sage, ...)` 唤醒 Sage，提醒中附带提案 `id`、`author`、`scope`、`kind`、正文摘要及当前 `pendingCount` / `disputedCount`。
  3. `lib/tools/registry.mjs` 的 `ria_executor_report.cognitionProposal` 与 `ria_chat_propose` 同步扩展可选参数 `kind`（`add`/`correct`/`retire`）、`targetEntryId`、`body`、`cause`、`sources`（兼容保留 `text`/`evidence`）。

### 2.2 `chatDigest()`、`chatProjectSummary()`、`retrieve()` 全部切 SQLite

- **状态：已实现。** `chatDigest()` 查 SQLite user:preference/agreement（`lib/roles/cognition.mjs:503`）；`listProjects()`（`:283`）与 `chatProjectSummary()` 列全部活跃项目（`lib/core/controller.mjs:1196`）；`retrieve()` 用 SQLite scopes（`:481`）；CHAT_MEMORY_LIMIT=2800（`lib/core/controller.mjs:64`）。测试：`test/chat-memory-prompt.mjs`、`test/cognition-wiring.mjs`、`test/advisor-stateless.mjs`。
- **历史问题（已修复）**：旧实现读 Markdown/1500 字并按 Chat cwd 过滤项目；现均走 SQLite。
- **改动要求**：
  1. `CognitionStore.chatDigest()`：
     - 从 SQLite 查 `scope IN ('user:preference', 'user:agreement') AND status = 'active'`，按 `updated_at DESC, id ASC` 排序。
     - 仅渲染 `- [<id>] <body>`（剥离 `cause` 与 `sources`），预算 **<= 1600 字符**。
  2. `CognitionStore.listProjects({ status = 'active' } = {})` 与 `controller.chatProjectSummary()`：
     - 不再依赖 `context.cwd` 过滤，而是列出所有 `status = 'active'` 的项目（上限 10 个，预算 **<= 1000 字符**）：每行渲染 `- <name> (<project_id>) | workspaces: <paths> | <overview首句摘要>`，供 Chat 根据用户口头简称识别并填入正确的 `workspace`。
  3. `controller.mjs` 的 `CHAT_MEMORY_LIMIT` 从 `1500` 调整为 `2800`（覆盖 `[长期记忆摘要]` 完整区块）。
  4. `CognitionStore.retrieve({ workspace, goal, tags = [] })`：
     - 改为读 SQLite：
       - `[Principles]`：读 `principles.md`（若保留）或 `scope='principle'`；
       - `[Project Overview]`：调用 `resolveProjectsForWorkspace(workspace)`（支持 1 项目多 workspace），渲染匹配项目的 `name`、`workspaces`、`overview`；
       - `[Candidate Experience]`：检索匹配项目 `project:<projectId>` + `global` + 命中 `tags` 的 `domain:<tag>` 下的 `active`/`disputed` 条目，取 **Top 8**（含 `id`、`scope`、`body`、`cause` 摘要及 `[待核实]` 标记）。

### 2.3 修复经验检索算法 + 打通 Advisor 精选 `workOrder.experience` → Executor Brief

- **状态：已实现。** `searchEntries` 支持 scopes + tokenize 分词/标签/project 权重（`lib/roles/cognition.mjs:249`）；`selectAdvisorExperience` 用 `resolveProjectsForWorkspace` 生成 scopes（`lib/roles/cognition-experience.mjs:22`）；Advisor 解析/持久化 experience（`lib/core/advisor.mjs:109`），dispatch 记录 experienceIds（`lib/core/controller.mjs:6130`），Brief 渲染 `[相关历史经验（必读）]`（`lib/prompts/shared.mjs:242`）。测试：`test/advisor-experience.mjs`。
- **现状问题**：
  - `lib/roles/cognition-experience.mjs:22` 用的是 `'project:' + projectKey(workspace)`（带 hash），和数据库里真实的 `project:dsh-ria` 匹配不上，也没有走 `resolveProjectsForWorkspace(workspace)`；
  - `lib/roles/cognition.mjs:259` 的 `searchEntries` 用的是整句 `LIKE '%完整goal%'`，长工单描述几乎必返 0 条；
  - `lib/core/advisor.mjs` 与 `lib/prompts/advisor.mjs` 未增加 `workOrder.experience` 字段，Advisor 无法精选经验。
- **改动要求**：
  1. 升级 `CognitionStore.searchEntries({ scopes, scope, tags, text, limit = 8 })`：
     - 支持 `scopes: string[]`（`scope IN (...)`）；
     - 关键词检索改为分词打分（复用 `lib/store/lessons.mjs` 的 `tokenize()`：CJK bigram + 英文词元），对 `body + cause + tags` 算分，加上 `tags` 交集加权、`project:*` 优先于 `global`，按 `score DESC, updated_at DESC` 排序取 Top-K。
  2. 升级 `selectAdvisorExperience`（`lib/roles/cognition-experience.mjs`）：
     - 先用 `cognition.resolveProjectsForWorkspace(workspace)` 解析出所有匹配的 `projectId`；
     - 构造候选作用域：`[...matchedProjects.map(p => 'project:' + p.projectId), 'global', ...tags.map(t => 'domain:' + t)]`；
     - 调用分词版 `searchEntries` 召回 Top 8 候选喂给 Advisor。
  3. 扩展 Advisor 输出契约与解析（`lib/core/advisor.mjs`、`lib/tools/registry.mjs`）：
     - `workOrder` 新增可选字段 `experience`: `Array<{ id: string, guidance: string }>`（最多 4 条，过滤空项与非法 id）。
     - `persistWorkOrder` 保存 `workOrder.experience`。
  4. 升级派发注入（`lib/core/controller.mjs:5870`、`lib/prompts/shared.mjs`、`lib/roles/co-managed.mjs`）：
     - `resolveLessonsForDispatch` 改名为/升级为优先消费 `workOrder.experience`（Advisor 精选）；若 Advisor 未显式选择则保持空（不再无脑塞无关经验），并在 `dispatch.attempt` payload 中记录 `experienceIds`。
     - `executorBrief` 与 `coManagedBrief` 渲染 `[相关历史经验（必读）]`（总长 <= 1000 字符），每条带 `[cog_X]` 与 `guidance`（并可在必要时查库附简短 `cause`）。

---

## 三、P1：补全 Sage 与 Reflection 闭环

### 3.1 `ria_sage_request` 升级与核查工单终态回调闭环

- **状态：已实现。** sage_request 支持 workspace/relatedEntryIds/relatedProposalId（`lib/tools/registry.mjs:457`），meta 保存关联（`lib/core/controller.mjs:3576`）；终态回调 `notifySageResearchResult`（`:3588`）接入 done/no_report/failed/error/stop。测试：`test/sage-request.mjs`。
- **现状问题**：`lib/tools/registry.mjs:437-446` 与 `lib/core/controller.mjs:3541-3547` 仍是旧实现，无 `workspace`/`relatedEntryIds`/`relatedProposalId`，且核查工单结束时不会通知 Sage。
- **改动要求**：
  1. `ria_sage_request` 新增可选参数：
     - `workspace?: string`（绝对路径；查某项目代码时透传给 `requestTicket`，允许 `mode='work'` 或 `mode='reflection'` 携带只读核查上下文，注意 `requestTicket` 若对 `reflection` 拒绝 `workspace` 需针对 `origin==='sage'` 放行只读 `projectCwd` 或在目标里明确工作区路径）；
     - `relatedEntryIds?: string[]`（关联待核查的 `cog_<N>` 列表）；
     - `relatedProposalId?: string`（关联待裁决的提案 ID）。
  2. 将 `relatedEntryIds`、`relatedProposalId` 存入 `ticketMeta`（与 `origin: 'sage'` 同存）。
  3. **终态回调 `notifySageResearchResult(ticket, status, reportOrReason)`**：
     - 在 `settleDoneReport`、`settleDoneNoReport`、`settleFailedReport`、`settleTurnError`、`chatStopTicket` 处检查 `meta.origin === 'sage'`；
     - 命中时向 `sageSessionId` 发送 `[Sage 核查回执]`（`queue` 模式），包含：`ticketId`、`status`、`relatedEntryIds`、`relatedProposalId`、`summary`、`evidence`（或失败原因），并写一条 `sage.research.notified` router event。

### 3.2 补齐 `ria_sage_read` 与 `ria_sage_write` 的 SQLite 管理能力

- **状态：已实现。** `setEntryStatus`/`upsertProject`/`summary`（`lib/roles/cognition.mjs:283/302/322`）；Sage read view（`lib/core/controller.mjs:3495`）与 write action（`:3523`）。测试：`test/sage-management.mjs`。
- **现状问题**：Sage 无法维护 `cognition_projects`（表现在是 0 行），无法用专用动作变更条目状态（`disputed`/`retired` + `superseded_by`），`ria_sage_read` 也无法查库概况与项目列表。
- **改动要求**：
  1. `CognitionStore` 新增：
     - `setEntryStatus(id, { status, reason = '', supersededBy = null })`：更新 `status`、`dispute_reason`、`superseded_by`、`updated_at`（若 `status === 'active'` 则清 `dispute_reason` 并更新 `verified_at`）。
     - `upsertProject({ projectId, name, workspaces = [], overview = '', status = 'active' })`：写入/更新 `cognition_projects`（校验 `workspaces` 为绝对路径数组、`overview <= 1500` 字）。
     - `summary()`：返回按 `scope`/`status` 分组的条目计数、活跃项目数、`pending` 提案数与 `disputed` 条目 ID 列表。
  2. `ria_sage_read`（`lib/tools/registry.mjs` & `controller.sageRead`）新增参数：
     - `view?: 'summary' | 'entries' | 'entry' | 'projects' | 'inbox'`（保留既有 `id`/`query`/`scope`/`inbox` 兼容）。
  3. `ria_sage_write`（`lib/tools/registry.mjs` & `controller.sageWrite`）支持：
     - `action: 'upsert_entry' | 'set_status' | 'upsert_project'`（兼容既有 `{ entry }` 写法）；
     - `set_status` 传 `{ id, status, reason?, supersededBy? }`；
     - `upsert_project` 传 `{ project: { projectId, name, workspaces, overview, status? } }`。

### 3.3 Reflection 兜底闭环直通 Sage

- **状态：已实现。** readMemoryContext 读 SQLite digest/projects（`lib/reflection.mjs:875`）；Sage context 补 projects/disputedEntries（`lib/reflection-sage-context.mjs:118`）；reflect_report 接受并持久化 cognitionActions（`lib/index.js:5760`），done 后生成 high 提案并唤醒 Sage（`:5775`）。测试：`test/reflection-memory-context.mjs`、`test/reflection-sage-sqlite.mjs`、`test/reflection-actions.mjs`。
- **历史问题（已修复）**：旧报告曾无 cognitionActions，readMemoryContext 曾读 Markdown。
- **改动要求**：
  1. `lib/reflection.mjs` 的 `readMemoryContext` 改读 SQLite（与 `chatDigest()` + `listProjects()` 一致）。
  2. `lib/reflection-sage-context.mjs` 的 `buildSqliteContext` 补充返回 `projects` 列表和 `disputedEntries` 列表（不限 `since` 时间窗，确保反思能发现长期悬而未决的争议条目和全部项目状态）。
  3. `ria_reflect_report`（`lib/index.js:5717` & `5877`）新增可选参数 `cognitionActions`：
     - 数组，最多 5 项，每项 `{ kind: 'add'|'update'|'retire'|'audit_fix', targetEntryId?, scope, body, cause, sources, reason }`。
     - 将 `cognitionActions` 持久化到 `run.json`。
  4. 反思工单 `done` 落盘后（`writeReflectionCanonicalFromTicket` 旁）：
     - 自动把 `run.cognitionActions` 逐条写入 `cognition_proposals`（`author: 'reflection', source: 'ria_reflect_report', priority: 'high'`，幂等去重）；
     - 立即唤醒 Sage 执行修订。

---

## 四、P1：完整重写五套 Prompt

按 [cognition-redesign-plan.md](./cognition-redesign-plan.md) 第 4 节原文落地，重点修正以下遗漏：
1. **`lib/prompts/shared.mjs`**：
   - 新增共享常量 `RIA_SHARED_HEAD`（简要介绍 Ria 全局定位与五角色分工），仅拼接在 `chatPrompt()` 和 `sagePrompt()` 头部。
   - **Chat Prompt**：补上 `[说话风格]`、`[用户偏好与约定]`、`[活跃项目概况]` 的消费规则与主动调 `ria_chat_propose` 的时机；删除冗余历史包袱。
   - **Sage Prompt**：彻底去掉 `cognition/chat/`、`projects/<key>.md`、`INDEX.md` 文件路径描述；改为 SQLite `scope` 划分、`ria_sage_read(view=...)`、`ria_sage_write(action=...)`、`ria_sage_decide`、`ria_sage_request` 核查闭环与自主新陈代谢流程；明确无标题、正文 <= 250 字、成因 <= 600 字、细粒度 `sources`。
   - **Advisor Prompt**（含 `lib/prompts/advisor.mjs`）：**删掉第 90 行遗留的 `2. Answer` 矛盾描述**；加入 `workOrder.experience` 精选职责与 JSON Schema 字段。
   - **Executor Prompt**：加入开工必读 `[相关历史经验（必读）]`、普通顺利工单不提提案、发现 `cog_X` 失实时发 `kind="correct"` 纠偏提案。
2. **`lib/prompts/reflection.mjs`**：
   - 删掉旧 `cognition/chat/{preferences,agreements,decisions}.md` 固定路径与旧 `## memory 候选` 文本格式要求；
   - 改为审计 SQLite 全域认知（`cognition_entries` + `cognition_projects` + `cognition_proposals`），并通过 `ria_reflect_report.cognitionActions` 输出结构化纠偏直通 Sage。
   - 同步更新 `lib/reflection.mjs` 的 `validateReflectionReport` / `ensureReflectionMemorySource` 校验逻辑与对应单测。

---

## 五、P2：清洗并重建本机 `ria.sqlite` 存量数据

### 现状问题（2026-11-24 实测）
- `cognition_entries` 共 107 行，**全部是 `cog_md_<hex>` 非数字 ID**，违反 `^cog_\d+$` 校验，Sage 无法更新。
- 65 行 `truncated = 1`；原本 17 条用户偏好被挤成 2 条并被截断，大量偏好丢失；仍残留 `Chatbot`/`Worker`/`worker-routing` 过期文本。
- `scope` 混乱：74 条挂在 `project:dsh-ria-lessons`（与 `project:dsh-ria` 分裂），且混杂了 4780 会话编辑器、SVG 矢量化等其他项目经验。
- `cognition_projects` 为 **0 行**。

### 清洗执行步骤
1. **先备份**：备份 `~/.dsh/state/ria/ria.sqlite`（含 `-wal`/`-shm`）为 `ria.sqlite.bak.<ISO>`，原 `cognition.bak-*` 保留不动。
2. **初始化 `cognition_projects`**：
   - `dsh-ria`：workspaces `["/home/gkl/Desktop/vibe_proj/dsh-ria"]`，填写精炼 `overview`（架构分层、存储分层、部署/重启与测试入口）。
   - `vggt-bottom-shop`：绑定实际底商仓库 workspace 路径与 `overview`。
   - 如有其他常驻项目（从 `tickets.project_cwd` 统计高频路径）一并注册。
3. **重洗 `cognition_entries`**：
   - 从最新备份 `cognition.bak-*/` 的原始 Markdown 重新蒸馏（不要从已被截断的 `cog_md_*` 二次加工）：
     - `chat/preferences.md` → 逐条拆分为独立条目入 `scope='user:preference'`（踢掉已失效的 `worker-routing` 与大段部署脚本；每条 `body <= 250` 字，不截断）。
     - `chat/agreements.md` & `chat/decisions.md` → 用户约定入 `scope='user:agreement'`；清理掉带 20 个空 JSON 的 8 条旧 lesson，蒸馏后入 `scope='project:dsh-ria'`。
     - `projects/dsh-ria-lessons.md` → 按工单实际归属分流，剔除 `lib/v2/` 等过期路径与同结论复读，蒸馏为 25~40 条高质量 `project:dsh-ria` 条目（附完整 `cause` 与细粒度 `sources`）。
     - `projects/vggt-bottom-shop.md` → 逐条入 `scope='project:vggt-bottom-shop'`。
   - **全部使用 SQLite 自增 `cog_<numeric>` ID**，清掉全部 `cog_md_*` 旧行。
4. **消化积压提案**：触发一次 Sage 处理 `cognition_proposals` 里剩余的 13 条 `pending` 提案，验证 `ria_sage_decide` 与 `cognition_receipts` 正常落库。

---

## 六、最终验收清单（全部打勾才算完成）

- [x] **提案全链路**：Chat / Advisor / Executor / Reflection 任一来源调用 `propose()` 后，记录直接进入 `ria.sqlite` 的 `cognition_proposals`（不再生成 `proposals/*.json`），且立即唤醒 Sage。
- [x] **Chat 注入**：`assembleSystemPrompt(chat)` 同时包含 `[说话风格]`、`[活跃项目概况]`（列出所有活跃项目及 workspaces）、`[长期记忆摘要]`（来自 SQLite `user:preference` + `user:agreement`，不含 `cause`/`sources`）。
- [x] **Advisor → Executor 链路**：新建 `dsh-ria` 测试工单，Advisor 收到由 `resolveProjectsForWorkspace` + 分词检索召回的候选经验，输出 `workOrder.experience`，Executor Brief（直管 & 协管）正确渲染 `[相关历史经验（必读）]`。
- [x] **Sage 核查闭环**：Sage 调用 `ria_sage_request(workspace, relatedEntryIds, relatedProposalId)` 派发核查工单，工单 `done`/`failed` 后 Sage 自动收到 `[Sage 核查回执]`。
- [x] **Sage 管理能力**：`ria_sage_read(view=...)`、`ria_sage_write(action=upsert_entry|set_status|upsert_project)`、`ria_sage_decide` 全通。
- [x] **Reflection 兜底**：反思报告附带 `cognitionActions` 完成 `done` 后，自动在 `cognition_proposals` 生成 `priority='high'` 提案并唤醒 Sage。
- [ ] **Prompt 干净**：`Chat` & `Sage` 共用 `RIA_SHARED_HEAD`，`Advisor`/`Executor`/`Reflection` 无全局头；静态测试确认无 `2. Answer`、`cognition/chat/`、`Chatbot`、`worker_report` 等残留。
- [ ] **本机数据干净**：`ria.sqlite` 中 `cognition_entries` 100% 为 `cog_<numeric>`、`truncated=0`、`cause` 非空、`cognition_projects` 已初始化；全量 `npm test` 通过。
## blocked-by-decision

| ID | 事项 | 原因 / 需要用户决定 |
|---|---|---|
| 4 | 五套 Prompt 完整重写 | 涉及产品文案、角色边界与行为措辞；本次仅完成 experience/SQLite 相关局部，不自行拍板整包替换。需要用户确认 RIA_SHARED_HEAD 文案、Chat/Sage/Advisor/Executor/Reflection 新提示词。 |
| 5 | 清洗本机 ria.sqlite 存量数据 | 需要删除/改写 107 条历史 entries、重建 projects、消费 pending proposals；属于不可逆数据操作，需用户明确授权与备份方案，本票不执行。 |
