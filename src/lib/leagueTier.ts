import type { LeagueTier } from '../data/types';
// 只借类型：`liquipediaParse.ts` 是纯模块（档位那份形状定义在那里）。
import type { LeagueTierInfo } from './liquipediaParse.ts';

/**
 * 赛事档位怎么用：显示文案，以及「什么样算一线队」。
 *
 * ## 为什么一线队要用赛事档位来定
 *
 * Dota 2 没有升降级分区，DPC 也停了，**不存在官方的「一线队」名单**。实测过三个方向：
 *
 * - Liquipedia 只有**赛事**档位（`Category:Tier 1 Teams` 是空的，战队门户页是按赛区平铺的
 *   字母序名单，不分档），所以队伍层级只能从它打过什么比赛反推；
 * - OpenDota 的队伍评分不能用：52 支里只匹配得到 24 支，而且排序明显失真——OG 1178 分，
 *   排在我们按档位算作三线的 PuckChamp（1265）后面；
 * - 人工白名单最准，但要人跟转会与黑马。
 *
 * 所以口径是：**窗口内参加过一级或二级赛事（Tier 1 / Tier 2）的队伍算一线队**。
 * 这是个近似——打进 T1 的预选赛队伍也会被算进来（实测 Level UP 就是这样），而休赛期
 * 没打 T1/T2 的强队会被漏掉。页面上要把这条口径写给读者，而不是只挂一个「一线队」的牌子。
 */

export interface LeagueTierMeta {
	label: string;
	cls: string;
}

/**
 * 档位徽章。T1 用金色、T2 用站点主色，T3/T4 压成灰——读者一眼就能看出层级，
 * 不用去记「T1 比 T4 高」。
 */
export const LEAGUE_TIER_META: Record<LeagueTier, LeagueTierMeta> = {
	1: { label: 'T1', cls: 'bg-gold/15 text-gold' },
	2: { label: 'T2', cls: 'bg-dota/15 text-dota-light' },
	3: { label: 'T3', cls: 'bg-zinc-600/15 text-zinc-400' },
	4: { label: 'T4', cls: 'bg-zinc-600/15 text-faint' },
};

/** 表演赛标记：它同时也有正式档位，这个标签只是提醒读者那不是一场正式比赛。 */
export const SHOWMATCH_META: LeagueTierMeta = { label: '表演赛', cls: 'bg-zinc-600/15 text-faint' };

/** 一线队的边界：档位不低于 T2（数字越小越高）。 */
export const FIRST_TIER_MAX: LeagueTier = 2;

/** 一届赛事在「这支队算几线」这件事上要看的东西。 */
export interface TieredEvent {
	tier?: LeagueTier;
	showmatch?: boolean;
}

/** 档位是挂在**赛事 id** 上的，所以还原的时候也要能拿到 id。 */
export interface TieredEventRef extends TieredEvent {
	id: string;
}

/**
 * 一批赛事 → `赛事 id → 档位`。
 *
 * 降级那一轮（主源挂了、走缓存）靠它把档位还原回来：缓存里存的是**赛事**，
 * 而对阵重建出来的是新的赛事对象，档位不会自己跟过去。少了这一句，那一轮全站赛事
 * 都没有档位，战队页默认视图（一线队）就是 0 支——读者看到一页空白，数据其实还在缓存里。
 */
export function tierMapOf(events: readonly TieredEventRef[]): Map<string, LeagueTierInfo> {
	const out = new Map<string, LeagueTierInfo>();
	for (const event of events) {
		if (event.tier === undefined) continue;
		// `showmatch` 只在有值时带上：这份对象会被写进缓存，多一个 undefined 键会让形状漂。
		out.set(event.id, event.showmatch ? { tier: event.tier, showmatch: true } : { tier: event.tier });
	}
	return out;
}

/** 把档位贴到赛事上。表里没有的赛事保持没有档位——页面不显示徽章，这是正常的一档。 */
export function applyEventTiers(events: TieredEventRef[], tiers: Map<string, LeagueTierInfo>): void {
	for (const event of events) {
		const info = tiers.get(event.id);
		if (!info) continue;
		event.tier = info.tier;
		if (info.showmatch) event.showmatch = true;
	}
}

/**
 * 一支队伍在窗口内打过的最好档位。
 *
 * **表演赛整届跳过。** 它也有自己的档位（Liquipedia 的 `liquipediatier` 与
 * `liquipediatiertype` 是两个独立字段，实测 BetBoom Streamers Battle 15 是 tier=3），
 * 但拿它当「这支队打过 T3 赛事」会误导——那种比赛的参赛队是主播队，跟职业层级没有关系。
 * 这条过滤放在函数里，而不是指望每个调用方都记得先挑一遍。
 */
export function bestTierOf(events: TieredEvent[]): LeagueTier | undefined {
	let best: LeagueTier | undefined;
	for (const event of events) {
		if (event.tier === undefined || event.showmatch) continue;
		if (best === undefined || event.tier < best) best = event.tier;
	}
	return best;
}

/** 算不算一线队。没有档位（一场正式赛事都没打过）的不算。 */
export function isFirstTier(best: LeagueTier | undefined): boolean {
	return best !== undefined && best <= FIRST_TIER_MAX;
}
