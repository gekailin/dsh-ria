# 任务看板预览

看板是只读的全屏浮层，不写工单、不派发消息、不唤醒 worker。它把工单按「项目 → 主题 → 工单」组织：横轴是项目（当前取 worker 所属 workspace），每个项目内是一组主题卡，打开主题卡可以看该主题下的全部工单和依赖。

截图用 mock 数据驱动真实 DSH Web shell 与工作区里的 `lib/client.js`，不是本机 `ria.json` 的实时投影。两档视口的截图生成在 `.ui-work/`（不提交）：1440 宽的主看板、主题弹窗和浮层，以及 1100 宽的主看板和主题弹窗。

## 主看板

- 横轴按项目排列；项目头显示项目名和「N 个主题 · 活跃 X · 阻塞 Y」。项目之间留间距，项目底色交替。
- 每个项目内最多 3 列主题卡。主题按 `lastUpdatedAt` 倒序，依次放进当前已用高度最小的列（瀑布贪心），因此越新的主题越靠前，列高保持接近。
- 主题卡固定 300px 宽，卡片间距 14px。卡头第一行是主题标题，第二行是「更新于 MM-DD HH:MM · done/total」。
- 卡头下面是 summary：优先用主题的 `brief`；为空时取该主题最近一张未完成工单的 goal，截断到 40 字并补上状态。
- 卡内只有三段：
  - 待执行：计数，最多列 2 条，其余显示「还有 N 条」。blocked 归入待执行，但行首有红点和「等拍板」标签。
  - 执行中：计数，最多列 3 条，其余显示「还有 N 条」。
  - 已完成：只显示计数，不列工单。
- 卡内不就地展开。点「还有 N 条」、计数行或卡片其它位置，都会打开该主题的主题页弹窗；折叠只表示省略显示。
- 顶部有搜索框和全部/进行中/卡住/空闲筛选。筛选只灰化不匹配的主题（opacity 0.32），主题卡保持在原位；搜索会过滤主题并重算瀑布布局。默认选中「全部」。
- 单击工单行复制 `ticketId`，底部弹出「已复制 ticket_…」约 2 秒；剪贴板权限失败时改为显示可手动选中的单号。单击主题卡打开主题页，不会复制。
- 悬停工单行弹出详情浮层：goal、状态、执行者、更新时间、依赖数、清单进度与逐条清单、卡点原因、排队说明。浮层可悬停、文字可选中；最多列 6 步清单，多出的显示「…还有 N 步」。浮层贴着视口边缘时自动翻转，不会超出窗口。
- 点工单行里的执行者名字调用宿主 `ctx.uiWorkspace.openSession(sessionId)` 打开会话；`executor=self` 显示「Ria」且不可点。执行会话缺失或归档时不跳转，只在浮层里标明。
- 底部提示「单击主题卡查看全部工单 · 单击工单行复制单号 · 点执行者打开会话 · 横向滚动查看其它项目」。

## 主题页弹窗

- 点主题卡或折叠项打开；标题是主题名，副标题是「N 张工单 · 待执行 X · 执行中 Y · 卡住 Z · 已完成 W」。
- 列出该主题下全部工单（含已完成），按 `updatedAt` 倒序，最新在上；已完成行灰显。
- 主题内依赖在左侧 26px 的 gutter 里用 SVG 曲线画箭头；跨主题依赖在行内用「↗ 在 <主题名>」标签标出，不画长线。
- 工单行与主看板共用同一组件和同一套交互：点行复制单号、悬停看详情、点执行者打开会话。
- 支持 Esc 关闭（先关浮层，再关弹窗）和点遮罩关闭；关闭弹窗后主看板保留原来的滚动位置和筛选。

## 数据

主看板：

~~~bash
curl -s "http://127.0.0.1:3080/plugins/dsh-ria/api/board?limit=200"
~~~

响应在原有 `counts` / `page` / `lanes` / `tickets` 之外新增 `projects`：

- `projects[]`：`projectId`、`title`、`kind`、`cwd`、`sessionId`、`counts`、`lastUpdatedAt`、`topics[]`。
- 每个 topic：`topicId`、`title`、`brief`、`level`、`parentId`、`unclassified`、`counts{open,working,blocked,done,total}`、`lastUpdatedAt`、`tickets`（待执行，最多 6 条）、`working`（执行中，最多 6 条）。
- 每张票带 `primaryTopicId`。一票最多一个 primary；`related` 链接不会把同一张票重复放到另一张主题卡上。

主题页：

~~~bash
curl -s "http://127.0.0.1:3080/plugins/dsh-ria/api/board/topic?topicId=topic_xxx"
~~~

返回 `topic`、`counts`、`tickets`（全部，含已完成）和 `edges`：`inside` 是主题内 `dependsOn` 边，`outside` 是跨主题依赖，带 `topicId` / `topicTitle`。`topicId` 不存在返回 404 `topic_missing`；缺少参数返回 400。

## 主题数据与迁移

- `ria.json` 升到 `schemaVersion: 5`，新增 `topics[]` 和 `links[]`。旧 v4 文件原样加载，字段缺失视为空数组；第一次写入前备份为 `ria.json.v4.bak`。更旧的 v3/v2/v1 仍按原路径迁移并各自备份。
- 主题用 `ria_topic` 维护：create / update / link / unlink / merge / archive / list。`link` 的 role 为 primary 或 related；同一张票再设 primary 时，旧 primary 自动降为 related。`archive` 只在主题没有未完成工单时允许。
- 没有 primary 主题的票会进入每个项目合成的「未分类」桶；这个 `topicId` 以 `unclassified:` 开头，只存在于 API 响应，不写入 `ria.json`。历史工单不会被编造主题。
- 拿不到 `topics` 数据（旧档或空主题）时，看板仍渲染「未分类」桶，不白屏。

## 已覆盖的边界

- 空看板、搜索无结果、主题没有工单、主题 brief 为空、worker 会话缺失、worker 已归档。
- 瀑布列分配（最矮列、并列取低列号）、每项目最多 3 列、主题卡高度随三段条数变化。
- 主题卡折叠行只打开主题页，不就地展开。
- 主题内依赖与跨主题依赖；已完成行灰显但仍可复制和悬停。
- 剪贴板 API 失败时的降级、浮层贴边翻转与视口 clamp、Esc 的关闭顺序。
- v4 到 v5 的迁移与 `ria.json.v4.bak` 备份；旧 `GET /board` 字段仍保留，旧测试继续通过。

## 实测（mock）

- 1440 视口：4 个项目、18 张主题卡，单卡 300×281，画布宽 3330px，面板 1396×769；默认「全部」，没有灰化。
- 主题弹窗：11 行工单、3 条主题内依赖连线、3 条跨主题「在 …」提示；弹窗 900×683。
- 1100 视口：面板 1056×776，项目横向滚动，主题弹窗 900×689。
