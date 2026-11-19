# dsh-ria 文档

根 [README.md](../README.md) 是产品入口；本页是文档索引，按「现行 / 归档 / 资产」三类列出。代码与测试是最终事实，文档与实现不一致时以代码为准并回头修文档。

## 现行文档

| 文档 | 内容 | 状态 |
| --- | --- | --- |
| [architecture.md](architecture.md) | 系统顶层地图：定位与边界、核心对象、主流程、可靠性、持久化、通道、记忆与反思、扩展点 | 现行 |
| [sage-advisor-design.md](sage-advisor-design.md) | Sage（大脑）+ 无状态 Advisor 的目标设计：Sage 边界/工具面/epoch、共享认知库（proposal→Sage 采纳）、Advisor 快照预算与降级、Router 两阶段、反馈闭环、迁移与风险 | 草案 |
| [project-advisor-design.md](project-advisor-design.md) | 项目级 Advisor 的历史方案：workspace 路由、项目会话、两级经验库与晋升；已被 Sage + 无状态 Advisor 取代 | 已取代 |
| [co-management-design.md](co-management-design.md) | 协管 P1+P2 设计与实现口径：transport 状态、监控/转述/统一路由、事件表、用户直连观测、与 direct 无耦合、命令与工具、去重限流、失败重试 | 现行 |
| [sqlite-migration-design.md](sqlite-migration-design.md) | 控制面数据迁 SQLite 的设计与分阶段方案：进库/留文件范围与权威源、Schema 草案、单写者 WAL 与事务边界、导入校验与回滚、三阶段落地、依赖与风险 | 草案 |
| [tools.md](tools.md) | 15 个 `ria_*` 工具与 6 个只读 `ria_reflect_*` 的参数、返回、依赖和调用纪律 | 现行 |
| [operations.md](operations.md) | 运行手册：入口、任务转述、60 秒确认、outbox、归档、重启恢复、worker 唤醒、审批自动化 | 现行 |
| [channels.md](channels.md) | 三个手机通道的面板、协议、入站投递、暂停与状态文件 | 现行 |
| [wechat.md](wechat.md) | 微信「文件传输助手」：扫码、暂停、长回复转 .md、图片与文件收发 | 现行 |
| [board-preview.md](board-preview.md) | 看板与主题视图的 UI 行为、数据字段、`/ask` 与迁移 | 现行 |
| [state-and-api.md](state-and-api.md) | 状态文件清单与全部 HTTP API | 现行 |
| [memory-budget.md](memory-budget.md) | memory.md 的容量方案：core 2400 字符 / 12 条 / 单条 300，archive 不注入 | 现行 |
| [testing.md](testing.md) | 测试套件索引与本地隔离验证方法 | 现行 |
| [limitations.md](limitations.md) | 已知限制、安全边界与未验证项 | 现行 |
| [cross-machine-session.md](cross-machine-session.md) | 跨机器 Session 的调研：远程访问、停机复制、relay/IM 分类与推荐 | 现行（调研） |

## 归档

| 文档 | 原稿 | 状态与保留理由 |
| --- | --- | --- |
| [design-history.md](archive/design-history.md) | `docs/design.md`（v0.31，922 行） | 历史设计；保留定位、工单不变量、就绪「状态即真相」、outbox 语义与 Phase 结论 |
| [task-model.md](archive/task-model.md) | `docs/task-model-design.md`（1351 行） | 历史设计；P0 已落地，保留 8 态、不变量、捕获/去重与失败矩阵；P1 分叉未实现 |
| [ticket-queue.md](archive/ticket-queue.md) | `docs/ticket-queue-design.md`（719 行） | 历史设计；P0 依赖/排队已落地，保留 queueToken、wake key、失败 hold 与 P1 缺口 |
| [daily-reflection.md](archive/daily-reflection.md) | `docs/daily-reflection-design.md`（1395 行） | 历史设计；服务端/调度/API/设置页已实现，保留预算、幂等与未实现项 |
| [approval-automation.md](archive/approval-automation.md) | `docs/approval-automation-design.md`（585 行） | 旧方案稿；2026-11-16 用户拍板「默认从严代批」后已按新语义落地，本稿仅保留方案 C、规则匹配、参数缓存与待拍板项，不代表现行实现 |
| [superagent-borrow.md](archive/superagent-borrow.md) | `docs/superagent-borrow.md`（277 行） | 评估稿；保留采纳/拒绝清单（outbox、attention 已落地，idle 合并未实现） |
| [memory-audit.md](archive/memory-audit.md) | `docs/memory-audit.md`（301 行） | 已落地（prompt 侧）；保留分流结论与未落地的路由/清理项 |
| [code-audit.md](archive/code-audit.md) | `docs/code-audit.md`（75 行） | 历史审计；16 项 / 12 修 / 4 项边界待定，作为快照保留 |
| [reflection-and-review.md](archive/reflection-and-review.md) | `docs/ria-session-review.md` + `docs/reflection_tool_trial.md` | 复盘与试跑合并稿；保留宿主边界事故、工具默认值建议与已修缺陷 |

已直接删除、不归档的稿件：`task-naming-audit.md`（改名已清零，结论已进代码与文档）、`readme-cases-candidates.md`（旧 README 案例，已被现行 README 取代）。需要时从 git 历史取回。

## 资产

| 路径 | 用途 |
| --- | --- |
| [hero/hero.png](assets/hero/hero.png) | 根 README 首屏 hero（1376×768，由定稿 JPG 转 PNG） |
| [brand/ria-avatar.png](assets/brand/ria-avatar.png) | 人物身份基准图 |
| [screenshots/](assets/screenshots/) | 现行文档引用的界面截图：会话入口、设置页、微信弹层、派发 note 卡片 |
| [board/](assets/board/) | 看板 preview 与 tooltip 截图 |
| [icon/](assets/icon/) | 侧栏 Ria 图标：`wave-faithful.svg`、预览与 [取舍说明](assets/icon/NOTES.md) |
| [hero-candidates/](assets/hero-candidates/) | 最终 hero 候选 `E2s-1.jpg` 与 [定稿记录](assets/hero-candidates/NOTES.md) |

## 本次清理（2026-11-16）

- 历史设计/审计稿：13 个源文件删除，其中 11 个压缩进 `docs/archive/` 的 10 篇（`ria-session-review` 与 `reflection_tool_trial` 合并为一篇）；2 个无继续参考价值的直接删除。
- 资产：根目录散落的 hero、头像、4 张界面截图、2 张看板截图、图标和 hero 候选统一收进 `docs/assets/`，按用途分目录；旧界面截图确认仍被现行文档引用后保留。
- 候选清理：`docs/assets/hero-candidates/` 只留最终候选 `E2s-1.jpg` 与定稿 NOTES，其余构图/人物实验与对比图删除；`docs/assets/icon/` 只留 `wave-faithful.svg`、两张预览与取舍 NOTES，standard/minimal 两版删除。
- 所有现行文档与根 README 的图片、文档链接已改到新路径；归档稿中的旧稿引用已指向 `docs/archive/` 内的对应页面。
