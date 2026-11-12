# 聊天连接

Ria 入口标题右侧有一个“连接”chip。点开后是一个通道面板，可以在三个通道之间切换、扫码登录、查看连接状态、暂停推送和退出登录。面板按微信 Claw、QQ 机器人、微信「文件传输助手」排列，但打开时默认选中上次使用的通道；没有记录或记录已失效时回退到微信「文件传输助手」。这个偏好保存在浏览器 `localStorage` 的 `dsh.ria.channels.last.v1`，刷新页面或重启 dsh web 后仍然有效，和面板排列顺序无关。

| 通道 | id | 扫码后得到 | 入站 | 出站 |
|---|---|---|---|---|
| 微信 Claw | `wechat-claw` | bot_token、账号、baseUrl | 文本、图片 | 文本、本机图片 |
| QQ 机器人 | `qq-bot` | AppID、AppSecret、openid | 文本 | 文本 |
| 微信「文件传输助手」网页版 | `wechat` | Cookie / sid / skey | 文本、图片 | 文本、.md 文件、本机图片 |

三个通道都运行在 DSH 进程内，不启动 bridge 进程，不额外占端口（QQ 使用出站 WebSocket）。扫码只需要在面板里做一次，凭据保存在本机，DSH 重启后自动重连。

微信「文件传输助手」的细节、长回复转 .md 的规则见 [wechat.md](wechat.md)；图片两条微信通道都支持，差异见下文与 [wechat.md](wechat.md#图片)。本文说明三个通道共用的面板、微信 Claw 与 QQ 机器人的协议和限制。

## 微信 Claw

“微信 Claw”直接对接腾讯 iLink 的机器人接入接口，不需要安装 OpenClaw，也不依赖本机上的 QBotClaw。

1. 面板请求 `GET {base}/ilink/bot/get_bot_qrcode?bot_type=3`，拿到 `qrcode` 和 `qrcode_img_content`；后者是一个 URL，用本机 qrcode 编码器渲染成 PNG data URL 显示。
2. 每 1.2 秒轮询 `GET {base}/ilink/bot/get_qrcode_status?qrcode=...`，带 `iLink-App-ClientVersion: 1`。状态依次是 `wait`、`scaned`、`confirmed`，过期是 `expired`。
3. 二维码有效期 5 分钟；过期会自动刷新，最多刷新 3 次，总等待上限 480 秒。面板上看到“二维码已过期，正在刷新…”时不需要手动点。
4. `confirmed` 后返回 `bot_token`、`ilink_bot_id`、`baseurl`、`ilink_user_id`。账号 id 会把 `-im-bot` 归一成 `@im.bot`、`-im-wechat` 归一成 `@im.wechat`，原始值也一并保存。
5. 连接后用 `POST /ilink/bot/getupdates` 做 45 秒长轮询，游标保存在 `cursor.json`。文本消息的 `item_list` 里是 `type=1` 的 `text_item.text`，图片是 `type=2` 的 `image_item`。
6. 回复走 `POST /ilink/bot/sendmessage`，带 `context_token`（来自最近一条入站消息）和 `message_type=2`、`message_state=2`。没有收到过消息时没有可回复的目标，发送会报“尚未收到可回复的消息”。

### 图片

图片默认双向开启，可在设置页或 profile 里分别关闭：

~~~yaml
- id: ria
  config:
    wechatClawImage:
      inbound: true
      outbound: true
~~~

| 方向 | 触发 | 处理 |
|---|---|---|
| 入站 | `item_list` 中 `type=2` 的 `image_item` | 从 `media.full_url` 或加密 CDN 地址下载，用 `aeskey`/`media.aes_key` 做 AES-128-ECB 解密，按文件头只收 PNG/JPEG/GIF/WebP，上限 20 MB（且不超过宿主附件限制） |
| 出站 | assistant 文本里的 `![alt](path)` | 本机真实图片；先 `getuploadurl`，AES-128-ECB 加密后 POST 到 CDN，取响应头 `x-encrypted-param`，再发 `type=2` 的 `image_item` |

- 入站落盘：`DSH_HOME/state/ria/wechat-claw-inbound/YYYYMMDD-HHMMSS-<msgid>.<ext>`，目录 0700、文件 0600，重名追加 `-2`；保留最近 30 天、最多 500 个。图片作为 `{ type: 'image', mediaType, data }` 内容块和原文字一起投给 Ria，路径附在文字里，可直接作为 `ria_request` 的附件。
- 入站失败：下载、解密、格式、大小或附件校验失败都不会丢消息；Ria 仍收到原文字（纯图用“（用户发来一张图片）”占位）加 `[图片接收失败：<原因>]`，日志记 `[claw inbound] image <id> rejected (<code>): <reason>`。
- 出站失败：单张图片发送失败只回退成一条可见文本“图片 <name> 发送失败，请在 Ria 会话中查看原图”，不影响已发出的文本和其他图片；围栏代码块里的示例不发送；暂停推送时图片和文本一样不发送。
- `inbound: false` 时图片消息仍回“目前只能接收文本消息。”，不下载、不落盘；`outbound: false` 时 Markdown 图片按原样当文本发送。
- 协议来源：腾讯公开的 `Tencent/openclaw-weixin` 客户端实现（`docs/protocol.md`、`src/api/types.ts`、`src/messaging/send.ts`、`src/cdn/upload.ts`、`src/media/media-download.ts`）；CDN 下载不带 bot token，上传成功以响应头 `x-encrypted-param` 为准。

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

限制与行为：

- 语音、文件、视频仍不处理：会回复一句“目前只能接收文本消息。”，不会交给 Ria。
- 一个账号同一时间只能有一个 Claw 会话；退出登录后重新扫码可以换账号。
- token 失效或长轮询持续失败时，状态卡会显示错误；重新扫码即可。失败后按 2 秒、30 秒退避重试，不会立刻断开。
- 不读取历史消息，不支持群管理、@ 判断、引用回复，也不支持语音、文件、视频。

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
- 自动暂停：当 Ria 收到来自另一个通道的用户消息时，本通道自动暂停，`pausedBy=channel`。原因会点名来源通道，例如“微信 Claw 通道消息”“QQ 通道消息”“微信「文件传输助手」通道消息”；只有无法识别的来源才写“非微信通道消息”/“非微信 Claw 通道消息”。设置页的 `wechatAutoPause=false` 只关闭微信「文件传输助手」的自动暂停；微信 Claw 和 QQ 通道仍按本规则暂停自己。
- 派发 note、审批提醒和自动暂停提示的文本会发给最近活跃的微信侧通道（「文件传输助手」或微信 Claw），不会发给 QQ；两个都不可用时留在 outbox 等待，规则见 [wechat.md](wechat.md#派发审批-note-走哪个微信通道)。
- 通道收到自己的消息时会恢复推送，包括之前是手动暂停的情况；因为用户在这个通道里说话，本身就表示希望在这里继续。
- 合成消息（`host_` 开头的启动恢复、启动失败、worker idle 唤醒）和官方 schedule 提醒不触发切换。
- 因此正常情况下只有“最后收到用户消息的通道”在推送，避免同一条回复发到多个聊天窗口。手动暂停优先：自动暂停不会覆盖 `pausedBy=manual`，但该通道自己的入站消息会恢复它。

已知边界：DSH 重启时每个通道各自恢复自己的暂停状态。如果上次退出前多个通道都处于推送中，重启后在第一条新入站消息到来之前，它们都可能收到同一条回复；第一条消息会立刻把其他通道自动暂停。首次配置多个通道时，建议只保留一个通道推送，其余手动暂停。

正在发送的那一条会发完；还没开始发送的排队消息丢弃。暂停和恢复会写 info/warn 日志，日志前缀分别是 `dsh-ria: wechat:`、`dsh-ria: wechat-claw:`、`dsh-ria: qq-bot:`。

## 面板行为

- chip 上有三个小圆点，分别对应三个通道：绿色已连接、橙色暂停或登录中、红色错误、灰色未连接。标签显示“连接”或“连接 N”。
- 打开面板停在最近使用的 tab（没有记录时是微信）。当前 tab 没有登录且不在登录中时，会自动请求一次二维码；切到其他 tab 也会自动请求一次。
- 二维码 210×210，显示在面板里；“刷新二维码”会重新创建会话或绑定任务。
- 已登录时显示账号、推送状态、暂停/恢复和退出登录。错误状态显示在二维码下方或状态卡下方。
- chip 只在宽侧边栏显示；折叠侧边栏不插入。

## 限制

- 微信 Claw 支持文本和图片，仍不支持文件、语音和视频；QQ 机器人只支持文本。微信 Claw 入站的非图片/非文本 item 只回提示，出站可发文本、本机图片、派发/审批/暂停提示；QQ 不发这些 note。需要发文件时用微信「文件传输助手」通道，或直接在 Ria 会话里操作。
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
