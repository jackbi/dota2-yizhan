import path from 'node:path';
import { isFresh, readCacheJson, writeCacheFile, cacheFile as cachePath } from './buildCache';
import { reportSource } from './dataHealth';
import { fetchHeroList, type HeroListEntry } from './heroApi';

/**
 * **构建期**用的英雄列表（带磁盘缓存）。
 *
 * ## 为什么不写进 `heroApi.ts`
 *
 * `heroApi` 在**运行时**也要用：`/heroes/<id>/guides` 是 SSR，英雄详情页的客户端脚本也 import 它。
 * 仓库的规矩是 SSR 侧不碰 `node:fs`（碰了 Cloudflare 产物就废），所以那边只能保持纯 fetch，
 * 磁盘缓存只能放在外面这一层。这一层只被预渲染的页面 import，进不了 Worker 产物。
 *
 * ## 为什么必须补缓存
 *
 * `/heroes/<id>` 的 `getStaticPaths` 靠这份列表生成 127 个英雄页，而它以前是**裸 fetch、失败即抛**：
 * 官方接口抖一下，整轮 CI 重建就停在这里、这一轮不部署（本机断网跑 `pnpm build` 实测就是停在这一步，
 * 报出来的是 `getaddrinfo ENOTFOUND www.dota2.com.cn`）。
 * 仓库里其他十几个源都是「TTL 缓存 + 上游失败退回旧缓存 + 进数据源健康表」，这里是唯一的例外。
 */

const CACHE_DIR = path.join(process.cwd(), '.cache', 'heroes');
/** 英雄名单几天才动一次，但缓存别太长——新英雄、改名要能在下一次重建就出现。 */
const TTL_SECONDS = 6 * 3600;
const OFFLINE = process.env.TOURNAMENTS_OFFLINE === '1';

/**
 * 缓存格式版本。**`HeroListEntry` 加字段就要加一。**
 * 缓存里存的是解析后的对象，老缓存不会自己长出字段（`roomList.ts` 里那段教训）。
 */
const CACHE_VERSION = 1;

interface CachedHeroList {
	v?: number;
	heroes?: HeroListEntry[];
}

function cacheFile(): string {
	return cachePath(CACHE_DIR, 'list.json');
}

/** 读缓存；`validate` 顺带挡住空列表——空列表存下来会变成"永远是空的"。 */
async function readCache(ttlSeconds: number): Promise<HeroListEntry[] | null> {
	const hit = await readCacheJson<CachedHeroList>(cacheFile(), (value) => {
		const cached = value as CachedHeroList;
		return cached?.v === CACHE_VERSION && Array.isArray(cached.heroes) && cached.heroes.length > 0;
	});
	return hit && isFresh(hit.ageMs, ttlSeconds) ? (hit.value.heroes ?? null) : null;
}

/** 一轮构建只有第一次的结果值得进健康表：这份列表被英雄列表页、详情页、阵容分析各要一遍。 */
let reported = false;

async function report(state: 'fresh' | 'cache' | 'empty', detail: string): Promise<void> {
	if (reported) return;
	reported = true;
	await reportSource('heroes', '英雄列表', state, detail);
}

/**
 * 英雄列表：新鲜缓存 → 联网 → 失败退回旧缓存。
 *
 * 缓存也没有、上游又拿不到时**照旧抛错**：这一份是 127 个英雄页的来源，静默返回空数组
 * 会让英雄页连同 sitemap 一起消失，"构建成功但站点缺了一整块"比构建失败更难发现。
 */
export async function fetchHeroListCached(): Promise<HeroListEntry[]> {
	const fresh = await readCache(TTL_SECONDS);
	if (fresh) {
		await report('cache', `${fresh.length} 个英雄，命中 ${TTL_SECONDS / 3600} 小时缓存`);
		return fresh;
	}

	const stale = await readCache(Number.POSITIVE_INFINITY);
	if (OFFLINE) {
		if (stale) {
			await report('cache', `离线构建，用旧缓存 ${stale.length} 个英雄`);
			return stale;
		}
		await report('empty', '离线构建，且 .cache/ 里没有英雄列表');
		throw new Error('英雄列表：离线构建，且 .cache/ 里没有这份数据');
	}

	try {
		const heroes = await fetchHeroList();
		if (heroes.length === 0) throw new Error('接口返回了空列表');
		await writeCacheFile(cacheFile(), JSON.stringify({ v: CACHE_VERSION, heroes } satisfies CachedHeroList));
		await report('fresh', `${heroes.length} 个英雄，来自官方接口`);
		return heroes;
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		if (stale) {
			await report('cache', `官方接口取不到（${reason}），退回旧缓存 ${stale.length} 个英雄`);
			return stale;
		}
		await report('empty', `官方接口取不到（${reason}），缓存里也没有`);
		throw error;
	}
}
