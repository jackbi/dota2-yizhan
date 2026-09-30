import type { LeagueTier } from '../data/types';
// 只借类型：`liquipediaParse.ts` 是纯模块（档位那份形状定义在那里）。
import type { LeagueTierInfo } from './liquipediaParse.ts';

/**
 * 赛事档位怎么用：显示文案（徽章），以及降级那一轮怎么把档位还原回赛事上。
 *
 * ## 档位只描述赛事，不描述队伍
 *
 * 档位曾经被用来给**队伍**分层（「窗口内打过 T1/T2 的算一线队」），那条口径已经撤掉了：
 * 打进 T1 预选赛的二线队会被算进来、休赛期没打 T1/T2 的强队会被漏掉，本质原因就是档位是
 * **赛事**的属性。战队名录现在改用 Liquipedia 的活跃战队门户按地区分组（见 `teamPortal.ts`）。
 *
 * Liquipedia 也不提供队伍档位：`Category:Tier 1 Teams` 是空的。当年记下来的另外两条路同样
 * 走不通，留在这里免得再试一遍——OpenDota 的队伍评分匹配率低且排序失真（52 支只匹配到 24 支，
 * OG 1178 分排在 PuckChamp 1265 之后）；人工白名单最准，但要人跟着转会与黑马维护。
 *
 * 所以这个模块只做两件事：给赛事页画档位徽章，以及把档位还原回赛事（见 `tierMapOf`）。
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

/** 档位与表演赛标记（`LeagueTierInfo` 的字段形状）。 */
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
 * 都没有档位徽章，档位筛选也会把每届都归进「其他」——数据其实还在缓存里。
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
