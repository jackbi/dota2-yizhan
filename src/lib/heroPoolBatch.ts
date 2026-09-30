import type { PlayerHeroPool, PlayerMatchRow } from './heroPool.ts';
import { summarizeHeroPool } from './heroPool.ts';

/**
 * 「一批选手的招牌英雄」的取数策略：纯函数，不碰网络也不碰文件系统。
 *
 * 单独成模块的理由和 `heroPool.ts`、`teamLogoSource.ts` 一样——自检要能在纯 node 里直接
 * import 它，而取数那一层（`playerHeroes.ts`）引了 `astro:env/server` 与 node:fs。
 *
 * 这一层管三件事：谁要问、问完怎么算、**什么时候停下来别再问了**。最后一件是主力：
 * STRATZ 的额度全站共用（构建、个人战绩页、攻略页都吃同一份），撞上限流或出口不对时，
 * 继续把剩下几十个账号挨个问一遍只会把额度打得更空（每个请求自己还会重试 3 次），
 * 而页面上完全看不出区别——所以这条判据放在这里、由自检钉住。
 *
 * 缓存条目的形状也在这一层：它是"策略要用的东西"，跟怎么发请求无关。
 */

/**
 * 缓存格式版本。**给 `PlayerHeroPool` 加字段就要加一**（理由见 `roomList.ts` 那段）。
 *
 * TTL 改长短不用动它：条目形状没变，老条目只是早一点或晚一点过期。
 */
export const HERO_POOL_CACHE_VERSION = 1;

export interface HeroPoolCacheEntry {
	v?: number;
	at: number;
	pool?: PlayerHeroPool;
}

export type HeroPoolCache = Record<string, HeroPoolCacheEntry>;

export interface HeroPoolBatchOptions {
	/** 想要招牌英雄的账号；重复、非法值在这里丢掉，调用方不用自己过滤。 */
	accountIds: number[];
	cache: HeroPoolCache;
	ttlMs: number;
	now: number;
	offline: boolean;
	/** 取一位选手的对局行。失败就抛，由 `stopReason` 决定是"他自己没取到"还是"整批别问了"。 */
	loadRows: (accountId: number) => Promise<PlayerMatchRow[]>;
	/**
	 * 这个错误要不要让整批停下：返回原因就不再问剩下的人，返回 null 只算这一位失败。
	 * 判据由调用方给——"额度用完/出口不对"与"这一个账号有问题"分得开才停得对。
	 */
	stopReason: (error: unknown) => string | null;
	patch: { patchStart: number; version: string };
}

export interface HeroPoolBatchResult {
	/** 有结论的选手，键是账号 id。 */
	pools: Map<number, PlayerHeroPool>;
	/** 下一轮要写回磁盘的那份缓存（只含这一轮要用的键）。 */
	cache: HeroPoolCache;
	/** 真的拿到数据的次数。 */
	fetched: number;
	/** 单个选手失败、但整批继续的次数。 */
	failed: number;
	/** 因为整批停下而**没问**的数量（不含那个触发停下的——他问过了，只是没结果）。 */
	skipped: number;
	/** 停下的原因，没有停下就是 undefined。 */
	stoppedBy?: string;
}

/**
 * 逐个取、逐个算，出结论就往 `pools` 里放。
 *
 * 三条规则，各自对应构建汇总里的一句话：
 *
 * 1. **新鲜缓存不问**：`now - at < ttlMs` 的条目直接沿用，这一轮不花额度；
 * 2. **单个失败不牵连别人**：他不写缓存（下一轮重试）、退旧缓存（页面上还有东西看）；
 * 3. **整批停下**：撞到 `stopReason` 认的那类错误后，剩下的人只退旧缓存、一次都不问。
 *
 * 返回的 `cache` 是"这一轮要写回磁盘的那份"，只含 `accountIds` 里的键——赛事滚出去之后，
 * 缓存不会跟着越攒越大。
 */
export async function collectHeroPools(options: HeroPoolBatchOptions): Promise<HeroPoolBatchResult> {
	const wanted = [...new Set(options.accountIds.filter((id) => Number.isInteger(id) && id > 0))];
	const pools = new Map<number, PlayerHeroPool>();
	const cache: HeroPoolCache = {};
	let fetched = 0;
	let failed = 0;
	let skipped = 0;
	let stoppedBy: string | undefined;

	for (const accountId of wanted) {
		const key = String(accountId);
		const hit = options.cache[key];
		const carry = (): void => {
			if (!hit) return;
			cache[key] = hit;
			if (hit.pool) pools.set(accountId, hit.pool);
		};

		if (hit && options.now - hit.at < options.ttlMs) {
			carry();
			continue;
		}
		if (options.offline) {
			carry();
			continue;
		}
		// 已经决定停下：剩下的连同旧数据一起带过去，一次都不问。
		if (stoppedBy !== undefined) {
			skipped += 1;
			carry();
			continue;
		}

		try {
			const rows = await options.loadRows(accountId);
			fetched += 1;
			const pool = summarizeHeroPool(rows, options.patch);
			cache[key] = { v: HERO_POOL_CACHE_VERSION, at: options.now, pool };
			if (pool) pools.set(accountId, pool);
		} catch (error) {
			const reason = options.stopReason(error);
			if (reason === null) {
				failed += 1;
			} else {
				stoppedBy = reason;
			}
			carry();
		}
	}

	return { pools, cache, fetched, failed, skipped, stoppedBy };
}
