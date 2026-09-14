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
| `.cache/liquipedia/` | Liquipedia 赛程页解析结果 | 30 分钟 |
| `.cache/live/` | 斗鱼 / 虎牙各直播间的开播状态 | 5 分钟 |
| `.cache/tournaments.json` | 聚合后的赛事日历 | 每次拿到完整日历就覆盖 |
| `.cache/health/` | 各数据源本轮的抓取结果 | 每次构建开始时清空 |

### `.cache/` 不进仓库

已经在 `.gitignore` 里，**不要提交，也不要上传**：它是可再生的抓取结果，而且包含
第三方站点的原始 HTML、社区帖子正文与机器翻译，体积只会越来越大。

删掉它不会丢任何东西，但代价是下一次构建（或 dev 下第一次打开页面）要把所有来源
重新抓一遍——冷启动约一两分钟，其中最慢的是 OpenDota 未鉴权接口的 1.1 秒串行限速。
所以**删掉 `.cache/` 之后建议先跑一次 `pnpm build` 预热，再 `pnpm dev`**，之后 dev
下打开页面就是秒开。

部署同理：在 CI 上按 `.cache` 做构建缓存（或加一个预热步骤），不要把缓存提交进仓库。

### 构建结束的数据源汇总

抓取是"拿不到就不展示"的静默降级，所以每次 `pnpm build` 结束时会打印一份汇总，
说明每个源这一轮是新抓的、吃缓存的，还是根本没拿到：

```
[data-source-report] 数据源（8）：
[data-source-report]   直播开播状态 — 联网抓取：11 个房间：直播中 5、轮播中 1、未开播 3、状态未知 2、房间已换人 1，联网抓取 12 次
[data-source-report]   官方更新日志 — 联网抓取：8 条，最新 7.41d（2026-06-05），联网抓取 1 次
[data-source-report]   赛事日历 — 联网抓取：7 个赛事，1 场进行中；来源：Liquipedia / OpenDota
```

没有数据的源排在最前面。原始记录在 `.cache/health/`，dev 下不会自动汇总，可以直接翻。

## OB 名单与开播状态

`src/data/ob.ts` 是 OB 大家庭的唯一名单来源，只写有出处的内容：十人名单以斗鱼官方签约通稿
（2018-12-07「OB 战队目前共有九人」）与 2019-06-13 OB 官博「十人全家福」为准，老陈是前身
「龙宝川」三人组的成员，一并收录。外号与梗属于社区流传内容，页面上单独标注，且不收感情纠纷、
赌博与私生活相关的内容。

开播状态由 `src/lib/liveApi.ts` 在构建期抓取，两个前提决定了它的形态：

- 斗鱼、虎牙的房间页都是客户端渲染，且通常禁止被 iframe 嵌套，而两家的房间接口都**没有 CORS 头**，
  浏览器里取不到。所以状态只能在构建期抓，页面上显示的是**构建那一刻的快照**并标注抓取时间——
  静态站点做不到实时。页面不显示观看人数，也不显示平台的热度值。
- 部分网络到 `douyu.com` / `huya.com` 的 TLS 握手会被直接重置（开发这个项目时就遇到过），
  所以除了直连还留了 `r.jina.ai` 读取代理做回退，用 `LIVE_PROXY` 控制。直连与代理都会偶发失败，
  两条路各重试若干轮。

### 别用 `open.douyucdn.cn`

斗鱼用房间页自己加载的 `https://www.douyu.com/betard/{id}`。**不要用
`open.douyucdn.cn/api/RoomApi/room/{id}`**：它看起来是"官方开放接口"，但对部分房间返回的是
十几年前的僵尸记录——820 的 82088 返回 `start_time: 2014-10-27`、房主「用户已注销」、分区
「英雄联盟」，而房间页标题明确写着「820邹倚天DOTA2直播」。曾据它给 820 标过"房间已注销"，
是错的。现在整条链路都不碰它。

（顺带一提，给 `r.jina.ai` 带浏览器 `User-Agent` 会触发它的 Cloudflare 验证，必须不带。）

房间号会随主播转平台或换房间而变化，因此每个成员都带 `ownerMatch`：构建期用平台返回的房主昵称
核对，对不上才说「房间已换人」，并写明现在归谁。主接口失败时退一步只读房间页标题判断房间归属，
**对得上就老实说「状态未知」，绝不因为拿不到状态就说房间没了**。任何情况下都不写死假的
「正在直播」。

## 环境变量

放在项目根目录的 `.env`（已 gitignore），dev 与 build 都会读取：

| 变量 | 必需 | 说明 |
| --- | --- | --- |
| `STRATZ_TOKEN` | 否 | [stratz.com/api](https://stratz.com/api) 生成。用于取 BP/选手明细与近一周英雄数据；缺失时自动回落到 OpenDota（更慢）或整块不展示 |
| `YOUDAO_COOKIE` | 否 | 覆盖有道翻译的默认访客 cookie |
| `AZURE_TRANSLATOR_KEY` / `AZURE_TRANSLATOR_REGION` | 否 | 配置后翻译改用 Azure，否则用有道 |
| `REDDIT_CLIENT_ID` / `REDDIT_CLIENT_SECRET` | 否 | 配置后 Reddit 走 OAuth，否则用 RSS（限流很紧） |
| `LIQUIPEDIA_CONTACT` | 建议 | Liquipedia 要求 User-Agent 里带联系方式，填邮箱即可；不填也能用，但不符合它的条款 |
| `LIVE_PROXY` | 否 | 直播间接口的取数方式：`auto`（默认，直连优先、被重置时退回 `r.jina.ai`）、`jina`（只走代理）、`off`（只直连） |
| `TOURNAMENTS_OFFLINE` | 否 | 设为 `1` 时完全不联网，只用 `.cache/` 里的数据构建 |

## 赛事数据来自 Liquipedia

赛程与赛果取自 Liquipedia 的 [`Liquipedia:Matches`](https://liquipedia.net/dota2/Liquipedia:Matches)
（原来的超凡电竞接口已不再响应）。使用它需要遵守
[Liquipedia API 条款](https://liquipedia.net/api-terms-of-use)：带能识别调用方的 User-Agent、
控制请求频率、署名并回链。代码里只在一页上取一次数据（30 分钟缓存），
页面上也保留了到 Liquipedia 的链接——改动这块时请一并保留。

## 提交规范

见 `AGENTS.md`。
