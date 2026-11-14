---
schema: 2
date: 2026-11-14
timezone: Asia/Shanghai
cadence: daily
windowStart: 2026-11-13T16:00:00.000Z
windowEnd: 2026-11-14T05:45:57.050Z
trigger: manual
runId: refl-20261114-6f25a3
attempt: 1
workerSessionId: session-8c621973-167d-4b18-89df-c9b98f1f258c
status: complete
sessionsReviewed: 7
sessionsSkipped: 0
ticketsReviewed: 40
compressedBytesRead: 0
decompressedBytesRead: 0
durationMs: 0
degraded:
  - "read_session 对超长会话返回 truncated=true，主会话与 Ria开发只能按时间窗/索引分段读"
  - "session-ddeb790b（2DGS demo）summary 返回 0 条消息，未能核对它的实际交付"
  - "工具未暴露压缩/解压字节数与精确耗时；成本按各次 stats.omittedChars 估算"
---
## 一句话
今天把反思系统从「工具写了」推进到「真机能跑」，并修掉微信出站图 aes_key、queue_wake 漏投两个 P1；但核心交付在窗口最后一小时仍靠连修两个真机 bug 才跑起来，暴露出「单测绿≠宿主可用」与「工单 checklist 不对账」两类系统性问题。

## 做对了什么
- **微信出站图黑图定位到根因并用单变量实测确认**：`aes_key` 发成了 `base64(16 字节裸密钥)`（24 字符），微信要的是 `base64(32 位 hex 字符串)`（44 字符）；同一条消息只改这一个字段，24 字符黑图、44 字符正常显示。修复 commit `95d5248`，36 套测试全绿，`docs/channels.md`/`docs/wechat.md` 已记录。证据：主会话 e18313、e18457；用户确认「这个能看到」e18432；ticket_mwfeifrs_e3c42deb14 status=done。
- **queue_wake 没有停在追单点原因，改成状态驱动自愈**：`publishReadyNotices()` 只读已提交的 `readyAt/readyNotifiedAt`，挂在「工单提交后 / startup / Ria turn-end」三处，风险事件后只做 +2s/+10s 一次性核验，不常驻 30 秒轮询；验证时还发现并修掉启动对账产生的重复 wake。commit `cdab3d5`，39 个测试脚本通过。证据：Ria开发 e47961（用户改方案）、e48673（交付）；ticket_mwfowzfq_37d267fa9d status=done。
- **chunk BA 没有硬凑数据**：指定块对 41 对候选帧、约 1800 条 LightGlue 内点，三角化+4px 过滤后只剩 27 条匹配/1 条 track；三角化通过率 1.5%（同 seq 6–12%）、本质矩阵相对旋转差 12–49°、地平面平移搜索 NCC 最优 0.081 无峰，判定两块不重叠；同时发现数据集 GPS 有 300–500 m 的序列级常量偏移。证据：众源BEV续 e30205；主会话 e17115。
- **反思试跑先证明流程有价值**：干净上下文 worker 一个 turn（约 6.7 分钟）写出 80 行/10.1KB 报告，给出 P0 0、P1 1、P2 5，并准确指出 queue_wake 空转 3h36m 与看图误判。证据：session-e17b42ae e370；ticket_mwfg5l6b_e807055a36 status=done。
- **被用户纠正后不嘴硬，补做了能力验证**：先直连 mccodex 后端发蓝框图得到回答「Blue」，再查 `cordis.patch.yml` 发现 `deepseek-v4-flash` 的 `input` 只声明 `text`，明确承认此前「模型不支持」的说法不准确；用户换到声明 image 的模型后成功读图。证据：主会话 e18518、e18551；ticket_mwf83yq_950a37600f status=done。

## 错漏清单
1. **反思只读工具返回非法 lossless JSON，第一次真机试跑 14/14 次调用被拒、零草稿**：`ticketView` 的 `waitingOn/blockedReason` 与 `querySession` 的 `at/turn` 会带 `undefined` 键，宿主整条拒绝。worker 最后写出畸形参数 `{"from": 2026-11-13T20:49:50.000Z}`，turn 以 `MALFORMED_RESPONSE` 结束。证据：session-b8eadcb8 e20-40（read_tickets 4/4 失败）、e44-80（read_session 9/10 失败）；主会话 e21399；ticket_mwfz1bkz_5d29843c94 status=done（修复 `7795e73`）。
2. **`ria_reflect` 的 status 分支被同名方法覆盖，重启后直接返回 run_closed**：`toolReflectStatus(signal)` 与 worker 版 `toolReflectStatus(sessionId, runId)` 同名，后者覆盖前者。证据：主会话 e21235；Ria开发 e50516（用户给根因）、e50648（改名修复 `cc4ad0b`）；ticket_mwfyww4t_e72f95e395 status=done。
3. **看图问题先误判成「模型不支持」，多花约 14 分钟**：实际是 profile 声明只写 `text`，不是后端能力问题；试跑报告把这条列为 P2。证据：主会话 e18411（错误结论）→ e18518（更正+实测）；session-e17b42ae e370（P2 统计）。
4. **queue_wake 漏投造成 3h36m 空转**：`ticket_mwf7lpk4_62a20be388` 在 00:55:32 就绪，`readyAt` 已写但无 `[Queue ready]`，直到 04:31 重启恢复才派发。证据：用户派单原文 e47599；ticket_mwfowzfq_37d267fa9d；试跑报告 e370（P1）。具体丢失环节未定位，现用状态驱动自愈兜底。
5. **多张已交付工单的 checklist 没有对账**：`ticket_mwfowzfq` 15 项全 false 但 status=done（worker 报告 commit `cdab3d5`）；`ticket_mwf7lpk4` 5 项全 false 但 status=done（`46d9c18`）；`ticket_mwet3jit` 5 项全 false；`ticket_mwfr3rgc` 5 项全 false，但 blockedReason 已写明 4 张图 + commit `e6999f6`。这会让看板和反思把「已交付」误读成「未完成」。
6. **chunk 选错又返工一轮**：先选了 58e0a89c × 6541749e，用户两次纠正「它选错 chunk 了」「chunk 还是没选对」，要求回读自己的会话历史复现最初指认的两段；worker 重新列候选并出 mosaic 后才由用户确认候选①。证据：ticket_mwfp0wlb_a0e5e8320d、ticket_mwffumei_05fe0fb6b8（均 merged 进 ticket_mwf7aihy_9d57f52727），该票 checklist 含「复盘自身会话历史，复现用户最初指认的两段 chunk」。
7. **窗口结束时正式反思报告仍未产出**：ticket_mwfwqrga_5d0df97bf3 的 checklist「worker 写报告」「交给用户」「重启后 attempt=2 重跑」仍为 false，ticket_mwfzg9b1_3d006b943f 仍 working；本报告是其中的 worker 环节，finish 落盘仍待 Ria 执行。

## 教训
1. **单测绿不等于宿主可用**：工具必须在真实宿主里逐个真调用一次，重点看 lossless JSON、绑定、run_closed 与空结果分支；这次 14/14 被拒发生在多套测试全绿之后。
2. **同类工具/方法必须唯一命名，回归要走公共 action**：`toolReflectStatus` 同名覆盖只有真机调用 `ria_reflect{action:'status'}` 才暴露；测试只测内部方法会漏。
3. **能力类结论分三层验证**：后端真实能力（直接 probe）→ profile 的 `input` 声明 → 会话当前所选模型；任何一层都不能代替另外两层，不能再用「模型不支持」一句话带过。
4. **状态即真相，事件只能做加速**：就绪通知必须能从已提交的 `readyAt/readyNotifiedAt` 推导并自愈；一次性回调不能作为唯一依据，否则同类 3h36m 空转还会发生。
5. **昂贵实验先锁输入，再谈优化**：先用低成本证据（地标、帧存证、候选 mosaic）确认数据对，用户说「就是之前那组」时先回读自己的会话历史复现，而不是按文档重新推导；否则 BA 跑得再完整也是在拟合错对应。

## memory 候选
- **reflection-lossless-json**：反思只读工具返回值不得含 `undefined`（含数组项）；宿主 lossless JSON 校验会整条拒绝。源头修 `ticketView/querySession`，并在 `reflectionToolResult` 做通用清洗；上线前逐工具真机调用一次。
- **image-capability-three-layers**：判断「能不能看图」要分三层：后端直接 probe、profile 的 `input: [text,image]` 声明、会话当前模型；只查其中一层容易误判。
- **ticket-closure-triad**：工单收口 = status + checklist 勾选 + 交付证据（commit/测试/路径）。status=done 但 checklist 全 false 视为未对账，不能直接向用户报「已完成」。

## 明日关注
1. **把本轮反思收口**：校验本报告 front matter，执行 `ria_reflect finish` 落盘 `reflections/2026-11-14.md` 并交给用户；若校验失败，保留 `lastCompletedDate=null` 并把错误写入 `state.json.lastError`。关联 ticket_mwfzg9b1_3d006b943f、ticket_mwfwqrga_5d0df97bf3。
2. **补对账**：检查并补勾 ticket_mwfowzfq、ticket_mwf7lpk4、ticket_mwet3jit、ticket_mwfr3rgc 的 checklist，或在看板上标记为「交付已确认、checklist 待补」，避免后续反思继续误判。
3. **三个等用户拍板的决策**：mosaic 纯平移 (+3.80,−0.90) m 是否写进 pair_opt/strain（ticket_mwfr3rgc）；底商无影像路线下一步（ticket_mwevzluz）；README 6 条候选是否定稿（ticket_mwedsk9u）。
4. **反思工具修复后做一次 6 工具非空数据冒烟**：至少覆盖 `read_tickets` 与 `read_session` 的非空结果，确认宿主不再报非法 JSON；再考虑下一次定时反思。
5. **2DGS 工单核对**：ticket_mwep7p60 status=done 但前 6 项 checklist 为 false，且 session-ddeb790b 读不到消息；需确认 `docs/2dgs_demo_report.md` 与渲染产物真实存在。
6. **chunk BA 不要沿同一批错对应继续加码**：候选①已给出内点率 5–9% 的负面结论，下一步应先改数据关联/匹配质量，或先接受 mosaic 平移方案，再决定是否重跑 BA。

## 覆盖与成本
- **会话**：读了 7 个不同会话——主会话 session-56448aa3（两段：01:15–04:29、12:30–13:45）、Ria开发 session-edd7b6d7（两段：turn 71–74、75–76）、众源BEV续 session-f7252a16（turn 60–62）、试跑 worker session-e17b42ae、Ria文档 session-3315a7c9、失败的反思 worker session-b8eadcb8、2DGS session-ddeb790b（返回 0 条消息）。
- **工单**：窗口内 40 张逐条看；另读 open 视图核对未收口项（2 张 working、3 张 blocked，其余为 done/merged/cancelled 及历史遗留）。
- **上下文**：memory 2,475 字节、outbox 13,376 字节；6 个只读工具中 status/read_tickets/read_context/read_session 实际使用，read_sessions/report 未用于取证。
- **读取量**：各次 summary 的 `omittedChars` 合计约 13,476,000 字符（压缩后的摘要抽样覆盖）；实际进入本 worker 上下文的正文约 90k 字符，未超预算。
- **时间**：run 于 2026-11-14T05:45:57Z 开窗、06:01:13Z 硬截止；工具未返回精确耗时，按调用量估计在 10 分钟软上限内。

## 未覆盖
- 候选会话约 180 个，只读了窗口内活跃的 7 个；其余按 `lastUsedAt` 在窗口外、blank 或纯历史会话排除，未逐个打开。
- 主会话在 04:29–12:30（Asia/Shanghai）之间因 summary 截断未第一手读到；该时段的关键事件（queue_wake 修复、反思编排实现）主要靠 Ria开发会话与工单/outbox 交叉补证。
- session-ddeb790b（2DGS demo）的 summary 返回 0 条消息，未核对其报告与产物，只能依据 ticket_mwep7p60 的 checklist。
- 未使用 `mode=full` 读原始事件；异常工单的根因由用户消息、worker 回报与 ticket 记录交叉验证，未逐条回放原始工具参数。
- 未读 schedule 视图；今日 trigger=manual，未验证定时反思配置。
- 所有 commit 号、测试套数与耗时均来自 worker 回报或票面记录；本 worker 无 shell/git 权限，未独立复跑 `npm test` 或检查 diff。
