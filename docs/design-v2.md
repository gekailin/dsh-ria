# dsh-ria 整体设计 v2（草案）

> 目标设计，不替代根 DESIGN.md；DESIGN.md 的 5 条原则不变。对外仍是一个阿汐，内部拆成 Chatbot / Advisor / Router / Worker。

命名约定：角色名统一用 Chatbot、Advisor、Router、Worker；代码和 API 用 chatbot、advisor、router、worker；Session 只指执行容器。

## 1. 核心

阿汐不是某一个 session，而是这套系统对用户的统一人格：一个对外入口、一套决策体系、一个调度中枢、多个执行容器。

- **对话、决策、调度、执行分开。** Chatbot 说话，Advisor 想事，Router 管流程，Worker 干活。
- **ticket 是唯一耐久桥。** 需要跟踪的委托都落 ticket；聊天记录不能代替任务账本。
- **Ria 是代管者，不是所有者。** 用户保留最终决定权、叫停权；独立 worker 仍由用户直接指挥。
- **普通 worker 0 入侵。** 现有创建、派发、唤醒、审批、提示词和工具都不变；直管能力走独立分支。

## 2. 角色

| 角色 | 形态 | 职责 | 不做什么 |
|---|---|---|---|
| Chatbot | 单例顶层会话 | 对用户说话、打标、入口 Request、通知 | 不派发、不改 ticket 状态、不执行任务、不挂干活工具 |
| Advisor | Global 单例；Project 每项目一个 | 澄清、拆解、定验收、产出 WorkOrder（plan of record） | 不做长调查、不写代码、不做最终验证；不直接对用户说话、不直接发 worker、不写 ticket 状态 |
| Router | 确定性控制面，不是会话 | 事件、状态机、路由、租约、派发、审批、通知、审计、预算 | 不做对话、不用模型做决定 |
| Worker | 顶层会话 | 执行 ticket | 不做管理、不派 subagent |

- 对外只有一个阿汐；Chatbot 与 Global Advisor 各单例，Project Advisor 每项目一个，不引入第二个管理者。
- Chatbot 只负责对话、入口和通知：不执行任务，不挂 shell、文件写入、代码执行、worker 派发/管理等干活工具；需要跟踪的工作落 Request，交给 Advisor/Router/Worker。
- 每条真实用户消息都有归宿：被回答、变成 Request、并入已有工单、执行控制操作，或显式阻塞等用户；不静默丢消息。
- Advisor 暂不设 Task Advisor；Project Advisor 不绑 cwd，Global Advisor 不绑项目。
- **会话形态**：Chatbot 用 standard；Advisor（Global / Project）和直管 worker 用 PTC；Router 没有会话。独立 worker 不指定 preset，沿用 DSH 当前配置。PTC 只改变调用方式，不改变权限；Advisor 与直管 worker 各自注册 scoped 工具，均不继承 Ria 的 `ria_*` 管理工具。

> 项目级 Advisor 方案已被 [Sage（大脑）+ 无状态 Advisor 设计](sage-advisor-design.md) 取代（2026-11-19）；旧 [project-advisor-design.md](project-advisor-design.md) 仅作历史。本文角色表描述当前实现，目标形态以 Sage 设计为准。

### Advisor（参谋）的定位

> 旧称 Thinker（已改名 Advisor）。

Advisor 的产物只有两种：

1. **WorkOrder（plan of record）**：每个工单的必经方案，不是可选的建议。Router 只按 WorkOrder 派发；**没有 Advisor 的 WorkOrder，工单不得进入 working**。plan of record 的含义是：它就是这张票的既定方案，后续执行、纠偏和验收都以它为基准，Worker 不自行改方案。
2. **Answer（仅限短问答）**：只读、一次答复、不落 WorkOrder。适合“现在各角色的工具集差异是什么”这类当场可核实的短问题。

三条禁止：

- **不做长调查、不做多轮取证**：需要反复取证的工作写成 WorkOrder 交给 Worker。
- **不写代码、不改文件**：Advisor 没有 shell、write、edit；只读核对限于判定方案所需的最小范围。
- **不做最终验证**：测试、复跑和验收结论由 Worker 出，Advisor 不替 Worker 收尾。

长调查、复盘和验证都交给 Worker；Advisor 只负责“定方案”或“短答”。

## 3. 主链路

1. 用户对 Chatbot 说。
2. Chatbot 能当场答就答；需要跟踪的先持久化 Request，再回执。
3. Router 消费 Request，建 intake ticket，按项目、主题和能力路由给 Global / Project Advisor。
4. Advisor 澄清、拆解、定验收，产出 WorkOrder（plan of record，必经）；问题经 Chatbot 回用户，不直接找 worker。没有 WorkOrder 的工单不派发。
5. Advisor 请求派发；Router 校验权限、依赖、预算和会话，ensure session，选择独立或直管 worker。常规工单派 work Worker，复盘票（mode=reflection）派 reflection Worker。Router 是唯一派发入口。
6. Worker 执行；独立 worker 收普通消息，直管 worker 按固定契约；Router 监听事件，不轮询。
7. Worker 停下或报告；Router 更新 ticket；Chatbot 汇总给用户；需要拍板的事项进入“需要你”。
8. 完成、失败、取消都有结论；卡住必须写清在等谁、等什么。

## 4. 核心对象

| 对象 | 定义 |
|---|---|
| Request | 入口请求；Chatbot 先落盘再 ack，Router 消费；不是工单本身 |
| Ticket | 耐久任务；代码、API、schema 用 ticket，对用户说“任务”；可属于 Project，也可为 Global；intake 阶段归属可未定；一票一执行者；依赖是 DAG；唯一桥 |
| Topic | 工单分组；用于看板和路由亲和，不拥有 worker |
| WorkOrder | Advisor 的加工结果（plan of record，必经），挂在 ticket 上；不是独立跟踪实体 |
| Session | 顶层执行容器；一次一个 cwd；subagent 不能当 worker |
| Project | 可选归属：目标、范围、验收、项目记忆、Project Advisor、预算 |
| Workspace | 目录、仓库、工具、权限、密钥；与 Project 默认 1:1，可多对多 |

- ticket 生命周期：intake → open → working → blocked → done / failed / cancelled；forked 预留。终态必须有结论，卡住必须有 waitingOn 和原因。详细状态、命令、lease 和并发规则见 [ticket-flow.md](ticket-flow.md)。
- 短问答票：Chatbot 对当场可核实的短问题先回一句回执，再用 `chatbot_request` 的 `mode:'answer'` 建票；Advisor 只用 read/grep/glob 做最小只读核对，然后 `ticket_answer` 直接 `open → done`（`resolution.kind='answered'`），不写 WorkOrder、不派 Worker；答案经 `[Router notice]` 回到 Chatbot 转述用户。需要长调查的问题不建 answer 票，走 WorkOrder 交 Worker。
- 同一张票同一时间只有一个 executor；依赖未完成不派发；同一次就绪最多派发一次。
- 所有需要跟踪的委托必须落 ticket；直接 session.send 只用于不跟踪的 ad-hoc。
- 票的归属状态：unassigned / project / global。intake 默认 unassigned，projectId 为空；unassigned 不派发，派发前必须落定为 project 或 global。unassigned 和 global 都可能是空 projectId，必须用归属状态区分。
- Global 票由 Global Advisor 负责，使用全局预算和全局知识，不写项目记忆；Project 票由 Project Advisor 负责，使用项目预算和项目记忆；Workspace 可空；session 一次只在一个 cwd 下运行；Project 票的直管 worker 用项目 cwd（该票选定 Workspace 的根目录），生成物和中间产物放 `{$cwd}/ria-runs/<workerId>/`；Global 票的直管 worker 默认用 Ria 的 worker 根目录（DSH_HOME/state/ria/workers），生成物和中间产物放 `{$cwd}/runs/<workerId>/`；Global 票显式指定 Workspace 时按项目 cwd 走。

## 5. Worker：独立 / 直管，以及 work / reflection 两种类型

| | 独立 worker | 直管 worker |
|---|---|---|
| 创建与配置 | 用户或已有 | Ria |
| 指令来源 | 用户可直接指挥；Ria 只投普通消息 | 只接 Ria 工单 |
| 用户角色 | 可直接指挥 | 只观察，保留紧急叫停；方向调整通过 Ria |
| Ria 角色 | 代管：只读观察，建议给用户 | 编内管理：派活、答疑、纠偏、收尾 |
| 契约 | 无固定契约 | 固定契约 + 协作工具 |
| 生命周期 | 长期 | 长生命周期；同一时间一票；跨票复用，空闲或显式退休 |
| Topic 关联 | 无 | 弱关联：Topic 只做路由亲和，不拥有 worker |
| cwd | 用户决定 | 创建时固定；Project 用该票 Workspace 根目录，产物放 ria-runs/<workerId>/；Global 默认用 DSH_HOME/state/ria/workers，产物放 runs/<workerId>/，显式 Workspace 时按项目 cwd |
| preset | 按 DSH 当前配置，Ria 不指定 | 默认 PTC；只注册执行与协作工具，不继承 `ria_*` 管理工具；不派子代理（`subagent`/`subagent_fork` + `list_agents`/`send_message`/`interrupt_agent` 全部 deny） |
| 默认 | 否，仅用户明确要求 | 是，新建 worker 默认 |

- **默认类型**：新建 worker 默认直管 worker，由 Ria 创建和配置；独立 worker 只在用户明确要求时使用，已有独立会话不因空闲被默认复用。直管不可用时向用户说明，不静默改派独立 worker。
- **独立 worker**：普通顶层会话，保留自己的 preset、tools、MCP；Ria 不改配置，不注入契约。观察需用户授权，只读；建议默认给用户，不直接指挥。
- **直管 worker**：只对 Ria 负责；不创建 worker，也不派子代理（`subagent`/`subagent_fork`）或列/发消息/打断子代理（`list_agents`/`send_message`/`interrupt_agent`，全部 deny），不调用 `ria_*` 管理工具，不写 Ria 记忆；Ria 的 steer 在下一个 checkpoint 必须处理；完成必须带证据。
- **Topic 弱关联与生命周期**：直管 worker 不绑定 Topic；Topic 只做路由亲和和上下文提示。一个 Topic 可以按需使用多个 worker，一个 worker 也可以跨 Topic 复用；同一 Workspace（Global 为 Ria 的 worker 根目录）内优先复用最近处理过该 Topic 的 idle worker。同一时间只接一张票；完成后继续接同 Workspace（或 Ria 的 worker 根目录）的其他票，空闲或显式退休；Topic 归档或合并不强制退休，只清掉亲和提示。跨 Topic 切换前写回 run record，切换时用 ticketBrief 重新定位，不假设上一 Topic 的上下文。
- **cwd 与产物目录**：直管 worker 的 cwd 创建时固定，不为单张票换 cwd。Project 票用项目 cwd（该票选定 Workspace 的根目录），生成物和中间产物放 `{$cwd}/ria-runs/<workerId>/`；Global 票默认用 Ria 的 worker 根目录（默认 DSH_HOME/state/ria/workers），生成物和中间产物放 `{$cwd}/runs/<workerId>/`；Global 票显式指定 Workspace 时按项目 cwd 走。产物不散落在项目根或 Ria 状态根；Topic 跨 Workspace 时按 Workspace 拆 worker。
- **直管契约**：一轮一件事；开工复述目标、验收、计划；里程碑结构化报告；歧义、不可逆、需要用户偏好时停下来问；只对 Ria 下结论。
- **PTC 与 checkpoint**：直管 worker 默认 PTC，但一个 `run_code` 只是一个执行段，不是 checkpoint。长任务按里程碑拆成多次 `run_code`；每次结束必须 `report` 并读 steer，不能把整张票塞进一个长程序，否则 Ria 无法在中途纠偏。
- **协作通道**：L1 结构化报告 + L2 checkpoint steer 为 MVP；同步问答可选；不共享上下文，不实时共思。
- **0 入侵与硬隔离**：普通 worker 路径一行不改；直管走 scoped prompt/tools，工具硬隔离，绑定落盘、重启可恢复。契约是行为约束，硬边界靠工具隔离、审批和用户叫停。

### Worker 类型：work / reflection

直管 worker 在 v2.json 里记 `workerType`。旧数据没有该字段时按 `work` 读取，**不丢绑定**，下次写入时补上。

| | work（默认） | reflection（复盘） |
|---|---|---|
| 用途 | 执行常规工单：改代码、跑测试、产出文件 | 复盘/反思：只读取证，产出复盘报告 |
| 工具面 | bash/read/write/edit/run_code + worker_report/worker_checkpoint | read/grep/glob + session_list/session_events + worker_report/worker_checkpoint；没有 bash/write/edit |
| cwd / 沙箱 | 项目 cwd 或 stateDir/workers，可写工作区 | stateDir/reflection-workers，不在仓库里，写不了仓库代码 |
| 派发 | mode=work 的工单 | mode=reflection 的工单 |
| 子代理 | 全部 deny | 全部 deny |

- 两种类型不可混用：给 work 工单指定 reflection Worker（或反过来）会被拒绝，返回 `worker_kind_mismatch`，票保持 `open`。
- reflection Worker 只读：通过 read/grep/glob 读仓库、通过 session_list/session_events 读历史会话；不写代码、不改配置、不做最终收尾。会话只读工具只属于它，Advisor 和 work Worker 都没有。
- **复盘票流转**：Chatbot 或用户提出复盘需求 → `chatbot_request(mode=reflection)` 建票 → Advisor 写 WorkOrder（读哪些会话、产出什么报告）→ `ticket_dispatch` 路由到 reflection Worker（当前没有就现场创建一个）→ Worker 用 session_* 与 read 取证，`worker_report(done)` 回传结论与证据 → Router 收口，Chatbot 转述。
- **为什么不给 Worker 子代理能力**：委派工具族对直管 Worker 全部关闭（`subagent`、`subagent_fork`、`list_agents`、`send_message`、`interrupt_agent`，以及 agent-team 的 `spawn_teammate`/`wait_agent` 若挂载）。① **执行末端**：Worker 是责任链的末端，工单已由 Advisor 拆到可执行粒度，再向下派会让“谁在做这张票”失去单一答案。② **责任链**：Worker 只对 Ria 下结论、只领一张票；子代理没有工单、没有 checkpoint、没有报告，失败无法归因，Ria 也无法纠偏。③ **绕过 checkpoint/report**：现有协作靠 `worker_report`/`worker_checkpoint` 的里程碑与 steer；子代理在本轮内部黑盒跑完，等于绕开这两个唯一可观测点。④ **并发不可控**：一张票同一时间只允许一个执行者（lease/attempt 语义）；子代理会制造绕过 lease 的并发写与重复产物，Ria 也无法暂停/恢复它们。实现口径：`restrictWorker` 按可用名求交集后以 deny-list 下发整个委派工具族，未知名自动跳过；Advisor/Chatbot 的工具面不受影响。

## 6. 控制面

- Router 是确定性控制面：事件驱动，不读对话上下文，不维护自己的会话；状态、权限、租约、预算、重试、超时、通知、审计都归它。
- 模型只在规则拿不到结构化标签时兜底：输出标签、分数、置信度；规则做决定。模型不能改状态、选 session、定预算、写知识。
- Router 的模型配置只读 Chatbot session 当前配置：provider + model + reasoningEffort。Chatbot 没有可用配置时直接报错；不 fallback 到 Global Advisor，不使用部署默认模型，不降级纯规则。
- Router 只读，不调用 selectModel，不写回默认模型；用 llm.stream 做 one-shot，不创建 session。
- 通知与副作用的目标形态是走 outbox，至少一次、按幂等键投递；状态先落定，再送达。MVP 的 Chatbot 通知直接 prompt，尚未接入 outbox（见第 10 节）。

### 提权风险分级与逐条审批

v2 的提权不再依赖工具白名单或 `chatbot_grant`。每次 Worker 的提权请求都由 Router 在 `approval/request` 前事件驱动地判一次风险，按风险决定「自动放行本次」还是「阻塞等用户」。分级器是纯函数 `lib/v2/risk.mjs`，没有 IO、没有定时器；参数缓存来自 `tools/pre-execute`，因为 `approval/request` 本身不带 argv。

**四档规则表**（命中多条时取最高档，reasons 列出所有命中；括号内是稳定规则 id）：

| 等级 | 判定类别 / 示例 | 规则 id |
|---|---|---|
| low | 只读命令：`ls`、`cat`、`head`、`tail`、`grep`、`rg`、`find`（无 `-delete`/`-exec`）、`wc`、`stat`、`file`、`jq`；只读 Git：`git status/diff/log/show/branch --list/rev-parse`；跑测试：`npm test`、`node test/*`、`pytest`、`go test`（不安装、不发布）；写工作区内产物/临时文件：`ria-runs/`、`runs/`、`dist/`、`*.log`、`*.tmp` | `read-only-cmd`、`read-only-git`、`run-tests`、`read-only-tool`、`write-artifact`、`write-workspace-file` |
| medium | 写工作区内被跟踪的源码/配置：`lib/`、`src/`、`test/`、`docs/`、`package.json`、`tsconfig*.json` 等；`git add/commit/stash/merge/rebase/switch/checkout/restore`；安装依赖：`npm/pnpm/yarn/bun install/add/ci`、`pip install`；改 `~/.dsh` 下非凭据配置 | `write-tracked-source`、`git-write`、`install-deps`、`config-write` |
| high | 写工作区外/系统路径（`/etc`、`/usr`、Home 下非 workspace）；`sudo`/`chmod`/`chown`/`dd`/`rm`/`rmdir`；`systemctl`/`service`/`launchctl`/`dsh-daemon`/`kill`；网络出口：`curl`/`wget`/`ssh`/`git push`；凭据相关：`.env`、`.credentials`、`.ssh`、`id_rsa`、`printenv`/`env` | `write-outside-workspace`、`privileged-command`、`privileged-escalation`、`destructive-command`、`network-egress`、`credentials-path`、`credentials-env`、`system-install` |
| unknown | 命令无法静态解析：管道、变量/命令替换、`sh -c` 套娃、复合重定向；路径无法解析：相对路径逃逸、`~` 未展开、缺少 cwd/workspace；工具不认识或参数缓存缺失 | `unparsed-shell`、`path-escape`、`path-unparsed`、`path-missing`、`workspace-missing`、`missing-arguments`、`unknown-tool` |

简单单条输出重定向（`cmd > path` / `cmd >> path`）按目标路径判定；含管道或复合重定向仍是 unknown。unknown 永远按高风险处理，不会自动放行。

**PTC 传输层：分类看内层命令，不看传输层工具名。** Worker 的命令经常经 `run_code` 执行，`approval/request` 里的 `toolName` 是 `run_code`。`parseTransportCall` 从 `tools/pre-execute` 缓存的 `args.code` 中静态提取内层 `tools.bash({ command: '<字面量>' })`、`tools.write({ file_path: '<字面量>' })` 等调用；多条内层命令/路径取最高风险。reasons 前置 `[via-run_code] 经由 run_code，实际命令：X`（多命令列前 3 条）；审计行保留外层 `tool=run_code`，`argv` 记内层命令、`paths` 记内层路径，并带 `transport=run_code`；自动放行/阻塞通知也展示内层命令。动态插值、变量拼接、`eval`/动态构造、缺 `code` 时回退 unknown，reasons 明确写「无法解析 run_code 内部命令」。`PTC_TRANSPORTS` 是传输层集合，未来同类 PTC 包装工具按同一规则扩展。

**策略优先级**：工单 `meta.escalationPolicy` > 全局 `settings.escalationPolicy` > 默认。默认 **`auto-low`**。`ticket_plan` 可传 `escalationPolicy`：

| 策略 | low | medium | high / unknown |
|---|---|---|---|
| `strict` | 问用户 | 问用户 | 问用户 |
| `auto-low`（默认） | 自动 allowed-once | 问用户 | 问用户 |
| `auto-low-medium` | 自动 allowed-once | 自动 allowed-once | 问用户 |

**事件驱动、无轮询**：`tools/pre-execute`（prepend）缓存 `sessionId|callId → {toolName, arguments}`，`tools/result` 清理；宿主追加 `approval/asked` 后、`approval/request` 瀑布前完成判定。自动放行直接返回 `allowed-once`；其余仍走宿主审批 UI，工单按 `approval/asked → blocked(waitingOn=approval)`、`approval/decided → open → working` 的既有状态机。没有任何 `setInterval`/看门狗。v1 的 `ApprovalObserver` 同样靠事件驱动；v2 的区别是按工单/风险决策、只对 Auto 策略下的 low/medium 放行。

**审计**：每次决策写 `state/audit.jsonl`（复用 `appendAudit`，失败只告警）。自动放行、转人工、人工批准/拒绝/取消各一行：

~~~json
{"at":1795000000000,"event":"approval/decision","ticketId":"ticket_x","sessionId":"session-w","tool":"bash","callId":"call_1","argv":"git status","paths":[],"level":"low","reasons":["[read-only-git] 只读 Git 命令：git status"],"decision":"auto-allow","policy":"auto-low","policySource":"default","kind":"risk"}
{"at":1795000000001,"event":"approval/decision","decision":"human-allow","approvalId":"apr_1","ticketId":"ticket_x","sessionId":"session-w","tool":"bash","callId":"call_2","level":"high","reasons":["[write-outside-workspace] 写入工作区外路径：/etc/hosts"],"policy":"auto-low","policySource":"ticket","kind":"risk"}
~~~

**通知**：低/中风险自动放行发一条信息性通知（谁、工具、命令/路径、等级、reasons、策略与来源），例如「已自动放行低风险提权：ticket_x 工具 bash「git status」；判为 risk:low [read-only-git] 只读 Git 命令：git status（策略 auto-low，来源 default）。」；需要人工判断的阻塞通知带 `[risk:high ...]` / `[risk:unknown ...]` 与全部 reasons。

**`chatbot_grant` 的定位**：仅调试/应急。正常提权走上述逐条风险审批，不得用 grant 绕过审批或解开被审批卡住的 Worker。`action=set` 必须写 reason，并用 `kind=debug|emergency` 标明性质；每次调用写 `grant/set`（或 `grant/rejected`）审计并带 `grant_kind`。

**grant 落地会结算该 session 的挂起审批**：Worker 的 ask 请求会保留一个可结算句柄（`pendingSettlers`，按 `sessionId|callId`），同时照常把请求交给宿主 UI；只有临时提权 grant（`kind=temporary`）会按方案 A 对每个句柄结算 `allowed-once`（等价于「此刻批准」），纯降权（永久 grant）不会替挂起请求做批准，宿主随后的 `approval/decided` 会把工单从 `blocked(waitingOn=approval)` 恢复为 `working`。每个被放行的请求写一行审计：`decision=auto-allow`、`reason=grant-applied`、`grantId` 关联、保留 `tool/ticketId/callId/level/reasons`；通知写「授权已生效，并已放行此前挂起的请求」。没有可结算句柄的旧记录（正常 live 请求不会出现）只标记为未结算并提示 Worker/用户重试；监听器只有 `AbortSignal`、无法替宿主取消请求，因此不假装已取消。全程事件驱动，无轮询。

**审批终态与取消竞态**：grant 成功 settle 时同时写 `approvalTerminals`（按 approvalId，缺失时按 callId；容量 500、写入时惰性清理 24h），并把 pending record 标 `terminal=grant-applied`。之后 `onApprovalDecided` 若看到终态且 outcome 是 cancelled/denied/unavailable，直接忽略：不改工单、不写 failure、不发「审批被取消/拒绝」通知，只记 info 日志；allowed-once 仍按正常路径恢复 working，并补记终态 allowed，防止后到的 cancelled 再改状态。这样 allowed/cancelled 两种事件顺序都不会把已结算的工单打回 cancelled。

**风险规则 `plugin-install`**：`dsh plugin` 的 add/update/remove/install（无论 `--profile` 在子命令前后，目标为 `~/.dsh/profiles/**` 或 `file:...`）判 **medium**，rule id `plugin-install`，reason 写「向 profile 安装/更新插件：dsh plugin <action> <target>」；action 无法识别时保持 unknown 并写清。工单设 `escalationPolicy=auto-low-medium` 时该请求自动放行；`strict` 下仍需人工确认。

**`chatbot_request` 的 escalationPolicy**：工具新增可选 `escalationPolicy`（strict/auto-low/auto-low-medium）；仅 `mode=work` 写入 ticket meta，answer/reflection 忽略；非法值返回 `invalid_escalation_policy`。部署类工单可显式声明 auto-low-medium。

### Router 事件日志

ticket history 是状态快照，`audit.jsonl` 是审批/授权决策审计；两者都不记录“为什么派发、派发给谁、确认了没有”。Router 事件日志补上这条过程流，append-only，事件驱动，复盘时可以直接按 ticket 还原时间线。

**事件类型**（`event` 字段；查询支持 `dispatch.*` 这类前缀）：

| event | 产生位置 | payload 关键字段 |
|---|---|---|
| `ticket.created` | `chatbotRequest` 建票成功后 | `mode`（work/answer/reflection）、`workspace`、`requestId`、`goal` 摘要 |
| `advisor.plan` | `ticketPlan` 写 WorkOrder 后 | `summary`、`steps` |
| `dispatch.attempt` | `dispatchTicket` 的 working 迁移后 | `workerId`、`attemptCount`、`requestId` |
| `dispatch.confirmed` | `confirmWorkerTurnStart` 收到 worker `turn/start` 时 | `workerId`、`requestId` |
| `dispatch.blocked` | 60 秒未确认、派发 prompt 失败、重派失败、startup 中断 | `workerId`、`requestId`、`message`、`reason` |
| `ticket.state` | `RiaStore.transitionTicket`（唯一状态写入口） | `from`、`to`、`waitingOn` |
| `approval.asked` | v2 `onApprovalAsked` | `approvalId`、`toolName`、`reason`、`riskLevel`、`decision`、`policy`、`policySource` |
| `approval.decided` | v2 `onApprovalDecided` | `approvalId`、`outcome`、`decision`、`riskLevel`、`toolName` |
| `lesson.injected` | `dispatchTicket` 把经验写进 Worker brief 后 | `lessonIds`、`source`（workOrder/match） |

**每条记录字段**：`ts`（epoch ms）、`event`、`ticketId`、`sessionId`、`actor`（chatbot/advisor/router/host）、`reason`、`payload`（对象或 null）。写失败只记 warn，不影响派发或审批。

**存储**：当前文件 `stateDir/router-events.jsonl`；跨月或当前文件超过 64MB 时，append 时把热文件轮转到 `router-events-YYYY-MM.jsonl`（YYYY-MM 取事件 ts 的 UTC 月）。启动时执行一次 `prune()`：保留最新 12 个月，删更早的月文件；没有定时器。`lib/router-events.mjs` 是唯一读写实现。

**只读查询**：

- `ria_status { scope: "events", ticketId?, type?, from?, to?, limit?, offset? }`：`type` 支持精确名或 `dispatch.*` 前缀；`from`/`to` 接受毫秒或 ISO；`limit` 1–200（默认 100），返回 `{scope:'events', ok, events, total, matched, hasMore, limit, offset, scanned}`，按 `ts` 倒序。只读，不建票、不改状态。
- HTTP `GET /plugins/dsh-ria/api/events?ticketId=&type=&from=&to=&limit=&offset=`：同一实现，JSON 返回；不提供写/清理接口。

没有轮询、没有定时器：所有埋点都在既有回调点（建票、plan、dispatch、turn/start、状态迁移、approval asked/decided），轮转只在 append 时触发，清理只在启动时触发一次。

## 7. 记忆与知识

- 长期记忆只放稳定偏好和长期约定，不抄 ticket 状态、时间戳或逐轮流水；定期反思只读回看，产出建议，不自动改写记忆。
- 知识层独立于 ticket：Global 知识跨项目，Project 知识项目内；条目不挂 ticketId。生命周期 proposed → active → deprecated / superseded；Worker 和 Chatbot 只能提议，Advisor 写 knowledge，Router 不写。
- 持久化目标：控制面热状态（ticket、event、outbox、registry、knowledge 等）进 SQLite；memory 和 reflections 留文件；transcript 仍由 DSH 管理。单写者、事务、WAL、可备份。SQLite 的迁移范围、Schema、导入/回滚与分阶段方案见 [sqlite-migration-design.md](sqlite-migration-design.md)。

### 复盘用的只读会话工具

reflection Worker 有两个只读工具，用来回看已发生的会话，给反思和事后归因提供证据；Advisor 与 work Worker 都没有这两个工具。

- `session_list`：按 `idPrefix`、`titleContains`、`cwdContains`、`updatedAfter`/`updatedBefore`（毫秒或 ISO 时间）、`running`、`agentAvailable` 检索会话；默认排除 subagent，`includeSubagents` 打开；归档项默认保留并带 `archived` 标记，`includeArchived:false` 可去掉。返回 `sessionId/title/cwd/updatedAt/running/agentAvailable/blank/parentSessionId/origin/archived`，按更新时间倒序；`total` 是过滤后总数，`truncated` 表示被 `limit` 截断。
- `session_events`：读一个会话的事件流，`sessionId` 可给唯一前缀；`types` 支持精确名和 `approval/*`、`turn/*` 这类前缀；还可给 `fromSeq`/`toSeq`、`fromTime`/`toTime`、`limit`（≤200）和 `summaryChars`（≤300）。默认只看复盘关键事件：`turn/start`、`turn/end`、`approval/asked`、`approval/decided`、`tool/call`、`tool/result`、`command/run`、`error`，以及任何名字含 `error` 的事件。每条事件压成一行摘要，不展开工具参数和消息正文；返回 `events/count/scanned/truncated/more/nextThroughSeq`，`nextThroughSeq` 用来接着读更早的事件。

典型三步：

1. `session_list` 按标题、cwd 或时间找到目标会话，拿到 `sessionId`。
2. `session_events` 先不传 `types` 看关键事件骨架；需要细看时再用 `types:['approval/*']`、`types:['turn/*']` 或 `seq` 区间缩小范围。
3. 根据 turn 起止、审批 asked/decided、工具调用和错误事件写复盘结论。

只读保证：两个工具只走宿主 `sessionController.list/events/state/projections`，没有 `prompt`、`append`、`updateQueue`、改标题或改权限的路径；也只注册给 reflection Worker，并有 `reflectionCaller` 守卫。

分页与截断：事件按页反向读取，单页 `maxMessages` 有界、总页数上限 10，`limit` 与 `summaryChars` 双重截断；不会把整个 `session.v4.jsonl.zstd` 塞进上下文。`more`/`truncated` 为真时用 `nextThroughSeq` 继续。

脱敏：标题、cwd、事件摘要里的 `token=…`、`apiKey:…`、`Authorization: …` 等一律替换为 `***` 或 `[redacted]`，工具参数不展开。

示例：

```
session_list { "titleContains": "发布", "updatedAfter": "2026-11-01T00:00:00Z", "limit": 10 }
→ { ok:true, sessions:[{ sessionId, title, cwd, updatedAt, running, agentAvailable, archived }], total, truncated }

session_events { "sessionId": "session-abc", "types": ["approval/*", "turn/*"], "limit": 20 }
→ { ok:true, sessionId, events:[{ seq, type, time, summary }], count, scanned, truncated, more, nextThroughSeq, note:"read-only" }
```

### 经验库与分发（lessons）

经验是**按需检索**的知识，和 memory.md（稳定偏好，整体注入）不是一回事：memory 抄进 prompt，经验只在派单命中时进入 Worker brief。

**存储**：`DSH_HOME/state/ria/lessons.json`（0600，tmp+fsync+rename 原子写）。每条：`id`、`tags`、`condition`（适用条件）、`scenario`（场景）、`pitfall`（坑位）、`approach`（有效做法）、`source{ticketId,sessionId}` 与 `sources[]`、`createdAt/updatedAt`、`hits`（命中次数）、`status=active|archived`。上限 500 条，超出按命中少、更新时间旧归档。

**闭环**：

1. **回流**：Worker 在 `worker_report` 里带 `lessons:[{scenario,pitfall,approach,evidence?}]`（≤5 条）。它只是**候选**，落在 v2.json 的候选区，默认不生效、不影响派单；reflection Worker 在复盘票里同样用这个字段提交。
2. **审阅**：Advisor 用 `lesson_review`（list/accept/reject）处理候选。accept 才写入经验库；reject 只标记候选，不入库。Worker 永远不能直接入库。
3. **去重**：按「scenario slug + pitfall slug」的 hash 查重；命中则合并——tags 取并集、来源追加、approach 取新、hits 相加、updatedAt 刷新，条目不新增。
4. **分发**：`ticket_plan` 可用 `lessons:[id]` 把条目钉进 WorkOrder；未钉时 `dispatchTicket` 用工单的 goal/workspace/mode 检索，自动取 ≤3 条。注入渲染成 brief 的 `[Lessons]` 段（每条一行，总长 ≤800 字符），并把所用 id 写进 `ticket meta.usedLessons`、派发返回体与 ticket 视图。
5. **命中计数**：brief 成功发出后 `hits` +1；没有相关经验时 brief 不出现 `[Lessons]`，meta.usedLessons 为空数组，不报错。

**检索**：内存倒排索引 `tag → ids` 与 `token → ids`（英文按词、中文按 2-gram，另加 workspace 路径段）。`match()` 只对查询 token/tag 的 postings 打分（tag 命中 ×3、token 命中 ×1，再按 hits/更新时间微调），不遍历全库；返回的 `scanned` 只随命中集合增长。`lesson_search` 是这个检索的只读入口。

## 8. 界面与观察

- 一个看板 + 一个 Chatbot。看板的主语是“事”，不是 session；第一屏是“需要你”收件箱，只有这里弹通知；其余分为进行中、最近完成、异常/叫停。
- 看板是只读投影：动作写回现有路径，不在看板里另建一套状态；直管卡没有输入框，独立卡可以打开会话。
- 独立 worker 可按授权只读观察目标、状态、消息元数据、产物和卡点；建议默认给用户，观察不等于指挥。
- **用户直连 Advisor/Worker**：这两个角色只接受 Ria 注入的消息（`host_` / `ria-task-host`）。用户在 DSH 界面手输的非 `host_` 消息不会被执行、不会转发给 Chatbot、不改工单，只由 `onPreStep` 把本回合模型输入替换为固定指令，模型正常回一条「请通过 Ria 下达任务。Advisor/Worker 只接受 Ria 派发的工单，直接对话不会被处理。」。例外：工单处于 `blocked(waitingOn=user)` 时放行，让用户能回答澄清。开关 `settings.blockDirectUserMessages` 默认 `true`，关闭后恢复原行为；Chatbot 与普通独立会话不受影响。`steer` 中途插入只在 step 边界生效。
- **直通（direct）归属**：状态、命令解析、目标解析、入站转发全部在 v2 controller（`directCommand` / `directInfo` / `enableDirect` / `directRelay` / `forwardDirectReply`，见 `lib/v2/controller.mjs`）；微信 Claw 只在入站时调用注入的 `directRelay` 钩子（`lib/channels/wechat-claw.mjs`），`lib/index.js` 负责把 `v2.directRelay` 接进去，v1 没有直通。`chatbot_direct` 工具与 `/直通`、`/直通状态`、`/退出直通` 是同一实现的模型入口与用户命令入口，不冗余，保留为唯一实现。后续若其他渠道也要直通，只复用 controller 的 `directRelay`/`directInfo`，不在渠道内复制状态与命令解析；把 `directCommand` 正则与提示文案抽成独立模块列为可选重构（不改变行为）。直通只改前缀与入站路由：Chatbot 的 assistant 文本仍经 Claw 转发（直通生效时加 `【Ria】`），直通回复带 `【直通·<标题>】`；直通发送失败在内存中有界重试（1s/3s/9s，≤3 次、≤2 分钟、按 `eventSeq` 去重），超限发可见失败提示，不写 outbox、不在恢复时重放；Chatbot 普通消息的恢复补发折叠为最近 5 条 + 一条 `【Ria·补发】` 汇总。

### 角色会话命名

| 角色 | 标题 | 规则 |
|---|---|---|
| Chatbot | `Ria` | 单例 |
| Advisor | `Ria Advisor` | 单例（当前 Global；未来无状态 Advisor 同名） |
| Worker | `Ria Worker <n>` | n 持久化递增，删除/回收不复用 |
| Reflection Worker | `Ria Reflection Worker <n>` | 独立计数器，同上 |
| Sage | `Ria Sage` | 单例 |

- 计数存 `v2.json.meta.workerSeq/reflectionSeq`；创建前自增并立即保存，编号只增不减。
- 启动时幂等执行 `renameRoleSessions()`：只处理 v2 绑定里的 chatbot/advisor/managed workers（含 reflection），通过 `sessionController.rename` 写会话标题事件，`session_list` 与看板随之更新；已是目标标题则跳过，失败只记 warn 不阻断启动。
- 用户自建的普通独立会话不在 v2 角色绑定里，**绝不重命名**；归档或不存在的角色会话跳过。
- 旧会话缺少 `seq` 时在迁移中补齐并写回 meta；Sage 创建逻辑已落地，标题 helper 统一生成。

### Sage 与无状态 Advisor（实现补充）

- **Sage**：单例标准会话，标题 `Ria Sage`，cwd `stateDir/sage`；工具仅 `sage_read`/`sage_write`/`sage_request`，无 bash/write/edit/run_code。启动与 compaction 后读 `cognition/INDEX.md`。
- **认知库**：`stateDir/cognition/` 下 `principles.md`、`projects/<key>.md`、`chatbot/{preferences,agreements,decisions}.md`、自动生成的 `INDEX.md`、`proposals/`；仍复用 `stateDir/lessons.json`。所有写入 0600 + tmp+fsync+rename，Sage 独占写，写后更新 INDEX 与 router-events。
- **无状态 Advisor**：每张进入 Advisor 阶段的票由 `createAdvisorForTicket` 新建会话（标题 `Ria Advisor`），prompt = ticket brief + 认知快照；不跨票复用上下文；检索失败时 prompt 显式标 `cognition_status: degraded`。
- **Chatbot 记忆**：Ria 在 `onPreStep` 以 host 消息注入只读摘要（记忆变化才重新注入）；Chatbot 无写认知工具，用户提案走 `chatbot_propose`（priority=high）。
- **提案通道**：Advisor `ticket_plan.cognitionProposal`、Worker/Reflection `worker_report.lessons`、用户 `chatbot_propose` 都落 `proposals/`；Sage 采纳后写记忆，积压不阻塞派单。
- **退役与 bootstrap**：启动时 `bootstrapCognition()` 一次性生成初始记忆（已有 `.bootstrapped` 则跳过），`retireLegacyAdvisor()` 清空 global 旧绑定并尝试归档会话，`advisorMode=stateless`。
- **简化口径**：Sage 单例，不做写队列/优先级/冲突引擎/TTL；记忆冲突与过期由 Sage 人工维护。与 `docs/sage-advisor-design.md` 一致，后者补充了更完整的长期目标。

### 阻塞通知范围

独立会话的提问/审批默认**不再推送 Chatbot**：

- 只有用户显式 `chatbot_watch` 的会话，才由协管路径发 `【协管·<标题>】在等你回答…` / `【协管·<标题>】需要你决定的提权…`；通用 `noticeQuestion`/`noticeApproval` 继续跳过 watched，避免双份。
- 未协管会话只写 `router-events.jsonl` 的 `notice.suppressed`（sessionId、kind=question/approval、question/toolName/reason、时间），不打扰用户。
- Chatbot/Advisor/Worker 角色会话始终静默，不写 suppressed。
- **代价**：未协管会话卡住时不会主动提醒，只能靠打开会话或事后查 router-events 发现；需要推送就先 `chatbot_watch`。

## 9. 边界

- 直管 ≠ 共享上下文或实时共思；双方只能通过消息、ticket 和 run record 协作。
- 审批由 Host/Router 的风险策略逐条处理：低风险可按策略放行本次，高风险/未知一律转用户；不自动放宽长期权限。v2 已接入四档风险分级，见 §6「提权风险分级与逐条审批」。
- 不把 subagent 当 worker；Router 不进入对话；Chatbot/Advisor 不是多个管理者；不改普通 worker 的配置和上下文。
- 本文是目标设计，不表示全部已实现；根 DESIGN.md 未改，实现状态以代码和测试为准。

## 10. 当前实现（MVP）

已实现：Chatbot（standard，仅 `chatbot_*`）、Global Advisor（PTC，只读核对 + `ticket_*`，不含会话只读工具）、managed Worker（PTC，两种 `workerType`：work 持 `worker_*` + 执行工具；reflection 只读仓库与会话日志，持 `worker_*` + `session_list`/`session_events`）；Worker 提权按四档风险逐条审批（`lib/v2/risk.mjs`，工单策略 > 全局设置 > 默认 auto-low），low 自动 allowed-once、medium 按策略、high/unknown 一律阻塞并通知，每次决策写 `audit.jsonl`；`chatbot_grant` 降级为调试/应急工具（set/list/reset），只有用户明确要求时才可用且写 `grant_kind` 审计；Chatbot 可用 `chatbot_watch`（add/remove/list/status）协管独立会话，与 direct 无耦合；Advisor/Worker 拦截用户直连消息（`settings.blockDirectUserMessages` 默认 true，`waitingOn=user` 例外），只回固定提示；纯降权永久生效，任何提权必须带 TTL；自动恢复只撤销提权字段，同一 grant 里的降权保留，显式 reset 才撤销全部字段；绑定 ticket 时随 done/cancelled 恢复，重启会 reconcile，审计写 `audit.jsonl`；ticket 的 intake → open → working → blocked/done/failed 主链路；研究类票（`chatbot_request mode=answer`）由 Advisor 只读调查后 `ticket_answer` 直接 `open → done`，不派 Worker；`chatbot_resume` 恢复 blocked 票；startup 把中断的 working 票置为 blocked(environment)；微信 Claw 通过 Chatbot 复用入站与 assistant 转发；微信直通模式（`/直通 <会话名>`、`/直通状态`、`/退出直通`）把消息直接 steer 给普通独立会话，只转发正式文本；启动时向已连接通道发送一条重启通知。`chatbot_request` 可带 `workspace` 绝对路径：给定已有项目目录时 Worker 用该项目 cwd、产物放 `{$cwd}/ria-runs/<workerId>/`；不填则用全局 worker 根目录。状态文件为 `ria.json`（ticket）+ `v2.json`（绑定、Request、WorkOrder、报告、inbox）。

暂缓：Project 路由与 Project Advisor、知识层、SQLite 迁移、独立 worker 的创建与观察、Topic 亲和、看板动作的 v2 收口、旧 legacy ticket 的迁移。

兼容：`apply(ctx, { stateDir })` 默认 v2；`{ v2: false }` 保留旧单会话 Ria 与 15 个 `ria_*` 工具，现有 legacy 测试走这条路径。
