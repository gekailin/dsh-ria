# Sage（大脑）+ 无状态 Advisor 设计（草案）

> 只出设计，不写实现。目标设计，不替代根 [DESIGN.md](../DESIGN.md)；与 [design-v2.md](design-v2.md) 配套阅读。项目级 Advisor 方案（[project-advisor-design.md](project-advisor-design.md)）已被本文取代，保留作历史方案。

## 背景与问题

现在是单个长期存活的 Global Advisor：所有项目的票都进入同一个会话，Advisor 既要想方案，又被动累积对话与项目细节。规模一上来会出现三类问题：

- **上下文膨胀**：长会话不断堆积历史 WorkOrder、项目细节和失败尝试；越到后期越贵、越慢，也越容易被旧内容带偏。
- **跨项目污染**：A 项目的构建/部署经验被写进长期上下文，处理 B 项目时仍会被当成通用规律；项目级 Advisor 方案试图按项目分会话，但会把会话数、路由和写入竞争一起放大。
- **单点瓶颈**：所有 mode=work 的票等同一个 Advisor；一次长方案期间其他项目只能排队。Advisor 卡住时，整个决策阶段都停。

本方案把「长期认知」和「单票决策」拆开：

- **Sage（大脑）**：长期存活，只维护共享认知；不写代码、不执行任务、不派工单，阻塞也不影响正常派单。
- **Advisor（无状态参谋）**：每次只拿「本票 brief + 检索到的认知快照」，产出一份 WorkOrder；不保留跨票记忆。
- **Router 不变**：仍是第一阶段快速分类与唯一派发入口；只有 mode=work 才进入 Advisor。

项目级 Advisor 被本文取代：不再按项目分会话，项目差异放进共享认知库的 project 片段，由检索按需装载。

## 目标 / 非目标

**目标**

- 把「长期认知」从 Advisor 会话里剥离，Sage 只接收提炼过的信息。
- Advisor 无状态化：同一输入（brief + 快照）得到稳定方案；不因历史会话漂移。
- 认知可检索、可审计、可回滚、可过期；坏结论不会静默污染所有票。
- 不改 Router 职责、不改 ticket 状态机、不改 Worker 执行链路、不引入新进程/端口。
- 全链路事件驱动；Sage 阻塞或认知检索失败时有明确降级，不拖垮主流程。

**非目标**

- 不做 per-project Advisor、不做 Advisor 互通、不做 Advisor 之间的协商。
- 不让 Sage 执行、写代码、派 Worker、改 ticket 状态。
- 不把认知写成一组新的长期会话记忆；认知必须是显式文件与提案。
- 不在本设计里实现 SQLite（只在写入一致性处引用既有迁移设计）。

## 1. Sage（大脑）

### 1.1 定位与边界

Sage 是**全局唯一**的认知维护者，独立于 Chatbot / Router / Advisor / Worker：

| 角色 | 形态 | 只做什么 | 明确不做 |
|---|---|---|---|
| Sage | 独立顶层会话（标题 `Ria Sage`），长期存活 | 读认知、审提案、采纳/拒绝、维护 Cognitive 与 Chatbot 长期记忆、发起调研需求 | 不执行任务、不写代码、不派 Worker、不改 ticket、不对用户做最终答复 |
| Advisor | 无状态调用 | 读 brief + 认知快照，产出 WorkOrder / Answer / 认知提案 | 不长期记忆、不分类、不派发、不写认知档 |
| Router | 控制面 | 分类、状态机、派发、审批、审计、单写者提交 | 不读对话、不写认知内容 |
| Worker | 执行容器 | 按 WorkOrder 执行 | 不管理、不写认知（只提交提案素材） |

Sage 的输入必须是**提炼过的**：提案、复盘结论、决策候选，而不是原始对话、完整工具日志或整份 transcript。它不解析项目代码，也不持有执行上下文。

Sage 是**可选的决策者，不是主链路阻塞点**：Advisor 检索不到 Sage 的最新结论时按降级快照继续；Sage 自己卡住只影响「新认知何时生效」，不影响已有 WorkOrder 和 Worker。

### 1.2 工具面（无 bash / write / edit）

Sage 只暴露三个 scoped 工具，使用 standard preset（非 PTC）：

| 工具 | 类型 | 作用 | 约束 |
|---|---|---|---|
| `sage_read` | 只读 | 读 principles / projects / lessons / decisions / proposals；按 scope、key、query 检索 | 有界返回；不返回原始 ticket/transcript；每次返回带版本与命中原因 |
| `sage_propose` | 写「意图」 | 创建认知提案；对已有提案给出 adopt / reject 意见 | **不直接改认知档**；写入 `proposals/` 与审计；采纳由 Router 单写者提交 |
| `sage_request` | 发起请求 | 发起一次调研：mode=reflection 或 mode=work 的 Request，交 Router 分类/审批/派发 | 只创建 Request，不创建 ticket、不选 Worker、不绕过 risk approval |

**没有** `bash`、`write`、`edit`、`run_code`、subagent、worker 管理、ticket 状态工具。Sage 不能读任意文件系统；读认知只经 `sage_read`。

选 **standard** 而不是 PTC 的理由：Sage 的工作是读结构化认知、写提案、发请求，不需要执行工具；standard 的工具面更容易收窄，也不给 PTC 预留的 run_code 留口子。它仍受 Ria 的权限与审计约束。

### 1.3 生命周期、恢复与 DSH 自动 compact

**常驻**：启动时 `ensureSage`（与 `ensureChatbot` 同级），sessionId 持久化在 v2 状态；已有 session 直接复用，不重建。会话标题固定 **`Ria Sage`**；cwd 固定 **`stateDir` 根**（旧 `stateDir/sage` 只在迁移判定中保留；启动时归档一次并重建，已是 stateDir 则幂等复用），不落项目目录。

**上下文托管给 DSH**：Sage 不再自己判断「上下文快满了该轮换」，也不创建新会话、不做轮换。上下文超限由 **DSH 自动 compact（压缩）** 处理；对 Sage 来说，会话可以被压缩，但认知文件不会。

**compact 发生时**：

- 压缩的是会话上下文，不是 `cognition/` 文件。系统提示与常驻的 principles 摘要仍在，但早先读档的细节、被拒绝提案的原文、长讨论过程可能被压缩掉。
- 因此**重要结论必须及时落盘**：Sage 在形成可复用结论时立即 `sage_propose`；没落盘的只存在于上下文里，compact 后可能就没了。
- compact 不改变 sessionId，Sage 在同一会话继续工作；不需要归档旧会话，也不需要「新一轮」。

**Sage 如何知道「忘了什么」**：

- 不依赖上下文回忆。判定前先 `sage_read` 读 `cognition/INDEX`（文件清单、摘要、版本、更新时间）与需要的具体文件，按需装载。
- 每次读取都带 `version/hash`；提案与决策引用具体文件版本，避免「我记得」式结论。
- 「忘了什么」由索引显式回答：INDEX 里列出的文件与摘要就是 Sage 当前可依赖的全部长期认知；不在索引、也不在上下文里的内容，视为不存在（不猜）。

**固定提示词 + INDEX 变化通知**：

Sage 的系统提示词是静态字符串，只包含：

- 角色与职责：大脑、只维护认知、不执行任务/不写代码/不派 Worker；
- `principles.md` 摘要，上限 **800 字符**，超出截断并标注；
- 认知库路径 `cognition/` 与索引路径 `cognition/INDEX.md`；
- 一句规则：需要最新认知时用 `sage_read` 读 INDEX 与相关文件；INDEX 可能滞后，以实际文件为准。

提示词不包含 INDEX 内容、文件清单或版本，运行期不变；创建时持久化 `sagePromptText`，恢复时复用。

**变化通知**：认知写入后对 `INDEX.md` 做 sha256（前 16 位）版本比较；变化时写 `cognition.index.changed`，payload 为 `{version, changedFiles, timestamp}`。通知器合并 60s 静默窗口内的多次变化（changedFiles 取并集），全局频率上限 5 分钟一次；同版本不重复。通知以非阻塞 host 消息投给 Sage，内容只给版本、变更文件名和「如需最新内容请 sage_read；不强制」；Sage 自行决定是否读取。投递失败只写 `cognition.index.notify_failed` 日志/事件，不影响认知写入和 Sage 运行。

**崩溃恢复**：DSH session 本身持久化；进程重启后按 sessionId 恢复，不重放旧对话；恢复失败（session 不存在/损坏）时新建会话，提示词仍是静态模板（principles 取当前摘要）。未完成提案保持 pending 等 Sage 重新读取。

**阻塞隔离**：Sage 的审阅、调研请求都是异步的；Router/Advisor 不等待 Sage。Sage 超时或不可用时：

- 已有认知照常可用；
- 新提案继续排队；
- Advisor 按「当前快照」出 WorkOrder，并在 WorkOrder 标注 `cognition_status: stale`（若有未处理提案）。

**状态字段建议**：

```text
v2.json.sage = {
  sessionId, status: 'active' | 'paused' | 'recovered',
  createdAt, lastUsedAt, lastCompactAt?, sagePromptText?
}
```

## 2. 共享认知库

### 2.1 目录结构

```text
stateDir/
├── cognition/                     # Sage 维护：Advisor 用的长期认知
│   ├── INDEX                      # 文件清单 + 摘要 + 版本 + 时间（Sage 判定前先读）
│   ├── principles.md              # 宪法：全局、最高优先级、短
│   ├── projects/
│   │   └── <project-key>.md       # 项目事实，按 workspace realpath 映射
│   ├── lessons.jsonl              # 已采纳经验（append-only，lesson_review 的投影）
│   ├── decisions.md               # 决策记录：日期/结论/理由/状态/来源/supersedes
│   ├── proposals/
│   │   └── <proposalId>.json      # 待 Sage 审阅的提案（含拒绝理由）
│   └── snapshots/
│       └── <ticketId>.json        # 可选：本次 Advisor 实际装载的快照与版本
├── chatbot/                       # Sage 维护：Chatbot 的长期记忆（Chatbot 只读）
│   ├── INDEX.md                   # 四个文件的摘要索引（注入 Chatbot 启动上下文）
│   ├── preferences.md             # 用户偏好、风格、雷区
│   ├── agreements.md              # 与用户的长期约定（时间/渠道/审批习惯等）
│   └── decisions-digest.md        # 历史决策摘要：日期/结论/影响
├── sage/                          # Sage 会话 cwd（不落项目）
├── advisors/                      # 无状态 Advisor 运行目录（不落项目）
└── v2.json                        # sage 状态、ticket meta、审计索引
```

**project key**：`slug(basename(realpath(workspace))) + '-' + sha1(realpath(workspace)).slice(0,8)`。与旧 project-advisor 方案一致，但这里只生成项目认知片段，不生成项目 Advisor 会话。无 workspace、路径不可读或指向 `stateDir` 时走 global 片段。

### 2.2 各文件的内容与上限

| 文件 | 内容 | 写入方式 | 装载上限 |
|---|---|---|---|
| `principles.md` | 全局必须遵守的原则、硬边界、用户稳定偏好 | 仅 Sage 采纳；变更需版本号与理由 | 全量 ≤1.5k 字符 |
| `projects/<key>.md` | 该项目的事实：目录结构、构建/部署、隐性约定、已踩坑 | proposal → Sage 采纳 → 合并/追加 | ≤2k 字符 |
| `lessons.jsonl` | 已采纳的可复用经验，字段与现有 lesson 对齐 | `lesson_review` 为唯一审阅入口；Router 投影 | 每次检索前 5 条 ≤2k 字符 |
| `decisions.md` | 决策：date、id、status、conclusion、rationale、scope、sources、supersedes | append-only；新决策显式 supersede 旧决策 | 最近 10 条 ≤1.5k 字符 |
| `proposals/<id>.json` | 提案原文、author、source、scope、证据、置信度、优先级、Sage 决定 | 四类来源均可提交（见 §2.6/§5）；Sage 只写决定 | 单条 ≤2k 字符；pending 上限 100 |
| `cognition/INDEX` | 以上文件的清单、摘要、版本、更新时间 | Router 单写者维护，随落档刷新 | 全量 ≤2k 字符 |
| `chatbot/INDEX.md` | Chatbot 四个记忆文件的摘要索引 | Sage 采纳后由 Router 落档；Chatbot 只读 | 全量 ≤1k 字符，注入启动上下文 |
| `chatbot/preferences.md` | 用户稳定偏好、风格、雷区 | 只能经提案 → Sage 采纳 | ≤1k 字符 |
| `chatbot/agreements.md` | 与用户的长期约定（时间、渠道、审批习惯） | 只能经提案 → Sage 采纳 | ≤1k 字符 |
| `chatbot/decisions-digest.md` | 历史决策摘要：日期/结论/影响 | ticket 收口或复盘后由 Sage 提炼 | 最近 20 条 ≤2k 字符 |

`lessons.jsonl` 与 `lessons.json` 的关系：**`lessons.json` 仍是经验库权威存储**，`lesson_review` 仍是唯一 accept/reject 入口；`lessons.jsonl` 是已采纳条目的 append-only 投影，供 Sage/Advisor 快速按 key 读取，不另起一套审阅。两者不一致时以 `lessons.json` 为准并重建投影。

### 2.3 写入流程：proposal → Sage 采纳 → 单写者落档

任何角色都**不能直接改** `principles/projects/lessons/decisions`：

1. **提交提案**：用户 / Advisor / Worker / Reflection Worker / Sage 通过 `cognition_propose`（或 Sage 的 `sage_propose`）写 `proposals/<id>.json`。字段必填：`author`、`source{kind,ticketId,sessionId}`、`scope`（global、project key 或 chatbot 记忆文件）、`kind`（principle/project-fact/lesson/decision/chatbot-memory）、`text`、`evidence[]`、`confidence`、`priority`、`createdAt`、`supersedes?`。
2. **Sage 审阅**：Sage 用 `sage_read` 查重、看冲突、看证据，然后 `sage_propose({action:'adopt'|'reject', proposalId, rationale})`。采纳/拒绝都写审计，拒绝理由留在提案里供复查。
3. **Router 提交**：Router 的**单写者队列**按采纳决定落档（append 或合并），更新版本与 hash，写 `router-events`（`cognition/proposed|adopted|rejected|superseded`）。Sage 不直接写文件，避免与 Router/其他写入竞争。
4. **生效**：下一次 Advisor 检索时按版本装载；已发出的 WorkOrder 不回写、不重跑，除非用户显式重开。

**冲突与优先级**：`principles > decisions > projects > lessons`。新决策覆盖旧决策必须写 `supersedes`；未写 supersede 的冲突不自动合并，标 `conflict` 等 Sage 裁决。项目事实只在该 project key 生效；lesson 默认全局，但可带 `scope=project:<key>`。

**单写者**：所有认知文件写入经 Router 的串行队列（同进程互斥 + 原子写 tmp+fsync+rename）；SQLite 落地后改为事务（见 [sqlite-migration-design.md](sqlite-migration-design.md)）。提案文件可并行写，但 ID 去重与采纳状态由队列裁决。

### 2.4 检索键与装载预算

**检索键**：

- `workspace` → 规范化 realpath → project key（无 workspace 用 `global`）；
- `goal` 关键词/标签 → lessons 与 decisions 的 tag 匹配；
- `scope` → principles 全量 + project 片段 + 相关 lessons + 最近 decisions；
- `sourceTicketId` 仅用于审计，不参与排序。

**Advisor 单次快照预算**（字符，非 token）：

| 片段 | 上限 | 超限策略 |
|---|---|---|
| principles | 1.5k | 永不裁剪；超限说明宪法本身过长，需 Sage 收敛 |
| project facts | 2k | 先保留与 goal 命中段落，其余折叠为标题 |
| lessons | 2k（前 5 条） | 按命中分、置信度、时间排序；低分丢弃 |
| decisions | 1.5k（最近 10 条） | 只保留与 scope/goal 相关的最近项 |
| **总计** | **≤6k** | 先裁 lessons，再裁 decisions；principles 不动 |

检索结果带 `version/hash`、每条来源与命中原因；Advisor 的 `snapshots/<ticketId>.json` 记录实际装载内容，便于复现。

### 2.5 防污染

- **来源必填**：每条认知必须有 ticket/session 来源与证据链接；没有来源的结论只能停留在提案，不入档。
- **scope 必填**：项目事实不得写成全局原则；跨项目结论要标 `promotedFrom` 与至少两个项目来源。
- **时间与过期**：每条带 `createdAt/updatedAt`；项目事实 90 天未命中降权，lesson 180 天未命中降权；过期不删除，标 `stale` 并在检索时排在后面。
- **冲突可见**：检索时若命中冲突项，快照带 `conflict: true` 与双方 id，Advisor 必须在 WorkOrder 里显式说明取舍或标阻塞，不静默选一个。
- **脱敏**：不写入 token、密钥、完整命令输出、用户隐私原文；只写结论与必要证据指针。
- **回滚**：每次落档保留旧版本（或 append-only 历史）；`cognition revert <version>` 由用户/运维执行，Sage 只能提案。
- **金丝雀**：新采纳的原则先只对 `scope=canary` 的票生效一轮，观察 WorkOrder 质量后再全量；坏结论可快速回滚。

### 2.6 全量记忆托管：Sage 维护 Ria 的全部记忆

Sage 的范围不只是 Advisor 用的认知，还包括 **Chatbot 的长期记忆**。一句话：**记忆在文件里，不在上下文里**；Chatbot 短期靠自己的会话上下文，长期靠 Sage 维护的文件。

| 类别 | 文件 | 谁用 | 内容 |
|---|---|---|---|
| Advisor 认知 | `cognition/principles.md`、`projects/<key>.md`、`lessons.jsonl`、`decisions.md` | Advisor / Router | 原则、项目事实、经验、决策 |
| Chatbot 记忆 | `chatbot/preferences.md`、`agreements.md`、`decisions-digest.md`、`chatbot/INDEX.md` | Chatbot | 用户偏好、长期事实、约定、历史决策摘要 |

**形态**：短条目 + 来源（ticketId/sessionId）+ 更新时间 + 置信度；不写会话上下文、不抄 transcript、不写逐轮流水。每条都可追溯到提案与审阅记录。

**谁写**：Chatbot 不直接改自己的长期记忆。它只能通过 `sage_propose` 提交提案（author=chatbot）；用户也可以直接提（author=user，优先级最高）。Sage 采纳后由 Router 单写者落档（§2.3）。

**何时更新**（事件驱动，不轮询）：

- 用户纠正/补充偏好或约定时（Chatbot 当场提案，或用户直接说给 Sage）；
- 重要决策完成时（ticket done / 复盘结论）；
- Reflection Worker 的复盘票产出时；
- Sage 处理提案、或 `/sage status` 时发现过期条目（只整理，不轮询）。

**Chatbot 如何读取**：

1. 短期：自己的会话上下文（compact 由 DSH 负责，同 §1.3）；
2. 启动注入：`chatbot/INDEX.md` + `preferences.md` 摘要（合计 ≤1.5k 字符）；
3. 需要细节：用只读工具（如 `chatbot_memory_read`）按文件/条目读取；只读、不改档。

**边界**：不改 Chatbot 的会话上下文与配置；不把用户偏好写成 principles（冲突时 principles 优先，并提示用户）；Chatbot 的临时观察不入档，只作提案素材。

## 3. 无状态 Advisor

### 3.1 输入 / 输出

每次 Advisor 调用都是独立函数式调用：

```text
输入:
  ticket brief（≤3k）
  cognition snapshot（≤6k，带 version/hash）
  任务说明（≤1k：产出 WorkOrder；可附认知提案）
输出:
  WorkOrder（plan of record）
  cognition_proposals[]（可选，0–3 条）
  cognition_status: ok | degraded | stale
```

**不保留会话记忆**：不读上一张票的对话，不继承上一张票的 WorkOrder；同一 ticket 内如需二次修订，只带该 ticket 的 brief 与上一版 WorkOrder，不扩到其他 ticket。跨 ticket 复用仅通过 cognition snapshot。

**执行形态**：仍可用 PTC（需要 read/grep/glob 做最小核对与 ticket 工具），但**逻辑上无状态**：每次调用使用新的上下文/临时运行实例；会话只是执行容器，不作为记忆载体。禁止把 Advisor 的历史 transcript 作为输入。

### 3.2 上下文预算与超限

| 部分 | 预算 | 超限处理 |
|---|---|---|
| ticket brief | ≤3k | brief 由 Router 生成时就截断；保留目标、验收、约束、依赖 |
| cognition snapshot | ≤6k | 按 §2.4 先裁 lessons/decisions；principles 不动 |
| 任务说明 | ≤1k | 固定模板 |
| 输出 WorkOrder | ≤4k | 超出拆步骤/引用证据，不贴大段代码 |

总输入建议 ≤10k。超限时不静默截断：WorkOrder 的 `context_notes` 写明「已裁剪 X 条 lessons / Y 条 decisions」。

### 3.3 检索失败降级

- 检索超时、文件损坏、版本不一致 → 只用 `principles` 生成最小快照。
- WorkOrder 必须带 `cognition_status: degraded`，并写「认知检索失败，按最小原则执行；未加载项目 facts/lessons/decisions」。
- 不静默假装检索成功；不因为检索失败拒绝出 WorkOrder（除非 principles 本身不可读，此时转 blocked(environment)）。
- 检索命中但冲突未决 → `cognition_status: conflict`，WorkOrder 明确取舍或请用户拍板。
- 失败事件写 `router-events`（`cognition/retrieval-failed`），便于告警与补检。

### 3.4 本次学到的东西如何反馈

Advisor 在 WorkOrder 或后续报告里带 `cognition_proposals[]`（不是直接写认知）：

- 新项目事实、可复用教训、需要 Sage 裁决的决策；
- 每条带 sourceTicketId、scope、证据、置信度；
- Router 只负责把提案投递到 `proposals/`，Sage 采纳后才入档。

## 4. Router 两阶段不变

Router 仍是**第一阶段快速分类**，不是 Advisor 的一部分：

```text
用户消息 → Chatbot → Request
  → Router 分类：answer | work | reflection | control
      answer      → 短问答路径（Advisor 只读答复 / 直接答复）
      reflection  → reflection Worker
      work        → Advisor（brief + cognition snapshot）→ WorkOrder → Router 派发
```

**为什么不合并且两阶段**：

- **成本与时延**：大量消息只需要 answer/control；先装载认知再让 Advisor 分类会为简单问题付出长期上下文成本。
- **确定性**：Router 是确定性控制面（状态机、路由、审批、审计）；把它塞进 Advisor 会引入模型不确定性，破坏可回放与审计。
- **边界清晰**：Router 不读对话、不写认知；Advisor 不分类、不派发。Sage 只通过 proposal 影响认知，不直接参与路由。
- **故障隔离**：Sage/Advisor 卡住时 Router 仍能处理 answer/control/已有工单。

**衔接**：Router 生成 ticket brief（≤3k）并调用 Advisor 时带 `cognitionSnapshot`；Advisor 返回 WorkOrder 后 Router 校验 schema、写入 ticket meta、按原状态机派发。Advisor 超时由 Router 标 blocked(environment) 或回退重试，不阻塞其他票。

## 5. 反馈闭环

```text
Worker / reflection Worker 产出
  → reflection Worker 提炼（不是 Worker 自己总结自己）
  → cognition proposal（source/scope/evidence/confidence）
  → Sage 审阅：可复用？不重复？有证据？scope 正确？
      ├─ 采纳 → Router 单写者落档 → 下次 Advisor 检索生效
      └─ 拒绝 → 提案保留 + 理由入库（可复查/重申）
  → router-events 记录 proposed/adopted/rejected/retrieval-hit/miss
```

**提案来源（四类，入口不同）**

| 来源 | 入口 | 必填字段 | 优先级 |
|---|---|---|---|
| **用户** | 通过 Chatbot 转达（`sage_propose` author=user）；若开放直连 Sage，也可直接对 Sage 说 | author=user、scope、text；evidence 可选 | **最高** |
| 无状态 Advisor | WorkOrder 的 `cognition_proposals[]` 字段（§3.4） | sourceTicketId、scope、kind、text、evidence[]、confidence | 常规 |
| Worker | `worker_report` 的提案字段（只作候选，不直接入档） | sourceTicketId/sourceSessionId、scope、text、evidence[] | 常规 |
| Reflection Worker | 复盘票产出的 lessons/提案（默认提炼者） | sourceTicketId、scope、text、evidence[]、confidence | 高于常规 |

**优先级**：**用户 > 纠错/安全类**（任何来源指出与 principles 冲突或安全问题）**> reflection > worker/advisor 常规**；同级按提交时间先后。用户提案不得被自动拒绝；与 principles 冲突时必须显式呈现冲突并请用户确认。每条 proposal 必须带 `author`、`source{kind,ticketId,sessionId}`、`scope`、`evidence[]`、`priority`。

**提炼者**：默认 reflection Worker，而不是执行该票的 work Worker。理由：执行者对自己的方案有自利偏差，容易把「这次这么做成了」写成通用规律；reflection Worker 只读复盘、无执行收益，且已有复盘工单与只读工具面。

**Sage 判断依据**（按顺序）：

1. **可复用**：只对一次特例有效的不入档；项目事实必须带项目 key。
2. **不重复**：与已有条目同义则合并/拒绝，不堆叠。
3. **有证据**：至少一个 ticket/session 来源 + 可核对证据（测试、日志、代码位置）；无证据只留提案。
4. **scope 正确**：项目特例不写成全局原则；跨项目结论需至少两个项目来源。
5. **冲突可裁**：与 principles/decisions 冲突时，Sage 必须显式 supersede 或拒绝，不能静默覆盖。

**节奏**：事件驱动，不轮询。Worker 报告/复盘完成触发提炼；Sage 在处理 Request/提案时推进；没有新事件就不产生新认知写入。

## 6. 与现有组件的关系

| 组件 | 关系 | 边界 |
|---|---|---|
| `lesson_review` | 仍是 lessons 的**唯一 accept/reject 审阅入口**；Sage 只读 `lessons.jsonl` 投影，Advisor/Worker 只提交候选 | 不让 Sage 直接写 `lessons.json`；不让 Advisor 保留长期审阅记忆 |
| `router-events` | 记录 `cognition/proposed|adopted|rejected|superseded|retrieval-failed|retrieval-hit` 与版本 hash | 只审计，不改认知；事件查询用于回滚与告警 |
| risk approval | 认知写入是数据操作，不走执行审批；`sage_request` 派生的调研票仍走正常风险分级与 ticket 审批 | 认知提案不能被当成提权或绕过审批 |
| 协管（co-management） | 协管事件需要跟踪时落 ticket；结论进入反馈闭环，不在协管模块里写认知 | 协管只提供事件与来源，不直接改认知 |
| 旧 Global Advisor | 旧长期会话退役为只读归档；历史不迁移，可复用结论经 reflection 提炼进认知 | 退役不回滚已派发 WorkOrder；旧 session 不参与新票 |
| Chatbot | 入口、通知、转述；只读自己的长期记忆文件（`chatbot/INDEX.md` + preferences 摘要），记忆变更只能提提案 | 不直接改长期记忆/认知，不改配置；用户仍通过 Chatbot 下达任务 |

**旧 Advisor 退役**：

1. 影子检索：旧 Advisor 照常工作，Router 同时生成 cognition snapshot 并记录差异。
2. 新票切到无状态 Advisor；旧会话只处理已打开票。
3. Sage 上线，提案/采纳闭环跑通。
4. 旧 Global Advisor 归档只读（保留 session 日志），不再接新票；`advisorMode` 保留回滚。

## 7. 生命周期、状态与恢复

- **启动**：ensureSage；检查 `cognition/` 版本/锁；重建 lessons 投影；对未决提案只读展示，不自动采纳。
- **崩溃**：session 恢复；未落档提案保持 pending；写队列从磁盘恢复，半写文件用 tmp 清理。
- **Sage 满载**：上下文由 DSH 自动 compact（§1.3），Sage 不做轮换；compact 期间 Router 用上一版快照，不阻塞派单。
- **Sage 不可用**：Advisor 用 principles-only 降级；WorkOrder 标 `cognition_status: degraded`；不等待 Sage。
- **写入恢复**：Router 单写者队列 + 原子写；启动时校验 hash，损坏文件从备份/上一版本恢复，不静默清空。
- **无轮询**：所有推进都挂在 Request/提案/Worker 报告/索引变更事件上。

## 8. 接口、命令与状态

### 8.1 Sage 工具（仅 Sage 可见）

```text
sage_read {
  scope?: "global" | "project:<key>",
  query?: string,
  keys?: ["principles","project","lessons","decisions","proposals"],
  limit?: 1..20
}
→ { principles, project, lessons[], decisions[], proposals[], version, hits[] }

sage_propose {
  action: "propose" | "adopt" | "reject",
  proposalId?: string,
  kind?: "principle" | "project-fact" | "lesson" | "decision",
  scope?: string,
  text?: string,
  evidence?: string[],
  confidence?: 0..1,
  supersedes?: string,
  rationale?: string
}
→ { proposalId, status:"pending"|"adopted"|"rejected", auditId }

sage_request {
  goal: string,
  mode: "reflection" | "work",
  scope?: string,
  reason: string
}
→ { requestId, status:"queued" }
```

### 8.2 内部接口

```text
cognition.snapshot({ workspace, goal, budget }) -> { text, version, status, hits, conflicts }
cognition.propose(proposal) -> proposalId
cognition.adopt(proposalId, rationale) -> { version, applied }
cognition.revert(version) -> { version }
advisor.plan({ ticket, brief, snapshot }) -> { workOrder, proposals, cognitionStatus }
```

### 8.3 运维命令（建议）

- `/sage status`：session、lastCompactAt（可选）、pending proposals、最近采纳/拒绝。
- `/sage adopt <proposalId>`：用户显式采纳（仍走 Router 单写者与审计）。
- `/cognition verify`：校验文件/hash/投影一致性。
- `/cognition revert <version>`：回滚认知版本（需用户确认）。

这些命令只读/管理认知，不直接派工单、不改 ticket 状态。

### 8.4 状态字段

```text
v2.json.sage = { sessionId, status, createdAt, lastUsedAt, lastCompactAt?, sagePromptText? }
v2.json.advisorMode = "legacy" | "sage"        # 回滚开关，默认 legacy 直到 P4
v2.json.cognition = { version, lastAppliedAt, pendingProposals, lastError }
```

## 9. 分阶段迁移与回滚

| 阶段 | 改动 | 验收 | 回滚 |
|---|---|---|---|
| **P0 现状** | 单 Global Advisor，现有链路 | 现有测试全绿 | — |
| **P1 认知空壳 + 影子检索** | 建 `stateDir/cognition/`、空 principles/projects/decisions；Router 为每张票生成快照并记录，不改变 Advisor 输入 | 快照版本/命中可查；旧行为不变；无写认知 | 关闭 `cognitionEnabled`，仅留只读文件 |
| **P2 无状态 Advisor（新票）** | 新票走 brief+snapshot；旧票仍用旧会话；Advisor 不保留跨票记忆 | 新票 WorkOrder 质量不降；检索失败显式 degraded；可一键回 legacy | `advisorMode=legacy`，新票回旧路径；已发 WorkOrder 不回滚 |
| **P3 Sage + proposal 闭环** | Sage 会话、`sage_read/propose/request`、Router 单写者、lesson_review 投影、DSH compact + 文件化记忆（认知 + Chatbot 记忆） | 提案→采纳→下次快照生效；拒绝有理由；compact 后 Sage 能靠 INDEX 重建上下文；Sage 阻塞不影响派单 | `sageEnabled=false`，退回 P2 快照；提案保留 |
| **P4 退役旧 Global Advisor** | 旧会话归档只读；新票全部无状态；旧历史提炼 | 无新票进入旧会话；旧会话可只读打开；回滚开关仍可用 | `advisorMode=legacy` 恢复旧会话；不删日志 |

**迁移原则**：

- 每阶段先影子后切流；写入开关与读开关分开（`cognitionEnabled` / `sageEnabled` / `advisorMode`）。
- 旧会话历史不回迁；需要保留的结论经 reflection 提炼成 proposal，不直接复制 transcript。
- 已派发/已完成的 WorkOrder 不回滚；回滚只影响新票与新认知读取。
- 每阶段验收包含：`npm test`、router-events 审计、两票对照、回滚演练。

## 10. 风险与应对

| 风险 | 表现 | 应对 |
|---|---|---|
| **认知腐败** | 错误结论进入 principles/projects，污染所有 Advisor；越用越偏 | 来源/证据/scope 必填；Sage 采纳门槛；金丝雀 scope；版本化 + `cognition revert`；定期抽样复核 |
| **检索失败静默** | 快照为空但 Advisor 仍自信出方案，质量无声下降 | 失败必须标 `cognition_status=degraded` 并写 WorkOrder；principles-only 兜底；router-events 告警；禁止空快照伪装成功 |
| **Sage 成为瓶颈** | 所有提案等 Sage，Sage 卡住导致新认知不生效甚至派单变慢 | Sage 异步、超时、不阻塞 Advisor；未采纳提案保留；已有认知照常检索；Sage 不可用时 P2 快照继续 |
| **写入冲突** | Sage/Router/lesson_review 同时写，最后写入者覆盖或半写 | 单写者队列 + 原子写 + 版本/hash + append-only decisions；提案可并行但采纳串行；SQLite 后改事务 |
| 上下文膨胀 | Sage 或 Advisor 又变成长期会话 | 上下文交给 DSH 自动 compact，记忆落文件（cognition/INDEX）；Advisor 逻辑无状态；快照固定预算；不把 transcript 当输入 |
| 项目事实跨项目泄漏 | A 项目结论被 B 项目加载 | project key 严格隔离；全局原则需多项目证据；检索按 workspace 过滤 |
| 旧 Advisor 退役不彻底 | 新票仍进旧会话，双轨漂移 | `advisorMode` 开关 + 路由断言 + 审计；P4 验收检查无新票进入旧 session |

## 11. 明确不做

- 不做 per-project Advisor、不做按项目分会话。
- 不做 Advisor 之间互通/协商。
- 不引入新进程、端口或第二个服务。
- 不改变 Router 的职责、分类逻辑与派发入口。
- 不让 Sage 执行、写代码、改文件、派 Worker 或改 ticket 状态；`sage_request` 只发起请求，实际派发仍由 Router。
- 不把认知写成长期对话记忆；不迁移旧 Advisor transcript。
- 不做无审阅的自动认知写入；不让 Worker 直接改 principles/decisions。
- 不在本设计内实现 SQLite；只在写入一致性处引用迁移方案。
- 不让 Sage 自己轮换上下文：compact 完全交给 DSH；Sage 只负责把结论落成文件。

## 12. 开放问题

- Sage 系统提示词里的 INDEX 快照只在会话重建时刷新；是否需要显式刷新命令？
- principles 的修改是否需要用户二次确认（涉及全局行为）？建议高风险变更需用户显式批准。
- 项目 key 对同一 realpath 的不同挂载点是否需要 inode/device 去重？
- 金丝雀 scope 如何选择样本票（按项目/按主题/按风险级别）？
- 旧 Advisor 归档保留多久？建议随 DSH session 保留期，不额外复制。
- `cognition.snapshot` 是否缓存到 `snapshots/<ticketId>.json` 以复现？建议 P2 起保留，按 ticket 生命周期清理。

## 13. 修订记录（2026-11-19）

按用户新决定收敛，改动如下：

| 项 | 旧 | 新 |
|---|---|---|
| 上下文管理 | Sage 自己做上下文 epoch 轮换（70%/40 轮触发、新建会话、epoch+1） | **DSH 自动 compact**：Sage 不轮换、不新建会话；重要结论及时落盘，靠 `cognition/INDEX` 与文件重建认知；常驻 principles 摘要 ≤800 字 |
| 记忆范围 | 只维护 Advisor 用的共享认知 | **Ria 全量记忆**：Advisor 认知 + Chatbot 长期记忆（`chatbot/preferences.md`、`agreements.md`、`decisions-digest.md`、`INDEX.md`）；Chatbot 只读、只能提案 |
| 提案来源 | Worker / reflection / Advisor | 增加**用户**（优先级最高）与无状态 Advisor 的 WorkOrder 提案；明确四类入口、必填字段与优先级 |
| 命名 | — | Sage 会话标题固定 **`Ria Sage`** |
| 状态字段 | `epoch` / `lastEpochAt` | `lastCompactAt?`；删除 `/sage epoch` 命令 |

**未改**：Router 两阶段、单写者落档、risk approval 边界、Advisor 无状态与快照预算、分阶段迁移开关与回滚。

**遗留待评审**：Chatbot 记忆文件的容量与过期策略；用户直连 Sage 是否开放。

## 14. 实现口径（2026-11-19，简化交付）

本次实现按用户确认的简化口径落地，和上文长期目标的差异：

- **Sage 单例，无写队列/优先级/批处理**：提案直接写 `cognition/proposals/`，积压不阻塞 Ria；用户提案 priority=high 仅用于排序。
- **Sage 独占写、原子写、INDEX 更新**；不做 TTL 自动清理、不做冲突检测引擎、不做版本回滚 UI；过期/冲突由 Sage 自己维护。
- **Advisor 默认无 session**：`planTicketStateless` 单次 LLM 调用（最多 2 次尝试/120s）产出 plan/answer/block；输入 brief + cognition snapshot，degraded 显式；`advisor.plan` 记录 `sessionId:''`、latencyMs、usage、cognitionIds、brief/workOrder 摘要；失败先写 `advisor.plan.failed` 再由调用点落 blocked。`advisorMode=legacy` 才保留 `createAdvisorForTicket` 建会话与 `ticket_plan` 回滚路径。
- **Sage cwd = stateDir 根**：旧 `stateDir/sage` 会话启动迁移时归档一次并写 `sage.migrated`，随后新建/绑定 cwd=stateDir 的 Sage；已是 stateDir 的 Sage 幂等复用；注入 INDEX + principles 摘要（≤800 字）。
- **Chatbot 记忆**：由 `onPreStep` 以 host 消息注入只读摘要，记忆变化才重注；用户提案走 `chatbot_propose`。
- **bootstrap**：`bootstrapCognition()` 从 DESIGN 五原则、architecture/limitations 摘要、memory.md、lessons 生成初始 principles/projects/chatbot 文件，`.bootstrapped` 幂等。
- **Sage 工具**：`sage_read` / `sage_write` / `sage_request`；`sage_write` 遇 `resolveProposal` 标记提案已采纳。
- **compact**：监听 Sage 的 `compaction/end` 重读 INDEX；不创建 epoch 会话。

