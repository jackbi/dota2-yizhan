# DOTA2 驿站

面向中文玩家的 DOTA2 门户：OB 直播与分屏观看、官方资讯、社区热帖（NGA / Reddit）、
职业赛事日历与战报、版本信息、英雄与装备资料。基于 Astro 的纯静态站点。

## 开发

```sh
pnpm install
pnpm dev        # http://localhost:4321
pnpm build      # 产物在 dist/
pnpm preview    # 预览 dist/
```

## 数据都是构建期抓取的

站点是 `output: static`，页面里没有任何运行时请求：所有数据在构建时（dev 下是渲染
页面时）由 Node 抓取，再渲染成静态 HTML。抓取结果落在 `.cache/`：

| 目录 | 内容 | 缓存时长 |
| --- | --- | --- |
| `.cache/news/` | dota2.com.cn 官方新闻列表与正文 | 列表 30 分钟，正文永久 |
| `.cache/community/` | NGA 刀塔版块热帖与楼层 | 列表 30 分钟，帖子 7 天 |
| `.cache/reddit/` | r/DotA2 热帖 | 1 小时 |
| `.cache/opendota/` | 队伍索引、职业比赛、阵容名单 | 6 小时 – 7 天 |
| `.cache/stratz/` | BP 与选手明细、一周英雄数据 | 1 小时 – 30 天 |
| `.cache/translate/` | 机器翻译结果 | 永久 |
| `.cache/tournaments.json` | 超凡电竞赛事日历 | 每次拿到完整日历就覆盖 |

### `.cache/` 不进仓库

已经在 `.gitignore` 里，**不要提交，也不要上传**：它是可再生的抓取结果，而且包含
第三方站点的原始 HTML、社区帖子正文与机器翻译，体积只会越来越大。

删掉它不会丢任何东西，但代价是下一次构建（或 dev 下第一次打开页面）要把所有来源
重新抓一遍——冷启动约一两分钟，其中最慢的是 OpenDota 未鉴权接口的 1.1 秒串行限速。
所以**删掉 `.cache/` 之后建议先跑一次 `pnpm build` 预热，再 `pnpm dev`**，之后 dev
下打开页面就是秒开。

部署同理：在 CI 上按 `.cache` 做构建缓存（或加一个预热步骤），不要把缓存提交进仓库。

## 环境变量

放在项目根目录的 `.env`（已 gitignore），dev 与 build 都会读取：

| 变量 | 必需 | 说明 |
| --- | --- | --- |
| `STRATZ_TOKEN` | 否 | [stratz.com/api](https://stratz.com/api) 生成。用于取 BP/选手明细与近一周英雄数据；缺失时自动回落到 OpenDota（更慢）或整块不展示 |
| `YOUDAO_COOKIE` | 否 | 覆盖有道翻译的默认访客 cookie |
| `AZURE_TRANSLATOR_KEY` / `AZURE_TRANSLATOR_REGION` | 否 | 配置后翻译改用 Azure，否则用有道 |
| `REDDIT_CLIENT_ID` / `REDDIT_CLIENT_SECRET` | 否 | 配置后 Reddit 走 OAuth，否则用 RSS（限流很紧） |
| `TOURNAMENTS_OFFLINE` | 否 | 设为 `1` 时完全不联网，只用 `.cache/` 里的数据构建 |

## 提交规范

见 `AGENTS.md`。
