# Ria ticket 排队 / 依赖机制设计

- 状态：P0 已按本文实现（见 DESIGN.md §4.2 与 Phase 27）；P1 项（onDependencyFailure、fan-out join 自动策略、批量派发等）仍未实现
- 日期：2026-11-12
- 范围：ticket 之间的先后顺序、跨 executor 链、fan-out 汇聚、失败/取消传播、重启恢复与可见性
- 关系：本文是 docs/task-model-design.md（T1–T28、10 条不变量）的增量设计，不另起一套任务模型；新增部分统一编号为 T29 起
- 约束：只写方案，不改 lib/，不改 test/，不重启 dsh web，不同步安装副本，不 push

## 0. 结论先行

1. **采用方案 A：在 ticket 上加依赖，形成 ticket 级 DAG。** 复用已有的 dependsOn 字段，新增 waitingOn='dependency'，不引入 plan/queue 实体，不引入第二个调度器。
2. **派发仍然只由 Ria 通过 ria_request 触发。** Host 只做三件事：计算 ticket 是否 ready、把 ready/异常写成持久信号、在重启时对账。Host 不直接给 worker 发消息，不替 Ria 选 executor。
3. **P0 覆盖顺序链（A→B→C）和跨 executor 链。** P1 再补 fan-out 后汇聚、条件分支、批量派发和 GUI 队列视图。
4. **失败默认「保持排队并叫醒 Ria」，不自动跳过、不自动改派。** 条件分支的 skip/continue/block 放到 P1，用显式策略表达。
5. **用户取消整条链时，默认级联取消下游尚在排队/阻塞的 ticket；已经在跑的下游不假装取消，单独报告给用户。**
6. **不新增 queued 状态。** 用 open + waitingOn=dependency 表示「已定性，但还轮不到」，避免把 8 个状态扩成 9 个、把现有过滤和恢复路径全部改一遍。

一句话版本：**A 完成后由 host 把 B 从「等依赖」改成「等 Ria」，并发一条可重试的唤醒信号；Ria 醒来后照旧走预检和 ria_request。依赖关系只决定「什么时候可以开始」，不把消息直接塞给 worker。**

---

## 1. 缺口与真实场景

### 1.1 先核对现状（以当前代码为准）

| 事实 | 位置 | 对排队机制的含义 |
|---|---|---|
| dependsOn 字段已经在 schema 里，归一化时保留，addTicket 也会写入 | lib/tickets.mjs:131、lib/index.js:750 | 这不是全新字段，但它目前只是「被保存」，没有 API、没有校验、没有调度 |
| ria_ticket 的参数表没有 dependsOn | lib/index.js:1612-1647 | Ria 现在无法通过工具表达 A→B |
| open 状态强制 waitingOn='ria' | lib/tickets.mjs:314-317 | 要支持「排队中」，必须放宽这条不变量，新增 dependency 等待值 |
| waitingOn 枚举没有 dependency | lib/tickets.mjs:27 | 需要新增，且只允许出现在 open |
| worker idle 只通知「有 working ticket 的 executor」 | lib/worker-idle.mjs:130-135 | A 完成后，若 B 还没 working，B 不会自己触发 idle 通知；必须有 host 侧解锁/唤醒 |
| 启动恢复把 open 当作待处理单元 | lib/index.js:3225-3243 | 重启后 B 会被当成普通 open 票提示 Ria，可能被提前派发；P0 必须把「排队中」从恢复单元里排除 |
| ria_request 成功一次后立即 concludeTurn() | lib/index.js:2668-2675 | 同一 turn 内连续派发 A、B 并不可靠；fan-out/批量派发需要 P1 单独设计 |
| source 被 merge 后以 done + resolution.kind='merged' 收敛 | lib/index.js:702-712 | 不能把「merged done」当成「工作完成」去解锁下游；merge 必须先把依赖边转移到 target |
| outbox 已有持久化、去重、6 次重试和 30 秒 tick | lib/outbox.mjs:11-17、lib/outbox.mjs:124-149 | 唤醒信号可以复用它，不需要新造一个持久队列 |
| ria_resolve kind=split 目前返回 not_supported | lib/index.js:592-594 | P0 不能靠 fork 父容器表达顺序链；需要允许跨 root 的 ticket 依赖 |

结论：**现状不是「有排队但不够强」，而是「关系字段存在、语义和驱动都不存在」。** 这反而有利于增量实现：不需要改数据模型的主干，只需要把 dependsOn 激活，并补上「ready 计算 + 唤醒 + 恢复」。

### 1.2 用户说「做完 xxx，做 yyy」时，实际包含四类问题

| 类型 | 例子 | 现在的真实表现 | 跨 turn / 重启 |
|---|---|---|---|
| 顺序链 | 「先改完后端，再跑前端构建」 | Ria 可以自己记住，但没有字段约束；A 未结束时也可能先派 B | 上下文一滑走或重启，顺序就断 |
| 跨 executor 链 | 「A 交给 worker1，B 交给 worker2，A 完再做 B」 | Ria 只能在 A 的 idle 通知后凭记忆派 B；B 可能被提前派发 | 重启后 B 是普通 open 票，恢复提示可能让它先跑 |
| fan-out 后汇聚 | 「A、B 并行，两个都完成再做 C」 | 可以建三个 ticket，但没有「都完成」这个条件；C 无法自动等 two-of-two | 无持久汇聚点 |
| 条件分支 | 「A 成功才做 B，失败就跳过」 | 只能靠 Ria 在 A 结束后自行判断 | 失败结果和分支决策都不在 ticket 状态里 |

### 1.3 哪些现在靠 Ria 自律其实能做

- 同一 turn 内，Ria 先派 A，等 A 的 [Worker idle] 通知后再派 B：只要 Ria 上下文还在、没有重启，通常能完成。
- A 和 B 都派给同一个 worker：如果 Ria 在同一个 turn 或紧邻 turn 把两条消息都投进这个 worker 的队列，worker 自己的 FIFO 队列会形成「先 A 后 B」的效果。但这是 **worker 消息队列的顺序**，不是 ticket 语义：A 的 turn 结束不等于 A 被验收，B 可能在 A 没有真正完成时就开始。
- Ria 在每次 ria_status 里看到 B 还 open，凭 prompt 规则提醒自己不要提前派。

### 1.4 哪些现在做不到

- **跨 executor 的可靠顺序**：A 在 worker1，B 在 worker2；A 结束后只有 worker1 的 idle 通知，B 不会自动被唤醒。
- **重启后的顺序**：B 是普通 open 票，启动恢复会把它列为「未收敛，请处理」，Ria 可能在不知道 A 还没完成的情况下派 B。
- **fan-out 汇聚**：没有「所有依赖都 done」这个可计算条件；父 ticket 的 children 聚合只适用于 forked 容器，而且当前 split 未开放。
- **失败/取消传播**：A 失败后 B 仍是 open；用户取消 A 后 B 仍可能被派发。
- **可见性**：ria_status 只能看到一堆 open 票，看不出「B 在等 A」，也看不出「A 失败导致 B 不能开始」。
- **幂等**：重启、重复 idle 通知、重复唤醒都可能让 Ria 对同一张票再次派发；当前没有 ready token。

### 1.5 为什么不能只靠 prompt（方案 D）

纯 prompt 的优点是零代码，缺点是它没有把「顺序」变成事实：

- 顺序只存在 Ria 的上下文里；turn 结束、上下文压缩、进程重启都会丢。
- 没有可查询的「B 在等 A」；用户问「为什么还没开始」时只能靠 Ria 回忆。
- 没有强制门禁：Ria 只要一次判断失误，B 就会被提前派发；事后只能靠用户发现。
- 没有幂等键：重复唤醒无法区分「同一个 ready 事件」与「新的派发机会」。

所以 D 只能作为回退，不作为方案。

---

## 2. 候选方案与对比

### 2.1 方案 A：ticket 级 DAG + waitingOn='dependency'

做法：

- 在 ticket 上加 dependsOn: string[]，边表示「B 必须等 A 进入 done 才能开始」。
- open 票有两种等待：waitingOn='ria'（就绪，等 Ria 派发）和 waitingOn='dependency'（还没轮到）。
- Host 在 A 变为终态时重算所有依赖 A 的票；全部依赖 done 时，把 B 从 dependency 改为 ria，并写入 ready 信号。
- Ria 被唤醒后，仍然调用 ria_request；预检、note、卡片、微信、recentWorkers 全部复用。
- Host 不直接向 worker 发消息，不替 Ria 选 executor。

### 2.2 方案 B：独立 plan/queue 实体

做法：新增 plans[]，每个 plan 有序或 DAG 的 step 列表，step 引用 ticketId + executor；由 plan runner 逐步解锁，甚至直接派发。

问题：

- plan 和 ticket 两套生命周期；merge、归档、reopen、恢复都要双写。
- 如果 runner 直接派发，就绕过 ria_request 的预检、note、审批、recentWorkers，形成第二套调度器。
- 如果 runner 只解锁、仍让 Ria 派发，那它本质上还是 A 的依赖图，只是多了一层容易失配的索引。
- 适合「用户明确要一个多步骤计划」的展示层，不适合作为 P0 的唯一事实来源。

### 2.3 方案 C：复用 forked 父容器 + children，按顺序解锁子票

做法：父 ticket forked/executor=null，子 ticket 各自 executor；父按 dependsOn 串行解锁子票。

问题：

- 当前 split 未开放，父/子工具面也不完整；P0 就要先补 fork，成本高于 A。
- 父的聚合语义是「所有子票收敛后父收敛」，不是「按顺序启动」；串行还要再实现一遍依赖。
- 父最多 2–8 个子、深度最多 2；跨 root 的临时顺序链不适用。
- 父容器是「一个目标拆成几件事」的心智，不是「队列」的心智；用户说「A 完再做 B」时不一定想把它们塞进一个父票。
- 结论：C 可以作为 P1 的「计划视图/容器」，但不建议作为底层机制；底层仍然需要 A 的依赖边。

### 2.4 方案 D：纯 prompt 自律，零代码

见 1.5。适合演示和极短链，不满足重启、可见性和强制门禁。

### 2.5 对比表

| 维度 | A：ticket DAG | B：plan/queue 实体 | C：forked 父容器 | D：纯 prompt |
|---|---|---|---|---|
| 与「一票一 executor」 | 不冲突；边在票之间，票仍只有一个 executor | 不冲突，但 plan/step 需要额外 executor 校验 | 不冲突；父无 executor，子各自一个 | 不冲突，但没有约束 |
| 与 ria_request 预检 | 完全复用 | runner 若直接派发会绕过；若让 Ria 派发则仍复用 | 子票派发可复用；父解锁逻辑另写 | 复用，但无门禁 |
| 与归档 | 依赖求值要能查 hot + tasks.log.jsonl | plan step 引用归档票要额外处理 | 父子归档都要处理 | 不处理 |
| 与 merge | 需要把 source 的入边转移到 target，source 的 merged done 不能解锁下游 | step 指向 source 会失效，需要重写 plan | 子票 merge 后父聚合要重算 | 不处理 |
| 重启后恢复 | 从 ria.json + 归档重算即可 | 需要恢复 plan 状态 + ticket 状态，双阶段 | 父聚合可恢复，但没有顺序状态 | 丢上下文就断 |
| 用户可见性 | 每张票可显示「等 A」；状态自然 | plan 视图最直观，但票视图仍要重复 | 树形直观，但只适用于父子 | 基本不可见 |
| 失败/取消传播 | 可逐票处理，可级联取消下游 | runner 可统一处理，但规则容易和 ticket 状态不一致 | 父聚合有 blocked>failed>cancelled>done，但不是顺序语义 | 靠 Ria 记忆 |
| 实现成本 | 中（P0 约 3 个模块 + 2 个 suite） | 高（新实体、新 runner、新迁移、新 UI） | 中高（先补 fork，再做串行） | 零 |
| 是否引入第二调度器 | 否，host 只解锁和唤醒 | 很容易；即使只解锁也多一层状态机 | 父解锁可能变成第二个调度器 | 否 |
| 适用阶段 | **P0 推荐** | P1/P2 的计划视图，可选 | P1 的容器视图，可选 | 回退 |

**推荐 A 的核心理由：**

1. 它把「顺序」放在 ticket 上，和现有「一票一 executor、预检、note、审批、归档、恢复」同构，不需要第二套生命周期。
2. 它不引入第二个调度器：host 只根据依赖算 ready，真正的派发动作仍然只有一个入口——Ria 的 ria_request。
3. 它支持跨 executor 链，而且不要求先实现 split/fork。
4. 它可以用最小状态变化表达：不新增状态，只新增一个 waitingOn 值和几个可重算字段。
5. 它的失败/取消语义可以逐票解释，不会出现「plan 说跳过、ticket 还在 working」的双重真相。

---

## 3. 推荐方案：A + host 计算 ready + 持久唤醒

### 3.1 角色边界

| 角色 | 负责 | 不负责 |
|---|---|---|
| Ria | 建票、加依赖、读 A 的结果、决定 B 是否仍要做、调用 ria_request、向用户解释 | 不轮询、不直接改依赖状态、不在失败时自动改派 |
| Host（RiaService） | 校验依赖图、在 A 终态时重算 B、把 B 改为 ready、写持久唤醒、启动对账、在 ria_status 中展示 | 不选 executor、不直接给 worker 发消息、不替 Ria 决定 skip/continue |
| Worker | 执行被派发的消息 | 不知道 ticket 依赖，不参与调度 |

### 3.2 端到端流程（顺序链 A→B）

1. 用户说「A 做完再做 B，A 给 worker1，B 给 worker2」。
2. Ria 把用户消息的 intake 定性为 A（ria_resolve kind=work，executor=worker1）。
3. Ria 用 ria_ticket 创建 B：executor=worker2，dependsOn=[A]。B 进入 open + waitingOn='dependency'。
4. Ria 派发 A。A 进入 working，B 保持排队。
5. A 的 worker idle 通知 Ria；Ria 读结果，确认后把 A 标为 done。
6. transitionTicket(A, done) 在同一事务边界内（保存后）触发依赖重算：
   - B 的所有依赖都已 done；
   - B 从 open/dependency 改为 open/ria；
   - 写 readyAt，生成 queueToken；
   - 往 outbox 入队一条 queue_wake。
7. Outbox 在 Ria 没有 turn 时用 sessionController.prompt 唤醒 Ria；Ria 读到 [Queue ready]，读 A 的结果，然后 ria_request B（带 queueToken）。
8. B 进入 working；A 的依赖边保留为历史，不再参与门禁。

### 3.3 如果 A 失败/取消

P0 的默认策略是 **hold（保持排队）+ 叫醒 Ria**：

- B 仍然是 open + waitingOn='dependency'，不会派发。
- 系统在 B 上写 dependencyAlerts，记录「A 已 failed/cancelled」。
- 系统给 Ria 发一条 [Queue blocked]，说明 B 在等 A，但 A 已经失败；请 Ria 向用户报告并询问：重试 A、跳过 B、取消整条链，还是改需求。
- 如果 A 后来被 reopen 并最终 done，重算会把 B 变为 ready；如果 A 仍然失败，B 继续等待。
- 不自动把 B 标成 failed，因为「A 失败」不等于「B 的执行失败」；也不自动 cancelled，因为用户可能想修 A。

P1 再增加显式策略：onDependencyFailure: 'hold' | 'skip' | 'continue' | 'block'。默认仍是 hold，避免行为突变。

### 3.4 派发由谁触发：仍然是 Ria

不建议 host 直接派发，理由：

- 会绕过 ria_request 的预检：session_missing、not_top_level、session_archived、workspace_missing、ticket_executor_mismatch。
- 会绕过 note 卡片和微信镜像；用户看不到「谁接到了什么」。
- 会绕过 recentWorkers、审批观察和现有幂等 delivery。
- 会让 host 同时拥有「调度」和「执行」两种职责，后续失败恢复会出现两个真相。

所以：**Host 只把「B 已经 ready」变成一条持久消息；派发动作仍然是 Ria 的一次工具调用。**

### 3.5 唤醒机制选型

| 机制 | 能解决 | 不能解决 | 结论 |
|---|---|---|---|
| worker idle 通知 | A 结束时唤醒 Ria | B 不是 working，不会触发；Ria 自己把 A 标 done 时也没有 A 的 idle | 只作为 A 结束的现有入口，不作为 B 的唤醒机制 |
| 启动扫描 | 重启后恢复 ready | 运行中 Ria 不在跑时不会触发 | 必须做，但不够 |
| outbox 持久信号 | 无 turn、崩溃、重试、去重 | 需要新增一种 entry kind；需要和现有 pump 合并 | **主机制** |
| 定时轮询 | 理论上能发现 ready | 引入轮询和额外 turn；与「ria_status 不等待」原则冲突 | 不做 |

推荐组合：

1. **outbox 的 queue_wake 是主路径**：A 终态触发时入队；Ria 没有 turn 时由 pump 启动一个 turn。
2. **startup reconcile 是兜底**：重启后重新计算所有依赖，补发未送达的 wake。
3. **turn/end 后再泵一次**：Ria 当前 turn 结束时，如果还有 ready 票，保证下一次唤醒不被漏掉。
4. **idle 通知不承担 B 的唤醒**：它仍然负责「A 的 worker 结束了，Ria 去读结果」。

### 3.6 ready 但没有 Ria 在跑时怎么保证派出去

分三层保证：

1. **持久化**：queue_wake 写入 outbox 文件（原子写、重试、6 次退避），不是内存事件。
2. **可启动**：pump 发现 Ria 没有活跃 turn 时，调用 ensureRia() 后 sessionController.prompt({mode:'queue'})；这和 worker-idle 当前唤醒 Ria 的方式一致。
3. **可对账**：每次启动扫描所有非终态票，重新计算 ready；对「ready 但仍未 working」的票补一条新的 wake。即使上一次 wake 已投递但 Ria 在派发前崩溃，重启也会再次提醒。

### 3.7 唤醒消息长什么样

一条唤醒可以合并多张 ready 票：

~~~text
[Queue ready]
以下 ticket 的依赖已完成，可以派发：
- ticket_b | goal=... | executor=session-w2 | queueToken=ticket_b:176...:7 | 依赖: ticket_a(done)
- ticket_c | goal=... | executor=session-w3 | queueToken=ticket_c:176...:3 | 依赖: ticket_a(done), ticket_b(done)
请先读依赖票的结果，确认目标仍然成立，再用 ria_request 派发；每张票只能派发一次。
~~~

失败提醒：

~~~text
[Queue blocked]
ticket_b 仍在等 ticket_a，但 ticket_a 已 failed。
不要派发 ticket_b。请向用户报告失败原因，并询问：重试 ticket_a、跳过 ticket_b、取消整条链，还是修改需求。
~~~

---

## 4. 数据与状态机增补

### 4.1 schemaVersion 3

建议把 ria.json 的 schemaVersion 从 2 升到 3：

- v2 已经持久化 dependsOn，但从未被工具写入，也从未被语义使用；v3 明确它的语义和校验。
- 新字段都是可选的、可重算的；读取 v2 时不丢数据，首次保存写 v3。
- 仍然接受 schemaVersion: 2 或 version: 2 的文件；迁移函数只做归一化和字段补全，不做破坏性改写。
- 归档日志 tasks.log.jsonl 的 schema:1 不变；归档 ticket 快照里如果有 dependsOn，按同样规则读取。

### 4.2 ticket 字段

~~~json
{
  "ticketId": "ticket_b",
  "status": "open",
  "waitingOn": "dependency",
  "executor": "session-w2",
  "dependsOn": ["ticket_a"],
  "readyAt": null,
  "readyNotifiedAt": null,
  "dependencyAlerts": [
    {
      "ticketId": "ticket_a",
      "status": "failed",
      "code": "dependency_failed",
      "at": 1760000000000
    }
  ]
}
~~~

| 字段 | 类型 | 说明 |
|---|---|---|
| dependsOn | string[] | 已有的字段；依赖票 id，去重、最多 8 个、不能自指、不能成环 |
| readyAt | number 或 null | 最近一次变为「所有依赖都 done」的时间；用于展示和 wake 去重 |
| readyNotifiedAt | number 或 null | 最近一次成功把 ready 通知交给 Ria 的时间；只用于观测/诊断 |
| dependencyAlerts | array | 依赖票已 failed/cancelled 时的结构化提示；不等于 ticket 自身 failed |
| queueToken | string（计算值） | ticketId + ':' + readyAt + ':' + revision；不入库，用于 ria_request 防重复派发 |
| onDependencyFailure | P1，枚举 | hold（默认）/ skip / continue / block；P0 不实现，不写字段 |

不新增 status='queued'。status 仍表示生命周期位置；waitingOn 表示「在等谁」。这样：

- 现有 TICKET_STATUSES、ACTIVE_STATUSES、归档、恢复、客户端过滤不需要增加分支。
- 只需要把 open 的等待值从「只能是 ria」放宽为「ria 或 dependency」。
- 用户看到的「排队中」是 open/dependency，不是新状态。

### 4.3 状态与等待值

| 状态 | 合法 waitingOn | 含义 | 能否被 ria_request 派发 |
|---|---|---|---|
| intake | ria | 用户消息尚未定性 | 否 |
| open | ria | 已定性、所有依赖已 done，等 Ria 派发 | **是**（唯一可开始的状态） |
| open | dependency | 已定性，但仍有一个以上依赖未 done | 否 |
| working | worker（或短暂 ria） | 已投递，等 worker 或等 Ria 验收 | 否（continuation 另论） |
| blocked | user / approval / environment | 等外部输入 | 否 |
| forked | children | 父容器，等子票 | 否 |
| done / failed / cancelled | none | 终态 | 否 |

open + waitingOn='dependency' 必须同时满足：dependsOn.length > 0 且至少一个依赖不是 done。否则应归一化为 open + waitingOn='ria'，或者拒绝这次更新。

### 4.4 新增转移（T29 起）

现有 T1–T28 不变。新增部分：

| ID | From → To | 触发 | Actor | 守卫 / 副作用 |
|---|---|---|---|---|
| T29 | open/dependency → open/ria | 依赖票变为 done，重算后全部满足 | system | 设 readyAt=now；dependencyAlerts=[]；生成 queueToken；入队 queue_wake |
| T30 | open/ria → open/dependency | 上游被 reopen，重算后不再全部 done | system | 清 readyAt；作废未投递的 wake；不派发 |
| T31 | open/ria → open/dependency | Ria 新增/修改 dependsOn，且未全部满足 | Ria | 先校验无环；清 readyAt；已入队的 wake 在投递时检查票状态并跳过 |
| T32 | open/dependency → open/ria | Ria 移除依赖，或依赖被补齐 | Ria | 设 readyAt；可入队 wake；Ria 在同一 turn 内通常直接派发 |
| T33 | open/dependency → open/dependency | 依赖票变为 failed / cancelled | system | 不改 status；写 dependencyAlerts；入队 queue_blocked（P0 只提醒，不自动 skip） |
| T34 | open/ria → open/dependency | 依赖票从 done 被 reopen | system | 同 T30；如果 B 已经 working，不回溯，只记录历史 |
| T35 | 排队/阻塞中的下游 → cancelled | 用户/Ria 显式级联取消 | user/ria | 只取消 open、blocked、intake 的下游；working 下游不改状态，返回 deferred |
| T36 | open/dependency → cancelled | P1 onDependencyFailure='skip' | system | resolution.kind='dependency_skipped'；记录被跳过的上游 |
| T37 | open/dependency → blocked/user | P1 onDependencyFailure='block' | system | 写 blockedReason + attention；等用户决定 |

说明：

- T29 是系统自动转移，但 **不自动派发**；它只把票变成「等 Ria」。
- T30/T34 处理「上游回滚」：A 从 done 被 reopen 后，B 不能再保持 ready；如果 B 还没 working，必须退回 dependency。
- T33 不改变状态，避免「A 失败」自动把 B 判死；P0 的可见性靠 dependencyAlerts 和 queue_blocked 唤醒。
- T35 的 deferred 是诚实的：Ria 没有停止 worker turn 的能力，不能把一张 running 的票写成 cancelled。

### 4.5 不变量增补

在现有 10 条之外增加：

11. dependsOn 必须去重；不能包含自身；最多 8 个。
12. 依赖图必须无环。新增/修改依赖时，从被依赖票出发做 DFS；发现回到当前票即拒绝 dependency_cycle，不做部分写入。
13. 依赖票必须存在：优先查热存储，其次查 tasks.log.jsonl / 月日志；不存在返回 dependency_missing。不允许依赖 intake（它还没有稳定归宿）。
14. open + waitingOn='ria' 要求所有 dependsOn 都是 done；否则必须处于 open + waitingOn='dependency'。这条是「不能提前派发」的硬门禁。
15. open + waitingOn='dependency' 要求 dependsOn.length > 0 且至少一个依赖不是 done；否则归一化为 ready。
16. waitingOn='dependency' 只允许出现在 open；intake/forked/working/terminal 不允许。
17. readyAt 只在「所有依赖 done 且票尚未 working」时有意义；变为 dependency 时清空。
18. dependencyAlerts 只记录终态非 done 的依赖；依赖恢复为 done 或票进入终态时清空。
19. mergeTicket 必须先转移依赖边，再把 source 收敛为 done(merged)；任何「source 已 merged done」都不能被当作依赖满足。
20. 父票聚合规则不变：dependsOn 只作用于子票自身；父仍按 blocked > failed > cancelled > done 聚合。依赖失败导致的子票 alert 不会让父提前收敛。
21. 级联取消必须只沿 dependsOn 边和 childTicketIds 向下走，不允许向上取消依赖票；否则用户取消 B 会误杀 A。
22. expectedRevision 仍然有效；ria_request 的 queueToken 校验失败返回 ticket_not_ready，不得投递。

### 4.6 依赖边的增删规则

- **创建**：ria_ticket 创建时允许传 dependsOn；ria_resolve kind=work 也允许传，用于「这条 intake 本身就要等某张票」。
- **更新**：只允许在 open 状态改 dependsOn；working 之后不允许新增未满足依赖（否则会制造「已经跑了但还在等」的假状态）。blocked 票可以保留旧依赖，reopen 后重新计算。
- **删除**：Ria 可以删除依赖；删除后如果全部满足，转 ready。
- **上限**：单票 8 个依赖；超过时让 Ria 先拆成两段或问用户，不自动截断。
- **跨 root**：P0 建议默认允许。原因见 8.1 的第 1 条；rootTicketId 继续只表示 fork 血统，不作为依赖边界。

### 4.7 与 merge 的交互

merge 是依赖机制最容易出错的地方，必须按下面顺序：

1. 校验 source/target，保持现有 merge 的所有检查。
2. 找到所有 t.dependsOn.includes(sourceId) 的票，把 sourceId 替换为 targetId；去重；如果 target 已在数组里，只保留一个。
3. 如果 source 自己有 dependsOn，把它们并入 target：target 尚未 started 时作为新的门禁；target 已经 working 时只记录，不再回溯阻塞。
4. 重新校验整张图无环；任何一步失败都不写入，保持 merge 的「先校验后提交」。
5. 最后才把 source 转为 done + resolution.kind='merged'。

这样：

- B 原来等 A，A 被并入 A2 后，B 改为等 A2，不会因为 A 的 done(merged) 被提前解锁。
- 如果 B 自己并入 B2，B2 继承 B 的依赖；B 的旧边消失。
- 已 working 的 target 不会因为 merge 突然被依赖卡住；依赖只对「还没开始」的票有意义。

### 4.8 与归档的交互

- 依赖求值必须能读归档：A 已 done 且归档，B 仍应视为满足；A 已 failed/cancelled 且归档，B 应产生 alert。
- 依赖目标允许是归档终态；不允许是归档中的活跃票（归档只有终态，不存在这种情况）。
- reopen 归档 A 时先从日志捞回热存储，再触发依赖重算；B 如果还是 ready 未派发，退回 dependency。
- ria_status 的依赖摘要要标 archived:true，避免 Ria 以为还能直接 ria_request 一张已归档的依赖票。

---

## 5. 失败与取消语义

### 5.1 失败/取消矩阵（P0）

| 上游 A 的结局 | B 的 P0 行为 | 用户可见 | Ria 动作 |
|---|---|---|---|
| done | 重算依赖；全部 done 时 B 变 ready | [Queue ready] 卡片/消息 | 读 A 结果，派发 B |
| failed | B 保持 open/dependency，写 alert | B 显示「上游 A 失败，等待处理」；Ria 收到 [Queue blocked] | 向用户报告，询问重试/跳过/取消/改需求 |
| cancelled | 同 failed | 同 failed | 同上 |
| blocked | B 继续等；不产生 alert（A 还可能恢复） | B 显示「等 A（A 等用户）」 | 无需额外动作；A 解决后重算 |
| working | B 继续等 | B 显示「等 A（执行中）」 | 等 A 的 idle 通知 |
| done(merged) | 依赖边已在 merge 时转移，B 等 target | 显示 target | 不把 merged 当完成 |
| 重新 open | 若 B 未 working，退回 dependency；若已 working，不回溯 | B 从「就绪」变回「排队」 | 若 B 已派发，接受既成事实，不再重派 |

P0 不自动 skip、不自动 cancel、不自动 failed。原因：

- 「A 失败」与「B 失败」是两件事；自动把 B 判 failed 会污染验收记录。
- 用户可能想修 A 后继续 B；自动取消会丢掉这个意图。
- 自动 skip 需要用户明确说「失败就跳过」；这是 P1 的策略字段。

### 5.2 条件分支（P1）

P1 增加 onDependencyFailure，默认 hold：

| 值 | 行为 | 适用 |
|---|---|---|
| hold | 保持排队 + alert + 叫醒 Ria（P0 默认） | 大多数链 |
| skip | 下游转 cancelled，resolution.kind='dependency_skipped'，记录上游 id | 「A 成功才做 B，失败就不做」 |
| continue | 无视失败，转 ready | 「A 失败也要做 B（例如清理/回滚）」 |
| block | 下游转 blocked/waitingOn=user，带 attention | 必须用户拍板 |

策略是「边的策略」还是「票的策略」？建议放在 **下游票** 上（onDependencyFailure），因为同一张 B 可能被多条边指向，票级策略更容易解释；P1 如需更细，再增加 per-edge 配置。P0 不暴露该字段。

### 5.3 取消整条链

新增显式参数：

~~~text
ria_ticket({ ticketId: A, status: "cancelled", cascade: "downstream", reason: "用户取消整条链" })
~~~

语义：

1. 先取消 A（现有行为）。
2. 从 A 出发，沿 dependsOn 反向索引找到所有下游；同时沿 childTicketIds 递归。
3. 对每个下游：
   - open / blocked / intake：转 cancelled，resolution.kind='cascade_cancel'，记录 upstreamTicketId。
   - working：**不直接改状态**，加入返回的 deferred，说明「worker 还在跑，需要用户在 worker 会话里停止，或等它结束后由 Ria 取消」。
   - 已经终态：跳过。
4. 作废所有相关 ready 票的未投递 wake；已在 Ria 队列里的唤醒消息在投递时检查票状态，发现 cancelled 就跳过。
5. 返回 { ok, cancelled: [...], deferred: [...] }，让 Ria 能准确告诉用户哪些已经停、哪些还需要手动停。

为什么不把 running 下游直接标 cancelled：

- Ticket 是状态记录，不是杀进程的工具；标了 cancelled 但 worker 还在跑，会让用户以为已经停了。
- Ria 没有停止 worker turn 的正式 API；谎报取消比不取消更糟。
- P1 如要支持协作式取消，可以加 cancelRequestedAt，在 worker idle 时由 Ria 确认取消；P0 只做「排队中的下游」。

---

## 6. 重启恢复与幂等

### 6.1 启动时的顺序

1. 加载 ria.json，归一化为 v3；已有 dependsOn 逐条校验。
2. 归档裁剪、审批对账、workspace 对账（现有流程不变）。
3. reconcileDependencies()：遍历所有非终态票，解析依赖状态（热存储 + 归档）。
   - 全部 done 且 waitingOn=dependency → 转 open/ria，写 readyAt。
   - 未全部 done 且 waitingOn=ria → 转 open/dependency，清 readyAt。
   - 有终态非 done 依赖 → 写 dependencyAlerts。
   - 依赖缺失/非法 → 票标 blocked/waitingOn=user，blockedReason='依赖数据无效'，不静默丢边。
4. recoveryUnits() 调整：**不把 open/dependency 作为恢复单元**；它们只进入队列摘要，不进入「请逐条处理」的恢复 prompt。open/ria 仍是恢复单元（但 ready 的票可能已经由 queue wake 处理）。
5. 生成一条合并的启动消息：
   - 有 working/intake/open(ria) 时，沿用现有恢复 prompt；
   - 在其中追加「排队中（等依赖）」摘要，明确不要派发；
   - 如果没有恢复单元但有 ready 票，发一条 [Queue ready]；
   - 同一张票不要在恢复 prompt 和 queue wake 中出现两次。
6. 启动后 pump outbox，补发所有未送达的 queue_wake。

### 6.2 幂等键

| 场景 | 键 | 作用 |
|---|---|---|
| ready 唤醒 | queue_wake:ticketId:readyAt | 同一 readiness 只产生一条 wake；outbox 重试不重复 |
| 启动补发 | queue_wake:ticketId:readyAt:boot:bootId | 上一次已投递但 Ria 崩溃未派发时，重启可以再提醒一次；每个 boot 最多一条 |
| 派发 | queueToken = ticketId:readyAt:revision | Ria 带 token 调 ria_request；票已 working/cancelled/revision 变了就返回 ticket_not_ready，不投递 |
| 实际投递 | 现有 requestId + deliveries | 断线重试仍复用同一 requestId，不产生第二条用户消息 |
| 依赖重算 | 当前票的 revision + 依赖状态 | 重算只做「状态到状态」的合法转移；重复 done 不会重复触发 |

### 6.3 崩溃窗口

| 崩溃点 | 恢复 |
|---|---|
| A 已 done 保存，B 还没转 ready | 启动重算，B 转 ready 并补 wake |
| B 已 ready 保存，wake 未入队/未投递 | outbox pending 或启动补发 |
| wake 已投递，Ria 在派发前崩溃 | B 仍 open/ria；启动补发 boot wake；token 未使用 |
| B 已 working，Ria 崩溃 | B 是 working，启动恢复按现有逻辑读 worker，不重复派发 |
| 级联取消到一半崩溃 | 已取消的保持；启动重算不会把 cancelled 重新打开；剩余下游仍可再次取消 |

### 6.4 与 recovery 上限的关系

- recovery.count 只统计「启动时仍未收敛、需要 Ria 处理」的次数，不统计 queue wake。
- 一张票如果一直 ready 但 Ria 一直不派发，不应在 3 次后自动 blocked；这是「Ria 没执行」，不是「恢复失败」。ria_status 会显示 ready 和 readyNotifiedAt，由用户/Ria 处理。
- 如果 B 的依赖永远不满足，它也不会被 recovery 计数；它是排队，不是恢复候选。

---

## 7. 可视化

### 7.1 ria_status 的 ticket 摘要

在现有 ticketSummary 上增加：

~~~json
{
  "ticketId": "ticket_b",
  "status": "open",
  "waitingOn": "dependency",
  "executor": "session-w2",
  "dependsOn": ["ticket_a"],
  "queueState": "waiting_dependency",
  "queueText": "排队中：等 ticket_a（worker1）完成",
  "blockedBy": [
    {
      "ticketId": "ticket_a",
      "goal": "改完后端接口",
      "status": "working",
      "executor": "session-w1",
      "archived": false
    }
  ],
  "readyAt": null,
  "readyNotifiedAt": null,
  "dependencyAlerts": []
}
~~~

queueState 的取值：

| queueState | 条件 | 文案 |
|---|---|---|
| waiting_dependency | open + dependency，无失败依赖 | 「排队中：等 A 完成」 |
| ready | open + ria，所有依赖 done | 「已就绪，等 Ria 派发」 |
| dependency_alert | open + dependency，且存在 failed/cancelled 依赖 | 「上游 A 失败，等待处理」 |
| dispatched | working | 「已派发给 worker」 |
| blocked | blocked/其它 | 沿用现有 blocked 文案 |

### 7.2 ria_status 的队列概览

scope=tickets 增加：

~~~json
{
  "queue": {
    "waiting": 2,
    "ready": 1,
    "alerts": 1,
    "items": [
      {
        "ticketId": "ticket_b",
        "goal": "改前端",
        "executor": "session-w2",
        "queueState": "waiting_dependency",
        "dependsOn": ["ticket_a"],
        "queueText": "排队中：等 ticket_a 完成"
      }
    ]
  }
}
~~~

排序：ready 在前，其次 dependency_alert，其次 waiting；同组按 readyAt/updatedAt 倒序。queue 只包含非终态、且 dependsOn.length > 0 的票，避免把普通 open 票混进队列。

### 7.3 用户可见的 GUI

P0 不强制改客户端，先保证 ria_status 和 Ria 的回复能说清楚：

- Ria 在收到 [Queue ready] 后，用 note 告诉用户「A 已完成，现在把 B 交给 worker2」。
- Ria 在收到 [Queue blocked] 后，用 attention 卡片问用户「A 失败了，B 要跳过还是重试 A」。

P1 再做客户端队列视图：

- 复用现有 conversation.input.dock 插槽（当前用于欢迎卡片）增加一个只读 chip：排队 2 · 就绪 1。
- chip 展开显示 queue.items 的只读列表，每项显示 ticketId、goal 摘要、executor 标题、queueText。
- 不新增可拖拽排序、不新增 plan 编辑器；排序仍由依赖图决定。
- 如果后续做 forked 树，队列视图可以作为树的「等待边」图层，不重复做一套。

### 7.4 通知与卡片

| 事件 | 卡片/消息 | 是否发微信 |
|---|---|---|
| B 变为 ready | [Queue ready] 唤醒 + Ria 的派发 note | 派发 note 按现有白名单镜像；唤醒本身不发微信 |
| A 失败导致 B alert | [Queue blocked] 唤醒 + Ria 向用户提问的 attention 卡片 | 走现有 blocked/attention 镜像规则 |
| B 被级联取消 | 结果摘要，不单独发卡片 | 默认不发；用户主动取消时由 Ria 汇报 |
| 重启后 ready 补发 | 合并进启动恢复消息 | 不发 |

---

## 8. 待用户拍板

建议按下面 6 条拍板；每条都给了默认建议。

1. **跨 root 依赖是否默认允许？**
   - 建议：**允许**。一条用户消息只产生一个 root intake，ria_resolve 目前也只能定一张 work 票；如果强制「同树」，P0 的顺序链就必须先实现 fork/split，成本明显变大。
   - 若选「必须同树」：P0 需要额外的 plan 容器票，顺序链会被推迟到 P1。

2. **用 open + waitingOn='dependency'，还是新增 queued 状态？**
   - 建议：**复用 open**。状态表示生命周期，waitingOn 表示在等谁；新增状态会扩散到恢复、归档、客户端和所有状态过滤。
   - 若选 queued：需要同步改 8→9 状态、所有转移表、恢复单元和 UI。

3. **上游失败时，P0 默认是 hold、自动 block，还是自动 skip？**
   - 建议：**hold + 叫醒 Ria**。不替用户做「跳过/继续」的决定；P1 再加 onDependencyFailure 策略。
   - 若选自动 block：用户会在链中间看到大量 blocked 票；若选自动 skip：可能丢掉用户想修 A 后继续 B 的意图。

4. **派发是否仍只由 Ria 触发？**
   - 建议：**是**。Host 只解锁和唤醒；否则会绕过预检、note、审批和 recentWorkers。
   - 若希望 host 自动派发：需要把 ria_request 的预检、note、幂等和审批观察整体下沉，等于第二套调度器。

5. **唤醒用 outbox 持久信号，还是只靠 idle 通知？**
   - 建议：**outbox 为主 + startup 对账 + turn/end 补泵**。idle 只负责 A 结束，不负责 B 的唤醒。
   - 若只靠 idle：Ria 自己把 A 标 done、重启、或 B 不是 working 时都会漏。

6. **级联取消是否包含正在工作的下游？**
   - 建议：**P0 只取消排队/阻塞的下游，working 下游返回 deferred**，由用户在原 worker 会话停止或等结束后再取消。
   - 若要求立即取消：需要新增 worker 停止/协作取消机制，不能只改 ticket 状态。

补充默认（不单独占一条拍板）：**schemaVersion 升到 3，但兼容读 v2；P0 不暴露 onDependencyFailure，P1 再加。**

---

## 9. 分期与测试计划

### 9.1 P0：顺序链 + 跨 executor（最小可用）

范围：

1. schema v3、归一化、v2 兼容；dependsOn 校验（自指/重复/缺失/环/上限）。
2. ria_ticket 创建/更新支持 dependsOn；ria_resolve kind=work 支持 dependsOn。
3. open/dependency 的不变量和 T29–T34；ready 计算。
4. queue_wake / queue_blocked outbox entry；pump 时合并 ready 票；queueToken 校验。
5. 启动 reconcileDependencies；恢复单元排除 open/dependency；启动消息合并。
6. ria_status 的 queueState/blockedBy/queue 字段。
7. 级联取消（只取消队列中的下游，working 返回 deferred）。
8. merge 时的依赖边转移与 source merged 特判。
9. 文档与测试。

P0 明确不做：

- fan-out 后汇聚的「批量派发」体验（数据模型支持多依赖，但 Ria 一次 turn 只能可靠派一张票；见 9.3）。
- onDependencyFailure 的 skip/continue/block。
- 客户端队列 chip。
- forked 串行容器（C）。
- 自动重试失败的依赖。

P0 验收：

- A→B 跨两个 worker：A 完成前 B 一直显示排队，A done 后 B 变 ready 并只被派发一次。
- A failed：B 不派发，Ria 收到 blocked 提醒并能向用户解释。
- 重启：B 不会出现在「请逐条处理」的恢复列表里，也不会被提前派发。
- 同一 ready 事件重复唤醒不会产生第二次 B 的派发。
- A 被 reopen 时，B 若尚未 working 会退回排队。
- 取消 A 并选择 cascade 时，B 被取消；A 的依赖票不受影响。

### 9.2 P1：fan-out 汇聚、条件分支、批量派发、GUI

范围：

1. 多依赖 join：C dependsOn=[A,B]，全部 done 才 ready；任一 failed/cancelled 时按策略处理。
2. onDependencyFailure 的 hold/skip/continue/block。
3. 批量派发：解决 ria_request 一次成功即 concludeTurn 的限制。可选方案：
   - 新增 ria_request_batch，一次接收多个 {ticketId, targetSessionId, message, note}，全部预检通过后统一投递、只结束一次 turn；
   - 或给 ria_request 增加 tickets[]，但保持「每票一 executor」的校验。
   推荐前者，语义更清楚，且不改变现有单票调用。
4. 客户端 conversation.input.dock 队列 chip 和只读列表。
5. P1 的测试矩阵。

P1 不一定要做 plan 实体；如果用户需要「一个计划」的视图，可以在 ticket DAG 上做一个只读 plan 分组，不引入第二套状态机。

### 9.3 为什么 fan-out 要等到 P1

当前 toolRequest 在任意目标投递成功后立即 exec.concludeTurn()（lib/index.js:2668-2675）。这意味着 Ria 很难在同一个 turn 里可靠地派发 A 和 B；第二张票通常要等下一次唤醒。P0 的顺序链只需要「一次派一张」，正好避开这个限制；fan-out 需要批量派发或调整 turn 结束策略，放到 P1 更稳。

### 9.4 测试计划

新增 suite 建议：

- test/queue.mjs：依赖图、状态转移、merge、归档、status。
- test/queue-restart.mjs：启动重算、恢复单元排除、wake 补发、幂等。
- P1：test/queue-fanout.mjs、test/queue-policy.mjs。

P0 用例：

| ID | 场景 | 关键断言 |
|---|---|---|
| Q-01 | 创建 B dependsOn=[A] | B 是 open/dependency；不能 ria_request |
| Q-02 | A done | B 转 open/ria；readyAt 写入；只入队一次 wake |
| Q-03 | 重复 A done / 重复重算 | 不重复入队；B revision 只增加一次 |
| Q-04 | A failed | B 保持排队；dependencyAlerts 有 A；入队 blocked 提醒 |
| Q-05 | A cancelled | 同 failed |
| Q-06 | A blocked | B 保持排队；不产生 failed alert |
| Q-07 | 自指/重复/缺失/环/超过 8 个 | 拒绝且整次写入不生效；错误码稳定 |
| Q-08 | B 就绪时 Ria 没有 turn | outbox 启动 Ria；wake 带 queueToken |
| Q-09 | wake 重复投递 | Ria 侧只派发一次；第二次 token 校验失败或票已 working |
| Q-10 | 重启时 A working、B dependency | B 不进恢复 prompt；A 完成后 B ready |
| Q-11 | 重启时 B ready 且未派发 | 补发一次 boot wake；不重复建票 |
| Q-12 | A 已归档 done | B 可 ready；blockedBy 标 archived |
| Q-13 | A 从 done reopen | B 若未 working 退回 dependency；wake 作废 |
| Q-14 | merge source 有下游 | 下游边转移到 target；source 的 merged done 不解锁 |
| Q-15 | 级联取消 A | 下游 open/blocked 取消；working 返回 deferred；上游不受影响 |
| Q-16 | 跨 root 依赖 | 允许；状态和普通依赖一致 |
| Q-17 | 预检失败 | B 保持 ready，不投递；错误码沿用现有预检 |

P1 用例：

| ID | 场景 | 关键断言 |
|---|---|---|
| QF-01 | A、B 无依赖，C 依赖两者 | 两者都 done 才 ready |
| QF-02 | A done、B failed，C 默认 hold | C 不 ready；alert 指向 B |
| QF-03 | C onDependencyFailure='skip' | C cancelled，resolution=skipped |
| QF-04 | C onDependencyFailure='continue' | C ready 并派发 |
| QF-05 | C onDependencyFailure='block' | C blocked/user，attention 有 B |
| QF-06 | 批量派发 A、B | 一次 turn 内两个 delivery，都通过预检；只结束一次 turn |
| QF-07 | 8 个依赖 | 上限内可用；超过返回错误 |
| QF-08 | 队列 chip | 显示 waiting/ready/alerts，点击只读列表 |

### 9.5 实施顺序建议

1. 先做纯 store 层：字段、校验、T29–T34、merge/归档求值；用 test/queue.mjs 驱动。
2. 再做 ria_ticket 参数和 ria_status 输出；此时还没有唤醒，手工 ria_status 可验证状态。
3. 再做 outbox queue_wake 和 queueToken；用 fake Ria 验证「无 turn 也能启动」。
4. 再做 startup reconcile 和 recovery 排除；这是「重启不提前派发」的关键。
5. 最后做级联取消和文档收尾。
6. P1 再碰 fan-out、批量派发、客户端。

---

## 10. 与现有设计文档的衔接

- docs/task-model-design.md 的 T1–T28 仍然有效；本文新增 T29–T37，不重写旧转移。
- 旧设计的 §2.5 已经写了 dependsOn「只表达开始顺序，不表达数据依赖」，本文把它从「约定」变成「可校验、可恢复、可展示的事实」。
- 旧设计的 §3.4 写了 fork.mode='serial'，那是 P1 的容器视图；本文的 A 方案不依赖 fork，先解决跨 executor 的普通票链。
- 旧设计的 10 条不变量继续有效；本文增加第 11–22 条，编号接在后面。
- 本文不改变「一票一 executor」「ria_request 必填 ticketId/note」「预检失败不投递」「worker idle 只读观察」等现有约束。

---

## 11. 一句话给评审

如果只做一件事：**让 A 的 done 自动把 B 从「等依赖」改成「等 Ria」，并持久地叫醒 Ria；不要自动派发，也不要引入第二个队列。** 这样顺序链和跨 executor 链在 P0 就能可靠工作，fan-out 和条件分支可以在此之上逐步加。
