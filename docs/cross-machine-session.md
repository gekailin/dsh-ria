# 跨机器 Session 管理：现状、候选与路线

> 调研日期：2026-11-16。对象：DSH 0.2.2-rc.1（本机）与 npm 生态。
>
> 证据标记：**已验证·源码** = 读过对应包源码；**已验证·文件** = 读过本机实际文件/目录；**已验证·包 README** = 读过发布包 README；**推断** = 基于上述证据的判断，未做端到端实测。文中未标来源的推荐、组合与风险判断均为推断。

## TL;DR

- **没有官方现成的「跨机 Session 同步/迁移」能力。** 官方只有 Web 远程访问、单 Session 的 LiveShare（实验性、需自建服务）和基于文件的 Session 持久化；没有导出/导入 API，也没有跨机锁。（推断：基于已读官方包与文档，未发现导出/导入 API）
- **首选路线 A：远程访问同一台 Host。** Session 始终留在原机器，另一台设备只是浏览器/客户端。最稳的是 **SSH 隧道到 Host 的 loopback dsh web**；手机/多设备可用 **Tailscale 直连**；想要开箱即用的跨设备体验可用 **ds-harness-remote 0.6.5**（端到端加密、Host 只外连；默认走第三方 relay，可自建最小 relay）。（组合建议为推断；各组件能力已验证·源码/包 README）
- **路线 B（复制 Session 文件）只适合停机后的单向迁移/备份**，并且要同时处理绝对路径、附件和 workspace 归属。**绝不要**用 Syncthing/git/rsync 做双向实时同步：没有跨机写锁，必然出现分叉或撕裂尾部。（已验证·源码 + 已验证·文件）
- **路线 C（手机/IM/relay 插件）都是同一台 Host 的入口，不是跨机会话。** 要让微信/Telegram 连到另一台机器，桥必须跑在那台机器上，或先通过路线 A 把那台机器暴露出来。（已验证·包 README/源码）
- 最接近需求的三类插件：**ds-harness-remote（远程接管另一台 Host）**、**dsh-remote（本地 DSH 操作远程工作区，但 Session 仍在本机）**、**dsh-session-manager（同机移动/补 workspace 归属，不做跨机传输）**。

## 1. 先厘清三种「跨机器」

| 说法 | 实际含义 | Session 在哪里 | 能否两边同时写 |
| --- | --- | --- | --- |
| 远程访问 | 浏览器/手机连到另一台机器的 DSH | 原 Host | 只有一个 Host，天然单写 |
| 会话迁移 | 把日志文件复制到另一台机器继续 | 目标机（源机是另一份） | 不能；两份会分叉 |
| 实时同步 | 两台机器共享同一份 Session | 两边 | 不支持；无跨机锁 |

很多插件宣称 remote / mobile / relay，实际只是第一种。采购或安装前先问一句：**它连的是哪台机器上的 DSH 进程？** 如果答案是一台，它就不会帮你把 Session 搬到另一台。

## 2. 官方能力与边界

### 2.1 dsh web 的远程访问

dsh web 默认只监听 loopback。要跨机器访问，有三个层次：

| 参数/机制 | 作用 | 关键限制 |
| --- | --- | --- |
| --host <IP> | 绑定一个具体网卡地址 | 只接受**一个具体的本机 IPv4/IPv6 字面量**；拒绝 0.0.0.0/:: 等通配地址 |
| --public-url <URL> | 只公告浏览器根（启动 URL、DSH_WEB_URL、运行时 Web GUI URL） | **不授予信任**；它不配置监听、路由或 cookie 作用域 |
| --trusted-host <host[:port]> | 让额外的浏览器 authority 通过 Host/Origin 栅栏 | 带端口时精确匹配；不带端口匹配任意端口；非法条目启动即失败 |
| --tls-cert + --tls-key | 直接启用 HTTPS | 必须成对、完整链、无口令 PEM；缺失/不成对启动失败，不回落 HTTP；不自动续期 |

Host/Origin 栅栏的实际规则（**已验证·源码**，dsh-client-connection/lib/index.js:240-249）：

- Host 必须是 loopback、等于监听器绑定的 IP 字面量（端口不限），或匹配 trustedHosts；
- 带 sec-fetch-site: cross-site 的请求拒绝；
- 请求若带 Origin，必须与 Host 同 authority；
- 不采信 X-Forwarded-* 或 Origin 来「证明」来源。

这意味着：

- **SSH 隧道**最省事：Host 侧仍绑 127.0.0.1，浏览器看到的是 http://127.0.0.1:3080，天然过栅栏。
- **Tailscale 直连**也简单：把 --host 设成 tailnet IP，浏览器用同一个 IP，Host 等于绑定 IP，不需要 --trusted-host。
- **反向代理**必须让 DSH 认识外部 authority：加 --trusted-host app.example，并让代理保留原始 Host/Origin。如果代理把 Host 和 Origin 都改写成 loopback，虽然能过栅栏，却会把「远程浏览器」伪装成本机，**这是安全风险，不是配置技巧**（dsh-host-directory-picker-auto/README.zh.md:112 明确提醒）。
- **不要把 3080 裸奔到公网。** 端口本身不受公告 URL 或栅栏保护；必须限制在可信代理/网络内。

### 2.2 token 与 cookie：URL 就是一次性入口

（**已验证·源码**，dsh-client-connection/lib/index.js:271-578）

- 启动时生成 32 字节随机 launchToken，只存在进程内存和打印出来的 URL 里；**重启即失效**。
- 访问 GET /?token=<token> 且恰好一个 token 时，签发 HMAC-SHA256 签名的 cookie：dsh-auth-<sha256(authority)>，HttpOnly、SameSite=Strict、Path=/；HTTPS 监听器加 Secure；默认 30 天。
- cookie 签名密钥持久化在 DSH_HOME/.credentials.yaml；token 不持久化。
- 远端浏览器首次必须拿到打印 URL（或从 daemon 的状态文件拿到带 token 的 URL）。**丢了 token 就只能重启 web 重新生成**；已有 cookie 在有效期内仍可用。
- 非 loopback 的账号登录入口会失败（页面 origin 不是 loopback HTTP），这种场景应使用 API Key，而不是反复试登录（dsh-client-ui-settings-account/README.zh.md:108）。

### 2.3 daemon 只负责「活着」，不负责传输

@chenkai114/dsh-daemon 做的是登录自启、看护、自愈，不是会话同步：

- 无头机器上可把 DSH_DAEMON_OPEN_BROWSER=0，让 daemon 只把带 token 的 URL 写到 ~/.dsh/daemon/.web-auth-url；
- 反代场景可用 DSH_DAEMON_TRUSTED_HOST 给 dsh web 追加 --trusted-host；
- 它不会把 Session 传到另一台机器，也不会替你解决 workspace 路径。

### 2.4 Session 存储：追加日志 + 单写者

（**已验证·包 README**，dsh-session-persistence-jsonl/README.zh.md:75-77、111、168-171）

布局：

~~~text
~/.dsh/sessions/
  --<normalized-cwd>--/
    <encoded-session-id>/
      session.v4.jsonl.zstd   # 当前 v4
      session.lock            # 0 字节，flock 用
~~~

物理格式：

- header 单独一个带校验和的 zstd frame；
- 之后每个 append batch 一个独立带校验和的 frame；
- 每批 fsync，写失败回滚到之前的长度；
- 崩溃后只保留已提交前缀；撕裂的最后一个 zstd frame 只取其中完整解码出的 JSONL 记录，写句柄下次写前会截掉撕裂字节并重写恢复记录；
- 列表只读 header frame；完整已提交帧的校验/解压/结构失败按损坏拒绝。

并发：

- **每个 Session 同时只有一个活动写入方**：进程内 claim + 内核非阻塞 flock(2) on session.lock（Windows 命名信号量）；锁随进程死亡释放；
- 活着但卡死的持有者会阻塞后来者，直到进程退出；
- POSIX 上删除锁文件即放弃排他；释放本身从不删除文件；
- **NFSv3 的 advisory flock 不可靠**；不要把 Session 根放在 NFS/SMB 上让多机同时写；
- 首次实体化在 POSIX 用 link()，同 id 竞态失败而不是覆盖已提交日志；Windows 用无替换 rename；
- 核心持久化没有导出/导入/删除 API；日志只增。

复制时的真实风险：

- cp/rsync **不遵守 flock**。源正在写时复制，目标可能只拿到完整前缀，丢掉最后一批；不会「自动合并」。
- session.lock 不应随复制带走；目标会自己建锁。
- 同一个 Session ID 在目标已存在时不要覆盖；两份同 ID 日志不会自动合并，只会分叉。
- header 没有 workspace id，只有绝对 cwd（可选）；跨机可移植性主要看目标机是否有同一路径、目标 DSH 是否支持 v4。

### 2.5 workspace 注册表：复制文件 ≠ 出现在侧栏

（**已验证·源码**，dsh-workspace/lib/index.js:102-104、111-124、378-395、614-618、758-813；**已验证·文件**，~/.dsh/storages/workspace.json）

实际文件结构：

~~~json
{
  "unit": { "name": "workspace", "version": 2 },
  "global": {
    "initialized": true,
    "workspaceIds": ["..."],
    "archivedSessionIds": ["..."],
    "pinnedSessionIds": []
  },
  "tables": {
    "workspaces": {
      "<id>": { "path": "/abs/path", "title": "...", "sessionIds": ["..."], "createdAt": 0, "updatedAt": 0 }
    }
  }
}
~~~

关键行为：

- 启动时只有 initialized === false 才会扫描历史 header 并 bootstrap()；已初始化的 profile 不会重跑；
- WorkspaceEntity.sessionIds 只返回记录里已有的 ID（再按存在性过滤）；
- attachSession 要求 header 的 cwd 存在，且 realpath 后等于 workspace 的 path；路径缺失/不是目录/解析到别处都拒绝；
- 因此：**只把 session.v4.jsonl.zstd 拷进目标机，侧栏很可能完全看不到它**，即使文件本身可读。

补齐归属的可行办法：

- 用 **dsh-session-manager 0.7.8** 的启动修复：README 说启动时若发现「cwd 已对应已注册工作区、但归属记录遗漏」的会话，会通过 DSH 官方接口补登记，幂等（README.zh.md:144）；它只补记录，不改写 cwd/工件、不重启（:25）。
- 或者在停机时备份 workspace.json，手动把 session ID 加进对应 workspace 的 sessionIds；**不推荐**，因为还有 header index/缓存，手改容易被打回。不要直接编辑 zstd/JSONL。
- 不要用「删掉 workspace.json 让 DSH 重新 bootstrap」这种做法：会丢掉已有工作区、归档、置顶等状态。

### 2.6 SDK / ACP / headless / LiveShare

- dsh-sdk-app 是 **stdio JSON-RPC**；dsh-acp-app 是 automation-only 的 stdio JSON-RPC；dsh-headless 是 one-shot，没有 Host/HTTP/browser。三者都不是现成网络服务；要跨机只能自己套 SSH/stdio 桥，不是开箱即用方案。
- @deepseek-ai/dsh-experimental-liveshare 是 **把一个 Session 共享给同事**的实验特性：owner 选 view 或 bounded-write，viewer 用 owner 的 Web shell，经外部独立 Liveshare server 的 POST {base}/__share/rpc 访问；server 的 OAuth/数据库/路由/部署不在包内，需要自建并匹配协议版本。它是「分享给他人看/有限写」，不是「我自己的多台机器同步 Session」。

### 2.7 Ria 的 state/ria 不要混进通用迁移

（**已验证·文件**，~/.dsh/state/ria/）

ria.json 里有 riaSessionId、tickets、recentWorkers、grants、wechat 相关状态；wechat-claw/creds.json 是微信凭据（0600）。这些内容：

- 指向本机的 Session ID / 路径；换机后会产生大量悬空引用；
- 含频道凭据，不应跨机器复制；
- 不属于 DSH 通用 Session 格式，不能靠复制 sessions/ 恢复。

如果确实要迁移 Ria，应当作为独立的应用状态迁移：重新配对微信/QQ、重新建立 Ria Session、逐项确认 ticket/worker 引用，而不是打包 state/ria 一起拷。

## 3. 候选插件（npm，检索日期 2026-11-16）

检索口径：registry.npmjs.org 的 /-/v1/search，10 组关键词（dsh、remote、ssh、sync、session、mobile、relay、tunnel、cluster、workspace、web 的组合）去重后 **1811 个包名**；宽口径相关 **1019 个**（含大量官方内部包，不能都算候选）。人工收敛 **13 个候选**；其中对 7 个最相关包做了 npm pack 解包验码（ds-harness-remote、dsh-remote、dsh-device-fleet、dsh-session-manager、dsh-a2a-groups、dsh-pocket、dsh-mobile-plugin），其余读本地已装包 README 或发布页。

| 包 | 最新版 | 它实际做什么 | 跨机？ | 结论 |
| --- | --- | --- | --- | --- |
| ds-harness-remote | 0.6.5 | 在 Host 装插件，授权设备通过 E2EE 连接，读写 Host 上的 workspace/session，可发消息、等结果、中断 | **是**，远程操作另一台 Host | 最接近「另一台电脑继续同一 Session」的开箱方案；Session 不落本地 |
| dsh-remote | 1.2.0 | 本地 DSH 通过 SSH 连远程主机，Agent 在远程工作区读写/执行/构建/测试 | 部分：远程文件/命令，不是远程 Session | 适合「借另一台机器的算力/代码」，不适合「接管那台机器上的会话」 |
| dsh-device-fleet | 1.8.4 | 同账号多设备组 Fleet，fleet_run 直调目标设备工具、共享 Room、跨设备委派 subagent | 是，但偏设备编排 | 实验性（TOFU、relay 控制面未 TLS）；不是会话迁移/接管 |
| dsh-session-manager | 0.7.8 | 同机跨 workspace 移动 Session、迁移 preset、归档、删除、启动补归属 | **否** | 复制 Session 后的「登记/移动」工具，不是跨机传输 |
| dsh-pocket | 2.13.1 | 手机扫码访问同一台电脑上的 DSH（局域网/公网） | 否，同一 Host | 同机手机入口 |
| dsh-mobile / dsh-mobile-plugin | 0.8.10 / 0.5.56 | 手机浏览器/App 通过局域网 HTTPS、Tailscale Funnel、cpolar、cloudflared、FRP、自建反代等连同一台 DSH | 否，同一 Host | 手机接管同一 Host；不是多机同步 |
| @linxin666/dsh-remote-web-ui | 0.4.18 | 扫码配对手机/PC 到同一台机器的官方 Web GUI，支持 cloudflared/固定中继/自备域名 tunnel | 否，同一 Host | 配对设备是 full-control；控制面仅回环 |
| @linxin666/dsh-remote-bridge | 0.4.18 | 同机原生客户端协议 v1（/ios/v1 WebSocket，配对、session 操作） | 否，同一 Host | 给客户端用的桥，不是跨机 |
| @linxin666/dsh-session-archive | 0.4.18 | 会话清单、批量归档/恢复、级联物理删除、自动清理 | 否 | 没有导出/导入；API 仅回环；不能当迁移工具 |
| @xmanrui/dsh-im | 5.10.0 | 微信/飞书/企微/钉钉/QQ/Telegram/WhatsApp/Slack/Discord/Matrix 接入 DSH | 否，同一 Host | IM 是入口；要让 IM 连另一台，桥得跑在那台 |
| dsh-tg-bridge | 1.51.2 | Telegram 驱动 DSH | 否，同一 Host | 同类 IM 入口 |
| dsh-a2a-groups | 0.1.72 | 把 DSH 变成可加入协作群的 A2A agent，群邀请/成员/审批/feed | 跨 agent/群，不是会话 | 群协作，不是 Session 接管/迁移 |
| @deepseek-ai/dsh-experimental-liveshare | 0.2.2-alpha.2 | 把一个 Session 共享给同事，view/bounded-write | 共享，不是同步 | 需自建 Liveshare server；实验性 |

补充排除项：

- dsh-config-manager：同步的是 settings/plugins/MCP/skills/presets 等配置，不是 Session 日志；
- dsh-search-index：导出/导入的是全文检索索引，不是 Session 本身；
- @linxin666/dsh-session-archive：能删/归档，不能导出/导入；
- 官方内部包（@deepseek-ai/dsh-*）不是给终端用户安装的跨机方案。

### 最接近的三个

1. **ds-harness-remote**：真正「另一台设备连到 Host 并继续 Session」。Host 只外连、不开公网端口，传输 E2EE；但默认依赖第三方 relay（https://dsh.r2049.cn），需要账号；交互终端默认开，且以 Host 用户运行、不受 Agent 审批约束（可在 Host 设置关闭）。适合接受「账号 + relay」的人。
2. **dsh-remote**：不是远程 Session，而是「本地 DSH + 远程工作区」。如果你的真实需求是「用家里机器的 CPU/文件」，它更合适；如果需求是「看见那台机器上正在跑的会话」，它不满足。
3. **dsh-session-manager**：不跨机，但它是复制 Session 后最实用的补登记/移动工具；把「文件复制」变成「侧栏可见、cwd 正确」。

## 4. 三条路线对比

| 维度 | A. 远程访问同一 Host | B. 单向复制 Session | C. 实时同步 / 共享存储 |
| --- | --- | --- | --- |
| 会话一致性 | 单一 Host，天然一致 | 停机快照；复制后两边分叉 | 无跨机锁，分叉/撕裂 |
| 路径一致性 | 保持原机路径 | 目标需同一绝对路径，或先改 cwd | 两边路径必须一致，通常做不到 |
| 附件 | 原机直接可用 | 需额外复制 ~/.dsh/attachments | 需双向同步，冲突难解 |
| 离线可用 | 需要网络到 Host | 可离线 | 可离线，但冲突 |
| 安全暴露面 | SSH/Tailscale 最小；公网反代最大 | 文件可能含敏感内容 | 共享盘/同步服务暴露面大 |
| 安装/维护成本 | 低（SSH）到中（插件/账号） | 中高，手工步骤多 | 高，且不可靠 |
| 推荐度 | **首选** | 仅离线迁移/备份 | **不要用于活动 Session** |

### 路线 A：远程访问（推荐）

#### A1. SSH 隧道（最稳、零插件）

Host 侧保持默认 loopback：

~~~sh
# 在 Host 上
dsh --profile web --no-open --public-url http://127.0.0.1:3080
~~~

把启动输出里的 http://127.0.0.1:3080/?token=... 复制下来。然后在本地建隧道：

~~~sh
ssh -N -L 3080:127.0.0.1:3080 user@host
~~~

本地浏览器打开刚才的 token URL（origin 仍是 127.0.0.1:3080），即可看到 Host 的 Web GUI。首次访问后 cookie 默认 30 天；token 本身重启失效。

如果本地 3080 已被占用（例如本机也跑着 dsh web），把隧道本地端口换成 3081：

~~~sh
ssh -N -L 3081:127.0.0.1:3080 user@host
~~~

然后打开 token URL 并把端口改成 3081（token 不变；cookie 会按 127.0.0.1:3081 重新签发）。不要为了省事去停掉本机正在用的 dsh web。

如果 Host 由 daemon 托管、拿不到启动输出：

~~~sh
cat ~/.dsh/daemon/.web-auth-url
~~~

没有这个文件或 URL 已失效，就重启 web/daemon 重新生成；不要试图从进程内存里「找回」旧 token。

验证：

~~~sh
# Host 上应看到 127.0.0.1:3080，而不是 0.0.0.0:3080
ss -ltnp | grep ':3080'
~~~

安全要点：token URL 就是密码，不要贴到聊天/工单；ssh -N 不执行远程命令；不用时关掉隧道。

#### A2. Tailscale 直连（手机/多设备）

Host 装 Tailscale，拿到 tailnet IP：

~~~sh
tailscale ip -4          # 例如 100.x.y.z
dsh --profile web --no-open --host 100.x.y.z --public-url http://100.x.y.z:3080
~~~

手机/另一台电脑装 Tailscale 后，直接打开打印出来的 http://100.x.y.z:3080/?token=...。Host 等于绑定 IP，栅栏接受；流量由 WireGuard 加密，但 DSH 本身仍是 HTTP，token 仍然要保管好。

注意：

- --host 必须是具体 IP 字面量；不能写 0.0.0.0 或主机名；
- 只允许 tailnet 访问，不要把该端口再映射到公网；
- 如果前面再用 tailscale serve 做 HTTPS，外部 authority 会变成 <machine>.<tailnet>.ts.net，必须给 DSH 加 --trusted-host <machine>.<tailnet>.ts.net，并确保代理保留 Host/Origin；不要把它改写成 loopback。

#### A3. 局域网直连（仅可信网络）

~~~sh
dsh --profile web --no-open --host "$(hostname -I | awk '{print $1}')"
~~~

同一 Wi-Fi 的设备打开打印 URL 即可。注意 hostname -I 可能同时列出 docker、Tailscale 或虚拟网卡地址；先确认选中的是真正的 LAN IP，否则打印出来的 URL 从别的设备连不上。这是**明文 HTTP**，只适合完全可信的家庭/实验室网络；不要在咖啡厅/酒店/公司访客网使用。需要 HTTPS 就配 --tls-cert/--tls-key，或用 Tailscale。

#### A4. 公网反向代理（高级，风险最高）

如果必须公网访问，最低要求：

- 反代终结 TLS（或用 DSH 自己的 --tls-cert/--tls-key）；
- dsh web 加 --trusted-host app.example（非 443 端口要写 app.example:port）和 --public-url https://app.example/；
- 代理**保留原始 Host 和 Origin**，不要改写成 loopback；
- 代理层做认证/限流/审计；防火墙只放行代理到 DSH；
- 不要把 3080 直接暴露到公网。

Caddy 最小示例（仅示意，认证要另加）：

~~~caddyfile
app.example {
  reverse_proxy 127.0.0.1:3080
}
~~~

注意：反代终结 TLS 时，DSH 监听器本身是 HTTP，签发的 cookie 不会带 Secure；更稳妥的是 DSH 自己启 TLS，或干脆用 SSH/Tailscale。若代理同时把 Host/Origin 改写成 loopback，会绕过栅栏、把远程浏览器伪装成本机——**不要这么做**。

#### A5. 开箱即用：ds-harness-remote

Host 上安装（现有 DSH profile）：

~~~sh
dsh plugin --profile web add -w ds-harness-remote@0.6.5
~~~

重启 dsh web 后，在 Host 的 Remote 面板登录/配对；远端用 Remote Web、Android 或 DSH Go 连接。它提供 remote_list_hosts、remote_list_workspaces、remote_list_sessions、remote_read_session、remote_create_session、remote_send_message、remote_wait_sessions、remote_interrupt_session、remote_upload_file、remote_download_file、remote_get_operation 等工具；Session 继续在 Host 上跑，权限也沿用 Host。

安全边界（**已验证·包 README**，:89-95）：

- Noise_IK_25519_ChaChaPoly_SHA256，客户端加密、仅目标 Host 解密；
- 账号成员 + Host 本地固定设备身份双授权；
- Host 只主动外连，不开公网端口；
- 不暴露通用 tool RPC/远程桌面/文件修改 API；
- 交互终端默认开，以 Host 用户运行、不受 Agent 审批约束；不需要就在 Host 设置里关掉。

默认 hosted relay 是 https://dsh.r2049.cn（cordis.patch.yml）。不想用第三方 relay，可用仓库里的 minimal single-account self-hosted Relay（apps/server，配 DSH_SERVER_ACCOUNT/DSH_SERVER_PASSWORD），但它不含完整多账号 Server/Remote Web UI/WebRTC TURN。兼容基线是 DSH dsh-v0.2.2-rc.1；升级 DSH 前先看插件兼容性。

#### A6. 手机/IM 入口（仍然只是同一 Host）

已装的 dsh-mobile、@linxin666/dsh-remote-web-ui、@linxin666/dsh-remote-bridge，以及 @xmanrui/dsh-im、dsh-tg-bridge 等，都是「连到某台 Host」的入口：

- 手机浏览器/PWA：dsh-mobile（局域网 HTTPS + 配对，或 Tailscale Funnel/cloudflared/FRP/自建反代）；
- 官方 Web GUI 扫码：remote-web-ui（配对设备 full-control；LAN bind 默认可能是关闭的，需要显式开）；
- IM：@xmanrui/dsh-im / dsh-tg-bridge 把消息转成 Host 上的 Session 输入；
- 它们**不会**把 Host A 的 Session 搬到 Host B。要让微信连到 B，就在 B 上跑桥，或先用 A1/A2 把 B 暴露出来。

### 路线 B：停机后单向复制（只适合迁移/备份）

适用：换电脑、离线带走、做只读副本、复现问题。不适用：两台机器同时继续同一 Session。

#### 前提

1. **源端停止写入**：退出 dsh web，或停止 daemon 管理的 web；不要在 Agent 正在执行时复制。归档不等于关闭写句柄，最稳妥是停 Host。
2. 目标 DSH 支持当前格式（本机是 v4）；跨大版本先在源端升级/迁移。
3. 目标机存在**同一绝对路径**的 cwd；否则 attachSession 会拒绝。
4. 需要历史里的图片/文件时，一并复制附件对象。
5. 目标机没有同 ID 的 Session；有就停下，不要覆盖。

#### 步骤

1）在源机定位 Session 目录：

~~~sh
find ~/.dsh/sessions -name 'session.v4.jsonl.zstd' -printf '%h\n' | tail -20
~~~

Session ID 可从 Web URL/侧栏信息里核对；目录名是编码后的 ID，不要手写。

2）复制日志（排除锁文件）：

~~~sh
# 目标机的父目录和 Session 目录先建好；目录名必须由目标机 cwd 生成
mkdir -p ~/.dsh/sessions/--<dst-cwd>--/<session-id>
rsync -a --exclude 'session.lock' \
  ~/.dsh/sessions/--<src-cwd>--/<session-id>/ \
  target:~/.dsh/sessions/--<dst-cwd>--/<session-id>/
~~~

--<dst-cwd>-- 必须由目标机的绝对 cwd 生成（通常就是把 / 换成 - 的形式，但以实际目录名为准）。

3）复制附件（内容寻址，可合并）：

~~~sh
rsync -a --ignore-existing \
  ~/.dsh/attachments/v1/objects/ \
  target:~/.dsh/attachments/v1/objects/
~~~

附件可能很大；只迁一个 Session 时也可以只挑该 Session 历史里引用的对象，但需要解析日志，容易漏，整目录合并在正确性上更稳。

4）让目标机「看见」这个 Session：

- 推荐：在目标机安装 dsh-session-manager，重启后让它按 cwd 补登记（它会检查「cwd 已对应已注册 workspace、但 sessionIds 缺记录」的情况）；
- 或者停机备份 ~/.dsh/storages/workspace.json，把 session ID 加进对应 workspace 的 sessionIds；不推荐手改，且不要删除整个文件让 DSH 重建；
- 不要直接编辑 session.v4.jsonl.zstd 来改 cwd；需要改路径时用 dsh-session-manager 的同机移动能力，或干脆在目标机创建同一路径。

5）验证：

~~~sh
# 目标机：不应有随复制带过来的锁
test ! -e ~/.dsh/sessions/--<dst-cwd>--/<session-id>/session.lock && echo ok
~~~

启动目标 dsh web，确认：

- 侧栏/工作区能看到该 Session；
- 打开历史，最后几条消息完整（没有截断/校验错误）；
- 历史里的图片/附件能打开；
- 发一条无害消息，确认 cwd 和工具在目标机正确执行；
- 源机不要同时再写同一份副本。要保留源机，就把它当 canonical，目标机当 fork。

#### 不要做

- **不要**用 Syncthing/git/rsync 双向实时同步活动 Session：没有跨机锁，session.lock 不跨机生效，必然分叉；同步工具还可能把临时文件/撕裂尾部传到对面。
- **不要**复制整个 ~/.dsh：里面有 .credentials.yaml、profiles、缓存、机器相关路径、workspace.json、锁文件；整体覆盖会破坏目标环境。
- **不要**把 workspace.json 整体覆盖到非空目标：workspace ID/路径会冲突，归档/置顶状态也会被覆盖。
- **不要**复制 session.lock；目标机会自己建锁。
- **不要**在 NFS/SMB 上让两台机器同时打开同一 Session 根：POSIX flock 在 NFSv3 不可靠。
- **不要**手改 zstd frame/JSONL 行：校验和、帧边界、序号映射都会坏。

### 路线 C：relay/IM/手机入口（不是跨机同步）

把候选按「它连哪台机器」分类：

| 类型 | 代表 | 实际连接 | 能否读到另一台机器的 Session |
| --- | --- | --- | --- |
| 手机/远程 Web UI | dsh-mobile、dsh-pocket、remote-web-ui、remote-bridge | 同一台 Host 的 DSH | 否；除非那台就是目标 Host |
| IM 桥 | @xmanrui/dsh-im、dsh-tg-bridge、dsh-wechat* | 同一台 Host 的 DSH | 否；桥跑在哪台就连哪台 |
| 会话归档 | dsh-session-archive | 同一台 Host | 否；只归档/删除，不导出 |
| 设备编排 | dsh-device-fleet | 同账号多设备 | 可跨设备调工具/委派，但不是接管已有 Session |
| Agent 群协作 | dsh-a2a-groups | A2A 群 | 否；是群消息/审批，不是 Session 迁移 |
| 远程 Host | ds-harness-remote | 另一台 Host | **是**；这是路线 A 的成品化 |
| 远程工作区 | dsh-remote | 另一台 Host 的文件/命令 | 否；Session 仍在本机 |

结论：**relay 本身不产生跨机会话。** 如果手机/IM 要操作「另一台机器」，要么：

1. 在那台机器上跑对应的 mobile/IM 插件（每台一个入口，自己选机器）；或
2. 用 ds-harness-remote 的账号/设备列表，先选 Host 再操作；或
3. 用 A1/A2 把 Host 暴露出来，让手机浏览器/IM 桥连过去。

## 5. 推荐组合

> 以下是基于前文证据的推断性建议；命令与验证方式见第 4 节。

| 你的场景 | 推荐 | 说明 |
| --- | --- | --- |
| 办公室/家里两台电脑，继续同一个 Session | A1 SSH 隧道 | 零插件、单写、最稳；把 token URL 当密码 |
| 手机路上看进度/发指令 | A2 Tailscale + dsh-mobile/remote-web-ui；或 ds-harness-remote | 同一 Host；手机不需要 SSH |
| 想在另一台机器离线继续 | B 单向复制 | 停机、同路径、附件、补 workspace；接受 fork |
| 想用另一台机器的 CPU/文件跑任务 | dsh-remote | 远程工作区，不是远程 Session |
| 多台设备协作/委派 | dsh-device-fleet（实验） | 不是会话迁移；注意 TOFU/relay 控制面风险 |
| 给同事看一个 Session | LiveShare 或屏幕共享 | LiveShare 需自建 server；不是个人多机同步 |
| 公网随时访问 | Tailscale 优先；不得已再反代 | 反代必须 TLS + trusted-host + 认证；不要裸奔 3080 |

### 安全清单

- 优先 loopback + SSH/Tailscale；不要 0.0.0.0，不要把 3080 直接映射公网。
- token URL 是进程级凭据：不要进聊天记录、截图、工单；丢 URL 就重启换新。
- 反代：保留 Host/Origin、--trusted-host 精确、TLS、认证、限流；不要把 Host/Origin 改写成 loopback。
- ds-harness-remote：不需要终端就在 Host 设置里关掉；确认是否接受默认第三方 relay，必要时自建。
- remote-web-ui 配对设备是 full-control；只配对自己的设备，定期 revoke。
- dsh-device-fleet 仍在原型期：身份 TOFU、relay 控制面未 TLS，别放敏感环境。
- IM 桥：单独 bot 账号、allowlist、不要在群里贴凭据；消息会经过第三方平台。
- 复制 Session 前确认文件里可能含敏感 prompt/输出/附件；迁移后源机副本是否保留要按数据政策处理。

### 验证命令汇总

~~~sh
# 1. 监听地址（Host）
ss -ltnp | grep ':3080'

# 2. 本机隧道是否通（本地）
curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3080/

# 3. 复制后的锁文件不应存在
test ! -e ~/.dsh/sessions/--<cwd>--/<session-id>/session.lock && echo ok

# 4. 附件对象是否存在（按日志里的 sha256 路径核对）
ls ~/.dsh/attachments/v1/objects/<2位>/<sha256>
~~~

curl 不带 token 时返回 401/403 是正常的；真正的验证是用浏览器打开打印出来的 token URL，确认能看到 Host 的会话列表并打开历史。

## 6. 未决问题与限制

- **没有官方导出/导入 API**：本文件的 B 路线是文件级操作，不是官方支持契约；DSH 升级后格式可能变，迁移前先看 session-format-catalog。
- **workspace 补登记依赖插件行为**：dsh-session-manager 的启动修复是第三方实现；版本升级后要重新验证。手改 workspace.json 不是长期方案。
- **反代 TLS 终结的 cookie Secure 语义**：DSH 监听器是 HTTP 时不会给 cookie 加 Secure；对安全要求高的场景，用 DSH 自己启 TLS 或 SSH/Tailscale。
- **ds-harness-remote 的默认 relay/账号**：是否接受第三方中转是组织决策；自建 server 只覆盖最小单账号场景，不含完整多账号/Remote Web UI/TURN。
- **dsh-device-fleet 实验性**：身份轮换/吊销、relay 控制面 TLS 尚不完整；不要当生产跨机会话方案。
- **LiveShare 不是同步**：它共享一个 Session 的查看/有限写，不把日志复制到另一台机器，也不能离线继续。
- **候选版本会变**：本表是 2026-11-16 的 registry 快照；安装前重新看 latest 与兼容基线。

## 7. 证据索引

官方源码（本机 DSH 0.2.2-rc.1）：

- .../@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-web-app/README.zh.md:65-87：--host/--public-url/--trusted-host/TLS、启动示例、token URL 分享警告；
- .../@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-client-connection/README.zh.md:47：Host/Origin 栅栏；
- .../@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-client-connection/lib/index.js:240-249：isTrustedApiRequest；:271-578：launch token、cookie、/connect；
- .../@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-session-persistence-jsonl/README.zh.md:75-77、111、168-171：追加/fsync/崩溃恢复/单写者/flock/NFS；
- .../@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-workspace/lib/index.js:102-104、111-124、378-395、614-618、758-813：workspace 归属、attach、bootstrap；
- .../@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-experimental-liveshare/README.zh.md：LiveShare 的 relay/配置边界；
- .../@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-client-ui-settings-account/README.zh.md:108：非 loopback 登录限制。

本机实际文件：

- ~/.dsh/sessions/：344M，201 个 session.v4.jsonl.zstd、213 个 session.lock、219 个 Session 目录（2026-11-16）；
- 样本 header：{"type":"session","version":4,"id":"session-...","createdAt":...,"cwd":"/home/gkl/Desktop/...","isSeeded":false,"delegationDepth":0,"agentPreset":"ptc"}；无 workspace id；
- ~/.dsh/storages/workspace.json：unit.version=2、global.initialized=true、12 个 workspace、113 个归档 Session；
- ~/.dsh/attachments/v1/objects/<2位>/<sha256>：内容寻址附件；
- ~/.dsh/daemon/.web-auth-url：daemon 托管的带 token URL；
- ~/.dsh/state/ria/ria.json、~/.dsh/state/ria/wechat-claw/creds.json：Ria 状态与凭据，不应混入通用 Session 迁移。

候选包：

- ds-harness-remote 0.6.5：<https://www.npmjs.com/package/ds-harness-remote>；源码与完整指南 <https://github.com/liguobao/ds-harness-remote>；
- dsh-remote 1.2.0：<https://www.npmjs.com/package/dsh-remote>；
- dsh-device-fleet 1.8.4：<https://www.npmjs.com/package/dsh-device-fleet>；
- dsh-session-manager 0.7.8：<https://www.npmjs.com/package/dsh-session-manager>；
- dsh-pocket 2.13.1：<https://www.npmjs.com/package/dsh-pocket>；
- dsh-mobile 0.8.10 / dsh-mobile-plugin 0.5.56：<https://www.npmjs.com/package/dsh-mobile>、<https://www.npmjs.com/package/dsh-mobile-plugin>；
- @linxin666/dsh-remote-web-ui 0.4.18：<https://www.npmjs.com/package/@linxin666/dsh-remote-web-ui>；
- @linxin666/dsh-remote-bridge 0.4.18：<https://www.npmjs.com/package/@linxin666/dsh-remote-bridge>；
- @linxin666/dsh-session-archive 0.4.18：<https://www.npmjs.com/package/@linxin666/dsh-session-archive>；
- @xmanrui/dsh-im 5.10.0：<https://www.npmjs.com/package/@xmanrui/dsh-im>；
- dsh-tg-bridge 1.51.2：<https://www.npmjs.com/package/dsh-tg-bridge>；
- dsh-a2a-groups 0.1.72：<https://www.npmjs.com/package/dsh-a2a-groups>。

> 说明：候选能力来自包 README/发布页与实际解包核对；未在目标环境做端到端安装测试。正式采用前，先在隔离 profile 里验证安装、重启、配对与回滚。
