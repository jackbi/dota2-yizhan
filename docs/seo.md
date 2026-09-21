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
| sitemap | `@astrojs/sitemap` → `/sitemap-index.xml` + `/sitemap-0.xml` | 一次列全所有预渲染页面（英雄、装备、更新日志、赛事、战队、资讯与社区帖）；条数随当轮抓到的新闻、帖子与比赛浮动，不写死（最近一次构建 1029 条）。`prerender = false` 的几条（`/me`、`/api/*`）不会进去，`/community` 那条跳转也不会 |
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

**一个容易改错的地方**：线上 `robots.txt` 前半截是 Cloudflare 的 Content Signals 说明块——那是
Cloudflare 托管的策略文本，它**拼在你自己的 robots.txt 前面**一起返回。要改就改
`public/robots.txt`，不要把那段当成"我们的文件"去 Cloudflare 面板里找。

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
