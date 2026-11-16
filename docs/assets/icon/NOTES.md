# Ria 图标（v7 浪体）

状态：现行。侧栏 `RiaIcon` 使用 `wave-faithful.svg`。

## 定稿

- 源图：v5 的 A3e-1.png（1024×1024，白底）；v1–v6 候选已清理，本 SVG 自包含。
- 画布：24×24，`viewBox="0 0 24 24"`；单色 `fill="currentColor"`，无 stroke、渐变、filter、mask。
- 坐标映射：`X = (x - 114) * 22 / 791 + 1`，`Y = (y - 115) * 22 / 791 + 1`。
- `wave-faithful.svg`：1 个 path、13 个子路径、29 段三次曲线，7.3 KB；保留 A3e-1 的笔触、三处飞白和卷口内的小圆点，适合 48px 以上。

## 三档取舍

早期做过三档：

| 档位 | 定位 | 结论 |
| --- | --- | --- |
| faithful | 48px 以上 | 最终采用；笔触完整 |
| standard | 24px 主稿 | 1.7 KB；16px 下白月牙只剩约 1px 灰缝 |
| minimal | 16px / favicon | 1.0 KB；实心单轮廓，小尺寸最稳 |

16px 实测：faithful 的三处飞白和回浪尾缺口糊成灰边，读不成完整的浪；standard 勉强成立；minimal 成立。侧栏 18px 实测同样显示 faithful 退化，24px 尚可，48px 才舒适。

只保留一个文件时选 faithful，因为 `RiaIcon` 是单一组件、不按尺寸分叉，且 48px 以上是主要展示场景；16–24px 的可读性降级已知。若以后要按尺寸分叉，standard/minimal 可从 git 历史取回（删除前的路径为 `docs/icon-concepts/v7/`）。

截图：`riaicon-sidebar-check.png`（16/18/24/48px × 浅色/深色，含 18px 侧栏模拟与旧图标对照）；`wave-preview.png`（三档 × 多尺寸，含 16px 最近邻放大）。
