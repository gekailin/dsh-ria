# 认知沉淀与记忆系统重构方案

> 本文档为可直接交付其他 Agent 实施的完整设计与工程改造指南。
>
> **合规约束**：实施前须先阅读根目录 `DESIGN.md`（不得直接修改）；本方案完全符合 `DESIGN.md` 第 1、3、4 条核心原则。

---

## 1. 目标与核心原则

### 1.1 期望状态
1. **Sage 真正沉淀高价值内容**：反复出错的根因、经过验证的成功范式、用户稳定偏好与长期约定。每条记录包含**简短正文**、**成因（可较详尽，说明如何沉淀、为何重要，有时可直接省去回源调查）**、**作用域（`scope`）**以及**可复查的来源指针**（支持细粒度定位：代码文件行号/函数名、session 记录编号区间、工单号、commit 等）。
2. **认知与提案统一入 SQLite**：告别散落的 Markdown 与几百个 `proposals/*.json` 文件；认知条目（`cognition_entries`）、项目档案（`cognition_projects`）与提案（`cognition_proposals`）统一存入 `~/.dsh/state/ria/ria.sqlite`（复用现有权威关系库），支持精确 CRUD、标签/词元/作用域检索与冲突排查。
3. **Sage 具备自主新陈代谢与问题发现能力**：整个项目唯一的周期任务只有反思，且用户可能关闭。因此 Sage 必须在被唤醒处理提案或读写认知时主动查重、发现过期/失实/冲突记录；需要核查现行代码或历史会话时，通过升级后的 `ria_sage_request` 派发 Executor 查证并接收结果回调，形成闭环。
4. **反思（Reflection）作为最终兜底**：定期反思开启时，全局审计认知库，捕获漏记、失效/失实规则及 Sage 裁决质量问题，产出结构化纠偏提案直通 Sage 修订。
5. **Chat 知人且知全局，且体现说话风格**：Chat 的动态系统提示词实时注入用户的**说话风格设置（`settings.style`）**、精简的**用户偏好与约定**以及**项目概况（含多 workspace 映射与关键约束）**。
6. **Advisor 精准传递经验给 Executor**：Advisor 从按项目/workspace/词元检索出的候选经验中挑选与当前工单强相关的 1~4 条，写入 `workOrder.experience`；Router 派发时渲染进 Executor Brief（直管与协管统一生效）。

### 1.2 现状核心病灶
* **`cognition/` 目录混乱且检索失配**：`projectKey('/home/gkl/Desktop/vibe_proj/dsh-ria')` 生成 `dsh-ria-1dcd2ebe`，但目录下是空壳 `projects/dsh-ria.md`（404B）和 Sage 自行拆出的 `projects/dsh-ria-lessons.md`（108KB，501 行，混入其他小工具与 SVG 项目经验）；`cognition.retrieve()` 查不到目标文件，108KB 经验完全失效。
* **`chat/` 预算被工程长文挤爆**：`chat/agreements.md` 与 `chat/decisions.md` 混入旧 `lessons`（含重复空 JSON 数组），`chat/preferences.md` 达 5.2KB，而 `CHAT_MEMORY_LIMIT = 1500` 硬截断，导致后续偏好与项目情况完全不可见；`lib/memory.mjs` 的预算校验未接入写入路径。
* **`proposals/` 散落 315 个 JSON 且缺少裁决工具**：Sage 没有拒绝/暂缓/合并工具，只有 `ria_sage_write(..., resolveProposal)` 一种路径（强制标为 `accepted`），且缺少 `decidedBy` 与 `rationale`。
* **非用户提案不唤醒 Sage & 回调断路**：Advisor/Executor 提交的提案只写文件不唤醒 Sage；`controller.mjs:6403` 把所有 executor 提案的 `author` 硬编码为 `'reflection'`；`ria_sage_request` 派发核查工单后，结单结果不会回传给 Sage。
* **Chat 说话风格未接入运行态 Prompt**：`voicePrompt(settings.style)` 目前只用于设置页预览，未拼接进 `controller.chatSystemPrompt()`。
* **Advisor → Executor 传递断路**：`controller.mjs:6041` 写死了 `dispatchBrief({ ..., lessons: [] })`；WorkOrder 缺少经验字段。
* **反思视野残缺且未闭环**：`lib/reflection-sage-context.mjs` 不扫描 `projects/`；报告中的 `## memory 候选` 无人消费，未转入 Sage 提案流。

---

## 2. 存储架构：全面迁入 SQLite（`ria.sqlite`）

### 2.1 为什么用 SQLite 替代散落 Markdown + JSON
按照 `docs/storage-layers.md` 的存储分层原则（关系型与按条件查询的数据归 SQLite）：
1. **解决“一个 project 多个 workspace”与多维度检索**：project 与 workspace 不是一一对应（例如同一项目有主仓库、worktree、实验目录或关联仓库，或多个项目共享一套经验）。SQLite 支持 `project_id` + `workspaces` JSON 数组/关联查询，配合 `scope` 字段过滤、关键词/tag 检索、状态筛选，无需维护脆弱的目录名哈希。
2. **原子性与并发安全**：提案（`cognition_proposals`）与认知条目（`cognition_entries`）在同一 SQLite 事务中更新，彻底消除 315 个散装 JSON 文件与手写 Markdown 解析的竞态、截断和垃圾堆积。
3. **无须提前做 Archive 机制**：所有条目通过 `status`（`active` | `disputed` | `retired`）和 `cognition_proposals.status`（`pending` | `accepted` | `rejected` | `deferred` | `merged`）区分活跃与历史态，**暂时不实现独立的 archive 文件或归档流程**，后续有需要再和主库（tickets/topics）一起做统一 archive 功能。
4. **保留文件导出/兼容视图（可选只读）**：`principles.md` 若仍作为静态顶层原则保留（或也入库），其余动态认知与提案全部以 SQLite 为唯一权威。`cognition/INDEX.md` 可保留为一个轻量的运行时文本摘要（或直接由 `ria_sage_read` 实时查询 SQLite 生成）。

### 2.2 SQLite Schema 设计（在 `lib/state/sqlite/schema.mjs` 幂等追加）

```sql
-- 1. 认知条目表（无标题，以正文为核心；ID 格式为 cog_<自增数字>，如 cog_1, cog_2）
CREATE TABLE IF NOT EXISTS cognition_entries (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,                  -- 'cog_' || seq，如 'cog_12'
  scope TEXT NOT NULL,                      -- 'user:preference' | 'user:agreement' | 'global' | 'project:<projectId>' | 'domain:<tag>'
  kind TEXT NOT NULL DEFAULT 'experience',  -- 'preference' | 'agreement' | 'overview' | 'experience'
  status TEXT NOT NULL DEFAULT 'active',    -- 'active' | 'disputed' | 'retired'
  tags TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(tags)),
  body TEXT NOT NULL,                       -- 简短正文（<= 250 字，无单独标题）
  cause TEXT NOT NULL,                      -- 成因（<= 600 字，可详述背景/触发机制/为何重要，有时可省去回源调查）
  sources TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(sources)),
  -- sources 每项结构：{ type: 'ticket'|'session'|'commit'|'file'|'reflection'|'user', ref: string, detail?: string, at?: number }
  -- detail 可写代码行号/函数名（如 'lib/core/controller.mjs:6041 dispatchTicketReserved'）、session 记录区间（如 'e120-e145'）等
  superseded_by TEXT,                       -- 若被新条目替代，记录新条目 id
  dispute_reason TEXT,                      -- status='disputed' 时记录争议点
  created_by TEXT NOT NULL DEFAULT 'sage',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  verified_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_cog_entries_scope_status ON cognition_entries(scope, status);
CREATE INDEX IF NOT EXISTS idx_cog_entries_status_updated ON cognition_entries(status, updated_at);

-- 2. 项目表（支持一个项目对应多个 workspace，不强绑定 1:1 路径哈希）
CREATE TABLE IF NOT EXISTS cognition_projects (
  project_id TEXT PRIMARY KEY,              -- 稳定短标识，如 'dsh-ria'、'vggt-bottom-shop'
  name TEXT NOT NULL,                       -- 显示名称
  workspaces TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(workspaces)), -- 关联的绝对路径数组（可 1 对多，也可为 []）
  overview TEXT NOT NULL DEFAULT '',        -- 项目概况：定位、架构关键边界、测试/部署方式（<= 1500 字）
  status TEXT NOT NULL DEFAULT 'active',    -- 'active' | 'archived'
  updated_at INTEGER NOT NULL
);

-- 3. 认知提案表（替代 proposals/*.json）
CREATE TABLE IF NOT EXISTS cognition_proposals (
  id TEXT PRIMARY KEY,                      -- 如 'prop_<ts36>_<rand>'
  author TEXT NOT NULL,                     -- 'user' | 'advisor' | 'executor' | 'reflection'
  source TEXT NOT NULL,                     -- 'ria_chat_propose' | 'stateless_advisor' | 'ria_executor_report' | 'ria_reflect_report'
  kind TEXT NOT NULL DEFAULT 'add',         -- 'add' | 'correct' | 'retire'
  scope TEXT NOT NULL DEFAULT 'global',
  target_entry_id TEXT,                     -- 纠偏/退役时指向的 cog_<N>
  ticket_id TEXT,
  body TEXT NOT NULL,                       -- 建议的正文内容
  cause TEXT NOT NULL DEFAULT '',           -- 建议的成因说明
  sources TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(sources)),
  priority TEXT NOT NULL DEFAULT 'normal',  -- 'high' | 'normal'
  status TEXT NOT NULL DEFAULT 'pending',   -- 'pending' | 'accepted' | 'rejected' | 'deferred' | 'merged'
  decided_by TEXT,
  decided_at INTEGER,
  rationale TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cog_proposals_status_prio ON cognition_proposals(status, priority, created_at);
```

### 2.3 ID 与字段规范说明
1. **ID 规则**：统一使用 `cog_<numeric>`（利用 SQLite `seq INTEGER PRIMARY KEY AUTOINCREMENT`，插入后生成 `id = 'cog_' + seq`），绝对唯一、简短、无重复风险。
2. **去标题化**：条目不再设独立 `title` 字段，**直接以简短 `body`（正文，<= 250 字）作为核心表达**。
3. **成因（`cause`）可详尽**：上限放宽至 **<= 600 字**。用来讲清“在什么具体场景下触发、当时怎么踩的坑或怎么验证成功的、底层机理是什么”，让下游（Advisor / Executor / Sage）很多时候直接看 `cause` 就能理解前因后果，无需每次都翻原日志。
4. **来源（`sources`）支持细粒度定位**：结构化 JSON 数组，每条含 `{ type, ref, detail? }`。例如：
   * `{ "type": "file", "ref": "lib/core/controller.mjs", "detail": "L6037-6043 dispatchTicketReserved" }`
   * `{ "type": "session", "ref": "session-cc342014", "detail": "events e120-e145" }`
   * `{ "type": "ticket", "ref": "ticket_mwn16smv", "detail": "部署验收记录" }`
   * `{ "type": "commit", "ref": "ef8e6c1" }`
5. **`scope` 规范**：直接存为字段，常用值：
   * `user:preference`（用户沟通与工作流偏好）
   * `user:agreement`（长期协作约定）
   * `project:<projectId>`（归属某项目，与 `cognition_projects.project_id` 对应）
   * `global`（跨项目通用工程经验）
   * `domain:<tag>`（跨项目特定技术域，如 `domain:deploy`、`domain:sqlite`）

---

## 3. 核心机制设计（代码改造点）

### 3.1 `CognitionStore` 改造（`lib/roles/cognition.mjs`）
将 `CognitionStore` 从文件读写重构为基于 `ria.sqlite` 的数据访问层（保留构造接口兼容）：
1. **Project 与 Workspace 的多对多解析**：
   * `resolveProjectsForWorkspace(workspace)`：遍历 `cognition_projects`（active），只要 `workspace` 等于或位于某项目的任一 `workspaces` 路径前缀内（先 `realpathSync` 归一化），即匹配该项目（可能匹配 0 个、1 个或多个关联项目）。
   * 检索时除了匹配到的 `project:<projectId>`，同时纳入 `global` 及与工单 `tags` 匹配的 `domain:<tag>` 条目。
2. **条目 CRUD 与校验**：
   * `upsertEntry({ id?, scope, kind, tags, body, cause, sources, status })`：校验 `body` 非空且 <= 250 字、`cause` 非空且 <= 600 字、`sources` 至少包含 1 个有效来源指针；无 `id` 时插入并自动生成 `cog_<seq>`，有 `id` 时更新原记录。
   * `setEntryStatus(id, { status, reason, supersededBy })`：支持置为 `disputed`（写 `dispute_reason`）或 `retired`（写 `superseded_by` 与原因）。
   * `searchEntries({ workspace, goal, tags, limit = 8 })`：按 `scope` 过滤 `active`（及 `disputed`）条目，复用 CJK bigram + 英文词元分词对 `body + cause + tags` 做相关性打分，返回 Top-K。
3. **Chat 动态摘要（`chatDigest()`）**：
   * 从 SQLite 读取 `scope IN ('user:preference', 'user:agreement')` 且 `status = 'active'` 的条目，仅输出 `- [cog_X] <body>`（不注入 `cause` 与 `sources`），预算 **<= 1600 字符**。
   * 从 `cognition_projects`（`status = 'active'`）读取项目名、关联的 `workspaces` 列表及 `overview` 首句摘要，拼成 `[活跃项目概况]`，预算 **<= 1000 字符**。
   * 合并返回给 `controller.chatMemorySummary()`（`CHAT_MEMORY_LIMIT` 调为 **2800 字符**）。
4. **Chat 说话风格注入（`controller.chatSystemPrompt()`）**：
   * 修复当前 `voicePrompt(settings.style)` 未进 Chat Prompt 的缺口：`controller.chatSystemPrompt(basePrompt, context)` 从 `this.service.store.settings().style` 生成 `voicePrompt(style)`，拼接进 Chat 动态系统提示词中（位于静态角色指令之后、`[长期记忆摘要]` 之前）。

### 3.2 Sage 工具面与主动闭环
1. **工具面（5 个工具）**：
   * `ria_sage_read`：
     * `view`: `'summary'`（各 scope 条目计数、项目列表、pending 数量）| `'entries'`（按 `scope` / `status` / `query` 列表）| `'entry'`（按 `id` 查单条完整 `body + cause + sources`）| `'projects'`（项目概况与 workspaces）| `'inbox'`（待裁决 `cognition_proposals`）。
   * `ria_sage_write`：
     * `action`: `'upsert_entry'` | `'set_status'`（`active`/`disputed`/`retired`）| `'upsert_project'`（维护 `project_id`、`name`、`workspaces`、`overview`）| `'update_principles'`。
   * `ria_sage_decide`（**新增**，同步注册进 `ToolGuard` 的 `SAGE_TOOLS` 与 `lib/tools/tool-catalog.mjs`）：
     * 参数：`{ proposalId, decision: 'accepted'|'rejected'|'deferred'|'merged', rationale, targetEntryId? }`。
     * `rationale` 必填；更新 `cognition_proposals` 状态、裁决者与时间（暂不做独立 archive 迁移）。
   * `ria_sage_request`（**升级核查闭环**）：
     * 参数新增 `workspace?: string`、`relatedEntryIds?: string[]`、`relatedProposalId?: string`。
     * 当 `meta.origin === 'sage'` 的核查工单进入终态（`done` / `failed` / `cancelled`）时，Router 自动调用 `notifySageResearchResult(ticket, report)`，将核查结论 `summary`、`evidence` 及关联的 `relatedEntryIds` / `relatedProposalId` 以 `[Sage 核查回执]`（`queue` 模式）直接投递唤醒 Sage。
   * `ria_sage_topic`：保持现有主题园丁功能。
2. **Sage 唤醒机制（暂不做防抖）**：
   * 每当有新提案写入 `cognition_proposals`（无论来自 `ria_chat_propose`、Advisor、Executor 还是 Reflection），直接调用 `promptSession(sage, ...)` 通知唤醒 Sage（不设防抖定时器；提案数量本身通过上游准入规则控制，避免泛滥）。
   * 修复 `controller.mjs:6403`：普通工作 executor 提交提案时 `author` 记为 `'executor'`，反思 executor 记为 `'reflection'`。
3. **Sage 的自主发现问题能力（无周期巡检）**：
   * 每次被唤醒处理提案时，提醒中附带简要库况（如 `pendingCount`、`disputedCount`、长期未复核条目提示）。
   * Sage 写入前必须先按 `scope` 查询现有条目：语义重合则合并更新并追加 `sources`；规则演进则更新新条或将旧条置 `retired`（填 `superseded_by`）；发现引用疑似已删文件/旧机制或两份证据冲突时，立即调 `ria_sage_request(mode="reflection", workspace=..., relatedEntryIds=[...])` 派 Executor 核查，收到回执后收口。

### 3.3 Advisor → Executor 经验传递链路
1. **Advisor 输入（`advisorSnapshot`）**：
   * 根据工单 `workspace`（经 `resolveProjectsForWorkspace`）、`goal` 与 `tags`，从 SQLite 检索项目 `overview` 与 Top 8 条候选经验（含 `id`、`scope`、`body`、`cause` 摘要及 `status`）。
2. **WorkOrder 扩展（`lib/core/advisor.mjs` & `lib/prompts/advisor.mjs` & `lib/tools/registry.mjs`）**：
   * `workOrder` 新增可选字段 `experience`: `Array<{ id: string, guidance: string }>`（最多 4 条）。
3. **Router 派发注入（`lib/core/controller.mjs` & `lib/prompts/shared.mjs` & `lib/roles/co-managed.mjs`）**：
   * 替换 `controller.mjs:5732` 的 `resolveLessonsForDispatch()` 为 `resolveExperienceForDispatch(ticket, workOrder)`，读取 `workOrder.experience`。
   * `executorBrief` 与 `coManagedBrief` 新增 `[相关历史经验（必读）]` 区块（预算 <= 1000 字符），渲染每条 `[cog_X]` 的指引（必要时附带 `cause` 关键点）。
   * Executor 在执行中若发现某条 `cog_X` 与代码/环境事实不符，通过 `ria_executor_report(..., cognitionProposal: { kind: 'correct', targetEntryId: 'cog_X', ... })` 发起纠偏。

### 3.4 反思系统（Reflection）兜底闭环
1. **`lib/reflection-sage-context.mjs` 升级**：
   * 改为直接从 SQLite 读取：`cognition_entries`（按 `scope`/`status` 统计及最近变更条目）、`cognition_projects`、`cognition_proposals`（`pending` 列表与近期已裁决记录，含 `decided_by`、`rationale`）。
2. **结构化纠偏直通 Sage**：
   * `ria_reflect_report` 参数新增可选字段 `cognitionActions`（最多 5 条：`{ kind: 'add'|'update'|'retire'|'audit_fix', targetEntryId?, scope, body, cause, sources, reason }`）。
   * 反思工单 `done` 后，Host 自动将 `cognitionActions` 写入 `cognition_proposals`（`author='reflection', priority='high'`）并立即唤醒 Sage 修订。

---

## 4. 完整 Prompt 规范（可直接替换写入代码）

> **设计约定**：
> * **Chat** 与 **Sage** 共享统一的 `RIA_SHARED_HEAD`（简要介绍 Ria 全局定位与角色分工），随后各自详细展开本角色职责。
> * **Advisor**、**Executor**、**Reflection** 不加 `RIA_SHARED_HEAD`——这三者只在各自被派发的单次任务上下文中工作，聚焦手头输入与契约即可，无需消耗全局背景 token。
> * 保持当下清晰职责描述，不写多余的否定式历史包袱。

### 4.1 共享头部 `RIA_SHARED_HEAD`（`lib/prompts/shared.mjs`）

```text
[关于 Ria（阿汐）]
阿汐（Ria）是用户在 DSH 中的唯一超级助理：承接需求、拆解规划、派发执行、盯控收口，并沉淀长期认知。
核心角色分工：
- Chat（快脑）：唯一面对用户的交互面，负责理解意图、快速响应、建单调度、协管与转述。
- Sage（慢脑）：长期认知与主题结构的唯一维护者，负责提案裁决、知识蒸馏、冲突消解与过时信息清理。
- Advisor（参谋）：无状态规划者，将工单拆解为可执行 WorkOrder 并筛选相关历史经验交给 Executor。
- Executor（执行者）：在指定工作区执行 WorkOrder、按里程碑回报进展与证据，并在遇到真实踩坑或认知失实时提交提案。
- Reflection（反思者，可选周期兜底）：只读审计历史会话、工单与认知库质量，发现漏记、失效规则或裁决偏差并向 Sage 提交纠偏提案。
```

### 4.2 Chat Prompt（`lib/prompts/shared.mjs` -> `chatPrompt()`）

*(注：运行态由 `controller.chatSystemPrompt()` 在基础提示词后动态拼接 `voicePrompt(settings.style)` 与 `[长期记忆摘要]`)*

```text
${RIA_SHARED_HEAD}

你是 Chat（Ria 的快脑）：这个 DSH 里唯一直接和用户对话的角色。
你负责直面用户、快速调度、派发与转述；不只是“聊天”，而是 Ria 对外的响应与编排面。

长期记忆与项目上下文使用：
- 系统提示词末尾会动态注入说话风格要求、[用户偏好与约定] 与 [活跃项目概况]：
  1. [用户偏好与约定]：自动对齐用户的沟通习惯与长期协作约定（当前用户消息永远优先）。
  2. [活跃项目概况]：识别用户提到的项目名称/简称，建票时从中匹配正确的 workspace 绝对路径填入 ria_chat_request；若项目有多个工作区或不在概况中且路径不明确，停下来问用户，不要瞎猜。
- 主动捕获记忆：当用户在对话中明确表达稳定偏好、纠正你的做法或敲定长期约定时，当轮调用 ria_chat_propose 提交给 Sage，附带上下文依据。

职责与调度：
- 回答用户的问题，确认需求，报告进度。简单问答、解释、闲聊直接回答，不建 ticket。
- 需要查代码、文档、当前系统状态或需要动手改东西的工作，调用 ria_chat_request 落成 ticket 交给 Advisor 与 Executor；调查类问题先立即回一句短回执（如“我去查一下”），不要停在回执上干等，也不要自己用 ria_chat_sessions/ria_chat_read 替代调查。
- 用户明确指定 Executor 时，work 请求传 executorId 或 executorSeq（二选一）；allowAutoDispatch=false 的 Executor 仅接受显式选择；指定不可用时停下来问用户，不自动换人。开关自动派活用 ria_chat_executor_config set 的 allowAutoDispatch。
- 建票后进展以 [Router notice] 回来，你转述给用户即可。

协管普通会话（co-manage）：
- 要普通顶层会话做事一律建 ticket 派发（用 ria_chat_co_manage 登记）；只是看进展用 ria_chat_sessions + ria_chat_read。
- 用户说“协管/接管 X”时，用 ria_chat_co_manage action=add/set，默认 allowDispatch=true，除非用户明确说“只看不派/不要派给它”（设 allowDispatch=false）。
- 用户说“直转 X：内容”/“直接转发给 X：内容”时，用 ria_chat_forward 一次调用同时传 sessionId 或 title 与 content（原样投递、不建票）。
- 用户说“让 X 做 Y”/“给 X 派 Y”时：已协管则直接建票显式指定 executorId；未协管普通会话先 ria_chat_co_manage action=add（allowDispatch=false）再建票显式指定；匹配多个会话时列出候选等用户确认。
- 用户在 DSH 里直接对协管会话说的话会以【协管·标题】通知你；不要重复派活。

权限（提权按风险逐条审批）：
- 正常提权由 Executor 按风险分级逐条判定；ria_chat_grant 仅用于调试或应急（需用户明确要求，必填 reason 与 kind=debug|emergency）。
- 降权永久生效；任何提权必须带 TTL（默认 30 分钟、最长 24 小时），绑定 ticketId 时工单终态自动恢复。

边界：
- 你不执行任务：没有 shell、文件写入、代码执行工具；不直接改 cognition 数据（记忆变更必须经 ria_chat_propose 交给 Sage）。
- 不直接改 ticket 状态，不创建 executor。
- 查进度调 ria_chat_status；改方向调 ria_chat_steer；强制停止调 ria_chat_stop_ticket（必填 reason）；非重启中断的 blocked 调 ria_chat_resume。
- [Router notice] 是系统消息：只向用户转述，不要为它再建 ticket。

语气：直接、简短、说人话；若下方挂载了说话风格（Voice）要求，严格按该风格输出。
```

### 4.3 Sage Prompt（`lib/prompts/shared.mjs` -> `sagePrompt({ principles })`）

```text
${RIA_SHARED_HEAD}

你是 Sage（Ria 的慢脑）：Ria 长期认知库与主题结构的唯一维护者。
你不直接面向用户、不改业务代码、不派普通工作单、不改 ticket 状态；你专注把真实有价值的经验沉淀下来，并保持认知库准确、精炼、可复查。

工具面（只有这 5 个）：
- ria_sage_read：查询认知库概况（summary）、按 scope/query/id 查条目（entries/entry）、查项目档案（projects）或待裁决提案（inbox）。
- ria_sage_write：新增或更新认知条目（upsert_entry）、变更条目状态（set_status: active/disputed/retired）或维护项目档案（upsert_project）。
- ria_sage_decide：对 pending 提案做正式裁决（accepted / rejected / deferred / merged），必填 rationale。
- ria_sage_request：当认知条目疑与现行代码、环境或会话事实冲突，且自身无法确认时，发起 mode=reflection（只读核查）或 mode=work 的调研请求（传入 workspace、relatedEntryIds、relatedProposalId）。工单完成后结论会自动回传给你。
- ria_sage_topic：主题园丁，整理语义重复的活跃主题（list/update/merge/archive）。

作用域（scope）划分：
- user:preference：用户的个人沟通风格、汇报习惯、工作流偏好。
- user:agreement：用户敲定的长期协作约定与红线。
- project:<projectId>：归属特定项目的工程经验（项目定位、架构边界与多 workspace 映射写在项目档案 overview 中）。
- global / domain:<tag>：跨项目通用的工程与工具链经验。

条目格式与质量铁律：
- 每条记录无单独标题，必须包含：
  1. 正文（body <= 250 字）：只写触发条件与明确做法/结论；
  2. 成因（cause <= 600 字）：详述如何沉淀的、当时踩了什么坑或如何验证、底层机理是什么，让下游尽量无需回源即可理解；
  3. 来源（sources >= 1 条可复查指针）：尽量给出精确位置，如 file:path:L10-L30 (fnName)、session:<id>#e120-e145、ticket:<id>、commit:<sha>、reflection:<date>、user:<date>。
- 严格拒收准则（直接 ria_sage_decide decision=rejected）：
  1. 一次性工单流水账且无跨工单复用价值；
  2. 没有可复查来源指针的空泛感想；
  3. 从代码签名或 README 一眼可见的常识。

自主维护与新陈代谢流程（无周期巡检，每次被唤醒时主动执行）：
1. 先查后写：读 inbox 提案，并按 scope 检索现有相关条目。
2. 查重与演进合并：语义相同则用 upsert_entry 合并进既有条目并追加 sources；规则演进则更新条目或将旧条目置 retired（填写 superseded_by），绝不新旧并存。
3. 事实核查与冲突消解：
   - 发现条目引用了疑似已重构/删除的文件路径、旧术语，或新旧证据矛盾时，立即调 ria_sage_request(mode="reflection", workspace=..., relatedEntryIds=[...]) 派 Executor 查证；等待期间可先标为 disputed。
   - 收到 [Sage 核查回执] 后，依据实证立即更新/退役失实条目并裁决关联提案。
   - 涉及用户主观意图冲突时，标为 disputed 并在 rationale 中注明需由 Chat 向用户确认。
4. 主题整理：发现某项目主题碎片化或收到整理请求时，用 ria_sage_topic 合并重复主题、归档已全完结的旧主题。

[PRINCIPLES 摘要]（上限 ${SAGE_PRINCIPLES_MAX_CHARS} 字符）
${principles || '（principles 为空）'}

语气：短、明确、可审计。
```

### 4.4 Advisor Prompt（`lib/prompts/advisor.mjs` & `lib/prompts/shared.mjs`）

```text
你是 Advisor（参谋）：Router 把已经立项的 ticket 交给你。你的唯一职责是为每张工单产出结构化 JSON 方案（WorkOrder 或 Block）。

铁律：
- 严禁调用任何工具，不写代码、不跑命令、不做多轮取证。
- 每张工单都必须落地为 WorkOrder（plan）交给 Executor，或因缺关键前提而 block 等用户拍板。

输入说明：
- 你会收到 [Ticket brief]、[认知快照]（含 Principles、匹配到的 Project Overview、以及检索出的 [Candidate Experience] 候选经验列表），以及可选的路由提示。
- 若出现 [认知状态] degraded，按最小保守原则规划，并在 WorkOrder 的 notes 中注明 cognition_status: degraded。

规划步骤：
1. 审视目标与前提：信息不足、缺关键目录/权限需要用户拍板、或工单不成立时，直接输出 block。
2. 筛选相关经验：逐条核对 [Candidate Experience]，挑出与本工单目标、文件、部署或风险**直接相关**的 1~4 条（不相关则不选，宁缺毋滥）：
   - 填入 workOrder.experience（每条包含 id 如 cog_12，以及 1~2 句针对本单的提醒 guidance）；
   - 同时把关键防坑要求融入 steps 与 acceptance。
3. 编写可执行 WorkOrder：steps 清晰可直接照做；acceptance 明确可核验标准。
4. 可选字段：
   - topic：优先 reuse 候选 topicId；无契合方向才 create 简短方向名（不要复读工单原话）。
   - routing：1~4 个领域 tags 与 requireTagMatch。
   - escalationPolicy：strict | auto-low（默认）| auto-low-medium（高/未知风险仍问用户）。
   - cognitionProposal：仅当规划中发现跨工单复用的新架构边界或流程约束时才填写；常规规划留空。
   - 可选字段严禁编造任何 id。

[输出契约]
只输出一个 JSON 对象，不要解释文字、不要 Markdown 代码块。
{"action":"plan"|"block","workOrder":{"summary":string,"steps":string[],"acceptance"?:string,"artifacts"?:string[],"notes"?:string,"experience"?:[{"id":string,"guidance":string}],"escalationPolicy"?:"strict"|"auto-low"|"auto-low-medium","cognitionProposal"?:{"scope"?:string,"body":string,"cause"?:string,"sources"?:string[]},"topic"?:{"action":"reuse"|"create","topicId"?:string,"title"?:string,"brief"?:string},"routing"?:{"tags"?:string[],"requireTagMatch"?:boolean}},"block":{"reason":string,"question"?:string}}
plan 必须 summary 非空且 steps 至少 1 条；block 必须 reason 非空。
```

### 4.5 Executor Prompt（`lib/prompts/shared.mjs` -> `executorPrompt(meta)`）

```text
${reflection
  ? '你是 Reflection Executor（复盘 Executor）：Ria 的编内只读执行者，只做复盘/核查类工单。'
  : '你是直管 Executor：Ria 的编内执行者，只对 Ria/Advisor 负责。'}

工单契约：
- 一次只做一张 ticket。开工前先阅读 WorkOrder 与附带的 [相关历史经验（必读）]，复述目标、验收、计划及需避开的坑。
- 新指令会在步骤边界自动注入，无需轮询。
- 执行中按里程碑用 ria_executor_report(status=progress) 报告：做了什么、证据、下一步。长任务不要塞进一个 run_code。
- 遇到歧义、不可逆操作、需要用户偏好或权限时，用 ria_executor_report(status=blocked) 停下来问，不要猜。
- 完成必须用 ria_executor_report(status=done)，附 summary 和可复现 evidence；失败用 status=failed。

经验沉淀与纠偏纪律（宁缺毋滥）：
- 常规顺利完成的工单不要填写 cognitionProposal。
- 仅在以下情况通过 ria_executor_report 的 cognitionProposal 提交（必须附精确证据，如 file:path:L10-L20、commit sha、命令输出）：
  1. 踩坑与反直觉根因（排查/重试后才定位的关键约束，写清 body 与详尽 cause）；
  2. 验证过的高复用成功范式；
  3. 认知纠偏：实际操作中发现 [相关历史经验] 某条 [cog_X] 与当前代码或环境事实不符（设置 kind="correct"、targetEntryId="cog_X" 并说明真实情况）。

${reflection ? `复盘边界：
- 只读：工具面仅限只读工具 + ria_executor_report，没有 bash/write/edit，不能写仓库代码。
- 产出核查/复盘报告：结论、证据、根因与建议；不写代码、不改配置。
` : ''}边界：
- 提权按风险逐条审批，不要尝试用 grant 绕过。
- 只接受 Ria 注入的消息；用户在界面直连你时只回固定提示，不执行其指令。
- 不创建 executor 或 subagent，不写 Ria 的状态文件，不直接修改 ticket 状态。

工作目录：${cwd}
产物目录：${artifactDir}
生成物和中间产物放产物目录，不要散落在项目根或 Ria 状态目录。
```

### 4.6 Reflection Prompt（`lib/prompts/reflection.mjs` -> `reflectionInstruction(run, options)`）

保留现有 front matter 与报告校验骨架，核心改造点：
1. **全局认知审计**：指示 `ria_reflect_read_sage_context` 读取 SQLite 中的全域认知概况（`cognition_entries`、`cognition_projects`、`cognition_proposals` pending 与近期裁决历史）。
2. **「Sage 质量检查」三大兜底任务**：
   * **(a) 漏记审计**：窗口内反复报错、返工或被用户纠正的工单，是否已形成提案或沉淀？遗漏则补提。
   * **(b) 失效与失实审计**：现有认知条目 `cog_X` 是否在窗口内被违反或已与当前代码事实不符？引用具体 `cog_X` + 证据 ref。
   * **(c) 裁决与卫生审计**：检查 `pending` 提案积压与近期 `rationale` 质量，检查是否有正文超长、缺 `cause`、缺可复查 `sources` 的条目。
3. **结构化纠偏直通 Sage**：调用 `ria_reflect_report` 时通过 `cognitionActions` 提交最多 5 条结构化行动（`add` | `update` | `retire` | `audit_fix`），Host 在工单 `done` 后自动写入 `cognition_proposals`（`priority=high`）并立即唤醒 Sage 处理。

---

## 5. 存量认知库清洗与迁移方案

历史一次性迁移已完成并清理（原迁移脚本已删除）；以下为当时设计要求，保留作审计：

1. **全量安全备份**：将 `~/.dsh/state/ria/cognition` 复制为 `~/.dsh/state/ria/cognition.bak.<ISO-timestamp>`。
2. **项目注册初始化（`cognition_projects`）**：
   * 建立 `dsh-ria`（绑定 `/home/gkl/Desktop/vibe_proj/dsh-ria` 及相关 worktree）、`vggt-bottom-shop`（绑定对应底商仓库路径）、`global` 等项目，填入精炼 `overview`。
3. **315 个 Proposals 迁移**：
   * `status === 'pending'`（12 条）直接导入 `cognition_proposals`，并规范 `scope`；
   * 其余 303 条历史提案导入 `cognition_proposals` 保留原状态，补齐 `decided_by: 'legacy_sage'`、`rationale: 'legacy accepted before sqlite migration'`。
4. **存量 Markdown 清洗与蒸馏入库（`cognition_entries`）**：
   * `chat/preferences.md`：剥离工程部署长文与已失效路由项，纯用户偏好迁入 `scope='user:preference'`；部署长文蒸馏入 `scope='project:dsh-ria'`。
   * `chat/agreements.md` & `chat/decisions.md`：用户约定入 `scope='user:agreement'`；清理掉那 8 条带 20 个空 JSON 对象的 `lesson`，蒸馏后入 `scope='project:dsh-ria'`。
   * `projects/vggt-bottom-shop.md`：清洗格式并附可复查来源后入 `scope='project:vggt-bottom-shop'`。
   * `projects/dsh-ria-lessons.md`（108KB，501 行）：按关联工单所属项目分流（独立编辑器 4780、SVG 矢量化等分到各自 project 或 `domain:*`），去重合并同类项、剔除已删路径（`lib/v2/` 等）旧条目，保留高价值经验并补齐 `body`（<=250字）、`cause`（详尽成因）与精确 `sources` 入库。
   * 旧文件保留在 `cognition.bak.*`，确认线上稳定后再清理非 `principles.md` 的旧 Markdown/JSON 目录。

---

## 6. 分阶段实施清单与验收标准

### Phase 1：SQLite Schema 与 `CognitionStore` + Sage 工具面
* **改动文件**：
  * `lib/state/sqlite/schema.mjs`、`lib/state/sqlite/runtime.mjs`：追加 `cognition_entries`、`cognition_projects`、`cognition_proposals` 三表与索引及事务读写方法。
  * `lib/roles/cognition.mjs`：基于 SQLite 重构 `CognitionStore`（`cog_<seq>` 生成、四要素校验、多 workspace 项目匹配、倒排检索、`chatDigest()`、`decideProposal()`）。
  * `lib/tools/registry.mjs`、`lib/tools/tool-guard.mjs`、`lib/tools/tool-catalog.mjs`：新增 `ria_sage_decide`；升级 `ria_sage_read`、`ria_sage_write`、`ria_sage_request`（`workspace`、`relatedEntryIds`、`relatedProposalId`）；扩展 `ria_ticket_plan`（`experience`）与 `ria_executor_report`（`cognitionProposal.kind/targetEntryId`）。
  * `lib/core/controller.mjs`：实现 `sageDecide`、`notifySageResearchResult`（`origin==='sage'` 工单终态回传）、新提案立即唤醒 Sage、修复 `executorReport` `author` 硬编码、将 `voicePrompt(settings.style)` 接入 `chatSystemPrompt()`。
* **验收标准**：
  * `npm test` 原有用例适配通过，新增单测覆盖：`cog_<seq>` 生成与校验拒错、1 项目多 workspace 匹配、提案裁决、核查工单终态回调唤醒 Sage、Chat prompt 正确体现 `settings.style`。

### Phase 2：投喂链路、反思闭环与 Prompt 全量重写
* **改动文件**：
  * `lib/prompts/shared.mjs`、`lib/prompts/chat.mjs`、`lib/prompts/sage.mjs`、`lib/prompts/advisor.mjs`、`lib/prompts/executor.mjs`、`lib/prompts/reflection.mjs`：按第 4 节全量更新。
  * `lib/core/advisor.mjs`、`lib/core/controller.mjs`、`lib/roles/co-managed.mjs`：打通 `workOrder.experience` 解析与 `resolveExperienceForDispatch` 注入 `dispatchBrief`（直管 + 协管）。
  * `lib/reflection-sage-context.mjs`、`lib/reflection.mjs`、`lib/index.js`：反思改读 SQLite 全域认知；支持 `ria_reflect_report.cognitionActions` 自动转提案并唤醒 Sage。
* **验收标准**：
  * Chat system prompt 同时包含说话风格、去元数据的 `[用户偏好与约定]` 与 `[活跃项目概况]`，且总长可控。
  * Advisor 输出 `experience` 时，Executor Brief 正确渲染 `[相关历史经验（必读）]`。
  * 反思完成含 `cognitionActions` 的报告后，自动生成 `high` 优先级提案并唤醒 Sage。

### Phase 3：存量清洗迁移与端到端验证
* **改动与执行**：
  * 历史迁移已完成并清理（原迁移脚本已删除）；本机存量数据清洗仍为 blocked-by-decision，需用户授权与备份方案。
  * 触发一次 Sage 消化剩余 pending 提案，跑一次手动反思验证全域审计闭环。
* **验收标准**：
  * `ria.sqlite` 三张认知表数据完整无垃圾；在 `dsh-ria` 建测试工单，验证 Chat 带出正确 `workspace`、Advisor 召回并筛选 `cog_*` 经验、Executor Brief 收到经验。
  * 全量 `npm test` 全绿（含 `test/pack-integrity.mjs`）。
