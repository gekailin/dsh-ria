# Ticket 核心设定

本文定义 `dsh-ria` 中 Ticket（工单）的核心定位、状态机、路由与结算约束。所有相关实现须以本文、根目录 [DESIGN.md](../../DESIGN.md) 及 [executor.md](executor.md) 为准。

## 1. 定位与轻量化原则

- **最小持久任务单元**：Ticket 是用户交代的需要跟进、执行或交付产物的持久工作单元；简单问答直接回复，不建工单。
- **1 Ticket = 1 WorkOrder（不做工单内 `queue`）**：
  - 保持 Ticket 轻量，不在单张工单内部维护多阶段 `queue` 队列。
  - 运行中需要调整方向或补充约束，走原生 `steer`；属于下一阶段的新任务，新建 Ticket（必要时用依赖串联）。
- **Chat 交互边界（任务面只碰 Ticket）**：
  - 有工单的任务，`ticketId` 是 Chat 唯一的交互句柄：查进度/读结果只走 `ria_chat_status(ticketId)`，改方向/恢复/强停只走 `ria_chat_steer` / `ria_chat_resume` / `ria_chat_stop_ticket`，不越级读写目标 Executor 会话。
  - Chat 仅在资源配置面（协管管理、模型/权限/会话配置）和无工单直转面才直接引用会话/Executor。
- **靠机制不靠看门狗**：工单的「有始有终」完全依靠事件驱动、状态机约束与启动检查保证，禁止新增定时轮询或扫表兜底。

## 2. 状态机与流转

- **核心状态**：
  - 活跃：`open`（待规划/待派发）、`working`（执行中）、`blocked`（阻塞，须明确 `waitingOn`：`user` / `approval` / `environment` / `executor`）。
  - 终态：`done`（完成）、`failed`（失败）、`cancelled`（取消）。
- **有始有终**：
  - `done` 必须有结果摘要与证据；`failed` 必须有失败原因；`cancelled` 必须有取消原因；`blocked` 必须说明在等谁、等什么。
  - 用户手动终止或异常强制终止的任务，不得擅自重派，须请示用户。

## 3. 路由与 Executor 绑定

- **显式指定优先且不静默改派**：指定了 `executorId` / `executorSeq` 的工单，若目标不可用（忙碌/归档/失效），直接停在 `blocked(waitingOn=user)` 交由用户决策，绝不自动换人。
- **软亲和打分，不设硬标签门槛**：
  - `routing.tags`（含用户 `preferredTags` 与 Advisor 产出的领域标签）仅用于候选 Executor 的亲和打分排序（显式 `tags` > `recentTopics` > `autoTags` > 最近活跃）。
  - **不使用 `requireTagMatch` 硬过滤**，避免因标签词不完全重合而拒掉同项目空闲 Executor、反复新建僵尸直管。
- **直管新建保底**：自动路由因无可用空闲 Executor 而新建常规直管时，须将工单/项目/主题的核心标签写入该直管的初始 `tags`（非空）。

## 4. 事件驱动结算与重启恢复

- **Report 只记录、不结算**：`ria_executor_report` 仅写入结构化进展/结论/阻塞证据，不直接驱动工单终态流转。
- **统一按生命周期事件结算**：
  - 正常结束以 `turn/end` 为结算时机：已有终态 report 则采用 report；未调 report（含协管无 report 工具）则以该 turn 的最终回复内容兜底结算 `done`。
  - 遇到提问（`ask`）、权限审批、错误中断（含 413 等超长错误）立即按事件流转并汇报，不得静默卡死。
- **重启恢复**：
  - 启动检查将重启前仍为 `working` 的工单置为 `blocked(waitingOn=environment, reason=interrupted)`，并**自动 `resume` 一次（严格限一次，计数先落盘防死循环）**；Chat 不重复处理。

## 5. 结论存储与通知读路径

- **完整结论落盘在 Ticket**：无论直管还是协管，有工单任务的完整报告均写入工单记录。
- **通知轻量化**：工单状态变更发给 Chat/Claw 时仅发状态摘要（`🔔` 前缀），不把长正文塞进通知；Chat 收到有 `ticketId` 的通知后从工单读取完整结论汇报，不去翻目标会话记录。

## 6. 并发与临界隔离

采用两层串行锁分工 + 单向嵌套，杜绝死锁与跨工单串台：

- **Executor 锁（主锁，`executorLock(executorId)`）**：
  - 串行保护同一 Executor 的 `dispatch / steer / settle(turn/end) / stop(cancel)`。
  - `turn/end` 到达时**同步**排队入锁，保证迟到的 `steer` 与后续新工单的 `dispatch` 均在结算完成后执行。
  - `settle` 拿锁后检查 `agent.inbox`：仅当存在 `ria_steer_` 前缀待消费消息时暂缓结算；否则同步原子迁移工单状态并释放 Executor。
- **Ticket 锁（辅锁，`ticketLock(ticketId)`）**：
  - 串行保护尚未绑定 Executor 或跨异步边界改变工单状态的入口（`plan / resume / stop`），防止并发 `resume` 重复派发两个 Executor 或 `plan` 中途被 `stop` 后误派发。
- **单向嵌套（防死锁）**：
  - 永远只允许 `ticketLock(T)` → `executorLock(E)`，绝不允许反向；`settle` 只持有 `executorLock(E)` 并通过同步原子的 `transitionTicket()` 迁移状态。
