# 系统级「任务转交 · 防误发」提示调研

状态：调研完成，未改代码，等待确认。目标是把 super_session_request 在任务派发时逐条插入的防误发文本，改为 DSH 系统级的通用行为约束。调研基线为 commit e2cac28。

## 0. 结论

推荐方案只有一个：给每个 worker agent 注册一个 agent 作用域的 system prompt section，由 Host 按当前 task 状态动态决定是否输出防误发提示；同时删除 task 派发时的整段消息前缀。

- 注入点：agent.ctx.systemPrompt.section，section 名称建议 dsh-super-session:dispatch-guard，order 4100。
- 生效范围：只对「当前有未结束 task，且 task.executor 等于该 agent id」的 agent 输出文本；其他 agent 输出空字符串，DSH 会丢弃空 section。
- 注册时机：插件 apply 时遍历 ctx.agents.list() 补装；同时监听 agent/created。冷 worker 在下一次被 prompt 唤醒、agent/created 触发时、排队消息释放前完成注册。
- 清理：section 返回 disposer，插件卸载时逐个 dispose；agent 销毁时其 ctx 也会自动 unwind。
- 前缀：建议替换，不保留整段前缀。历史消息里已有的前缀不迁移，也没必要迁移；新派发不再插入。
- 标记：默认不需要额外标记。若必须精确归因，最多保留一行 [任务转交]，不要保留整段说明。这一项需要用户确认。
- 微信：微信入站消息进入 Super，不直接进 worker；防误发只挂在 Super 到 worker 的任务派发上，所以 UI 和微信入口最终一致。quick relay 仍然保持原文。
- 不改 worker preset、不改 AGENTS.md、不写 session 历史、不依赖 developer message。preset 无法给已开始会话换绑，AGENTS.md 是 user 角色且范围过大，developer message 没有自由文本 API。

## 1. 现状与问题

当前实现：

- /home/gkl/Desktop/vibe_proj/dsh-super-session/lib/index.js:29 定义 DISPATCH_GUARD_TEXT。
- /home/gkl/Desktop/vibe_proj/dsh-super-session/lib/index.js:678：
  const outboundContent = taskId ? [{ type: 'text', text: DISPATCH_GUARD_TEXT }, ...content] : content
- /home/gkl/Desktop/vibe_proj/dsh-super-session/lib/index.js:702-704 把 outboundContent 写入 delivery 并调用 sessionController.prompt。
- /home/gkl/Desktop/vibe_proj/dsh-super-session/lib/index.js:706 成功后才把 task 置为 working。
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

结论：这是真正的 system 角色、每步重新计算、按 agent 隔离，而且不触碰 session 内容。它满足「系统级」和「只对被派发的 worker 生效」两个要求。

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

session/created 发生在 agent 和 system prompt 作用域建立之前，拿不到 agent.ctx，也无法判断这条 session 之后会不会被 Super 派发。结论：不可行。

### 2.6 developer / system message

位置：

- /home/gkl/.nvm/versions/node/v26.2.0/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-llm/lib/types/message.d.ts:140 DeveloperMessage。
- /home/gkl/.nvm/versions/node/v26.2.0/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-session/lib/types/types.d.ts:302 developer/message，:309 system/message。
- /home/gkl/.nvm/versions/node/v26.2.0/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-session/lib/index.js:335-347：developer/message 只允许工具增删，且 headerSeq 必须引用更早的 request/header。

没有「插件追加任意 developer 指令」的 API。SystemMessage 只由 agent loop 的 systemPrompt 投影产生，也没有任意文本 append 入口。结论：不可行。

### 2.7 全局 persona 配置

位置：dsh-system-prompt 的 personaPrefix / personaSuffix 是部署级配置，所有 agent 共用。不能只对被派发的 worker 生效。结论：不采用。

### 2.8 prompt source 是否能区分 Super

位置：/home/gkl/.nvm/versions/node/v26.2.0/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-api-session-controller/lib/index.js:4048

- prompt() 在 :4054 构造 source = { kind: 'user', rpcId: request.requestId, ... }。
- UI 用户消息和 Super 的 request 都走同一个 API，source 都是 user-rpc；模型看到的没有来源标记。

所以不能靠「Super 的消息自动带特殊 source」来让 worker 识别，除非在内容里加标记。结论：系统提示方案不依赖 source 标记。

### 2.9 system-prompt context（备选，不推荐）

ctx.systemPrompt.context 可以注册 agent 作用域的动态 context，但渲染成 user 角色的 current-runtime-context 快照，权威性低于 system prompt；更适合运行时事实，不适合行为约束。结论：不采用。

## 3. 推荐设计

### 3.1 一个 section，动态文本

建议在 lib/index.js 增加：

- 名称：dsh-super-session:dispatch-guard
- order：4100（在工具说明之后、TOOLS_SDK 5000 之前；避免和内置 section 的固定 order 冲突）
- text：一个函数，返回字符串或空字符串。

判断逻辑：

- 遍历 this.store.tasks()。
- 找到 status 为 open、working 或 blocked，且 executor === String(agent.id) 的 task。
- 找到则返回防误发文本；否则返回空字符串。
- executor 为 self 的 Super 任务不会命中任何 agent id，所以 Super 自己不会出现这段提示。
- subagent 不作为 task executor（toolRequest 已拒绝 parentSessionId 和 origin=subagent），所以它们即使被注册也不会命中。

为什么把 blocked 也算 active：blocked 表示任务还没结束，Super 可能随后带 taskId 继续派发；如果 section 在 blocked 时消失，continuation 就没有提示。done 和 cancelled 不算 active，任务结束后提示自动消失。

### 3.2 注册与生命周期

- 插件 apply 时遍历 this.ctx.agents.list()，对每个 live agent 调 installDispatchGuard(agent)。这解决「插件加载前已经存在的 worker」。
- 同时保留 ctx.on('agent/created', ...)，对新创建或冷恢复的 agent 注册。
- 冷 worker 被 sessionController.prompt 唤醒时，agent/created 在排队输入释放前触发；section 注册完成后第一步就能看到。
- 每个 agent 只注册一次；用 Map 记录 agent id 到 disposer，重复调用先 dispose 再注册，或直接跳过。
- 插件卸载时 dispose 所有 section；agent 销毁时 agent.ctx 也会自动 unwind。建议在 ctx.effect cleanup 中统一清理，避免插件重载时同名 section 抛错。
- 如果注册抛错（例如同名 section 已存在），记录 warn，不阻断插件加载；不要因此回退到消息前缀。

### 3.3 文本措辞

去掉「这条消息前面有一段提示」的假设，改成对「最新一条用户消息」的判断。建议文本：

本会话可能收到由其他会话（Super Session）转交的任务。
- 如果最新一条用户消息与本会话正在做的事明显不同，或与本会话上下文完全对不上：可能发错了会话，请先向用户确认，不要直接执行。
- 如果本会话空闲、刚建立，或消息与当前任务相关：按正常任务执行，不要因为这段提示额外确认。

这段文本只在 task active 时出现，因此不需要每句话都重复「这是转交任务」；它约束的是当前这段派发生命周期。

### 3.4 前缀：替换，不重复

建议：

- task 派发不再插入 DISPATCH_GUARD_TEXT；outboundContent 就是 content。
- 保留 quick relay 的原文语义。
- 历史 session 里已经存在的旧前缀保留，不迁移。system prompt 不是对话历史，不需要迁移；旧前缀只是历史消息的一部分。
- 新派发不再有整段前缀，因此不会出现「系统提示 + 前缀」双重提示。

可选的精确归因：

- 如果用户希望 worker 能明确知道「这条是 Super 转交的」，可以只保留一行 [任务转交] 作为消息开头，而不是整段说明。
- 但推荐的通用措辞不依赖这个标记；不加标记也不会影响判断。
- 需要用户确认选「完全无前缀」还是「一行标记」。

### 3.5 对已有 worker、历史和重启的影响

已有 live worker：

- 插件 apply 遍历 agents.list() 后立即生效；下一步系统提示就包含 section。
- 已经存在的 task 状态从 super.json 恢复，所以不需要重新派发就能恢复提示。

冷 worker：

- 没有 live agent，无法提前注册；下一次 prompt 触发 agent/created 时注册。
- 注册发生在 queued input 释放之前，第一步就能看到。
- 如果 worker 是被 Super 用 taskId 唤醒的，task 在 super.json 里已经是 open/working/blocked，section 文本非空。

历史消息：

- 不需要迁移，也不应该改写历史。
- 旧消息里的前缀仍然存在；新消息没有。模型看到的是「旧消息带前缀、新消息靠系统提示」，这是可接受的过渡状态。

重启：

- 插件重新 apply，遍历 live agents 或等待 agent/created，section 重新注册。
- task 状态持久化，提示是否出现完全由 task 状态决定。
- 不需要把提示写进 session 文件，也不需要改 worker 配置。

升级/重装：

- 没有持久化的 worker preset 或 session 配置需要回退；升级只换代码。
- 如果回退到旧版本，旧版本会重新插入前缀；新版本遗留的历史前缀不会被删除。
- 如果插件被卸载但 agent 还活着，已注册 section 应在插件 cleanup 中 dispose；否则同名重载可能抛错。这是实现时必须处理的点。

### 3.6 只对被 Super 派发的 worker 生效

- 判断依据是 task.executor，不是「这个 session 是否被 Super 创建」。
- 用户自己开的普通会话没有 task，section 文本为空，不占上下文。
- worker 的 task 结束后，section 文本变为空，下次系统提示自动去掉。
- 不写任何持久标记到 worker session，不污染用户自己的会话。
- 唯一副作用：一个仍处于 blocked 的 task 会让该 worker 在用户直接对话时也看到这段提示。这是任务仍 active 的合理代价；任务关闭后消失。

### 3.7 与微信入口的一致性

- 微信入站消息进入 Super，不直接进 worker；Super 仍是唯一派发者。
- 防误发挂在「带 taskId 的派发」上，与任务来源是 UI 还是微信无关。
- 所以微信来源的任务和 UI 来源的任务得到同一条系统提示，不存在入口不一致。
- quick relay 仍然原文转发，不带提示；如果用户希望微信 quick relay 也带提示，那是另一个产品决定，不应混进本次系统级改造。

## 4. 方案对比

| 方案 | 侵入性 | 可靠性 | 上下文开销 | 重启后保持 | 升级/重装回退 | 实现复杂度 | 精确归因 |
|---|---|---|---|---|---|---|---|
| agent 作用域 system prompt section（推荐） | 低：内存注册，不改 session/preset/文件 | 高：system 角色，每步组装 | 无 active task 时为 0；active 时一小段 | 是：重新注册，task 状态持久化 | 代码级，无需回退配置 | 低到中 | 依赖 task 状态，不依赖消息标记 |
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

## 5. 落地步骤（待确认后执行）

1. 在 lib/index.js 增加 DISPATCH_GUARD_SECTION_TEXT（替换现有 DISPATCH_GUARD_TEXT 的用途）和 installDispatchGuard(agent)。
2. installDispatchGuard 调 agent.ctx.systemPrompt.section，name 固定，order 4100，text 用闭包检查 store.tasks() 与 agent.id；把 disposer 存进 Map。
3. apply 中遍历 this.ctx.agents.list() 补装，并保留 agent/created 注册；增加 ctx.effect cleanup 统一 dispose 所有 section。
4. 删除 toolRequest 里的 outboundContent 拼接（lib/index.js:678），delivery 和 prompt 直接使用 content。
5. 更新 manager prompt 和 super_session_request 的工具描述：Host 通过 worker 的系统提示提供防误发约束，模型不要手写；quick relay 仍然原文。
6. 补测试：
   - mock agent.ctx.systemPrompt.section 捕获 name/order/text；
   - 没有 task 时 text 为空；open/working/blocked 且 executor 匹配时非空；done/cancelled 后为空；
   - Super 和无关 worker 为空；
   - 已有 live agent 在 apply 时被注册；agent/created 也会注册；
   - cleanup 会 dispose；重复注册不抛错；
   - task 派发的 content 不再包含前缀；quick relay 仍是一段原文。
7. 更新 README.md、DESIGN.md 第 6 节和实现状态；新增本文档链接。
8. 在隔离 DSH 环境验证：创建一个 worker、给它一个 task，检查 session 的 system/message 投影里出现该 section；task 结束后下一次请求不再出现；确认没有改动 worker 的 tools/preset。
9. npm test 全绿后再提交；真实 ~/.dsh/profiles/web 仍不安装，等用户确认。

## 6. 风险与限制

- 系统提示是行为约束，不是硬拦截；模型仍可能不遵守。它比消息前缀更权威，但插件无法验证 worker 是否真的先问用户。
- task 状态不及时会导致提示多留或少留：Super 忘记把 task 置 done，提示会继续存在；task 还是 open 但派发失败，提示也会存在。需要 Super 维护 task 状态，和现有设计一致。
- 系统提示每步重新组装；task 状态不变时文本稳定，不会每步抖动；task 状态变化时会有一次系统提示变化，可能影响 prompt cache。相比每条消息重复前缀，长期开销更小。
- 如果插件重载时旧 section 没有 dispose，同名注册会抛错。实现必须用 Map + cleanup，并在注册失败时记录 warn，不能静默重复。
- 已存在的旧前缀不能从历史里删除；新旧格式会共存一段时间。这是可接受的迁移成本。
- 隔离测试 profile 没有配置模型，无法验证真实模型是否按提示先确认；只能验证 section 是否进入系统提示，以及消息内容是否还有前缀。
- 如果用户选择保留一行 [任务转交] 标记，系统提示应明确「只有带这个标记的消息才是转交任务」，否则不要提标记，避免模型把普通消息误判为转交。

## 7. 需要确认

1. 是否按推荐方案替换整段前缀，默认完全不加标记？
2. 如果要精确归因，是否接受保留一行 [任务转交]？
3. active 状态是否按 open、working、blocked 计算？（推荐是；done/cancelled 不算。）
4. 确认后再实现、补测试、更新文档；现在不动代码。
