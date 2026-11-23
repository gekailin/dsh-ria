# 完成才记账：Executor autoTags 与 lastUsedAt

## 规则

1. **只在 done 记账**：工单进入 `done`（有无 report 均可）时，才把该票的路由 tags 与主 topic tags 写入执行器 `autoTags[tag] = 当前 turn`，并写 `lastUsedAt = 完成时刻`。turn 来自 `turn/end` 事件或会话记录的最近 turn。
2. **取消/失败/阻塞/中止不计**：`cancelled`、`failed`、`blocked`、人类中止、session 结束、startup 中断都不写 `autoTags`，也不移动 `lastUsedAt`。
3. **字典结构、只增不删、上限 100**：`autoTags` 是 `{ [tag]: lastTurn }`，不是数组。标签走 `normalizeTags`（trim、小写、空格/下划线转连字符、去非法字符、去重）；显式 `tags` 优先，不会同时进入 `autoTags`。超过 100 条时淘汰 `lastTurn` 最小的条目，平局按 tag 字典序，保证确定性。
4. **幂等**：执行器持久化 `autoTaggedTicketIds`。同一 ticketId 第二次 done 直接返回，不重复累加、不改 `lastUsedAt`。重复完成只保留较大的 `lastTurn`。
5. **阈值判定，不物理删除**：打分只使用满足 `currentTurn - autoTags[tag] <= 30` 的 tags；默认阈值 30，可通过 `options.autoTagTurnThreshold` 或打分/判定的 `autoTagTurnThreshold` 传参覆盖。过期 tag 只忽略，不删除；100 条上限是唯一的淘汰来源。
6. **同步不空覆盖**：`syncCoManagedExecutors` 重建协管执行器记录时保留 `autoTags`、`lastTurn`、`autoTaggedTicketIds`、`lastUsedAt`、`recentTopics`；它只从 coManagement 同步显式 `tags`，不写 `autoTags`。
7. **remove 不删记录**：`ria_chat_co_manage action=remove` 只把协管登记标为 inactive，执行器条目和 `autoTags` 保留；同一 sessionId 重新 add/set 会恢复 active，学习标签自然还在。

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
- done 调用点：`settleDoneReport` 与 `settleDoneNoReport`（由 `settleCompletedTurn` 传入 `turn/end` 的 turn）
- 状态规范化：`lib/store/store.mjs` 的 `normalizeExecutor`（数组→字典，缺失 lastTurn=0）
- 协管同步保留：`lib/store/store.mjs` 的 `syncCoManagedExecutors`
- 阈值与字典 helper：`lib/store/tags.mjs` 的 `normalizeAutoTags` / `activeAutoTags` / `AUTO_TAG_TURN_THRESHOLD`
- 打分与判定：`lib/core/executor-pool.mjs` 的 `scoreExecutor` / `isExecutorEligible` / `isExecutorSelectable`
- 常量：`AUTO_TAG_LIMIT=100` / `AUTO_TAG_TURN_THRESHOLD=30` / `AUTO_TAG_LEDGER_LIMIT`

## 测试

`test/completion-tags.mjs` 覆盖 done 累加、四类不计入、幂等、数组→字典归一化、100 上限淘汰、阈值边界（30 命中/31 不命中）、配置与传参覆盖、syncCoManagedExecutors 不空覆盖；`test/co-management.mjs` 覆盖 remove inactive 后重新协管保留 autoTags。
