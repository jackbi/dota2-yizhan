import { promises as fs } from 'node:fs';
import path from 'node:path';
import { decodeEntities } from './articleHtml';
import { collectNicknames } from './ngaBbcode';

/**
 * NGA 社区热帖层：构建期抓取 NGA DOTA2 版块的热帖列表与主楼摘要。
 *
 * 为什么走 APP 接口：网页版 thread.php 对访客直接 403（靠 JS 下发 guestJs cookie
 * 再重载），而 APP 侧 app_api.php / read.php 免鉴权返回 JSON，是唯一可行的入口。
 * 这两个接口没有官方承诺，随时可能收紧，所以一律按"尽力而为"处理：
 * 取不到就退回过期缓存，再取不到就留空，绝不编数据。
 */

const API = 'https://bbs.nga.cn';
/** DOTA2 版块，取自 app_api.php?__lib=home&__act=category。 */
const DOTA2_FID = 321;
const CACHE_DIR = path.join(process.cwd(), '.cache', 'community');
const OFFLINE = process.env.TOURNAMENTS_OFFLINE === '1';
/** APP 接口认这个 UA，返回的数据字段更完整。 */
const USER_AGENT = 'NGA_WP_JW';

let boardPromise: Promise<CommunityThread[]> | null = null;
/** 帖子详情按 tid 记忆，列表页与详情页共用同一次请求。 */
const threadCache = new Map<string, Promise<ThreadDetail | null>>();

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
/** 主楼基本不改，但热评会变，按周刷新一次。 */
const THREAD_TTL_SECONDS = 7 * 24 * 3600;
const FETCH_CONCURRENCY = 4;
/** NGA 未见限流，但没必要打太急。 */
const MIN_INTERVAL_MS = 200;

/** type 字段的位标记：锁定的帖子和合集入口不该出现在热帖榜里。 */
const TYPE_LOCKED = 1 << 10;
const TYPE_COLLECTION = 1 << 15;

export interface HotThread {
	tid: string;
	title: string;
	author: string;
	/** 窗口内的回复数；NGA 的热榜就是按它倒序。 */
	replies: number;
	/** 发帖时间，Unix 秒 */
	postedAt: number;
	/** 最后回复时间，Unix 秒 */
	lastReplyAt: number;
	lastPoster: string;
	/** 主楼首段摘要；主楼只有图片时为空 */
	summary: string;
}

/** 热帖 + 它上了哪几个时间窗的榜。 */
export interface CommunityThread extends HotThread {
	windows: HotWindowDays[];
}

/** 一层楼。站内详情页只展示正文，昵称见 ThreadDetail.nicknames。 */
export interface ThreadFloor {
	pid: string;
	/** 楼层号，主楼为 0。 */
	floor: number;
	/** 发帖时间，Unix 秒。 */
	time: number;
	/** 赞数 */
	score: number;
	/** 原始 BBCode 正文 */
	content: string;
	/** 楼层作者 id，用于反查昵称。 */
	authorId: string;
}

/** 一个帖子的详情，主楼、本页楼层与热评一次抓齐。 */
export interface ThreadDetail {
	/** 主楼首段摘要，列表页用 */
	summary: string;
	/** 主楼 BBCode 正文 */
	content: string;
	/** 本页楼层（含主楼） */
	floors: ThreadFloor[];
	/** 楼主筛出的热评，按赞数倒序 */
	hotReplies: ThreadFloor[];
	/** 全帖楼层总数（含主楼） */
	totalFloors: number;
	/**
	 * 楼层作者 id → 昵称。
	 * 接口对未登录访问会把昵称打码成 `UID:123`，只有引用文本里带着真实昵称，
	 * 所以这里只能从正文里反推，拿不到的就留空。
	 */
	nicknames: Record<string, string>;
}

// ---------------------------------------------------------------- 请求与缓存

let lastRequestAt = 0;
let paceQueue: Promise<void> = Promise.resolve();

/** 串行化请求间隔，避免并发同时穿过限速窗口。 */
function pace(): Promise<void> {
	paceQueue = paceQueue.then(async () => {
		const wait = lastRequestAt + MIN_INTERVAL_MS - Date.now();
		if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
		lastRequestAt = Date.now();
	});
	return paceQueue;
}

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
	return path.join(CACHE_DIR, `${key}.json`);
}

async function readCache<T>(key: string): Promise<{ value: T; ageMs: number } | null> {
	try {
		const file = cacheFile(key);
		const stat = await fs.stat(file);
		return { value: JSON.parse(await fs.readFile(file, 'utf8')) as T, ageMs: Date.now() - stat.mtimeMs };
	} catch {
		return null;
	}
}

async function writeCache(key: string, value: unknown): Promise<void> {
	await fs.mkdir(CACHE_DIR, { recursive: true });
	await fs.writeFile(cacheFile(key), JSON.stringify(value), 'utf8');
}

async function mapLimit<T>(items: T[], limit: number, run: (item: T) => Promise<void>): Promise<void> {
	let cursor = 0;
	const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
		while (cursor < items.length) await run(items[cursor++]);
	});
	await Promise.all(workers);
}

// ---------------------------------------------------------------- 地址

/** 帖子在网页版的地址，用于署名跳转。 */
export function ngaThreadUrl(tid: string): string {
	return `${API}/read.php?tid=${tid}`;
}

function hotUrl(days: number): string {
	return `${API}/app_api.php?__lib=subject&__act=hot&fid=${DOTA2_FID}&days=${days}&__output=11`;
}

// ---------------------------------------------------------------- 热帖榜

/** 热帖榜：data[0] 是帖子数组，data[1] 是附加信息。 */
function toThreads(raw: unknown): HotThread[] | null {
	const groups = (raw as { data?: unknown })?.data;
	if (!Array.isArray(groups) || !Array.isArray(groups[0])) return null;
	const threads = (groups[0] as Record<string, unknown>[])
		.filter((row) => {
			const type = Number(row.type) || 0;
			return !(type & (TYPE_LOCKED | TYPE_COLLECTION));
		})
		.map((row) => ({
			tid: String(row.tid ?? ''),
			title: String(row.subject ?? '').trim(),
			author: String(row.author ?? ''),
			replies: Number(row.replies) || 0,
			postedAt: Number(row.postdate) || 0,
			lastReplyAt: Number(row.lastpost) || 0,
			lastPoster: String(row.lastposter ?? ''),
			summary: '',
		}))
		.filter((thread) => thread.tid && thread.title && thread.replies >= MIN_REPLIES);
	return threads.length > 0 ? threads : null;
}

async function loadHotList(days: number): Promise<HotThread[] | null> {
	const key = `hot-${days}`;
	const cached = await readCache<HotThread[]>(key);
	if (cached && cached.ageMs < LIST_TTL_SECONDS * 1000) return cached.value;

	let value: HotThread[] | null = null;
	if (!OFFLINE) {
		for (let attempt = 0; attempt < 2 && value === null; attempt++) {
			const text = await fetchText(hotUrl(days));
			if (text === null) continue;
			try {
				value = toThreads(JSON.parse(text));
			} catch {
				value = null;
			}
		}
	}
	if (value === null) return cached?.value ?? null;

	await writeCache(key, value);
	return value;
}

// ---------------------------------------------------------------- 主楼摘要

/** __R 有时是数组、有时是以 tid 为键的对象，两种都要能取到楼层列表。 */
function firstFloorList(data: unknown): Record<string, unknown>[] | null {
	const replies = (data as { __R?: unknown })?.__R;
	if (Array.isArray(replies)) return replies as Record<string, unknown>[];
	if (replies && typeof replies === 'object') {
		for (const value of Object.values(replies)) {
			if (Array.isArray(value)) return value as Record<string, unknown>[];
		}
	}
	return null;
}

/**
 * 主楼正文是 HTML + BBCode 混排，摘要只取第一段可读文字。
 *
 * 注意别剥掉 [quote]：主楼常是"引用公告"的形态（如更新说明），整段剥掉就什么都不剩，
 * 所以引用只去标签、保留正文。附件在正文里以 `mon_202609/10/xxx.jpg` 这样的裸路径出现，
 * 外链则是 `[标题] https://...` 的形式，两者都会让摘要变成无意义字符，先去掉。
 */
function summarizePost(content: string): string {
	const text = decodeEntities(
		content
			.replace(/<img\b[^>]*>/gi, ' ')
			.replace(/\[img\][\s\S]*?\[\/img\]/gi, ' ')
			.replace(/\[collapse[^\]]*\][\s\S]*?\[\/collapse\]/gi, ' ')
			.replace(/\[s:[^\]]*\]/gi, ' ')
			.replace(/\[\/?[a-z*][^\]]*\]/gi, ' ')
			.replace(/\.?\/?mon_\d{6}\/[\w./-]+/gi, ' ')
			.replace(/<br\s*\/?>/gi, '\n')
			.replace(/<[^>]+>/g, ' '),
	);
	for (const line of text.split('\n')) {
		const clean = line
			.replace(/https?:\/\/\S+/gi, ' ')
			.replace(/[[\]]/g, ' ')
			.replace(/\s+/g, ' ')
			.trim();
		if (clean.length < 12) continue;
		return clean.length > 96 ? `${clean.slice(0, 96)}…` : clean;
	}
	return '';
}

/** 一层楼 → 站内展示结构；没有正文的楼层（纯图片被吞掉的情况）直接丢弃。 */
function toFloor(row: Record<string, unknown>): ThreadFloor | null {
	const content = typeof row.content === 'string' ? row.content : '';
	if (!content) return null;
	return {
		pid: String(row.pid ?? ''),
		floor: Number(row.lou) || 0,
		time: Number(row.postdatetimestamp) || 0,
		score: Number(row.score) || 0,
		content,
		authorId: String(row.authorid ?? ''),
	};
}

function toFloors(rows: unknown): ThreadFloor[] {
	if (!Array.isArray(rows)) return [];
	return rows.map((row) => toFloor(row as Record<string, unknown>)).filter((floor): floor is ThreadFloor => floor !== null);
}

/** read.php 的响应 → 帖子详情。 */
function toThreadDetail(raw: unknown): ThreadDetail | null {
	const data = (raw as { data?: Record<string, unknown> })?.data;
	if (!data) return null;
	const rows = firstFloorList(data) ?? [];
	const floors = toFloors(rows);
	const main = floors.find((floor) => floor.floor === 0) ?? floors[0];
	if (!main) return null;

	// 热评挂在主楼的 hotreply 字段上，按赞数取前几条。
	const mainRow = rows.find((row) => Number(row.lou) === 0) ?? rows[0];
	const hotReplies = toFloors(mainRow?.hotreply)
		.sort((a, b) => b.score - a.score)
		.slice(0, 5);

	// 昵称只能从引用文本里反推，主楼、楼层、热评的正文一起参与匹配。
	const nicknames = Object.fromEntries(
		collectNicknames([main.content, ...floors.map((floor) => floor.content), ...hotReplies.map((floor) => floor.content)]),
	);

	return {
		summary: summarizePost(main.content),
		content: main.content,
		floors,
		hotReplies,
		totalFloors: Number(data.__ROWS) || floors.length,
		nicknames,
	};
}

/** 用 JSON 接口取整个帖子；正文里出现非法转义时整段解析失败，交给调用方兜底。 */
async function fetchThreadJson(tid: string): Promise<ThreadDetail | null> {
	const text = await fetchText(`${API}/read.php?tid=${tid}&__output=11`);
	if (text === null) return null;
	return toThreadDetail(JSON.parse(text));
}

/**
 * read.php 的 JSON 会因为正文里的 `\u`、`\t` 之类字符整段解析失败（官方文档也承认），
 * 这时退回去掉 __output 的 HTML 版本：GBK 编码，主楼在 <p id='postcontent0'>。
 * 只能救回主楼，楼层与热评就欠奉了。
 */
async function fetchThreadHtml(tid: string): Promise<ThreadDetail | null> {
	const html = await fetchText(`${API}/read.php?tid=${tid}&noBBCode`, 'gb18030');
	if (html === null) return null;
	const match = html.match(/<p[^>]*\bid=['"]postcontent0['"][^>]*>([\s\S]*?)<\/p>/i);
	if (!match) return null;
	const content = match[1];
	return {
		summary: summarizePost(content),
		content,
		floors: [{ pid: '', floor: 0, time: 0, score: 0, content, authorId: '' }],
		hotReplies: [],
		totalFloors: 1,
		nicknames: {},
	};
}

/**
 * 帖子详情。主楼、本页楼层、热评共用 read.php 这一次请求，
 * 列表页只用其中的摘要，所以详情页不会再产生额外请求。
 */
export function fetchThreadDetail(tid: string): Promise<ThreadDetail | null> {
	let pending = threadCache.get(tid);
	if (!pending) {
		pending = loadThread(tid);
		threadCache.set(tid, pending);
	}
	return pending;
}

async function loadThread(tid: string): Promise<ThreadDetail | null> {
	const key = `thread-v2-${tid}`;
	const cached = await readCache<ThreadDetail>(key);
	if (cached && cached.ageMs < THREAD_TTL_SECONDS * 1000) return cached.value;
	if (OFFLINE) return cached?.value ?? null;

	let detail: ThreadDetail | null = null;
	for (let attempt = 0; attempt < 2 && detail === null; attempt++) {
		try {
			detail = await fetchThreadJson(tid);
		} catch {
			detail = null;
		}
	}
	if (detail === null) detail = await fetchThreadHtml(tid);
	if (detail === null) return cached?.value ?? null;

	await writeCache(key, detail);
	return detail;
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
	const byId = new Map<string, CommunityThread>();
	for (const window of HOT_WINDOWS) {
		const list = await loadHotList(window.days);
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
	await mapLimit(threads, FETCH_CONCURRENCY, async (thread) => {
		thread.summary = (await fetchThreadDetail(thread.tid))?.summary ?? '';
	});
	return threads;
}
