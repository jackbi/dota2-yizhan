import path from 'node:path';
import { cacheFile as cachePath, readCacheJson, writeCacheFile } from './buildCache';
import { mapLimit } from './concurrency';
import { reportSource, sourceState } from './dataHealth';
import { type HupuThread, selectBoardThreads, toThreads } from './hupuBoard';
import { hupuThreadPageUrl, parseHupuThread } from './hupuThread';
import type { HupuReply, HupuThreadDetail } from './hupuThread';
import { createPace } from './pace';

/**
 * 帖子类型从 `hupuThread.ts` 再导出：页面与自检一直在 `hupuApi` 上取它们，
 * 而运行时那条路（`/api/community/floors`）只能引纯模块，两边共用同一份定义。
 */
export type { HupuReply, HupuThreadDetail } from './hupuThread';

/**
 * 虎扑 DOTA2 区（`bbs.hupu.com/dota2`）的社区帖层：列表 + 详情。
 *
 * **为什么是虎扑**：微博与贴吧都试过，不是解析难度的问题，是根本取不到数据——
 * 微博的内容接口全部要登录态（`m.weibo.cn` 的 container 接口回 302 到 "Sina Visitor System"，
 * `weibo.com/ajax/side/hotSearch` 直接 403），贴吧直连 403、走读取代理拿到的是「百度安全验证」。
 * 虎扑的版块列表与帖子页直连就是服务端渲染好的 HTML，是少数能稳定抓的中文社区。
 *
 * **详情走 `__NEXT_DATA__`，不抠渲染后的 DOM。** 帖子页是 Next.js，`<script id="__NEXT_DATA__">`
 * 里有一份完整的 JSON：主楼正文（HTML）、亮数、推荐数、浏览数、创建时间，以及
 * `lights`（亮评，50 条）与 `replies`（分页回复，每页 20 条）。比在 HTML 上做正则稳得多，
 * 也不受 class 名带哈希后缀的影响（页面上是 `post-content_bbs-post-content__cy7vN` 这种）。
 * 所以详情页只用这一次请求就能出正文 + 亮评 + 第一页回复，**没有额外请求**。
 *
 * **与 NGA 的口径差异**（页面上有说明）：NGA 的 `replies` 是**时间窗内**的回复数，
 * 虎扑给的是**帖子总回复数**，两者不可直接比较。这里不做归一化、不编数据，
 * 页面上按来源分栏时各自可比。
 *
 * 列表的解析与取帖口径在 `hupuBoard.ts`（纯函数，配 `scripts/hupuBoard.check.ts`）——
 * 那一栏曾经按回复数重排，把版面页最上面的新帖全挤掉了，原因与修法都写在那边的文件头。
 */

const BOARD_URL = 'https://bbs.hupu.com/dota2';
const ORIGIN = 'https://bbs.hupu.com';
const CACHE_DIR = path.join(process.cwd(), '.cache', 'community');
const OFFLINE = process.env.TOURNAMENTS_OFFLINE === '1';

const LIST_TTL_SECONDS = 30 * 60;
/** 详情（正文 + 亮评 + 第一页回复）一次抓齐，按小时级刷新。 */
const DETAIL_TTL_SECONDS = 2 * 3600;
const FETCH_CONCURRENCY = 4;
/** 虎扑未见限流，但没必要打太急。 */
const MIN_INTERVAL_MS = 200;

const USER_AGENT =
	'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

export type { HupuThread };

/** 帖子在虎扑的地址，用于署名跳转。 */
export function hupuThreadUrl(pid: string): string {
	return `${ORIGIN}/${pid}.html`;
}

// ---------------------------------------------------------------- 请求与缓存

/** 串行化请求间隔，避免并发同时穿过限速窗口。 */
const pace = createPace(MIN_INTERVAL_MS);

async function fetchHtml(url: string): Promise<string | null> {
	await pace();
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 20_000);
	try {
		const res = await fetch(url, {
			signal: controller.signal,
			redirect: 'follow',
			headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,application/xhtml+xml' },
		});
		if (!res.ok) return null;
		return await res.text();
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

// ---------------------------------------------------------------- 列表解析

/*
 * 版面页的解析（`toThreads`）与取帖口径（`selectBoardThreads`）在 `hupuBoard.ts`：
 * 那边是纯函数，能脱离网络与缓存在 `scripts/hupuBoard.check.ts` 里测。
 */

/** 版面列表本轮是联网抓到的（拿到了非空的帖子），还是吃缓存/没抓到。 */
interface LoadedBoard {
	threads: HupuThread[];
	network: boolean;
}

async function loadBoard(): Promise<LoadedBoard> {
	const key = 'hupu-list';
	const cached = await readCache<HupuThread[]>(key);
	if (cached && cached.ageMs < LIST_TTL_SECONDS * 1000) return { threads: cached.value, network: false };

	let value: HupuThread[] | null = null;
	if (!OFFLINE) {
		const nowSec = Math.floor(Date.now() / 1000);
		for (let attempt = 0; attempt < 2 && value === null; attempt++) {
			const html = await fetchHtml(BOARD_URL);
			if (html === null) continue;
			value = toThreads(html, nowSec);
		}
	}
	if (value === null) return { threads: cached?.value ?? [], network: false };

	value = selectBoardThreads(value);
	await writeCache(key, value);
	// 页面取到了、却一条帖子都没解析出来（版面改版），和"没抓到"是一回事，不能算本轮拿到了列表。
	return { threads: value, network: value.length > 0 };
}

/*
 * 解析（`__NEXT_DATA__` → 主楼、亮评、这一页回复）搬到了 `hupuThread.ts`：
 * 那边是纯函数，构建期与运行时（详情页的「加载更多」）共用同一份口径。
 */

/** 一份详情，外加**它是怎么来的**。列表那一行只报列表的来源，详情只记次数。 */
interface LoadedDetail {
	detail: HupuThreadDetail | null;
	network: boolean;
}

const detailCache = new Map<string, Promise<LoadedDetail>>();

/** 帖子详情，按 pid 记忆：列表页的摘要与详情页共用同一次请求。 */
export function fetchHupuThreadDetail(pid: string): Promise<HupuThreadDetail | null> {
	return loadDetailRaw(pid).then((loaded) => loaded.detail);
}

function loadDetailRaw(pid: string): Promise<LoadedDetail> {
	let pending = detailCache.get(pid);
	if (!pending) {
		pending = loadDetail(pid);
		detailCache.set(pid, pending);
	}
	return pending;
}

async function loadDetail(pid: string): Promise<LoadedDetail> {
	// 键里的版本号跟解析格式绑定：清洗规则一变就得换，否则旧结果会一直吃到过期。
	// v3：正文清洗从黑名单换成白名单（`articleHtml.ts`），v2 缓存里可能存着漏网的 `onerror`。
	// v4：详情里多了 `page` / `perPage` / `totalPages`（详情页的「加载更多」靠它们算下一跳）。
	const key = `hupu-thread-v4-${pid}`;
	const cached = await readCache<HupuThreadDetail>(key);
	if (cached && cached.ageMs < DETAIL_TTL_SECONDS * 1000) return { detail: cached.value, network: false };
	if (OFFLINE) return { detail: cached?.value ?? null, network: false };

	const html = await fetchHtml(hupuThreadPageUrl(pid, 1));
	if (html === null) return { detail: cached?.value ?? null, network: false };
	const detail = parseHupuThread(html);
	if (detail === null) return { detail: cached?.value ?? null, network: false };

	await writeCache(key, detail);
	return { detail, network: true };
}

// ---------------------------------------------------------------- 对外接口

let boardPromise: Promise<HupuThread[]> | null = null;

/**
 * 列表 + 摘要，一次构建只抓一轮。列表就是版面页最前面的 20 条（最新回复顺序）。
 * 取不到就返回空数组（页面按"没有数据"处理）。
 */
export function fetchHupuThreads(): Promise<HupuThread[]> {
	if (!boardPromise) boardPromise = loadBoardWithSummaries();
	return boardPromise;
}

async function loadBoardWithSummaries(): Promise<HupuThread[]> {
	const board = await loadBoard();
	const threads = board.threads;
	/** 摘要"抓失败"（网络不通、页面结构变了）与"主楼本来就没文字"是两回事，汇总里分开报。 */
	let failed = 0;
	/** 详情本轮联网抓了几个。只进说明文字：那一行的状态说的是**列表**的来源。 */
	let detailFetched = 0;
	await mapLimit(threads, FETCH_CONCURRENCY, async (thread) => {
		const loaded = await loadDetailRaw(thread.pid);
		if (loaded.network) detailFetched += 1;
		const detail = loaded.detail;
		if (detail === null) {
			failed += 1;
			return;
		}
		thread.summary = detail.summary;
		// 详情页的数字比列表页权威（列表页只给它在榜上那一条的计数），顺手对齐。
		if (detail.replies > 0) thread.replies = detail.replies;
		if (detail.read > 0) thread.views = detail.read;
	});

	const withSummary = threads.filter((thread) => thread.summary).length;
	await reportSource(
		'hupu',
		'虎扑 DOTA2 区',
		sourceState(board.network, threads.length),
		`${threads.length} 个帖子，列表${board.network ? '联网抓取' : '用缓存'}，详情联网抓取 ${detailFetched} 个，` +
			`详情抓取失败 ${failed} 个，${withSummary} 个有文字摘要`,
	);
	return threads;
}
