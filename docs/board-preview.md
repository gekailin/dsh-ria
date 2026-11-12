# 任务看板预览

![Ria 任务看板，真实 84 票](assets/ria-board-preview.png)

预览图基于本机真实状态 `DSH_HOME/state/ria/ria.json` 的 84 张 ticket：80 done、3 cancelled、1 working，0 张有依赖。按 executor 会话的 cwd 聚合出 5 条泳道（`ria`、`vggt`、`Ria · 管家`、`misc`、`session`），其中 `self` 与当前 Ria 会话归入「Ria · 管家」，找不到会话的 worker 进「未分配」。截图尺寸 1440×1160，浏览器内从数据加载到卡片与箭头布局完成约 31 ms。

## 为什么用静态 harness

截图时 `~/.dsh/profiles/web/node_modules/dsh-ria` 仍是旧拷贝，而任务约束不重启 dsh web、不同步安装副本，所以无法从正在运行的 Web UI 点开新看板。预览使用与 `lib/client.js` 相同的 DOM 结构、配色、分位时间桶和 SVG 依赖路径逻辑，数据由真实 `ria.json` 投影而来；它只用于视觉验收，不是生产页面。

## 复现真实页面

1. 同步安装副本并重启 dsh web（重启前先征得同意）：

   ~~~bash
   cp -a lib/. ~/.dsh/profiles/web/node_modules/dsh-ria/lib/
   dsh-daemon restart
   ~~~

2. 展开侧栏，点 Ria 入口右侧的「▦ 看板」图标（顺序：Ria 入口 | 看板 | 设置 | 连接）。看板数据可直接检查：

   ~~~bash
   curl -s http://127.0.0.1:3080/plugins/dsh-ria/api/board | head -c 400
   ~~~

3. 端点返回 `ok/counts/lanes/tickets`；页面本身只读，不写 ticket、不派发消息。

## 已覆盖的边界

- 没有 ticket、筛选后为空、worker 会话缺失、worker 已归档、workspace registry 读取失败。
- 无依赖的票不画箭头；有依赖时箭头只在上游/下游卡片悬停时高亮。
- 已完成/已取消的票折叠为两行，避免大量历史把活跃泳道挤出首屏。
- 横向不是真实时间比例，而是按创建时间排序后的 6 个等分位桶，标签注明 `日期 · n/6`。
