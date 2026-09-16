# Steam 登录与个人战绩

用 Steam 账号登录后可以看自己的战绩：`/me` 是概况，下面还有比赛、英雄、队友与对手、
进展、分析五个子页；比赛列表里每一行都可以点进 `/me/matches/<对局号>` 看这一场的记分板。
数据来自 STRATZ 的 GraphQL 接口（公开比赛数据），**不需要 Steam Web
API Key**——登录只用到 OpenID，昵称和头像由 STRATZ 一并返回。

## 这几条路由是 SSR，其余仍是纯静态

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

要发布到 Cloudflare Workers，产物布局一样，只是最后这条换成 `wrangler deploy`——
见 [构建、缓存与部署](./deploy.md) 的「发布到 Cloudflare Workers」。

## 会话与登录安全

会话是**无状态签名 Cookie**（HMAC-SHA256），服务端不存 session，所以不需要数据库，
在 Serverless / Workers 上行为一致。有效期 30 天。

- `SESSION_SECRET` 没配置时一律拒绝签发与校验，**不会退回默认密钥**；
- 登录跳转带一次性 `state`（存 `d2s_login_state` Cookie），挡登录 CSRF；
- 回调必须回 Steam 反查 `check_authentication`，并校验 `op_endpoint`、`return_to`、
  `claimed_id` 形状——只看回调参数就发会话等于谁都能伪造登录；
- 昵称是用户可控输入，页头那段水合脚本用 `createElement` + `textContent` 拼 DOM，不用 `innerHTML`。

## 四个上游的坑

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

## 单场对局页：`/me/matches/[id]`

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

## 头像为什么必须带 `referrerpolicy="no-referrer"`

Steam 的头像 CDN（`avatars.steamstatic.com`）会拒掉带 Referer 的请求，不带这个属性页面上
就是一张破图。站内主播头像、比赛页的队标一直是这么处理的，个人战绩页的头像统一走
`src/components/player/Avatar.astro`：带 `no-referrer`，加载失败时摘掉 `<img>` 露出首字母，
不会出现破图图标。
