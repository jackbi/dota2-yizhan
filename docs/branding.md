# 品牌资源与主题色板

## Logo、标签页图标与字体

站点的 logo / 标签页图标是**从母版生成**的，不是手改的：

```sh
# 换 logo：替换 src/assets/logo.png（方形，1254px 或更大），然后
sh scripts/logo-assets.sh   # 生成 public/{logo.webp, favicon.png, apple-touch-icon.png}
```

母版刻意放在 `src/assets/` 而不是 `public/`——`public/` 会原样进发布产物，而站点只需要几张
128px 以内的小图（页眉的 WebP 是 4.7 KB，母版 PNG 是 590 KB）。标签页图标用 PNG 而不用 WebP：
Safari 至今不支持 WebP 的 favicon。

字体同样是生成出来的，跑一遍这条：

```sh
pnpm fonts   # 拉 Google Fonts 的 CSS 与 woff2 → public/fonts/ + src/styles/fonts.css
```

两个家族（`Russo One`、`Chakra Petch`）的分片文件提交进仓库，运行时不碰第三方域名。
换家族、换字重、或者想让 Google 那边的新版生效时重跑即可；脚本会顺手删掉不再被引用的旧分片。
`pnpm check` 里有 `scripts/fonts.check.ts` 盯着「CSS 引用的文件都在、文件都被引用、没人再连
Google Fonts」——这三件事坏掉时页面不会报错，只会静默回退到系统字体，肉眼很难发现。
`unicode-range` 是省流量的关键：中文走 PingFang SC / 微软雅黑，这两个拉丁字体只在页面真的
出现拉丁字符时才下载对应的那一片（19 个分片共 133 KB，一个页面通常只取 1～5 个）。

**字体的许可证不放 `public/fonts/`。** 两个家族都是 SIL OFL 1.1，要求再分发时随附许可证，
所以它们放在 `public/licenses/OFL-RussoOne.txt` 与 `OFL-ChakraPetch.txt`（`public/` 会原样
进发布产物，跟字体一起发出去）。放 `public/fonts/` 会坏两件事：`fonts.check.ts` 要求那个目录里
每个文件都被 CSS 引用，而 `pnpm fonts` 会把不认识的旧文件清掉——许可证会被脚本删掉。

## 主题色板

颜色定义在 `src/styles/global.css` 的 `@theme` 里，是一条约定的「余烬」梯度：

| 变量 | 值 | 角色 |
| --- | --- | --- |
| `--color-dota` | `#c6522c` | 主按钮、描边、强调（基准色） |
| `--color-dota-dark` | `#8f1613` | 主按钮 hover / 按下（基准色） |
| `--color-dota-deep` | `#2e1410` | 渐变最暗端（派生） |
| `--color-dota-light` | `#ea6134` | **只给文字用**的强调档（派生） |
| `--color-gold` | `#d9a05e` | 次级强调文字（派生） |
| `--color-gold-deep` | `#8c4c23` | 铜色填充与描边（基准色） |
| `--color-surface-3` | `#3b1a13` | 标签 / 筹码底色（基准色） |

四个基准色 `#c6522c` / `#8c4c23` / `#8f1613` / `#3b1a13` 本身就是同色系由亮到暗的递进，
所以直接按明度分配角色：亮橙做主色、深红做压暗档、暗棕做底色、铜色做次级。

**文字色和填充色必须分开。** 基准色 `#c6522c` 直接当文字用，在卡片上只有 4.02:1，
达不到 WCAG AA 的 4.5:1（旧主题的 `#d64a2f` 也只有 4.27:1）。因此：

- `--color-dota-light` 取等比提亮 18% 的 `#ea6134`，最差背景 4.64:1；
- 主按钮的 hover 从「变亮」改成「压暗到 `--color-dota-dark`」，白字对比度 9.16:1。

顺带把 `--color-faint` 从 `#6f665c` 提到 `#95847a`（卡片上 3.27:1 → 5.08:1）：
它承担的是房间号、播放量、投稿日期这类要读的信息，不是纯装饰。

改色时要一并搜一遍 `items.astro`、`heroes.astro` 等处**以 `rgb(...)` 硬编码的旧色值**，
以及 Tailwind 的任意值类（如 `bg-[radial-gradient(...,rgba(198,82,44,0.18),...)]`）——
它们不走主题变量，不会自动跟着改。

下面这些**不是**主题色，改主题时不要动：平台品牌色（`src/data/site.ts` 的斗鱼 / 虎牙 /
B站 / YouTube）、英雄属性色与生命魔法条（`src/lib/heroApi.ts`）、「直播中」的绿色，
以及英雄详情面板 `#252728 → #101415` 的冷灰渐变（照 DOTA2 官方 DetailsBar 还原的）。
