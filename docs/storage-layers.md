# 存储分层（Phase A/B/C）

## 1. SQLite = 关系型权威

`~/.dsh/state/ria/ria.sqlite` 是以下关系的唯一权威：

- `tickets` / `ticket_history`
- `topics` / `topic_links`
- `lessons`（DEPRECATED：仅保留历史，数据已迁入 cognition；代码不再读写）

写路径经过 `RiaStore`/`SqliteTicketRuntime` 的事务；`sqlite-verify` 只读体检。不要把关系数据或需要按状态查询的数据塞回 JSON。

## 2. state.json = 控制面

`~/.dsh/state/ria/state.json` 只保留控制面：

- `workers`、`settings`、`grants`、`recentWorkers`
- `chatSessionId` / `sageSessionId` / `riaSessionId` / `riaPreset`
- `meta`、`lastError`、`storage`、`version`、`createdAt`、`lastHumanMessageAt`
- `coManagement`（协管 watch 注册表；旧 co-management.json 仅迁移时读取）

目标 **< 100KB**。请求/报告/派单/收件箱/反馈/lesson 候选不在这里（Phase B 后）。

## 3. events.jsonl = 只追加日志

`~/.dsh/state/ria/events.jsonl`：

- 每行 `{at, kind, ticketId, payload}`
- 承载 `request.*` / `report.*` / `workorder.*` / `inbox.*` / `feedback.*`（lesson.* 已废弃，不再产生）
- 只追加，不就地改写
- 默认按 **50MB** 轮转到 `events-<timestamp>.jsonl`，保留 **14 天**（可配 `maxBytes` / `retainDays`）
- 启动从当前文件 + archive 新到旧重建：requests/reports/workOrders/ticketFeedback 各 500，inbox 全量；lessonCandidates 不再写入（兼容读取只用于旧数据）

`operation-events.jsonl` 仍是独立审计流，不承载业务状态。

## 4. ria.json = 已退场

Phase A 起不再写入；磁盘保留只读一版作为回滚材料。下个版本满足以下条件后删除：

1. 线上连续一版启动 `state.json` 已有 `eventsMigratedAt` 且控制字段完整；
2. 无回滚到 JSON 模式的需求；
3. `ria.json.bak.*` 与旧备份至少保留一份。

## 决策表：哪个数据该写哪里

| 数据类别 | 应写位置 | 判定理由 | 常见误写反例 |
|---|---|---|---|
| 工单、历史、主题、链接 | SQLite | 关系查询、按状态筛选、唯一约束 | 把 tickets/topics 镜像回 ria.json |
| Worker/设置/grant/session id/控制面 meta | state.json | 小、低频、启动即读 | 把 requests/reports 留在 state.json |
| 请求、报告、WorkOrder、inbox、反馈 | events.jsonl | 追加流水、可按尾部重建、轮转 | 每次保存重写整个数组到 state.json |
| 操作审计/告警 | operation-events.jsonl | 独立消费与保留策略 | 与业务事件混在一个文件 |
| 一次性回滚副本 | ria.json / *.bak | 只读、下版本删除 | 继续当作运行态读源 |

## 部署后首次启动会发生什么

1. `RiaService` 先迁移控制字段：`ria.json` 的 settings/grants/... 缺则搬进 `state.json`，并备份 `ria.json.bak.<ISO>`。
2. `StateStore` 发现 `state.json` 仍含六个日志键：备份 `state.json.bak.<ts>`，逐条 append 到当日 `events.jsonl`，写 `eventsMigratedAt`，原子重写 `state.json`（仅控制面）。
3. 后续启动从 `events.jsonl` 重建；`ria.json` 不再被写。

## 回滚

1. 停服。
2. 用最新 `state.json.bak.<ts>` 覆盖 `state.json`。
3. `git revert` Phase B 的 commit（必要时连同 Phase A）。
4. 重启，旧路径在 `events.jsonl` 不存在且 `state.json` 有旧六键时直接读 state.json。
5. 注意：回滚会丢掉回滚点之后 append 到 events.jsonl 的新请求/报告/收件箱事件；需要时先从 events.jsonl 人工导出。