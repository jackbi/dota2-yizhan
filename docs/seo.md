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
| sitemap | `@astrojs/sitemap` → `/sitemap-index.xml` + `/sitemap-0.xml` | 一次列全 **520 个预渲染页面**（英雄、物品、更新日志、赛事、战队、新闻、社区帖）。`prerender = false` 的几条（`/me`、`/api/*`）不会进去 |
| robots.txt | `public/robots.txt` | 指路 sitemap；挡掉 `/api/` 与要登录的 `/me`。`/party` **不挡**——它对匿名访客也是 200 的公开页，「dota2 开黑」是真实流量 |
| canonical | `src/layouts/Layout.astro` | 每个页面自己声明主版本 |
| og / twitter 卡片 | 同上 | 分享到 NGA、贴吧、TG 群时给的是标题+描述+图，不然只剩一个裸链接 |
| JSON-LD | 同上 | `WebSite`（站点身份，url 必须是站点根）+ `WebPage`（当前页，url 用 canonical） |
| 页面标题与描述 | 各页面的 `Layout` 参数 | 从上线起就是每页独立的（`敌法师 · 英雄资料 · DOTA2 驿站` 这种），这是最值钱的一条，别退化成统一标题 |

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

- **详情页的 `BreadcrumbList`**：`赛事 → 战队 → 比赛`这种层级在搜索结果里能显示成面包屑，
  比自己写一行标题更容易被点。
- **内页互链**：现在比赛页→队伍页→赛事页的链有，但英雄页与更新日志之间（「7.41f 里这个英雄改了
  什么」）没连起来。内链是权重在站内流动的唯一途径，比堆关键词有用。
- **每页唯一的 og:image**：现在全站共用 logo；英雄页用英雄头像、赛事页用队标，分享出去的点击率
  会明显不同。
- **别做的事**：关键词堆砌、给同一份内容造多个 URL、买外链。前两个会被判定作弊，第三个对这个
  体量的站毫无性价比。
