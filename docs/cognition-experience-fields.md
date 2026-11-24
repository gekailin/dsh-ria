# Cognition experience 字段说明（Phase 2）

Advisor 注入的认知经验**保留 WorkOrder 的 `lessons` 字段名**，不另造 `experience` 字段：
现有 `dispatchBrief` / `lessonsBrief` 消费方无需改名。

每个条目统一为：

```json
{ "id": "cog_12", "source": "lib/x.mjs:10", "text": "<=200 chars" }
```

- 最多 5 条；text 按字符截断到 200。
- sqlite 来源：`cognition_entries`（searchEntries）；file 回退：`cognition/projects/<key>.md` 与 `cognition/chat/*.md`。
- 直管与协管 Executor Brief 共用同一 `lessonsBrief` 渲染。
