# v6 · A3e-1 的水滴实验

## 结论

- 六种配置都只改水滴，浪体逐像素未改。contact 第一格是母本 A3e-1，后六格是合成后的变体。
- 按“水滴直径≈最粗笔画 1/4–1/3”的比例，水滴在 16px 全部消失，24px 也基本不可见，32px 只剩最大的一颗约 1px 灰点，48px 才可辨。
- 因此“哪 3 张在 16/24/48px 都成立”的答案是：**没有**。最接近的是 #1 / #2 / #6（水滴不超过 2 颗），但 16px 仍不成立；16px 下 A3e-1 的飞白和回浪尾本身就不可辨。
- 推荐 **#1 单颗**：只有一颗 26px 墨点，位置在卷口外上方 (880, 290)，与卷口留出约 90px 空白。它的矢量版只需要一个独立 circle，16px 约 1px，24/48px 都能读成“浪 + 一颗水珠”。
- 若 16px 是硬性要求，不能靠放大水滴解决；应另做一版简化浪体（去掉内卷和飞白），再保留 1 颗 1.5 单位的点。见文末“16px”。

## 方法：图生图只生成水滴，合成保证浪体不动

这一轮试过三种引导：

1. **纯文字坐标**（A3w-1 第一版）：模型把“2 点钟、15px”画成 3 点钟、约 50px 的大圆点。浪体保持很好，但位置/尺寸不听话。
2. **实心红点**（A3w-1g）：模型把红点变成泪滴，并下移到卷口附近，位置和形状都错。
3. **红色细环**（A3w-1r）：位置基本正确，浪体几乎不变；但输出水滴仍有 30–100px，远大于目标，模型的最小可控墨点约 30–35px。

更关键的是，**图生图会把浪体整体加粗/重画**：即使提示词要求“逐像素不动”，模型输出的浪脊、卷口厚度、飞白都和 A3e-1 有肉眼可见差异。为满足“不要动 A3e-1 的浪体本身”，最终采用两层做法：

- 图生图只负责**水滴形态**（红环定位 + 墨点质感）；
- 用 PIL 把水滴从模型输出里按灰度抠出（alpha = (255-gray)/255），缩放到目标直径，再合回 A3e-1 的原图。位置、尺寸、数量由脚本精确控制；浪体像素完全来自 A3e-1。
- #5 的短划线模型画得和浪体缠在一起，无法干净抠出，最后用 PIL 画了一道两端带收锋的短划（24×8px，40°）。这是六张里唯一非模型生成的水滴元素。

所以 variants/ 里的六张是“A3e-1 + 合成水滴”，不是模型直出；raw/ 里的模型原图只作为水滴来源，不提交。这样 contact 里看到的水滴是模型墨点形状，但位置/尺寸是设计的，不是模型随机发挥。

### 网关调用（实际使用）

- 提交：POST https://aigc.sankuai.com/v1/google/models/gemini-3.1-flash-image:imageGenerate，Authorization: Bearer <AIGC_APPID>。
- 图生图输入必须是 **snake_case**：parts=[{"inline_data":{"mime_type":"image/png","data":base64}},{"text":prompt}]；generationConfig.responseModalities=["TEXT","IMAGE"]，seed，imageConfig={"aspectRatio":"1:1","imageSize":"1K"}。
- 查询：GET https://aigc.sankuai.com/v1/google/models/{operationId}:imageGenerateQuery，operationId 在路径里；用 ?operationId= 会得到 {"status":-1,"data":"未找到对应记录"} 或 500 begin 7, end 6, length 6。
- status：0 生成中，1 成功，-1 失败；成功图 URL 在 data.candidates[].content.parts[].inlineData.data。每张约 10–20s。
- 本轮 seed：2101–2106。appid 只在运行时环境变量里，不写入仓库。

## 六张配置

| 编号 | 配置 | 合成参数（中心 x,y / 直径） | 优点 | 问题 |
| --- | --- | --- | --- | --- |
| A3w-1 | 单颗 | 26px @ (880, 290) | 最干净；一颗独立墨点；矢量只需一个 circle | 32px 只剩约 1px 灰点；16px 无 |
| A3w-2 | 两颗，一小一大 | 18px @ (825, 305) + 32px @ (872, 355) | 有方向、有大小层级；contact 里最像“溅起来”的一组 | 小滴先消失；大滴离卷口较近，16px 会并进去 |
| A3w-3 | 三颗沿切线排弧 | 18px @ (810, 260) + 26px @ (866, 295) + 32px @ (916, 345) | 弧线关系最完整；48px 有节奏 | 32px 只剩最大一颗；16px 全无；三颗在小尺寸容易成噪点 |
| A3w-4 | 三颗 + 尾端一颗 | 同 #3 + 18px @ (118, 795) | 尾端一颗把左下空白补上，故事最完整 | 尾端离主体太远，32px 先消失；整体最散 |
| A3w-5 | 两点 + 一道短划 | 26px @ (846, 300) + 24×8px 40° @ (890, 340) + 18px @ (920, 392) | 短划有“飞溅”速度感，不是雨点 | 短划在 32px 只有约 1px，容易读成脏点；16px 全无 |
| A3w-6 | 外沿一点 | 18px @ (820, 448) | 最克制，像浪尖甩出的一滴 | 离卷口只有 17px，32px 会和浪体粘在一起；16px 无 |

> 说明：#1 的提示词目标位置是 (860, 330)，模型原图落在 (866, 321)；合成时为了在卷口外留出约 90px 空白、避免矢量里粘住，微调到 (880, 290)。#2–#6 的合成位置与提示词基本一致。

### 提示词

共同段（#1–#4、#6 开头；#5 另起一段）：

    Use the supplied image as the exact base. The thin red ring(s) are only placement-and-size guides, not part of the design. Each red ring marks one droplet: replace it with exactly one solid black ink droplet that fills the ring's inner area, with the same center and diameter and a soft dry-brush edge. Remove every red pixel. Do not move, resize, redraw, restyle, recolor, crop, or rotate the wave: keep every existing black brush stroke, the composition, the left rising stroke, the top curl, the lower backwash line, the dry-brush texture, negative space, and white background exactly as they are. Do not add any other droplet, splash, line, text, frame, or shadow. Do not turn the droplets into teardrops or rain; they are round beads.

各题追加段：

- **A3w-1**（seed 2101，ref .gen/A3w-1-guide.png）：There is exactly one red ring in this image, centered at roughly x=860, y=330, about 15 pixels across. Replace it with one round black droplet of that size, in the empty white space outside the upper-right of the curl. It must not touch any wave stroke; keep at least 40 pixels of clear white around it.
- **A3w-2**（seed 2102，ref .gen/A3w-2-guide.png）：There are exactly two red rings in this image: a smaller one at roughly x=825, y=305, about 9 pixels across, and a larger one at roughly x=872, y=355, about 16 pixels across. Replace each ring with one round black droplet of the same center and size, so the two beads sit along one short diagonal splash direction from upper-left to lower-right. They must not touch the wave or each other; keep at least 35 pixels of clear white around each.
- **A3w-3**（seed 2103，ref .gen/A3w-3-guide.png）：There are exactly three red rings in this image, placed along a gentle arc outside the upper-right of the curl, with increasing spacing: a small one at roughly x=810, y=260 (about 8 pixels), a medium one at roughly x=866, y=295 (about 12 pixels), and a larger one at roughly x=916, y=345 (about 16 pixels). Replace each ring with one round black droplet of the same center and size. They must not touch the wave or each other; keep at least 30 pixels of clear white around each.
- **A3w-4**（seed 2104，ref .gen/A3w-4-guide.png）：There are exactly four red rings in this image. Three follow the same gentle arc outside the upper-right of the curl, with increasing spacing: about 8 pixels at roughly x=810, y=260; about 12 pixels at roughly x=866, y=295; about 16 pixels at roughly x=916, y=345. The fourth is a small 8-pixel ring near the far left tail tip, at roughly x=118, y=795, as if the receding tide left one bead behind. Replace each ring with one round black droplet of the same center and size. They must not touch the wave or each other; keep at least 30 pixels of clear white around each.
- **A3w-5**（seed 2105，ref .gen/A3w-5-guide.png）：开头换成 Use the supplied image as the exact base. The red marks are only placement-and-size guides, not part of the design: two thin red rings and one short red bar. 后续要求把红环换成圆珠、红短划换成同长同宽同角度的收锋黑短划；两个环约 11px @ (846, 300) 和 8px @ (920, 392)，红短划约 18×7px、40° @ (890, 340)。
- **A3w-6**（seed 2106，ref .gen/A3w-6-guide.png）：There is exactly one small red ring in this image, centered at roughly x=820, y=448, about 8 pixels across, just outside the outer lip of the curl at about 3 o'clock from the mouth. Replace it with one tiny round black bead of the same center and size. It must not touch the curl or any other stroke; keep at least 12 pixels of clear white around it. Keep the splash extremely minimal: no other droplet, no line, no text, no frame, no shadow.

## 32px / 48px 实测

位图水滴在 32px 的直径 = 源直径 × 32 / 1024：

| 源直径 | 16px | 24px | 32px | 48px |
| --- | --- | --- | --- | --- |
| 18px（小） | 0.28px | 0.42px | 0.56px | 0.84px |
| 26px（中） | 0.41px | 0.61px | 0.81px | 1.22px |
| 32px（大） | 0.50px | 0.75px | 1.00px | 1.50px |

- **16px**：六张都没有可辨水滴；母本本身也只剩紧凑轮廓。
- **24px**：只有 32px 的大滴留下极淡的 1px 灰点；18/26px 不可辨。
- **32px**：只有带 32px 大滴的 #2/#3/#4 留下 1px 灰点；#1/#5/#6 基本看不到。
- **48px**：六张的水滴都可辨；但 18px 小滴仍偏灰，#1/#2 的层级最清楚。
- contact 每格下面的 32px 缩略图是真实显示尺寸，不是放大图；看起来“没有水滴”是正确结果，不是漏画。

## 矢量：trace-fill.svg

选 **#1 单颗** 做 24×24 填充矢量：

- 母本 A3e-1 灰度阈值 128，内容 bbox 外扩 40px，缩到 1200×1200；skimage.measure.find_contours(0.5)，approximate_polygon(tolerance=1.2)，面积 <30 的碎屑丢弃，映射到 20 单位内容区（offset 2）。
- 轮廓做 1 次 Chaikin 平滑，合并为一条 fill-rule="evenodd" 的 path（13 个子路径），无 stroke、无渐变。
- 水滴是独立 circle：cx=20.83、cy=6.40、r=0.70、fill=currentColor；没有并进 path。
- 整体按“浪体 + 水滴”的联合 bbox 居中；viewBox 0 0 24 24。
- 矢量的水滴半径 0.70（直径 1.40 单位）：16px 约 0.93px，24px 约 1.4px，48px 约 2.8px。这比位图的 1/4–1/3 比例大，是刻意的：要在 16px 留 1px，只能做到 1.4 单位；位图和矢量在这一点上无法同时满足，NOTES 里明确分开。

### 16 / 18 / 24 / 48 实际表现

- **16px**：浪体只剩一个紧凑的黑色轮廓，卷口内白约 1px；飞白全失，回浪尾只剩左竖末端的一点点缺口；水滴约 1px，但和卷口外沿只隔约 1px，视觉上容易并进轮廓。**能读成“带一颗水珠的浪”，但水珠不是独立可辨的圆点。**
- **18px**：比 16px 多约 1px 的回旋余地，卷口内白仍在；水滴开始能和卷口分开。
- **24px**：浪的卷口、回浪尾都能读；水滴是独立圆点；飞白只剩零星白缝。
- **48px**：卷口、回浪尾、水滴都清楚；飞白和内卷的白缝大部分被填掉，笔触比位图更粗、更“标”。这是 trace + 24 单位栅格化的代价，不是水滴造成的。

trace-preview.png 里每格先按实际尺寸渲染，再最近邻放大到约 96px；浅底 #fbfbf9、深底 #111111 各一行，标签里写了放大倍数。

## 16px 的建议

如果 16px 必须成立，不要继续放大水滴：

1. 浪体做 16px 专用简化稿：保留左竖、外卷和回浪尾三段，去掉内卷的第二道回锋和大部分飞白；
2. 水滴保留 1 颗，直径 1.5 单位，放在卷口外上方至少 2 单位处；
3. 24/48px 继续用现在这版 trace-fill.svg。

现在这版适合 **24px 起用**；16px 只能算“轮廓可辨”，不能算“水滴可辨”。

## 文件

- contact.png：A3e-1 + 六张合成变体，220px 观察图 + 32px 实际大小。
- variants/A3w-1..6.png：1024×1024，A3e-1 逐像素未改，只合入水滴。
- trace-fill.svg：24×24，fill=currentColor，13 个子路径 + 1 个独立水滴 circle。
- trace-preview.png：16/18/24/48px × 浅/深底。
- raw/、.gen/ 是生成过程，不提交。

未改 lib/client.js，未重启 dsh web，未推送。
