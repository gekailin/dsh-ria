# Ria 审批自动化设计（归档）

> 状态：历史设计（2026-11-13）· 方案未实现

现行文档见 [design-history.md](design-history.md)（审批 observer 与 ria_approval 只读契约）、[operations.md](../operations.md)（「审批等待」一节）、[tools.md](../tools.md)。

## 背景与目标

- 用户问「你现在有逐一审批的能力吗」，答案是「没有」：Ria 只能看到 worker 卡在审批，不能替用户允许或拒绝，微信侧完全无法处理。
- 目标：在用户明确授权下逐条允许/拒绝；用少量确定性规则自动处理重复、低风险、可精确描述的审批；每次自动决定都带规则 id、参数摘要、actor 与结果写入 `audit.jsonl`；默认关闭、随时回退；失败 fail closed；复用现有 ticket、attention、outbox、微信镜像，不另起调度器。
- 非目标：不做第二个 approval service、不改宿主 `dsh-user-approval`；不把结果持久化成「永久允许」（持久授权只走 `ria_grant`）；worker/Ria 不能创建或修改规则；P0/P1 不做 Ria 自主 allow。

## 关键决策（含理由）

1. **推荐方案 C：规则先行，Ria 转人工兜底。** 低风险、可精确匹配的请求由规则直接 `allowed-once`；仍余下的交 Ria 转给用户。理由：规则确定、可复现、可审计而人是最终权限边界，且可分阶段上线。
2. **不做 Ria 自主裁决（A2）。** 审批的 `reason` 与工具参数都来自 worker 内容，可能被 prompt injection 污染；LLM 判断不可复现、不可解释；失败模式是静默放行；与 `ria_grant` 的「用户显式授权」语义冲突。未来最多允许「自动拒绝、不能自动允许」。
3. **规则只做「减少重复确认」，不做「永久提权」。** 每条规则只影响一次 `allowed-once`，不调 `setPolicy`、不改 sandbox、不产生 grant。
4. **拒绝/超时/取消后工单不自动回 working**，留在 `blocked/waitingOn=user`。理由：worker 已拿不到权限，工单不能假装还在正常执行。现行 `ApprovalObserver.releaseTicket` 无论结果都回 working，是本设计要改的行为。
5. **审批必须在 worker 当前 turn 内闭环。** 宿主 `dsh-user-approval/lib/index.js:155` 要求 turnOpen，不能「存起来等重启」，只能 fail closed；pending 只存内存。
6. **不能双应答者竞速。** 调用 `next()` 后不能再返回自己的 outcome，「先等 20 秒没人点再交给 UI」不可行；要么接管，要么交给原生 UI。
7. **P0 默认 `observe`**，行为与现在逐字节一致；只有用户显式切到 `hybrid`/`relay` 才接管，切回 `observe` 立即恢复原生弹窗。

## 关键机制与数字

- 设置项 `approvalAutomation`（`ria.json` 的 settings，schema v3 加字段、不做迁移）：`mode` ∈ `observe|rules|relay|hybrid`（非法值回落 `observe` 并写 warn）；`unmatched` ∈ `ui|relay`（仅 `hybrid` 有意义）；`relayTtlMs` 默认 900000（15 分钟），最小 60 秒、最大 30 分钟；`rulesFile=approval-rules.json`。
- **可返回的 outcome 只有四种**：`allowed-once`/`rejected`/`cancelled`/`unavailable`（`dsh-user-approval/lib/index.js:29-31`），没有 allow always；想持久授权只能走 policy/grant，不能伪造 outcome。`policy=never` 在进入 waterfall 前已直接 `rejected`（`:200`），所以规则引擎只在 policy=`ask` 时有效。
- **参数缓存是前提**：`approval/request` 只带 `agent`、`toolName`、`callId`、`reason`、`signal`，不含命令与参数。broker 在 `tools/pre-execute`（`dsh-tools/lib/pipeline.js:386-387` 先于审批）按 `(agentId, callId)` 缓存 `exec.arguments`，最多 500 条、保留 10 分钟，`tools/result` 或审批结束时删除；取不到则不允许规则 allow（可 deny 或转人工）。
- **判定顺序**：① 不在接管范围（Ria 自己、非 top-level worker、无 active ticket、policy≠ask、mode=observe）→ `next()`；② 同一 executor 多 active ticket → 不自动 allow；③ 内置硬拒绝 → `rejected`；④ 用户 deny → `rejected`；⑤ 用户 ask → 强制人工；⑥ 用户 allow 全部条件满足 → `allowed-once`（ticket 不进入 blocked）；⑦ 未命中按 mode/`unmatched` 决定 `next()` 或转人工；⑧ 任何异常记 error，转人工或 `next()`，两者都不可用则 `unavailable`。
- **规则优先级**：内置硬拒绝（不可覆盖）> 用户 deny > 用户 ask > 用户 allow > 默认。多条 allow 同时命中取 `id` 排序最前的一条并写 `matchedRuleId`，不做「最具体优先」打分。硬拒绝清单要短：`sudo`、`rm -rf /`、写 `~/.ssh`、写 `~/.dsh`、改 `ria.json`、调 `dsh-daemon` 停服务。
- **规则文件**：`~/.dsh/state/ria/approval-rules.json`，与 `ria.json` 分离以便热加载和回滚。P0 只支持 `tool`（必填）、`commandPrefix`、`commandExact`、`workdirUnder`、`pathUnder`、`sandboxMode`（仅显式带 `sandbox_permissions` 时匹配）、`limits.maxUsesPerTicket`、`limits.expiresAt`；不支持正则、glob、环境变量、占位符。
- **命令准入**：`bash` 的 command 是字符串，`startsWith("git status")` 不可靠（`git status; rm -rf /` 也会命中）。保守 tokenizer 只接受普通字符、引号内字面量与单空格；出现 `; && || | > < $` 反引号、换行、`(){}*?~` 即判「不可自动 allow」；拒绝 `cd` 开头与 `FOO=bar cmd` 赋值形式；解析失败按不匹配处理。这只是 allow 的准入条件，隔离仍靠 sandbox。
- **转人工**：生成 `approvalId`（`apr_...`）→ 复用 `enterApproval` 置 `blocked/waitingOn=approval`、attention.ref=approvalId → 本地卡片 + 微信镜像 → 用 `sessionController.prompt` 以 `source.kind='ria-approval'` 唤醒 Ria（不能是 `'user'`，否则被 intake 当用户请求；按 approvalId 去重，每条只唤醒一次）→ 等决定 / abort / TTL / 卸载。
- **HTTP 与微信**：`GET /approvals`、`GET /approvals/:id`、`POST /approvals/:id/decision` body `{decision:"allow"|"deny"}`；重复决定返回 `409 approval_already_decided` 且不重复写审计，过期/取消返回 `410 approval_expired`，没有 `allow-always`。微信只识别整条消息匹配 `^(允许|拒绝)\s+([A-Za-z0-9]{4,8})$`，短码 4–6 位且在当前 pending 内唯一；回复直接调 broker，不经过 Ria 的 LLM，actor=user。
- **`ria_approval`（P1 才加 decide）**：`{approvalId, decision, userConfirmed:true, reason}`；错误码 `approval_confirmation_required`/`approval_not_found`/`approval_already_decided`/`approval_expired`/`approval_not_authorized`；只装在 Ria 自己 agent 上。`userConfirmed` 是流程约束而非密码学证明，权威路径是按钮/短码。
- **审计**（沿用 `stateDir/audit.jsonl`）：`approval/rule`、`approval/relay`、`approval/decision`、`approval/expired`、`approval/aborted`、`approval/rules_reloaded`。`argsDigest` 是 canonical JSON 的 SHA-256，`argsPreview` 截断 400 字并把 `token`/`password`/`Authorization`/`sk-` 等替换为 `[redacted]`；宿主的 `approval/asked`/`approval/decided` 仍是权威审计，插件审计只是补充。
- **启动/卸载/取消**：startup 若无 pending 则恢复 `open`、再按 worker 是否存活决定 working，并写 attention「审批因重启丢失，请确认 worker 状态」，不静默当 working；`dispose` 对所有 pending 返回 `cancelled` 并写 `approval/aborted`；`req.signal` abort 立即 `cancelled`，晚到的点击返回 `approval_expired`。
- **多审批同一 ticket**：只在第一条时 block，全部结束才释放；全 allow → working，任一 deny/cancel/timeout → `blocked/waitingOn=user` 并说明哪条失败。状态映射：allow 走 blocked→open→working；deny/cancel/timeout/unavailable 一律保持 `blocked/waitingOn=user` 并写「审批被拒绝/取消/超时」attention，不自动重派。

## 实现状态

- 方案文档，未实现；`lib/`、`test/` 未改。
- 已有基础：`lib/approvals.mjs` 的 `ApprovalObserver` 已监听 `approval/request`、用 `agent.id` 找 active ticket（`:58`、`:68`）、置 `blocked/waitingOn=approval` 并写 attention（`:89`）、审批结束经 open 回 working（`:145`）；但它总是 `return await next()`，只观察不回答（`lib/index.js:1699` manager prompt 写 `This tool only observes; it cannot approve or deny`，`:4110` 的 `toolApproval` 只接受 `action=list`）。
- 缺口逐项：不能回答（微信侧完全不可用）、没有规则（每条都打断人）、没有决策审计（只有 asked/decided，没有「为什么」）、没有失败语义（拒绝后工单像还在跑）、没有并发控制、没有权限边界。
- 计划新增：`lib/approval-rules.mjs`（纯函数，schema/加载/校验/匹配）、`lib/approval-broker.mjs`（监听、缓存、决策、超时、审计）、`lib/index.js` 接线与 `ria_approval`、`lib/client.js` 卡片。

## 仍未实现 / 风险

- 全部未实现，且有 14 项待拍板：默认模式、转人工是否替换原生弹窗、Ria 能否自主 allow、拒绝后工单状态、规则语言是否够用、硬拒绝清单是否加 `git push --force`/`npm publish`、`npm test` 能否自动 allow、规则文件位置、微信短码格式、多审批释放策略、同 executor 多 ticket、审计保留与脱敏、唤醒频率、`decide` 是否保留。
- 规则易被命令拼接绕过：tokenizer 只是 allow 准入，不构成 shell 安全边界。
- 规则写错即误放行；文件损坏时整份拒绝加载并保留上一版，避免「半份规则生效」导致全部转人工或全部放行。
- 转人工替换原生弹窗后，插件挂掉就无人应答，只能 fail closed 返回 `unavailable`。
- 审计写失败必须降级为转人工/deny，否则等于无审计放行；这条在实现里最容易漏。
- 收益未经验证：没有实现，也没有试点数据。

## 现行文档

- [design-history.md](design-history.md)：审批可见性 observer、Phase 5、`ria_approval` 只读契约。
- [operations.md](../operations.md)：「审批等待」一节描述现行 blocked/waitingOn=approval、15 分钟超时与重启恢复 working 的行为。
- [tools.md](../tools.md)：`ria_approval` 的参数与返回。
