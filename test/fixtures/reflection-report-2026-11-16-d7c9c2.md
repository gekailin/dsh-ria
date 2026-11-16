---
schema: 2
date: 2026-11-16
timezone: Asia/Shanghai
cadence: daily
windowStart: 2026-11-15T16:00:00.000Z
windowEnd: 2026-11-16T15:46:14.327Z
trigger: schedule
runId: refl-fixture-20261116-d7c9c2
attempt: 2
workerSessionId: session-1a71ab03-fbc8-4e2d-8b7e-c4f973ef1104
status: complete
sessionsReviewed: 4
sessionsSkipped: 6
ticketsReviewed: 78
compressedBytesRead: 0
decompressedBytesRead: 0
durationMs: 0
degraded: ["attempt 1 报告正文不可读，仅能确认已写入", "窗口外事件无法核对", "未复跑测试/未看 diff"]
---
## 一句话

审批自动化今天走完了「上线 → 实测失败 → 查到真因 → 修好待重启」一整圈，真因是审批请求根本没到 Ria（waterfall 监听顺序被浏览器转发器截住），`58045f1` 修复并在隔离环境验证通过，但 3080 生产仍跑旧代码；同日反思已经跑过第 1 次并出了完整报告，本 run 是第 2 次。

## 做对了什么

- **失败测试被如实定性，没有被包装成成功**：审批实测 worker 只发一次探针（`session-2429abc2` e9/e41），120s 超时后明确写「属于超时未决，不是成功、也不是显式拒绝」，并核对文件不存在（e24-38、e41），没有重试、换路径或换工具。这份干净的数据后来成为定位根因的关键输入。
- **撞到宿主能力边界时停手并给证据，而不是 DOM hack**：看板执行者定位方案 C 被证实不可行，dev worker 直接停下，给出 `lib/client.js:6047`（插件只注入 slots/sessions/uiWorkspace）、`dsh-client-ui-conversation/lib/client.js:22865`（openView/inspectCall 只给 conversation.session 的 owner）、`dsh-client-ui-workspace/lib/client.js:1473`（openSession 只收 SessionTarget）三处证据（`session-edd7b6d7` e84818；`ticket_mwj6fahk` blockedReason）。
- **根因定位到机制层而不是规则层**：没有去改审批风险规则，而是查出 Cordis waterfall 按注册顺序执行、`dsh-api-remotes` 先注册且不 `next()`，Ria 后注册的监听器永不执行（`session-edd7b6d7` e87946）。这一条同时解释了三个现象：worker 120s、audit 无记录、outbox 无审批卡。
- **交付说明自带边界**：三个 commit 都写清了验证方式与「不 push / 不重启 / 不同步安装副本」（e85107 `fcfd6ea`、e85868 `57492d6`、e87946 `58045f1`），并按要求用 fixture/构造断言而非依赖跑着旧代码的 `/ask`（e84825 指令、e85107 执行）。
- **状态汇报先核事实再下结论**：众源 worker 状态查询给出 turn 109、20:12 结束、c2 纵向 +12.31 m 不可辨识（526 条对应中路面 0 条）、以及「8796 viewer 已连不上」（`session-56448aa3` e36182），没有把「重投影 2.54 px」说成整体成功。
- **第 1 次反思按时交付**：attempt 1（`refl-20261116-065fd8`）在 15:43:45Z 写入报告并正常收口（`session-315b028e` e69-70、e73）。

## 错漏清单

1. **8 张 done 工单的 checklist 全是 0 完成**：`ticket_mwj7r2un`、`ticket_mwj7nw5o`、`ticket_mwj3ibkg`、`ticket_mwj107kf`、`ticket_mwivgm4q`、`ticket_mwiuma5q`、`ticket_mwit61ad`、`ticket_mwilejd9` 的 `resolution.checklistPending` 均为 `done:0 / total:4~10`（本文所读工单详情）。关单动作与清单勾选是两条平行线，交付看起来「已完成 + 未完成」并存。
2. **「done」的验收层级没写清，导致审批自动化提前 2 小时进入已完成态**：`ticket_mwj3ibkg` 于 20:21（本地）标 done，Ria 自己在 22:25 说明「审批链路目前只通过 fixture 验证过」（`session-56448aa3` e35049）；22:51 真实链路一测即失败。工单 acceptance 只要求「含设置页开关、审计、fail-closed 与测试」，字面达标，但「单测通过 / 隔离实测 / 生产生效 / 真实链路」四层没有区分。
3. **修复与生效之间缺一个显式状态**：`58045f1` 已提交、安装副本已同步、隔离环境两轮实测通过（e87946），但 3080 仍是旧代码，dev 只能在结尾问「要我重启一次吗」。同日 `a3a2f93` 也是同一模式（21:19 提交、22:24 重启后才生效）。用户在 22:25 与 23:24 两次被问到同一类问题，中间夹着一次失败实测。
4. **同一 forDate 出现两份报告，没有权威标记**：attempt 1 报告在 `runs/refl-20261116-065fd8/`，本 run 在 `runs/refl-20261116-d7c9c2/`，status 里只有 `ordinal:2`（run 元数据）；`ticket_mwjfp8bj`（「反思如果被重启打断会怎样」）与本次 run 在同一毫秒（15:46:14.327Z）被处理。谁是对外汇报的权威版本，从工具返回看不出来。
5. **测试脚本数量的自述未复核**：`58045f1` 的正文写「npm test 60 个脚本全部 exit 0」，但同一 turn 的 thinking 摘要有「60 scripts? Output listed maybe 59 ok?」（`session-edd7b6d7` e87946）。数字口径未二次核对，属报告严谨性摩擦。

## 教训

1. **「完成」至少分四层，报告时必须点名到第几层**：代码提交 → 隔离环境实测 → 生产生效 → 真实链路跑通。今天审批自动化在前两层被判 done，第 3 层靠重启，第 4 层直接失败；不写层级，done 就会骗人。
2. **「没收到」不等于「没发生」，先查事件链最前端的注册顺序**：Ria 侧 audit/outbox/唤醒全空，worker 侧只有 120s 超时，真相是浏览器转发器先拿到 approval/request 且不 `next()`。以后遇到「理论上该我处理却没痕迹」，先列监听器注册顺序，再怀疑自己的规则。
3. **实测脚本要显式禁重试、禁换路，数据才可用**：「只发一次、被拒就原样报错、不换 write、不换路径」（`session-2429abc2` e9）让超时可以被归因成「等审批」而不是「环境抖动」；否则一次失败会留下多条 callId，根因更难锁。
4. **关单不勾清单，等于把审计线索留成垃圾**：8 张 done 票带 pending 项，事后无法判断是「漏勾」还是「真没做」，checklist 变成装饰。
5. **同日重跑要先声明谁是权威**：两份完整报告并存时，用户看到的可能是旧结论；第 2 次 run 开跑前应先确认第 1 次是否已 complete，并在汇报里带上前一份 runId。

## 对 dsh-ria 的迭代建议

**1. 关单与 checklist 脱钩**
- 问题：8 张 done 工单 `resolution.checklistPending.done=0`（`ticket_mwj7r2un`、`ticket_mwj7nw5o`、`ticket_mwj3ibkg`、`ticket_mwj107kf`、`ticket_mwivgm4q`、`ticket_mwiuma5q`、`ticket_mwit61ad`、`ticket_mwilejd9`），交付与清单状态自相矛盾。
- 建议改法：在 `lib/index.js` 的 `ria_resolve` 入口（resolve 前写状态那段）加校验：`checklist.some(i=>!i.done)` 时返回 `code=CHECKLIST_PENDING` 并列出未勾项，新增可选参数 `closeChecklist:"auto"|"keep"`，`auto` 时先把剩余项勾上再关单，`keep` 保留现状但必须在 resolution 里写 `checklistPending`（现有行为）。
- 影响面：所有 Ria 关单路径与旧调用方；默认值设为 `keep` 可保持兼容，仅在返回体新增 code 与提示。
- 优先级：P1

**2. 「修好」与「生效」之间补一个可查字段**
- 问题：`58045f1` 已提交并同步安装副本，但 3080 仍是旧代码（e87946 结尾问「要我重启一次吗」）；`a3a2f93` 同样在 22:24 重启后才生效。汇报只能靠 Ria 自己记得说「待重启」，容易漏。
- 建议改法：在 `lib/index.js` 的 `ria_status` 返回体新增 `deploy: { repoHead, installedHead, runningHead, pendingRestart }`，其中 `runningHead` 取宿主 `/health` 或 daemon status 里的 HEAD，`installedHead` 读安装副本 `git rev-parse HEAD`；`pendingRestart = repoHead !== runningHead`。Ria 汇报「修好」时直接引用该字段。
- 影响面：只增字段，不破坏现有调用；所有「改完要重启」的工单受益，尤其是审批、看板这类多 commit 连续上线的模块。
- 优先级：P1

**3. 审批链补一个「链尾观察者」，区分「没到」与「到了没处理」**
- 问题：本次事故中 Ria 的监听器从未执行，所以 `58045f1` 新增的 `approval-diagnostics.jsonl` 在这种场景下也不会有记录（记录点在被跳过的 listener 内）；`session-2429abc2` e41 只能推断「极可能进入等待审批」。
- 建议改法：在 `lib/approvals.mjs` 注册两个 hook：一个 `{prepend:true}`（Ria 决策），一个普通注册放在链尾作为哨兵；哨兵只在「前面的 listener 全部 `next()` 下来」时执行，写 `approval-chain.jsonl`（含 agentId、toolName、callId、时间戳，不含参数正文）。有哨兵记录 = 请求到了但没人接；无哨兵记录 = 请求被上游截住。
- 影响面：仅新增日志文件与一次内存判断，不改变审批结果与延迟；对现有 audit 格式无影响。
- 优先级：P2

**4. 同日重跑要有权威标记**
- 问题：`refl-20261116-065fd8`（15:43:45Z 完成）与本 run 同日并存，status 只给 `ordinal:2`；`ticket_mwjfp8bj` 与本次 run 在 15:46:14.327Z 同一毫秒收口，无法从工具返回判断哪份报告是对外版本。
- 建议改法：`lib/reflect.mjs` 的 `begin()` 在 `ordinal>1` 时于 run 目录写 `supersedes.json`（记录上一次 runId 与状态），并在 report front matter 增加 `supersedes: refl-...`；`finish` 返回 `{ authoritative: bool, supersededRunId }`，`status` 输出 `latestCompleteRunId`。
- 影响面：反思调度、设置页历史列表、报告归档路径；均为新增字段/文件，旧 run 目录不受影响。
- 优先级：P2

## memory 候选

- **approval-deploy-gap**：说「审批修复完成」必须同时给三件事：commit、安装副本是否已同步、生产 running HEAD 是否包含它；未重启就明确写「待重启生效」，不得只说「已修复」。
- **checklist-close**：`ria_resolve` 前先看 checklist；有未勾项时要么勾完再关，要么在汇报里显式列出剩余项，不能只把 pending 塞进 resolution。
- **reflection-authority**：同一 forDate 重跑反思时，先确认上一次 run 是否已 complete；汇报必须带上权威 runId，避免两份报告并存时用户看到旧结论。

## 明日关注

1. **重启让 `58045f1` 生效，并用真实 worker 复测审批卡进微信**：这是今天唯一「已修未验」的关键路径（e87946 末句、`ticket_mwjdgo3w` 已 done 但生产未生效）。复测要覆盖：中风险生成审批卡并唤醒 Ria、高风险自动拒绝、超时 2 分钟按拒绝并通知。
2. **4 张待用户拍板的票**：`ticket_mwj6fahk`（A/B 二选一）、`ticket_mwiv7ut5`（跨机器 TODO）、`ticket_mwg151vq`（memory 中给 worker 的条目如何投递）、`ticket_mwedsk9u`（README 经典用法改写）——每次状态汇报都要显式列出，避免继续积压。
3. **两份反思报告的收口**：确认 attempt 1 与 attempt 2 的结论差异，指定权威版本并把关键教训写进 memory（本 run 只给候选，不写）。
4. **看板 `57492d6` / `fcfd6ea` 重启后的真机验收**：SSE 自动刷新（断线重连、页面隐藏恢复、滚动与筛选保留）目前只有 dev 侧截图与 fixture 证据（e85868），重启后需在 1440×900 上实际看一次。
5. **`sendmessage ret=-2`**：22:33 前后 Ria 会话出现过 `dsh: fatal load failure: Error: sendmessage ret=-2` 的未处理拒绝（`session-56448aa3` e35356 摘要），窗口内没有根因与修复记录，先确认是否仍是微信 Claw 的已知问题。

## 覆盖与成本

- 读取工单：window 内 78 张（summary），其中 12 张读 full（2 张 blocked + 10 张 dev worker 的 done 票）。
- 读取会话：4 个 —— `session-315b028e`（attempt 1 反思，回执）、`session-56448aa3`（Ria 主会话，turn 639-646）、`session-edd7b6d7`（Ria 开发，turn 114-117）、`session-2429abc2`（审批实测，turn 1）。
- 读取上下文：memory（1536 字符）、outbox（17644 字节，已截断）。
- 未调用 full 模式的会话；未复跑测试、未读 commit diff（只读工具无法执行）。
- 压缩/解压字节数与耗时由宿主在 finish 时按实际读取覆盖，此处写 0。

## 未覆盖

- **attempt 1 的报告正文**：只确认写入成功（`session-315b028e` e69-70、e73），无法比较两次结论差异。
- **窗口外（>15:46:14.327Z）的事件**：Ria 对「反思被重启打断会怎样」的答复正文、本 run 的开跑动作、`ticket_mwjfp8bj` 的 resolution 内容都看不到，因此「为什么开第 2 次 run」只能按时间戳推断，不作为结论。
- **未读会话**：`session-f7252a16`（众源BEV续，仅通过 Ria 的汇报转述，e36182）、`session-3315a7c9`（Ria 文档）、`session-105082b9`（权限审批测试）、`session-bf4eda62`（s3 跑批）、`session-ded5a8e1`（11-15 反思）、`session-4faf2fa2`（Blender），共 6 个；其中众源的关键数字属二手证据。
- **验证缺口**：`npm test` 是否全绿、截图是否真实存在、`57492d6`/`fcfd6ea`/`58045f1` 的实际 diff，均未独立复核；「60 个脚本」的计数存疑（e87946 thinking）。
