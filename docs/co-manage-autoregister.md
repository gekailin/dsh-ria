# 让 X 做 Y：自动纳管约定

当用户说「让 X 做 Y」或「给 X 派 Y」时，Chat 按以下规则处理。

## 分支

1. **X 已在协管列表**：直接建 work 票，并显式指定 `executorId`。
2. **X 不在协管列表**：先调用 `ria_chat_co_manage action=add`：
   - `allowDispatch=false`
   - `cwd` 取该会话的 cwd
   - 成功后再建 work 票，并显式指定 `executorId`
3. **X 匹配多个会话**：不要猜。列出候选让用户选；用户确认后再纳管/派单。
4. **X 是 managed executor**：已在执行器池，无需纳管；直接按 `executorSeq` 或 `executorId` 派单。
5. **纳管失败**（会话不存在/是角色会话）：明确报错并停止，不派单。

## allowDispatch=false 的语义

**只承接这一张显式工单，不参与后续自动派单。** 自动纳管成功后，Chat 必须立刻显式派这一张票；不能把 `allowDispatch` 改成 true，也不能让后续同类工单自动落到该会话。

## 自动纳管 ≠ 自动派单

自动纳管只是把会话放进协管列表，不会自动产生工单、不会自动派单。派单仍由用户「让 X 做 Y」这句话触发，并且必须显式指定 `executorId`。

## Prompt 指针

规则权威文本：`lib/prompts/shared.mjs` 的 Chat prompt「让 X 做 Y（自动纳管，不自动派单）」段落。
