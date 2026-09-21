import path from 'node:path';
import type { NewsCardItem } from '../data/types';
import { decodeEntities, sanitizeArticleHtml } from './articleHtml';
import { cacheFile as cachePath, readCacheJson, writeCacheFile } from './buildCache';
import { mapLimit } from './concurrency';
import { reportSource } from './dataHealth';
import { translateToChinese } from './translate';

/**
 * Reddit 内容层：构建期抓取两个版块的热帖（r/DotA2 总版 + r/compDota2 赛事版）。
 *
 * 取数思路参考 Horizon（https://github.com/Thysrael/Horizon）：优先官方接口，
 * 不行再退到公开端点。区别是这边不接 AI —— 只做原文搬运，不抓评论、不润色、不翻译。
 *
 * 本机实测：old.reddit.com 与 www.reddit.com 的 HTML、.json 一律 403（返回 Blocked），
 * 只有 .rss 能通，而且几分钟内连发几次就 429。所以：
 * - **每个版块**一次构建只发一个请求、两次请求之间留间隔（`FEED_GAP_MS`），结果落盘缓存一小时；
 * - 429 / 403 / 断网时退回过期缓存，缓存也没有就整块不展示；
 * - 配了 REDDIT_CLIENT_ID / REDDIT_CLIENT_SECRET 时改走官方 OAuth 接口，
 *   能拿到赞数与评论数，也不再受匿名限流影响。
 *
 * 标题、摘要与正文会翻成中文（见 translate.ts），译文按原文哈希永久缓存，
 * 翻译失败就退回英文，不影响构建。
 */

/**
 * 抓哪几个版块。`id` 同时用作缓存文件名、健康记录 id 与资讯页的来源锚点。
 *
 * - `reddit`：r/DotA2 总版（实测约 30 条/天，热帖榜更新很快）；
 * - `comp`：r/compDota2 赛事版（实测约 1.5 条/天，聊职业比赛、阵容与转会）。
 *
 * 两边的取数方式完全一样，只是版块名不同；加版块只要往这里加一行。
 */
export const REDDIT_FEEDS = [
	{ id: 'reddit', subreddit: 'DotA2' },
	{ id: 'comp', subreddit: 'compDota2' },
] as const;

export type RedditFeed = (typeof REDDIT_FEEDS)[number];
export type RedditFeedId = RedditFeed['id'];

/** 两个版块之间等一会儿再发下一个请求：匿名端点连发就 429。 */
const FEED_GAP_MS = 8000;
/**
 * 每个版块抓几次、中间等多久。
 *
 * 实测 CI（境外 runner）上连着发两个版块，第二个照样会被匿名端点挡掉——r/DotA2 成、r/compDota2
 * 败，页面里那一栏就空着。命中缓存的那一轮不联网，所以这点等待只在真联网时才发生。
 */
const FETCH_ATTEMPTS = 3;
const RETRY_DELAYS_MS = [10_000, 30_000];

const CACHE_DIR = path.join(process.cwd(), '.cache', 'reddit');
const OFFLINE = process.env.TOURNAMENTS_OFFLINE === '1';
const USER_AGENT =
	'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36';

/** 缓存一小时：Reddit 匿名端点限流很紧，没必要每次构建都去要。 */
const LIST_TTL_SECONDS = 60 * 60;
const MAX_POSTS = 25;
/** 正文翻译只取前这么多字，超长帖翻一半也够读；页面用它提示截断。 */
export const MAX_TRANSLATE_CHARS = 3000;
/**
 * 图片直链可以直接内嵌，其余的（含 v.redd.it 与 .mp4）只能给跳转卡片。
 * 注意别把视频格式算进来：<img src="x.mp4"> 只会渲染成破图。
 */
const IMAGE_URL_RE = /^https?:\/\/(?:i|preview)\.redd\.it\/|^https?:\/\/i\.imgur\.com\/|\.(?:png|jpe?g|gif|webp)(?:\?|$)/i;

export interface RedditPost {
	id: string;
	title: string;
	/** 来自哪个版块（`REDDIT_FEEDS.id`） */
	feed: RedditFeedId;
	/** Reddit 版块名，卡片与详情页的署名用它 */
	subreddit: string;
	/** 去掉 /u/ 前缀 */
	author: string;
	/** 讨论页地址 */
	permalink: string;
	/** 发帖时间，Unix 秒 */
	createdAt: number;
	/** 正文 HTML（已经是 Reddit 渲染好的），没有正文则为空 */
	body: string;
	/** 链接帖的目标地址（图片 / 视频 / 外链），自帖为空 */
	externalUrl: string;
	/** 目标是图片时可以直接内嵌 */
	image: string;
	summary: string;
	/** 赞数，仅官方接口能拿到 */
	score: number | null;
	/** 评论数，仅官方接口能拿到 */
	comments: number | null;
	/** 中文译文；整块缺省表示没翻出来，由下面的取值函数回退英文 */
	zh?: PostTranslation;
}

/** 译文。字段各自可缺省：图片帖只有标题，长帖的正文可能只翻了前半段。 */
export interface PostTranslation {
	title?: string;
	summary?: string;
	body?: string;
}

/** 标题：优先译文。 */
export function postTitle(post: RedditPost): string {
	return post.zh?.title ?? post.title;
}

/**
 * 卡片与 description 用的摘要。
 * 这里必须用 ||：没有正文时 summarizeReddit 返回空串而不是 undefined，
 * 用 ?? 会漏到空摘要上。
 */
export function postSummary(post: RedditPost): string {
	const summary = post.zh?.summary || post.summary;
	if (summary) return summary;
	if (post.image) return '图片帖，点开看图。';
	if (post.externalUrl) return '视频或外链帖，点开查看目标内容。';
	return '该帖只有标题，内容在 Reddit 的讨论页里。';
}

/**
 * 译文是否只覆盖了正文的一部分。
 * 按需从英文正文算，不落进缓存——否则换了缓存格式就再也提示不出来了。
 */
export function isPostBodyTruncated(post: RedditPost): boolean {
	return bodyToText(post.body, MAX_TRANSLATE_CHARS).truncated;
}

/** 译文正文按段落拆开；没翻译时返回空数组，页面回退英文原文。 */
export function postBodyParagraphs(post: RedditPost): string[] {
	return (post.zh?.body ?? '')
		.split('\n')
		.map((line) => line.trim())
		.filter(Boolean);
}

// ---------------------------------------------------------------- 缓存

function cacheFile(id: RedditFeedId): string {
	return cachePath(CACHE_DIR, `list-${id}.json`);
}

/**
 * 单版块时代的缓存名。改名的这一轮要是正好撞上 Reddit 限流，至少还能拿它兜住 r/DotA2，
 * 而不是把整个 Reddit 栏空掉——和 `normalizePost` 迁移旧译文是同一类顾虑。
 */
const LEGACY_CACHE = 'hot.json';

function feedOf(id: RedditFeedId): RedditFeed {
	const feed = REDDIT_FEEDS.find((item) => item.id === id);
	// 调用方只可能传表里的 id，这里只是为了让类型收窄。
	if (!feed) throw new Error(`未知的 Reddit 版块：${id}`);
	return feed;
}

/**
 * 早期版本把译文平铺在 titleZh / summaryZh / bodyZh 上，读缓存时顺手迁移到 zh，
 * 否则改完字段名之后旧缓存里的译文会静默失效（而 Reddit 限流又不一定抓得回来）。
 */
function normalizePost(raw: RedditPost & { titleZh?: string; summaryZh?: string; bodyZh?: string }): RedditPost {
	const { titleZh, summaryZh, bodyZh, ...rest } = raw;
	if (rest.zh || !(titleZh || summaryZh || bodyZh)) return rest;
	return { ...rest, zh: { title: titleZh, summary: summaryZh, body: bodyZh } };
}

type CachedPost = RedditPost & { titleZh?: string; summaryZh?: string; bodyZh?: string };

/** 读缓存，连同它的年龄；老字段在读的时候顺手迁移（见 `normalizePost`）。 */
async function readCache(id: RedditFeedId): Promise<{ posts: RedditPost[]; ageMs: number } | null> {
	const hit = await readCacheJson<CachedPost[]>(cacheFile(id));
	if (hit && Array.isArray(hit.value)) return { posts: hit.value.map(normalizePost), ageMs: hit.ageMs };

	/*
	 * 只有 r/DotA2 有旧缓存可捡。它只是这一轮的兜底：那份缓存一旦过期、并且真的抓成功了，
	 * 就会按新文件名写回去，旧的 `hot.json` 之后不再有人读。
	 */
	if (id !== 'reddit') return null;
	const legacy = await readCacheJson<CachedPost[]>(cachePath(CACHE_DIR, LEGACY_CACHE));
	if (!legacy || !Array.isArray(legacy.value)) return null;
	return { posts: legacy.value.map(normalizePost).map((post) => withFeed(post, id)), ageMs: legacy.ageMs };
}

function writeCache(id: RedditFeedId, posts: RedditPost[]): Promise<void> {
	return writeCacheFile(cacheFile(id), JSON.stringify(posts));
}

/** 老缓存里没有版块字段，读出来按当前版块补齐，页面与详情页不用再猜。 */
function withFeed(post: RedditPost, id: RedditFeedId): RedditPost {
	return { ...post, feed: id, subreddit: feedOf(id).subreddit };
}

/**
 * 最近一次抓取失败的原因，写进健康记录。
 * 只报一句「请求失败」看不出是被限流（429）还是根本没连上，维修时白猜一轮。
 */
let lastFetchFailure = '';

async function get(url: string, init: RequestInit = {}, timeoutMs = 20_000): Promise<Response | null> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const response = await fetch(url, { ...init, signal: controller.signal, redirect: 'follow' });
		if (!response.ok) {
			const retryAfter = response.headers.get('retry-after');
			lastFetchFailure = `HTTP ${response.status}${retryAfter ? `，retry-after ${retryAfter}` : ''}`;
			return null;
		}
		lastFetchFailure = '';
		return response;
	} catch (error) {
		lastFetchFailure = error instanceof Error ? error.name : 'fetch 失败';
		return null;
	} finally {
		clearTimeout(timer);
	}
}

// ---------------------------------------------------------------- 解析

function atomText(xml: string, tag: string): string {
	const match = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i'));
	return match ? match[1] : '';
}

function atomHref(xml: string, tag: string): string {
	const match = xml.match(new RegExp(`<${tag}[^>]*\\bhref="([^"]*)"`, 'i'));
	return match ? match[1] : '';
}

/**
 * Reddit 的 RSS 会在正文后面追加一段 “submitted by /u/x [link] [comments]” 的尾巴，
 * 它不是帖子内容，截掉。
 */
function stripRssFooter(body: string): string {
	return body.split(/\s*submitted by\s/i)[0] ?? body;
}

/**
 * 正文里是否真有可读内容。
 * 链接帖在 RSS 里的 content 只是一个 `&#32;` 之类的占位，不该当成正文，
 * 否则会为它生成一个空白的站内详情页。
 */
function hasReadableBody(bodyHtml: string): boolean {
	return decodeEntities(bodyHtml.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim().length > 0;
}

/** 正文里的纯文字摘要，取第一段像样的文字；纯链接段落跳过。 */
export function summarizeReddit(bodyHtml: string, maxLength = 120): string {
	const lines = decodeEntities(bodyHtml.replace(/<[^>]+>/g, '\n'))
		.split('\n')
		.map((line) =>
			line
				.replace(/https?:\/\/\S+/gi, ' ')
				.replace(/\s+/g, ' ')
				.trim(),
		)
		.filter((line) => line.length >= 12);
	const first = lines[0] ?? '';
	if (!first) return '';
	return first.length > maxLength ? `${first.slice(0, maxLength)}…` : first;
}

/** 两条取数路径解析出来的字段是一致的，统一在这里拼成帖子对象。 */
function toPost(feed: RedditFeed, fields: {
	id: string;
	title: string;
	author: string;
	permalink: string;
	createdAt: number;
	bodyHtml: string;
	externalUrl: string;
	score: number | null;
	comments: number | null;
}): RedditPost {
	const body = fields.bodyHtml.trim();
	return {
		id: fields.id,
		title: fields.title,
		feed: feed.id,
		subreddit: feed.subreddit,
		author: fields.author,
		permalink: fields.permalink,
		createdAt: fields.createdAt,
		body,
		externalUrl: fields.externalUrl,
		image: IMAGE_URL_RE.test(fields.externalUrl) ? fields.externalUrl : '',
		summary: summarizeReddit(body),
		score: fields.score,
		comments: fields.comments,
	};
}

/** RSS（Atom）→ 帖子列表。 */
function parseRss(xml: string, feed: RedditFeed): RedditPost[] {
	const posts: RedditPost[] = [];
	for (const match of xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
		const entry = match[1];
		const id = atomText(entry, 'id').trim().replace(/^t3_/, '');
		const title = decodeEntities(atomText(entry, 'title')).trim();
		if (!id || !title) continue;
		const permalink =
			atomHref(entry, 'link').trim() || `https://www.reddit.com/r/${feed.subreddit}/comments/${id}/`;
		const content = decodeEntities(atomText(entry, 'content'));
		// RSS 会用 [link] 标出链接帖的目标地址，就在被我们截掉的页脚里，先捞出来。
		const target = (content.match(/<a\s+href="([^"]+)"[^>]*>\s*\[link\]\s*<\/a>/i)?.[1] ?? '').trim();
		const externalUrl = target && !target.includes(`/comments/${id}`) ? target : '';
		const raw = stripRssFooter(content).trim();
		posts.push(
			toPost(feed, {
				id,
				title,
				author: atomText(entry, 'name').replace(/^\/u\//, '').trim(),
				permalink,
				createdAt: Math.floor(Date.parse(atomText(entry, 'published')) / 1000) || 0,
				bodyHtml: hasReadableBody(raw) ? raw : '',
				externalUrl,
				score: null,
				comments: null,
			}),
		);
	}
	return posts;
}

/** 官方接口的 JSON → 帖子列表。 */
function parseListing(raw: unknown, feed: RedditFeed): RedditPost[] {
	const children = (raw as { data?: { children?: unknown } })?.data?.children;
	if (!Array.isArray(children)) return [];
	const posts: RedditPost[] = [];
	for (const child of children) {
		const data = (child as { data?: Record<string, unknown> })?.data;
		if (!data || data.over_18) continue;
		const id = String(data.id ?? '');
		const title = String(data.title ?? '').trim();
		if (!id || !title) continue;
		const raw = stripRssFooter(decodeEntities(String(data.selftext_html ?? ''))).trim();
		posts.push(
			toPost(feed, {
				id,
				title,
				author: String(data.author ?? ''),
				permalink: `https://www.reddit.com${String(data.permalink ?? `/r/${feed.subreddit}/comments/${id}/`)}`,
				createdAt: Number(data.created_utc) || 0,
				bodyHtml: hasReadableBody(raw) ? raw : '',
				externalUrl: data.is_self ? '' : String(data.url ?? ''),
				score: Number(data.score) || 0,
				comments: Number(data.num_comments) || 0,
			}),
		);
	}
	return posts;
}

// ---------------------------------------------------------------- 抓取

/** app-only 令牌窗口内复用一份，重试时不用每次都去换。 */
let tokenCache: { value: string; expiresAt: number } | null = null;

/** 配了应用凭据就走官方 OAuth（app-only），失败一律退到 RSS。 */
async function fetchViaOAuth(feed: RedditFeed): Promise<RedditPost[] | null> {
	const clientId = process.env.REDDIT_CLIENT_ID;
	const clientSecret = process.env.REDDIT_CLIENT_SECRET;
	if (!clientId || !clientSecret) return null;

	let accessToken = tokenCache && tokenCache.expiresAt > Date.now() ? tokenCache.value : '';
	if (!accessToken) {
		const tokenResponse = await get('https://www.reddit.com/api/v1/access_token', {
			method: 'POST',
			headers: {
				Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
				'Content-Type': 'application/x-www-form-urlencoded',
				'User-Agent': USER_AGENT,
			},
			body: 'grant_type=client_credentials',
		});
		if (!tokenResponse) return null;
		const token = (await tokenResponse.json().catch(() => null)) as {
			access_token?: string;
			expires_in?: number;
		} | null;
		if (!token?.access_token) return null;
		accessToken = token.access_token;
		// 提前一分钟作废，免得卡在过期那一刻。
		tokenCache = { value: accessToken, expiresAt: Date.now() + Math.max((token.expires_in ?? 3600) - 60, 60) * 1000 };
	}

	const listing = await get(`https://oauth.reddit.com/r/${feed.subreddit}/hot?limit=${MAX_POSTS}&raw_json=1`, {
		headers: { Authorization: `bearer ${accessToken}`, 'User-Agent': USER_AGENT },
	});
	if (!listing) return null;

	const posts = parseListing(await listing.json().catch(() => null), feed);
	return posts.length > 0 ? posts.slice(0, MAX_POSTS) : null;
}

async function fetchViaRss(feed: RedditFeed): Promise<RedditPost[] | null> {
	const response = await get(`https://www.reddit.com/r/${feed.subreddit}/hot/.rss`, {
		headers: { 'User-Agent': USER_AGENT, Accept: 'application/atom+xml,application/xml,text/xml,*/*' },
	});
	if (!response) return null;
	const posts = parseRss(await response.text(), feed);
	return posts.length > 0 ? posts.slice(0, MAX_POSTS) : null;
}

let allPostsPromise: Promise<RedditPost[]> | null = null;

/**
 * 两个版块的热帖（按 `REDDIT_FEEDS` 顺序拼成一条）。一次构建只抓一轮，页面多处共用。
 *
 * **串行**：匿名端点连发就 429（两个版块之间隔 `FEED_GAP_MS`）。命中缓存的那一轮不联网，
 * 也就没有这个间隔带来的等待。
 */
export function fetchRedditPosts(): Promise<RedditPost[]> {
	if (!allPostsPromise) allPostsPromise = loadAllFeeds();
	return allPostsPromise;
}

async function loadAllFeeds(): Promise<RedditPost[]> {
	const posts: RedditPost[] = [];
	for (const [index, feed] of REDDIT_FEEDS.entries()) {
		if (index > 0) await sleep(FEED_GAP_MS);
		posts.push(...(await loadFeed(feed)));
	}
	return posts;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** 正文 HTML → 用于翻译的纯文字段落，同时告诉调用方有没有被截断。 */
function bodyToText(html: string, limit: number): { text: string; truncated: boolean } {
	const text = decodeEntities(
		html
			.replace(/<\/(?:p|div|blockquote|li|h[1-6])>/gi, '\n')
			.replace(/<br\s*\/?>/gi, '\n')
			.replace(/<[^>]+>/g, ''),
	)
		.split('\n')
		.map((line) => line.replace(/[ \t]+/g, ' ').trim())
		.filter(Boolean)
		.join('\n');
	return { text: text.slice(0, limit), truncated: text.length > limit };
}

/**
 * 标题、摘要、正文各翻一遍，返回带译文的副本。
 * 失败就用英文，绝不因为翻译挂掉构建。
 */
async function withTranslations(posts: RedditPost[]): Promise<RedditPost[]> {
	const done = new Map<string, string | null>();
	const translate = async (text: string) => {
		if (!text) return null;
		if (!done.has(text)) done.set(text, await translateToChinese(text));
		return done.get(text) ?? null;
	};
	const translated: RedditPost[] = [...posts];
	await mapLimit(posts, 3, async (post) => {
		const body = bodyToText(post.body, MAX_TRANSLATE_CHARS);
		translated[posts.indexOf(post)] = {
			...post,
			zh: {
				title: (await translate(post.title)) ?? undefined,
				summary: (await translate(post.summary)) ?? undefined,
				body: body.text ? ((await translate(body.text)) ?? undefined) : undefined,
			},
		};
	});
	return translated;
}

async function loadFeed(feed: RedditFeed): Promise<RedditPost[]> {
	/** 两个版块各写一条健康记录，汇总里一眼看得出是哪个版块挂了。 */
	const healthId = `reddit-${feed.id}`;
	const label = `Reddit r/${feed.subreddit}`;
	const cached = await readCache(feed.id);
	if (cached && cached.ageMs < LIST_TTL_SECONDS * 1000) {
		await reportSource(healthId, label, 'cache', `${cached.posts.length} 条，命中 1 小时缓存`);
		return cached.posts;
	}
	if (OFFLINE) {
		const posts = cached?.posts ?? [];
		await reportSource(healthId, label, posts.length > 0 ? 'cache' : 'empty', `${posts.length} 条，离线构建`);
		return posts;
	}

	/*
	 * 先试官方接口，再退到匿名 RSS，两条都不通就隔一会儿再来一轮。
	 * 匿名端点被限流是常态（CI 上连着抓两个版块，第二个就 429 了），退避重试能把这一轮救回来。
	 */
	let fetched: RedditPost[] | null = null;
	let viaOAuth = false;
	for (let attempt = 0; attempt < FETCH_ATTEMPTS && !fetched; attempt += 1) {
		if (attempt > 0) await sleep(RETRY_DELAYS_MS[attempt - 1] ?? 30_000);
		const fromOAuth = await fetchViaOAuth(feed);
		if (fromOAuth) {
			fetched = fromOAuth;
			viaOAuth = true;
			break;
		}
		fetched = await fetchViaRss(feed);
	}
	if (!fetched) {
		const posts = cached?.posts ?? [];
		const why = lastFetchFailure ? `（${lastFetchFailure}）` : '';
		await reportSource(
			healthId,
			label,
			posts.length > 0 ? 'cache' : 'empty',
			posts.length > 0
				? `${posts.length} 条，取不到新的${why}，退回过期缓存`
				: `请求失败且无缓存${why}`,
		);
		return posts;
	}

	const posts = (await withTranslations(fetched)).map((post) => withFeed(post, feed.id));
	await writeCache(feed.id, posts);
	const channel = viaOAuth ? 'OAuth 接口' : '匿名 RSS';
	await reportSource(healthId, label, 'fresh', `${posts.length} 条，来自${channel}`);
	return posts;
}

// ---------------------------------------------------------------- 页面数据

/**
 * 站内渲染 Reddit 正文：先按官方文章的规则清掉脚本、内联样式与事件属性，
 * 再把所有链接收成「只允许 http(s) + 新窗口打开」。
 */
export function renderRedditBody(body: string): string {
	return sanitizeArticleHtml(body).replace(/<a\b[^>]*>([\s\S]*?)<\/a>/gi, (whole, label: string) => {
		const href = whole.match(/\bhref\s*=\s*"([^"]*)"/i)?.[1] ?? '';
		if (!/^https?:\/\//i.test(href)) return label;
		return `<a href="${href}" target="_blank" rel="noopener noreferrer nofollow">${label}</a>`;
	});
}

/** Reddit 帖子 → 资讯中心卡片。全部走站内详情页，不再往外跳。 */
export function toRedditCard(post: RedditPost): NewsCardItem {
	return {
		id: `reddit-${post.id}`,
		title: postTitle(post),
		originalTitle: post.zh?.title ? post.title : undefined,
		summary: postSummary(post),
		date: new Date(post.createdAt * 1000).toISOString().slice(0, 10),
		img: post.image || undefined,
		tags: ['Reddit'],
		badge: 'Reddit 社区',
		meta: post.score != null ? `r/${post.subreddit} · ${post.score} 赞 · ${post.comments} 评论` : `r/${post.subreddit} · 热度排序`,
		href: `/news/reddit/${post.id}`,
	};
}
