# Cognition（认知与反思）核心设定

本文定义 `dsh-ria` 中长期认知库的数据模型、写入门禁、作用域边界，以及定期反思驱动的长周期新陈代谢机制。所有相关实现须以本文、根目录 [DESIGN.md](../../DESIGN.md) 及 [sage.md](sage.md) 为准。

## 1. 定位与权威存储

- **单一权威存储**：SQLite（`ria.sqlite`）中的 `cognition_entries`、`cognition_projects`、`cognition_proposals` 为认知数据的唯一权威源。
- **单一写者**：所有正式认知条目与项目档案仅由 Sage 写入；Chat、Advisor、Executor、Reflection 均通过提案（`cognition_proposals`）提交，不直接写认知库。
- **长期认知 vs 临时待办**：
  - 认知库只存**稳定、可跨工单复用的规律、偏好、协作约定与项目概况**。
  - **禁止**把“某 bug 待修”“暂不开单的需求”“临时排查进度/流水账”当作长期认知写入；此类事项应留在 Ticket、Topic 或当前会话。若确需记录临时规避措施，须写明触发条件，并在修复工单完成后及时退役。

## 2. 作用域（Scope）与消费面

| Scope | 归属内容 | 下游消费 |
|---|---|---|
| `principle` | 来自 `DESIGN.md` 的不可违背核心原则 | 注入 Sage / Chat 顶层约束 |
| `user:preference` | 用户个人沟通风格、汇报习惯、工作流偏好 | 直接注入 Chat 系统提示词（`chatDigest`） |
| `user:agreement` | 用户敲定的长期协作约定与红线 | 直接注入 Chat 系统提示词（`chatDigest`） |
| `project:<projectId>` | 归属特定项目的工程经验与踩坑机理 | 按项目/标签检索注入 Advisor / WorkOrder |
| `global` / `domain:<tag>` | 跨项目通用的工程与工具链经验 | 按标签检索注入 Advisor / WorkOrder |

- **`user:*` 纯度约束**：`user:preference` 与 `user:agreement` 每次对话都会占用 Chat 提示词预算，严禁混入具体代码路径、函数名或单项目实现细节（此类内容须归入 `project:<projectId>`）；对 `user:*` 活跃条目设软上限（建议 ≤ 20 条），超限时优先合并或退役旧条目。
- **项目档案（`cognition_projects`）**：每个活跃项目须维护真实的 `workspaces` 映射与 100~300 字的 `overview`（项目定位、核心模块与边界），禁止长期保留占位空话或与 `workspaces` 矛盾的描述。

## 3. 条目结构与写时门禁

每条 `cognition_entries`（ID：`cog_<numeric>`，三态：`active` / `disputed` / `retired`）须满足：

1. **三要素完备**：
   - `body`（≤ 250 字）：只写触发条件与明确做法/结论，不带旧 Markdown 列表前缀（如 `- **xxx**：`）。
   - `cause`（≤ 600 字）：写清沉淀经过、踩坑机理或验证方式，使下游无需回源即可理解。
   - `sources`（≥ 1 条可复查指针）：精确到 `file:path:L10-L30`、`commit:<sha>`、`ticket:<id>`、`session:<id>#eN`、`reflection:<date>` 或 `user:<date>`。
2. **写时防重门禁**：新建条目（无 `id`）时，在同 `scope` 现有 `active` 条目中做轻量相似度检查；命中高度相似条目时拒绝重复新建并返回 `duplicate_suspected` + `similarEntryId`，引导走更新/合并。
3. **状态变更门禁**：
   - 标为 `disputed` 时**必填 `disputeReason`**，禁止无理由悬空；
   - 标为 `retired` 且存在替代条目时须填 `supersededBy`。

## 4. 定期反思（长周期新陈代谢引擎）

定期反思是本项目中**唯一的看门狗**（见 [AGENTS.md](../../AGENTS.md)），同时承担认知库的长周期健康巡检，**不新增额外后台定时器**：

1. **窗口内增量审计（`since = run.windowStart`）**：
   - 覆盖窗口内工单、Router/Advisor 角色上下文（最新优先读取）、候选会话及 Sage 裁决活动；
   - 完成三大审计：**漏记审计**、**失效与失实审计**、**裁决与卫生审计**。
2. **存量轮检（启用 `verified_at`）**：
   - `ria_reflect_read_sage_context` 每次附带按 `COALESCE(verified_at, updated_at) ASC` 选出的最久未复核 **5 条 `active` 条目**；
   - 反思确认仍成立则仅刷新 `verified_at`；发现过时或重复则通过 `cognitionActions` 提交 `retire` / `update` 交 Sage 处理。
3. **代码变更定向失效检测**：
   - 若窗口内已完成工单修改了某源码文件，自动反查 `sources` 引用该文件的 `active` 认知条目，纳入当次反思优先核对，防止「代码已修但认知仍写旧事实/待修」。
4. **卫生告警（`hygieneAlerts`）与 `disputed` 升级**：
   - 自动标出含「待修 / 未修 / 先不开单 / TODO / 暂缓」字样的 `active` 条目、`overview` 过短或与 `workspaces` 矛盾的项目档案；
   - `disputed` 超过 48 小时的条目进入「待用户拍板」清单，推动尽快转为 `active` 或 `retired`，杜绝长期悬空。
5. **反思执行隔离**：每次反思新建独立的一次性只读 Reflection Executor，通过 `ria_reflect_report` 提交报告草稿与 `cognitionActions`（最多 5 条），由宿主写入规范路径报告并将 `cognitionActions` 转为 `priority=high` 提案唤醒 Sage，用完即归档。
