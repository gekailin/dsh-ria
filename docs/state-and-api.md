# 状态文件与 HTTP API

## 状态文件

~~~text
DSH_HOME/state/ria/
  ria.json       # riaSessionId、riaPreset、tickets、pending deliveries、grants、settings、dispatchNotes
  outbox.json    # 副作用待投递/失败记录（dispatch note、微信镜像），0600
  memory.md       # 用户偏好和长期记忆
  audit.jsonl     # 临时权限审计，0600
  wechat/creds.json        # 微信文件传输助手登录凭据，0600
  wechat/state.json        # 已处理消息 id、Outbound 队列、暂停状态与时间
  wechat-claw/creds.json   # 微信 Claw bot_token、accountId、baseUrl、userId，0600
  wechat-claw/state.json   # 暂停状态
  wechat-claw/cursor.json  # getupdates 长轮询游标
  qq-bot/creds.json        # QQ 机器人 appId、appSecret、userOpenid，0600
  qq-bot/state.json        # 暂停状态
~~~

不保存聊天 transcript。Ria 的原始 Session 日志仍由 DSH 写在 DSH_HOME/sessions 下。

## HTTP API

前缀：/plugins/dsh-ria/api

- POST /ensure：创建或打开全局唯一的 Ria。
- GET /state：riaSessionId、tickets、pendingDeliveries、grants、settings、workerIdleNotifications（enabled/throttleMs）、wechatClawAssistant（最近一条 assistant 正文的转发结果，未产生过为 null）。
- GET/POST /settings：读取或设置 {dispatchGuard:boolean, wechatAutoPause:boolean, reflection:object, style:object}（GET 还返回 progressCards、reflectionStatus 与 style.effectiveText）。reflection 默认 {enabled:false, cadence:"daily", time:"23:40", weekday:1, model:null, provider:null, reasoningEffort:null}，timezone 固定 Asia/Shanghai；POST 可只传其中一个，reflection 可只传部分字段并浅合并。校验：enabled 必须 boolean，cadence 为 daily|weekly，time 匹配 HH:MM，weekday 为 1–7 的整数，model/provider/reasoningEffort 为非空字符串或 null；任一项非法整包 400 且不部分写入。开启 reflection 时维护「Ria: 定期反思」计划；宿主无 schedule 服务时设置仍保存，reflectionStatus.scheduleError 给出原因。style 默认 {enabled:false, preset:"concise", custom:""}，preset 为 concise|warm|formal|playful，custom 最多 300 字；POST 的 style 可只传部分字段并浅合并，enabled 必须 boolean、preset 必须在枚举内、custom 必须是字符串且不超过 300 字，非法整包 400；空对象不算有效 patch。effectiveText 是服务端渲染的完整风格指令，style 关闭时为空字符串，前端不复制文案。
- GET /reflection/status：只读返回 {lastCompletedDate, lastStatus, lastError, activeRunId, workerSessionId, scheduleId}。
- POST /reflection/run：body {force?:boolean, forDate?:YYYY-MM-DD}；forDate 缺省为 Asia/Shanghai 今天，非法日期 400。已有运行中的反思返回 409 {error, runId}；否则向 Ria 注入 `[REFLECTION MANUAL] forDate=… force=…` 提醒并返回 202 {queued:true, forDate}。注入失败返回 500，不假报成功。
- GET /dispatch-notes?sessionId&turn：读取 Ria 的派发 note；sessionId 必须是当前 Ria，turn 可选且必须是非负整数；返回 {notes}。
- GET /board?limit=60&before=<createdAt>：只读任务看板数据。limit 默认 60、范围 1–200，before 是上一页最旧一张的 createdAt；服务端合并热存与归档日志后按 createdAt 升序取最后 limit 张。返回 {ok, generatedAt, riaSessionId, counts:{total,active,terminal,blocked}, page:{limit,before,returned,total,hasMore,nextBefore}, lanes, tickets, projects}；tickets 含 ticketId/goal/status/waitingOn/blockedReason/attention/dependsOn/dependentCount/checklist/progress/executor/executorTitle/executorCwd/executorArchived/executorMissing/archived/primaryTopicId/laneId/laneLabel/createdAt/updatedAt/closedAt/readyAt/queueState/queueText。executor 为 `self` 或当前 Ria 时归入「Ria · 管家」；worker session 缺失或已归档只降级标道，不返回错误；归档工单带 archived=true。limit 非法或 before 不是时间戳时返回 400。
- projects 是看板的主投影：每个项目含 projectId/title/label/kind/cwd/sessionId/counts{total,active,terminal,blocked,topics}/lastUpdatedAt/topics；每个主题含 topicId/title/brief/level/parentId/unclassified/counts{total,open,working,blocked,done}/lastUpdatedAt/tickets（primary 链接的待执行最多 6、执行中最多 6，done 只给计数）。没有 primary 的工单进入 `unclassified:<laneId>` 合成桶，topicId 不落库。
- GET /board/topic?topicId=<id>：主题详情。返回 {ok, topic, counts, tickets, edges:{inside:[{from,to}], outside:[{ticketId,dependsOn,topicId,topicTitle,topicUnclassified}]}}；tickets 是该主题 primary+related 的全部工单，按 updatedAt 倒序，字段与 /board 的 ticket 投影一致；主题不存在返回 404 {ok:false,code:"topic_missing"}，缺少 topicId 返回 400。
- POST /ask：body {topicId, text, source}，source 为 panel|card。把一条普通用户消息发给 Ria（mode=queue，忙时排队、不打断当前 turn），正文带「【看板 · 主题面板】/【看板 · 主题卡】【主题名】」来源标注；二级主题加「（子主题）」。只发消息，不建工单、不派发、不唤醒 worker。text trim 后非空且不超过 1000 字。成功返回 {ok:true, topicId, source, sessionId}；topic 缺失 404 topic_missing，未分类桶 400 topic_unclassified，空文本 text_empty，超长 text_too_long，source 非枚举 source_invalid，投递失败 502 ask_failed。
- GET /health：健康检查。
- GET /wechat/status：微信登录和连接状态，含 paused/pausedBy/pauseReason/pausedAt/resumedAt/resumedBy、wechatAutoPause、folded 和 lastFoldedAt。
- POST /wechat/login：获取登录二维码。
- POST /wechat/logout：退出微信登录。
- POST /wechat/start：用已有凭据重连。
- POST /wechat/pause：手动暂停或恢复推送，body {paused, reason?}。
- GET /channels/status：三个聊天通道（wechat、wechat-claw、qq-bot）的登录和连接状态；每项含 paused/pausedBy/pauseReason/pausedAt/resumedAt/resumedBy，wechat 项另有 wechatAutoPause。
- GET /channels/<id>/status：单个通道状态，id 为 wechat、wechat-claw 或 qq-bot。
- POST /channels/<id>/login：获取二维码并开始扫码登录。
- POST /channels/<id>/logout：退出该通道并删除本机凭据。
- POST /channels/<id>/start：用已有凭据重连。
- POST /channels/<id>/pause：手动暂停或恢复推送，body {paused, reason?}。
- /wechat/status|login|logout|start|pause 仍然保留，等价于 wechat 通道。

所有请求校验 DSH 同源；没有额外的 loopback 端口。
