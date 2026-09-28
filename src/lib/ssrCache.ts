/**
 * SSR 运行时的内存缓存与限速。
 *
 * 为什么不复用 `.cache/` 那套：那是**构建期**的磁盘缓存（`node:fs`），跑在 Node 里没问题，
 * 但认证与个人战绩页是运行时按需渲染的，上 Cloudflare Workers 后没有文件系统。
 * 所以这里只用内存 —— 进程重启即失效，在这个场景下完全够用（数据本来就有 TTL）。
 *
 * 缓存是**每实例**的：Serverless 多实例之间不共享，命中率不如集中式缓存，但换来的是
 * 零依赖、零额外服务。上游有速率限制时，单实例内的合并与限速才是主要保护。
 */
// 带扩展名：自检（`scripts/ssrCache.check.ts`）要用 Node 直接跑这个模块，Node 的 ESM 解析不补扩展名。
import { createPace } from './pace.ts';

interface Entry {
	at: number;
	value: unknown;
	/** 这份值占的估算字节数；淘汰按它记账，不按条数想当然。 */
	bytes: number;
}

export interface CacheLimits {
	/** 条数兜底：一堆小条目也不该把表撑到几万行。 */
	maxEntries: number;
	/** 总字节预算——真正防住内存的是这一条。 */
	maxBytes: number;
}

/**
 * 估算一份缓存值占多少字节。
 *
 * 拿 `JSON.stringify` 的长度当量级：这些值本来都是从上游 JSON 解析出来的，形状就是它。
 * 乘 2 是因为 V8 的字符串按 UTF-16 存（值里中文不少，不过淘汰只关心"谁更大"这个排序，
 * 不需要精确到字节）。量不出来的（循环引用、含 BigInt）按"跟预算一样大"算，
 * 它会在下一次写入时立刻被丢掉，而不是挂着一个不肯淘汰的条目。
 */
function estimateBytes(value: unknown, unmeasurable: number): number {
	try {
		const text = JSON.stringify(value);
		return text === undefined ? unmeasurable : text.length * 2;
	} catch {
		return unmeasurable;
	}
}

/**
 * 建一份带预算的内存缓存。
 *
 * 预算按**字节**算，不按条数：条数上限看着够用，其实跟真正的风险对不上——个人战绩页那份
 * `MatchDetail` 一份就有几百 KB，400 条就是上百 MB，而 Worker 的内存上限是 128MB。撞上去
 * 是整个实例被回收（所有并发请求一起失败），不是安静地少几条缓存。所以给一份远低于上限的
 * 总预算，条数上限退化成兜底。
 */
export function createCache(limits: CacheLimits) {
	const store = new Map<string, Entry>();
	/** 同一个 key 并发未命中时只发一次请求，其余等着复用同一个 Promise。 */
	const inflight = new Map<string, Promise<unknown>>();
	let totalBytes = 0;

	function evictIfNeeded(): void {
		if (store.size <= limits.maxEntries && totalBytes <= limits.maxBytes) return;
		// 先走的总是写得更早的那批：这个缓存只用来省掉重复请求，旧条目本来也接近过期了。
		const oldest = [...store.entries()].sort((a, b) => a[1].at - b[1].at);
		for (const [key, entry] of oldest) {
			if (store.size <= limits.maxEntries && totalBytes <= limits.maxBytes) break;
			store.delete(key);
			totalBytes -= entry.bytes;
		}
	}

	function remember(key: string, value: unknown): void {
		const previous = store.get(key);
		// 同一个 key 被重写时要先退掉上一次的账，否则反复刷新同一个 key 会凭空把预算撑满。
		if (previous) totalBytes -= previous.bytes;
		const bytes = estimateBytes(value, limits.maxBytes);
		store.set(key, { at: Date.now(), value, bytes });
		totalBytes += bytes;
		evictIfNeeded();
	}

	/**
	 * 命中且未过期就直接返回；未命中（或已过期）时执行 `load`。
	 *
	 * `load` 抛错时**不写缓存**并把错误抛给调用方：个人页要能把「上游挂了」和
	 * 「这个玩家没有数据」区分开，不能把失败当空结果缓存下来。
	 */
	async function cached<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
		const hit = store.get(key);
		if (hit && Date.now() - hit.at < ttlMs) return hit.value as T;

		const running = inflight.get(key);
		if (running) return running as Promise<T>;

		const task = (async () => {
			try {
				const value = await load();
				remember(key, value);
				return value;
			} finally {
				inflight.delete(key);
			}
		})();

		inflight.set(key, task);
		return task;
	}

	/** 当前记账的估算字节数与条数。给自检读，页面不用。 */
	function stats(): { bytes: number; entries: number } {
		return { bytes: totalBytes, entries: store.size };
	}

	return { cached, stats };
}

/**
 * 全站共用的那一份。16MB 是留给缓存的分额：Worker 上限 128MB，其余要留给正在渲染的页面
 * 与刚从上游读进来的响应；缓存把内存挤爆的代价是整实例被回收，比少几条缓存贵得多。
 */
const memory = createCache({ maxEntries: 400, maxBytes: 16 * 1024 * 1024 });

export const cached = memory.cached;

/**
 * 串行限速：STRATZ 的额度按秒/分/时/天四档计，并发打过去只会触发 429。
 * 与构建期共用 `pace.ts` 的实现（那个文件不碰 `node:*`，所以 Workers 上也能用），
 * 这里给运行时留更大间隔（用户感知的是首屏，不是构建总时长）。
 */
const MIN_INTERVAL_MS = 120;

export const pace = createPace(MIN_INTERVAL_MS);
