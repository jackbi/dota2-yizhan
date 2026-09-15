# DOTA2 驿站

面向中文玩家的 DOTA2 门户：OB 直播与分屏观看、官方资讯、社区热帖（NGA / Reddit）、
职业赛事日历与战报、版本信息、英雄与装备资料。基于 Astro 的纯静态站点。

## 开发

```sh
pnpm install
pnpm dev        # http://localhost:4321
pnpm build      # 产物在 dist/client（静态）+ dist/server（SSR）
pnpm rebuild    # 构建到暂存目录、成功后切换，供定时任务用（见「部署与重建频率」）
pnpm preview    # 预览构建产物（会起服务端，不是纯静态预览）
```

线上运行见「[Steam 登录与个人战绩](#steam-登录与个人战绩)」——多了一步 `node dist/server/entry.mjs`。
**定时重建别用 `pnpm build`，用 `pnpm rebuild`**：就地重建会把正在服务的资源挖空，原因见
「[部署与重建频率](#部署与重建频率)」。

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

## 数据都是构建期抓取的

站点是 `output: static`，内容页没有任何运行时请求：所有数据在构建时（dev 下是渲染
页面时）由 Node 抓取，再渲染成静态 HTML。抓取结果落在 `.cache/`：

**唯一的例外**是「Steam 登录 + 个人战绩」（见下一节）：那几条路由是 `prerender = false`，
按请求在服务端向 STRATZ 取数。它们不参与 `.cache/`，理由与做法写在同一节里。

| 目录 | 内容 | 缓存时长 |
| --- | --- | --- |
| `.cache/news/` | dota2.com.cn 官方新闻列表与正文 | 列表 30 分钟，正文永久 |
| `.cache/community/` | NGA 刀塔版块热帖与楼层、虎扑 DOTA2 区列表与帖子详情 | 列表 30 分钟，帖子 2 小时 – 7 天 |
| `.cache/reddit/` | r/DotA2 热帖 | 1 小时 |
| `.cache/opendota/` | 队伍索引、职业比赛、阵容名单 | 6 小时 – 7 天 |
| `.cache/stratz/` | BP 与选手明细、一周英雄数据 | 1 小时 – 30 天 |
| `.cache/translate/` | 机器翻译结果 | 永久 |
| `.cache/liquipedia/` | Liquipedia 赛程页解析结果 | 30 分钟 |
| `.cache/live/` | 斗鱼 / 虎牙各直播间的开播状态 | 5 分钟 |
| `.cache/roomlist/` | 斗鱼 / 虎牙 DOTA2 分区的热门房间列表 | 30 分钟 |
| `.cache/avatars/` | 主播头像的字节（构建结束拷进 `dist/avatars/`） | 永久，30 天没用到就清理 |
| `.cache/covers/` | B站视频封面的字节（构建结束拷进 `dist/covers/`） | 永久，30 天没用到就清理 |
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
[data-source-report]   直播开播状态 — 联网抓取：11 个房间：直播中 5、轮播中 1、未开播 4、房间已关闭 1，联网抓取 11 次
[data-source-report]   官方更新日志 — 联网抓取：8 条，最新 7.41d（2026-06-05），联网抓取 1 次
[data-source-report]   赛事日历 — 联网抓取：7 个赛事，1 场进行中；来源：Liquipedia / OpenDota
```

没有数据的源排在最前面。原始记录在 `.cache/health/`，dev 下不会自动汇总，可以直接翻。

## Steam 登录与个人战绩

用 Steam 账号登录后可以看自己的战绩：`/me` 是概况，下面还有比赛、英雄、队友与对手、
进展、分析五个子页；比赛列表里每一行都可以点进 `/me/matches/<对局号>` 看这一场的记分板。
数据来自 STRATZ 的 GraphQL 接口（公开比赛数据），**不需要 Steam Web
API Key**——登录只用到 OpenID，昵称和头像由 STRATZ 一并返回。

### 这几条路由是 SSR，其余仍是纯静态

页面本身还是构建期生成的静态 HTML，只有下面几条走服务端：

| 路径 | 作用 |
| --- | --- |
| `/api/auth/steam/login` | 302 跳去 Steam OpenID |
| `/api/auth/steam/callback` | 校验断言、发会话、回 `/me` |
| `/api/auth/logout` | POST 清会话 |
| `/api/me` | 页头脚本查登录态用的 JSON |
| `/api/steam/profile` | 按手填的 Steam ID 查昵称与头像（开黑房间用） |
| `/login`、`/me`、`/me/*` | 登录页与六个战绩页 |
| `/party` | 开黑房间。**页面是 SSR，房间不是**：只为把「你是谁」按登录态渲染对，房间本身仍全在浏览器里 |

`astro.config.mjs` 里挂了 `@astrojs/node`，构建产物因此从「一个 `dist/`」变成
`dist/client/`（静态资源）+ `dist/server/`（SSR）。**部署方式随之改变**：

```sh
pnpm build
node --env-file=.env dist/server/entry.mjs   # 监听 PORT / HOST，默认 4321
```

`--env-file=.env` 不能省：`astro:env` 的密钥是**运行时**从 `process.env` 读的，
不会内联进产物，所以直接 `node dist/server/entry.mjs` 会读不到 `SESSION_SECRET`
而拒绝登录。用 Docker / systemd 部署时，把变量配进进程环境即可，不必带这个参数。
`astro preview` 走的也是同一个服务端入口。

### 换 adapter 只动三行

Node 只是为了「本地能跑、能自托管」。要上 Vercel / Netlify / Cloudflare，装对应 adapter
再改 `astro.config.mjs` 里的 `adapter: node(...)` 那一行即可，**路由与页面不用动**——
SSR 侧代码刻意只用 Web 标准 API：

- `src/lib/session.ts` 用 `crypto.subtle` 签 Cookie，不碰 `node:crypto`；
- `src/lib/stratzPlayer.ts` 与 `src/lib/ssrCache.ts` 只用 `fetch` + 内存 Map，不碰 `node:fs`；
- 密钥统一从 `astro:env` 读，Workers 下会自动接到运行时绑定上。

**注意 Cloudflare**：`astro dev` 在 CF adapter 下会跑 workerd，而 `astro.config.mjs` 里
`imagesInDev` 那段 dev 中间件用了 `node:fs`（图片字节），到时候需要一起改。

### 会话与登录安全

会话是**无状态签名 Cookie**（HMAC-SHA256），服务端不存 session，所以不需要数据库，
在 Serverless / Workers 上行为一致。有效期 30 天。

- `SESSION_SECRET` 没配置时一律拒绝签发与校验，**不会退回默认密钥**；
- 登录跳转带一次性 `state`（存 `d2s_login_state` Cookie），挡登录 CSRF；
- 回调必须回 Steam 反查 `check_authentication`，并校验 `op_endpoint`、`return_to`、
  `claimed_id` 形状——只看回调参数就发会话等于谁都能伪造登录；
- 昵称是用户可控输入，页头那段水合脚本用 `createElement` + `textContent` 拼 DOM，不用 `innerHTML`。

### 四个上游的坑

**`matches` 的 `take` 上限是 100。** 超过不是截断而是直接报错
（`You have surpassed the maximum take value of : 100`），`/me/matches` 因此每页取 25。
聚合接口 `matchesGroupBy` 的 `take` 含义完全不同——它限的是**参与聚合的比赛数**，
默认值只有 20 左右，不放大就只统计得到最近几场，「全部时间」的胜率会假得离谱。

**STRATZ 的 token 绑定 IP。** 出口 IP 一变就直接返回
`You cannot use different IP Addresses when using the API`（403，而且**是纯文本响应、
连 `content-type` 都没有**）。它和 Cloudflare 挑战页同为 403，但后者随机出现、值得重试，
所以 `stratzPlayer.ts` 的 `gql()` 会先读 body 再分类——不特判的话页面上只剩一句
「HTTP 403」，看不出该去改什么（这个坑真踩过）。除这两类之外的 403 也按「可能短暂」重试
（挑战页的返回形态不止 HTML 一种），但重试耗尽后的文案保留原始状态码，不冒充挑战页——
否则 token 失效这类硬失败会被说成「稍后再试」。

**绑的是哪一个 IP，实测过。** 同一条查询、连着四轮，**走代理 4/4 通，`--noproxy` 绕开代理
直连 4/4 全是 403**——这个 token 绑定的是**代理节点那一个出口 IP**，家宽 IP 不在绑定里。
由此有两条结论：

- **本地**：`PROXY` 如果配成按延迟自动选（Clash 的 URLTest 组），它会在节点之间切，出口 IP
  一变就 403、切回来又通。要稳就把这一组固定到 token 绑定的那个节点上，别让它自动选。
- **部署**：Vercel / Cloudflare 上没有这个代理，出口既不是节点 IP 也不是家宽 IP，
  **同一个 token 原样部署上去必然 403**。要上线得在那边重新生成 token（绑定那边的出口），
  或者找 STRATZ 重置绑定。这件事应当在选平台之前就排掉。

> 有一个对不上的观察，别被它带偏：另一次连续二十分钟的 403，期间回显服务报的出口 IP 一直
> 没变（每 12 秒采一次共 14 次，两个不同的回显服务对得上）。所以「切节点」未必是唯一原因，
> STRATZ 侧也可能存在多后端不一致或缓存。但「只有走那个出口才通」是确定的。

token 本身不带 IP——解出来只有 `Subject` / `SteamId` / `APIUser` / `nbf` / `exp`，
所以绑定状态在 STRATZ 那侧，从本地看不出它认的是哪个 IP。取数层把这种情况按「上游故障」
处理，页面给可重试的提示，而不是当成「这个玩家没有数据」。

**位置/分路/定位里藏着一批「无记录」的比赛。** STRATZ 不返回「未知」，而是把远古局、
未解析局塞进各维度的默认枚举值（位置记成 `POSITION_1`、分路记成 `ROAMING`、定位记成
`CORE`），`avgImp` 一律为 0。实测某个 1338 场的账号，这三处是同一批 1071 场。直接渲染
会同时出现「两个 1 号位」和「1071 场 1 号位」这种失真结果。`stratzPlayer.ts` 的
`splitUnclassified()` 按「三个维度里 (场次, 胜场) 完全相同」把它认出来摘掉，页面上单独
注明「另有 N 场没有位置记录」。

**时段是 UTC，不是本地时间。** 讲的是 `groupBy(HOUR)`：把最近 100 场的 `startDateTime`
按 UTC 分桶，与接口返回的分布吻合（总偏差 42），按 UTC+8 分桶则差得很远（偏差 166）。
`/me/breakdown` 因此统一换算成北京时间再显示——换算后峰值落在 20:00–21:00，
与国内玩家的作息对得上。

### 单场对局页：`/me/matches/[id]`

`src/pages/me/matches/[id].astro` + `MatchScoreboard.astro`，天辉/夜魇两栏各五张选手卡，
高亮当前登录账号那一行，并把他的 `award`（MVP / 最佳核心 / 最佳辅助）标出来。数据层是
`stratzPlayer.ts` 的 `loadMatchDetail()`，一次 `match(id:)` 把十个选手一起取回来——
这里**不能**加 `playerList: SINGLE`，那是列表页为了只拿本人一行才用的。

页面跟其余五个子页一样要求登录，所以**分享链接给别人会跳登录页**。对局数据本身是公开的，
要做成可分享的得换一套不依赖 `PlayerLayout` 的外壳，暂时没做。

字段用真实响应（比赛 7720294433）核对过。几个刻意的取舍：

- **不查 `pickBans`。** 个人对局绝大多数是加速/普通匹配，本来就没有 BP：实测这场 Turbo
  返回的就是 `null`。为它多写一套 UI 不划算。
- **物品格保留空位。** `item0Id`~`item5Id` 里没放东西的格子上游直接不给字段，映射层补成
  `null` 而不是过滤掉——记分板上「这个格子是空的」本身是信息（卖掉的中件、没打完的装备）。
  列表页的 `PlayerMatch.items` 反而是过滤掉的，两处需求不同，别顺手统一。
- **时间显示开赛时刻，而 STRATZ 页头显示的是结束时刻。** 同一场，我们显示 19:30，
  STRATZ 写 20:01（= 19:30 + 31:23）。两边都没错，并排比对时别以为是数据不一致。
- **`award` 的 `NONE` 要当「没有」。** 上游用一个真实枚举值表示没拿奖，直接渲染会让每张卡
  都挂一个 `NONE` 角标。
- **路由是 `/me/matches/[id]`，不是 `/matches/[id]`。** 后者是赛事日历那条线，id 形如
  `lp-<开赛时间>-<主队>-<客队>`（`tournamentIndex.ts`）。混用会让 `/me/matches` 上每一行
  都 404——这个坑真踩过，见 commit `30a541d`。

### 头像为什么必须带 `referrerpolicy="no-referrer"`

Steam 的头像 CDN（`avatars.steamstatic.com`）会拒掉带 Referer 的请求，不带这个属性页面上
就是一张破图。站内主播头像、比赛页的队标一直是这么处理的，个人战绩页的头像统一走
`src/components/player/Avatar.astro`：带 `no-referrer`，加载失败时摘掉 `<img>` 露出首字母，
不会出现破图图标。

## 开黑房间（`/party`）

建房、大厅、聊天、roll 点、分队伍。**房间完全不经过服务端**：传输是 WebRTC 数据通道，
信令走 Trystero 的公共中继。页面本身是 SSR（`prerender = false`），但只为一件事：
把「你是谁」按登录态渲染对——登录状态服务端本来就知道，没必要让已登录的人先看到一个
「用 Steam 登录」按钮（脚本一挂就一直留在那儿，Vite 预构建 504 那次真踩过）。

### 为什么不做成服务端房间

本站每 5 分钟重建并重启一次（见「[部署与重建频率](#部署与重建频率)」）。房间状态放在
SSR 进程内存里，就会被那次重启清空一次；放进数据库又要引入本站一直刻意避开的依赖。
P2P 房间不受重启影响，代价写在下文「[连不上的几种情况](#连不上的几种情况)」里。

| 文件 | 职责 |
| --- | --- |
| `src/pages/party.astro` | 页面骨架（身份按会话渲染、设置区 / 房间区），不写业务逻辑 |
| `src/scripts/partyRoom.ts` | 大厅与房间的传输、渲染、事件 |
| `src/lib/partyLogic.ts` | 成员/队伍/roll 的**纯状态变换**，不碰 DOM 也不碰 WebRTC |
| `scripts/partyLogic.check.ts` | 上面那一层的自检（队伍重排是最容易写错的部分） |
| `scripts/steamId.check.ts` | 手填 Steam ID 的解析自检（错一位就查到别人头上） |
| `scripts/lobbyRoom.check.ts` | 大厅房间进出时序的自检（见下面「大厅只加入一次」） |
| `scripts/partyVisibility.check.ts` | 静态可见性自检：标记里不许有脚本摘不掉的隐藏手法 |
| `scripts/partyDrag.check.ts` | 拖拽归队的自检：拖拽写错全是静默失效，见下文「归队有两条路」 |

**显隐一律走 `setVisible()`**（同时摘 `hidden` 属性、写内联 `display`）。标记里
**不要**用 `hidden` 属性或独立的 `hidden` 类来藏要切换的元素：Tailwind v4 的 preflight 是
`[hidden] { display: none !important }`，`hidden` 类也在 utility 层，两者都会让元素
**永远露不出来**——房间区、提示条、Steam ID 折叠块都这么栽过一次，症状是「页面上什么都没有，
也不报错」。最后那条自检就是为了挡住这一类。

纯逻辑单独抽出来的理由很实际：分队规则里有几个必须收敛的分支（每队上限调小时超员的人
去哪、房主手动加的队会不会被自动分队顺手删掉、最后一个队能不能删），脱离浏览器才验得动：

```sh
pnpm check   # 队伍逻辑 + Steam ID 解析，纯 node，不需要浏览器
```

### 「我是谁」的三种来源

| 来源 | 拿到什么 | 能不能证明身份 |
| --- | --- | --- |
| Steam 登录（OpenID） | 昵称 + 头像，由服务端回 Steam 反查后写进签名 Cookie | **能**，这是唯一可信的来源 |
| 手填 Steam ID | 昵称 + 头像，`/api/steam/profile` 转成 accountId 后向 STRATZ 查 | **不能**，谁都能查任意账号 |
| 什么都不填 | 自己打的昵称 + 首字母头像 | 不能 |

手填那条路由是**公网可调用**的：每次未命中都会消耗一次 STRATZ 额度，所以只取了
`steamAccount { name avatar }` 两个字段（不去拉 `loadPlayerProfile` 那份带 60 个英雄的
大查询）、结果缓存 6 小时，并且复用了 `gql()` 里的串行限速。没配 `STRATZ_TOKEN` 时
这条功能返回 503 并提示直接填昵称，不是报错。

解析支持 SteamID64、账号 id（Steam 好友码就是它）、`STEAM_X:Y:Z`、`[U:1:Z]` 与
`/profiles/<id>` 链接；**`/id/<自定义短名>` 不支持**——换算它要 Steam Web API Key，
而本站登录只用 OpenID，为一个头像再引入一个密钥不划算。

### 协议与谁说了算

- **房主是唯一权威。** 成员、队伍、roll 结果都在房主的 `state` 里，其他人只发指令
  （`cmd`）、只渲染收到的快照。所以没有冲突合并，也不需要 CRDT；「房主分配人员」的结果
  对所有人一定一致。`rev` 单调递增，用来丢弃迟到的旧快照。
- **房间密码就是信令密钥。** Trystero 用 `password` 派生 AES-GCM 密钥去加密 SDP，还额外做
  一次 challenge——密码不对的人在信令层就建不起连接。这比前端 `if (pwd === input)` 实在，
  失败会走 `onJoinError`，页面据此区分「密码错」和「网络打不通」。
- **大厅只加入一次，角色只是「播不播报」。** 所有人以同一个配置进大厅房间，房主用它广播
  自己的房间（15 秒一次，45 秒没重播就从列表里消失），访客只收。这条是被两个坑逼出来的：
  1. 早先让访客用 `passive: true` 加入（想把大厅做成星形、避免 N 个访客互建
     N×(N-1)/2 条连接），但**休眠的被动房间根本不广播**——Trystero 的 `queueAnnounce`
     里没进活跃状态就直接 return。结果是访客要等房主下一次播报才发现房间，最多干等 15 秒；
  2. `passive` 是 `joinRoom` 的**配置**，而角色会来回切（建房、离开房间），每次切都得
     `leave()` + 重进同一个 roomId。偏偏 `joinRoom` 对同一组 `(appId, roomId)` 是**幂等**
     的，`leave()` 又是异步的（先发告别消息、之后才删内部登记），于是重进拿到的是**正在退出
     的旧实例**，连 `passive` 配置都是旧的：房主以为自己在广播，手里却是个已退出的被动房间，
     而两个被动方永远不建连。症状就是客人那边「大厅当前没有房间」，**且没有任何报错**。
     这个行为在 `scripts/lobbyRoom.check.ts` 里有离线断言（不连中继也能跑）。
  配置不再随角色变化，第 2 类问题就不可能发生；加入时的初始播报是连发几次的（Trystero 的
  startup burst），所以新来的人一两秒内就能看到房间。
- **「先验证密码」是真的连一次，不是本地比对。** 密码就是信令的加密密钥，Trystero 没有
  「只验一下密码」的接口，所以加入房间时**不切界面**：等房主把房间快照发过来才算验证通过，
  在此之前一直留在「加入房间」那张卡上，错了就把原因写在卡片下面。密码错时 joiner 会在
  一两秒内收到 `incorrect room password when decrypting offer`，超时（12 秒）则按
  「密码/房间码抄错、房主不在、或网络不通」处理。顺带把 `leaveRoom` 改成 `await` 房间的
  `leave()`——验证失败后重试要立刻重进同一个 roomId，不等旧实例退完就会拿到它。
- **状态条上写「连上了几个人」。** 房间列表、聊天、分队全都建立在「P2P 真的连上了」之上，
  而连不上时页面上什么都不会发生、也不报错。所以顶部把「大厅已连 N 人 / 大厅可见」摆出来，
  用来分清「没人开房」和「我根本没连上」。
- **房主刷新页面不会散场。** 刷新时页面会向大厅发一条「房间没了」，同时用 sessionStorage
  里的记录按原样重建（同码、同名、同密码）；成员那边先显示「房主掉线了」并给 20 秒窗口，
  收到新房主的快照就当作他回来了。这条路径必须留着，因为 Trystero 的 `selfId` **每次加载
  都重新生成**，房主回来时 peer id 已经变了。
- **房间不落库。** 聊天只在内存里，`CHAT_KEEP` 条封顶；房主关页面房间就结束。

### 连不上的几种情况

WebRTC 的失败在浏览器里长得一模一样——都是「房间里没人」，所以页面上必须分别说清楚：

| 现象 | 原因 | 页面上的提示 |
| --- | --- | --- |
| 一直连不上信令 | 公共 Nostr 中继被墙（默认从 28 个里按 appId 洗牌取 10 个，见 `RELAY_REDUNDANCY`） | 顶部状态条的绿点不变绿 |
| 进房后没人 | 密码不对，或双方 NAT 都不允许直连 | 分别提示「密码不对」与「换网络再试」 |
| 只有某个人看不到 | 你和这一个人之间的 NAT 打不通（其他人的连接是好的） | 「其他人的消息不受影响」 |

控制台里出现几行 `WebSocket connection to 'wss://…' failed` 属于**正常**：默认的 28 个公共
中继里总有几个在本地网络打不通（`nos.lol` 就是常客），浏览器会为每个失败的连接各记一行，
脚本拦不掉——那是浏览器自己在报网络错误。有用的是**连上了几个**，看顶部状态条；一个都连不上
时它才会显示成「正在连接信令中继…」并附带建议。Trystero 自己那层中继告警已经关掉
（`relayConfig.warnOnRelayFailure: false`），免得多刷一遍。

**默认没有 TURN。** Trystero 只带 Cloudflare 的 STUN（`stun:stun.cloudflare.com:3478`）。
同一个 WiFi 下的两个人通常没问题；国内手机 4G/5G 大量是对称 NAT，双方都对称时**必然**
连不上，只能靠 TURN 中转。要彻底解决就在自己的 VPS 上跑一个 coturn，然后：

1. 把地址填进 `src/scripts/partyRoom.ts` 的 `CUSTOM_RELAYS`（自建 `@trystero-p2p/ws-relay`
   或几个本地可达的 Nostr 中继）——**填了之后 `RELAY_REDUNDANCY` 会被忽略**；
2. TURN 通过 `joinRoom` 的 `turnConfig` 传入，目前没有配置项，需要时在那里加。

TURN 只是中转字节，数据仍然是端到端加密的；它不解密、也没有业务逻辑。

### 一个 Vite 的坑：`trystero` 必须写进 `optimizeDeps.include`

它只被 `/party` 的页面脚本 import，而 Astro 启动时的依赖扫描**没有**把它收进
`node_modules/.vite/deps`（那份 `_metadata.json` 里只有 dev-toolbar 的几个包）。于是 Vite
每次都在请求到达时按需发现它：生成一个新的 `?v=` 哈希、把模块改写成指向新哈希，预构建
产物却没落盘——页面反复吃 `504 Outdated Optimize Dep`，而且**每刷一次哈希就换一个**
（实测连着见过三个）。`astro.config.mjs` 里已显式列进 `include`，哈希就稳定了。
**以后再有「只被某个页面脚本 import」的依赖，同样要加到这里。**

### 已知的取舍

- **昵称是自报的。** 登录 Steam 的人由 `/api/me` 给出昵称和头像，但它在 P2P 里无法被他人
  验证——知道房间密码的人可以自称任何名字。要堵住得让服务端签发一张可离线验签的票据
  （Ed25519 + 公钥打包进静态产物），目前没做，开黑场景够用。
- **房间不设人数上限。** 真正的上限是浏览器和网络：P2P 全网状，N 个人 N×(N-1)/2 条连接，
  十几个人就开始明显变慢。在应用层卡一个数字只会挡自己人（开黑本来就要 5v5 往上），
  要加回来就在 `upsertMember` 里判断。
- **队伍分配区有两种全屏，是两件事**（工具栏上两个按钮）：**浏览器全屏**走 Fullscreen API，
  浏览器收起地址栏与标签页，和 F11 一样；**网页全屏**是纯 CSS 固定定位，在当前页面里把这块
  盖满视口，浏览器界面照旧（它同时锁住 body 滚动，否则滚轮会穿透到后面的页面）。两者互斥。
  都不做「另开一个页面」——房间状态在房主内存里、成员各自在浏览器里，另开页面就得再同步
  一份状态，还要处理哪个窗口说了算。不支持元素级全屏的浏览器（如 iPad Safari）上，
  浏览器全屏自动退回网页全屏。
- **大厅也是全网状。** 因为大厅只加入一次、配置不随角色变化（见上一节的第 2 条坑），
  所有人都是活跃身份，N 个人在线就两两建连。几十人以内没问题；真要更多，得回到 `passive`
  方案，并同时解决「被动房间不广播、新访客得等下一次播报」那个问题（给房主更短的播报间隔，
  或另开一条只做列表的信令通道）。
- **归队有两条路，权限一样。** 每张成员卡左边有个 ⋮⋮ 手柄，鼠标用户可以把它拖到任意队伍卡片上
  （拖回空闲池就是退队）；右边仍然保留下拉框，因为**拖拽在触屏和键盘上都没有等价操作**，而下拉
  天然三端可用（同「分屏直播」里「拖拽必须有等价操作」的结论）。两条路都走 `moveMemberTo()`，
  房主能挪任何人、其他人只能挪自己。`draggable` 只挂在那两个点上、不挂整张卡——卡里嵌着那个
  `<select>`，祖先带 `draggable` 之后它在部分浏览器里点不动。几个静默坑（`dragover` 不
  `preventDefault` 就永远不触发 `drop`、Firefox 不 `setData` 就不开始拖、重建队伍区必须
  `clearDrag()`）都固化在 `scripts/partyDrag.check.ts` 里。
- **`/party` 的客户端包约 30 KB（gzip）**，因为打进了 Trystero 与 Nostr 客户端。它只在这个
  页面上加载，不影响内容页。

## 部署与重建频率

内容页都是构建期抓取 + 预渲染，所以**内容的新鲜度 = 你多久重建一次**。`.cache/` 的 TTL
表（直播状态 5 分钟、新闻/社区/赛程 30 分钟、Reddit 1 小时…）决定的是「这一轮要重新抓
哪些」，它需要一个触发者——而仓库里**没有任何 CI 或定时配置**，这件事得自己接上。

没有触发者的后果很具体：直播状态标称 5 分钟，实际是「上次构建那一刻」，可能已经过去几天。

实测同一个 `.cache/` 上连续构建：

| | 耗时 | 联网抓取 |
| --- | --- | --- |
| 冷构建（`.cache/` 为空） | ~1 分钟 | 全部来源 |
| 热构建（TTL 内） | **4.4 秒** | 0 次 |

建议 **5 分钟一次**，正好对齐最短的那个 TTL。每轮只有到期的源会重抓：直播状态每轮都过期
（11 个房间），新闻/社区/赛程每 6 轮一次，其余按自己的 TTL 轮流——单轮 5～20 秒。

### 不能就地重建

这是加了 `@astrojs/node` 之后**才出现**的新约束，实测过两件事：

1. 服务进程是**按请求从磁盘读** `dist/client` 的。就地重建会让旧的哈希资源
   （`_astro/Layout.BQUakPPC.css`）立刻消失，而页面 HTML 仍引用着它——实测取该资源当场
   变 404，页面直接掉样式。
2. 进程启动时就把 `dist/server` 的模块 import 进内存了。就地重建后**服务端跑的还是旧代码**，
   客户端却换成了新资源。「旧服务端 + 新客户端」比单纯 404 更难查。

所以必须**构建到暂存目录、成功后再切换、最后重启进程**。`scripts/rebuild.sh` 就是干这个的：

```sh
# 构建 + 切换，之后自己重启
pnpm rebuild

# 或者让脚本代劳重启
RESTART_CMD='systemctl restart dota2-news' pnpm rebuild
```

脚本只在**构建成功且产物完整**时才切换（`server/entry.mjs` 与 `client/` 都在），构建失败
则线上原样不动——这两条都实测验证过。上一版留在 `dist-prev/`，回滚就是
`mv dist-prev dist && 重启`。

### 接定时任务

```cron
# 每 5 分钟重建一次
*/5 * * * * cd /srv/dota2-news && RESTART_CMD='systemctl restart dota2-news' pnpm rebuild >> /var/log/dota2-news-rebuild.log 2>&1
```

用 systemd timer 的话，配一个每 5 分钟跑 `pnpm rebuild` 的 oneshot service 即可
（`RESTART_CMD` 直接写在自己的 restart 命令上）。

两点注意：

- **切换后必须重启**，否则新产物不会生效（服务进程持有旧代码）。重启有几秒中断；要零停机
  得跑两个实例、前面挂个反代逐个切。
- **前面挂了 CDN 的话，重建后要刷 HTML 的缓存**。带内容哈希的 `_astro/*` 不用管，
  但页面 HTML 是拿去就缓存的，不刷的话用户还是看到旧页面——也就还是旧状态。

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

### 房间号：斗鱼的「靓号」不能喂给接口

斗鱼用房间页自己加载的 `https://www.douyu.com/betard/{id}`（npm 上的 `douyu-api` 包里的
`live.getRoomInfo` 就是这一行 `axios.get`，没有别的门道）。两个坑：

**一、靓号只是别名。** 82088 是 820 的靓号：`www.douyu.com/82088` 与 `www.douyu.com/507882`
的 `<title>` 一字不差，但 betard/82088 返回的是「您观看的房间已被关闭」提示页，betard/507882
才是真正的房间 JSON。曾据此把正在直播的 820 误报成「房间已关闭」。所以 `ob.ts` 里存的是平台
接口认的规范房间号，不是靓号。

**二、别用 `open.douyucdn.cn/api/RoomApi/room/{id}`。** 它看起来是"官方开放接口"，但返回的是
十几年前的僵尸记录——820 的旧房间返回 `start_time: 2014-10-27`、房主「用户已注销」、分区
「英雄联盟」。现在整条链路都不碰它。

字段上也别照抄 `douyu-api` 的文档：它把 `room.status` 注释成「1 是正在直播」，但实测开播和
未开播的房间 `status` 都是 `'1'`；真正的开播标志是 `show_status`（1 开播 / 2 未开播），而
`videoLoop=1` 表示房间在放录像轮播、主播本人并不在播（对应虎牙的 `liveStatus=REPLAY`）。
两者合成 `live` / `replay`。

（顺带一提，给 `r.jina.ai` 带浏览器 `User-Agent` 会触发它的 Cloudflare 验证，必须不带。）

房间号会随主播转平台或换房间而变化，因此每个成员都带 `ownerMatch`：构建期用平台返回的房主昵称
核对，对不上只把昵称原样标出来（可能只是改名），**不下"房间换人"的结论**。主接口失败时退一步只读
房间页标题，用来说明这个房间号现在显示的是谁，状态仍标未知。任何情况下都不写死假的「正在直播」。

开播状态分五种：`live` / `replay` / `offline` / `closed` / `unknown`。其中 `closed` 是平台自己
给的状态——斗鱼关掉某个房间的播放时，房间数据接口返回的是一张 HTML 提示页
（「您观看的房间已被关闭」）而不是 JSON，房间页本身还在。它和「未开播」不是一回事：未开播是房间
还在、只是没播；closed 是平台把播放关掉了（喂了靓号或废弃房间号时最容易撞上它）。

还有一个坑：Astro 会并行开多个渲染进程，每个进程各自跑一遍 `liveApi`（模块级单飞只在进程内生效），
于是可能出现"这个进程抓失败了、另一个进程刚抓到并写了缓存"。所以抓取失败后还会等一下重读缓存
（`waitForPeerCache`），否则同一个房间在不同进程渲染出的页面里会一个显示直播中、一个显示状态未知。

### 分屏直播页：嵌入结论与房间列表

`src/pages/live.astro` + `src/scripts/liveWall.ts` 是左侧房间列表、右侧监控室的分屏页。
列表与墙面都由浏览器渲染（`items.astro` / `heroes.astro` 也是这个路子），排布和自建房间存在
`localStorage` 的 `dota2-live-wall/v1` 里。

**能不能把别人的直播间嵌进自己页面？** 构建期查过，结论是"能嵌，但平台随时可能变"：

- 斗鱼房间页**没有** `X-Frame-Options`，虎牙的 CSP 里**没有** `frame-ancestors`。
  用 `api.hackertarget.com/httpheaders` 查的（先用 bing / github / MDN 三个已知会发
  `X-Frame-Options` 的站点验证过这个工具确实会报，baidu / 斗鱼不报就是真没有）。
- 两家的页面内联脚本、抽查的 JS chunk 里都没有 `top.location` / `frameElement` 这类防嵌代码。
- 但**这些都不等于一定出画面**：还可能撞上登录要求、风控验证（斗鱼响应头里有 `X-Px`，
  即 PerimeterX）、以及浏览器对第三方 Cookie 的分区。所以每格都固定留了「打开直播间」外链，
  空白时直接跳官方页。

本机 `curl` 到 `douyu.com` / `huya.com` 的 TLS 握手仍被重置（`SSL_ERROR_SYSCALL`），但**嵌入已经
端到端验证过了**：headless Chrome 能拿到 `https://www.douyu.com/9999`（`200 text/html`，标题就是
YYF 的房间），放进 iframe 后页面照常渲染、视频真的在播——平台**没有**拦嵌入。拦的话 Chrome 报的是
`ERR_BLOCKED_BY_RESPONSE`，而不是把内容画出来。

**B站 是反例，它拦。** `live.bilibili.com` 的响应头带 `X-Frame-Options: SAMEORIGIN`，
iframe 里的文档请求直接被拒（同样是 `net::ERR_BLOCKED_BY_RESPONSE`）。所以手动添加虽然认 B站 链接，
但那个格子只会是黑的，页面上写明了。

### 分屏页的「只显示画面」

每格嵌的是平台**整个直播间页面**，导航、弹幕、礼物、推荐位都在里面，画面自然小。iframe 跨域，
父页面碰不到里面的 DOM，所以唯一的办法是把 iframe 放大再错位（`transform: scale() translate()`），
让播放器正好落在格子里，外层 `overflow: hidden` 裁掉其余部分。两家都没有官方嵌入播放器
（查过开放平台，没有），要真正"只取流"必须自建后端解流，不在静态站的能力范围内。

定位靠 **URL 片段锚点**：斗鱼 `#js-player-video`、虎牙 `#J_playerMain`。两个坑都是实测踩出来的：

- **锚点必须"加载完再补"，不能只写在初次导航的地址里。** 两家都是客户端渲染，播放器容器出现在
  浏览器的片段滚动**之后**，滚不滚全看运气——同一平台 `9999` 滚到了（scrollY=1379），
  `88660` 完全没滚（scrollY=1），页面上露出一条房间信息条。
- **只能补一次。** 斗鱼是 Next.js，每次 hash 变化都会走一次路由转场；反复补会让它不停"跳过转场"，
  最后把播放器整个刷没（补三次实测两格全黑 + 252 条 `AbortError: Transition was skipped`）。
  另外记一条浏览器行为：加片段、换片段是同文档导航、不重新加载，但**去掉**片段会让 iframe 整页重载
  （本地页面数 `load` 次数验证过）。

补锚点后的实测值（1280×720 视口冷启动）：斗鱼 `(32, 0) 813×457`、虎牙 `(90, 60) 785×442`
（虎牙页头是 `fixed`，吸顶占 60px）。**广告是后到的**，个别房间仍会偏——实测同一平台一间正好、
一间偏 180px，所以每格左下角有一组上下微调＋复位，**按房间 key 存在 `localStorage`**。
取景时 iframe 的逻辑视口固定 1280×720，格子的缩放用 `ResizeObserver` 跟着重算（换格数、进全屏都不会错位）。

注：`loading="lazy"` 的 iframe 在窄屏下是有意义的——那里墙面排在长长的房间列表下面，滚到跟前才开始加载。
iframe 只带 `allow="… fullscreen …"`，不再叠 `allowfullscreen`：Chrome 会为两者并存报一条
"Allow attribute will take precedence" 警告。

### 分屏页的格子尺寸

墙面默认等分（原来就是这样），列宽行高可以拖格子之间的**分隔条**改：`liveWall.ts` 的 `applyTracks()`
把比例写成内联的 `grid-template-*`，`drawSplitters()` 在 gap 里放浮层按钮。几条踩过的坑：

- **排列必须从 Tailwind 类名搬进 JS。** 内联样式盖掉媒体查询，继续用 `sm:grid-cols-2`
  会出现"窄屏还是三列"。现在断点判断在 `arrangement()` 里，取值与原来那套类名一一对应。
- **列宽用 fr，行高看情况。** 非全屏时墙面高度是内容撑出来的，`grid-template-rows` 写 fr 会被当成
  auto——实测行高塌成 56px，所以按「等分行高 × 行数」折成 px；比例都是 1 时与原来的 `aspect-video`
  完全一致（16:9）。全屏时面板 fixed 铺满视口，高度确定，才用 fr 跟着视口长。
- **分隔条元素要复用，不能每次重建。** `setPointerCapture` 打在元素上，元素一被换掉捕获就没了，
  拖到一半会断。拖动必须用指针捕获：横穿 iframe 时父页面收不到 `pointermove`。
- **`#wall` 外面包了一层 `#wall-box`**（浮层要有定位祖先），全屏撑高的 flex 项因此变成了那一层，
  `.wall-immersive #wall { flex: 1 }` 得改成给 `#wall-box`，否则全屏后行高只剩几十像素。
- 比例按格数分别存（`ratios: { "4": { c, r } }`），换了断点列数对不上就按比例重采样；
  「均分」按钮删掉当前格数那一份。方向键与拖动等价，分隔条是 `role="separator"`。

**房间列表**由 `src/lib/roomList.ts` 在构建期抓，两个来源都是平台给分区页用的那份数据：

- 斗鱼 `https://www.douyu.com/g_DOTA2`：房间列表以 JSON 内嵌在 HTML 里
  （`{"cateInfo":…,"list":[{"authInfo":…,"rid":9999,"nn":"yyfyyf","ol":3612801,…}]}`）。
  所以必须按**原始 HTML** 取——本机直连被重置时走代理，就得给 `r.jina.ai` 带
  `x-respond-with: html`，否则它会把页面转成 markdown，那段 JSON 就没了。
  页面里写的 `pagePath: /gapi/rknc/directory/mixListV1/2_3/` 直接请求是 **404**，别去试。
  房间对象都以 `{"authInfo"` 开头，按它切块后在块内取字段，比整段正则安全。
- 虎牙 `https://www.huya.com/cache.php?m=LiveList&do=getLiveListByPage&gameId=7`。
  `gameId=7` 是 DOTA2（从 `m=Game&do=getGameList` 里查的：1 是英雄联盟、6 是 DOTA1）。
  **房间号要取 `profileRoom`**：列表里的 `privateHost` 是 `longdd` 这种靓号字符串，
  开播接口喂它会返回 422，只有 `profileRoom`（LongDD 是 678555）才认。

热度值两家口径不同（斗鱼 `ol`、虎牙 `totalCount`），**不可横向比较**，所以页面上只用它做
同平台内的提示，不做跨平台排序。热门榜本身只列当前开播的房间，因此这些房间一律标「榜单」
而不是标绿点——绿点只给有构建期开播状态的 OB 成员，避免把榜单快照包装成实时状态。

抓取层（直连优先、失败退回代理、重试、`extractJson`）抽在 `src/lib/fetchText.ts`，
`liveApi` 与 `roomList` 共用。

### 社区热帖：来源与口径

社区页（`src/pages/community.astro`）有**两个**来源，聚合在 `src/lib/communityFeed.ts`：
NGA 走 `src/lib/ngaApi.ts`（APP 接口免鉴权返回 JSON），虎扑走 `src/lib/hupuApi.ts`
（`bbs.hupu.com/dota2` 直连就是服务端渲染好的 HTML）。页面按「来源 + 时间」两个维度筛选，
两个维度都在 `data-*` 属性上，客户端只切 `hidden`，计数按来源预埋在时间页签的 `data-counts` 里。

**回复数不可跨来源比较，所以不做归一化。** NGA 的 `replies` 来自它的热榜接口，是**所选时间窗内**
的回复数；虎扑列表给的是**帖子总回复数**。两套口径没法换算，`communityFeed` 只保证"按回复数倒序"
这一个排序规则，切到单个来源时才可比。同理，虎扑没有窗口参数，它的时间窗只能按
**最后回复时间落在窗口内**归属（近似，只用来筛掉太久没人理的帖子）。这些都写在了页面上。

**虎扑的取舍**（都是实测出来的）：

- 列表取默认的「最新回复」页（49 条），按 `回复数 >= 5` 过滤后取前 20 条，与 NGA 的「每窗 15 条」对齐；
  列表给的是 `回复 / 浏览`（`post-datum`）、作者、`MM-DD HH:mm`。
- **时间没有年份**，按 **UTC+8** 显式解析：虎扑是北京时间，构建机时区不定，用本地时区解会让
  `lastReplyAt` 随构建设备漂移；解出来比"现在"晚，就退回上一年。
- 摘要与详情走**同一次请求**：帖子页是 Next.js，`<script id="__NEXT_DATA__">` 里有一份完整的
  JSON（主楼正文 HTML、亮数、推荐数、浏览数、创建时间、50 条亮评、第一页 20 条回复）。
  比抠渲染后的 DOM 稳得多——页面上的 class 名带哈希后缀（`post-content_bbs-post-content__cy7vN`），
  正则随时会失效；结构真变了还有一条兜底：从 `<div class="thread-content-detail">` 里救回主楼正文。
  列表缓存 30 分钟、详情 2 小时（键带版本号 `hupu-thread-v2-`，解析规则一变就要换），一轮构建约 21 次请求。
- **两个来源都有站内详情页**：虎扑走 `/community/hupu/[pid]`（`src/pages/community/hupu/[pid].astro`），
  镜像主楼正文、亮评（前 10）与第一页回复（10 条，和亮评去重），其余留给原帖外链。
  正文是 HTML 不是 BBCode，所以走 `sanitizeHupuHtml`（去脚本与事件属性、相对地址按 `bbs.hupu.com` 补全），
  样式与 NGA 的 `.nga-post` 共用（`.hupu-post`）。
- 亮评在接口里**不是按键排序的**（实测 1047 / 468 / 523…），站内自己按亮数重排。
- 虎扑**没有楼层号**（接口不返回），所以站内只按时间顺序展示，不编 `#N 楼`。

**微博与贴吧为什么不在**（都试过，不是解析问题，是取不到数据）：

- 微博：`weibo.com/ajax/side/hotSearch` → 403，`s.weibo.com/weibo?q=DOTA2` → 302，
  移动端 `m.weibo.cn/api/container/getIndex?...` → 302；走 `r.jina.ai` 拿到的是
  「Sina Visitor System」。所有内容接口都要登录态（`SUB` cookie 或开放平台 OAuth）。
- 贴吧：直连 `tieba.baidu.com/f?kw=dota2` → 403，走 `r.jina.ai` 拿到的是「百度安全验证」；
  想用 RSSHub 绕，公共实例 `rsshub.app` 又被 Cloudflare 403 挡住。

取不到就不做，也不拿别的站的内容顶替——这两家只有拿到可用凭证（cookie / 开放平台 key）才谈得上接入。

### 头像与封面：取回来自已发

`src/lib/localImages.ts` 是公共流程，`src/lib/avatars.ts` 与 `src/lib/covers.ts` 只描述各自的
频道（目录、尺寸、体积上限、并发）。页面里引用的永远是 `/avatars/xxx.jpg`、`/covers/xxx.jpg`。

**为什么不直接热链**，按重要性排：

1. **本机到这些 CDN 的连接会被重置。** `curl https://i0.hdslb.com/...` 连 TLS 握手都过不去——
   ClientHello 发出去就是 `Connection reset by peer`（同一个 IP 换个 SNI 却能拿到正常的 TLS
   `handshake failure` 告警，说明是认名字的拦截，不是 IP 不可达）。斗鱼的 `douyucdn`、虎牙的
   `huyaimg` 也一样。直链交出去，图出不出得来就取决于访客走的那条线路。B站封面正是这么翻车的：
   同一批 30 张，连着三次加载分别挂 20、7、16 张，访客看到的就是「刚打开一排破图，刷几次又慢慢出来」。
2. 虎牙给的是 `http://huyaimg.msstatic.com/...`，站点一旦走 HTTPS 就是混合内容；
3. 允不允许外链由平台随时决定，判不判 Referer 我们控制不了，失败就是一排破图；
4. 热链等于把访客的 IP 送给平台 CDN。

所以构建期把字节取回来。**两条腿走路**：直连优先，被重置时退回 `wsrv.nl` 图片代理。裁切与缩放
只发生在代理那一支（`w` / `h` / `fit=cover`）：直连拿到的字节是**原样落盘**的，尺寸由对方决定，
超出频道上限（封面 1MB）才丢弃——所以「统一到 800×450」只对走代理的那些成立。两家头像原图一个
200×200、一个 140×140，封面原图实测 4KB ~ 187KB 不等。`LIVE_PROXY` 同样管这里：`off` 只直连，
`jina` 只走代理——jina 只能转文本，对图片来说就是纯代理。

落盘与发布：

- 文件名是 `键-地址哈希.jpg`。头像的键是 `平台-房间号`，封面是 BV 号；地址一变就换文件，
  不会串图，调用方也不用跟着改查询方式。
- 字节进 `.cache/<dir>/`，构建结束由 `astro.config.mjs` 把**本轮用到过**的拷进 `dist/<dir>/`
  （用到的文件会刷新 mtime，拷贝时以此判断），30 天没用到的从缓存里删掉。
- **拿不到就降级，不出现破图**：房间头像不进返回值、页面不渲染 `<img>`，显示品牌渐变底 + 首字母
  （头像是用背景图画的）；封面不进返回值，卡片退回热链原图——和改造前一样，不会更差。
- **dev 也要能看到**：`astro dev` 不跑构建，`dist/<dir>/` 根本不存在，页面里引用的
  `/avatars/xxx.jpg`、`/covers/xxx.jpg` 会整片 404——一度被当成「头像没抓到」。所以
  `astro.config.mjs` 里另有一段 `images-in-dev` 中间件，dev 下直接从 `.cache/<dir>/` 读
  （只认自己生成的文件名，`path.basename` 挡掉路径穿越）。改完 `astro.config.mjs` 要重启
  dev server 才生效，不过 Astro 检测到配置变化一般会自己重启。

**头像没有额外请求元数据**——地址本来就跟着房间数据一起取回来了：

| 用途 | 来源字段 |
| --- | --- |
| OB 成员（斗鱼） | `betard` 的 `room.avatar.middle`（另有 `owner_avatar` 与 `big` 相同） |
| OB 成员（虎牙） | `mp.huya.com` 的 `data.profileInfo.avatar180` |
| 热门榜（斗鱼） | 分区页内嵌 JSON 的 `av` |
| 热门榜（虎牙） | 榜单接口的 `avatar180` |

- 斗鱼 `isDefaultAvatar=1` 时**不取**：那是平台的系统默认图，不如页面自己的首字母占位。
- 封面尺寸取 800×450：专题墙在 1280px 容器里三列，一格约 397px，2x 屏就是 794。
  成员卡里的缩略图只有 112px、会多下一点字节，但它们本来热链的就是原图，算下来仍然更省。

> 给 `RoomRef` 加字段必须同时把 `roomList.ts` 里的 `CACHE_VERSION` 加一。缓存存的是**解析后**的
> 对象，老缓存不会自己长出字段：加头像那次就没加版本，结果 64 个热门房间一个头像都没有，
> 而构建汇总还写着「使用缓存」，看上去像抓取失败，其实是拿了一份旧形状的数据。

**还有哪些图没落地。** 站点里仍有大量外链图（`img.dota2.com.cn` 1287 张、`liquipedia.net` 993 张，
以及社区正文里的图），它们量级大、多数来自第三方正文，没有跟着一起本地化。已知会挂的两处：

- **虎扑正文图**：一度记为「全 403，因为 `sanitizeHupuHtml()` 没补 `referrerpolicy`」——这个结论
  是错的，别再照它去改。详情页有**文档级**的 `<meta name="referrer" content="no-referrer">`
  （`src/pages/community/hupu/[pid].astro`，构建产物里确认过它在 `<head>` 里），正文的 `<img>`
  因此根本不带 Referer。实测同一个 `i11.hoopchina.com.cn` 地址：`curl` 不带 Referer 得
  `200 image/webp`，带站外 Referer 得 `403 text/plain`——拒的是 Referer，不是缺 `referrerpolicy`。
  真再看到 403，先在浏览器 Network 里确认请求头里到底有没有 Referer，别顺手去升
  `hupu-thread-v2-` 缓存键（那次改动没动到 `sanitizeHupuHtml()`，升了也没用）。
- **Reddit 缩略图**：`i.redd.it` 和 `i*.hdslb.com` 一样会被重置，`/news/reddit/[id]` 的图因此经常不出。

**两种全屏是并列的**，都在右侧工具栏里，共用一套沉浸样式：

- 「网页全屏」只把面板抽成 `position: fixed; inset: 0` 铺满浏览器窗口，并用 `body` 上的
  `.wall-immersive-lock` 锁住底下的滚动；Esc 退出（系统全屏时按 Esc 归浏览器管，
  所以监听里要先 `if (document.fullscreenElement) return`，否则会把两个全屏一起关掉）。
- 「浏览器全屏」走 `requestFullscreen()`，进的是系统全屏。状态只能从 `fullscreenchange` 事件里读，
  因为用户可能按 Esc 或 F11 退出；进系统全屏时「网页全屏」按钮会被禁掉——那时它已没有可见效果。
  这个接口缺失或被拒时退回网页全屏并提示，不让按钮点了没反应。
- 沉浸模式下**格子不再锁 16:9**，改成 `grid-rows-*` 平分视口高度（`IMMERSIVE_GRID_CLASS`），
  1440×900 下 4 格从 268px 长到 381px。切换全屏只改类名、**绝不重渲染**：`renderWall()`
  会重建 `innerHTML`，把已加载的 iframe 全部冲掉，那等于一全屏就把画面停了。
- 一个坑：`.wall-immersive` 必须写 `margin: 0`。父容器是 Tailwind 的 `space-y-4`，会给面板自己
  留下 1rem 上外边距，而 fixed 元素一旦带外边距，`inset: 0` 解出来的高度就会少掉那 1rem
  （实测 900 → 884），表现为全屏后底下空一条。

### 视频：只信 B站 自己的接口

`src/data/obVideos.ts` 是页面上的视频清单（23 支成员「名场面 / 人物志」+ 7 支剑雪封喉）。
它不是构建期抓的，而是**一次性核对后写死的静态数据**——视频是历史内容，不像开播状态那样会变，
没必要每次构建都去请求 B站。

核对方式是 B站的 `https://api.bilibili.com/x/web-interface/view?bvid={BV号}`：标题、时长、
播放量、投稿日期、封面地址全部取自这个接口的返回值，**不从搜索结果的转述里抄**。搜索页
（`search.bilibili.com`）只用来发现候选，逐条验证必须回到 view 接口。几个实测结论：

- 搜索页能直接访问，但要拿到结构化结果得走 `r.jina.ai`（和直播接口同一条回退路径）。
- `api.bilibili.com/x/space/arc/search`（按 UP 主列投稿）会返回 `-412` / `-799`：非登录态的
  数据中心 IP 基本被风控挡死。所以**没法按 UP 主拉全量列表**，只能靠关键词搜；「OB 人物志」
  这个系列就是这么找出来的。
- 封面地址同样取自 view 接口，但**不热链**：`i*.hdslb.com` 的连接会被间歇性重置（见
  「头像与封面：取回来自已发」），所以构建期由 `src/lib/covers.ts` 取回本地，页面引用
  `/covers/<BV号>-<哈希>.jpg`。只有拿不到字节的那几张才退回热链原图，那时仍带
  `referrerpolicy="no-referrer"`。卡片底下垫了 `bg-surface-3` 纯色，图挂了也不会塌成破图。
  本站不托管、不转码任何视频，只做外链。

**搬运 ≠ 原作者。** 这些经典老视频在 B站 大多是粉丝二次上传的（剑雪封喉 7 支里只有 1 支是他自己
频道发的），所以每张卡都必须把**实际投稿人**写出来，喉哥那一段还额外打了「喉哥本人 / 粉丝搬运」
的角标。别把搬运者的昵称当成原作者，也别把「播放量高」当成「权威」。

收录标准：优先成系列的人物回顾（如「OB 人物志」，共 6 集），其次是与某个具体梗直接对应的原始
对局（「7 分钟 3800」「给我幽鬼，不赢砍手」），再次是本人频道发的切片。**找不到可靠对应视频的
成员就不凑数**，不拿主题相近的视频硬套。

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
| `LIVE_PROXY` | 否 | 直播间接口、热门房间列表与图片本地化（头像、B站封面）的取数方式：`auto`（默认，直连优先、被重置时退回代理）、`jina`（只走代理）、`off`（只直连）。文本走 `r.jina.ai`，图片走 `wsrv.nl` |
| `IMAGE_DEBUG` | 否 | 图片本地化的调试开关（原名 `AVATAR_DEBUG`，拆出 `localImages.ts` 时一并改名）。设为 `1` 时构建日志里逐个频道打印「发布 N 张 / 新下载 N / 命中缓存 N / 拿不到 N」 |
| `TOURNAMENTS_OFFLINE` | 否 | 设为 `1` 时完全不联网，只用 `.cache/` 里的数据构建 |

## 赛事数据来自 Liquipedia

赛程与赛果取自 Liquipedia 的 [`Liquipedia:Matches`](https://liquipedia.net/dota2/Liquipedia:Matches)
（原来的超凡电竞接口已不再响应）。使用它需要遵守
[Liquipedia API 条款](https://liquipedia.net/api-terms-of-use)：带能识别调用方的 User-Agent、
控制请求频率、署名并回链。代码里只在一页上取一次数据（30 分钟缓存），
页面上也保留了到 Liquipedia 的链接——改动这块时请一并保留。

## 提交规范

见 `AGENTS.md`。
