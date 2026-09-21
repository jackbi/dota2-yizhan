# 数据来源

站点的内容全部来自公开上游，构建期抓取后落进 `.cache/`（缓存策略见
[构建、缓存与部署](./deploy.md)）。这篇记的是每个来源的取数方式、口径与实测结论。

## 社区热帖：来源与口径

资讯页（`src/pages/news.astro`）有**五个**来源页签：官网新闻、Reddit 热帖（r/DotA2）、
Reddit 赛事讨论（r/compDota2）、NGA 热帖、虎扑新帖。两个中文社区来源聚合在
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
  列表缓存 30 分钟、详情 2 小时（键带版本号 `hupu-thread-v2-`，解析规则一变就要换）。
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

- **每个版块**一次构建只发一个请求，两次之间隔 3 秒（`FEED_GAP_MS`），结果落盘一小时
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

## 赛事数据来自 Liquipedia

赛程与赛果取自 Liquipedia 的 [`Liquipedia:Matches`](https://liquipedia.net/dota2/Liquipedia:Matches)
（原来的超凡电竞接口已不再响应）。使用它需要遵守
[Liquipedia API 条款](https://liquipedia.net/api-terms-of-use)：带能识别调用方的 User-Agent、
控制请求频率、署名并回链。代码里只在一页上取一次数据（30 分钟缓存），
页面上也保留了到 Liquipedia 的链接——改动这块时请一并保留。
