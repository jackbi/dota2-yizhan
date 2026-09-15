import { promises as fs } from 'node:fs';
import path from 'node:path';
import { decodeEntities, summarizeArticle } from './articleHtml';
import { mapLimit } from './concurrency';
import { reportSource } from './dataHealth';

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
 * 页面上按来源分开筛选时各自可比。
 *
 * **窗口归属**：NGA 的窗口来自它自己的热榜接口，虎扑没有对应的窗口参数，
 * 所以按「最后回复时间落在窗口内」归属（见 communityFeed）。
 */

const BOARD_URL = 'https://bbs.hupu.com/dota2';
const ORIGIN = 'https://bbs.hupu.com';
const CACHE_DIR = path.join(process.cwd(), '.cache', 'community');
const OFFLINE = process.env.TOURNAMENTS_OFFLINE === '1';

const LIST_TTL_SECONDS = 30 * 60;
/** 详情（正文 + 亮评 + 第一页回复）一次抓齐，按小时级刷新。 */
const DETAIL_TTL_SECONDS = 2 * 3600;
/** 列表页有 49 条，按回复数取前若干条，与 NGA 那套「每窗 15 条」对齐。 */
const THREADS_PER_BOARD = 20;
/** 少于这个回复数的不算热帖，和 NGA 保持一致。 */
const MIN_REPLIES = 5;
const FETCH_CONCURRENCY = 4;
/** 虎扑未见限流，但没必要打太急。 */
const MIN_INTERVAL_MS = 200;

const USER_AGENT =
	'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

export interface HupuThread {
	/** 帖子 id，取自列表里的 `/642425918.html` */
	pid: string;
	title: string;
	author: string;
	/** 帖子总回复数（不是窗口内的） */
	replies: number;
	/** 浏览量 */
	views: number;
	/** 最后回复时间，Unix 秒 */
	lastReplyAt: number;
	/** 主楼首段摘要；抓不到就是空串 */
	summary: string;
}

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

// ---------------------------------------------------------------- 列表解析

/**
 * 列表页只给 `MM-DD HH:mm`，没有年份。
 *
 * 按**北京时间**（UTC+8）解成 Unix 秒：虎扑的时间是北京时间，而构建机的时区不一定，
 * 用本地时区解会让 `lastReplyAt` 随构建设备漂移。跨年时解出来的时间会比"现在"还晚，
 * 那就退回上一年。
 */
function parseMonthDay(value: string, nowSec: number): number {
	const match = /^(\d{2})-(\d{2}) (\d{2}):(\d{2})$/.exec(value.trim());
	if (!match) return 0;
	const month = Number(match[1]);
	const day = Number(match[2]);
	const hour = Number(match[3]);
	const minute = Number(match[4]);
	const at = (year: number) => Math.floor(Date.UTC(year, month - 1, day, hour - 8, minute) / 1000);
	const currentYear = new Date(nowSec * 1000).getUTCFullYear();
	const guess = at(currentYear);
	return guess > nowSec + 3600 ? at(currentYear - 1) : guess;
}

/** 列表行：标题、地址、`回复 / 浏览`、作者、最后回复时间。 */
function toThreads(html: string, nowSec: number): HupuThread[] | null {
	const rows = [...html.matchAll(/<li class="bbs-sl-web-post-body">([\s\S]*?)<\/li>/g)].map((match) => match[1]);
	if (rows.length === 0) return null;
	const threads: HupuThread[] = [];
	for (const block of rows) {
		const href = /<a href="(\/\d+\.html)"/.exec(block)?.[1];
		const pid = href?.replace(/\D/g, '') ?? '';
		const title = stripTags(/class="p-title"[^>]*>([\s\S]*?)<\/a>/.exec(block)?.[1] ?? '');
		const datum = /class="post-datum">([^<]*)</.exec(block)?.[1] ?? '';
		const author = stripTags(/class="post-auth">([\s\S]*?)<\/div>/.exec(block)?.[1] ?? '');
		const [replies, views] = datum.split('/').map((part) => Number(part.trim()) || 0);
		if (!pid || !title || !author) continue;
		threads.push({
			pid,
			title,
			author,
			replies,
			views,
			lastReplyAt: parseMonthDay(/class="post-time">([^<]*)</.exec(block)?.[1] ?? '', nowSec),
			summary: '',
		});
	}
	return threads.filter((thread) => thread.replies >= MIN_REPLIES && thread.lastReplyAt > 0);
}

/** 列表里的标题与作者带内联标签与实体，统一还原成纯文本。 */
function stripTags(html: string): string {
	return decodeEntities(html.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

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

	value = value.sort((a, b) => b.replies - a.replies || b.lastReplyAt - a.lastReplyAt || a.pid.localeCompare(b.pid));
	value = value.slice(0, THREADS_PER_BOARD);
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
 * 拿到的就是 HTML（不是 BBCode），标签只有 `p / img / br / a / div / span`，
 * 实测没有内联 style 与 class，所以只要去掉脚本、事件属性，并把相对地址补成绝对地址即可。
 * 相对地址按 **bbs.hupu.com** 补，不能复用官方新闻那套（那是按 dota2.com.cn 补的）。
 */
function sanitizeHupuHtml(html: string): string {
	return html
		.replace(/<script[\s\S]*?<\/script>/gi, '')
		.replace(/<style[\s\S]*?<\/style>/gi, '')
		.replace(/<!--[\s\S]*?-->/g, '')
		.replace(/\son\w+\s*=\s*"[^"]*"/gi, '')
		.replace(/\s(?:contenteditable|tabindex|draggable|data-imgid)\s*=\s*"[^"]*"/gi, '')
		.replace(/(\s(?:src|href)\s*=\s*")([^"]*)"/gi, (_whole, prefix: string, url: string) => `${prefix}${resolveHupuUrl(url)}"`)
		.replace(/<img\b(?![^>]*\bloading=)/gi, '<img loading="lazy"');
}

function resolveHupuUrl(url: string): string {
	if (!url || /^(?:data:|mailto:|javascript:|#)/i.test(url)) return url;
	if (url.startsWith('//')) return `https:${url}`;
	if (url.startsWith('/')) return `${ORIGIN}${url}`;
	return url;
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
	const key = `hupu-thread-v2-${pid}`;
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

/** 列表 + 摘要，一次构建只抓一轮。取不到就返回空数组（页面按"没有数据"处理）。 */
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
