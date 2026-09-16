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
import { createPace } from './pace';

interface Entry {
	at: number;
	value: unknown;
}

/** 上限只是防止内存无界增长；超出后按写入时间淘汰最旧的一批。 */
const MAX_ENTRIES = 400;
const store = new Map<string, Entry>();
/** 同一个 key 并发未命中时只发一次请求，其余等着复用同一个 Promise。 */
const inflight = new Map<string, Promise<unknown>>();

function evictIfNeeded(): void {
	if (store.size <= MAX_ENTRIES) return;
	const oldest = [...store.entries()].sort((a, b) => a[1].at - b[1].at);
	for (const [key] of oldest.slice(0, store.size - MAX_ENTRIES)) store.delete(key);
}

/**
 * 命中且未过期就直接返回；未命中（或已过期）时执行 `load`。
 *
 * `load` 抛错时**不写缓存**并把错误抛给调用方：个人页要能把「上游挂了」和
 * 「这个玩家没有数据」区分开，不能把失败当空结果缓存下来。
 */
export async function cached<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
	const hit = store.get(key);
	if (hit && Date.now() - hit.at < ttlMs) return hit.value as T;

	const running = inflight.get(key);
	if (running) return running as Promise<T>;

	const task = (async () => {
		try {
			const value = await load();
			store.set(key, { at: Date.now(), value });
			evictIfNeeded();
			return value;
		} finally {
			inflight.delete(key);
		}
	})();

	inflight.set(key, task);
	return task;
}

/**
 * 串行限速：STRATZ 的额度按秒/分/时/天四档计，并发打过去只会触发 429。
 * 与构建期共用 `pace.ts` 的实现（那个文件不碰 `node:*`，所以 Workers 上也能用），
 * 这里给运行时留更大间隔（用户感知的是首屏，不是构建总时长）。
 */
const MIN_INTERVAL_MS = 120;

export const pace = createPace(MIN_INTERVAL_MS);
