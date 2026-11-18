# 聊天连接

Ria 入口标题右侧有一个“连接”chip。点开后是一个通道面板，可以在三个通道之间切换、扫码登录、查看连接状态、暂停推送和退出登录。面板按微信 Claw、QQ 机器人、微信「文件传输助手」排列，但打开时默认选中上次使用的通道；没有记录或记录已失效时回退到微信「文件传输助手」。这个偏好保存在浏览器 `localStorage` 的 `dsh.ria.channels.last.v1`，刷新页面或重启 dsh web 后仍然有效，和面板排列顺序无关。

| 通道 | id | 扫码后得到 | 入站 | 出站 |
|---|---|---|---|---|
| 微信 Claw | `wechat-claw` | bot_token、账号、baseUrl | 文本、图片、文件 | 文本、本机图片、本机文件 |
| QQ 机器人 | `qq-bot` | AppID、AppSecret、openid | 文本 | 文本、本机文件 |
| 微信「文件传输助手」网页版 | `wechat` | Cookie / sid / skey | 文本、图片 | 文本、.md 文件、本机图片、本机文件 |

三个通道都运行在 DSH 进程内，不启动 bridge 进程，不额外占端口（QQ 使用出站 WebSocket）。扫码只需要在面板里做一次，凭据保存在本机，DSH 重启后自动重连。Ria 启动后会向当时已连接的通道发送一条「Ria 已重启」通知；通道是异步登录的，启动后约一分钟内连接上的也会收到，每个通道每次启动最多一条。

微信「文件传输助手」的细节、长回复转 .md 的规则见 [wechat.md](wechat.md)；图片和文件的通道差异见下文与 [wechat.md](wechat.md#图片)。本文说明三个通道共用的面板、微信 Claw 与 QQ 机器人的协议和限制。

## 入站消息如何交给 Ria

三个通道的手机入站消息走同一条投递路径，不再固定排到 Ria 的下一轮：

- Ria 当前有运行中的 turn（`turn/start` 到 `turn/end` 之间）时，消息用 `mode="steer"` 注入这一轮。Ria 会在当前步骤结束后看到它，可以把它当补充信息，回复可能比空闲时晚。
- Ria 空闲时，仍用 `mode="queue"` 起一个新 turn。
- 如果 steer 抛错（例如 turn 刚好结束），宿主会自动退回一次 `mode="queue"`，并复用同一个 `requestId`；宿主按 requestId 去重，不会因为“steer 已部分入队、随后报错”而投递两次。两次都失败才走原有的“消息未能交给 Ria”通知。
- 每次尝试记一行日志：`[<channel> inbound] mode=steer|queue reason=ria_busy|ria_idle|steer_failed requestId=...`。

这个取舍只影响“这句话什么时候进入 Ria 的上下文”，不改变图片/文件的下载与落盘、失败提示、暂停、typing、未送达通知和 outbox，也不改变 `ria_request` / `ria_resolve` 的 worker 派发模式。需要 Ria 立刻作为独立新任务处理时，最好等它空闲后再发；在长任务中插话时，steer 更像补充说明，而不是抢占当前任务。

## 微信 Claw

“微信 Claw”直接对接腾讯 iLink 的机器人接入接口，不需要安装 OpenClaw，也不依赖本机上的 QBotClaw。

1. 面板请求 `GET {base}/ilink/bot/get_bot_qrcode?bot_type=3`，拿到 `qrcode` 和 `qrcode_img_content`；后者是一个 URL，用本机 qrcode 编码器渲染成 PNG data URL 显示。
2. 每 1.2 秒轮询 `GET {base}/ilink/bot/get_qrcode_status?qrcode=...`，带 `iLink-App-ClientVersion: 1`。状态依次是 `wait`、`scaned`、`confirmed`，过期是 `expired`。
3. 二维码有效期 5 分钟；过期会自动刷新，最多刷新 3 次，总等待上限 480 秒。面板上看到“二维码已过期，正在刷新…”时不需要手动点。
4. `confirmed` 后返回 `bot_token`、`ilink_bot_id`、`baseurl`、`ilink_user_id`。账号 id 会把 `-im-bot` 归一成 `@im.bot`、`-im-wechat` 归一成 `@im.wechat`，原始值也一并保存。
5. 连接后用 `POST /ilink/bot/getupdates` 做 45 秒长轮询，游标保存在 `cursor.json`。文本消息的 `item_list` 里是 `type=1` 的 `text_item.text`，图片是 `type=2` 的 `image_item`。
6. 回复走 `POST /ilink/bot/sendmessage`，带 `context_token`（来自最近一条入站消息）和 `message_type=2`、`message_state=2`。没有收到过消息时没有可回复的目标，发送会报“尚未收到可回复的消息”。

### 图片

图片双向固定开启，设置页没有开关。旧 profile 里的 `wechatClawImage.inbound` / `wechatClawImage.outbound` 仍然可以读取，但不再生效；启动时统一归一为 true，旧的 `PATCH /plugins/dsh-ria/api/settings` 也会被忽略。

| 方向 | 触发 | 处理 |
|---|---|---|
| 入站 | `item_list` 中 `type=2` 的 `image_item` | 从 `media.full_url` 或加密 CDN 地址下载，用 `aeskey`/`media.aes_key` 做 AES-128-ECB 解密，按文件头只收 PNG/JPEG/GIF/WebP，上限 20 MB（且不超过宿主附件限制） |
| 出站 | assistant 文本里的 `![alt](path)` | 本机真实图片；先 `getuploadurl`（`media_type=1`），AES-128-ECB 加密后 POST 到 CDN，取响应头 `x-encrypted-param`，再发 `type=2` 的 `image_item`；`media.aes_key` 用 `base64(32 位 hex 字符串)`（44 字符），用裸密钥的 base64（24 字符）会显示成黑图并提示“已过期或被清理” |

- 入站落盘：`DSH_HOME/state/ria/wechat-claw-inbound/YYYYMMDD-HHMMSS-<msgid>.<ext>`，目录 0700、文件 0600，重名追加 `-2`；保留最近 30 天、最多 500 个。图片作为 `{ type: 'image', mediaType, data }` 内容块和原文字一起投给 Ria，路径附在文字里，可直接作为 `ria_request` 的附件。
- 入站失败：下载、解密、格式、大小或附件校验失败都不会丢消息；Ria 仍收到原文字（纯图用“（用户发来一张图片）”占位）加 `[图片接收失败：<原因>]`，日志记 `[claw inbound] image <id> rejected (<code>): <reason>`。
- 出站失败：单张图片发送失败只回退成一条可见文本“图片 <name> 发送失败，请在 Ria 会话中查看原图”，不影响已发出的文本和其他图片；围栏代码块里的示例不发送；暂停推送时图片和文本一样不发送。
- 旧配置里的 `inbound: false` / `outbound: false` 不再生效：服务启动时归一到 true，接口也不接受关闭。图片消息始终下载、落盘并转给 Ria，回复里的本地图片始终上传发送。
- 协议来源：腾讯公开的 `Tencent/openclaw-weixin` 客户端实现（`docs/protocol.md`、`src/api/types.ts`、`src/messaging/send.ts`、`src/cdn/upload.ts`、`src/media/media-download.ts`）；CDN 下载不带 bot token，上传成功以响应头 `x-encrypted-param` 为准。

### 文件

微信 Claw 的文件消息使用 iLink 的 `type=4` `file_item`：

~~~json
{
  "type": 4,
  "file_item": {
    "media": {
      "encrypt_query_param": "...",
      "aes_key": "base64(32 位 hex 字符串)",
      "encrypt_type": 1,
      "full_url": "https://..."
    },
    "file_name": "方案.pdf",
    "md5": "...",
    "len": "12345"
  }
}
~~~

`len` 是明文字节数的十进制字符串。下载地址优先 `media.full_url`，没有时用 `<cdn_base>/download?encrypted_query_param=<encodeURIComponent(encrypt_query_param)>`；密钥 `aes_key` 先 base64 解码成 32 个 hex 字符，再解成 16 字节，AES-128-ECB + PKCS#7 解密。CDN 下载不带 bot token。

- 入站落盘：`DSH_HOME/state/ria/wechat-claw-inbound-files/YYYYMMDD-HHMMSS-<msgid>-<清洗后的文件名>`，目录 0700、文件 0600；重名追加 `-2`，最多尝试 1000 次。文件名只保留 basename，控制字符、路径分隔符和 Windows 非法字符替换为 `_`，去掉前导点与尾部点/空格，最长 120 字符。保留最近 30 天、最多 500 个。
- 投递形式：文件不会变成宿主的 file part，而是以明确的文本引用进入 Ria 消息：`📎 文件：<name>（<size>）` 加一行 `   路径：<absolute path>`。原文字保留；纯文件用“（用户发来一个文件）”占位。Ria 可以直接把路径作为后续参数或 `ria_read` 的目标。
- 预检顺序：先按扩展名和 `len` 判断；下载上限按 `aesEcbPaddedSize(maxBytes)` 放宽给 AES 填充，解密后再按明文大小检查。下载、解密、超限或扩展名不支持都不丢整条消息，仍投原文字并追加 `[文件接收失败：<原因>]`，日志记 `[claw inbound] file <id> rejected (<code>): <reason>`。
- 允许的扩展名：pdf、doc/docx、xls/xlsx、ppt/pptx、zip/gz/tar/7z/rar、txt、md、csv、json、html、xml、yml/yaml、log、png/jpg/jpeg/gif/webp、svg。其它类型（如 exe、sh）回“不支持的文件类型：<ext>”，不落盘。
- 上限默认 20 MB，配置在 `channels.wechat-claw.files.maxBytes`（上限 100 MB）；`channels.wechat-claw.files.enabled=false` 时只回“目前文件接收已关闭。”，不投给 Ria。QQ 和微信「文件传输助手」的入站仍只处理文本/图片。
- 出站：assistant 要发文件时调用 `ria_send_file({ path, note? })`，详见 [tools.md](tools.md#发送文件)。Host 先 `POST /ilink/bot/getuploadurl`，body 含 `filekey`（16 字节随机 hex）、`media_type: 3`、`to_user_id`、`rawsize`、`rawfilemd5`（md5 hex）、`filesize`（AES 填充后大小）、`no_need_thumb: true`、`aeskey`（16 字节随机 hex）；地址优先响应里的 `upload_full_url`，否则 `<cdn_base>/upload?encrypted_query_param=<param>&filekey=<filekey>`。把 AES-128-ECB 密文 POST 上去，成功后取响应头 `x-encrypted-param`；4xx 不重试，其它错误最多 3 次。
- 发送消息时用 `type=4` 的 `file_item`：`media.encrypt_query_param` 来自 `x-encrypted-param`，`media.aes_key` 是 `base64(32 位 hex 字符串)`（不是裸密钥的 base64），`media.encrypt_type=1`，`file_name` 和 `len`（十进制字符串）填原文件信息。caption 另发一条文本，不塞进 file_item。
- 暂停推送时 `ria_send_file` 不进 CDN、不发送，而是以 `channel_file_send` 入 outbox 并返回 `queued=true`；恢复后自动重试，暂停/没有可回复目标时 deferred 不消耗 `attempts`。成功或失败都会在通道状态里留下 `lastFileSend`（delivered、name、bytes、path、code/error/ret/errmsg），失败不会静默吞掉。
- 协议来源：`Tencent/openclaw-weixin` 的 `docs/protocol.md`、`src/api/types.ts`、`src/messaging/send.ts`、`src/cdn/upload.ts`、`src/media/media-download.ts`；未在真实账号验证文件是否能在手机端正常打开。

### 正在输入

微信 Claw 在收到真实用户消息并成功交给 Ria 后，会调用原生「正在输入」；默认开启：

~~~yaml
- id: ria
  config:
    channels:
      wechat-claw:
        typing:
          enabled: true
          refreshMs: 5000
          maxMs: 600000
~~~

- `POST /ilink/bot/getconfig`，body 为 `{ ilink_user_id, context_token?, base_info: { channel_version: "1.0.3" } }`，取响应里的 `typing_ticket`，按 `ilink_user_id` 缓存复用。
- `POST /ilink/bot/sendtyping`，body 为 `{ ilink_user_id, typing_ticket, status, base_info }`；`status=1` 开始，`status=2` 取消。
- 处理期间每 `refreshMs`（默认 5 秒）续期一次，单次最长 `maxMs`（默认 10 分钟）。
- 任何出站（文本、图片、Markdown 文件）发送前先发 `status=2`，并且取消与发送按用户串行，避免取消落到发送之后；处理失败、暂停推送、连接断开或退出登录也会取消。
- `typing_ticket` 请求失败或返回 `ret != 0` 时作废并重取一次；typing 自身的异常只记 debug 日志，不重试风暴、不影响收发。
- `enabled: false` 时不会发出任何 typing 请求。`GET /channels/wechat-claw/status` 额外返回 `wechatClawTyping: { enabled, refreshMs, maxMs, ticketCache, active }`。
- 未在真实账号验证「正在输入」是否真的显示；协议来自 `Tencent/openclaw-weixin` 的 `getconfig`/`sendtyping` 调用。

### 回复补发与可观测性

- `sendmessage` 返回 `ret != 0` 时，错误会带上 `ret` 和 `errmsg`，不再只有裸 `ret`。出站单条按 4000 字符、最多 8 段发送，长报告不会因为超过 iLink 单条约 5000 字符的上限而整条丢失。
- 每条 assistant 正文的转发结果记在 `lastAssistantForward`：`{ at, eventAt?, reason, chars, preview, eventSeq?, images?, imagesFailed?, error?, errorCode?, ret?, errmsg?, deliveredChunks?, totalChunks?, fallbackQueued?, fallbackError? }`。`eventAt` 是 assistant 事件本身的时间（用于恢复重排），`at` 是记录这条转发结果的时间。`reason` 取 `delivered`、`paused`、`no_outbound`、`no_text`、`extract_failed`、`send_failed` 之一。
- `GET /channels/wechat-claw/status` 返回 `lastAssistantForward`，`GET /plugins/dsh-ria/api/state` 的 `wechatClawAssistant` 与之同源。插件自己的持久日志在 `<stateDir>/wechat-claw/assistant.log.jsonl`（0600，超过 2 MB 轮转为 `.1`），不依赖 dsh-web.log。
- 正文没有送达（暂停、无 outbound、发送或图片提取失败）时，会以 durable `wechat_assistant_note` 入 outbox，由微信 Claw 通道补发，消息前缀「（补发）」。legacy 微信通道不发，避免重复。
- 补发保持 pending 直到成功：暂停或没有 peer 时标记 deferred，不消耗重试次数；下一次 Claw 入站刷新 `context_token` 后，会把这些补发重新置为待投递并立即重试。`wechat_assistant_note` 入队时带 assistant 事件的 `eventAt`；微信侧通道恢复后，它会和派发/审批卡片一起按事件时间重排，不会被折叠掉。
- 补发正文超过 24000 字符会截断，并附「补发内容已截断，完整内容见 Ria 会话」。

限制与行为：

- 语音、视频仍不处理：会回复一句“目前只能接收文本消息。”，不会交给 Ria。文件按上一节的「文件」处理。
- 一个账号同一时间只能有一个 Claw 会话；退出登录后重新扫码可以换账号。
- token 失效或长轮询持续失败时，状态卡会显示错误；重新扫码即可。失败后按 2 秒、30 秒退避重试，不会立刻断开。
- 不读取历史消息，不支持群管理、@ 判断、引用回复，也不支持语音、视频；文件见「文件」一节。

默认接口地址是 `https://ilinkai.weixin.qq.com`。开发和测试时可以用 `WX_CLAW_BASE` 指向本地假服务，用 `WX_CLAW_QR_POLL_MS` 调快轮询。

## QQ 机器人

QQ 通道使用 QQ 开放平台的“扫码绑定机器人”流程，再通过官方 MIT SDK 的 WebSocket 网关收发消息。

1. 本机生成 32 字节随机 `key`，`POST https://q.qq.com/lite/create_bind_task`，body 为 `{"key":"<base64>"}`，返回 `task_id`。
2. 把 `https://q.qq.com/qqbot/openclaw/connect.html?task_id=<task_id>&source=dsh-ria&_wv=2` 渲染成二维码。手机 QQ 扫码后完成绑定。
3. 每 2 秒 `POST /lite/poll_bind_result`，body 为 `{"task_id":"..."}`。状态 0 是未开始、1 是等待/已扫码未确认、2 是完成、3 是过期；过期后自动重建任务，最多 3 次，总等待上限 5 分钟。
4. 完成时返回 `bot_appid`、`bot_encrypt_secret`、`user_openid`。用本地 `key` 做 AES-256-GCM 解密：载荷是 `iv(12 字节) + ciphertext + authTag(16 字节)`，明文就是 AppSecret；认证失败会拒绝保存。
5. 凭据写进 `qq-bot/creds.json` 后，用 `@tencent-connect/qqbot-nodejs` 连接 QQ Bot API v2 的 WebSocket 网关，鉴权用 AppID + AppSecret。
6. 收到 `message` 事件后只处理 `c2c` 和 `group`。群消息需要 @ 机器人（`mentionGate({ requireMentionInGroup: true, alwaysAnswerC2C: true })`），SDK 会过滤机器人自己的回显并去重。
7. 回复用 `bot.sendText({ scope, targetId }, text)`，目标来自最近一条入站消息的 `replyTarget`。

### 正在输入（仅 C2C）

QQ 只有单聊（C2C）支持输入状态，群聊和频道不做假实现。默认开启：

~~~yaml
- id: ria
  config:
    channels:
      qq-bot:
        typing:
          enabled: true
          durationSec: 30
          refreshMs: 30000
          maxMs: 600000
~~~

- 收到真实 C2C 用户消息并成功交给 Ria 后，发送一次 `POST /v2/users/{openid}/messages`，body 为 `{ msg_type: 6, input_notify: { input_type: 1, input_second: N }, msg_seq, msg_id? }`，鉴权沿用现有 QQ access token。
- `input_second` 是 QQ 显示输入状态的秒数（默认 30），到期自动消失；QQ 没有显式取消接口，所以回复发出前按 `refreshMs` 再发一次续期，回复发出后停止续期。
- `refreshMs` 不会短于 `durationSec * 1000`，避免比 QQ 的显示窗口更密；单次最长 `maxMs`（默认 10 分钟）。
- 暂停推送、连接断开、退出登录或处理失败都会清掉续期定时器；typing 异常只记 debug 日志，不影响收发。
- `enabled: false` 时不会发出任何 typing 请求。`GET /channels/qq-bot/status` 额外返回 `qqTyping: { enabled, durationSec, refreshMs, maxMs, active }`。
- 未在真实 QQ 账号验证输入状态是否显示；C2C-only 的结论来自官方 SDK `@tencent-connect/qqbot-nodejs` 的 `sendTyping` 与 `sendInputNotify` 实现。

限制与行为：

- 只处理文本。非文本消息会回复“目前只能接收文本消息。”，不会交给 Ria。
- 「正在输入」只在 C2C 发送；群聊/@ 场景没有输入状态。
- 群聊必须 @ 机器人；私聊直接说话即可。
- 机器人需要在 QQ 开放平台有可用的消息权限，并且已经发布或处于可用的沙箱环境；否则网关能连上也可能收不到消息。
- 没有收到过消息时没有回复目标，主动推送会失败；这是平台限制，不是 Ria 的队列问题。
- 在面板里退出登录只删除本机凭据，不会在 QQ 开放平台删除机器人。
- 开发和测试时可以用 `QQ_BIND_HOST` 指向本地假服务，用 `QQ_BIND_POLL_MS` 调快轮询，用 `QQ_BIND_SOURCE` 改二维码里的 source 参数。

## 状态文件

~~~text
DSH_HOME/state/ria/
  wechat/
    creds.json       # 文件传输助手登录凭据，0600
    state.json       # 去重、待发队列、暂停状态
  wechat-claw/
    creds.json       # bot_token、accountId、baseUrl、userId，0600
    state.json       # 暂停状态
    cursor.json      # getupdates 游标
  wechat-claw-inbound/        # 入站图片，0700
  wechat-claw-inbound-files/  # 入站文件，0700
  qq-bot/
    creds.json       # appId、appSecret、userOpenid，0600
    state.json       # 暂停状态
~~~

目录 0700，文件 0600。这里只保存连接与去重状态，不保存聊天 transcript；会话日志仍由 DSH 写在 `DSH_HOME/sessions`。凭据是明文 JSON，依赖 DSH_HOME 的文件权限保护；不要把这个目录同步到公开仓库或云盘。

## HTTP API

前缀：`/plugins/dsh-ria/api`

- `GET /channels/status`：返回三个通道的状态：

  ~~~json
  {
    "ok": true,
    "channels": {
      "wechat": { "loggedIn": true, "paused": false, "login": { "phase": "success" } },
      "wechat-claw": { "loggedIn": false, "login": { "phase": "idle", "message": "未连接微信 Claw" } },
      "qq-bot": { "loggedIn": false, "login": { "phase": "idle", "message": "未连接 QQ 机器人" } }
    }
  }
  ~~~

- `GET /channels/<id>/status`：单个通道，字段与上面一致。`id` 是 `wechat`、`wechat-claw`、`qq-bot`。
- `POST /channels/<id>/login`：获取二维码并开始轮询。返回当下的状态，`login.qr` 是 PNG data URL。
- `POST /channels/<id>/logout`：中止登录、断开连接、删除该通道凭据。
- `POST /channels/<id>/start`：用已有凭据重连。
- `POST /channels/<id>/pause`：body 为 `{"paused":true}` 或 `{"paused":false}`，可选 `reason`；`paused` 不是布尔值返回 400。

旧的 `/wechat/status`、`/wechat/login`、`/wechat/logout`、`/wechat/start`、`/wechat/pause` 仍然保留，等价于 `wechat` 通道。所有请求校验 DSH 同源，没有额外的 loopback 端口。

## 暂停与多通道

暂停只关闭“Ria -> 该通道”的出站推送：连接、登录态、长轮询和 WebSocket 保持，入站消息照常投递给 Ria。暂停状态写在各通道的 `state.json`，DSH 重启后保持。

- 手动暂停：面板里的“暂停推送”，或 `POST /channels/<id>/pause`，`pausedBy=manual`。
- 自动暂停：当 Ria 收到来自另一个通道的用户消息时，本通道自动暂停，`pausedBy=channel`。原因会点名来源通道，例如“微信 Claw 通道消息”“QQ 通道消息”“微信「文件传输助手」通道消息”；只有无法识别的来源才写“非微信通道消息”/“非微信 Claw 通道消息”/“非 QQ 通道消息”。设置页的 `wechatAutoPause=false` 只关闭微信「文件传输助手」的自动暂停；微信 Claw 和 QQ 通道仍按本规则暂停自己。
- 派发 note、审批提醒的文本会发给最近活跃的微信侧通道（「文件传输助手」或微信 Claw），不会发给 QQ；两个都不可用时留在 outbox 等待，规则见 [wechat.md](wechat.md#派发审批-note-走哪个微信通道)。
- 自动暂停提示不走上面的路由：被暂停的通道只在自己的通道发一条提示。仅当 `pausedBy=channel` 且本次从「未暂停」变为「暂停」时入队一次，手动暂停不发；同一 `pausedAt` 去重，DSH 重启重放不重复。未连接或没有可回复目标时不入队。提示走 outbox 的 `channel_pause_notice`，`dedupeKey` 为 `channel:pausedAt`；暂停态仍可发出这一条（绕过暂停），投递时若已恢复或 `pausedAt` 已变化则直接丢弃，deferred 不消耗 `attempts`，真正的发送失败按 outbox 退避重试。
- 通道收到自己的消息时会恢复推送，包括之前是手动暂停的情况；因为用户在这个通道里说话，本身就表示希望在这里继续。
- 恢复时按真人消息锚点重放：手动恢复或收到本通道消息自动恢复时，Ria 读取持久化的 `lastHumanMessageAt`（任意通道最后一条真人消息）。事件时间 `eventAt` 不晚于锚点的通知静默标记 `delivered`，不发送也不生成汇总；晚于锚点的按 `eventAt` 升序重排，assistant 正文与派发/审批卡片混排补发，`dedupeKey` 去重。恢复时刻和单通道 `lastInboundAt` 不是锚点；旧版 `wechat_fold_notice` 一律静默。`folded` 与 `lastFoldedAt` 仍出现在 `/channels/<id>/status`、`/wechat/status` 和 `ria_status.outbox`，但当前流程不再累加。
- 合成消息（`host_` 开头的启动恢复、启动失败、worker idle 唤醒）和官方 schedule 提醒不触发切换。
- 因此正常情况下只有“最后收到用户消息的通道”在推送，避免同一条回复发到多个聊天窗口。手动暂停优先：自动暂停不会覆盖 `pausedBy=manual`，但该通道自己的入站消息会恢复它。

已知边界：DSH 重启时每个通道各自恢复自己的暂停状态。如果上次退出前多个通道都处于推送中，重启后在第一条新入站消息到来之前，它们都可能收到同一条回复；第一条消息会立刻把其他通道自动暂停。首次配置多个通道时，建议只保留一个通道推送，其余手动暂停。

正在发送的那一条会发完；还没开始发送的排队消息丢弃。暂停和恢复会写 info/warn 日志，日志前缀分别是 `dsh-ria: wechat:`、`dsh-ria: wechat-claw:`、`dsh-ria: qq-bot:`。

## 状态语义

状态颜色和文案由登录态与登录阶段决定，三个通道使用同一套规则：

| 条件 | 颜色 | 文案 |
|---|---|---|
| 未登录，无登录流程（idle 或其它阶段） | 灰 `#9ca3af` | 未连接 |
| 未登录，`waiting`（二维码等待扫描） | 灰 `#9ca3af` | 未扫码 |
| 未登录，`scanned` | 琥珀 `#f59e0b` | 已扫码，待确认 |
| 未登录，`connecting` / `starting` | 琥珀 `#f59e0b` | 连接中 |
| 已登录，未暂停 | 绿 `#22c55e` | 已连接 |
| 已登录，已暂停推送 | 琥珀 `#f59e0b` | 推送已暂停 |
| 登录阶段为 `error`（无论是否已登录） | 红 `#ef4444` | 连接失败 |

“推送已暂停”只表示“已连接但暂停推送”。通道断开后即使本机还保存着上次的暂停标记，`/channels/status` 也返回 `paused: false`，面板显示“未连接”或“未扫码”，不会显示“推送已暂停”。重新登录后，原来的暂停状态仍按各通道的 `state.json` 恢复。

## 面板行为

- chip 上有三个小圆点，分别对应三个通道：绿色已连接、橙色登录中或已连接但暂停推送、红色错误、灰色未连接（含等待扫码）。标签显示“连接”或“连接 N”。
- 打开面板停在最近使用的 tab（没有记录时是微信）。当前 tab 没有登录且不在登录中时，会自动请求一次二维码；切到其他 tab 也会自动请求一次。
- 二维码 210×210，显示在面板里；“刷新二维码”会重新创建会话或绑定任务。
- 已登录时显示账号、推送状态、暂停/恢复和退出登录。错误状态显示在二维码下方或状态卡下方。
- chip 只在宽侧边栏显示；折叠侧边栏不插入。

## 限制

- 微信 Claw 支持文本、图片、文件；QQ 机器人支持文本和出站文件；微信「文件传输助手」支持文本、图片和出站文件。QQ 和「文件传输助手」的入站文件仍未实现，入站遇到文件只会回文本提示。微信 Claw 入站的非文本/图片/文件 item 只回提示；QQ 不发派发/审批/暂停这类 note。
- 三个通道都没有在真实账号上完成一次完整的扫码收发验证；协议用本地 mock 服务覆盖，见 [testing.md](testing.md)。真实扫码、平台权限和消息窗口仍需要在目标环境确认。
- 不保存聊天历史，也不做跨通道去重；同一条平台消息如果被重复投递，依靠各通道的 message id 去重。
- QQ 群消息必须 @ 机器人；这是产品行为，不是可配置项。
- 同一通道同时有多个聊天目标（多个 QQ 群，或微信 Claw 的多个用户会话）时，回复发给最近一条入站消息的来源；Ria 处理期间如果另一个会话插话，回复可能发到最新的那个。建议一个通道只保留一个常用会话，或分开时间段使用。
- 没有终端扫码入口，二维码只在 Web 面板里显示。

## 故障排查

| 现象 | 检查 |
|---|---|
| 二维码一直不出现 | 看 `dsh-ria: wechat-claw:` / `dsh-ria: qq-bot:` 日志；确认能访问 `ilinkai.weixin.qq.com` / `q.qq.com`；如果报 `fetch failed`，检查 DNS 或 `/etc/hosts` 是否把域名指到 `127.0.0.1`，以及本地代理是否拦截 |
| 微信 Claw 显示已连接但没回复 | token 是否失效；长轮询是否持续报错；退出后重新扫码 |
| QQ 显示已连接但收不到消息 | 机器人是否已发布或在沙箱；群消息是否 @；开放平台消息权限是否开启；网关是否 ready |
| 两个通道都收到同一条回复 | 只有最后收到消息的通道应保持推送；在面板里手动暂停不需要的通道，或先在该通道发一条消息 |
| 暂停后收不到回复 | 暂停只停出站；在该通道发一条消息会自动恢复 |
