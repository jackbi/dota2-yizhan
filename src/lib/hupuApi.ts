import path from 'node:path';
import { sanitizeArticleHtml, summarizeArticle } from './articleHtml';
import { cacheFile as cachePath, readCacheJson, writeCacheFile } from './buildCache';
import { mapLimit } from './concurrency';
import { reportSource } from './dataHealth';
import { type HupuThread, selectBoardThreads, toThreads } from './hupuBoard';
import { createPace } from './pace';

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

/** 一层回复。虎扑不返回楼层号，所以站内只按时间顺序展示，不编号。 */
export interface HupuReply {
	pid: string;
	author: string;
	/** 亮数（虎扑的「赞」） */
	lights: number;
	/** 这条下面的二级回复数 */
	replyNum: number;
	/** 是不是楼主自己回的 */
	isStarter: boolean;
	createdAt: number;
	/** 已经清洗过的正文 HTML */
	content: string;
}

export interface HupuThreadDetail {
	summary: string;
	/** 主楼正文 HTML（已清洗） */
	content: string;
	/** 亮数 */
	lights: number;
	/** 推荐数 */
	recommend: number;
	/** 浏览数 */
	read: number;
	/** 总回复数，详情页的数字比列表页权威 */
	replies: number;
	/** 发帖时间，Unix 秒 */
	createdAt: number;
	repliedAt: number;
	/** 亮评，按键（亮数）降序 */
	hotReplies: HupuReply[];
	/** 详情页第一页回复，按时间正序 */
	floors: HupuReply[];
	location: string;
	topic: string;
}

/** 帖子在虎扑的地址，用于署名跳转。 */
export function hupuThreadUrl(pid: string): string {
	return `${ORIGIN}/${pid}.html`;
}

// ---------------------------------------------------------------- 请求与缓存

/** 串行化请求间隔，避免并发同时穿过限速窗口。 */
const pace = createPace(MIN_INTERVAL_MS);

/** 本轮真正联网抓了几次；用于区分"新抓的"和"吃缓存的"。 */
let networkFetches = 0;

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
		networkFetches += 1;
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

async function loadBoard(): Promise<HupuThread[]> {
	const key = 'hupu-list';
	const cached = await readCache<HupuThread[]>(key);
	if (cached && cached.ageMs < LIST_TTL_SECONDS * 1000) return cached.value;

	let value: HupuThread[] | null = null;
	if (!OFFLINE) {
		const nowSec = Math.floor(Date.now() / 1000);
		for (let attempt = 0; attempt < 2 && value === null; attempt++) {
			const html = await fetchHtml(BOARD_URL);
			if (html === null) continue;
			value = toThreads(html, nowSec);
		}
	}
	if (value === null) return cached?.value ?? [];

	value = selectBoardThreads(value);
	await writeCache(key, value);
	return value;
}

// ---------------------------------------------------------------- 详情解析

type Json = Record<string, unknown>;

const asObject = (value: unknown): Json | null =>
	value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : null;
const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const asString = (value: unknown): string => (typeof value === 'string' ? value : '');
const asCount = (value: unknown, fallback = 0): number =>
	typeof value === 'number' && Number.isFinite(value) ? value : fallback;
/** 虎扑的时间是毫秒 */
const msToSec = (value: unknown): number => Math.floor(asCount(value) / 1000);

/** 帖子页的关键数据都在这段 JSON 里；取不到就退回渲染后的 HTML（只剩正文）。 */
const NEXT_DATA_RE = /<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/;
/** 兜底路径：主楼正文容器（注意 class 名带哈希后缀，只能匹配前缀）。 */
const MAIN_POST_RE = /<div class="thread-content-detail">/;

/**
 * 清洗虎扑正文。
 *
 * 正文是用户内容，清洗一律走 `articleHtml.ts` 的白名单（那边有整套用例），
 * 这里只提供两件虎扑特有的事：相对地址按 **bbs.hupu.com** 补（不能沿用官方新闻那套
 * dota2.com.cn 的域名），以及把 `data-imgid` 这类虎扑自己的私有属性交给白名单自动丢掉。
 */
function sanitizeHupuHtml(html: string): string {
	return sanitizeArticleHtml(html, { baseOrigin: ORIGIN });
}

function toReply(raw: unknown): HupuReply | null {
	const row = asObject(raw);
	if (!row) return null;
	const content = sanitizeHupuHtml(asString(row.content));
	if (!content) return null;
	return {
		pid: asString(row.pid),
		author: asString(asObject(row.author)?.puname) || '虎扑用户',
		lights: asCount(row.count),
		replyNum: asCount(row.replyNum),
		isStarter: row.isStarter === true,
		createdAt: msToSec(row.createdAt),
		content,
	};
}

function parseDetail(html: string): HupuThreadDetail | null {
	const raw = NEXT_DATA_RE.exec(html)?.[1];
	if (!raw) return parseDetailFallback(html);
	let root: Json | null = null;
	try {
		root = asObject(JSON.parse(raw));
	} catch {
		return parseDetailFallback(html);
	}
	const detail = asObject(asObject(asObject(root?.props)?.pageProps)?.detail);
	const thread = asObject(detail?.thread);
	if (!thread) return parseDetailFallback(html);

	const content = sanitizeHupuHtml(asString(thread.content));
	/** 亮评在接口里不是按键排序的（实测 1047 / 468 / 523…），这里自己排。 */
	const hotReplies = asArray(detail?.lights)
		.map(toReply)
		.filter((reply): reply is HupuReply => reply !== null)
		.sort((a, b) => b.lights - a.lights || a.createdAt - b.createdAt);
	const floors = asArray(asObject(detail?.replies)?.list)
		.map(toReply)
		.filter((reply): reply is HupuReply => reply !== null);

	return {
		summary: summarizeArticle(content),
		content,
		lights: asCount(thread.lights),
		recommend: asCount(thread.recommend),
		read: asCount(thread.read),
		replies: asCount(thread.replies),
		createdAt: msToSec(thread.createdAt),
		repliedAt: msToSec(thread.repliedAt),
		hotReplies,
		floors,
		location: asString(thread.location),
		topic: asString(asObject(thread.topic)?.name),
	};
}

/** 结构变了（或接口没了）时的兜底：从渲染后的 DOM 里只救回主楼正文。 */
function parseDetailFallback(html: string): HupuThreadDetail | null {
	const content = sanitizeHupuHtml(extractMainPost(html));
	if (!content) return null;
	return {
		summary: summarizeArticle(content),
		content,
		lights: 0,
		recommend: 0,
		read: 0,
		replies: 0,
		createdAt: 0,
		repliedAt: 0,
		hotReplies: [],
		floors: [],
		location: '',
		topic: '',
	};
}

/** 按 div 嵌套深度配对闭合标签，取出主楼正文 HTML。 */
function extractMainPost(html: string): string {
	const start = html.search(MAIN_POST_RE);
	if (start < 0) return '';
	const bodyStart = html.indexOf('>', start) + 1;
	const tagRe = /<\/?div\b[^>]*>/gi;
	tagRe.lastIndex = bodyStart;
	let depth = 1;
	let match: RegExpExecArray | null;
	while ((match = tagRe.exec(html))) {
		if (match[0][1] === '/') {
			if (--depth === 0) return html.slice(bodyStart, match.index);
		} else {
			depth++;
		}
	}
	return html.slice(bodyStart);
}

const detailCache = new Map<string, Promise<HupuThreadDetail | null>>();

/** 帖子详情，按 pid 记忆：列表页的摘要与详情页共用同一次请求。 */
export function fetchHupuThreadDetail(pid: string): Promise<HupuThreadDetail | null> {
	let pending = detailCache.get(pid);
	if (!pending) {
		pending = loadDetail(pid);
		detailCache.set(pid, pending);
	}
	return pending;
}

async function loadDetail(pid: string): Promise<HupuThreadDetail | null> {
	// 键里的版本号跟解析格式绑定：清洗规则一变就得换，否则旧结果会一直吃到过期。
	// v3：正文清洗从黑名单换成白名单（`articleHtml.ts`），v2 缓存里可能存着漏网的 `onerror`。
	const key = `hupu-thread-v3-${pid}`;
	const cached = await readCache<HupuThreadDetail>(key);
	if (cached && cached.ageMs < DETAIL_TTL_SECONDS * 1000) return cached.value;
	if (OFFLINE) return cached?.value ?? null;

	const html = await fetchHtml(hupuThreadUrl(pid));
	if (html === null) return cached?.value ?? null;
	const detail = parseDetail(html);
	if (detail === null) return cached?.value ?? null;

	await writeCache(key, detail);
	return detail;
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
	const threads = await loadBoard();
	/** 摘要"抓失败"（网络不通、页面结构变了）与"主楼本来就没文字"是两回事，汇总里分开报。 */
	let failed = 0;
	await mapLimit(threads, FETCH_CONCURRENCY, async (thread) => {
		const detail = await fetchHupuThreadDetail(thread.pid);
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
	const state = networkFetches > 0 ? 'fresh' : threads.length > 0 ? 'cache' : 'empty';
	await reportSource(
		'hupu',
		'虎扑 DOTA2 区',
		state,
		`${threads.length} 个帖子，详情抓取失败 ${failed} 个，${withSummary} 个有文字摘要，联网抓取 ${networkFetches} 次`,
	);
	return threads;
}
