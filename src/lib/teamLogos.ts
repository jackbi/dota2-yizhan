/*
 * 带 `.ts` 后缀是有意的：`scripts/teamLogos.check.ts` 直接用 node 跑这个模块，
 * 而 node 的 ESM 解析不认省略后缀的路径（同一个原因见 `liquipediaParse.ts`）。
 */
import type { ImageChannel } from './localImages.ts';
import { localizeImages } from './localImages.ts';
import type { TeamLogoRef } from './teamLogoSource.ts';
import { teamLogoSources } from './teamLogoSource.ts';

/**
 * 战队队标：构建期从 Liquipedia 取回来，换成本站路径。
 *
 * 改之前每个队标都是热链 `liquipedia.net` 的缩略图——对阵行、对阵页、战队页、赛事页
 * 加起来两千八百多个 `<img>` 指着人家的服务器。理由和 `avatars.ts`、`covers.ts` 那边记的是同一套：
 * 允不允许外链由对方说了算、访客的 IP 与 Referer 白送出去、出不出图取决于访客走的哪条线路。
 * 顺带还省了一件事——热度全在构建机上打，访客不再各自去敲一次。
 *
 * ## 尺寸：不放大来源
 *
 * 队标显示在 64px 的方框里（`h-16 w-16`），2x 屏就是 128，所以频道按 128 配。
 * 但 **Liquipedia 赛程页给的就是它自己按版面缩好的小图**（实测 36–100px 不等），
 * 把它改写成 `128px-` 试过，46 个里有 18 个直接 404——原图本来就没那么大，
 * Liquipedia 对超过原图宽度的缩略图请求是拒绝的而不是放大。所以这里按原样取回来，
 * 落盘的就是那张缩略图，页面上的清晰度和热链时期一样，不会更差。
 *
 * 真正的高清队标要等战队页那条线：Liquipedia 战队页的 Infobox 里带 Valve 队伍 id
 * （`teamid=2163`），拿它换 STRATZ 的 `cdn.stratz.com/images/dota2/teams/<id>.png`——
 * 实测是 13–53KB 的 PNG，尺寸和清晰度都够。
 */
export const TEAM_LOGO_CHANNEL: ImageChannel = {
	dir: 'teamlogos',
	width: 128,
	height: 128,
	maxBytes: 512 * 1024,
	concurrency: 4,
};

/**
 * 把一批队标取回本地，返回 `队伍 id → /teamlogos/xxx.jpg`。
 *
 * 拿不到的队伍不会出现在返回值里，调用方据此保留原外链——所以不会出现破图，
 * 这一点和 `localizeAvatars()`、`localizeCovers()` 一致。
 *
 * 用队伍 id 而不是图片地址当键：队标换了（改版、换赞助商）文件名跟着地址哈希变，
 * 缓存的旧文件会在 30 天后被清掉，调用方不用跟着改任何查询方式。
 *
 * 「哪些要去下载」那条判据在 `teamLogoSource.ts`（纯函数，有自检）。
 */
export function localizeTeamLogos(teams: TeamLogoRef[]): Promise<Map<string, string>> {
	return localizeImages(TEAM_LOGO_CHANNEL, teamLogoSources(teams));
}
