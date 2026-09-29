import type { LocalImageSource } from './localImages.ts';

/**
 * 「哪些队标要去下载」这条判据：纯函数，不碰网络也不碰文件系统。
 *
 * 单独成一个模块的理由和 `liquipediaParse.ts`、`guideBuild.ts` 一样——
 * `scripts/teamLogos.check.ts` 要直接 import 它，而 `teamLogos.ts` 引了 `localImages.ts`
 * （里面有 `node:fs`），自检在 Node 里跑不起来。
 */

/**
 * Liquipedia 给「还没有队标」的队伍用的占位图文件名。
 *
 * 实测赛程页上有 6 支队伍挂着它。那是 Valve 的 Dota 通用标志，**不是**这支队自己的队标：
 * 六个不同的队显示同一个图标，比显示它们各自的首字母还糟。所以当成「没有队标」处理，
 * 让页面退回 `teams/[id].astro` 里那个首字母占位。
 *
 * 比的是**去掉了扩展名**的那一段：Liquipedia 以后换格式也还认得出来。
 */
const PLACEHOLDER_STEM = 'Dota_2_default_allmode';

export function isPlaceholderLogo(url: string | undefined): boolean {
	return !!url && url.includes(PLACEHOLDER_STEM);
}

/** 一支队伍在队标这件事上要看的东西。 */
export interface TeamLogoRef {
	id: string;
	logo?: string;
}

/**
 * 从 Liquipedia 的缩略图地址里读出版面宽度（`.../57px-Natus_Vincere...png`）。
 *
 * 读不出来按 0——宁可当成最窄的那张，也不要因为一个不一样的地址形状就把整支队的队标丢掉。
 */
function thumbWidth(url: string): number {
	const match = url.match(/\/(\d+)px-[^/]*$/);
	return match ? Number(match[1]) : 0;
}

/**
 * 两个候选地址里哪个该留下来：先比宽度，宽度一样再比地址本身。
 *
 * 第二步不是凑数——同一支队可能同时挂着 `_lightmode` 与 `_allmode` 两张宽度相同的图，
 * 只比宽度的话又会退回到"看谁先出现"，那正是要避免的那种不确定性。
 */
function preferred(url: string, than: string): boolean {
	const [a, b] = [thumbWidth(url), thumbWidth(than)];
	return a !== b ? a > b : url < than;
}

/**
 * 把一批队伍收敛成待下载的队标清单。
 *
 * 三条规则，各自都对应界面上的一个结果：没有地址的跳过（页面本来就不渲染 `img`）、
 * 占位图跳过（见上）、同一支队只留一个地址。
 *
 * ## 为什么同一支队会有好几个地址，以及留哪一个
 *
 * 一支队在一轮里会出现在好几场比赛里，每场都带一份它自己的地址。同一支队的地址**可能不止一个**：
 * bundle 里既有主赛程页的解析结果，也有各赛事页补全的历史对阵，两种模板给的缩略图宽度不一样
 * （实测全场 36–100px）。
 *
 * 取**最宽的那张**，不是为了清晰（差几像素看不出来），而是为了**确定性**：比赛顺序在每轮
 * 构建里都会变（新赛程插进来、旧赛事滚出去），按"第一次出现的那个"来决定，等于让文件名哈希
 * 跟着赛程顺序跳——同一张队标每轮换一个文件名，缓存全废、`dist/` 里还留着上一份孤儿文件。
 * 宽度是第一判据、地址是第二判据，两个都不看顺序。
 *
 * （今天这份数据里实测每支队还只有一个地址，所以这条规则暂时挑不出差别——它是给
 * "同一支队出现两种版面"那天准备的。）
 *
 * 所有引用同一支队的 `TeamRef` 由调用方统一指到这个地址上（见 `tournamentsApi.localizeLogos`）：
 * 拿到的这几张本来就是同一张图的不同缩略尺寸，让它们指向同一个文件正是想要的结果。
 *
 * 返回的清单按队伍 id 排序：挑哪张已经和顺序无关了，下哪张、日志里先出现谁也别再随赛程漂。
 */
export function teamLogoSources(teams: TeamLogoRef[]): LocalImageSource[] {
	const widest = new Map<string, string>();
	for (const team of teams) {
		const url = team.logo;
		if (!url || isPlaceholderLogo(url)) continue;
		const kept = widest.get(team.id);
		if (kept === undefined || preferred(url, kept)) widest.set(team.id, url);
	}
	return [...widest]
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
		.map(([key, url]) => ({ key, url }));
}
