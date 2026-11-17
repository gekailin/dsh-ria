# superagent 借鉴评估（归档要点）

> 状态：历史设计（Phase 22/23 实施前的只读评估稿；本页为 2026-11-16 压缩归档）/ 部分实现 / 部分方案未实现
> 现行文档见 `README.md`、[design-history.md](design-history.md) 第 20 节（实现状态）与第 15 节（逐阶段落地记录）。

## 背景与目标

- 评估对象：`/home/gkl/Desktop/vibe_proj/misc/dsh-superagent-prototype`，约 2.8 万行 TS；读了 `docs/000–008`、`prompts/`、`src/core`、`src/app`、`src/executor`。
- 对照基线：本仓 `lib/index.js`、`lib/tickets.mjs`、`lib/worker-idle.mjs`，以及 `design-history.md`、`task-model.md`。
- 性质：只读评估，不改 `lib/`、`test/`，不跑会改文件的脚本，不重启、不推送。
- 要回答的问题：prototype 哪些设计值得 Ria 学。结论是：值得学的不是它的多源获客体系（GitHub/Feishu 触发 → Eval → 订阅），而是为「人不会错过任何需要自己的事」而建的三件出口基础设施。
- 纳入标准：每条先写「解决什么痛点」；说不出痛点的标「无痛点需求」，不因「对方有」而抄。
- 可靠性声明：通读 prototype 的 `docs/000/001/003/004/007` 与 `prompts/*.md`（共 464 行）及 6 个核心源文件的关键段，行号为评估时 HEAD 的实读结果；未通读 `src/client/*.tsx` 与 `tests/*`，未运行 prototype 测试——其行为描述来自源码与文档，不是运行观测。
- 未核验：Ria 的 `ctx` 能否像 prototype 那样装饰宿主 `bash`/`job_output`（prototype 同宿主插件做到了，`src/app/sessions.ts:77-86`），权限等价性未验证。

## 关键决策（含理由）

### 只借出口，不借入口与领域模型
- Ria 已解决「每条用户消息都有家」（intake 恰好一次定性），短板全在出口：卡片、微信、派发说明都是 fire-and-forget。
- 三条有代码证据的静默丢失路径：`appendDispatchNote` 拿不到 turn 号直接返回 false（`lib/index.js:2334-2339`，注释明说 note 丢失而派发照常成功）；`notifyDispatchNote` 对 `sendDispatchNote` 只挂 `.catch(log)`（`:2353-2363`），断线、未登录、发送超时即永久丢；recovery 达上限时是三次独立写——`transitionTicket`（`:2570`，内含 save）→ `addFeedback`（`:897-923`，外层 try/catch 吞异常）→ `appendDispatchNote`+`notifyDispatchNote`（`:2594-2595`），死在中间则工单已 blocked 而人和微信都不知道。`addFeedback` 自身也无投递状态：卡片靠客户端按 `since` 轮询（`:925`），微信靠即时推送，两条通道都不重试。

### 只做一件时先做 outbox
1. 这是正确性问题而非体验问题：状态已落盘、用户却没收到通知，等于「系统说自己做了、用户不知道」，比任何界面细节都伤信任。
2. 它是另外两项的底座：结构化问题要一路送到微信才有意义，合并后的通知更需要「至少送达一次」。
3. 与现有架构同构：入站已是「先写后做 + 启动重放」（`addDelivery` `index.js:2285` → prompt → `:2288` `removeDelivery`；启动时 `retryDeliveries` `:2511`），出口照抄同一形态，不引入新概念。

排序依据是「可靠性 > 可行动性 > 效率」。Top 3 建议：

| 排序 | 事项 | 一句话理由 |
|---|---|---|
| 1 | 出站副作用落地投递 | 消灭「工单在跑、用户不知道」的三条路径；不动机器，只补出口 |
| 2 | 结构化 attention | 让「等你」变成「等你回答这个」，微信/面板/下一轮 turn 都能直接用；不动状态机 |
| 3 | `[Worker idle]` 合并投递 | 成本最低（一个文件），直接减少无效唤醒与过期快照误判 |

### 明确不借鉴
- **Thread / Subscription / Eval / Mandate 多源准入**（`docs/001-domain.md` 为此额外引入 5 个实体）：Ria 入口只有人，没有「要不要开工」这一步，Eval 是为外部噪声存在的；订阅 fan-out「一条消息进多张工单」与 intake 硬约束「每条真实用户消息恰好被定性一次」（`index.js:430-448`）不能共存；概念税高——「这条消息为什么进这张工单」变成要查 Thread 绑定。只带走它的结论：authorization（能不能干）与 context（消息给谁看）要分开，Ria 已用 `ticket_executor_mismatch` 预检 + `grants` 的 worker 绑定做同一件事。
- **一票多 Assignment（换会话重试）**：会同时打破工单-执行者绑定、grant 的恢复语义、用户点名 worker 的选择逻辑；要换人应关单重开（新工单、新 executor）。
- **SQLite 单库**：迁移要覆盖所有读写、归档、恢复路径；在几十到几百张工单的量级下收益不成立，而 `writeAtomic`（fsync + rename，`index.js:87-98`）+ 归档 jsonl 已解决热文件变大。真需要跨工单统计时再评估，届时未必选它。
- **一工单一个目录 + prepare 命令 + worktree**：与 `ria_spawn` 的 cwd 语义、`workspace_missing` 预检、用户「在我的项目里干」的直觉冲突；worktree 在 DSH 侧已有能力，重复造会分裂事实源。
- **源适配器（GitHub/Feishu）与 React 面板**：微信桥与它们职责同类（外部消息 → user message），第二种源只增加凭据、限流、分页、权限的运维面。
- **订阅 fan-out 且不校验发送者**（`prompts/subscriptions.md`: "no mention/sender check"）：Ria 没有 thread，「消息属于哪张工单」是硬约束（`ria_request` 必须带 `ticketId`，`index.js:1214`），照搬会让同一条消息出现在多张工单里。

## 关键机制与数字

prototype 侧：
- 一个写者 + 一张 stage 表：唯一写者是 `Engine`（`src/core/engine.ts:24`），同步、一命令一事务，对外只给按角色裁剪的接口。「在等谁」不是存储字段而是纯函数 `ticketStage()`（`src/core/stage.ts:9-21`），按首行匹配：投递失败 → 等回答 → 待 review → blocked/failed 无人回复 → 排队 → idle → working。
- 先落盘再做：`Effects` 在业务事务内 `enqueue`、提交后执行；`kind+key` 只有一行（同 key 覆盖 payload）；同 kind 按 `seq` 串行（`effects.ts:109-113`）；失败指数退避（`:141-143`），连续 3 次失败报健康；`Later` 表示「现在没资源」，不计失败（`:5`、`:138-139`）；关停不动运行中的行，重启续跑。
- 资源不够就排队而非拒绝：worker 槽位 = `maxWorkers` + 给人留 1 个（`if (this.used() >= this.max() + (by === 'person' ? 1 : 0)) throw new Later(...)`，`src/executor/dsh.ts:194`）。
- 结构化 attention：`Attention { id, question, triggerId }`（`src/core/model.ts:275`）挂在 ticket 上，卡片直接渲染 `attention.question`；报告枚举 `progress|waiting|ready|blocked|failed|dropped`，`reportRelay()` 只在「有结构化 question」或「非 progress」时转发（`notices.ts:121-129`）——routine progress 不进人的视野；回复目的由 host 校验（`result` 要求工单已 ready，`attention` 要求当前存在 structured request）。
- prompt 是版本化配置：覆盖记录 `base`（被改的内置文本 key，`prompts.ts:28-30`），内置文本升级后算 `DefaultChange` 差异给人看；`generated` 段（environment、policy）每次请求重建。
- 主会话不等待：host 装饰 `bash`/`job_output` 拒绝 sleep（`sessions.ts:77-86`）。

Ria 侧现状：
- `waitingOn` 是半派生：`normalizeTicket` 有按状态默认值（`tickets.mjs:96`），每状态允许集靠不变量约束（`:255-280`），如 working 只能 `worker|ria`，blocked 只能 `user|approval|environment`。
- 语义缺口：`waitingOn=user` + `blockedReason` 自由文本只能告诉人「有事」，说不了「要你做什么」；`lib/` 里没有任何 `question` 字段。
- idle 唤醒：每事件一条 queue prompt（`worker-idle.mjs:174-179`），节流键 `sessionId|ticketId`（`:139-148`），跨 session 不去重；三个 worker 两分钟内结束就是三次唤醒、三次 `ria_status`/`ria_read`，后两次读到的是已被收尾的过期快照。
- outbox 最小形态：`outbox: [{id, kind, payload, attempts, due}]` + `pump()`（启动与每次 save 后触发），先只接 `notifyDispatchNote`；幂等键用 `feedbackId`（微信按 id 去重、卡片按 id 过滤），重试要有上限与放弃终态，否则积僵尸队列；队列为空即等价旧行为，回滚容易。
- attention 最小形态：`ticket.pendingQuestion = { text, askedAt }`，由 blocked/failed 转移的 `options` 带入，任何离开 blocked 的转移清空。纪律：不做成 blocked 必填项，否则模型漏传就报错、T8/T9 失败率上升；展示策略是「有 question 就展示，没有就退回 blockedReason」。
- idle 合并的候选实现：`pending: Map<sessionId, {tickets, lastTurn}>` + 2–5 秒窗口，每个 session 一段、带各自 turn id/outcome，一次 `prompt`。

## 实现状态

- 出站副作用 outbox：已落地。`lib/outbox.mjs` 提供原子写、幂等 key、退避重试、6 次上限、delivered 清理、失败保留与 summary，另有按谓词作废（依赖退回等待时删 queue wake）；`test/outbox.mjs` 覆盖幂等入队、重载、退避、上限、坏文件恢复、无活跃 turn 时排队与 turn 开始后补投；smoke 覆盖「卡片写失败仍记 note」「微信异常后按 due 重试并 delivered」。
- 结构化 attention：已落地。`lib/tickets.mjs` 的 `normalizeAttention` 产出 `{ question, options?, ref? }`，不变量规定它只在 blocked 且 `waitingOn ∈ {user, approval}` 时合法，否则抛 `invalid_attention`；`blockedReason` 缺失时回填 `attention.question`；审批场景下 attention 在待决审批之间移交（`lib/approvals.mjs`）；`test/attention.mjs` 覆盖设置/读取/清空、旧 blockedReason 工单与 `ria_status` 输出。
- `[Worker idle]` 跨 worker 合并投递：未实现，仍只是建议。当前同一 session 的多张 working 工单会合成一段 `idleText` 一次投递，但不同 session 各发一条 prompt；节流默认 30s（`DSH_RIA_WORKER_IDLE_THROTTLE_MS` 可配，夹在 1s–600s）。
- 低优先、未做：`ticketStage()` 式纯派生（Ria 没有 assignment，派生不出 queued/idle/review 中间态）、prompt 版本化与 `base` 漂移提示（单人维护，可先把变更记进 `docs/`）、host 级「不许等」护栏（已有明文禁令 `index.js:1216`，护栏会误伤真实长命令且需装饰宿主工具）、100 词硬上限（微信侧已有 800 字/含表格代码转 .md 的降级）、`Later`（Ria 无槽位概念）、恢复提示补「外部动作（push/评论/PR）先核对」这个措辞（`index.js:1221` 已覆盖大半，属一句话打磨）。
- 明确标注无痛点、不做：团队分节编辑 prompt 与团队 skills、设置项收敛/策略版本 UI/变更历史、面板统计（无排队概念、无通过/拒绝漏斗）、多语言（中英混排是刻意的：给模型看英文、给用户看中文）、候选卡 pending 过期（intake 有强制定性，不需要超时清理）。

## 仍未实现 / 风险

- 至少一次不等于不丢：outbox 只对已成功持久化的条目保证 at-least-once + 有限重试，不覆盖「派发已接受但尚未落盘」的窗口，也不覆盖入队写盘失败——这类确认仍可能丢。
- 重复投递是 outbox 的主要破坏性风险（低-中）：卡片走轮询、微信走推送，重试会让同一件事出现两次，必须靠 `feedbackId` 幂等，并设重试上限与「放弃」终态。
- idle 合并的代价是 2–5 秒延迟，且合并后工单状态可能已变：文本里要保留每张票的 `lastWorkerTurn` 与时间戳，让 Ria 自己看出快照旧了（它本就被要求 `ria_read` 复核，`index.js:1217`）。
- attention 的风险不在状态机而在纪律：一旦变成 blocked 必填项，会推高 T8/T9 失败率并把工单卡在半路。
- 未实测：outbox 重试上限、idle 合并窗口时长都无实测数据（落地时以日志为准）；prototype 的 `tests/core-engine`、`runtime` 未运行。
- 决策前提会过期：否定 SQLite 的理由基于「几十到几百张工单」；一旦出现跨工单统计/查询需求就要重估，届时 DSH 宿主可能已有存储能力。
- 并发模型不可平移：`maxWorkers + 1` 的人工槽服务 prototype 的 slot 概念，Ria 侧不设全局并发上限（只有宿主按会话排队），该机制不适用。

## 现行文档

- `README.md`：入口与当前能力。
- [design-history.md](design-history.md) 第 20 节：实现状态——outbox、attention、审批可见性、依赖排队等已实现项，以及哪些只有单测/smoke 覆盖、哪些未用真实微信账号验证。
- [design-history.md](design-history.md) 第 15 节：逐阶段落地记录（outbox 与结构化 attention 的落地过程）。
- `docs/operations.md`：副作用 outbox 的运维语义、worker idle 唤醒。
- `docs/tools.md`：工具参考，含 attention 的读写约束；`docs/state-and-api.md`、`docs/testing.md`：状态文件/HTTP API 清单与测试套件覆盖范围。
