# 构建、缓存与部署

内容页全部在构建期抓取 + 预渲染，站点是 `output: static`；只有登录相关的那几条路由按请求渲染，
它们在 [Steam 登录与个人战绩](./player-profile.md) 里。这篇讲数据怎么来、产物长什么样、
怎么上线、以及多久重建一次。

## 数据都是构建期抓取的

站点是 `output: static`，内容页没有任何运行时请求：所有数据在构建时（dev 下是渲染
页面时）由 Node 抓取，再渲染成静态 HTML。抓取结果落在 `.cache/`：

**唯一的例外**是「Steam 登录 + 个人战绩」（见 [Steam 登录与个人战绩](./player-profile.md)）：
那几条路由是 `prerender = false`，按请求在服务端向 STRATZ 取数。它们不参与 `.cache/`，
理由与做法写在同一篇里。

| 目录 | 内容 | 缓存时长 |
| --- | --- | --- |
| `.cache/news/` | dota2.com.cn 官方新闻列表与正文 | 列表 30 分钟，正文永久 |
| `.cache/patches/` | dota2.com 版本列表、每个版本的更新日志、英雄/物品/技能名字表 | 列表 30 分钟，其余 7 天 |
| `.cache/community/` | NGA 刀塔版块热帖与楼层、虎扑 DOTA2 区列表与帖子详情 | 列表 30 分钟，帖子 2 小时 – 7 天 |
| `.cache/reddit/` | r/DotA2 与 r/compDota2 热帖 | 1 小时 |
| `.cache/opendota/` | 队伍索引、职业比赛、阵容名单 | 6 小时 – 7 天 |
| `.cache/stratz/` | BP 与选手明细、一周英雄数据 | 1 小时 – 30 天 |
| `.cache/translate/` | 机器翻译结果 | 永久 |
| `.cache/liquipedia/` | Liquipedia 赛程页解析结果 | 30 分钟 |
| `.cache/live/` | 斗鱼 / 虎牙各直播间的开播状态 | 5 分钟 |
| `.cache/roomlist/` | 斗鱼 / 虎牙 DOTA2 分区的热门房间列表 | 30 分钟 |
| `.cache/avatars/` | 主播头像的字节（构建结束拷进 `dist/avatars/`） | 永久，30 天没用到就清理 |
| `.cache/covers/` | B站视频封面的字节（构建结束拷进 `dist/covers/`） | 永久，30 天没用到就清理 |
| `.cache/patch-heroes/` | 更新日志里的英雄图标（构建结束拷进 `dist/patch-heroes/`） | 永久，30 天没用到就清理 |
| `.cache/patch-items/` | 更新日志里的物品图标（构建结束拷进 `dist/patch-items/`） | 永久，30 天没用到就清理 |
| `.cache/tournaments.json` | 聚合后的赛事日历 | 每次拿到完整日历就覆盖 |
| `.cache/health/` | 各数据源本轮的抓取结果 | 每次构建开始时清空 |

上面那些「永久」指的是**读取时不判过期**，不等于文件会一直留着。每轮构建开头会扫一遍
（`astro:build:start`）：

- 图片频道（avatars / covers / patch-heroes / patch-items）走 `pruneImages()`：**30 天没被用到**
  就删——`localImages()` 每次命中都会把 mtime 刷成当前时间，所以这里的 mtime 是「上次用到」。
- 其余目录走 `pruneCacheDirs()`：**180 天没写过**的 JSON / HTML 删掉，外加任何年龄的 `*.tmp`
  写入残留。这里的 mtime 是「上次写入」——命中缓存不刷新它，只有真联网抓回来才写，所以窗口给得
  很宽：删早了的代价是上游恢复后本来能命中的兜底缓存没了。
- 写入是**原子的**（`buildCache.writeCacheFile()`）：先写 `<file>.<pid>.<序号>.tmp` 再 `rename`。
  Astro 并行开多个渲染进程、同时读写同一个 `.cache/`，就地 `writeFile` 的中间态会被读到——JSON
  读坏只算没命中，但正文那份缓存的 TTL 是「永久」，半截 HTML 一旦被当成新鲜命中就永远不会重抓，
  所以正文读的时候还多一条 `isCompleteHtml()` 校验。

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
[data-source-report]   官方更新日志 — 联网抓取：118 个版本，最新 7.41f（2026-09-15），联网抓取 1 次
[data-source-report]   赛事日历 — 联网抓取：7 个赛事，1 场进行中；来源：Liquipedia / OpenDota
```

没有数据的源排在最前面。原始记录在 `.cache/health/`，dev 下不会自动汇总，可以直接翻。

## 两套 adapter：默认 Node，`DEPLOY_TARGET=cloudflare` 出 Workers 产物

Node 是为了「本地能跑、能自托管」。Cloudflare 的适配器也装着了，用环境变量切：

```sh
pnpm build                              # 默认 → @astrojs/node，产物给 node dist/server/entry.mjs
DEPLOY_TARGET=cloudflare pnpm build     # → @astrojs/cloudflare，产物给 wrangler 上传
```

切换只影响 `astro.config.mjs` 里 `adapter:` 那三行，**路由与页面不用动**——SSR 侧代码
刻意只用 Web 标准 API：

- `src/lib/session.ts` 用 `crypto.subtle` 签 Cookie，不碰 `node:crypto`；
- `src/lib/stratzPlayer.ts` 与 `src/lib/ssrCache.ts` 只用 `fetch` + 内存 Map，不碰 `node:fs`；
- 密钥统一从 `astro:env` 读，Workers 下会自动接到运行时绑定上。

Cloudflare 侧有三个配置是**必须**的，都是实测踩出来的（原因写在 `astro.config.mjs` 的注释里）：

- `prerenderEnvironment: 'node'`——预渲染默认跑在 workerd 里，而那里面的 `fetch` 不认
  `HTTP_PROXY`，构建到 `/live` 会直接 `TypeError: fetch failed`；
- `imageService: 'passthrough'`——图片是自己下载发布成静态文件的，不用 Astro 的图片服务；
- `session: false`——站点用自己签名的 Cookie，关掉它，适配器就不会再自动建一个用不上的 KV。

**`astro dev` 仍然走 Node adapter**（也就是别加 `DEPLOY_TARGET=cloudflare`）：CF adapter 的 dev
跑在 workerd 里，而 `astro.config.mjs` 里 `imagesInDev` 那段 dev 中间件用了 `node:fs` 读图片字节，
要跑起来得先改它。

## 发布到 Cloudflare Workers

```sh
pnpm exec wrangler login                  # 只需一次
pnpm exec wrangler secret put SESSION_SECRET
pnpm exec wrangler secret put STRATZ_TOKEN
pnpm deploy                               # = DEPLOY_TARGET=cloudflare astro build && wrangler deploy
```

本地先看一眼效果（workerd 里跑真产物，不是 `astro dev`）：把开发用的密钥写进根目录 `.dev.vars`
（已在 `.gitignore`），然后 `pnpm exec wrangler dev`。

变量对号入座：**服务端运行时**要用的两个密钥走 `wrangler secret put`（加密存储，既不进仓库也不进
`wrangler.jsonc`），其余非敏感的（`SITE_URL`）写进 `wrangler.jsonc` 的 `vars`；**构建期**那些
（`LIVE_PROXY`、`LIQUIPEDIA_CONTACT` 之类）仍然只在本机的 `.env` 里读，Cloudflare 不参与构建。
完整清单见 README 的「[环境变量](../README.md#环境变量)」。

`wrangler.jsonc` 里两处容易写错：

- `main` 必须写 `@astrojs/cloudflare/entrypoints/server` 这个包名，**不能写 `dist/server/entry.mjs`**：
  Cloudflare 的 Vite 插件在配置阶段就要求 `main` 指向一个已存在的文件，写产物路径会以
  `doesn't point to an existing file` 直接中止构建。真正的产物布局由适配器接管——构建完它会生成
  `dist/server/wrangler.json`（`main: entry.mjs`、`assets.directory: ../client`），
  `.wrangler/deploy/config.json` 负责把 `wrangler deploy` 重定向过去。
- `SITE_URL` 换成真实域名。它拼的是 Steam OpenID 的 `realm` / `return_to`，配错会在回调那一步失败。

产物形态：`dist/client/` 是静态资产（约 1550 个文件、23 MB），`dist/server/entry.mjs` 是 Worker
（800 KiB，gzip 205 KiB），图片频道照旧发布进 `dist/client/avatars` 这些目录。免费额度够用——
静态资源请求免费且不限量，Worker 请求 10 万/天，资产文件上限 2 万/版本、单个不超过 25 MiB；
几条 SSR 都是 I/O 等待，10 ms 的 CPU 上限咬不到。

**构建留在自己机器上，别交给 Workers Builds。** 它的构建缓存只覆盖 pnpm store 与
`node_modules/.astro`，**不含 `.cache/`**，于是每轮都是冷构建，还要从 Cloudflare 的出口去抓
NGA / Reddit / 斗鱼 / 翻译，被风控的概率比本机高得多。所以定时重建仍然跑在
`scripts/rebuild.sh` 那台机器上，只是把「切换产物 + 重启进程」换成 `wrangler deploy`——
wrangler 上传资产走 `check-missing`，没变的文件不会重传。

两件**上线前必须实测**的事：

- **STRATZ 的 token 绑出口 IP。** 运行时取个人战绩是从 Cloudflare 边缘出去的，和本机不是同一个
  出口，同一个 token 原样上去必然 403——而且本地用 workerd 也测不出来，因为请求还是从本机出去
  （实测 `/api/steam/profile` 在本地 workerd 里是通的）。要么在那边重新生成 token 并接受它可能
  漂移，要么给 STRATZ 调用加一层固定出口的中转。
- **斗鱼直连能不能从 Cloudflare 出去。** `/api/live/stream-url` 是运行时解析直链，本机 workerd
  里实测是 `Network connection lost.`（本机直连斗鱼会被重置，平时靠 `LIVE_PROXY` 走代理）。
  这条只在部署后能验；解析不到只会退回取景兜底，不会白屏。

## STRATZ 走固定出口中转

STRATZ 的 token **绑定调用方 IP**，换了出口就 403（纯文本 `You cannot use different IP
Addresses when using the API.`）。而站点的两条取数路径都没有稳定出口：运行时的个人战绩跑在
Workers 上，边缘出口按 colo 漂；构建期跑在开发机上，平时挂着代理，代理组一自动选节点出口就变。

所以 token 交给一台**出口固定**的机器（你自己的服务器）持有，其它地方只带一个中转口令跟它说话。
中转本体是 `scripts/stratz-relay.mjs`，没有任何依赖，只用 `node:http` 和一个 `fetch`。

### 服务器上：跑起中转

```sh
# 1) 密钥文件（只有这台机器需要真正的 token）
openssl rand -hex 32          # 生成 RELAY_TOKEN，记下来，客户端也要填这个
sudo tee /etc/stratz-relay.env >/dev/null <<'EOF'
STRATZ_TOKEN=<stratz.com/api 新生成的 token>
RELAY_TOKEN=<上面那串>
EOF
sudo chmod 600 /etc/stratz-relay.env

# 2) 直接跑一下（确认能启动；HOST 默认只监听 127.0.0.1，外面交给反代）
node /srv/dota2-news/scripts/stratz-relay.mjs
```

交给 systemd：

```ini
# /etc/systemd/system/stratz-relay.service
[Unit]
Description=STRATZ 固定出口中转
After=network-online.target

[Service]
WorkingDirectory=/srv/dota2-news
EnvironmentFile=/etc/stratz-relay.env
Environment=HOST=127.0.0.1
Environment=PORT=8788
ExecStart=/usr/bin/node scripts/stratz-relay.mjs
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
```

再给反代加一个前缀（nginx 为例；TLS 证书照你现有站点的做法挂上）：

```nginx
location /stratz/ {
    proxy_pass http://127.0.0.1:8788/;
    proxy_set_header Host $host;
    client_max_body_size 256k;
}
```

**绑定 token**——这是整件事的目的，新 token 的第一次调用要从中转发出去：

```sh
curl -s http://127.0.0.1:8788/probe -H "x-relay-token: $RELAY_TOKEN"
# {"status":200,...}  → 绑定成功，STRATZ 认的就是这台机器的出口 IP
# {"status":403,...}  → token 已经绑在别处了，去 stratz.com 重新生成一个再来
```

`GET /healthz` 不需要口令（监控用），`POST /graphql` 与 `GET /probe` 都要
`x-relay-token`，body 上限 256 KB，只认这两个路径——它不是一个通用代理。

### 没有 Node？用 nginx 直接中转

中转不必是一个常驻进程：nginx 自己就能补上那个 `Authorization` 头，把这台机器变成固定出口。
实测部署的那台 OpenCloudOS 9 上根本没装 Node，直接走的这条路。密钥单独放一个 600 的文件、
由 location `include` 进来，别混进主配置：

```nginx
# /etc/nginx/stratz-relay-secrets.conf（chmod 600，只有 nginx master 读得到）
set $stratz_relay_token "<RELAY_TOKEN>";
set $stratz_upstream_auth "Bearer <STRATZ_TOKEN>";
```

这个入口的处境是「域名公开 + 唯一门锁是一个静态口令」，所以还得补两件基础设施的事，
缺了等于没有防护。**限流**属于 `http` 块（`include /etc/nginx/conf.d/*.conf` 就在该块里，
写在 conf 文件顶部即 http 级）：

```nginx
limit_req_zone $binary_remote_addr zone=stratz_relay:1m rate=20r/s;
```

**真实 IP**：机器前面挂着 Cloudflare 时 `$remote_addr` 是 CF 边缘 IP，照它限流等于把同一个
CF 节点的所有访客塞进一个桶。按官方网段信任 `CF-Connecting-IP`（网段取自
https://www.cloudflare.com/ips/ 逐条列出；直连源站的请求不在名单里，伪造这个头不会被接受）：

```nginx
# /etc/nginx/conf.d/00-cloudflare-realip.conf，v4 15 条 + v6 7 条
set_real_ip_from 173.245.48.0/20;
# …
real_ip_header CF-Connecting-IP;
```

```nginx
# 口令校验放在子请求里，不要写成 `if (...) { return 401; }`：if 在 rewrite 阶段就返回，
# 而 limit_req 在 preaccess 阶段执行——没口令的洪水正好绕过限流。
location = /stratz/authz {
  include /etc/nginx/stratz-relay-secrets.conf;
  internal;                                  # 只接受内部子请求
  if ($http_x_relay_token != $stratz_relay_token) { return 401; }
  return 204;
}

location = /stratz/graphql {
  include /etc/nginx/stratz-relay-secrets.conf;
  limit_req zone=stratz_relay burst=60 nodelay;
  limit_req_status 429;
  auth_request /stratz/authz;
  limit_except POST { deny all; }
  client_max_body_size 256k;

  proxy_pass https://api.stratz.com/graphql;
  proxy_ssl_server_name on;                  # 少了这句 SNI 对不上，Cloudflare 直接拒
  proxy_set_header Host api.stratz.com;
  proxy_set_header User-Agent STRATZ_API;    # STRATZ 只放行这个 UA
  proxy_set_header Accept application/json;
  proxy_set_header Content-Type application/json;
  proxy_set_header Authorization $stratz_upstream_auth;
  proxy_pass_request_headers off;            # 调用方自己的头一律不带上去
  proxy_http_version 1.1;
  proxy_connect_timeout 10s;
  proxy_read_timeout 30s;
}

# 监控用，不需要口令
location = /stratz/healthz { return 200 "ok\n"; }
```

两处阈值与写法的来历，都是实测出来的：

- 把口令校验挪进 `auth_request`，是为了让**没口令的洪水也受限流约束**。实测用错口令并发
  打 200 发：169 个 401、31 个 429；洪水停下、桶回满后正常请求立刻恢复 200。
- `burst=60` 而不给紧值，是因为 Worker 打这个入口时服务器看到的源地址是 Cloudflare 自己的
  （实测 `2a06:98c0:3600::103`），**全站 Worker 共用一条限流桶**，`rate=20r/s` 是合计上限，
  不是单个访客的上限。访客那侧有真实 IP，按人分桶。

改完 `nginx -t && nginx -s reload`。上游域名是在启动/重载时解析的，STRATZ 换了 IP 要再 reload 一次。

绑定与验证（和 Node 版等价，只是没有 `/probe`，直接打一条最小查询）：

```sh
curl -s -X POST https://<你的域名>/stratz/graphql \
  -H "x-relay-token: $RELAY_TOKEN" -H 'Content-Type: application/json' \
  -d '{"query":"{ __typename }"}'
# {"data":{"__typename":"DotaQuery"}}       → 绑定成功
# You cannot use different IP Addresses…   → token 已绑在别处，去 stratz.com 重新生成
```

### 轮换中转口令

地址是公开的，口令是静态共享的，那「它有没有见过光」就是唯一的防线。一旦怀疑泄漏（贴进 issue、
截过图、进过日志），**两头一起换**，只换一头就是全线 401：

1. 服务器：改 `/etc/nginx/stratz-relay-secrets.conf` 里的 `$stratz_relay_token`（Node 版改
   `/etc/stratz-relay.env`），再 `nginx -t && nginx -s reload`（Node 版 `systemctl restart stratz-relay`）。
2. 客户端：`pnpm exec wrangler secret put STRATZ_RELAY_TOKEN` 填同一个新值，本机 `.env` 同步。

STRATZ 那份 token 不必跟着换——它绑在这台机器的出口 IP 上，换地方调用会被官方 403 挡掉。真要作废
它，去 stratz.com 重新生成，替换 `$stratz_upstream_auth` 即可。

### 客户端：两边都改成走中转

| 位置 | 要配的东西 |
| --- | --- |
| Worker | `wrangler.jsonc` 的 `vars` 里加 `STRATZ_RELAY_URL`（`https://<你的域名>/stratz/graphql`），再 `pnpm exec wrangler secret put STRATZ_RELAY_TOKEN` |
| 本机构建 | `.env` 里加同样的两条（`STRATZ_RELAY_URL` + `STRATZ_RELAY_TOKEN`） |

两个都配才生效，**配了就一律走中转**；只配一半时按「没开这个功能」处理并把原因写进日志，不会
偷偷退回直连（那样你以为走的是固定出口，其实没有）。这条分支有 `scripts/stratzEndpoint.check.ts`
盯着，改动时 `pnpm check` 会拦住。

走中转之后，`STRATZ_TOKEN` 就不该再出现在 Worker 与本机的环境变量里——那份 token 只属于服务器。
Runtime 侧遇到中转自己回的 401（两边口令不一致）会直接说清楚，不会含糊成「HTTP 401」。

## 部署与重建频率

内容页都是构建期抓取 + 预渲染，所以**内容的新鲜度 = 你多久重建一次**。`.cache/` 的 TTL
表（直播状态 5 分钟、新闻/社区/赛程 30 分钟、Reddit 1 小时…）决定的是「这一轮要重新抓
哪些」，它需要一个触发者。

**Cloudflare Workers 这条路已经接好了**：`.github/workflows/rebuild.yml` 每 30 分钟
（cron `17,47 * * * *`）跑一轮 `pnpm check` → `astro build` → `wrangler deploy`，
也能用 `workflow_dispatch` 手动跑一次。换仓库或换账号时需要配这些 repo secret：

| secret | 用途 |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | 部署。用 Cloudflare 的「Edit Cloudflare Workers」模板生成 |
| `CLOUDFLARE_ACCOUNT_ID` | 部署。`wrangler whoami` 输出里的那串 |
| `STRATZ_RELAY_URL` / `STRATZ_RELAY_TOKEN` | 构建期取 STRATZ（同上面「客户端」一节） |
| `LIQUIPEDIA_CONTACT` | Liquipedia 要求 User-Agent 里带联系方式 |
| `REDDIT_CLIENT_ID` / `REDDIT_CLIENT_SECRET` | 构建期取 Reddit。不配也能跑，但匿名端点连抓两个版块，第二个就 429（0.3.1 那一轮 Reddit 赛事讨论整栏是空的）；生成步骤见 `scripts/reddit-oauth.setup.sh`。Reddit 已关掉自助建应用，拿不到新 client id 时只能走申请，详见 `docs/data-sources.md` |

`.cache/` 用 `actions/cache` 滚动接上一轮，所以每轮只有过期的源会重抓。**第一轮是冷构建**：
实测在 GitHub runner 上 3 分 31 秒，17 个源全部抓到，斗鱼/虎牙/OpenDota 都通，不需要代理。
Worker 上已有的 secret（`SESSION_SECRET` 等）不受 `wrangler deploy` 影响。

两件要有心理准备的事：定时任务在**仓库 60 天没有任何活动**之后会被 GitHub 自动停用（会提前
发邮件），随便推一个 commit 就恢复；GitHub 的定时队列在整点最挤，实测常延迟十几分钟，
所以页面上的「数据更新于」不会精确卡在 :17/:47。

**自托管（Node）这条路仍然要自己接触发者**，见下面的 cron 与 systemd timer。

没有触发者的后果很具体：直播状态标称 5 分钟，实际是「上次构建那一刻」，可能已经过去几天。
（真实发生过：赛程页在线上停了三天，而且不只是没人重建——构建本身被一个带 `/` 的队名打断，
见 `routeSlug`。）

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

跑在 Cloudflare Workers 上时这一环换成 `pnpm deploy`（见上面「发布到 Cloudflare Workers」一节）：
没有进程可重启，`wrangler deploy` 上去就是新版本，HTML 也不用再手工刷缓存。代价是每轮都要把
变更过的资产传一遍，所以间隔给到 30 分钟（对齐新闻/赛程那一档）比 5 分钟更合适；真要 5 分钟级的
开播状态，更适合把它挪成运行时接口、交给边缘缓存。
