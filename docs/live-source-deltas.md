# 为什么 dart_simple_live 那种聚合直播，浏览器里跑不出同样的效果

对 [xiaoyaocz/dart_simple_live](https://github.com/xiaoyaocz/dart_simple_live)（默认分支 `master`）
做的一次源码核对，以及它和本仓库直播接入（`src/lib/liveStream.ts`、`src/lib/liveApi.ts`、
`src/scripts/liveWall.ts`）的差异。**每条结论都指向具体文件**，没有凭印象的推断。

这是一篇**对照阅读笔记，不是代码来源**：本仓库没有搬运它的代码。斗鱼那条签名链是按 streamlink
现在的实现思路自己写的（streamlink 是 BSD-2-Clause），而 dart_simple_live 走的是另一条路
（跑平台 JS 的 `homeH5Enc` + QuickJS）。它自己是 **GPL-3.0**——将来若要抄它的代码，得连同
GPL 一起接受，不能只挂 Apache-2.0。

## 0. 一句话结论

它不是「接入方式更聪明」，而是**形态不同**：解析请求和播放请求都不经过浏览器，所以斗鱼的
一次性 token、虎牙的签名与 UA、两家的 CORS 缺失，这些本仓库要硬碰的问题它压根不会遇到。
能平移过来的只有「编排」那一层（多线路预取、失败才换线、不探测），**不能平移的是原生 HTTP
栈与原生解码器**。

## 1. 它的形态：没有服务端，也没有 Web 端

- 顶层只有四块：`simple_live_core`（协议库）、`simple_live_app`（Flutter 客户端）、
  `simple_live_tv_app`、`simple_live_console`（GitHub 仓库 README 的「项目结构」一节）。
  **没有服务端组件、没有自建代理、没有浏览器端**。
- 网络层是 Dart 的 Dio：`simple_live_core/lib/src/common/http_client.dart`（构造函数里建
  `Dio(BaseOptions(...))`，全部请求走它）。
- 播放层是 `media_kit`（mpv 内核）：`simple_live_app/pubspec.yaml` 里
  `media_kit: ^1.2.2` / `media_kit_video` / `media_kit_libs_video`；
  `simple_live_app/lib/modules/live_room/player/player_controller.dart:30-56` 建
  `Player` 与 `VideoController`（`initializePlayer()` 只设 `ao` 与 Android 的
  `force-seekable`，没有网络/代理相关的特殊参数）。

所以 CORS、`Referer`/`Origin` 不可伪造、`User-Agent` 不能改、MSE 只吃 fMP4——这一整套浏览器
约束，它一个都不需要处理。

## 2. 斗鱼：`rate=-1` 拿清单，逐条 CDN 各换一条一次性地址

出处：`simple_live_core/lib/src/douyu_site.dart`

| 步骤 | 做什么 | 位置 |
| --- | --- | --- |
| 清晰度 | `POST https://www.douyu.com/lapi/live/getH5Play/{rid}`，body 追加 `&cdn=&rate=-1&ver=Douyu_223061205&iar=1&ive=1&hevc=0&fa=0`，读 `data.cdnsWithName` 与 `data.multirates` | `douyu_site.dart:95-133` |
| 地址 | **对上面每一个 cdn 各发一次** `getH5Play/{rid}`（带 `cdn=`/`rate=`），取 `rtmp_url` + `rtmp_live` 拼成播放地址 | `douyu_site.dart:134-170` |
| 请求头 | `referer: https://www.douyu.com/{rid}` + 桌面 Chrome UA（`douyu_site.dart:158-166`） | |
| 签名 | 房间详情的 `data` 是 `DouyuSign.getSign(crptext, rid)`，其中 `crptext` 来自 `swf_api/homeH5Enc` | `douyu_site.dart:213`、`douyu_site.dart:252` |

签名那条路值得单独说：`simple_live_core/lib/src/scripts/douyu_sign.dart` 内嵌整份 CryptoJS，
用 **QuickJS** 在运行时执行平台下发的混淆 JS（`simple_live_core/pubspec.yaml` 里
`dart_quickjs` 是 git 依赖；`getSign()` 里 `JsRuntime(...)` → `eval(kCryptoJs)` →
`eval(html)` → `ub98484234(rid, did, time)`）。**没有 JS 运行时就没法走这条路**。

本仓库走的是另一条（streamlink 2026 年重新启用的纯 MD5 链，见 `src/lib/liveStream.ts:12-25`
的函数头注释）：`betard` → `websec/getEncryption` → 纯 `md5` 迭代出 `auth` →
`getH5PlayV1`。**不需要 JS 运行时**，所以能在 Node / Workers 里跑。这是本仓库比它更轻的地方。

## 3. 虎牙：这条路在浏览器里基本不可能成立

出处：`simple_live_core/lib/src/huya_site.dart`

1. **依赖二进制协议**。线路（`sFlvUrl` / `sStreamName` / `sFlvAntiCode`）来自房间详情，
   但 `wsSecret` 要的 `sFlvToken` 来自 `getCdnTokenInfoEx`——一次 **TUP/Tars 二进制请求**
   （`BaseTarsHttp("http://wup.huya.com", "liveui")`，`huya_site.dart:19-29`、
   `huya_site.dart:300-308`）。浏览器里发不出，也读不了。
2. **antcode 是算出来的**。`buildAntiCode()`（`huya_site.dart:242-297`）把
   `md5(secretPrefix_calcUid_stream_md5(seqId|ctype|platformId)_wsTime)`、`seqid`、`ctype`、
   `t`、`fs`、`fm`、`u = rotl64(uid)` 拼成查询串；播放地址是
   `${line}/${streamName}.flv?${anticode}&codec=264`（`huya_site.dart:229-236`）。
3. **播放请求必须带自定义 UA**。`getPlayUrls` 返回 `headers: {"user-agent": HYSDK_UA}`，
   `HYSDK_UA = "HYSDK(Windows, 30000002)_APP(pc_exe&7060000&official)_SDK(trans&2.32.3.5646)"`
   （`huya_site.dart:19-20`、`huya_site.dart:224`）。**浏览器不允许改 UA**，
   而 `.flv` 只能靠 MSE 播 → 直连这条路直接封死。
4. 作者自己也知道 UA 会过期：`getHuYaUA()` 去拉
   `https://github.iill.moe/xiaoyaocz/dart_simple_live/master/assets/play_config.json`
   （仓库里的 `assets/play_config.json` 只有一条 `huya.user_agent`），**用远端配置替代发版**
   来换 UA（`huya_site.dart:192-207`），但代码注释里写着「最新 UA 需要额外验证，此方法暂时弃用」。

结论：虎牙要拿到可播的画面，**要么整段走原生/服务端转发，要么退回到平台自己的播放器页**——
本仓库选了后者（`src/data/site.ts` 的 `embedUrl()` → `liveshare.huya.com/iframe/{房间号}`），
这是被约束逼出来的，不是没做。

## 4. 「一次性 token」它为什么不会被咬到：播放环节只有一个人碰地址

`simple_live_app/lib/modules/live_room/live_room_controller.dart`：

- `getPlayQualites()` → 选一档 → `getPlayUrl()` → `getPlayUrl()` 里一次性取回**全部线路地址**，
  然后 `initPlaylist()` 把它们**整批**塞进 `Playlist(mediaList)`，每条 `Media` 带
  `httpHeaders: playHeaders`（`:345-435`）。
- 失败/断流时 `mediaError()` / `mediaEnd()` 只做两件事：重试同一路 1-2 次（`setPlayer()` →
  `player.jump(currentLineIndex)`），还不行就**换下一条线路**（`changePlayLine(index + 1)`），
  全部线路都断才判定下播（`:444-495`）。
- 全程**没有任何 HEAD / Range / 预加载去试探地址**，也没有把地址交给第二个组件。

对照本仓库：早期那个临时诊断端点会拿同一条直链请求三次探 CORS，
[直播](./live.md) 的「分屏页的画面」一节记着这个坑（「诊断脚本在播之前先用同一条地址探了三次
CORS，token 被消耗掉了」）；诊断代码连同端点
都已删除，生产上解析直链的只剩 `/api/live/stream-url`。
**这条经验两边是一致的：地址一旦被消费就作废。**

## 5. 差异总表

| 维度 | dart_simple_live | 本仓库（浏览器） |
| --- | --- | --- |
| 取数出口 | 客户端进程内（Dio） | 构建期 Node / SSR 端点 |
| 播放出口 | mpv（原生 HTTP + 原生解码） | `<video>` + mpegts.js（MSE） |
| CORS | 不适用 | 必须 CDN 给 `Access-Control-Allow-Origin`，否则只能服务端转发字节 |
| 自定义头 | 任意（UA / Referer / Origin） | 只剩 `Referer` 的「发 / 不发」一档（`referrerPolicy`） |
| 协议 | RTMP / FLV / HLS 都能吃 | 只剩 MP4/WebM（原生）与 FLV/HLS（MSE，需 CORS） |
| 虎牙 | TUP 二进制 + md5 anticode + HYSDK UA，全在进程内 | 无路可走，退回 `liveshare.huya.com/iframe/{id}` |
| 斗鱼 | `homeH5Enc` + QuickJS 跑平台 JS 签名；每 CDN 各一条地址 | 纯 MD5 签名链（不跑 JS）；`/api/live/stream-url` 每次点击解一条 |
| 断流处理 | 单次取回多线路，重试同路 → 换线 → 判下播 | 每次重播/换清晰度都重新解析（见 [直播](./live.md) 的「分屏页的画面」） |
| 弹幕 | `simple_live_core/lib/src/danmaku/*`（含抖音 protobuf） | 无 |

## 6. 可以平移 / 不能平移

能平移的（都不改架构）：

1. **多线路预取**：斗鱼 `getH5PlayV1` 的 `multirates` 之外还有 `cdnsWithName`，
   一次解析多拿几条不同 CDN 的地址，播放时按线路切换，省掉「断了再解析」的一次往返。
2. **失败才换线，不做健康检查**：与 `liveStream.ts` 现在「每次重播都重新解析」互补——
   重解析是 token 作废时的唯一出路，预取多线路是抖动时的更便宜出路。
3. **地址只交给播放器一个人**：诊断端点已经按这条原则删掉（`src/pages/api/live/probe.ts`，
   文件头自己写着「定案后应当删掉」），以后再加类似的探针也别往生产上放。

平移不了的：浏览器给不了自定义 UA / Referer，给不了 MSE 之外的解码器，也给不了不受 CORS
约束的 HTTP 栈。**虎牙、B 站、抖音在浏览器里只有「服务端转发字节」这一条路**，
而那意味着带宽和风控都落在自己身上——这是选型问题，不是实现问题。

## 7. 出处清单

- GitHub REST API：`repos/xiaoyaocz/dart_simple_live`（默认分支 `master`）、`git/trees/master?recursive=1`。
- 读过的文件（raw 直取）：`README.md`、`assets/play_config.json`、
  `simple_live_core/pubspec.yaml`、`simple_live_core/lib/src/{douyu_site,huya_site,bilibili_site}.dart`、
  `simple_live_core/lib/src/scripts/douyu_sign.dart`、
  `simple_live_core/lib/src/common/{http_client,custom_interceptor}.dart`、
  `simple_live_core/lib/src/model/live_play_url.dart`、`simple_live_core/lib/src/interface/live_site.dart`、
  `simple_live_app/pubspec.yaml`、
  `simple_live_app/lib/modules/live_room/live_room_controller.dart`、
  `simple_live_app/lib/modules/live_room/player/player_controller.dart`。
- 本仓库侧：`src/lib/liveStream.ts`、`src/lib/liveApi.ts`、`src/pages/api/live/stream-url.ts`、
  `src/data/site.ts`、`src/scripts/liveWall.ts`、[直播](./live.md)（「分屏页的画面」一节）。
