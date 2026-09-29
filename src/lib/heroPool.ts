/**
 * 从「这位选手在窗口内的每一场」里挑出招牌英雄：纯函数，不碰网络也不碰文件系统。
 *
 * 单独成一个模块的理由和 `liquipediaParse.ts`、`teamLogoSource.ts` 一样——
 * `scripts/playerHeroes.check.ts` 要直接 import 它，而取数那一层（`playerHeroes.ts`）
 * 引了 `buildCache`（node:fs），自检在 Node 里跑不起来。
 */

/** 本版本至少要这么多场，才认为样本够用、不必回退。 */
export const MIN_PATCH_GAMES = 5;
/** 一个英雄至少要打这么多场才算「擅长」——只打一场就上榜是噪音。 */
export const MIN_HERO_GAMES = 2;
/** 最多列几个。 */
export const TOP_HEROES = 5;

export interface PlayerHeroStat {
	heroId: number;
	games: number;
	wins: number;
}

export interface PlayerHeroPool {
	/** `patch`：样本全在当前版本内；`window`：回退了，跨版本。 */
	scope: 'patch' | 'window';
	/** 当前版本号（`7.41f`），页面上要标出来。 */
	version: string;
	/** 实际统计到的第一场与最后一场，Unix 秒。 */
	since: number;
	until: number;
	/** 样本场次。 */
	games: number;
	heroes: PlayerHeroStat[];
}

/** 一场比赛里这位选手的那一行。 */
export interface PlayerMatchRow {
	heroId: number;
	win: boolean;
	startTime: number;
}

/**
 * 挑招牌英雄。
 *
 * 两条判据，各自对应界面上的一句话：
 *
 * 1. **本版本优先**：样本 ≥ `MIN_PATCH_GAMES` 就只算本版本，否则回退到整个窗口；
 * 2. **口径如实**：选中的样本里只要有一场在版本之前，`scope` 就是 `window`——
 *    页面上那两个标签（「7.41f 版本」/「近 90 天」）就是照它写的，标错了页面照样好看，
 *    只是那个名单其实不是本版本的。
 *
 * 返回 null 表示"没有可说的"：一场没打、或者每个英雄都只打过一场。
 */
export function summarizeHeroPool(
	rows: PlayerMatchRow[],
	options: { patchStart: number; version: string },
): PlayerHeroPool | null {
	if (rows.length === 0) return null;
	const inPatch = rows.filter((row) => row.startTime >= options.patchStart);
	const chosen = inPatch.length >= MIN_PATCH_GAMES ? inPatch : rows;
	const scope: PlayerHeroPool['scope'] = chosen.some((row) => row.startTime < options.patchStart) ? 'window' : 'patch';

	const perHero = new Map<number, { games: number; wins: number }>();
	for (const row of chosen) {
		const entry = perHero.get(row.heroId) ?? { games: 0, wins: 0 };
		entry.games += 1;
		if (row.win) entry.wins += 1;
		perHero.set(row.heroId, entry);
	}

	const heroes = [...perHero]
		.filter(([, stat]) => stat.games >= MIN_HERO_GAMES)
		// 场次多的在前；场次一样时胜场多的在前；再一样就按英雄 id 定序（每轮构建结果要一样）。
		.sort((a, b) => b[1].games - a[1].games || b[1].wins - a[1].wins || a[0] - b[0])
		.slice(0, TOP_HEROES)
		.map(([heroId, stat]) => ({ heroId, games: stat.games, wins: stat.wins }));
	if (heroes.length === 0) return null;

	return {
		scope,
		version: options.version,
		since: Math.min(...chosen.map((row) => row.startTime)),
		until: Math.max(...chosen.map((row) => row.startTime)),
		games: chosen.length,
		heroes,
	};
}
