# 测试与本地开发

## 跑测试

~~~bash
npm test
~~~

`npm test` 串行执行 61 个 `test/*.mjs`，全部退出码为 0 才算通过；每个文件都是独立的 Node 进程，用 mock ctx 和临时 stateDir，不连真实 dsh web、不发网络请求。断言既覆盖服务端行为，也包含对 `lib/client.js` 源码字符串的检查（看板尺寸、选择器、文案），所以改前端时这些测试会一起失败。

## 套件索引

| 组 | 文件 | 覆盖重点 |
|---|---|---|
| 核心 | `smoke.mjs` | ensure/Workspace 挂载、15 个工具注册、request、工单派发、dispatch guard、settings/state、memory、grant、持久化与重复 ensure |
| 工单 | `task-state`、`intake`、`checklist`、`merge`、`archive`、`attention` | 状态机、intake 定性、清单勾选与终态、checklist_pending 门禁与 waiver、合并/归档、等待用户拍板 |
| 队列与依赖 | `queue`、`ticket-queue`、`ticket-queue-restart`、`queue-wake-recovery`、`queue-wake-delivery` | queueToken、依赖就绪、失败 hold、重启对账、wake 补发与投递 |
| 派发与 worker | `spawn`、`workspace-spawn`、`workspace-reconcile`、`model`、`title`、`recent-workers`、`worker-idle`、`working-guard`、`dispatch-confirm`、`attachments` | 顶层 worker 创建/改模型/改名、最近 worker、idle 唤醒、防误发、附件预检 |
| 看板与主题 | `board`、`topic-board`、`board-ask`、`board-events`、`topic-suggest` | 瀑布布局、主题网格与筛选、搜索索引、`/ask` 两种来源、SSE 变更广播与断线清理、工单详情弹窗与 `GET /board/ticket` 的「最后结果」、tooltip 精简、suggest 打分与 v4→v5 迁移 |
| 通道 | `wechat`、`wechat-pause`、`wechat-file`、`wechat-image`、`wechat-image-inbound`、`wechat-fold`、`wechat-claw-*`、`qq-bot-typing`、`channels`、`inbound-delivery`、`channel-pause-notices` | 三通道扫码/入站去重/暂停、长回复转 .md、图片与文件上下行、typing、忙碌 steer 与空闲 queue 回退 |
| 审批与权限 | `approvals`、`approval-automation`、`approval-ordering`、`grants`、`approval-visibility` | 审批捕获与清理、风险分类与代批（低风险放行/硬拒绝/中风险 Ria 裁决/ask-user/超时/审计失败 fail closed/参数脱敏）、真实 cordis waterfall 下的 prepend 顺序与未匹配诊断、临时 grant 的过期/恢复/审计、审批可见性 |
| 反思与风格 | `reflection`、`reflection-run`、`reflection-watch`、`reflection-schedule`、`reflection-tools-lossless`、`reflection-front-matter`、`reflection-report-sections`、`reflection-settings-ui`、`reflection-naming`、`voice-style`、`memory-budget` | 只读 worker 与工具、先校验后写入、一次性/单并发/幂等、报告结构、监控工单生命周期、设置页、说话风格、记忆预算与归档 |
| 其他 | `outbox`、`startup`、`dispatch-guard` | outbox 退避/去重、启动恢复、system prompt section 安装与卸载 |

具体断言以测试文件为准；上表只用于定位改动影响面。

## 本地开发与隔离验证

开发时不必改真实 profile，可以直接用 patch 叠加：

~~~bash
DSH_HOME=$PWD/.verify-home dsh --profile riatest --patch ./cordis.patch.yml --port 3099 --host 127.0.0.1 --no-open
~~~

改 `lib/` 后，真实 profile 里的 `node_modules/dsh-ria` 是拷贝而不是符号链接，需要手动同步副本并重启 dsh web 才会生效；本仓库的测试和开发流程都不会自动同步，也不会重启服务。
