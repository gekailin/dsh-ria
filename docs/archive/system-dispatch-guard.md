# 系统级「任务转交 · 防误发」提示（归档）

> 状态：历史设计（2026-11-13）· 已实施

现行文档见 [design-history.md](design-history.md)（第 6 节防误发提示）、[operations.md](../operations.md)（防误发提示一节）。

## 背景与目标

- 改造前在 `lib/index.js:29` 定义 `DISPATCH_GUARD_TEXT`，`:678` 在带 `taskId` 的派发里把整段提示作为第一条 `text` 拼进 content，`:702-704` 写 delivery 后调 `sessionController.prompt`，`:706` 成功才把 task 置 working；quick relay 不带前缀。
- 问题不在投递可靠性，而在提示形态：每条任务重复同一段文字；内容处在 user 角色，与用户原话混在一起，模型可能当成用户要求的一部分；固定文字占每条派发的上下文，任务越多重复越多。
- 目标：把「防误发」从消息内容改成 DSH 系统级的通用行为约束；对所有会话生效、可开关、可回退；不改 worker preset、不改 `AGENTS.md`、不写 session 历史。

## 关键决策（含理由）

- **采用 agent 作用域的 system prompt section**（`agent.ctx.systemPrompt.section`）：真正的 system 角色、每步重新计算、按 agent 隔离、不触碰 session 内容（`dsh-system-prompt/lib/index.js:255` section、`:358` assemble、`:119` renderPrompt 丢弃空串）。
- **不采用消息前缀**：它是消息内容而非 Host 约束；user 角色易被当作指令；每条派发都重复占上下文。已整段删除。
- **不采用 AGENTS.md / CLAUDE.md**：`$DSH_HOME/AGENTS.md` 影响所有 session、项目链影响该 cwd 下所有 session，范围过大；它是 user 角色的持久 system-reminder，不是 system（`dsh-agent-instructions/lib/index.js:1480`、`:1369`、`:1423`）；外部修改需 touch 或恢复对账才生效。
- **不采用 worker preset**：`dsh-agent-preset-registry/lib/index.js:769` 在 `openTurnStartSeq !== null` 或 `lastTurn > 0` 时抛 `agent-preset/locked`（`This session has already started`），已有 turn 的 worker 无法换绑；重启时用的又是 session 里保存的 preset id。
- **不采用 agent/pre-step**：它发生在系统提示 assemble 之后（`dsh-agent-loop/lib/index.js:679` 先 assemble、`:685` 才 pre-step），只能拒步或替换进入步骤的 user 消息，追加内容会变成 user 角色并进入历史。
- **不采用 developer/system message**：`developer/message` 只允许工具增删且 headerSeq 必须引用更早的 request（`dsh-session/lib/index.js:335-347`），`SystemMessage` 只由 systemPrompt 投影产生，都没有自由文本入口。
- **不采用 session/created**：它发生在 agent 与 system prompt 作用域建立之前，拿不到 `agent.ctx`。**不采用全局 persona**：`personaPrefix/personaSuffix` 是部署级、所有 agent 共用。**不采用 systemPrompt.context**：渲染成 user 角色的 current-runtime-context 快照，权威性低于 system。
- **最终改为静态文本，不做按 task 的动态判断。** 原调研曾建议遍历 `store.tasks()`，只对 `open/working/blocked` 且 executor 匹配的 agent 输出。理由：通用约束对所有 agent 无害；静态文本不依赖 task 状态，不会因 Ria 忘更新 task 而多留或少留；动态判断会让 system prompt 随 task 状态变化，增加 prompt cache 抖动与实现复杂度。因此不安 executor 过滤，也不给 Ria 自己例外。
- **文本不点名 Ria、不提「消息来自转交」**：`prompt()` 在 `dsh-api-session-controller/lib/index.js:4048` 统一构造 `source.kind='user'`（`:4054`），UI 用户消息与 Ria 的请求在模型眼里没有来源差别，靠 source 区分不可行，只能靠通用措辞。

## 关键机制与数字

- section：名字 `dsh-ria:dispatch-guard`，order `4100`（工具说明之后、`TOOLS_SDK` 5000 之前，避免与内置 section 的固定 order 冲突），`interpolate: false`。
- 文本（v0.29）是简短英文两句、无标题：`The latest message may not belong to this session's current work. If it is clearly unrelated to what the session is doing, ask the user to confirm before acting on it.`
- `text` 是函数：`settings.dispatchGuard` 为 true 时返回固定文本，否则返回空字符串；空 section 被 `renderPrompt` 丢弃，不占系统提示。
- 开关在「设置 > Ria」，默认打开，持久化在 `ria.json` 的 `settings.dispatchGuard`；关闭只影响后续 system prompt，不改历史消息、tools、preset，不做硬拦截。
- 派发与 quick relay 都不再加任何前缀或标记（用户已确认完全无标记，不保留 `[任务转交]` 行）；历史 session 里已存在的旧前缀保留、不迁移，因为 system prompt 不是对话历史。
- 微信入站消息进 Ria、不直接进 worker，防误发由 worker 的系统提示提供，所以 UI 与微信两个入口最终一致。
- 生命周期：插件 `apply` 时遍历 `ctx.agents.list()` 对每个 live agent 调 `installDispatchGuard`（覆盖插件加载前已存在的 worker）；订阅 `agent/created` 覆盖新建与冷恢复，注册发生在排队输入释放之前，第一步就能看到；`agent/disposed` 与插件卸载时 dispose，disposer 存 `Map` 按 agent id 去重；注册抛错（如同名 section 已存在）只 `warn`，不阻断插件加载，也不回退到消息前缀。

## 实现状态

- 已实施。新增 `lib/dispatch-guard.mjs`，导出 `DISPATCH_GUARD_SECTION_NAME`、`DISPATCH_GUARD_SECTION_ORDER`、`DISPATCH_GUARD_TEXT` 和 `DispatchGuard`；`DispatchGuard.install` 调 `agent.ctx.systemPrompt.section`，`lib/index.js` 的 apply 调 `installAll()`，并在 `ctx.effect` cleanup 统一 dispose。
- 已删除 `toolRequest` 里的 `outboundContent` 拼接，delivery 与 prompt 直接用原 content；manager prompt 和 `ria_request` 工具描述改为「由 worker 系统提示提供，模型不要手写前缀」。
- 测试：`test/dispatch-guard.mjs` 覆盖安装、`agent/created` 与 `agent/disposed`、重复安装、开关文本、失败 warning、shutdown；`test/smoke.mjs` 覆盖 worker 与 Ria 都装 section、默认文本、`POST /settings` 关闭后 text 为空、再次打开恢复、非法值 400、`GET /state` 的 settings，以及 task 派发与 quick relay 的 content 只有一段原文。`npm test` 九个 suite 全绿；设置页在隔离 DSH 中真实点击验证。
- 归档时真实 `~/.dsh/profiles/web` 仍未安装。

## 仍未实现 / 风险

- **系统提示是行为约束，不是硬拦截**：模型仍可能不遵守；插件无法验证 worker 是否真的先问用户。这比消息前缀更权威，但做不到强制。
- 静态文本对所有 agent 生效（含 Ria 自己与用户自己的会话），用户已确认无害；唯一副作用是一个仍 blocked 的 task 会让该 worker 在用户直接对话时也看到提示，任务关闭后消失。
- 隔离测试 profile 没有配置模型，真实模型是否按提示先确认**未验证**，只能验证 section 安装、文本随开关变化、消息无前缀。
- 旧前缀留在历史里，形成「旧消息带前缀、新消息靠系统提示」的过渡态；回退到旧版本会重新插入前缀，新版本遗留的历史前缀不会被删除。
- 插件重载若未 dispose 旧 section，同名注册会抛错；已用 `Map` + cleanup 处理，但这是实现时必须守住的不变量。
- 版本号记录不一致：源文标注 DESIGN v0.29，历史设计稿记为 v0.23。

## 现行文档

- [design-history.md](design-history.md)：第 6 节防误发提示、`settings.dispatchGuard`、Phase 13。
- [operations.md](../operations.md)：现行说明，明确防误发不是消息前缀，而是 name=`dsh-ria:dispatch-guard`、order=4100 的 section。
