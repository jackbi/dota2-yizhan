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
| `.cache/roomlist/` | 斗鱼 / 虎牙 DOTA2 分区的热门房间列表 | 30 分钟 |
| `.cache/avatars/` | 主播头像的字节（构建结束拷进 `dist/avatars/`） | 永久，30 天没用到就清理 |
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

### 主播头像：取回来自已发

`src/lib/avatars.ts`。OB 页与分屏页的头像都由它落地，**没有额外请求元数据**——
头像地址本来就跟着房间数据一起取回来了：

| 用途 | 来源字段 |
| --- | --- |
| OB 成员（斗鱼） | `betard` 的 `room.avatar.middle`（另有 `owner_avatar` 与 `big` 相同） |
| OB 成员（虎牙） | `mp.huya.com` 的 `data.profileInfo.avatar180` |
| 热门榜（斗鱼） | 分区页内嵌 JSON 的 `av` |
| 热门榜（虎牙） | 榜单接口的 `avatar180` |

**不直接热链的原因**：虎牙给的是 `http://huyaimg.msstatic.com/...`，站点一旦走 HTTPS 就是
混合内容；允不允许外链由平台说了算（判不判 Referer 我们控制不了），失败就是一排破图；
而且热链等于把访客的 IP 送给平台 CDN。所以构建期把字节取回来，页面只引用 `/avatars/xxx.jpg`。

- 直连优先，被重置时退回 `wsrv.nl` 图片代理，顺便裁成正方并缩到 128px
  （两家原图一个是 200×200、一个是 140×140，体积也不一样）。`LIVE_PROXY` 同样管这里：
  `off` 只直连，`jina` 只走代理——jina 只能转文本，对图片来说就是纯代理。
- 文件名是 `平台-房间号-地址哈希.jpg`，地址一变就换文件，不会串图；字节进 `.cache/avatars/`，
  构建结束由 `astro.config.mjs` 把**本轮用到过**的拷进 `dist/avatars/`（用到的文件会刷新 mtime，
  拷贝时以此判断），30 天没用到的从缓存里删掉。
- 斗鱼 `isDefaultAvatar=1` 时**不取**：那是平台的系统默认图，不如页面自己的首字母占位。
- 拿不到头像的房间不渲染 `<img>`，页面显示品牌渐变底 + 首字母。头像是用**背景图**而不是
  `<img>` 画的，所以即使文件没发布也不会出现破图图标。
- **dev 也要能看到**：`astro dev` 不跑构建，`dist/avatars/` 根本不存在，页面里引用的
  `/avatars/xxx.jpg` 会整片 404——一度被当成"头像没抓到"。所以 `astro.config.mjs` 里另有一段
  `avatars-in-dev` 中间件，dev 下直接从 `.cache/avatars/` 读（只认自己生成的文件名，
  `path.basename` 挡掉路径穿越）。改完 `astro.config.mjs` 要重启 dev server 才生效，
  不过 Astro 检测到配置变化一般会自己重启。

> 给 `RoomRef` 加字段必须同时把 `roomList.ts` 里的 `CACHE_VERSION` 加一。缓存存的是**解析后**的
> 对象，老缓存不会自己长出字段：加头像那次就没加版本，结果 64 个热门房间一个头像都没有，
> 而构建汇总还写着「使用缓存」，看上去像抓取失败，其实是拿了一份旧形状的数据。

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
- 封面热链自 `i*.hdslb.com`，必须带 `referrerpolicy="no-referrer"`——带站外 Referer 会被拒。
  卡片底下垫了 `bg-surface-3` 纯色，图挂了也不会塌成破图。本站不托管、不转码任何视频，只做外链。

**搬运 ≠ 原作者。** 这些经典老视频在 B站 大多是粉丝二次上传的（剑雪封喉 7 支里只有 1 支是他自己
频道发的），所以每张卡都必须把**实际投稿人**写出来，喉哥那一段还额外打了「喉哥本人 / 粉丝搬运」
的角标。别把搬运者的昵称当成原作者，也别把「播放量高」当成「权威」。

收录标准：优先成系列的人物回顾（如「OB 人物志」，共 6 集），其次是与某个具体梗直接对应的原始
对局（「7 分钟 3800」「给我幽鬼，不赢砍手」），再次是本人频道发的切片。**找不到可靠对应视频的
成员就不凑数**，不拿主题相近的视频硬套。

## 环境变量

放在项目根目录的 `.env`（已 gitignore），dev 与 build 都会读取：

| 变量 | 必需 | 说明 |
| --- | --- | --- |
| `STRATZ_TOKEN` | 否 | [stratz.com/api](https://stratz.com/api) 生成。用于取 BP/选手明细与近一周英雄数据；缺失时自动回落到 OpenDota（更慢）或整块不展示 |
| `YOUDAO_COOKIE` | 否 | 覆盖有道翻译的默认访客 cookie |
| `AZURE_TRANSLATOR_KEY` / `AZURE_TRANSLATOR_REGION` | 否 | 配置后翻译改用 Azure，否则用有道 |
| `REDDIT_CLIENT_ID` / `REDDIT_CLIENT_SECRET` | 否 | 配置后 Reddit 走 OAuth，否则用 RSS（限流很紧） |
| `LIQUIPEDIA_CONTACT` | 建议 | Liquipedia 要求 User-Agent 里带联系方式，填邮箱即可；不填也能用，但不符合它的条款 |
| `LIVE_PROXY` | 否 | 直播间接口、热门房间列表与主播头像的取数方式：`auto`（默认，直连优先、被重置时退回代理）、`jina`（只走代理）、`off`（只直连）。文本走 `r.jina.ai`，图片走 `wsrv.nl` |
| `TOURNAMENTS_OFFLINE` | 否 | 设为 `1` 时完全不联网，只用 `.cache/` 里的数据构建 |

## 赛事数据来自 Liquipedia

赛程与赛果取自 Liquipedia 的 [`Liquipedia:Matches`](https://liquipedia.net/dota2/Liquipedia:Matches)
（原来的超凡电竞接口已不再响应）。使用它需要遵守
[Liquipedia API 条款](https://liquipedia.net/api-terms-of-use)：带能识别调用方的 User-Agent、
控制请求频率、署名并回链。代码里只在一页上取一次数据（30 分钟缓存），
页面上也保留了到 Liquipedia 的链接——改动这块时请一并保留。

## 提交规范

见 `AGENTS.md`。
