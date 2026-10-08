import path from 'node:path';
import { cacheFile as cachePath, readCacheJson, writeCacheFile } from './buildCache';
import { mapLimit } from './concurrency';
import { reportSource, sourceState } from './dataHealth';
import { createPace } from './pace';
import { ngaHotUrl, ngaReadUrl, parseHotThreads, parseThreadHtmlPage, parseThreadJson } from './ngaThread';
import type { HotThread, ThreadDetail, ThreadFloor } from './ngaThread';

/**
 * 帖子类型从 `ngaThread.ts` 再导出：页面与自检一直在 `ngaApi` 上取它们，
 * 而运行时那条路（`/api/community/floors`）只能引纯模块，两边共用同一份定义。
 */
export type { ThreadDetail, ThreadFloor } from './ngaThread';

/**
 * NGA 社区热帖层：构建期抓取 NGA DOTA2 版块的热帖列表与主楼摘要。
 *
 * 为什么走 APP 接口：网页版 thread.php 对访客直接 403（靠 JS 下发 guestJs cookie
 * 再重载），而 APP 侧 app_api.php / read.php 免鉴权返回 JSON，是唯一可行的入口。
 * 这两个接口没有官方承诺，随时可能收紧，所以一律按"尽力而为"处理：
 * 取不到就退回过期缓存，再取不到就留空，绝不编数据。
 */

const API = 'https://bbs.nga.cn';
const CACHE_DIR = path.join(process.cwd(), '.cache', 'community');
const OFFLINE = process.env.TOURNAMENTS_OFFLINE === '1';
/** APP 接口认这个 UA，返回的数据字段更完整。 */
const USER_AGENT = 'NGA_WP_JW';

let boardPromise: Promise<CommunityThread[]> | null = null;
/** 一份详情，外加**它是怎么来的**。列表那一行只报列表的来源，详情只记次数。 */
interface LoadedThread {
	detail: ThreadDetail | null;
	network: boolean;
}

/** 帖子详情按 tid 记忆，列表页与详情页共用同一次请求。 */
const threadCache = new Map<string, Promise<LoadedThread>>();

/** 热帖榜的时间窗，对应接口的 days 参数。 */
export const HOT_WINDOWS = [
	{ days: 1, label: '24 小时' },
	{ days: 7, label: '7 天' },
	{ days: 30, label: '30 天' },
] as const;

export type HotWindowDays = (typeof HOT_WINDOWS)[number]['days'];

/** 每个时间窗取热度最高的多少条；榜单已按回复数排好。 */
const THREADS_PER_WINDOW = 15;
/** 少于这个回复数的不算热帖。 */
const MIN_REPLIES = 5;
const LIST_TTL_SECONDS = 30 * 60;
/**
 * 帖子详情（主楼 + 楼层 + 热评）。
 * 主楼基本不改，但热评和列表摘要都取自这里，按周刷新意味着热帖榜 30 分钟一刷、
 * 点进去却是上周的讨论。按小时级刷新，代价是每 2 小时重抓一遍榜上的几十个帖子。
 */
const THREAD_TTL_SECONDS = 2 * 3600;
const FETCH_CONCURRENCY = 4;
/** NGA 未见限流，但没必要打太急。 */
const MIN_INTERVAL_MS = 200;

/*
 * 热帖条目的类型、榜单解析与地址构造搬到了 `ngaThread.ts`（纯模块）：
 * 资讯列表的「加载更多」是运行时按需取下一页的，那边不能引 `node:fs`。
 */
export type { HotThread } from './ngaThread';

/** 热帖 + 它上了哪几个时间窗的榜。 */
export interface CommunityThread extends HotThread {
	windows: HotWindowDays[];
}

// ---------------------------------------------------------------- 请求与缓存

/** 串行化请求间隔，避免并发同时穿过限速窗口。 */
const pace = createPace(MIN_INTERVAL_MS);

async function fetchText(url: string, encoding = 'utf-8'): Promise<string | null> {
	await pace();
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 20_000);
	try {
		const res = await fetch(url, { signal: controller.signal, headers: { 'User-Agent': USER_AGENT } });
		if (!res.ok) return null;
		return new TextDecoder(encoding).decode(await res.arrayBuffer());
	} catch {
		return null;
	} finally {
		clearTimeout(timer);
	}
}

function cacheFile(key: string): string {
	return cachePath(CACHE_DIR, `${key}.json`);
}

function readCache<T>(key: string): Promise<{ value: T; ageMs: number } | null> {
	return readCacheJson<T>(cacheFile(key));
}

async function writeCache(key: string, value: unknown): Promise<void> {
	await writeCacheFile(cacheFile(key), JSON.stringify(value));
}



// ---------------------------------------------------------------- 地址

/** 帖子在网页版的地址，用于署名跳转。 */
export function ngaThreadUrl(tid: string): string {
	return `${API}/read.php?tid=${tid}`;
}

/* 热帖榜地址与解析都在 `ngaThread.ts`（`ngaHotUrl` / `parseHotThreads`）。 */

// ---------------------------------------------------------------- 热帖榜

/** 一个时间窗的热帖榜本轮是联网抓到的，还是吃缓存/没抓到。 */
interface LoadedHotList {
	threads: HotThread[] | null;
	network: boolean;
}

async function loadHotList(days: number): Promise<LoadedHotList> {
	const key = `hot-${days}`;
	const cached = await readCache<HotThread[]>(key);
	if (cached && cached.ageMs < LIST_TTL_SECONDS * 1000) return { threads: cached.value, network: false };

	let value: HotThread[] | null = null;
	if (!OFFLINE) {
		for (let attempt = 0; attempt < 2 && value === null; attempt++) {
			const text = await fetchText(ngaHotUrl(days));
			if (text === null) continue;
			try {
				value = parseHotThreads(JSON.parse(text), MIN_REPLIES);
			} catch {
				value = null;
			}
		}
	}
	if (value === null) return { threads: cached?.value ?? null, network: false };

	await writeCache(key, value);
	return { threads: value, network: true };
}

/**
 * 取第一页（`read.php` 一次给一页）。JSON 解析失败就退回去掉 `__output` 的 HTML 版本
 * ——GBK 编码，只能救回主楼，那种情况下页面不摆「加载更多」。
 *
 * 解析本身在 `ngaThread.ts`（纯函数，运行时那条路也用它）。
 */
async function fetchThreadFirstPage(tid: string): Promise<ThreadDetail | null> {
	const text = await fetchText(ngaReadUrl(tid, 1));
	if (text !== null) {
		try {
			const parsed = parseThreadJson(JSON.parse(text), 1);
			if (parsed) return parsed;
		} catch {
			// 正文里出现非法转义时整段 JSON 解析会失败，落到下面的 HTML 兜底。
		}
	}
	const html = await fetchText(`${API}/read.php?tid=${tid}&noBBCode`, 'gb18030');
	return html === null ? null : parseThreadHtmlPage(html);
}

/**
 * 帖子详情。主楼、本页楼层、热评共用 read.php 这一次请求，
 * 列表页只用其中的摘要，所以详情页不会再产生额外请求。
 */
export function fetchThreadDetail(tid: string): Promise<ThreadDetail | null> {
	return loadThreadRaw(tid).then((loaded) => loaded.detail);
}

function loadThreadRaw(tid: string): Promise<LoadedThread> {
	let pending = threadCache.get(tid);
	if (!pending) {
		pending = loadThread(tid);
		threadCache.set(tid, pending);
	}
	return pending;
}

async function loadThread(tid: string): Promise<LoadedThread> {
	// 键里的版本号跟解析格式绑定：摘要规则一变就得换，否则旧结果会一直吃到过期。
	// v4：详情里多了 `page` / `perPage`（详情页的「加载更多」靠它们算下一跳），
	// v3 缓存里没有这两个字段，命中的话按钮会算不出还剩几层。
	const key = `thread-v4-${tid}`;
	const cached = await readCache<ThreadDetail>(key);
	if (cached && cached.ageMs < THREAD_TTL_SECONDS * 1000) return { detail: cached.value, network: false };
	if (OFFLINE) return { detail: cached?.value ?? null, network: false };

	let detail: ThreadDetail | null = null;
	for (let attempt = 0; attempt < 2 && detail === null; attempt++) {
		try {
			detail = await fetchThreadFirstPage(tid);
		} catch {
			detail = null;
		}
	}

	if (detail === null) return { detail: cached?.value ?? null, network: false };

	await writeCache(key, detail);
	return { detail, network: true };
}

// ---------------------------------------------------------------- 对外接口

/**
 * 三个时间窗的热帖合并去重，按回复数倒序。
 * 页面多处共用同一份结果，一次构建只抓一轮。
 */
export function fetchCommunityThreads(): Promise<CommunityThread[]> {
	if (!boardPromise) boardPromise = loadBoard();
	return boardPromise;
}

async function loadBoard(): Promise<CommunityThread[]> {
	/** 热帖榜本轮联网抓到几个时间窗。**整源的状态只看它**，楼层详情是次要数据。 */
	let listFetched = 0;

	const byId = new Map<string, CommunityThread>();
	for (const window of HOT_WINDOWS) {
		const loaded = await loadHotList(window.days);
		if (loaded.network) listFetched += 1;
		const list = loaded.threads;
		if (!list) continue;
		for (const thread of list.slice(0, THREADS_PER_WINDOW)) {
			const existing = byId.get(thread.tid);
			if (existing) existing.windows.push(window.days);
			else byId.set(thread.tid, { ...thread, windows: [window.days] });
		}
	}

	const threads = [...byId.values()].sort(
		(a, b) => b.replies - a.replies || b.lastReplyAt - a.lastReplyAt || b.tid.localeCompare(a.tid),
	);
	/** 楼层抓取失败与"主楼没有文字"是两回事，汇总里分开报。 */
	let failed = 0;
	/** 楼层本轮联网抓了几个。只进说明文字：那一行的状态说的是**热帖榜**的来源。 */
	let detailFetched = 0;
	await mapLimit(threads, FETCH_CONCURRENCY, async (thread) => {
		const loaded = await loadThreadRaw(thread.tid);
		if (loaded.network) detailFetched += 1;
		const detail = loaded.detail;
		if (!detail) failed += 1;
		thread.summary = detail?.summary ?? '';
	});

	const withSummary = threads.filter((thread) => thread.summary).length;
	await reportSource(
		'nga',
		'NGA 刀塔版块',
		sourceState(listFetched > 0, threads.length),
		`${threads.length} 个热帖，热帖榜联网抓取 ${listFetched} 个时间窗，楼层联网抓取 ${detailFetched} 个，` +
			`楼层抓取失败 ${failed} 个，${withSummary} 个有文字摘要`,
	);
	return threads;
}
