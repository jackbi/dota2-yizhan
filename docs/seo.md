# SEO：现状、做了什么、还剩什么

先说结论，免得白花力气：**「dota2」这个词打不动**。那个位置是 Valve 官网、Dotabuff、OpenDota、
Liquipedia、NGA、虎牙斗鱼这些站在抢，一个刚上线、没有外链的中文小站挤不进首页——这不是技术
问题，是权重问题。能争取的是**长尾**，而且这个站的页面结构其实挺适合：

```
dota2 更新日志 7.41f      → /patches、/patches/<版本号>
dota2 敌法师 天赋 出装     → /heroes/1
dota2 赛事 赛程 今天       → /tournaments
dota2 BP 阵容 怎么禁       → /draft
dota2 开黑房间            → /party
dota2 分屏 看直播         → /live
```

## 已经做好的

| 东西 | 在哪 | 为什么 |
| --- | --- | --- |
| `site` 配置 | `astro.config.mjs` | sitemap 与 canonical 都要求绝对 URL；没有它，同一个页面会以 www / 尾斜杠 / 带参数几种形式各算一份 |
| sitemap | `@astrojs/sitemap` → `/sitemap-index.xml` + `/sitemap-0.xml` | 一次列全所有预渲染页面（英雄、装备、更新日志、赛事、战队、资讯与社区帖）；条数随当轮抓到的新闻、帖子与比赛浮动，不写死（最近一次构建 1000 条上下）。`/api/*` 与 `/community` 那条跳转不在里头；`/me/*`、`/settings`、`/login`、121 个薄装备页是**显式过滤**掉的——"`prerender = false` 的不进 sitemap"这句老话靠不住，见下面那两行 |
| robots.txt | `public/robots.txt` | 指路 sitemap；挡掉 `/api/` 与要登录的 `/me`。`/party` **不挡**——它对匿名访客也是 200 的公开页，「dota2 开黑」是真实流量 |
| canonical | `src/layouts/Layout.astro` | 每个页面自己声明主版本 |
| og / twitter 卡片 | 同上 | 分享到 NGA、贴吧、TG 群时给的是标题+描述+图，不然只剩一个裸链接 |
| JSON-LD | 同上 | `WebSite`（站点身份，url 必须是站点根）+ `WebPage`（当前页，url 用 canonical） |
| `BreadcrumbList` | 同上，详情页传 `breadcrumbs` 参数 | 搜索结果里能显示成 `dota2.hiwenbin.com › 英雄 › 敌法师`。**只有详情页给**——列表页没有层级，硬造一条是在喂假结构 |
| 页面标题与描述 | 各页面的 `Layout` 参数 | 从上线起就是每页独立的（`敌法师 · 英雄资料 · DOTA2 驿站` 这种），这是最值钱的一条，别退化成统一标题 |
| 英雄页 ↔ 版本页 互链 | `src/lib/patchHeroes.ts`、`patchNotes.renderHero` | 英雄页有「版本改动记录」（最多列最近 12 个版本），版本页里每个被改到的英雄名链回英雄页。用的是构建期已落盘的版本日志，不额外联网 |
| 英雄 / 装备列表在构建期渲染 | `src/pages/heroes.astro`、`src/pages/items.astro` | 这两页原先的主数据是客户端 `fetch` 现拉的，构建产物里**一个英雄名、一件装备名都没有**。百度基本不执行 JS，Google 的二次渲染又依赖 dota2.com.cn 的连通性，等于白做。改成构建期渲染后 HTML 里就有 127 / 229 个条目及其详情页链接，客户端只留筛选 |
| 装备详情页 | `src/pages/items/[id].astro`、`src/lib/itemCatalog.ts` | 520 个页面（`itemCatalog` 里那些有中文名的条目）。原先 614 件装备挤在 `/items` 一个 URL 里，标题只能写「装备资料库」，搜「闪烁匕首 合成」没有任何页面能承接。页面上的「升级为」是同一份数据反查出来的（192 件散件有去向），「版本改动记录」与英雄页共用同一套版本日志 |
| 薄页面不收录 | `src/lib/itemCatalog.ts` 的 `isThinItem`、`astro.config.mjs` 的 `sitemap-exclusions` | 121 个只有价格、一句描述都没有的条目（图纸、活动道具、部分中立物品）页面照旧生成——配方里点进去不能 404——但带 `noindex` 且不进 sitemap。**`@astrojs/sitemap` 不认页面的 noindex**（实测 520 个装备页一个没少），所以还得在配置里按 URL 过滤，判据共用一份 `isThinItem` |
| 版本页 ↔ 装备页 互链 | `src/lib/patchItems.ts`、`patchNotes.renderItem` | 与英雄那条对称：版本页里每个被改到的装备名链到 `/items/<内部名>`，装备页有「版本改动记录」（最多列最近 12 个版本）。全站实测 4017 个指向装备页的链接、零死链 |
| 404 页 | `src/pages/404.astro` | 原先没有，Cloudflare 拿默认页顶上，站内导航全丢。现在带 `noindex`（404 不该被收录）与六个板块入口；workerd 本地实测 `/no-such-page/`、`/heroes/nope/` 都是 404 + 这一页 |
| 对局复盘不收录 | `src/pages/replay/[id].astro` | 这条路由的 URL 空间是**无界**的（任何 Valve 比赛 id 都能渲染一页），对搜索引擎没有价值，而每次抓取都要打一次上游，所以带 `noindex`；它本来也是 `prerender = false`，不进 sitemap。入口在赛事对阵页与个人战绩页，读者照常点得进去。英雄攻略页那个入口只长在展开后的面板里（客户端拼出来的，不进服务端 HTML），所以没有多开一条抓取路径 |
| URL 形态只留一种 | `src/pages/heroes/[id]/guides.astro`、`src/pages/party.astro`、`src/pages/replay/[id].astro`、`src/pages/login.astro` | 预渲染页由 Cloudflare 的静态资源规则收口（`/tournaments` 会 307 到 `/tournaments/`，带斜杠那版才是它的规范形态），天生只有一个地址；**SSR 路由两种写法都会 200**，而 canonical 是照 `Astro.url.pathname` 拼的，于是两个地址各指自己，Google 只能自己挑主版本，没被挑中的那半就报「重复网页，Google 选定了与用户不同的规范网页」（Search Console 上成片出现的就是这条）。攻略页、复盘页与登录页 301 到**不带**斜杠那版（页内与英雄页、比赛页、`/me` 的链接就是这形式），`/party` 301 到**带**斜杠那版（sitemap 登记的是这个形式，导航链接也跟着改了）。**新增 SSR 路由时要照这个收口**，`scripts/linkForm.check.ts` 会盯着 |
| 站内链接照规范形态写 | 全站 129 处 `href`、`scripts/linkForm.check.ts` | 链接指向哪个形态，搜索引擎就先去爬哪个形态。原先站内一律写成不带斜杠的 `/heroes/1`、`/items/blink`，于是**每一条链接都指向一个会 307 的地址**——2026-10 的 Search Console 里「网页会自动重定向」那一栏堆的就是这批自己交上去的 URL。现在一律照各路由的规范形态写（预渲染页带斜杠，SSR 路由按上一条收口），并加了 `linkForm.check` 钉住**形态**与**落地页是否存在**两件事：形态错了页面照样能看，人眼发现不了 |
| `/me/*`、`/settings`、`/login` 不进 sitemap | `astro.config.mjs` 的 `sitemap` filter | `robots.txt` 已经 `Disallow: /me`，匿名访问还会 302 到 `/login`。实测 `@astrojs/sitemap` **会把静态的 SSR 路由一起列进来**（`/party/`、`/login/` 与 6 条 `/me/*` 都在），只能在这里显式挡掉——否则 Search Console 会分别报「已提交的网址被 robots.txt 屏蔽」与「已提交的网址会重定向」（`/login/` 提交的是带斜杠那版，而 `/login` 与 `/login/` 都 200、各指自己）。这三条对外的内容价值都是零：一个是登录入口，一个是填 key 的个人配置页 |

**一个容易改错的地方**：线上 `robots.txt` 前半截是 Cloudflare 的 Content Signals 说明块——那是
Cloudflare 托管的策略文本，它**拼在你自己的 robots.txt 前面**一起返回。要改就改
`public/robots.txt`，不要把那段当成"我们的文件"去 Cloudflare 面板里找。

## Search Console 报的那三条（2026-10）

Google 的邮件列了三个「新原因」：未找到 (404)、网页会自动重定向、被 noindex 标记排除。
逐条对着线上抓取核过，结论是**一条是我们的问题、一条是有意为之、一条是聚合站的结构问题**。

### 网页会自动重定向 —— 站内链接写错了形态（已改）

站内链接原先一律写成不带尾斜杠的 `/heroes/1`、`/items/blink`、`/teams/lp-team-og`，而预渲染页的
规范形态是**带**斜杠的（Cloudflare 的静态资源规则就是这么收口的：不带斜杠的地址 307 到带斜杠那版，
sitemap 与 canonical 用的也是带斜杠的）。两边不一致，等于**站内每一条链接都指向一个会重定向的地址**。

改法是把 129 处 `href`（含面包屑、`NAV`、`BreadcrumbList` 里的 `item`、以及 `patchNotes` 那种
拼 HTML 的字符串）统一写成各路由的规范形态，并加了 `scripts/linkForm.check.ts` 钉住。SSR 路由的
两种形态另有一层收口（见上表「URL 形态只留一种」），这次把 `/replay/<id>` 也补上了。

顺带记一笔**没改的**：`/community` 这条老地址跳到 `/news#nga`，而 `/news` 还会被 307 补一次斜杠，
等于白跳两跳。它不在任何链接与 sitemap 里（只有老链接会走到），而把目标改成 `/news/#nga` 要赌
Cloudflare `_redirects` 怎么解析目标里的 `#` —— 赌错的代价是丢掉那个锚点，收益只有一跳，不值得。

### 被 noindex 标记排除 —— 有意为之（不用治）

121 个「只有价格、一句描述都没有」的装备页，加上 URL 空间无界的 `/replay/<比赛 id>`，都带
`noindex`（理由见上表两行）。它们照旧生成、照旧能从站内点进去，只是不交给搜索引擎。
Search Console 会把它们列进「未编入索引」，这是设计的一部分，不是故障。

### 未找到 (404) —— 一半是自己造的（已修），一半是聚合站的换血（待定）

#### 自己造的：Reddit 跨版转发的外链是相对地址（已修）

Reddit 的跨版转发（crosspost）在列表里给出的目标地址是 `/r/DotaConcepts/comments/…/` 这样的
**站内相对路径**。照原样渲染出来，那个 `href` 就落在我们自己域名下——点下去是我们自己的 404 页
（实测线上 `/r/DotaConcepts/comments/1wdyar2/…` 就是 404，一轮构建里有 11 条）。
现在两条取数路径与**缓存读取**都在 `src/lib/redditApi.ts` 的 `absoluteRedditUrl()` 里补成绝对地址
——只改解析侧不够：缓存里躺的是当年解析出来的对象，不顺手补一遍就得等它自己过期。

顺带把这套「产物级的死链」核对方式也做了一遍：整轮构建的 1121 个页面、47905 条站内页面链接，
形态全对、**零死链**。以后再动链接，用同样的办法抽查一次产物即可（`pnpm check` 里的
`linkForm.check` 管源码，产物那一遍要 build 之后才能跑）。

#### 结构性的：详情页只活一轮

成因是结构性的：`/matches/<id>`、`/news/<id>`、`/news/reddit/<id>`、`/news/wmpvp/<id>`、
`/community/{nga,hupu}/<id>` 这些详情页是**每轮构建按「当前列表」现生成的**，而列表窗口很窄
（完美世界一次 20 条、Reddit 每个版块若干、NGA 与虎扑是热帖榜、赛事是当前赛程窗口）。
下一轮重建时滑出窗口的那些页面就从产物里消失了——Google 上一轮已经收录，这一轮就报 404。

实测过一轮：把 9 月 30 日与 10 月 8 日的两份 sitemap 相减，**182 个地址消失**（对阵 78、资讯 57、
社区 40、战队 5、赛事 2），抽查 15 个全部 404。站点每半小时重建一次，所以这不是偶发，是持续换血。

两条路，先把「这些镜像页是资产还是快照」定下来：

| 方案 | 做法 | 代价 |
| --- | --- | --- |
| **留档**（倾向这条） | 把详情页用到的数据（列表项 + 详情）按家族落到 `.cache/`，`getStaticPaths` 把「当前列表」与「留档」并起来生成；详情页在留档状态下只用缓存、不联网 | 产物与部署体积会涨——`/news/wmpvp/*` 的正文配图是抓回站内的，留档等于把它们一起留在 `dist/`（实测单张 0.2MB 上下）；`/matches/*` 还得把系列赛数据一起留档，否则每轮重建都要为几百场旧比赛重新问一遍 STRATZ |
| **当快照** | 这几族不进 sitemap，页面照旧只活一轮 | 收录会明显变慢变少（这几族本来是这个站的 SEO 主力），而且 Google 仍会从站内链接爬到、仍会有 404，只是量小些 |

留档要动 `getStaticPaths`、详情数据的取用路径（`fetchThreadDetail` / `fetchHupuThreadDetail` 那类
要能「只用缓存、不联网」）与一份回收策略（按条数或天数封顶），属于要单独一轮构建验证的改动。

## 只有站点主能做的（需要账号）

1. **百度搜索资源平台**（<https://ziyuan.baidu.com>）：验证站点 → 提交
   `https://dota2.hiwenbin.com/sitemap-index.xml` → 用「普通收录」的 API 主动推送新页面。
   中文流量大头在这儿，但它对海外主机 + Cloudflare 的抓取本来就慢，主动推送是唯一有效的加速。
2. **Google Search Console**：验证 → 提交同一份 sitemap。抓取与收录最快。
3. **Bing Webmaster Tools**：同样提交一次（顺带覆盖 ChatGPT 之类用 Bing 索引的问答入口）。

三家的验证都支持「DNS TXT 记录」或「HTML 文件放到 public/」两种方式。走文件方式的话把验证文件
放进 `public/`，构建会自动发布出去（`public/` 下的东西原样进产物）。

## 下一步还能做的

- **每页唯一的 og:image**：现在全站共用 logo；英雄页用英雄头像、赛事页用队标，分享出去的点击率
  会明显不同。
- **别做的事**：关键词堆砌、给同一份内容造多个 URL、买外链。前两个会被判定作弊，第三个对这个
  体量的站毫无性价比。
