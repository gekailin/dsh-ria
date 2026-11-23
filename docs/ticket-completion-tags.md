# 完成才记账：Executor autoTags 与 lastUsedAt

## 规则

1. **只在 done 记账**：工单进入 `done`（有无 report 均可）时，才把该票的路由 tags 与主 topic tags 合并进执行器 `autoTags`，并写 `lastUsedAt = 完成时刻`。
2. **取消/失败/阻塞/中止不计**：`cancelled`、`failed`、`blocked`、人类中止、session 结束、startup 中断都不写 `autoTags`，也不移动 `lastUsedAt`。
3. **规范化去重、上限 12**：所有标签走 `normalizeTags`（trim、小写、空格/下划线转连字符、去非法字符、去重）；`autoTags` 最多 12 个。显式 `tags` 优先，不会同时进入 `autoTags`。
4. **幂等**：执行器持久化 `autoTaggedTicketIds`。同一 ticketId 第二次 done 直接返回，不重复累加、不改 `lastUsedAt`。
5. **不衰减（当前版本）**：只保留完整累计的 `autoTags` 与 ticket ledger，不做“最近 N 次完成”的窗口重算。后续若需要衰减，可在 ledger 旁增加 `{ticketId,tags,at}` 贡献列表，按窗口重算并仍受 12 上限；当前不实现，避免扩大改动面。
6. **同步不空覆盖**：`syncCoManagedExecutors` 重建协管执行器记录时保留 `autoTags`、`autoTaggedTicketIds`、`lastUsedAt`、`recentTopics`；它只从 coManagement 同步显式 `tags`，不写 `autoTags`。

## 为什么完成才记账

- 派单即写 autoTags 会让失败/取消/中止的工单污染执行器画像；下一次派单可能因错误标签被选中。
- 派单即写 lastUsedAt 会让 recency 被未完成工作拉动，无法反映“真正完成过什么”。
- 完成才记账把“做过并交付”作为唯一学习信号，失败只留下 failure/审计，不改变能力标签。

## 首次派单怎么引导

新执行器或没有 autoTags 的执行器，首单不能被标签自动命中。首单需要：

- 显式指定 executor / worker；或
- 派单路由使用 `requireTagMatch=false`，让候选可以无标签命中。

工单 done 后，执行器自动获得该票的标签；下一张同类工单才可能因 tags 命中被自动选中。

## 代码位置

- 累加函数：`lib/core/controller.mjs` 的 `applyTicketCompletionToExecutor`
- done 调用点：`settleDoneReport` 与 `settleDoneNoReport`
- 状态规范化：`lib/store/store.mjs` 的 `normalizeExecutor`
- 协管同步保留：`lib/store/store.mjs` 的 `syncCoManagedExecutors`
- 常量：`lib/store/tags.mjs` 的 `AUTO_TAG_LIMIT` / `AUTO_TAG_LEDGER_LIMIT`

## 测试

`test/completion-tags.mjs` 覆盖 done 累加、四类不计入、幂等、规范化/上限 12、显式 tags 与 dedicated 回归、syncCoManagedExecutors 不空覆盖。
