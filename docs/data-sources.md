# 数据来源

站点的内容全部来自公开上游，构建期抓取后落进 `.cache/`（缓存策略见
[构建、缓存与部署](./deploy.md)）。这篇记的是每个来源的取数方式、口径与实测结论。

## 社区热帖：来源与口径

资讯页（`src/pages/news.astro`）有**六条**来源页签：官网新闻、完美世界电竞、
Reddit 热帖（r/DotA2）、Reddit 赛事讨论（r/compDota2）、NGA 热帖、虎扑新帖
（条数以页面里 `SOURCES` 那份清单为准，别在这里写死一个数）。两个中文社区来源聚合在
`src/lib/communityFeed.ts`：NGA 走 `src/lib/ngaApi.ts`（APP 接口免鉴权返回 JSON），
虎扑走 `src/lib/hupuApi.ts`（`bbs.hupu.com/dota2` 直连就是服务端渲染好的 HTML）。
「社区」原本是独立一页（`/community`），并进资讯页之后那条路由只剩一个 301
（`astro.config.mjs` 的 `redirects`，落到 `#nga`）。

页签只按来源分，客户端切 `hidden`、一次只显示一条列表。这里**不提供时间窗筛选**，
也不把两个来源并成一条「社区热议」：两家的回复数不是一个口径（见下），合并排序等于拿两把尺子
量同一列，而 NGA 的内容又占了大头，并出来的那条跟 NGA 单来源看起来没差。NGA 那条列表仍是三个
时间窗的热帖合并去重（三个窗叠起来才是完整的 41 条），只是不再让读者自己挑窗口。

**两条列表各自保持来源自己的顺序，`communityFeed` 不合并、不重排。** NGA 那条是热榜
（按回复数倒序），虎扑那条是版面页的「最新回复」顺序（按时间）。两家的口径连"热"都不是一回事：
NGA 的 `replies` 来自它的热榜接口，虎扑给的是**帖子总回复数**，没法换算，也没法归一化。
页面上按来源分栏，各排各的，读者不会看到两种尺子混在一列里。

**虎扑的取舍**（都是实测出来的）：

- **列表跟着版面页的顺序走，取最前面的 20 条，不按回复数重排。** 版面页默认选中的是
  「最新回复」（另一个页签是「最新发布」），一条给 `回复 / 浏览`（`post-datum`）、作者、
  `MM-DD HH:mm`，顺序就是最新的在前（实测前 20 条的回复时间落在 0–6 天之间）。
  这里踩过一次坑、值得记着：原来先按 `回复数 >= 5` 过滤、再按回复数倒序取 20，等于把几天前的
  高回复长贴抬到最上面，新帖回复少、第一刀就被砍掉——选出来的 20 条里最新的一条也是 74 小时前，
  于是每轮构建这一栏都长一个样，看着像"数据没更新"。NGA 能按回复数排是因为它调的就是热榜接口。
  口径与解析现在放在 `src/lib/hupuBoard.ts`（纯函数），由 `scripts/hupuBoard.check.ts` 钉住。
- **时间没有年份**，按 **UTC+8** 显式解析：虎扑是北京时间，构建机时区不定，用本地时区解会让
  `lastReplyAt` 随构建设备漂移；解出来比"现在"晚，就退回上一年。
- 摘要与详情走**同一次请求**：帖子页是 Next.js，`<script id="__NEXT_DATA__">` 里有一份完整的
  JSON（主楼正文 HTML、亮数、推荐数、浏览数、创建时间、50 条亮评、第一页 20 条回复）。
  比抠渲染后的 DOM 稳得多——页面上的 class 名带哈希后缀（`post-content_bbs-post-content__cy7vN`），
  正则随时会失效；结构真变了还有一条兜底：从 `<div class="thread-content-detail">` 里救回主楼正文。
  列表缓存 30 分钟、详情 2 小时（键带版本号 `hupu-thread-v3-`，解析规则一变就要换）。
  列表改成时间序之后榜上换人更快，每轮要给新进来的帖子抓一次详情，一轮 20–40 次请求
  （改之前那批长贴稳定，是 21 次左右）。
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

## Reddit：两个版块，只走 `.rss`

`src/lib/redditApi.ts` 抓两个版块，在资讯页各占一栏：

| 版块 | 定位 | 实测活跃度 |
| --- | --- | --- |
| r/DotA2 | 总版热帖榜 | 约 30 条/天 |
| r/compDota2 | 职业比赛、阵容与转会讨论 | 约 1.5 条/天（25 条要往前翻半个多月） |

**只有 `.rss` 能通。** old.reddit.com 与 www.reddit.com 的 HTML、`.json` 一律 403（返回 Blocked），
`.rss` 能拿到，但几分钟内连发几次就 429。所以：

- **每个版块**一次构建只发一个请求，两次之间隔 8 秒（`FEED_GAP_MS`），结果落盘一小时
  （`.cache/reddit/list-<版块>.json`）。单版块时代那份 `hot.json` 还能被捡起来兜一次，
  免得改名字那一轮正好撞上限流就把整栏空掉。
- 429 / 403 / 断网退回过期缓存，没有缓存就整块不展示，绝不编数据；两个版块各写一条健康记录，
  汇总里看得出是哪一个挂了。
- 配了 `REDDIT_CLIENT_ID` / `REDDIT_CLIENT_SECRET` 就走官方 OAuth（app-only），能拿到赞数与
  评论数，也不受匿名限流影响。**加版块时留意请求数跟着翻倍**，匿名那点额度经不起。
- 标题、摘要、正文都翻成中文（`translate.ts`，译文按原文哈希永久缓存），失败退回英文。

**凭据为什么一直配不上。** Reddit 2025-11-11 的公告（r/redditdev「Introducing the Responsible
Builder Policy + new approval process for API access」）结束了自助 API 访问：`/prefs/apps` 点
“create app” 会直接跳到 Responsible Builder Policy，表单不出现。这不是账号或浏览器的问题，
社区里从 2025-11 到 2026-05 一直有人报同一个现象。想拿 client id 只有两条路：

- 提交申请等审批（`api_request_type_developer_clone` 那张表单，见
  [Responsible Builder Policy](https://support.reddithelp.com/hc/en-us/articles/42728983564564-Responsible-Builder-Policy)
  里的 Developer 一节）；官方不承诺回复时间，实际也有很多人没等到回音。
- 走 [Devvit](https://developers.reddit.com/)——但 Devvit 应用跑在 Reddit 内部，给不了外部站点
  数据，官方 FAQ 也写明「外部脚本、机器人、网站是另一套认证流程」。本地用不上。

所以这一栏就按匿名端点跑着：实测两个版块都能出数据，只是没有赞数与评论数，且要守
`FEED_GAP_MS` 那点间隔。OAuth 那套代码留着，哪天批下来填进 `.env` 就自动生效。

加版块只要往 `REDDIT_FEEDS` 加一行即可：缓存文件名、健康记录 id 与页面锚点都用那个 `id`，
详情页的「返回」也是按 `post.feed` 回到自己那一栏。

## 头像与封面：取回来自已发

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

**还有哪些图没落地。** 站点里仍有大量外链图（`img.dota2.com.cn` 930 个地址、`www.dota2.com.cn`
525 个，以及社区正文里的图），它们量级大、多数来自第三方正文，没有跟着一起本地化。
**`liquipedia.net` 那一批已经落地了**——队标走 `/teamlogos/`，见「赛事数据来自 Liquipedia」那节。
已知会挂的两处：

- **虎扑正文图**：一度记为「全 403，因为 `sanitizeHupuHtml()` 没补 `referrerpolicy`」——这个结论
  是错的，别再照它去改。详情页有**文档级**的 `<meta name="referrer" content="no-referrer">`
  （`src/pages/community/hupu/[pid].astro`，构建产物里确认过它在 `<head>` 里），正文的 `<img>`
  因此根本不带 Referer。实测同一个 `i11.hoopchina.com.cn` 地址：`curl` 不带 Referer 得
  `200 image/webp`，带站外 Referer 得 `403 text/plain`——拒的是 Referer，不是缺 `referrerpolicy`。
  真再看到 403，先在浏览器 Network 里确认请求头里到底有没有 Referer，别顺手去升
  `hupu-thread-v3-` 缓存键（那次改动没动到 `sanitizeHupuHtml()`，升了也没用）。
- **Reddit 缩略图**：`i.redd.it` 和 `i*.hdslb.com` 一样会被重置，`/news/reddit/[id]` 的图因此经常不出。
- **Valve CDN 的英雄图**：`cdn.cloudflare.steamstatic.com` 在国内网络动不动就
  `ERR_CONNECTION_RESET`，一整排英雄图一起裂。曾经只有"官方列表取不到就退回 OpenDota"
  这一条兜底，而那份兜底的图正指着它——离线构建或官网接口抖一下，对阵页就全是英文名 + 裂图
  （2026-09-24 实测：本机离线构建的对阵页整整 15 页带这个域名，线上没有）。现在的兜底是
  「先读带缓存的官方列表（中文名 + `img.dota2.com.cn`），最后才退到 OpenDota，且图换到
  `cdn.dota2.com.cn`」——同一条路径两边都有，实测都是 200。

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

## 视频：只信 B站 自己的接口

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

## 版本数据来自 dota2.com 的 datafeed

`/patches` 与 `/patches/<版本号>` 的数据取自 `https://www.dota2.com/datafeed/`（带上
`language=schinese`，官方直接给中文），一共四个接口：

| 接口 | 内容 |
| --- | --- |
| `patchnoteslist` | 版本列表：`patch_number` + `patch_timestamp`，从 7.08 到最新共 118 个 |
| `patchnotes?version=<版本>` | 某个版本的改动，按 `general_notes` / `items` / `neutral_items` / `neutral_creeps` / `heroes` 分层 |
| `herolist` / `itemlist` / `abilitylist` | 名字表：改动里只有 `hero_id` / `ability_id`，名字得回来查 |

### 为什么不再用中文站的「游戏性更新」

原来抓的是 `www.dota2.com.cn/news/gamepost`（和官网新闻同一套模板）。它有两个问题：
**只发到 7.41d**，再往前就断了；而且给的是排好版的 HTML，正文只能整段塞进页面。
datafeed 是官网 `/patches` 页自己的数据源，118 个版本一个不缺，而且是结构化的——
所以现在能按「英雄 → 技能 / 天赋 / 命石」分层排版，也能在列表页按大版本分组。

三个坑记在这里：

- **正文要消毒。** 改动文本里夹着 `<br>`、`<b>`、`<font color='#e03e2e'>`、
  `<span class="Subtitle">`，这份字符串最后要过 `set:html`，所以 `sanitizeNote()`
  走白名单：认得出的标签保留（颜色只接受十六进制），认不出的连标签带属性一起丢掉。
  规则在 `scripts/patchNotes.check.ts` 里逐条钉住了。
- **7.23「世外之争」和 7.28「林渊秘境」没有正文。** 官方把这两个大版本的日志做成了
  独立专题站，datafeed 里只有 `patch_website`；页面据此改成一个跳转按钮，
  而不是渲染空的正文框。列表页对应的小格子上有「专题」角标。
- **名字表会缺人。** 熊灵（`hero_id: 1961`）占着一个英雄位但没有名字和图标，
  在 `patchNotes.ts` 里补了别名，图标则退化成占位方块。

### 图标是构建期取回来的

英雄图标（`heroes/icons/<内部名>.png`，4.8KB）与物品图标（`items/<内部名>.png`，12.7KB）
都在 `cdn.steamstatic.com` 上，国内直连会被重置，所以和头像、封面走同一套本地化流程
（见「头像与封面：取回来自已发」）：落到 `.cache/patch-heroes/`、`.cache/patch-items/`，
构建结束拷进 `dist/`。**只下这一页真正用到的图**——8 年下来全部英雄加物品有 400 多张，
一次下完既慢又没必要。技能图标一张 24KB、760 个，为了配个名字不值当，所以技能只有文字。

## 装备：一份数据，两处用

装备来自 dota2.com.cn 的两个接口，**只有详情那个是 JSONP**（响应是 `HeropediaDFReceive({...})`，
没有 CORS 头，所以浏览器里要注入 `<script>` 绕跨域）；分类那个是普通 JSON，直接 `fetch`：

| 接口 | 内容 | 谁在用 |
| --- | --- | --- |
| `itemscategory/json` | 分类视图：基础 / 升级 / 中立，229 件 | `/items` 的分组与排序（构建期与浏览器各取一次） |
| `items/json` | 全部 614 件详情：价格、描述、效果、备注、冷却、耗蓝、配方 | 悬浮框（浏览器注入 `<script>` 绕跨域）与 `/items/[id]`（构建期剥掉 JSONP 外壳直接解析） |

几件踩过的坑，改这块之前先看：

- **配方字段是 `requirements`，不是 `components`。** `components` 实测 614 件全为空字符串，
  最早的实现信了它，于是「合成配方」在页面上从来没出现过。`requirements` 是个数组，
  `recipe_*` 是图纸，带 `*` 后缀的那件表示"要拿升级件来合"（展示时去掉后缀）。
- **重复项是有意义的份数**：魔杖的配方里 `branches` 出现两次，就是要两根铁树枝干。价格核对过：
  散件（含重复）+ 图纸 = 成品价，魔杖 200 + 55×2 + 150 = 460。
- **94 条没有中文名**（`recipe_phase_boots`、`mystery_hook`、`winter_cake` 这类历史遗留与活动道具），
  不给它们建页——那只是给爬虫喂空页。合成配方里引用到它们时按纯文字渲染。
- **`qual`（品质）与 `created` 全是空的**，做不出稀有度标签，也拿不到上线时间，别去试。

构建期那份目录落在 `.cache/items/catalog.json`（6 小时），上游挂了就退回旧缓存、多旧都用；
一件都拿不到时不建装备页，宁可没有也不能出 500 个空壳。

## 在线人数：官方接口 + 自己记的趋势

首页那块「刀塔有多热」：三个大数字 + 一条能悬停看数值的折线。

**三个数字里的两个来自 Valve 官方接口**，不要 key、不碰第三方：

| 想要什么 | 接口 | 实测 |
| --- | --- | --- |
| 当前在线 | `api.steampowered.com/ISteamUserStats/GetNumberOfCurrentPlayers/v1/?appid=570` | 200 · `{"player_count":370669}` · 1.5s |
| 24 小时峰值、全站排名 | `api.steampowered.com/ISteamChartsService/GetMostPlayedGames/v1/` | 200 · DOTA2 `{"rank":2,"peak_in_game":794330}` |

后一个接口列的是**全站前 100 名**，DOTA2 常年在第 2、第 3，所以拿得到；哪天掉出去就是 null，
页面少显示一格（那一格是 24 小时峰值），不算故障。`peak_in_game` 就是「24 小时峰值」这个口径，
不是历史峰值——Steam 那页自己也这么标。

**第三个「历史峰值」没有官方口径**，只能取第三方的统计值当常量写在 `steamPlayers.ts` 里，
而且各家还不一样：SteamCharts 记 1,291,328（2016 年 3 月），SteamDB 记 1,295,114——采样间隔不同，
谁都说得通。取的是 SteamCharts 那个，页面上标明来源，不假装是官方数字；真被破了得手动改。

**趋势不是第三方给的，是自己记的。** SteamDB 那张图表页（`/app/570/charts/`）是 Cloudflare
保护着的，实测 403——那是它自己的数据产品，抓它既不礼貌也不稳。所以每轮构建往
`.cache/players/history.json` 记一笔：站点半小时重建一次，一天 48 个点，一周就是一条真曲线。
跟着 `.cache/` 在 CI 里滚动（GitHub 的缓存长期不用才会淘汰，我们每半小时用一次）。

几条规矩：

- **历史从开始记录那天算起**，图上标出起点；刚开始只有几个点时，页面显示「折线才刚开始记」
  并给一个 SteamDB 的外链，不假装我们有长期数据。
- 两个点挨得近（15 分钟内，本地连着构建）就**覆盖**上一个，不新起一个点。
- 只留 30 天，画之前抽稀到 400 点以内——SVG 路径别写成几十 KB。
- 官方接口这次没通就不记点（免得把旧数字当新样本），页面退回历史最后一个点并标出时刻。
- 折线**默认由服务端画好**，同时把整条序列压成 `[时间, 在线数]` 的紧凑 JSON 塞进页面
  （400 个点约 8.8KB，gzip 后 2KB 上下），客户端拿它做两件事：切时间窗（24 小时 / 7 天 / 30 天）、
  悬停显示具体数值（十字线 + 圆点 + 提示框，时间按北京时间）。没有 JS 时静态 SVG 照常显示，
  只是不能缩放与悬停。

## 完美世界电竞：直连为主，RSSHub 兜底

国服运营方（完美世界）的 DOTA2 资讯，中文，和官网那 46 篇不是一回事，所以在资讯页单开一栏。

**主路直连它自己的两个 JSON 接口**（`appengine.wmpvp.com` 列表、`appactivity.wmpvp.com` 正文），
无 cookie、无 puppeteer。下面这组是**在 GitHub runner 上**测的——本机挂着代理、出口在国内，
两边结论经常不一样（`候选源探测` 那个 workflow 就是干这个的）：

| 探测点 | 结果 |
| --- | --- |
| 直连列表接口 | 200 · 28KB · 0.7s |
| 直连正文接口 | 200 · 4KB · 0.7s |
| RSSHub 公共实例 `rsshub.rssforever.com` | 200 · 103KB · 5.3s |
| RSSHub 官方实例 `rsshub.app` | 403（Cloudflare 挑战，用不了） |

**兜底走 RSSHub 的 `/wmpvp/news/1`。** 它的价值不在"能取到"（直连也能），而在上游改字段时
那条路由由 RSSHub 的维护者跟着改，等于白捡一层别人替你维护的解析。代价是它自带 5 分钟缓存、
而且是**别人的服务**——它挂了这一栏不该跟着空，反过来也一样，所以只当备胎。实例地址读
`RSSHUB_BASE` 环境变量（默认上面那个公共实例），换自建实例不用改代码。

缓存：列表半小时（`.cache/wmpvp/list.json`），正文按 id 永久缓存（`.cache/wmpvp/news-<id>.json`，
发布后基本不改）。两条路都不通就退回旧缓存、多旧都用，再没有就整栏不展示，健康记录里写清楚。

### 配图必须取回本地，而且要让图床压一遍

`cdn.wmpvp.com` **判 Referer**：实测不带 403、带本站域名 403、只有带 `news.wmpvp.com` 才 200。
而站里的 `<img>` 一律 `referrerpolicy="no-referrer"`（那是为了迁就 Steam 的 CDN），
所以热链出去必然满屏 403——第一次接完之后读者看到的就是这个。现在构建期带上它自己家的 Referer
把字节取回来，和头像、封面走同一套 `localImages`（为此给 `ImageChannel` 加了两个可选字段：
频道级请求头，以及代理兜底时的 `fit`——文章配图得用 `contain`，不能像头像那样裁成固定比例）。

顺带让图床自己压一遍。`cdn.wmpvp.com` 是阿里云 OSS，认 `x-oss-process`（那些带
`resize,m_fixed,h_599,w_948` 的地址就是它自己生成的），把参数换成「长边 1080 / q80 / webp」：

| | 张数 | 合计 | 中位 | 最大 |
| --- | --- | --- | --- | --- |
| 原图 | 111 | 205MB | 1.5MB | 3.8MB |
| 压过的 | 111 | 6.5MB | 74KB | 115KB |

差的是整个 `dist/client` 的体积（246MB → 50MB），也就是每次部署要传、每个读者要下的量。
压过的地址不一定都认（原图不在 OSS 上、参数被拒），那些会退回原地址再取一次。

**别指望这个实例上别的路由也能用。** 同一个实例我试过 `/tieba/forum/dota2` 与 `/zhihu/hotlist`
都是 503、`/bilibili/ranking/...` 是 301——能不能出数据取决于它自己的出口 IP 与配置，
要接哪条就先用探测 workflow 探哪条。

## 赛事数据来自 Liquipedia

赛程与赛果取自 Liquipedia 的 [`Liquipedia:Matches`](https://liquipedia.net/dota2/Liquipedia:Matches)
（原来的超凡电竞接口已不再响应）。使用它需要遵守
[Liquipedia API 条款](https://liquipedia.net/api-terms-of-use)：带能识别调用方的 User-Agent、
控制请求频率、署名并回链。页面上保留了到 Liquipedia 的链接——改动这块时请一并保留。

**两种页面模板，内层结构一样**（解析在 `src/lib/liquipediaParse.ts`，纯函数，可离线自检）：

| 页面 | 切块标记 | 内容 |
| --- | --- | --- |
| `Liquipedia:Matches`（主赛程页） | `<div class="match-info">` | 未来赛程 + 近期赛果，**滚动窗口** |
| 赛事页与阶段子页 | `brkts-match-info-popup`（bracket 模板的隐藏弹层） | 整届对阵，已完赛的带比分 |

主赛程页只是窗口内的切片，所以赛事页要再补一遍：按主表里出现过的页面路径抓，每页 6 小时缓存
（`.cache/liquipedia/events.json`），一轮最多 8 页、页间留 1.2 秒。实测同一时刻 PGL Wallachia 9
在主表里只有 1 场，赛事页上有 37 场。

两个踩过的坑：

- **队标 span 的 class 不是固定的**。只有亮色队标的队伍会渲染成
  `class="team-template-image-icon team-template-lightmode"`；正则要求 class 恰好等于前者时，
  这类队伍解析成空，而「一方未定就跳过整场」会把对手一起丢掉——实测主表 100 场丢 56 场，
  其中 29 场是这个原因（Xtreme Gaming vs Team Nemesis 就在里头）。
  `scripts/liquipedia.check.ts` 守这件事，改解析先跑它。
- **同一届赛事的各个阶段是两个页面**：`PGL/Wallachia/9` 是季后赛，`.../9/Group_Stage` 是小组赛。
  不归并就会被拆成两个站内赛事，读者点进去看到的是「即将开始」加一场孤零零的对阵。归并只认明确的
  阶段名（`group_stage` / `playoffs` / …），`BLAST/SLAM/9/Southeast_Asia` 这种区域子赛有自己
  独立的赛程，保持单独一个赛事。

### 队标也取回本地了

主赛程页与赛事页的每支队伍都带一份队标缩略图。这些图以前是**热链**`liquipedia.net`，
一轮构建下来对阵行、对阵页、战队页、赛事页加起来三千多个 `<img>` 指着人家的服务器。
现在和头像、封面走同一条路（直连 → `wsrv.nl` 代理 → `.cache/teamlogos/` → 构建末尾发布到
`/teamlogos/`），**取回成功的换成站内地址，拿不到的仍退回热链**（页面不会出现破图，所以
线上偶尔还会看到 `liquipedia.net` 的地址——那是兜底，不是漏改）。频道配置在 `src/lib/teamLogos.ts`，
「哪些地址要去下」的判据在 `src/lib/teamLogoSource.ts`（纯函数，`scripts/teamLogos.check.ts` 守着）。

**这个频道刻意不设 `width`/`height`**：代理兜底那条路会按尺寸 + `fit` 缩放裁剪（默认 cover），
而这里要原样——Liquipedia 给的就是它自己缩好的小图（实测 36–100px），写成 128×128 会把
100×50 那种队标放大再裁成方图。（实测当前一轮 46 张落盘全是原始尺寸的 PNG，说明走的是直连；
代理那条路没被用到，但参数别改回去。）

三件实测出来的事，改这块之前先看一眼：

- **别把缩略图地址改写成更大的尺寸**。Liquipedia 赛程页给的是它按版面缩好的小图（实测 36–100px），
  把 `50px-` 换成 `128px-` 试过，46 个里有 18 个直接 404——它对超过原图宽度的缩略图请求是**拒绝**
  而不是放大。所以按原样取回来，清晰度和热链时一样，不会更差。真要高清除非去战队页的 Infobox 拿
  Valve 队伍 id（`teamid=2163`），换 STRATZ 的 `cdn.stratz.com/images/dota2/teams/<id>.png`。
- **`Dota_2_default_allmode.png` 不是队标**。那是 Valve 的通用标志，赛程页上实测有 6 支队伍挂着它，
  六个不同的队显示同一个图标比显示首字母还糟。判据里当成「没有队标」处理，页面退回首字母占位。
- **本地化要盖住 bundle 里的每一个 `TeamRef`**。一支队在对阵里是一堆各自独立的对象，
  `buildEvents()` 归并出的 `event.teams` 还是**拷贝**——只改其中一个，线上表现就是
  一部分页面对了、一部分还在热链（这个漏过一次：先把对阵改对了，赛事页的「参赛队伍」那一栏没跟上）。

**队徽放在浅色底板上，不挑「深色版」。** 赛程页给的缩略图常常是 `_lightmode`（Liquipedia 模板里
那是给**亮色**界面用的），而队徽本身多半是黑图形 + 透明底：实测 46 张里 **9 张**的图形像素几乎全黑
（Team Spirit、Team Lynx、Team Nemesis、MOUZ、Natus Vincere、Team Spirit Academy、Balu Team、
Kalmychata、Xipto、Yangon Galacticos），叠在 `--color-surface-2`（`#2f140f`）上等于没画。现在
和 Liquipedia 自己一样，把队标放进一块暖白底板（`--color-plate`）：黑队徽、白队徽、彩色队徽都能
看见，一处 CSS 解决，五处页面（场次行、对阵页、战队列表、战队详情、赛事页）共用。

试过并撤掉的另一条路是读 Infobox 的 `imagedark=`（给深色背景的那一版）。它有两个死角：

- **`imagedark` 不一定是队徽，可能是横排的文字组合 logo**。Team Spirit 那张
  `Team_Spirit_2022_full_darkmode.png` 实测 120×31、Team Nemesis 的 `..._full_darkmode.png` 是
  120×22，而当时的队标框是方形 + `object-cover`——宽图被裁成方图之后只剩一个字母的碎片，页面上
  看起来就是「队标没加载出来」。这次报上来的正是这个现象。
- **深色版是给深色背景画的**（白字 / 白图形），底板一旦改成浅色，它自己反而看不见。所以
  「浅色底板」与「深色版队标」只能留一件，最后选了底板。

`.cache/liquipedia/team-dark-logos.json` 现在没有代码再读，旧文件留着不影响构建，可以删。
另外两条当时记下来的坑仍然有效（万一以后又想做深色版）：**别靠文件名猜**——把 `_lightmode`
换成 `_darkmode` 去问，11 支里有名字对不上的（Team Lynx 的真名是 `Team_Lynx_full_darkmode.png`）；
`Special:FilePath` 那条路实测 403 被 Cloudflare 挡着，只能走 `action=query&prop=imageinfo`。

**队标框不许再用 `object-cover`。** 宽队标会被裁成碎片（上面那个 120×31 → 只剩一个字母），
改用 `object-contain` 让整个 mark 都在，哪怕小一点。`scripts/teamLogos.check.ts` 守这条：
五处页面的 7 张队标必须同时带 `bg-plate` 与 `object-contain`。

### 赛事档位（只描述赛事）

Liquipedia 会给每届赛事定档，Infobox 上渲染成 `Liquipedia Tier: Tier 2` 这样一行。
解析在 `src/lib/liquipediaParse.ts` 的 `parseLeagueTier`，解析本身不额外发请求——档位就在
我们为了补全对阵已经抓回来的那份渲染结果里。**但当前实现仍然是单独抓一次赛事根页面**
（`.cache/liquipedia/tiers.json`，缓存一周）：赛事页补全抓的是 `sourceUrl` 指的那些页面
（常常是 `…/Group_Stage` 这类子页），而档位只在根页面的 Infobox 上，两条流的页面集合只有
一部分重合。实测 5 届赛事里 5 届重合，也就是冷启动那一轮同一页会被抓两遍（一次按 6 小时、
一次按一周），量级很小；要省掉它得让档位复用赛事页补全已经取回的 HTML。

**档位只用在赛事这一层**：赛事页的徽章与档位筛选。它曾经被拿来给**队伍**分层——「窗口内打过
T1/T2 的算一线队」——那条口径已经撤掉：档位是赛事的属性，拿来反推队伍必然走样，打进 T1 预选赛的
二线队会被算进来（实测 Level UP 就是），休赛期没打 T1/T2 的强队会被漏掉。战队名录改成按
Liquipedia 的活跃战队门户分区（见下面「战队名录」一节），页面上也把这条口径写给了读者。

**OpenDota 的队伍评分试过，不能用**：52 支里只匹配得到 24 支，而且排序明显失真——
OG 1178 分，排在我们按档位算作三线的 PuckChamp（1265）后面；Team Liquid 1407 分低于
PARIVISION 的 1507。别再往那个方向试。

四个实测出来的坑：

- **阶段子页上没有那一行**。`PGL/Wallachia/9/Group_Stage` 没有 Infobox，档位在父页面
  `PGL/Wallachia/9` 上，而 `sourceUrl` 恰恰常常指向子页。所以 `fetchLiquipediaEventTiers()`
  按 `eventPathOf()` 归到根页面再去取。
- **档位与「表演赛」是两个字段**。wikitext 里是 `liquipediatier=3` 与
  `liquipediatiertype=showmatch` 两条，渲染成 `Showmatch (Tier 3)`——表演赛**仍然有正式档位**，
  不是"没有档位"。站内两个都存（`event.tier` 与 `event.showmatch`）：档位负责徽章与筛选，
  `showmatch` 只是提醒读者那不是一场正式比赛（那种比赛的参赛队是主播队，跟职业层级没关系）。
- **这条流要单独限速**。第一次跑就中了一招：5 个赛事的档位请求里 1 个没拿到页面（路径在输入里、
  缓存里没有），那一届整轮没有徽章。两条流各自节流，对方看到的是两批加起来的频率，所以
  档位这条用 2 秒间隔（比赛事页补全的 1.2 秒慢），并且失败重试一次。
- **认不出的值不显示**。只认 `Tier 1`–`Tier 4`，其余（包括没抓到页面的）一律不挂徽章——
  不猜一个默认档位。

档位缓存一周（`.cache/liquipedia/tiers.json`）：Liquipedia 定档之后就不动了。这里有两档要分开——
**页面抓到了、但上面没有档位那一行**（阶段子页混进来、或那届确实没定级）会当作"问过了"记一笔，
免得每轮白问一次；**页面根本没抓到**才不写缓存，下一轮重试。

**降级那一轮要把档位从缓存还原**（`tierMapOf` / `applyEventTiers`，判据在
`scripts/leagueTier.check.ts`）：档位挂在**赛事**上、不在对阵上，而走缓存时赛事是按对阵重新聚合的，
档位不会自己跟过去。漏掉这一步的表现很具体——离线构建那一轮全站赛事都没有档位，
赛事页的档位徽章全空、档位筛选把每届都归进「其他」，而数据其实就在缓存里（实测踩到）。

### 战队名录：按地区分组，而不是按档位分层

`/teams` 的名单来自 Liquipedia 活跃战队门户 `Portal:Teams` 的 **Regions** 面板，解析在
`parseTeamPortal`（`scripts/teamPortal.check.ts` 守着）。

- **为什么换**：原来的名录是"我们抓的那几届赛事里出现过谁"，再用赛事档位猜哪支算一线队。
  窗口只有几届赛事，所以二线队、青训队会被算进来，休赛期的强队会被漏掉。门户是 Liquipedia
  人工维护的「现在活跃的强队名单」，而且天然按地区分好了组——正是名录需要的那个轴。
- **抓什么**：`action=parse` 的渲染结果。门户模板内部走 Liquipedia 自己的 LPDB 查询，
  **没有公开接口**，只能读渲染 HTML。一天一次（`.cache/liquipedia/team-portal.json`），
  抓不到就退回过期缓存；连缓存都没有时，名录退回"窗口里出现过的队伍"单列一区，页面照常可用。
  抓取结果会以 `liquipedia-teams` 的 id 进构建汇总——静默失败在页面上看不出来。
- **六个地区**（实测 37 支）：北美 1、南美 5、西欧 9、东欧与独联体 12、中国 4、东南亚 6。
  中文标签在 `src/lib/teamRegions.ts`；门户将来加地区而这里没配标签时，页面显示门户自己的名字
  （不编中文），自检会把没配的那个键报出来。
- **地区是队籍登记，不是俱乐部起源地**：OG 在东南亚（`location=Philippines`）、
  LGD Gaming 在南美、GamerLegion 在北美。页面上把这句话写给读者，否则看着就像分错了。
- **队伍 id 按页面标题生成**（`liquipediaTeamId`）。门户里 `Inner_Circle_x_Insanity` 显示成
  「IC x Insanity」，赛程页显示成「Inner Circle x Insanity」——按队名生成 id 会把同一支队
  劈成两个 id、两个页面（实测）。换成页面标题之后，窗口里 46 支队的 id 一个都没变。
- **门户独有的队伍会多出页面**：实测 13 支（Amaru Gaming、Hokori、Nigma Galaxy、Virtus.pro、
  Winter Bear、Execration…）。它们有队标、名单与招牌英雄，只是「窗口内 0 场对阵」。
  代价是招牌英雄要按人逐个查 STRATZ（见 `playerHeroes.ts`），这一批会多出 60 次上下。
- **队标用门户自带的 2x 档**（`srcset` 里最大的一张，实测 84–192px），比赛程页那份 36–100px
  的缩略图清楚；渠道、缓存目录与赛程页那份共用。
- **窗口里出现、门户没收录的队伍不丢**：名录页最后折起来列它们（实测 22 支）。它们是二线队、
  青训队或临时组队，没有地区归属，但页面上仍然有位置，对阵页与赛事页也还链着。
- **`/draft` 复用这份名录**：阵容分析页两个下拉背后的数据（队标、名单、每人招牌英雄、
  OpenDota id）与这份名录同源，收录规则是「门户里的全部 + 窗口里出现过且 Liquipedia 有名单
  的队伍」。实测就是门户那 37 支——窗口独有那 22 支在 Liquipedia 上没有可用的名单（只有队名和
  队标），进下拉只是噪声。OpenDota id 也在这里烘焙好（37 支里 25 支查得到），查不到的那几支
  只是取不到「近期英雄偏好」，招牌英雄与队标照常显示。
  这一份**内联在 `/draft` 的 HTML 里**（`<script id="draft-teams">`），`/draft-teams.json` 是它的
  程序接口（同一次 `loadDraftTeams()`，内容一致）。为什么不只发一份文件：那份取不到时页面只会
  显示「未指定队伍」，和「没选队」分不出来，用户会以为选择没生效——实测被这么误解过。

### 战队名单：换掉 OpenDota 的「历史全量」

`/teams/<队>` 的人员名单原来取 OpenDota 的 `/teams/<id>/players`，而那个接口给的是**历史全量**：
实测 Team Liquid 名下同时有现役的 miCKe、Boxi、tOfu，也有几年前的 Miracle-、GH、kky，
连教练 Jabbz 都被标成「在队」——页面上就是「名单不完整、又混着离队的人」。现在改用 Liquipedia
战队页的 wikitext，解析在 `parseTeamRoster`（`scripts/liquipedia.check.ts` 守着）。

取数走 `action=query`（轻接口）加 `titles=` 批量：一次 50 个标题，几十支队两批就取完，
之后 12 小时吃缓存（`.cache/liquipedia/rosters.json`）。按队逐个抓会是几十个请求，
而条款要求低频调用。

页面结构（实测 Team Spirit / Team Liquid）：现役是 `{{Squad|status=active}}`，教练组是
`{{Squad|type=staff|status=active}}`，离队整块是 `status=inactive` 或 `status=former`
（NAVI 一页 33 个 former Squad、OG 24 个）。判据用模板参数而不是章节标题——标题会变、会缺席，
参数不会。

**教练组只有 3 支队伍有，是数据源本身没有，不是解析漏了**（把 52 支队的页面全取回来数过：
25 个有内容，其余 21 个没有页面）：用 `{{Squad|type=staff}}` 的只有 Team Liquid、Team Spirit、
PuckChamp 三家。其余队伍把团队信息放在 `==Organization==` 的
`{{ActiveOrganizationAuto|{{Person|…}}}}` 里，而那一栏 40 条 role **没有一条是教练或分析师**——
全是 Founder / CEO / COO / CBDO / CRO / Manager / General Manager / Head of Esports /
Esports Host / SMM 这类组织职务。也就是说，多认一个模板只会把 CEO 搬进「教练组」那一栏，
反而错得更远；要显示那一栏得先定口径（比如另开一栏「团队」，只收 Manager / General Manager 这类）。
另外**教练组不再受"现役那一段"的切片影响**：页面顺序不统一，`===Coaching Staff===` 排在
`===Inactive Roster===` 之后的队伍同样存在，切掉就整块没了；它自己靠 `status=active`
挡离职的人，不需要切片兜底。

四个坑：

- **`{{stand-in}}` 到处都有，历史段里最多**。页尾的 `===Former===` 段塞满了历年的替补记录
  （实测 OG 27 条，其中一个人出现 5 次），照单全收就会变成「替补：Ceb、Ceb、Ceb…」。
  所以先按「现役那一段」把文本切掉，边界认 `former` / `inactive` 标题与对应的 Squad。
- **页面会用 HTML 注释「停用」整段模板**（Team Spirit 的替补表就写在注释里），解析前先去注释。
- **模板要按大括号配对读，不能上非贪婪正则**：`{{Squad|…{{Person|…}}…}}` 里第一个 `}}`
  关掉的是 `Person`，非贪婪会把 `Squad` 截断在第一个人之后。
- **队标取名单要靠页面标题，不能拿队名猜**。`Xtreme Gaming` 的队标文件叫
  `Xtreme_Gaming_%28China%29_allmode.png`，照它猜标题会查不到——标题要从对阵页里那条队伍链接的
  `href` 取（`/dota2/Xtreme_Gaming`）。

**另有 24 支队伍没有名单，那不是抓失败**：那些队在 Liquipedia 上根本没有页面（YBN Team、
Team Kinetix 这类主播/业余队，赛程页里是红链）。页面照常生成，只是显示「暂无名单」。

> **给解析出来的对象加字段，必须同时把 `liquipediaApi.ts` 的 `CACHE_VERSION` 加一。** 缓存里存的
> 是**解析后**的对象，老缓存不会自己长出字段：给队伍加 `wiki`（取名单要用它）那次忘了升版本，
> 那一轮构建吃到旧缓存，全站队伍一个名单都没有，而构建汇总还写着「联网抓取」。同一个坑
> `roomList.ts` 里踩过。

### 选手的招牌英雄：按版本算

**OB 页（`/ob`）用的是同一份东西，外加班级。** 成员卡片上的「天梯 + 擅长英雄」由
`src/lib/obPlayers.ts` 在构建期拼出来，三个来源各一段：

- **账号 id 取自 Liquipedia 选手页的 `|playerid=`**（`liquipediaApi.fetchLiquipediaPlayerIds`，
  和战队名单是同一条路），写死在 `src/data/ob.ts` 的 `accountId`。**不靠昵称搜**：用 OpenDota
  搜 `yyf` 能搜出三个近期都在打的「YYF」，猜错就是把别人的战绩挂在石佛头上——所以宁可不显示。
- **段位来自 STRATZ 的 `steamAccount.seasonRank`**，用站内 `dotaLabels.rankInfo` 翻译成
  「冠绝 / 超凡 4 星 / 未定级」。**Valve 不公开 MMR 数字**，所以这里不写分数——要写只能编。
  实测这十位的段位分布是 7 个冠绝、1 个超凡 4 星、2 个未定级。
- **英雄池直接复用上一条那套**（`loadPlayerHeroPools`，按版本统计、样本不够退 90 天并如实标口径）。

两种"没有数据"是**两回事**，页面上分开写（这一条有自检盯着）：
账号匿名或长期不打天梯（LongDD、ZippO 的账号匿名；Mu 最后一场是 2024-10）→「没有可用的公开对局」；
池子有数据、但这次构建没取到英雄名（更新日志那条源没通）→「有 N 个英雄的记录，但没取到名字」。
上一版把这两种写成同一句，等于把"这次没取到名字"说成"他没打过"。

段位那一层单独落盘（`.cache/stratz/ob-players.json`，24 小时）：`loadPlayerProfile` 走的是
`ssrCache`（**进程内存**、10 分钟），而 OB 页是构建期预渲染的静态页——不落盘就等于每次重建
都要为这十个人各发一次请求。离线构建照用旧缓存，不让整块凭空消失。

`/teams/<队>` 每个人的招牌英雄来自 STRATZ 的 `player.matches`，**按当前版本统计**——
「擅长英雄」是跟版本走的，跨版本平均出来的名单既不是他现在的水平、也不是他上个版本的。
每一行末尾都标着实际口径（`7.41f 版本` / `近 90 天`），挑选规则在 `src/lib/heroPool.ts`
（纯函数，`scripts/playerHeroes.check.ts` 守着），取数在 `src/lib/playerHeroes.ts`。

**账号 id 写在选手页上**，不在战队页里（`|playerid=152962063`），所以要跟着名单再取一层。
队伍模板里 `{{Person}}` 有 `link=` 时用它当页面标题，没有就是昵称（MediaWiki 首字母不区分大小写）。
实测 113 个选手页里 94 个有账号。

**不能按昵称搜。** STRATZ 的根查询里没有按名字搜选手的字段，而昵称本来就随时改：实测一个账号
在 Liquipedia 上叫 `Gotthejuice`，游戏里已经叫 `realm`，九月的比赛里就是这个名字——按名字对不上人。

四个实测出来的事：

- **STRATZ 只给正式比赛**（`PRACTICE` + `CAPTAINS_MODE`），天梯对局不对外开放：显式要
  `lobbyTypeIds: [7]` 返回 0 场。样本因此比 dota2protracker 那种「近 8 天天梯 + 官方赛」薄，
  一位现役选手一个版本大约 20–50 场。
- **`heroesPerformance` 在这个场景不能用**：它只有 `take` 一个参数（问过 schema），没有时间维度，
  拿到的是职业生涯累计。按版本算只能用 `matches`。
- **窗口不能只看本版本**。版本刚开两周时，没打官方赛的队一个人都列不出来：实测 Team Liquid 的
  选手最后一场官方赛是 8 月 22 日、Team Spirit 是 8 月 23 日，而 7.41f 是 9 月 15 日发的。
  所以本版本样本不足 5 场就回退到 90 天，**并把口径改成「近 90 天」**——回退本身没问题，
  假装还是本版本的数据才有问题。

  **2026-09-30 补了两个判据，都是被界面上的误读逼出来的**：判据只看场次、每人只留 5 个英雄时，
  实测 Ame 的池子在页面上只剩**一个**英雄，看起来像"这位职业选手只会一个英雄"。
  原因是 6 场打了 6 个英雄也算"本版本样本够"，而每个英雄都只有 1 场、过不了英雄门槛。
  现在：**本版本要能凑出 ≥5 个达标的英雄**，凑不满就退到 90 天（标签跟着写「近 90 天」）；
  每人保留的**英雄数从 5 提到 10**。实测这一轮下来，每位选手的池子从平均 4–5 个变成
  **平均 7.8 个（最多 10、最少 1）**，Ame 从 1 个变成 10 个。
  改判据同时把 `HERO_POOL_CACHE_VERSION` 从 1 升到 2——缓存里存的是**算好的池子**，
  不升版本号就会一直吃旧判据的结果（同一个坑上面刚从 Liquipedia 那边踩过一次）。
- **一位选手一个请求**（`players()` 一次只让带 5 个），靠缓存摊平：对局结果 24 小时、账号 id 一周。
  冷启动那一轮构建会多花几分钟（实测 94 位在两分钟内打完，约 0.8 次/秒），之后都是命中缓存。

  **TTL 是按额度定的，不是按新鲜度定的。** 实测名单里 94 个账号：取 6 小时 = 每天 4 轮 × 94
  ≈ 376 次请求，取 24 小时 = 94 次。同名册里的人数是会长的（Liquipedia 现在只有 28/52 支队伍
  有维护好的名单），所以缩短 TTL 等于把人数乘上刷新次数，别再往下调。

  **撞到限流就整批停下**（`heroPoolBatch.ts`，自检在 `scripts/playerHeroes.check.ts`）：429、
  出口 IP 不对、中转口令不对、上游挂掉都会抛 `StratzError`，而这几类都是"整批都问不动"——
  再问剩下几十个账号只会把额度打得更空（每个请求自己还会重试 3 次），页面上却看不出区别。
  停下的那一轮：没问的人退旧缓存（页面照常显示），失败的不写缓存，下一轮重试。

英雄图标沿用更新日志那一套（`.cache/patch-heroes/`，见上文），但**只取这一页要画的那些**：
实测 52 支队伍加起来引用 81 个英雄。别按"战队页会把整套图标拉下来"去推——`dist/patch-heroes/`
里始终是整套 127 张，那是**更新日志页**的引用集，它把 127 个英雄全提了一遍。

教练组没有对局可算、替补通常也没有；没有账号 id、或者样本里每个英雄都只打过一场的，
这一块就不显示——宁可不给结论，也不拿一个英雄凑数。

## 对阵页的阵容：按小局取

日历上的一条是**系列**（BO3/BO5），而 Valve 的每个比赛 id 只对应其中**一局**。所以对阵页
按小局列出：第几局、时长、谁赢了，以及那一局各自的 BP 与选手。取数分三步
（`src/lib/matchDraft.ts` 取数，`src/lib/matchSeries.ts` 是纯逻辑，后者可离线自检）：

1. **队伍解析只走 OpenDota**。它的 `/api/teams` 与 `proMatches` 队名索引命中率更高；
   STRATZ 的 `stratz.search` 在三线队上又少又容易给错队。
2. **候选取两边的并集**：OpenDota 的联赛索引，加 STRATZ 的"两队近 30 天比赛"求交集——
   后者能补上 `proMatches` 没收录的场次。全部按 Valve 比赛 id 去重。
3. **明细优先 STRATZ**（字段更全、限速宽 7 倍），取不到才回 OpenDota。

几个必须守住的点：

- **小局清单要用 STRATZ 的 `match(id).series.matches`**，不能按"时间接近"猜：同一对队伍
  同一天可能打两轮（小组赛 + 淘汰赛），按时间猜会把两轮并成一个系列。只有拿不到系列关系
  （未配 token、离线构建、不是系列赛）时才回落到候选里 ±6 小时。离线构建照样读缓存，
  只是不联网——别在 `cached()` 之前就 return，那样会把整段系列关系白白丢掉。
- **系列关系的 TTL 是 30 分钟（`SERIES_TTL_SECONDS`），不是 30 天**。它缓存的是"这个系列
  **现在**有哪些小局"——一个随时间增长的量。站点每 30 分钟重建一轮，只要某轮抓到"第 1 局
  还在打"的那个瞬间，后面打完的局就再也不会出现（缓存键是 Valve 比赛 id，页面每次都落回
  同一个锚点），表现就是表头写着 2:1、下面只列一局。
- **`series.matches` 是倒序返回的**（决胜局在最前），展示前必须按开始时间排一次。
- **局号按系列的位次给**（`MatchDraftGame.ordinal`），不能取"有数据的局"里的下标：中间某局
  取不到明细时会被跳过，但后面那几局的编号要留在原位，否则第 3 局会显示成"第 2 局"。
- **天辉/夜魇与主客队无关**。日历上的主队完全可能在夜魇，所以"天辉赢了"要按队伍 id 换算成
  "主队赢了"；BP 与选手同理（实测同一系列里主队会在两局之间换边）。
- **明细里有后补的部分，缺了要短 TTL**。两个源都有这毛病：比赛刚打完就抓，STRATZ 常常先
  给回十个选手、`pickBans` 还是空的；OpenDota 的 `picks_bans` 要等它解析完（实测 3.4 / 5.3
  小时前打完的还没有，8.9 小时起才有 24 条）。所以缺 BP、或缺后来才加进来的字段
  （`radiantWin` / `duration`，老缓存不会自己长出来）时，明细只当 6 小时新鲜
  （`MATCH_INCOMPLETE_TTL_SECONDS`），否则会整整一个月看不到禁用英雄、也刷不出来。

命中不了就不展示，绝不靠队名近似去猜一场比赛。页面下方保留到 STRATZ / OpenDota 对应小局的
外链，改动这块时请一并保留。

## 英雄胜率的口径

英雄页与 BP 页的数据来自 STRATZ 的 `heroStats.stats(bracketBasicIds: [DIVINE_IMMORTAL])`
（见 `src/lib/stratzApi.ts`），口径是**超凡入圣及以上**、窗口是**上一个完整的统计周**
（`metaWindow.ts` 里算，页面上用 `HERO_META_WINDOW_LABEL`）。

**这个窗口既不是「近 7 天」也不是自然周**，而是上游按 **Unix 纪元对齐的 7 天桶**（1970-01-01 是
周四，所以边界在周四 00:00 UTC）。2026-09-29 实测：跨过 `2026-09-24T00:00Z` 总场次从 1,763,328
跳到 1,073,094，按 2 小时步进能把边界夹在 22:13Z 与 00:13Z 之间；同一桶内换任意 `week` 结果一致。

**不传 `week` 拿到的是当前那个还没走完的桶**（那天构建时它只有 5/7 天、1,040,817 场）——仓库里
曾经写着"不传 = 上一个完整自然周"，那是错的。所以现在显式传一个落在上一桶里的时刻
（`weekAnchorSeconds`），要一整桶。

和另外两个源对不上属于口径差异，不是算错：STRATZ 自家趋势页走的是 `winWeek` 字段（同一段位下与
`stats` 逐英雄平均差 1.81 个百分点、最大 8 个），OpenDota 的 `/heroes/public`（实际接口
`/api/heroStats`）统计的是**全部公开对局**，含未校准与低分段。
