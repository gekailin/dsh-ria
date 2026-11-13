# superagent 借鉴评估：哪些设计值得 Ria 学

> 评估对象：`/home/gkl/Desktop/vibe_proj/misc/dsh-superagent-prototype`（约 2.8 万行 TS；`docs/000–008`、`prompts/`、`src/core`、`src/app`、`src/executor`）
> 对照基线：本仓库 `dsh-ria`（`lib/index.js`、`lib/tickets.mjs`、`lib/worker-idle.mjs` 等）与 `docs/DESIGN.md`、`docs/task-model-design.md`
> 性质：**只读评估**。本文不改 `lib/`、`test/`，不跑会改文件的脚本，不重启、不推送。
> 引用：`文件:行号`，行号以评估时的 HEAD 为准；跨仓库时以文件名区分。
> 历史基线说明：本文是 Phase 22/23 实施前的评估，下面“Ria 现状”及旧代码位置仅指评估时基线，不是当前缺陷清单。outbox 与结构化 attention 已分别在 Phase 22/23 落地；跨 worker 的 idle 合并投递仍是建议。outbox 对已成功持久化条目提供至少一次（at-least-once）投递与有限重试，不保证派发接受到落盘前的窗口或入队写盘失败不会丢确认。当前状态以 README.md 与 docs/DESIGN.md 第 20 节为准。

---

## 0. 先说结论

prototype 值得借的**不是**它的多源获客体系（GitHub/Feishu 触发 → Eval → 订阅），而是它为了让「人不会错过任何需要自己的事」而建的三件基础设施。Ria 已经解决了「每条用户消息都有家」（intake + T28 转移表），但评估时的**出口**（卡片、微信、派发说明）还是 fire-and-forget（现已落地 outbox，见上方历史基线说明）。

| # | 借鉴点 | 解决的 Ria 具体痛点 | 代价 | Ria 侧主要落点 |
|---|---|---|---|---|
| 1 | 出站副作用落地投递（effect/outbox） | 卡片/微信/说明在一次 `save()` 之后发，失败只写日志，崩在中间就永久丢 | 中 | `lib/index.js:2334`、`:2353`、`:2570-2595` |
| 2 | 结构化 attention（问题，而不只是状态） | `waitingOn=user` 只有枚举和一段自由文本，答不了「用户到底要做什么」 | 中 | `lib/tickets.mjs:17`、`lib/index.js:753` |
| 3 | `[Worker idle]` 合并投递 | N 个 worker 同时 idle 唤醒 Ria N 次，每次重读快照 | 小 | `lib/worker-idle.mjs:130-179` |

- **只做一件：第 1 件。** 理由是 Ria 的价值主张就是「用户永远知道发生了什么」，而现在有三条静默丢失路径（见 4.1）。
- **最不该学：Thread / Subscription / Eval / Mandate 那一整套多源准入模型**（6.1）。它会把 Ria 从「ticket 是唯一管理单元、一张工单一个 executor」改成「消息先过准入、再 fan-out 到多张工单」，与 intake 的「每条消息恰好定性一次」直接冲突。

---

## 1. 读法、范围与可靠性声明

- 通读了 prototype 的 `docs/000-philosophy.md`、`001-domain.md`、`003-execution.md`、`004-prompts.md`、`007-architecture.md` 与 `prompts/*.md`（共 464 行），以及 `src/core/stage.ts`、`src/core/model.ts`、`src/app/effects.ts`、`src/app/notices.ts`、`src/app/cards.ts`、`src/app/sessions.ts`、`src/app/prompts.ts`、`src/app/tools/main.ts`、`src/executor/dsh.ts` 的关键段。**没有**通读它的前端 `src/client/*.tsx` 与 `tests/*`。
- Ria 侧重点核对了状态机、反馈、派发、idle 通知、recovery、prompt 六处，行号均为实读。
- 未做：未运行 prototype 的测试；未在 DSH 里验证「Ria 侧能否装饰宿主的 `bash` 工具」（prototype 是同宿主插件且做到了，`src/app/sessions.ts:77-86`，但未验证 Ria 的 `ctx` 权限等价）。
- 下文每条都先写「解决什么痛点」。如果只有「对方有、我们也能有」而说不出痛点，会**明确标注「无痛点需求」**。

---

## 2. prototype 的设计骨架（只写影响判断的部分）

### 2.1 注意力是设计目标，不是副产品

`docs/000-philosophy.md` 的第一句是「Take as little human attention as possible, and give as much value as possible」，随后把它变成可执行规则：每条消息、每个通知、每个设置项、面板上的每个元素都要「挣得」自己的注意力成本；只在被要求或有成文规则时行动；只在「人必须做点什么」或「人能用上结果」时说话；问就一次只问一个结构化问题。

对 Ria 有意义的是它的推论：**「少概念」优先于「表达力」**——一个业务需求应变成某个属性的取值或一句 prompt，而不是新实体；**「默认值」优先于「设置项」**。这解释了 prototype 为什么用少量领域实体就覆盖了外部源、人、执行器三类参与者。

### 2.2 一个写者 + 一张 stage 表

- 唯一写者是 `Engine`（`src/core/engine.ts:24`），同步、一条命令一个事务；调用方拿到的是按角色裁剪的接口（Sources / MainSession / People / Settings / Executor），不是 store 本身。
- 「这张工单现在在等谁」不是存储字段，而是**纯函数派生**：`ticketStage()`（`src/core/stage.ts:9-21`）按 docs/003 的表**首行匹配**——投递失败 → 等回答 → 待 review → blocked/failed 无人回复 → 排队 → idle → working。卡片状态直接由它渲染（`src/app/cards.ts:20-25`），面板按「在等人的」分组（`src/app/views/overview.ts:73`）。

Ria 的 `waitingOn` 是**半派生**：`normalizeTicket` 有按状态的默认值（`lib/tickets.mjs:96`），但每个状态允许的取值范围靠不变量约束（`lib/tickets.mjs:255-280`，如 working 只能 `worker|ria`，blocked 只能 `user|approval|environment`）。好处是能表达「working 但在等 Ria 补信息」，坏处是它成了与 `status` 并列的事实源，调用方必须传对。

### 2.3 先落盘，再做；失败可重放

`Effects`（`src/app/effects.ts`）是持久化副作用队列：在业务事务内 `enqueue`，提交后再执行；每个 `kind+key` 只有一行（同 key 覆盖 payload），顺序 kind 按 `seq` 串行（`:109-113`），失败指数退避（`:141-143`），`Later` 表示「现在没资源，别记失败」（`:5`、`:138-139`），连续 3 次失败报健康。关停时不动运行中的行，重启继续（`:136-137`）。

配套的是「资源不够就排队，而不是拒绝」：worker 槽位 = `maxWorkers` + **给人留 1 个**——`if (this.used() >= this.max() + (by === 'person' ? 1 : 0)) throw new Later(...)`（`src/executor/dsh.ts:194`）。所以「新工作」永远挤不掉「人想继续跟的工单」。

### 2.4 报告与「在等人」是结构化的

- `Attention { id, question, triggerId }`（`src/core/model.ts:275`）挂在 ticket 上；卡片直接带 `attention.question`（`src/app/cards.ts:31`）。
- 报告状态是枚举：`progress | waiting | ready | blocked | failed | dropped`；`reportRelay()` 只在「有结构化 question」或「非 progress」时向主会话转发（`src/app/notices.ts:121-129`）——**routine progress 不进人的视野**。
- 回复目的被 host 校验：`result` 需要工单已 ready，`attention` 需要工单上当前存在 structured request（`prompts/replies.md`、`src/app/tools/main.ts:225`）。系统不靠「模型自觉」。

### 2.5 prompt 是版本化配置，不是代码

每个内置片段可有团队覆盖，覆盖记录 `base`（被编辑的内置文本 key，`src/app/prompts.ts:28-30`）；内置文本升级后算出 `DefaultChange` 差异给人看（`:124-127`）；`generated` 段（environment、policy）每次模型请求重建。对 Ria 而言关键是「**内置文本可被逐段覆盖且能看出基线漂移**」，而不是这套 UI。

### 2.6 它主动放弃的东西，比它做了什么更值得读

`docs/001-domain.md` 的 rejected concepts 是设计取舍的精华：不做 Principal/Membership 实体与跨源身份映射（用 prompt 文字解决）；不做「追加到 ticket」这种 Decision（订阅 fan-out 已覆盖）；不让 ticket 状态跟着 DSH Session 走；不做「一个 thread 只能有一张活工单」；**订阅上不做准入检查**（authorization 交给 ticket 的 Mandate，context 交给订阅）；策略变更**不取消**运行中的工单（只通知 + 重排）；失败/阻塞时**不锁死** worker 的所有工具（停掉自动输入就够）；**不从报告自由文本推断「在等人」**（必须是结构化字段）。

最后一条正是 Ria 缺的那块（见 4.2）。

---

## 3. 对照总表

| 主题 | prototype | Ria 现状 | 判断 |
|---|---|---|---|
| 唯一写者 | Engine 独占写（`engine.ts:24`） | `transitionTicket` 独占状态写（`lib/index.js:753`），但反馈/说明/派发记录各自 `save()` | 借「写者边界」精神，不借实现 |
| 「在等谁」 | 纯派生 `ticketStage()`（`stage.ts:9`） | `waitingOn` 半派生 + 每状态允许集（`tickets.mjs:96`、`:255-280`） | 已够用，低优先 |
| 出站副作用 | effect 队列，先写后做 + 退避（`effects.ts:130-146`） | 入站派发已先写后做（`addDelivery` `index.js:2285` → prompt → `:2288` 删除）；出站是 fire-and-forget（`:2353`） | **值得借（只补出口）** |
| 在等人 | `Attention{question, triggerId}`（`model.ts:275`） | `blockedReason` 自由文本 + `waitingOn=user` | **值得借** |
| 通知投递 | relay 在 turn 内合并到下一步（`notices.ts:121`、`sessions.ts:171`） | 每 idle 事件一条 queue prompt（`worker-idle.mjs:174`） | **值得借（合并）** |
| 主会话不等待 | host 装饰 `bash`/`job_output` 拒绝 sleep（`sessions.ts:77-86`） | 仅 prompt 禁令（`index.js:1216`） | 低优先（痛点弱） |
| 恢复 | 新 assignment 带 recovery note，重投未取输入 | 重启恢复合并一条 prompt，n/3 上限（`index.js:1221`、`:2570`） | 已覆盖，仅措辞可补 |
| 并发 | `maxWorkers` + 1 个人工槽（`dsh.ts:194`） | 不设全局并发上限（只有宿主按会话排队） | 不适用（Ria 侧无 slot 概念） |
| 存储 | 单 SQLite + 事务 | JSON + 归档 jsonl + `writeAtomic`（`index.js:87-98`） | 不借 |
| 多源准入 | Thread/Subscription/Eval/Mandate | 入口只有人；intake 强制定性 | 不借 |
| 执行器模型 | 一个工单多个 assignment，可重启换会话 | 一个工单一个 executor，`ticket_executor_mismatch` 预检（`index.js:2269`） | 不借 |
| 工作目录 | 一个工单一个目录 + prepare 命令 | worker 在自己 cwd 里干（`ria_spawn` cwd） | 不借 |

---

## 4. 值得借鉴

### 4.1 出站副作用的落地投递（effect / outbox）

**解决的痛点（有代码证据，三条静默丢失路径）：**

1. **没有当前 turn 就没有派发说明。** `appendDispatchNote` 在拿不到 turn 号时直接返回 false，注释写着「the dispatch still succeeds but the note is lost」（`lib/index.js:2334-2339`）。用户看到的是「Ria 没说话」，而工单已经进了 working。
2. **微信镜像失败只写日志。** `notifyDispatchNote` 对 `sendDispatchNote` 的 promise 只挂 `.catch(log)`（`lib/index.js:2353-2363`），断线、未登录、发送超时都会永久丢，没有任何补偿。
3. **恢复路径是三次独立写。** recovery 达上限时：`transitionTicket`（内部 `save`，`index.js:2570`）→ `addFeedback`（又一次 `save`，`index.js:897-923`，外面还包了 try/catch 吞异常，`:2583-2593`）→ `appendDispatchNote` + `notifyDispatchNote`（`:2594-2595`）。进程在这三拍之间死掉，工单是 blocked，但人和微信都不知道。反馈记录本身也**没有投递状态**：`addFeedback` 只推一条记录（`:905-922`），卡片靠客户端按 `since` 轮询（`:925`），微信靠即时推送——两条通道都不重试。

**对方怎么做：** 事务内 `enqueue`、提交后执行、`kind+key` 去重、失败退避、关停保留（`src/app/effects.ts:130-146`）；回复类 effect 还受 pause 与顺序约束（`src/app/outbox.ts:24`）。

**差异：** Ria **入站**已经是「先写后做」（`addDelivery` `index.js:2285` → `prompt` → `:2288` `removeDelivery`，启动时 `retryDeliveries` `index.js:2511`）。所以不是重造投递，而是把**出口**（feedback 卡片、微信镜像、派发说明）纳入同一套「先记录、再发、失败重试」的语义。

**改造代价：中。** 涉及 `lib/index.js`（`addFeedback`、`appendDispatchNote`、`notifyDispatchNote`、recovery 路径）、新增 `lib/effects.mjs`（内存 + 落盘队列，随 `ria.json` 持久化，启动时重放）、`test/smoke.mjs` 增补。不需要动状态机。

**破坏性风险：低-中。** 风险点不在状态，而在**重复投递**：卡片走轮询、微信走推送，重试可能让同一件事出现两次。必须带 `feedbackId` 做幂等（微信侧按 id 去重，卡片侧按 id 过滤），并且重试要有上限和「放弃」终态，否则会积累僵尸队列。回滚容易：队列为空即等价旧行为。

**最小落地：** 新增 `outbox: [{id, kind, payload, attempts, due}]` 与 `pump()`（启动 + 每次 save 后触发）；先只接 `notifyDispatchNote` 一类，验证后再接 feedback 卡片。

---

### 4.2 结构化 attention：把「在等人」变成可回答的问题

**解决的痛点：** Ria 用 `waitingOn='user'` + `blockedReason` 自由文本来表达「需要人」。但这只能告诉人「有事」，告诉不了「要你做什么」：

- 微信里只有一句自然语言，用户离开半天回来，得往上翻才能拼出他要决定什么；
- Ria 下一个 turn 要判断「这张工单在等什么」，只能 `ria_read` 读 transcript（`docs/DESIGN.md` 的 ria_read 语义），既慢又容易读错；
- `lib/` 里没有任何 `question` 字段（全仓 grep 只有 prompt 文本里的 "question" 一词，`index.js:1205`、`:1206`、`:1552`），所以面板、微信、状态查询都没有结构可渲染。

**对方怎么做：** `Attention { question, triggerId }`（`src/core/model.ts:275`）挂在工单上，卡片直接带 `attention.question`（`cards.ts:31`）；报告里没有结构化 question 就不算「在请求人」（`prompts/handoff.md`），回复目的也按它校验（`replies.md`）。

**差异：** prototype 把「等人」拆成**状态 + 问题 + 来源消息**三元组；Ria 只有状态 + 文本。

**改造代价：中。** `lib/tickets.mjs`（新字段 + `normalizeTicket` 迁移默认空 + 不变量：只有 blocked/user 才允许非空）、`lib/index.js`（`ria_ticket` 在 `status=blocked` 时接受 `question`；`ria_status` 输出；微信/卡片渲染）、`lib/client.js`（卡片显示一行问题）、`test/task-state.mjs`。

**破坏性风险：低。** 不动状态机，不改 executor 绑定；旧工单缺字段按空处理。唯一要守住的纪律：**question 不能变成 blocked 的必填项**，否则 T8/T9 的失败率会上升（模型漏传就报错，工单卡在半路）。建议「有 question 就展示，没有就退回 blockedReason」。

**最小落地：** `ticket.pendingQuestion = { text, askedAt }`，由 `blocked`/`failed` 转移的 `options` 带入，任何离开 blocked 的转移清空；`ria_status` 与卡片各显示一行。

---

### 4.3 `[Worker idle]` 合并投递

**解决的痛点：** 现在每个 idle 事件都直接排一条 queue prompt（`lib/worker-idle.mjs:174-179`），节流键是 `sessionId|ticketId`（`:139-148`），**跨 session 不去重**。三个 worker 在两分钟内先后结束，就是三次唤醒、三次 `ria_status`、三次 `ria_read`；而 Ria 在第一个 turn 里可能已经把工单收尾了，后面两个 turn 读到的是过期快照，容易做出「重复续派」。

**对方怎么做：** relay 在 turn 进行中到达时**合并到下一个 step 一次投递**（`src/app/notices.ts:121-129` 产出 relay，`src/app/sessions.ts:171` `enqueue('relay', requestId, ...)` 交给宿主 inbox）；候选卡也支持一次调用批量 route（`prompts/dispatch.md`："batch settled candidates in one call"）。

**差异：** Ria 是「一事件一唤醒」，对方是「一会话一合并」。

**改造代价：小。** 只动 `lib/worker-idle.mjs`：维护 `pending: Map<sessionId, {tickets, lastTurn}>`，2–5 秒窗口后合并成一条文本（每个 session 一段，带各自的 turn id/outcome），一次 `prompt`。`test/worker-idle.mjs` 加两个用例（同时 idle、窗口内单条）。

**破坏性风险：低。** 代价是延迟 2–5 秒；要防「合并后工单状态已变」，文本里保留每个工单的 `lastWorkerTurn` 与时间戳，让 Ria 自己能看出快照旧了（它本来就被要求 `ria_read` 复核，`index.js:1217`）。

---

## 5. 可借鉴但优先级低

| # | 点 | 为什么低 |
|---|---|---|
| 5.1 | `ticketStage()` 纯派生（`stage.ts:9-21`） | Ria 的 `waitingOn` 已经半派生，面板也已把 `blocked + waitingOn=user` 排最前（`lib/index.js:405-411`）。剩余价值只在「统一的 queued/idle/review 视图」，而 Ria 没有 assignment 概念，派生不出这些中间态。等真的要做总览页再说。 |
| 5.2 | prompt 版本化 + `base` 漂移提示（`prompts.ts:28-30`、`:174-189`） | 痛点真实（改 Ria 的 prompt 就是改 `index.js:1198-1237` 的字符串，无版本、无 diff、无回滚），但收益与成本不成比例：单人维护、测试已锁文案。可先做「prompt 变更记到 `docs/`」，把版本化的时机推到「多人协作或 A/B」出现时。 |
| 5.3 | host 级「不许等」护栏（`sessions.ts:77-86`） | Ria 已有明文禁令（`index.js:1216`："do not sleep, do not poll…"）。护栏能兜住模型失误，但会误伤真实的长命令场景，且需要在 Ria 侧装饰宿主工具（可行性已由同宿主的 prototype 证明，但未在 Ria 验证权限）。痛点弱 → 观察一段日志再说。 |
| 5.4 | 100 词硬上限 + 回复目的校验（`prompts/replies.md`、`main.ts:225`） | 微信侧已有「超过 800 字/含表格代码 → 转 .md 文件」的降级（`docs/DESIGN.md`），长回复的实际伤害已被处理；再叠一层硬上限容易把有用的结论截断。 |
| 5.5 | `Later`（延迟但不计失败，`effects.ts:5`、`:138-139`） | 它服务于「worker 槽位满」这类资源约束。Ria 没有槽位/排队概念，没有「稍后再试比失败更对」的场景，等 5.1 或并发控制落地后再引入。 |
| 5.6 | 恢复提示里「重复外部动作前先核对」 | Ria 的恢复指令已经说了「inspect the workspace, changed files, and tests before resuming, and not repeat finished work」（`index.js:1221`），只差「外部动作（push/评论/PR）」这个词。属于一句话的打磨，不单列成项。 |

---

## 6. 不建议借鉴

### 6.1 Thread / Subscription / Eval / Mandate 一整套多源准入

**它解决的是**：GitHub/Feishu 上别人说话，系统怎么判断「要不要开工、开哪张工单、后续消息归谁」。prototype 为此刻意引入 5 个实体和一条订阅链（`Address` 之外还有 Source/Trigger/Thread/Decision/Mandate，见 `docs/001-domain.md`），并接受「一条消息可能 fan-out 到多张工单」。

**为什么不适合 Ria：**
- Ria 的入口只有人（微信、Web、DSH 会话），**没有「判断要不要开工」这一步**——用户说要做就是要做，不确定就问。Eval 是为「外部噪声」存在的，Ria 没有噪声源。
- 与 Ria 的硬约束直接冲突：intake 要求「每条真实用户消息恰好被定性一次」（`lib/index.js:430-448`；`docs/DESIGN.md` 的四个强制点），而 fan-out 的语义是「一条消息进多张工单、每张工单的 worker 自己决定」，两者不能共存。
- 概念税过高：Ria 现在 `ticket` 一个实体就能解释「用户消息 → 一张工单 → 一个 executor」。引入订阅后，「这条消息为什么进了这张工单」变成要查 Thread 绑定，调试成本翻倍。

**结论：无对应痛点，且破坏模型。** 唯一值得带走的是它的**结论**：authorization（能不能干）与 context（消息给谁看）要分开——Ria 用 `ticket_executor_mismatch` 预检 + `grants` 的 worker 绑定已经在做同一件事。

### 6.2 一个工单多个 Assignment（换会话重试）

prototype 允许同一张工单有多段 assignment（重启后新 assignment 接着同一个目录/分支/PR 干，`docs/003-execution.md`）。Ria 的前提是「ticket 有且只有一个 executor」，预检里 `ticket_executor_mismatch` 就是在守这条（`lib/index.js:2269`），grant 也绑定到单个 worker。

**不建议**：这会同时打破工单-执行者绑定、grant 的恢复语义、以及「用户点名 worker」的选择逻辑。Ria 需要「换人重做」时，正确做法是关工单重开（新工单、新 executor），而不是在一张工单里换执行者。

### 6.3 SQLite 单库

prototype 用 SQLite 做事务与查询（`src/app/store.ts`）。Ria 是 JSON + 归档 `jsonl` + `writeAtomic`（fsync + rename，`lib/index.js:87-98`），单进程单写者。

**不建议**：迁移成本大（所有读写路径、归档、恢复），收益在当前工单量级（几十到几百张）下不成立；而且 Ria 的归档已经解决了「热文件变大」的问题。等真需要跨工单查询/统计时再考虑，届时也未必选 SQLite（DSH 宿主可能已有存储能力）。

### 6.4 一个工单一个目录 + prepare 命令 + worktree

prototype 给每张工单建目录、跑一次 prepare（典型是 git worktree，10 分钟超时，`docs/003-execution.md`）。Ria 是让 worker 在**自己的 cwd** 里干活（`ria_spawn` 的 `cwd`），目录由用户决定。

**不建议**：会与 `ria_spawn` 语义、workspace 预检（`workspace_missing`）、以及用户「在我的项目里干」的直觉冲突；worktree 本身在 DSH 侧已有能力，重复造会分裂事实源。

### 6.5 源适配器（GitHub/Feishu）与 React 面板

DSH 宿主已提供 UI 槽位与插件机制（Ria 的 `lib/client.js` 就是），prototype 的 `src/client/*.tsx` 是它自己的控制台；GitHub/Feishu 适配与 Ria 的微信桥在职责上**同类**（把外部消息变成 Ria 的 user message）。

**不建议**：无痛点。Ria 的桥已经跑通，再引入第二种源只会增加运维面（凭据、限流、分页、权限），而不是能力。

### 6.6 订阅 fan-out 且不校验发送者

prototype 的订阅刻意**不查 sender**（`prompts/subscriptions.md`："no mention/sender check"），因为 thread 上任何人说话都可能与工单相关，由 worker 自己判断相关性并 hand back。

**不建议**：Ria 没有 thread 概念，「这条消息属于哪张工单」是硬约束（`ria_request` 必须带 `ticketId`，`index.js:1214`）。照搬会让同一条消息出现在多张工单里，直接破坏「恰好一次定性」。

---

## 7. 无痛点需求（明确标注）

以下在 prototype 里成立、但对 Ria 只是「对方有」：

- 团队分节编辑 prompt（3 个 section + 团队 skills）：Ria 是单用户插件，prompt 由维护者改。
- 设置项收敛、策略版本 UI、变更历史（`src/app/settings-history.ts`）：Ria 只有 2 个设置（`dispatchGuard`、`progressCards`，`index.js:267`）。
- 面板统计（并行数、排队数、通过率）：Ria 没有排队概念，也没有「通过/拒绝」漏斗。
- 多语言（`src/client/locales.ts`）：Ria 的文案中英混排是刻意的（给模型看英文、给用户看中文）。
- 候选卡的 pending 过期（`prompts/dispatch.md`："undecided candidates expire"）：Ria 的 intake 有强制定性（`get_goal`/turn-stopping），不需要超时清理。

---

## 8. 整体判断

### 8.1 如果只做一件事

**做 4.1（出站副作用的落地投递）。** 三个理由：

1. 它是**正确性**问题，不是体验问题：状态已经落盘、用户却没收到通知，属于「系统说自己做了、用户不知道」，比任何界面细节都伤信任。
2. 它是**别的改进的底座**：4.2 的结构化问题要一路送到微信才有意义，4.3 合并后的通知更需要「至少送达一次」的保证。
3. 它与现有架构**同构**：Ria 的入站已经是「先写后做 + 启动重放」（`addDelivery`/`retryDeliveries`），出口照抄同一形态即可，不需要引入新概念。

### 8.2 Top 3

| 排序 | 事项 | 一句话理由 |
|---|---|---|
| 1 | 出站副作用落地投递（4.1） | 消灭「工单在跑、用户不知道」的三条静默丢失路径；不动机器，只补出口。 |
| 2 | 结构化 attention（4.2） | 让「等你」变成「等你回答这个」，微信/面板/下一轮 turn 都能直接用；不动状态机。 |
| 3 | `[Worker idle]` 合并投递（4.3） | 成本最低（一个文件），直接减少无效唤醒与过期快照误判。 |

排序依据是「可靠性 > 可行动性 > 效率」：1 决定用户是否被告知，2 决定被告知后能否行动，3 决定 Ria 自己少做无用功。

---

## 附录 A：本文引用到的行号速查

prototype：

- `src/core/engine.ts:24` — `Engine` 唯一写者
- `src/core/stage.ts:9-21` — `ticketStage()` 首行匹配表
- `src/core/model.ts:275` — `Attention { id, question, triggerId }`
- `src/app/cards.ts:20-25` / `:31` — 卡片状态派生 / attention 展示
- `src/app/notices.ts:121-129` — `reportRelay()`，progress 不外发
- `src/app/effects.ts:109-113` / `:130-146` / `:5` — 有序队列 / 退避与 `Later` / `Later` 定义
- `src/app/outbox.ts:24` — 回复 effect 的 pause 与顺序
- `src/app/sessions.ts:77-86` — 主会话 no-wait 装饰；`:171` — relay 入队
- `src/app/prompts.ts:28-30` / `:174-189` — override `base` / `DefaultChange`
- `src/executor/dsh.ts:194` — `maxWorkers + 1` 的人工槽
- `src/app/views/overview.ts:73` — 面板「在等人」分组

Ria：

- `lib/index.js:87-98` — `writeAtomic`（fsync + rename）
- `lib/index.js:405-411` — 面板排序（blocked/user 优先）
- `lib/index.js:430-448` — `resolveIntake` 恰好一次定性
- `lib/index.js:753` — `transitionTicket`
- `lib/index.js:897-923` — `addFeedback`（独立 save、无投递状态）
- `lib/index.js:1198-1237` — `managerPrompt`；`:1216` 禁 sleep/poll；`:1221` 恢复指令
- `lib/index.js:1694-1700` — 单段 system prompt 注册
- `lib/index.js:2285-2288` — 入站「先写后做」
- `lib/index.js:2334-2339` — 无 turn 则派发说明丢失
- `lib/index.js:2353-2363` — 微信镜像 fire-and-forget
- `lib/index.js:2570-2595` — recovery 三次独立写
- `lib/tickets.mjs:96` / `:255-280` — `waitingOn` 默认值与每状态允许集
- `lib/worker-idle.mjs:130-179` — idle 通知；`:139-148` 节流键

## 附录 B：未核验事项

- prototype 的测试（`tests/core-engine`、`runtime`）未运行，本文对其行为的描述来自源码与 docs。
- 「Ria 能否装饰宿主的 `bash`/`job_output` 工具」只有 prototype 的同宿主先例（`sessions.ts:77-86`），未在 Ria 的 `ctx` 上验证。
- 4.1 的重试上限、4.3 的合并窗口时长没有实测数据，落地时以日志为准。
