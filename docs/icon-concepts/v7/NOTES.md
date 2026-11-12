# v7 · 浪体三档矢量

把 A3e-1 的**浪体本身**（不含水滴、不含 R 的斜腿）做成 24×24 的手工优化矢量。三档共用同一个源图和同一套坐标映射，只改变“保留多少笔触”和“墨色有多厚”。

- 源图：`docs/icon-concepts/v5/raw/A3e-1.png`（1024×1024，白底）
- 画布：24×24，`viewBox="0 0 24 24"`，`width/height="24"`
- 颜色：全部 `fill="currentColor"`，单一颜色，无 stroke / 渐变 / filter / mask
- 坐标映射：`X = (x - 114) * 22 / 791 + 1`，`Y = (y - 115) * 22 / 791 + 1`；源图内容区 (154,254)–(866,770) 映射到约 (2.1,4.9)–(21.9,19.2)
- 原始小点：component 24，源图 (794,444)–(804,461)，映射到约 (20.05,10.4)，直径约 0.3–0.4；standard / minimal 用 `<circle cx="20.0" cy="10.4" r="0.24">` 单独保留。faithful 的描摹已含这个卷口内端的小圆点，不再重复加。

## 文件

| 文件 | 定位 | 结构 | 大小 |
| --- | --- | --- | --- |
| `wave-faithful.svg` | 48px 以上、需要笔触质感 | 1 个 path / 13 个子路径 / 29 段三次曲线 | 7.3 KB |
| `wave-standard.svg` | 24px 主稿 | 2 条轮廓（外轮廓 + 下方白月牙）/ 62 个 Q 段 + 1 个圆点 | 1.7 KB |
| `wave-minimal.svg` | 16px / favicon | 1 条轮廓 / 32 个 Q 段 + 1 个圆点 | 1.0 KB |

`wave-preview.png`（1200×1920）：三档 × 16/18/24/48/160px × 浅底 #ffffff / 深底 #1e1e1e；下半部是 A3e-1 位图 vs standard 160px 的并排和红蓝叠加；最底部是 16px 实际渲染后最近邻 8× 的像素真相。

## 做法

### 1. faithful：simplify 描摹 + 人工清理

先取 v6 的描摹稿 `docs/icon-concepts/v6/trace-fill.svg`（它的主体就是 A3e-1 的墨迹），跑：

```bash
inkscape docs/icon-concepts/v6/trace-fill.svg \
  --actions='select-all;path-simplify' \
  --export-plain-svg=docs/icon-concepts/v7/.gen/simp-out.svg
```

得到 13 个子路径 / 29 段三次曲线的简化稿。然后人工做三件事：

1. **删掉 v6 新增的水滴**：原文件有 `<circle cx="20.83" cy="6.40" r="0.7">`，这是 v6 实验加的水滴，不属于 A3e-1，必须去掉。
2. 保留 A3e-1 自己的三处飞白：顶部卷口内的细白缝、回浪带内的细白缝、左竖底部的缺口；13 个子路径里除主形和大白月牙外，其余就是这些飞白和原小点。
3. 重写成一个 path：`fill="currentColor" fill-rule="evenodd"`，去掉 Inkscape 的命名空间、id、defs 和 XML 头。

这不是把 autotrace 的碎路径原样交出来：曲线已经从逐像素折线压到 29 段，按“主形 / 大洞 / 三处飞白 / 原小点”分组可读；再小的碎屑只在高分辨率下提供笔触毛边。

### 2. standard / minimal：先膨胀，再描边

原始 A3e-1 的外轮廓在“回浪尾与主浪之间”有一个**拓扑 pinch**：直接取 0.5 等值线会自交，evenodd 填充会把下方白月牙吃掉；对整条轮廓做全局 Catmull-Rom / Q 平滑会过冲、自交，尾部变成粗楔形。

可行路线是先把墨迹做形态学膨胀，让 pinch 合并成简单轮廓，再描边：

```python
ink = gray < 128
dil = scipy.ndimage.binary_dilation(ink, structure=disk(r))
cs  = skimage.measure.find_contours(np.pad(dil, 1), 0.5)
Q   = skimage.measure.approximate_polygon(c, tolerance)
# 映射到 24 坐标；area < 0.15 的碎屑丢弃
# 每个点用 midpoint 法生成 Q 段：M mid, Q point mid, ...
```

- standard：`r = 6`（源图像素），`tolerance = 0.28` 单位，保留外轮廓 + 下方白月牙两条轮廓，共 62 个 Q 段；小飞白在这一档合并掉，但两处关键缺口还在。
- minimal：`r = 36`，`tolerance = 0.30` 单位，只剩 1 条外轮廓（32 个 Q 段），内部白月牙被膨胀填平，成为实心单轮廓。

两档都用 `fill-rule="evenodd"`；minimal 只有一条轮廓，evenodd 与 nonzero 等价。

## 16px 实测

把 SVG 用 Inkscape 渲染到 16×16，再最近邻放大 8× 看像素（见 `wave-preview.png` 最底部）：

- **faithful 不成立**：16px 下三处飞白全部糊成灰边，回浪尾的缺口消失，只剩一团带灰阶的轮廓；它适合 48px 以上。
- **standard 勉强成立**：外轮廓和卷口还能读成浪，但下方白月牙只剩约 1px 的灰缝，笔触细节全失；24px 才是它的舒适区。
- **minimal 成立**：实心单轮廓在 16px 下仍有清楚的浪头 + 卷口，虽然没有飞白，但作为 favicon / 小尺寸标记最稳。

结论：**24px 用 standard，16px 用 minimal，48px 以上用 faithful**。如果只允许一个文件，选 standard，并把 16px 视为可接受的降级。

## 侧栏 18px 实测（2026-11-12）

`RiaIcon` 已改用 faithful。`riaicon-sidebar-check.png` 是无头 Chrome 的 16/18/24/48px × 浅色 `#ffffff` / 深色 `#1e1e1e` 对照（2× 截图），并带 18px 侧栏模拟和与旧图标的新旧对照。

- 16–18px：faithful 明显退化，三处飞白和回浪尾缺口糊成灰边，只剩中央卷口，读不成完整的浪；18px 侧栏里像一个灰色小卷，与上面 16px 的结论一致。
- 24px：外轮廓勉强成立，笔触细节仍损失。
- 48px：笔触和缺口完整，是 faithful 的舒适区。

按要求先上 faithful。如果侧栏 18px 的可读性优先，建议 18px 换 `wave-standard.svg`（16px 则用 `wave-minimal.svg`），24px 以上保留 faithful；`RiaIcon` 仍是一个组件，不按尺寸分叉，替换时只改 path。

## 没有动的东西

- 2026-11-12：`lib/client.js` 的 `RiaIcon` 已改为 faithful，新增 `riaicon-sidebar-check.png`；没有重启 dsh web，没有同步安装副本，没有 push。
- 本次只改 `RiaIcon` 的 path，侧栏折叠/展开仍共用同一个组件。
- 没有新增水滴；v6 的水滴 circle 在 faithful 里已删，standard / minimal 只有 A3e-1 原有的小点。
