# 系统级「任务转交 · 防误发」提示调研

状态：已实施（DESIGN v0.29）。调研基线为 commit e2cac28；最终采用静态 system prompt section + 设置页开关，不再按 task 动态判断，也不再插入消息前缀。v0.29 把 section 文本收敛为简短英文，无标题，不提 Ria 或其他会话名。目标是把 ria_request 在任务派发时逐条插入的防误发文本，改为 DSH 系统级的通用行为约束。

## 0. 结论

最终实施：给每个 agent 注册一个 agent 作用域的静态 system prompt section；同时删除 task 派发时的整段消息前缀。

- 注入点：agent.ctx.systemPrompt.section，section 名称 dsh-ria:dispatch-guard，order 4100。
- 生效范围：所有 agent 都安装，文本是通用提示；用户明确接受「对所有 agent 生效」，因为它对普通会话无害。不再按 task 或 executor 动态判断。
- 开关：设置页「设置 > Ria」提供 dispatchGuard 开关，默认打开。关闭后 section 的 text 返回空字符串，DSH 的 renderPrompt 丢弃空 section。
- 注册时机：插件 apply 时遍历 ctx.agents.list() 补装；同时监听 agent/created。冷 worker 在 agent/created 时、排队消息释放前完成注册。
- 清理：section 返回 disposer；agent/disposed 和插件卸载时 dispose，按 agent id 去重。注册失败只 warn，不阻断插件加载。
- 前缀：已删除。task 派发和 quick relay 的 content 都原样发送，不加任何前缀或标记。
- 微信：微信入站消息进入 Ria，不直接进 worker；防误发由 worker 的系统提示提供，所以 UI 和微信入口最终一致。quick relay 仍然保持原文。
- 不改 worker preset、不改 AGENTS.md、不写 session 历史、不依赖 developer message。preset 无法给已开始会话换绑，AGENTS.md 是 user 角色且范围过大，developer message 没有自由文本 API。

## 1. 现状与问题

改造前实现（历史，相关前缀已删除）：

- /home/gkl/Desktop/vibe_proj/dsh-ria/lib/index.js:29 曾定义 DISPATCH_GUARD_TEXT。
- /home/gkl/Desktop/vibe_proj/dsh-ria/lib/index.js:678：
  const outboundContent = taskId ? [{ type: 'text', text: DISPATCH_GUARD_TEXT }, ...content] : content
- /home/gkl/Desktop/vibe_proj/dsh-ria/lib/index.js:702-704 把 outboundContent 写入 delivery 并调用 sessionController.prompt。
- /home/gkl/Desktop/vibe_proj/dsh-ria/lib/index.js:706 成功后才把 task 置为 working。
- quick relay（不带 taskId）保持原文；带 taskId 才加整段提示。

问题不在投递可靠性，而在提示的形态：

- 每条任务消息都重复同一段文字，属于消息内容而不是 Host 约束。
- 提示在 user 角色里，和用户原话混在一起，模型可能把它当成用户要求的一部分。
- 一段固定文字占每条派发的上下文；任务越多，重复越多。
- 用户明确认为这不够系统级，愿意为这个通用约束调整 worker 会话本身。

## 2. DSH 可用的系统级注入点（已核实）

### 2.1 agent 作用域的 system prompt section（推荐）

位置：/home/gkl/.nvm/versions/node/v26.2.0/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-system-prompt/lib/index.js

- :255 section(section) 在当前调用上下文的作用域注册有序 prompt section，返回 Cordis effect disposer。
- 用 agent.ctx.systemPrompt.section 调用时，作用域就是该 agent；同一作用域内重名会抛错（:205）。
- section 的 text 可以是 function(context)；:189 resolveContext 会调用 entry.text(context)。
- :358 assemble(context) 每步重新组装 global 和 scoped 层；scoped 同名会遮蔽 global（:365）。
- :119 renderPrompt 渲染 section；空字符串会被丢弃，不占系统提示。
- dsh-agent/lib/index.js:407 assembleContextFor 返回 { agent, scope: agent, signal }，所以 agent 作用域 section 能参与该 agent 的组装。

Agent loop 的时序：

- /home/gkl/.nvm/versions/node/v26.2.0/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-agent-loop/lib/index.js:679 先 assemble 系统提示。
- 同文件 :685 再跑 agent/pre-step。
- 同文件 :691-696 渲染 context sections，组装系统提示。
- 同文件 :843-850 refresh/project system prompt；system prompt 会作为 system/message 投影进 session，不是普通对话历史。

结论：这是真正的 system 角色、每步重新计算、按 agent 隔离，而且不触碰 session 内容。它能满足「系统级」；原需求还要求只对被派发的 worker 生效，但最终按用户决定改成静态文本安装到所有 agent（见 3.1），因为文本通用且对普通会话无害。

### 2.2 agent/pre-step（不能改系统提示）

位置：/home/gkl/.nvm/versions/node/v26.2.0/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-agent/lib/types/runtime-types.d.ts:332

- payload 是 { agent, messages, turn, step, signal, modelSelection }，next() 返回 PreStepDecision。
- :117 的 decision 只有 { kind: 'reject' } 或 { kind: 'enter', messages, startsRequestSeries? }。
- 它发生在系统提示 assemble 之后，只能拒绝本步或替换进入步骤的 user 消息，不能改系统提示。
- 在这里追加提示会变成 user 角色消息，可能进入历史、每步重复，可靠性也不如 system。结论：不采用。

### 2.3 agent preset（不能改造已有 worker）

位置：

- /home/gkl/.nvm/versions/node/v26.2.0/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-agent-preset/lib/index.js:13 Config.id，:25 agentPresets.register。
- /home/gkl/.nvm/versions/node/v26.2.0/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-agent-preset-registry/lib/index.js:766 select(agent, preset)。
- 同文件 :769：如果 openTurnStartSeq !== null 或 lastTurn > 0，抛 agent-preset/locked，信息是 This session has already started。

preset 是子插件列表，只能在空白会话上绑定；用户已有的 worker 大多已经开过 turn，无法换绑。重启时用的又是 session 里保存的 preset id。结论：技术上可以做专用 worker preset，但不能满足「已有 worker 也生效」，且会把一个通用提示扩大成整套 preset 差异。不采用。

### 2.4 AGENTS.md / CLAUDE.md

位置：/home/gkl/.nvm/versions/node/v26.2.0/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-agent-instructions/lib/index.js:1480

- pre-step 注入 baseline instructions；:1369 baselineContent，:1423 去重。
- README.zh.md 说明它们是 user 角色的持久 system-reminder 消息，不是 system 角色。
- 首次请求加载；外部新增或修改文件不会自动 watcher，需要文件系统 touch 或恢复时对账。
- $DSH_HOME/AGENTS.md 影响所有 session；项目链影响该 cwd 下的 session。

结论：范围太大，会污染用户自己的会话；需要写文件；更新依赖 touch/恢复；不是按 task 动态开关。不采用。

### 2.5 session/created 注入

位置：

- /home/gkl/.nvm/versions/node/v26.2.0/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-session/lib/types/index.d.ts:43 定义 session/created。
- /home/gkl/.nvm/versions/node/v26.2.0/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-session/lib/index.js:1909 发出事件。

session/created 发生在 agent 和 system prompt 作用域建立之前，拿不到 agent.ctx，也无法判断这条 session 之后会不会被 Ria 派发。结论：不可行。

### 2.6 developer / system message

位置：

- /home/gkl/.nvm/versions/node/v26.2.0/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-llm/lib/types/message.d.ts:140 DeveloperMessage。
- /home/gkl/.nvm/versions/node/v26.2.0/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-session/lib/types/types.d.ts:302 developer/message，:309 system/message。
- /home/gkl/.nvm/versions/node/v26.2.0/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-session/lib/index.js:335-347：developer/message 只允许工具增删，且 headerSeq 必须引用更早的 request/header。

没有「插件追加任意 developer 指令」的 API。SystemMessage 只由 agent loop 的 systemPrompt 投影产生，也没有任意文本 append 入口。结论：不可行。

### 2.7 全局 persona 配置

位置：dsh-system-prompt 的 personaPrefix / personaSuffix 是部署级配置，所有 agent 共用。不能只对被派发的 worker 生效。结论：不采用。

### 2.8 prompt source 是否能区分 Ria

位置：/home/gkl/.nvm/versions/node/v26.2.0/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-api-session-controller/lib/index.js:4048

- prompt() 在 :4054 构造 source = { kind: 'user', rpcId: request.requestId, ... }。
- UI 用户消息和 Ria 的 request 都走同一个 API，source 都是 user-rpc；模型看到的没有来源标记。

所以不能靠「Ria 的消息自动带特殊 source」来让 worker 识别，除非在内容里加标记。结论：系统提示方案不依赖 source 标记。

### 2.9 system-prompt context（备选，不推荐）

ctx.systemPrompt.context 可以注册 agent 作用域的动态 context，但渲染成 user 角色的 current-runtime-context 快照，权威性低于 system prompt；更适合运行时事实，不适合行为约束。结论：不采用。

## 3. 推荐设计

### 3.1 一个 section，静态文本

实施时改为静态方案，实际在 lib/dispatch-guard.mjs 增加：

- 名称：dsh-ria:dispatch-guard
- order：4100（在工具说明之后、TOOLS_SDK 5000 之前；避免和内置 section 的固定 order 冲突）
- interpolate：false
- text：一个函数；settings.dispatchGuard 为 true 时返回固定文本，否则返回空字符串。

原调研曾建议按 task 动态判断：遍历 store.tasks()，只对 status 为 open/working/blocked 且 executor 等于 agent id 的 agent 输出文本。用户最终决定不这样做，理由是：

- 提示是通用行为约束，对所有 agent 都无害；
- 静态文本不依赖 task 状态，不会因为 Ria 忘记更新 task 而多留或少留；
- 动态判断会让 system prompt 随 task 状态变化，增加 prompt cache 抖动和实现复杂度。

因此最终实现不安 executor 过滤，也不在 Ria 自己身上做例外；所有 agent 都安装同一个静态 section。

### 3.2 注册与生命周期

- 插件 apply 时遍历 this.ctx.agents.list()，对每个 live agent 调 installDispatchGuard(agent)。这解决「插件加载前已经存在的 worker」。
- 同时保留 ctx.on('agent/created', ...)，对新创建或冷恢复的 agent 注册。
- 冷 worker 被 sessionController.prompt 唤醒时，agent/created 在排队输入释放前触发；section 注册完成后第一步就能看到。
- 每个 agent 只注册一次；用 Map 记录 agent id 到 disposer，重复调用先 dispose 再注册，或直接跳过。
- 插件卸载时 dispose 所有 section；agent 销毁时 agent.ctx 也会自动 unwind。建议在 ctx.effect cleanup 中统一清理，避免插件重载时同名 section 抛错。
- 如果注册抛错（例如同名 section 已存在），记录 warn，不阻断插件加载；不要因此回退到消息前缀。

### 3.3 文本措辞

去掉「这条消息前面有一段提示」的假设，改成对「最新一条用户消息」的判断。v0.29 的实际实现是一段简短英文，没有标题，不提 Ria 或其他会话名：

The latest message may not belong to this session's current work. If it is clearly unrelated to what the session is doing, ask the user to confirm before acting on it.

这段文本是静态的，对所有 agent 都存在。它不假设消息一定来自转交，也不点名任何会话；只规定最新消息与当前工作明显无关时先向用户确认，不再补充空闲或相关时如何处理的说明。

### 3.4 前缀：已删除

实施结果：

- task 派发不再插入 DISPATCH_GUARD_TEXT；delivery 和 prompt 都直接使用原 content。
- quick relay 保持原文语义。
- 历史 session 里已经存在的旧前缀保留，不迁移。system prompt 不是对话历史，不需要迁移；旧前缀只是历史消息的一部分。
- 新派发没有任何前缀或标记，因此不会出现「系统提示 + 前缀」双重提示，也不会出现「系统提示 + 一行标记」。

用户已确认完全无标记，不再保留 [任务转交] 行。

### 3.5 对已有 worker、历史和重启的影响

已有 live worker：

- 插件 apply 遍历 agents.list() 后立即生效；下一步系统提示就包含 section。
- 是否出现与 task 无关；开关打开就出现，开关状态从 ria.json 恢复。

冷 worker：

- 没有 live agent，无法提前注册；下一次 prompt 触发 agent/created 时注册。
- 注册发生在 queued input 释放之前，第一步就能看到。

历史消息：

- 不需要迁移，也不应该改写历史。
- 旧消息里的前缀仍然存在；新消息没有。模型看到的是「旧消息带前缀、新消息靠系统提示」，这是可接受的过渡状态。

重启：

- 插件重新 apply，遍历 live agents 或等待 agent/created，section 重新注册。
- 开关状态从 ria.json 的 settings.dispatchGuard 恢复，不依赖 task 状态。
- 不需要把提示写进 session 文件，也不需要改 worker 配置。

升级/重装：

- 没有持久化的 worker preset 或 session 配置需要回退；升级只换代码。
- 如果回退到旧版本，旧版本会重新插入前缀；新版本遗留的历史前缀不会被删除。
- 如果插件被卸载但 agent 还活着，已注册 section 应在插件 cleanup 中 dispose；否则同名重载可能抛错。这是实现时必须处理的点。

### 3.6 对所有 agent 生效

- 不再按 task.executor 过滤；所有 live agent 和新建 agent 都安装同一个静态 section。
- 文本明确说明「不代表当前消息一定是转交任务」，普通会话不会因为这段提示误判。
- 用户已确认通用提示无害；关闭开关后所有 agent 的 section 文本为空，DSH 会丢弃空 section。
- 不写任何持久标记到 worker session，不污染用户自己的会话。
- 唯一副作用：一个仍处于 blocked 的 task 会让该 worker 在用户直接对话时也看到这段提示。这是任务仍 active 的合理代价；任务关闭后消失。

### 3.7 与微信入口的一致性

- 微信入站消息进入 Ria，不直接进 worker；Ria 仍是唯一派发者。
- 防误发挂在「带 taskId 的派发」上，与任务来源是 UI 还是微信无关。
- 所以微信来源的任务和 UI 来源的任务得到同一条系统提示，不存在入口不一致。
- quick relay 仍然原文转发，不带提示；如果用户希望微信 quick relay 也带提示，那是另一个产品决定，不应混进本次系统级改造。

## 4. 方案对比

| 方案 | 侵入性 | 可靠性 | 上下文开销 | 重启后保持 | 升级/重装回退 | 实现复杂度 | 精确归因 |
|---|---|---|---|---|---|---|---|
| agent 作用域 system prompt section（推荐） | 低：内存注册，不改 session/preset/文件 | 高：system 角色，每步组装 | 开关打开时每个 system prompt 一小段；关闭为 0 | 是：重新注册，开关从 ria.json 恢复 | 代码级，无需回退配置 | 低到中 | 无：通用提示，不区分消息 |
| 保留整段消息前缀 | 低：只改消息内容 | 高：每条派发都可见 | 每条派发重复一段 | 是：delivery 里保存了 content | 代码级 | 低 | 高：每条消息自带说明 |
| 改 worker preset | 高：整套 preset 差异 | 高：preset 内可写系统提示 | 取决于 preset | 是：session 保存 preset id | 需要迁移/重建 | 中到高 | 高 |
| AGENTS.md / CLAUDE.md | 中高：写文件，影响范围大 | 中：user 角色 reminder | 每个相关 session 都带 | 是：文件持久化 | 文件需手动清理 | 中 | 低：无法按 task 开关 |
| agent/pre-step 注入 user 消息 | 中：每步改消息 | 中：user 角色，可能被忽略 | 每步或每次派发重复 | 取决于实现 | 代码级 | 中 | 可做到按 requestId |
| developer message | 低 | 高（如果可用） | 一次 | 是 | 代码级 | 高 | 高 |
| 全局 persona | 高：所有 agent | 高 | 所有会话都带 | 是 | 配置回退 | 低 | 无 |

补充：

- preset 的致命问题是 :769 的 locked：已有 turn 的 worker 不能换 preset。用户明确允许改 worker，但这条路不能覆盖存量会话，所以不选。
- AGENTS.md 的致命问题是范围和角色：它影响该 cwd 下所有 session，且是 user 角色 system-reminder，不是 system。
- pre-step 的致命问题是它发生在系统提示组装之后，只能改 user 消息；要按 requestId 精确注入也不是不行，但会写历史、增加复杂度，收益不如 section。
- developer message 没有自由文本入口；session/created 没有 agent 作用域。这两个方向在当前 DSH 版本直接不可行。

## 5. 落地步骤（已执行）

1. 新建 lib/dispatch-guard.mjs，导出 DISPATCH_GUARD_SECTION_NAME、DISPATCH_GUARD_SECTION_ORDER、DISPATCH_GUARD_TEXT 和 DispatchGuard。
2. DispatchGuard.install 调 agent.ctx.systemPrompt.section，name 固定，order 4100，interpolate=false，text 根据 settings.dispatchGuard 返回静态文本或空字符串；disposer 存进 Map，按 agent id 去重。
3. lib/index.js 的 apply 中调用 dispatchGuard.installAll()，订阅 agent/created 与 agent/disposed，并在 ctx.effect cleanup 统一 dispose。
4. 删除 toolRequest 里的 outboundContent 拼接；delivery 和 prompt 直接使用 content。
5. 更新 manager prompt 和 ria_request 的工具描述：防误发由 worker 系统提示提供，不加消息前缀，模型不要手写。
6. 补测试：
   - test/dispatch-guard.mjs 覆盖安装、agent/created 与 disposed、重复安装、开关文本、失败 warning、shutdown；
   - test/smoke.mjs 覆盖 worker 和 Ria 都安装 section、默认文本、POST /settings 关闭后 text 为空、再次打开恢复、非法值 400、GET /state 的 settings；
   - task 派发 content 只有一段原文；quick relay 也只有一段原文。
7. README.md、docs/DESIGN.md 第 6 节、设置页、Phase 13、验收和实现状态已更新。
8. 设置页已在隔离 DSH 中真实点击验证；section 安装、开关和空文本同时由单元测试和 smoke 覆盖。
9. npm test 九个 suite 全绿后提交；真实 ~/.dsh/profiles/web 仍不安装。

## 6. 风险与限制

- 系统提示是行为约束，不是硬拦截；模型仍可能不遵守。它比消息前缀更权威，但插件无法验证 worker 是否真的先问用户。
- 静态文本对所有 agent 生效。用户已确认这是可接受的，因为文本不假设消息来自转交，也不点名任何会话，对普通会话无害。
- 系统提示每步重新组装；文本固定，不会每步抖动。开关切换时会有一次系统提示变化，可能影响 prompt cache。
- 如果插件重载时旧 section 没有 dispose，同名注册会抛错。实现用 Map + cleanup，并在注册失败时记录 warn。
- 已存在的旧前缀不能从历史里删除；旧消息带前缀、新消息靠系统提示，这是可接受的过渡状态。
- 隔离测试 profile 没有配置模型，无法验证真实模型是否按提示先确认；只能验证 section 是否安装、文本是否随开关变化，以及消息内容是否还有前缀。
- 设置页只开关该 section，不改变 worker 的 tools、preset 或历史，也不做硬拦截。

## 7. 已确认

1. 采用 agent 作用域 system prompt section，而不是消息前缀。
2. 使用静态文本，对所有 agent 生效；不按 task 或 executor 动态判断。
3. task 派发和 quick relay 都不加任何前缀或标记。
4. 增加设置页开关，默认打开；关闭后 section 文本为空。
5. 已实现并通过单元测试与 smoke；设置页真实点击已验证，真实模型行为尚未验证。
