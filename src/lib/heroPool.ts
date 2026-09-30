/**
 * 从「这位选手在窗口内的每一场」里挑出招牌英雄：纯函数，不碰网络也不碰文件系统。
 *
 * 单独成一个模块的理由和 `liquipediaParse.ts`、`teamLogoSource.ts` 一样——
 * `scripts/playerHeroes.check.ts` 要直接 import 它，而取数那一层（`playerHeroes.ts`）
 * 引了 `buildCache`（node:fs），自检在 Node 里跑不起来。
 */

/** 本版本至少要这么多场，才认为样本够用、不必回退。 */
export const MIN_PATCH_GAMES = 5;
/**
 * 本版本至少要能凑出这么多**英雄**，否则整份池子回退到窗口。
 *
 * 只按「场次」判断够不够是不够的：一个选手本版本打了 6 场、每场换一个英雄，
 * 每个英雄都只有 1 场、过不了 `MIN_HERO_GAMES`，于是"本版本"这条路上只剩一两个英雄——
 * 实测 Ame 的池子就显示成只有 1 个英雄，看起来像"这位职业选手只会一个英雄"。
 * 池子太薄，BP 里的"他会不会这个"也就无从谈起，所以宁可退到 90 天并**照实标成「近 90 天」**。
 */
export const MIN_POOL_HEROES = 5;
/** 一个英雄至少要打这么多场才算「擅长」——只打一场就上榜是噪音。 */
export const MIN_HERO_GAMES = 2;
/**
 * 最多列几个。
 *
 * 5 太少了：一线选手一个版本能拿的远不止五个（pool 里留的本来就是"打够场次"的那些），
 * 只留 5 个会让"他没打过它"变成一个很弱的判断。10 个既够 BP 里判断熟不熟，也不至于把池子
 * 摊成一堆 2 场的噪音（门槛仍是每人每英雄 ≥ `MIN_HERO_GAMES`）。
 */
export const TOP_HEROES = 10;

export interface PlayerHeroStat {
	heroId: number;
	games: number;
	wins: number;
}

export interface PlayerHeroPool {
	/** `patch`：样本全在当前版本内；`window`：回退了，跨版本（含"压根没有版本信息"那一档）。 */
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
 * 三条判据，各自对应界面上的一句话：
 *
 * 1. **本版本优先**：样本 ≥ `MIN_PATCH_GAMES` 就只算本版本，否则回退到整个窗口；
 * 2. **口径如实**：选中的样本里只要有一场在版本之前，`scope` 就是 `window`；
 * 3. **没有版本信息就不装**：`patchStart` 为 0（更新日志那一源没取到）时一律按 `window` 算，
 *    页面标「近 90 天」，不拼一个空的版本号出来。
 *
 * 第 2、3 条都是为了让页面上那两个标签（「7.41f 版本」/「近 90 天」）说得准——
 * 标签是照 `scope` 写的，标错了页面照样好看，只是那个名单其实不是它说的口径。
 *
 * 返回 null 表示"没有可说的"：一场没打、或者每个英雄都只打过一场。
 */
export function summarizeHeroPool(
	rows: PlayerMatchRow[],
	options: { patchStart: number; version: string },
): PlayerHeroPool | null {
	if (rows.length === 0) return null;
	/*
	 * `patchStart` 为 0 是**调用方没拿到版本信息**，不是"版本从 1970 年开始"。那种情况下
	 * 「每一场都在本版本内」是句废话，所以干脆不进本版本那条路：样本全算窗口，口径标 `window`。
	 * 实测过不这么分的后果——标签会渲染成「 版本」（版本号是空串）。
	 */
	const hasPatch = Number.isFinite(options.patchStart) && options.patchStart > 0;
	const inPatch = hasPatch ? rows.filter((row) => row.startTime >= options.patchStart) : [];
	/** 把一批对局按英雄合计。 */
	const aggregate = (list: readonly PlayerMatchRow[]): Map<number, { games: number; wins: number }> => {
		const perHero = new Map<number, { games: number; wins: number }>();
		for (const row of list) {
			const entry = perHero.get(row.heroId) ?? { games: 0, wins: 0 };
			entry.games += 1;
			if (row.win) entry.wins += 1;
			perHero.set(row.heroId, entry);
		}
		return perHero;
	};
	/*
	 * 本版本够不够用，要看**能凑出几个英雄**、不能只看场次：6 场打了 6 个英雄，结果是 0 个够门槛。
	 * 那种情况退到整个窗口，`scope` 跟着变成 `window`，页面标「近 90 天」——宁可口径宽一点，
	 * 也不要摆一个只有一两个英雄的"本版本池子"出来（那看起来像"这位选手只会一个英雄"）。
	 */
	const patchPerHero = aggregate(inPatch);
	const patchHeroes = [...patchPerHero.values()].filter((stat) => stat.games >= MIN_HERO_GAMES).length;
	const chosen = inPatch.length >= MIN_PATCH_GAMES && patchHeroes >= MIN_POOL_HEROES ? inPatch : rows;
	const scope: PlayerHeroPool['scope'] =
		!hasPatch || chosen.some((row) => row.startTime < options.patchStart) ? 'window' : 'patch';

	const perHero = aggregate(chosen);

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
