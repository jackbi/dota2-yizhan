# DOTA2 驿站

面向中文玩家的 DOTA2 门户：OB 开播状态与网页端分屏直播、官方新闻与 Reddit 热帖、社区热帖
（NGA / 虎扑）、赛事赛程与战报、版本更新日志、英雄与装备资料，外加 Steam 登录的个人战绩，
以及一间纯 P2P 的开黑房间。用 Astro 构建：内容页全部预渲染成静态 HTML，只有登录相关的
那几条路由按请求渲染。

## 功能

- **分屏直播**（`/live`）：斗鱼用服务端解析出的直链自己播，虎牙嵌官方播放器，解析不到时退回
  「嵌整页 + 取景」兜底；格子可拖分隔条改比例、可全屏，斗鱼格子自带弹幕
- **OB 大家庭**（`/ob`）：十人名单、外号、荣誉与固定直播间，附各人名场面视频
- **官方新闻**（`/news`）：dota2.com.cn 官网资讯与 r/DotA2 热帖，正文抓回站内阅读
- **社区热帖**（`/community`）：NGA 与虎扑两个来源，站内镜像主楼正文与回复，可按来源与时间筛选
- **官方赛事**（`/tournaments`）：TI / Major / ESL 等赛事的赛程与赛果，带战队页
- **版本信息**（`/patches`）：7.08 到最新共 118 个版本的更新日志，按「英雄 → 技能 / 天赋 / 命石」分层
- **英雄与装备**（`/heroes`、`/items`）：属性、定位、出装与物品资料
- **个人战绩**（`/me`）：Steam OpenID 登录后看概况、比赛、英雄、队友与对手、进展、分析五个子页，
  以及每场的记分板
- **开黑房间**（`/party`）：建房、大厅、分队伍、roll 点、聊天，房间走 WebRTC，服务端不存任何房间状态

## 形态与技术栈

- Astro 7 + Tailwind 4，`output: static`；适配器只为那几条 `prerender = false` 的路由存在，
  Node 自托管与 Cloudflare Workers 两套产物都支持，用 `DEPLOY_TARGET` 切换
- 数据全部在构建期抓取后落进 `.cache/`，页面上的动态内容都标注抓取时间，不假装实时
- 主播头像、B站封面、更新日志图标在构建期取回本地再自己发布，避免外链换来的破图
- 没有数据库：会话是无状态签名 Cookie，开黑房间是 P2P

## 快速开始

```sh
pnpm install
pnpm dev        # http://localhost:4321
pnpm build      # 产物在 dist/client（静态）+ dist/server（SSR）
pnpm preview    # 预览构建产物（会起服务端，不是纯静态预览）
pnpm check      # 纯 node 的自检：缓存写入、弹幕编解码、队伍逻辑、Steam ID 解析…
```

第一次 `pnpm build` 会联网把所有来源抓一遍（冷启动一两分钟），结果缓存在 `.cache/`，
之后是秒级。`.cache/` 已在 `.gitignore` 里，删掉不丢东西，只是下次要重抓。

换 logo、重抓字体、改主题色见 [品牌资源与主题色板](./docs/branding.md)。

## 部署

自托管（Node）：

```sh
pnpm build
node --env-file=.env dist/server/entry.mjs   # 监听 PORT / HOST，默认 4321
```

定时重建**用 `pnpm rebuild`，不要用 `pnpm build`**：它先构建到暂存目录，成功后再整体切换、重启进程；
就地重建会把正在服务的资源挖空。Cloudflare Workers 也已经接好，一条命令 `pnpm deploy`。

两边的完整步骤（含「为什么不能就地重建」）、`.cache/` 的缓存与回收策略、定时任务怎么写，
都在 [构建、缓存与部署](./docs/deploy.md)。

## 环境变量

放在项目根目录的 `.env`（已 gitignore），dev 与 build 都会读取。
带 ★ 的两个是 Steam 登录新增的，**构建期用不到、只在服务端运行时读**，所以用 `node` 直接
起线上服务时必须把变量带进进程环境（本地最简单的做法是 `node --env-file=.env`）：

| 变量 | 必需 | 说明 |
| --- | --- | --- |
| `SESSION_SECRET` ★ | 登录必需 | 会话 Cookie 的签名密钥，随便一串足够长的随机值即可（`openssl rand -hex 32`）。**不配置时登录直接报错，不会退回默认密钥** |
| `SITE_URL` ★ | 建议 | 站点对外地址（如 `https://example.com`），用于拼 Steam OpenID 的 `realm` / `return_to`。不配时按请求的 Host 推断，本地开发无需配置；生产挂在反向代理后面时建议显式配上 |
| `STRATZ_TOKEN` | 否 | [stratz.com/api](https://stratz.com/api) 生成。构建期用于取 BP/选手明细与近一周英雄数据；运行时用于个人战绩，以及开黑房间里按手填 Steam ID 查昵称头像。**该 token 绑定调用方 IP**，换 IP 会 403。缺失时构建期回落到 OpenDota（更慢）或整块不展示，个人战绩页与 Steam ID 查询提示「未启用」 |
| `YOUDAO_COOKIE` | 否 | 覆盖有道翻译的默认访客 cookie |
| `AZURE_TRANSLATOR_KEY` / `AZURE_TRANSLATOR_REGION` | 否 | 配置后翻译改用 Azure，否则用有道 |
| `REDDIT_CLIENT_ID` / `REDDIT_CLIENT_SECRET` | 否 | 配置后 Reddit 走 OAuth，否则用 RSS（限流很紧） |
| `LIQUIPEDIA_CONTACT` | 建议 | Liquipedia 要求 User-Agent 里带联系方式，填邮箱即可；不填也能用，但不符合它的条款 |
| `LIVE_PROXY` | 否 | 直播间接口、热门房间列表与图片本地化（头像、B站封面、更新日志图标）的取数方式：`auto`（默认，直连优先、被重置时退回代理）、`jina`（只走代理）、`off`（只直连）。文本走 `r.jina.ai`，图片走 `wsrv.nl` |
| `IMAGE_DEBUG` | 否 | 图片本地化的调试开关（原名 `AVATAR_DEBUG`，拆出 `localImages.ts` 时一并改名）。设为 `1` 时构建日志里逐个频道打印「发布 N 张 / 新下载 N / 命中缓存 N / 拿不到 N」 |
| `TOURNAMENTS_OFFLINE` | 否 | 设为 `1` 时完全不联网，只用 `.cache/` 里的数据构建 |

部署到 Cloudflare 时哪个走 `wrangler secret`、哪个写在 `wrangler.jsonc` 的 `vars` 里，
见 [构建、缓存与部署](./docs/deploy.md)。

## 文档

README 只留「是什么 / 怎么跑 / 怎么部署」，实现细节与踩过的坑按主题拆在 `docs/` 下：

| 主题 | 文件 |
| --- | --- |
| 构建期抓取与 `.cache/`、两套 adapter、部署与重建频率、Cloudflare 发布 | [docs/deploy.md](./docs/deploy.md) |
| Steam 登录、个人战绩页、STRATZ 的四个坑 | [docs/player-profile.md](./docs/player-profile.md) |
| 直播：OB 名单与开播状态、分屏页的画面与格子尺寸、弹幕 | [docs/live.md](./docs/live.md) |
| 数据来源：社区热帖、头像与封面本地化、B站视频、版本 datafeed、赛事 | [docs/data-sources.md](./docs/data-sources.md) |
| 开黑房间：协议、身份来源、连不上时的表现与取舍 | [docs/party.md](./docs/party.md) |
| logo / 字体 / 主题色板 | [docs/branding.md](./docs/branding.md) |
| 与 dart_simple_live 的直播做法差异（为什么浏览器里做不到同样的效果） | [docs/live-source-deltas.md](./docs/live-source-deltas.md) |

## 数据来源与许可

内容全部取自公开上游：dota2.com / dota2.com.cn（新闻、版本）、STRATZ 与 OpenDota（比赛数据）、
NGA / 虎扑 / Reddit（社区）、Liquipedia（赛程）、斗鱼 / 虎牙 / B站（直播与视频）。
本站只做聚合与展示，不托管、不转码任何视频。

赛程与赛果取自 Liquipedia，按它的
[API 条款](https://liquipedia.net/api-terms-of-use)使用：带能识别调用方的 User-Agent、
控制请求频率、署名并回链。**改动这块时请一并保留页面上的署名与外链。**

## 提交规范

见 `AGENTS.md`。
