# memory.md 审计：哪些该迁进主提示词或代码

- 审计对象：`/home/gkl/.dsh/state/ria/memory.md`（2026-11-12，3175 bytes，11 条 bullet）
- 对照代码：`lib/index.js` 的 `managerPrompt()`、`lib/dispatch-guard.mjs`、`lib/worker-idle.mjs`、`lib/index.js` 的 `startup()` 与 `toolRequest()`
- 本文正文只给方案，不改 memory；§8 记录 2026-11-12 的实际落地状态（改了 prompt 与测试，未改 memory）。

## 0. 结论先行

这 11 条的去向：

- **留在 memory 3 条**：restart-report（与旧的重复条合并）、restart-method（与旧的重复条合并）、worker-routing 的当前 sessionId 映射。
- **进主提示词 3 条**：restart-consent、worker-notify-steer、关注某个 worker。
- **拆分 1 条**：路由策略。通用的“standing routing preference 优先”进提示词，具体 sessionId 映射留在 memory，也就是上面第 3 条。
- **可删除 5 条**：delegate-only-explicit、设计原则、worker 拒绝/取消、旧 restart-report、旧 restart-method。

按原始条目计：3 条（含拆分后的 routing 映射）+ 3 条进 prompt + 5 条删除 = 11 条。

如果只先做 2–3 条，我建议：

1. **restart-consent 进 manager prompt**。这是安全规则，当前没有任何代码强制点，放在 memory 里最容易被上下文挤掉。
2. **worker-notify-steer 进 manager prompt**。它只差一句明确的“信息同步用 steer”，补上后 memory 这条可以整条删除。
3. **关注某个 worker 进 manager prompt**。它和已有的 `[Worker idle]` 机制是同一件事，写进 prompt 后不用再靠 memory 提醒。

另外，**delegate-only-explicit 现在就可以删**：`lib/index.js:1642` 已经逐字覆盖了它，留着只会让模型看到两遍不同措辞的同一条规则。

## 1. 现状与判断依据

### 1.1 memory 本身的问题

- 11 条 bullet 里有 2 组重复：restart-report 两条、restart-method 两条。重复条不是“更保险”，而是让模型在两条措辞之间做选择，容易只执行其中一条。
- 多条内容已经在 prompt 或代码里存在，属于“记忆里的冗余副本”：
  - `lib/index.js:1642`：`You may do concrete work yourself only when the user explicitly asks you to; otherwise delegate.`
  - `lib/index.js:1646`：intake 工单、`ria_resolve`、turn-stopping 兜底。
  - `lib/index.js:1647`：worker 拒绝/用户取消时停下问用户，不静默改派。
  - `lib/index.js:1661`：`[Worker idle]` 的处理，包括 `aborted(user)` 时不要续派。
  - `docs/operations.md:105` 的“管理者 prompt 的行为约束”又把上述规则汇总了一遍。
- memory 在 `managerPrompt()` 的末尾注入（`lib/index.js:1677-1679`），位置本身是对的：它在 `## Identity` 之后，属于 section 的尾部，修改 memory 不会动到前面的稳定前缀。

### 1.2 prompt / 代码的现状

- manager prompt 是动态 system prompt section：`lib/index.js:2318-2325`，`name: 'ria-manager'`、`order: 40`、`interpolate: false`、`text: () => managerPrompt(sessionId, this.store.readMemory())`。
- `lib/dispatch-guard.mjs` 是全局静态 section：`name: 'dsh-ria:dispatch-guard'`、`order: 4100`，会被安装到所有 agent（包括 worker），文本只有一句防误发。它不适合放 Ria 专属规则。
- `subscribeIntake()` 注册了 `agent/pre-step` 与 `agent/turn-stopping`：前者自动 captureIntake 并注入 `[Task intake]`，后者第一次 steer 提醒、第二次自动 blocked。也就是说，“用户交代的事不能丢”已经有硬机制。
- `lib/worker-idle.mjs` 已经检测 `isUserCancelled(lastTurn)`，把对应 working ticket 转 blocked，blockedReason 是“用户取消了 worker turn（aborted(user)）；等待用户决定下一步”，idleText 明确写不自动续派。
- `toolRequest()`（`lib/index.js:3311-3424`）在状态上只检查 `isTerminal(ticket.status)`，另有 sessionProblem、executor mismatch 等预检，但没有“blocked + waitingOn=user 必须先 reopen”的硬拦截。被标记 blocked 的工单仍然可以被再次 `ria_request`。
- `ria_request` 的 busy 预检只对 `mode === 'queue'`。steer 没有“目标必须正在运行”的预检；DSH controller 在 `dsh-api-session-controller/lib/index.js:857` 对 `request.mode === 'steer'` 直接调 `agent.steer(message)`，`:932` 的 updateQueue 才检查 steer 目标必须 running。
- 插件没有 `ria_restart` 或任何 dsh-daemon 工具。Ria 是 PTC，`run_code` 里可以调 `bash`，所以 `dsh-daemon restart` 仍然可达；不存在结构性禁止。
- `startup()`（`lib/index.js:4224`）在没有未收敛 ticket / pending delivery 时会在 `:4253` 直接 return。干净重启不会产生任何回执，restart-report 目前没有代码强制点。

### 1.3 逐条归类

| # | memory 条目 | 归类 | 结论 | 去向 |
|---|---|---|---|---|
| 1 | restart-consent | 移入主提示词 | 安全规则，每轮都该生效；当前没有可靠代码强制点 | `managerPrompt()` 的 `## How you work` 开头；删除 memory 条 |
| 2 | delegate-only-explicit | 可删除 | 与 `lib/index.js:1642` 重复 | 直接删除；prompt 不改 |
| 3 | 设计原则：有始有终 | 可删除 | intake + turn-stopping 已强制；`:1646` 已写 | 直接删除；prompt 不改 |
| 4 | worker 拒绝/取消时停下问用户 | 可删除 | `lib/index.js:1647`、`:1661` 已写；取消已由 `worker-idle.mjs` 硬处理 | 删除；可选加“blocked 必须先 reopen”的代码 guard |
| 5 | restart-report（旧） | 可删除（并入 6） | 被第 6 条取代，内容更旧 | 删除；保留第 6 条并精简 |
| 6 | restart-report（新，schedule_create） | 留在 memory | 运维流程，频率低；当前没有 restart intent 记录，不能可靠做成代码 | 合并第 5 条后保留；长期可做 startup receipt |
| 7 | restart-method（旧，setsid 被杀） | 可删除（并入 8） | 与第 8 条讲的是同一组失败模式，旧条只讲了一半 | 删除；保留第 8 条并精简 |
| 8 | restart-method（新，KillMode=process） | 留在 memory | 环境相关、命令长，不适合每轮进 prompt；应同时写进运维文档 | 精简后保留；背景移到 `docs/operations.md` |
| 9 | worker-notify-steer | 移入主提示词 | `:1657`/`:1659` 已有大半，只差“信息同步用 steer”一句 | 在 `:1659` 后补一条；删除 memory 条 |
| 10 | 路由：代码/文档各归固定 worker | 拆分 | 通用规则适合 prompt；具体 sessionId 是易变环境事实 | prompt 加“standing routing preference 优先”；memory 留当前 ID 映射 |
| 11 | 关注 xxx worker | 移入主提示词 | 与已有 `[Worker idle]` 机制同源，属于稳定工作方式 | 在 `:1661` 后补一条；删除 memory 条 |

## 2. 迁移文案（可直接贴）

下面所有英文都是拟插入的原文；位置按当前 `lib/index.js` 行号标注。行号会随代码变动，贴的时候以所在 bullet 为准。

### 2.1 restart-consent → manager prompt

**插入位置**：`lib/index.js:1644`，`## How you work` 标题之后、现有第一条 bullet 之前。放在最前面，避免被后面的长 bullet 淹没。

```text
- Never restart dsh web or dsh-daemon, and never run a command whose purpose is to stop this server, without the user's explicit consent in this conversation. Copying plugin files is allowed; ask before any restart and wait for the answer.
```

**为什么不是代码机制**：插件没有重启工具，但 PTC 的 `bash` 仍能执行 `dsh-daemon restart`。在 shell 层做关键词拦截既不可靠（别名、脚本、systemd-run 都能绕过），也会误伤正常的诊断命令。当前最合适的强制点就是每轮都在的 manager prompt；如果以后加 `ria_restart` 工具，可以在工具入口要求 `userConfirmed: true`，但 bash 旁路仍在，所以 prompt 这条仍要保留。

**删除的 memory 原文**：

```text
- **restart-consent**: 重启 dsh web / dsh-daemon（包括为了加载插件改动的重启）必须先征得用户明确同意；未同意不得自行执行 dsh-daemon restart 或触发 web 重启。安装插件文件可以，重启前先问。
```

### 2.2 worker-notify-steer → manager prompt

**插入位置**：`lib/index.js:1659` 之后，作为新的 bullet。现有的 `:1657` 已经说“steer 不能夹带新任务”，`:1659` 说“需求变化先问 queue/steer”，但都没有正面说“信息同步应该用 steer”。这一条补的是正面用法。

```text
- Send information-only updates to a running worker with mode="steer" (parallel changes, external state); do not queue them for the next turn. If the message adds or changes work, ask whether to queue or steer first. Steer must never carry a new task.
```

**删除的 memory 原文**：

```text
- **worker-notify-steer**: 信息同步类消息（通知 worker 有并行改动、外部状态变更等，不需要打断它当前任务、但不希望排队等到下一轮）发给 worker 时使用 ria_request mode=steer 插播，不要用默认 followup 排队；只有真正的新任务/续跑才用普通投递。
```

**可选的代码补强**：在 `toolRequest()` 的 preflight 里加一条“`mode === 'steer'` 要求目标正在 running”，失败返回 `steer_requires_running`。这样即使模型把新任务误写成 steer，也不会在 idle worker 上悄悄变成一轮新 turn。注意：这是对外 `ria_request` 的预检，内部 `retryDeliveries` 和审批恢复路径不应被这条挡住。

### 2.3 关注某个 worker → manager prompt

**插入位置**：`lib/index.js:1661` 之后，紧跟 `[Worker idle]` 那条。这样“读它 → 挂工单 → 等 idle”在 prompt 里是连续的一段。

```text
- When the user asks you to watch a worker, read it first and report what it is doing. If it is still running, create or reuse a ticket with that worker as executor and status=working so the host's [Worker idle] note wakes you; do not end with only a status sentence and do not add a schedule timer for it. If it is already idle, report the result now.
```

**删除的 memory 原文**：

```text
- 当用户说「关注 xxx worker 的工作」时：先读该 worker 正在做什么并汇报；若还没做完，就挂一张以该 worker 为 executor 的 ticket 跟踪，等它这轮结束（Worker idle）时把结论汇报给用户，不要只答一句就结束。
```

**注意**：`:1662` 说了“keep watching something 用官方 schedule 工具”。这条和它不冲突，但要在措辞上明确“worker 用 ticket，不要额外挂 timer”；上面的英文已经写了 `do not add a schedule timer for it`。

### 2.4 路由：prompt 通用规则 + memory 当前映射

这是唯一需要“拆”的一条。不要把人名和 sessionId 硬编码进 `lib/index.js`：这个插件是通用插件，个人 worker 名字和 ID 不属于通用代码。正确拆法是：

- prompt 放**通用规则**：如果 memory 里有 standing routing preference，就优先于 recent 默认。
- memory 放**当前映射**：哪类工作归哪个 sessionId，以及“ID 变了就更新本条”。

#### 2.4.1 修改现有的 recent 规则

**位置**：`lib/index.js:1649` 这一句是当前冲突点：

```text
Do not list or scan all sessions, and never pick a worker that has not been used recently.
```

**替换为**：

```text
Do not list or scan all sessions. Do not pick a worker that has not been used recently unless a standing routing preference in memory names it as the owner for this kind of work; verify that owner before dispatch.
```

如果不改这一句，路由 memory 会和 prompt 直接冲突：模型一边看到“never pick a worker that has not been used recently”，一边看到“代码交给 session-edd7...”，最后很可能按 prompt 拒绝路由 memory。

#### 2.4.2 新增通用路由 bullet

**插入位置**：`lib/index.js:1651` 之后，也就是“用户点名 worker / 不选 subagent”那条之后。

```text
- A standing routing preference recorded in memory overrides the recent-worker default: when it names an owner for this kind of work, use that owner if it exists, is top-level, unarchived, and its cwd is usable. If the owner is missing, archived, busy, or ambiguous, fall back to the recent list or ask; never reassign a ticket that already has an executor.
```

#### 2.4.3 memory 保留的映射条

把原来的第 10 条替换为下面这条。保留 sessionId 是必要的，因为当前没有“按 title 解析角色”的稳定 API；但要把“核验”和“更新”写进去。

```text
- **worker-routing**：用户没点名 worker 时，代码类交 Ria开发（session-edd7b6d7-5f43-4c54-bb36-a182348ef3c6），文档/README/hero/图标/宣传素材交 Ria文档治理（session-3315a7c9-8e1d-41b5-9cdf-cb3e025ebed9）。派发前用 ria_status scope="sessions" 核验存在、top-level、未归档、cwd 可用；id 变了就更新本条。
```

**长期方案（P1，不在本次范围）**：给 `ria_status scope="sessions"` 加 `title` 过滤，或在 ria.json 增设 `routing` 配置（role → sessionId），memory 只留“代码归 Ria开发、文档归 Ria文档治理”这种角色名。这样 sessionId 变化时只改配置，不用改 memory。

### 2.5 合并后的两条运维 memory

#### restart-report（第 5 + 6 条合并）

```text
- **restart-report**：重启 dsh web 成功后，在下一次可交互时汇报 health、加载的插件 HEAD 与停机时长。做法：重启前用 schedule_create 挂一个约 60s 的一次性任务（target=this_session），触发后核验 health 与插件 HEAD 再汇报；不为此改插件代码（2026-11-11 决定）。
```

#### restart-method（第 7 + 8 条合并）

```text
- **restart-method**：从工具里重启 dsh web 必须用独立 transient unit 并带 KillMode=process，避免进程被 cgroup 回收：`systemd-run --user --collect --on-active=6s --property=KillMode=process --unit=ria-restart-$(date +%H%M%S) dsh-daemon restart`，预期 down≈4–5s。
```

同时建议在 `docs/operations.md` 增加一个“重启 dsh web”小节，把两条旧 memory 里的背景写进去：

- 为什么不能直接 `setsid + nohup`：工具进程属于 dsh-subprocess scope，web 关闭时会 `--kill-who=all` 把重启命令一起杀掉，watchdog 要等 120s 锁过期，实测 128s 空窗。
- 为什么必须带 `KillMode=process`：unit 退出时 systemd 默认按 control-group 回收 cgroup，会把刚拉起的 web 一起杀掉；不带时实测 24s 空窗，首代 web 被回收后由 watchdog 补起。

memory 里只留命令 + 一句原因，详细背景放文档。

## 3. 代码机制候选

不是所有“应该强制执行”的规则都适合现在写代码。逐条看：

| 规则 | 当前强制点 | 缺口 | 建议 |
|---|---|---|---|
| 用户交代的事有始有终 | `agent/pre-step` 自动 captureIntake + `agent/turn-stopping` 第二次自动 blocked | 已覆盖“不丢”，但 blocked 之后是否继续由 Ria 决定 | 不改 |
| worker 取消/叫停 | `lib/worker-idle.mjs` 检测 `aborted(user)`，working ticket 自动 blocked | 已覆盖取消；worker“明确拒绝”仍靠读消息 | 不改语义检测；可加 blocked guard |
| blocked 后不得擅自重派 | 只有 prompt `:1647` 约束 | `toolRequest()` 允许 blocked ticket 再次派发 | P1：对外 `ria_request` 检查 `status==='blocked' && waitingOn==='user'`，要求先 reopen；内部 retry/approval 不走 |
| 重启必须先征得同意 | 无 | bash 旁路无法可靠拦截 | 放 prompt；未来 `ria_restart` 可要求 `userConfirmed`，但不能替代 prompt |
| 重启后汇报 | 无 | `startup()` 干净重启在 `:4253` 直接 return | P1：重启前写 `restart-intent.json`，`startup()` 在 early return 前读并生成 receipt；需要新状态与测试 |
| 信息同步用 steer | prompt `:1657`/`:1659` | steer 没有“目标必须 running”的预检 | P1：`toolRequest()` 加 `steer_requires_running` |
| 固定路由 | 无 | 没有按 title 解析角色的 API | P2：`ria_status` title 过滤或 ria.json `routing` 配置 |
| 关注 worker | `[Worker idle]` 已能在 working ticket 结束时唤醒 Ria | 没有“关注”语义，需要 Ria 自己挂 working ticket | prompt 足够；不改代码 |

**关于 restart-report 的代码化**：最小可行方案不是“每次都自动发微信”，而是“有重启意图才回执”。具体是：在重启动作前写 `stateDir/restart-intent.json`（含 requestedAt、pluginHead、reason），`startup()` 读到后计算停机时长，在 early return 前把一条 `restart_receipt` 放进 outbox 或 Ria 的下一条 system notice。这样不会给用户无关的重启也发消息，也能区分“Ria 主动重启”和“用户手动重启”。但没有这个 intent 文件之前，restart-report 只能留在 memory。

## 4. 风险与冲突

### 4.1 与现有 prompt 的重复

- restart-consent 是新增，不重复。
- steer 那条与 `:1657` 语义重叠，但补的是正面用法；建议保留 `:1657` 的“不得夹带新任务”，不要再复制一遍“不要 queue 新工作”。
- 关注 worker 与 `:1662` 的 schedule 规则相邻，必须明确“worker 用 ticket，不要 timer”，否则模型可能两个都做。
- 路由规则与 `:1649` 的“never pick a worker that has not been used recently”直接冲突，必须同时改 `:1649`。这是本审计里最容易漏的一处。

### 4.2 对 prompt cache 的影响

- `ria-manager` 是 `order: 40` 的动态 section，每次 render 都会调 `managerPrompt()` 读 memory。memory 追加在整个 section 的最末尾（`:1677-1679`），这是正确的：改 memory 只动尾部，前面的大段规则仍是稳定前缀。
- 把规则从 memory 移到静态 prompt，会带来一次性的前缀变化；之后不再随 memory 编辑而变。对缓存是净收益，不是损失。
- 不要把 memory 或本轮状态插到 `## How you work` 前面。那样每次 memory 小改都会让后面所有 bullet 变成新前缀。
- 如果 provider 只做整请求缓存，任何 prompt 改动都会 miss 一次；这是不可避免的一次性成本，不要为了缓存把规则留在 memory。

### 4.3 dispatch-guard 不是放这些规则的地方

`lib/dispatch-guard.mjs` 是全局 section，装在所有 agent 上，包括 worker。把 Ria 的“重启要先问”“代码归 Ria开发”“关注 worker 要挂工单”放进去，会让 worker 也看到管理者规则，属于串味。它只适合保留现在那一句防误发。Ria 专属规则一律进 `managerPrompt()`。

### 4.4 多个工单并行时的串味

- 路由规则必须是“默认归属”，不是“所有代码工单都强制塞给同一个 worker”。如果 Ria开发 正在跑，第二张代码工单不能 queue 进去；按现有 `:1657`/`:1658` 用 `dependsOn` 或问用户。
- 已经有 executor 的工单不能因为路由规则被改派。上面的英文明确写了 `never reassign a ticket that already has an executor`。
- 如果固定 owner 归档、cwd 失效或不是 top-level，必须回落到 recent 或问用户；不能因为 memory 写了 ID 就硬发。现有 `ria_request` 预检会返回 `session_archived`/`workspace_missing`/`session_missing`，但最好在 prompt 层就先判断。

### 4.5 过度约束

- restart-consent 是安全偏好，不是普通软偏好；写进 prompt 合理。措辞用“without explicit consent”，保留用户当场说“重启”就执行的正常路径。
- 关注 worker 是稳定工作方式，写进 prompt 合理。
- steer 是工具语义，写进 prompt 合理。
- 路由是个人/安装级偏好，**不要**把“Ria开发”“Ria文档治理”或 sessionId 写进 `lib/index.js`。通用规则进 prompt，具体映射留 memory 或未来配置。
- restart-method 是环境事实，不要进 prompt。命令长、平台相关，放 memory + 运维文档。

### 4.6 迁移顺序与回滚

- 必须先落 prompt 改动，再删 memory 对应条目；反过来会有一段“规则空窗”。
- 旧 restart-report/restart-method 可以在同一次 memory 编辑里合并删除，因为它们只是重复，不涉及新规则。
- 如果 prompt 改动后模型行为不对，回滚 prompt 即可；memory 里的旧条在回滚前不要删。建议分两次提交/两次 memory 编辑：先 prompt，再清理 memory。

### 4.7 顺手发现的两个不一致（不在本任务范围）

- `lib/index.js:1649` 写 `scope="recent"` 返回 up to 5；`docs/tools.md` 的 `ria_status` 行写最多 10。至少有一处过时，建议后续统一。
- ria.json 的 recentWorkers 里还有已死引用 `session-2accf2cd`（cwd `/home/gkl/Desktop/vibe_proj/dsh-super-session` 已不存在）。如果模型按 recent 选到它，`ria_request` 会报 `workspace_missing`；这属于旧遗留，不是 memory 规则问题，但会干扰路由判断。

## 5. 排序

### P0：现在做，风险最低

1. **删 delegate-only-explicit**。`:1642` 已经逐字覆盖，删了没有任何行为损失。
2. **restart-consent 进 prompt，删 memory 条**。安全规则，当前无强制点。
3. **steer 正面用法进 prompt，删 memory 条**。只补一句，不改工具行为。
4. **关注 worker 进 prompt，删 memory 条**。和已有 `[Worker idle]` 机制对齐。
5. **合并 restart-report 两条、restart-method 两条**。只做去重，不改语义。

### P1：需要改一处 prompt 冲突或加代码 guard

6. **路由拆分**：改 `:1649` 的“never pick ... recently”，加通用路由 bullet，memory 换成当前映射。
7. **`ria_request` 的 blocked guard**：阻断 `blocked + waitingOn=user` 的再次派发，强制先 reopen。这能把“worker 拒绝/用户取消后不要擅自重派”从 prompt 变成硬约束。
8. **`ria_request` 的 steer running guard**：`steer_requires_running`，防止 steer 在 idle worker 上变成新 turn。
9. **startup restart receipt**：需要 `restart-intent.json` 和新测试，适合单独做。

### P2：长期

10. **路由配置化**：`ria_status` title 过滤或 ria.json `routing`，让 memory 只留角色名。
11. **`ria_restart` 工具**：带 `userConfirmed`，写 intent、走 transient unit。它只能覆盖正常路径，不能替代 prompt 的 consent 规则。

### 明确不建议迁移的

- **restart-method 进主提示词**：命令太长、环境相关、每次 turn 都用不到；放 memory + `docs/operations.md` 就够。
- **Ria 专属规则进 dispatch-guard**：它是全局 section，会污染 worker 的 system prompt。
- **把“Ria开发/文档治理”的 sessionId 写进 lib**：这是个人安装数据，不是通用插件逻辑；ID 过期后代码里会留下死引用。
- **用关键词扫描 bash 来强制 restart-consent**：不可靠，容易误伤；prompt + 可选 `ria_restart` 是更诚实的边界。
- **用模型语义判断“worker 拒绝”**：不稳定；保留 prompt + blocked 卡片，让用户决定，比自动检测后自动改派更安全。

## 6. 迁移后的 memory.md 建议形态

只保留 3 条，顺序建议：路由映射在前（最常用），两条 restart 在后（低频）。

```text
- **worker-routing**：用户没点名 worker 时，代码类交 Ria开发（session-edd7b6d7-5f43-4c54-bb36-a182348ef3c6），文档/README/hero/图标/宣传素材交 Ria文档治理（session-3315a7c9-8e1d-41b5-9cdf-cb3e025ebed9）。派发前用 ria_status scope="sessions" 核验存在、top-level、未归档、cwd 可用；id 变了就更新本条。
- **restart-report**：重启 dsh web 成功后，在下一次可交互时汇报 health、加载的插件 HEAD 与停机时长。做法：重启前用 schedule_create 挂一个约 60s 的一次性任务（target=this_session），触发后核验 health 与插件 HEAD 再汇报；不为此改插件代码（2026-11-11 决定）。
- **restart-method**：从工具里重启 dsh web 必须用独立 transient unit 并带 KillMode=process，避免进程被 cgroup 回收：`systemd-run --user --collect --on-active=6s --property=KillMode=process --unit=ria-restart-$(date +%H%M%S) dsh-daemon restart`，预期 down≈4–5s。
```

如果 P1 的 startup receipt 和路由配置落地，这两条 restart memory 还可以进一步缩短成指向文档的一行，memory 最终只剩路由角色名。

## 7. 一句话总结

**memory 应该只记“这个安装的偏好和环境事实”，不该记“Ria 本来就应该这样工作”的规则。** 这次审计里，restart-consent、steer、关注 worker 属于工作方式，应该进 prompt；路由属于安装偏好，拆成通用规则 + 当前映射；delegate/follow-through/取消处理已经被 prompt 和代码覆盖，直接删；restart-report/restart-method 各留合并后的一条。

## 8. 实施状态（2026-11-12）

已落地（本次改动）：

- §2.1 restart-consent：`lib/index.js:1658`，`## How you work` 第一条。
- §2.2 worker-notify-steer：`lib/index.js:1674`，steer 相关 bullet 之后。只插入前两句；`Steer must never carry a new task` 的语义已在 `lib/index.js:1671`（`steer only synchronises information into an already-running turn and must never carry a new task.`）存在，未重复粘贴。
- §2.3 关注 worker：`lib/index.js:1677`，紧跟 `[Worker idle]` 那条（`lib/index.js:1676`）；明确用 status=working ticket，不额外挂 schedule timer。
- `test/smoke.mjs:655-657` 三条断言分别覆盖上述三条。

未落地：

- §2.4 路由拆分（P1）：`lib/index.js:1663` 仍是 `never pick a worker that has not been used recently`，还没加通用路由 bullet；memory 里的映射也未改。
- §2.5 restart-report / restart-method 合并：`memory.md` 由用户维护，本次未动。
- 删除 5 条冗余 memory：`memory.md` 由用户维护，本次未动。
- §3 的 blocked guard、steer running guard、startup restart receipt：均为 P1，未做。