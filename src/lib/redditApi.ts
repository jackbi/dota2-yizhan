import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { NewsCardItem } from '../data/types';
import { decodeEntities, sanitizeArticleHtml } from './articleHtml';
import { translateToChinese } from './translate';

/**
 * Reddit 内容层：构建期抓取 r/DotA2 的热帖。
 *
 * 取数思路参考 Horizon（https://github.com/Thysrael/Horizon）：优先官方接口，
 * 不行再退到公开端点。区别是这边不接 AI —— 只做原文搬运，不抓评论、不润色、不翻译。
 *
 * 本机实测：old.reddit.com 与 www.reddit.com 的 HTML、.json 一律 403（返回 Blocked），
 * 只有 .rss 能通，而且几分钟内连发几次就 429。所以：
 * - 一次构建只发一个请求，结果落盘缓存，默认一小时；
 * - 429 / 403 / 断网时退回过期缓存，缓存也没有就整块不展示；
 * - 配了 REDDIT_CLIENT_ID / REDDIT_CLIENT_SECRET 时改走官方 OAuth 接口，
 *   能拿到赞数与评论数，也不再受匿名限流影响。
 *
 * 标题、摘要与正文会翻成中文（见 translate.ts），译文按原文哈希永久缓存，
 * 翻译失败就退回英文，不影响构建。
 */

const SUBREDDIT = 'DotA2';
const CACHE_DIR = path.join(process.cwd(), '.cache', 'reddit');
const OFFLINE = process.env.TOURNAMENTS_OFFLINE === '1';
const USER_AGENT =
	'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36';

/** 缓存一小时：Reddit 匿名端点限流很紧，没必要每次构建都去要。 */
const LIST_TTL_SECONDS = 60 * 60;
const MAX_POSTS = 25;
/** 正文翻译只取前这么多字，超长帖翻一半也够读。 */
const MAX_TRANSLATE_CHARS = 3000;
/** 图片直链可以直接内嵌，其余的只能给外链。 */
const IMAGE_URL_RE = /^https?:\/\/(?:i|preview)\.redd\.it\/|^https?:\/\/i\.imgur\.com\/|\.(?:png|jpe?g|gif|webp|mp4)(?:\?|$)/i;

export interface RedditPost {
	id: string;
	title: string;
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
	/** 中文译文；取不到就留空，由页面回退英文 */
	titleZh?: string;
	summaryZh?: string;
	bodyZh?: string;
}

// ---------------------------------------------------------------- 缓存

function cacheFile(): string {
	return path.join(CACHE_DIR, 'hot.json');
}

async function readCache(): Promise<{ posts: RedditPost[]; ageMs: number } | null> {
	try {
		const file = cacheFile();
		const stat = await fs.stat(file);
		return { posts: JSON.parse(await fs.readFile(file, 'utf8')) as RedditPost[], ageMs: Date.now() - stat.mtimeMs };
	} catch {
		return null;
	}
}

async function writeCache(posts: RedditPost[]): Promise<void> {
	await fs.mkdir(CACHE_DIR, { recursive: true });
	await fs.writeFile(cacheFile(), JSON.stringify(posts), 'utf8');
}

async function get(url: string, init: RequestInit = {}, timeoutMs = 20_000): Promise<Response | null> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const response = await fetch(url, { ...init, signal: controller.signal, redirect: 'follow' });
		return response.ok ? response : null;
	} catch {
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

/** RSS（Atom）→ 帖子列表。 */
function parseRss(xml: string): RedditPost[] {
	const posts: RedditPost[] = [];
	for (const match of xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
		const entry = match[1];
		const id = atomText(entry, 'id').trim().replace(/^t3_/, '');
		const title = decodeEntities(atomText(entry, 'title')).trim();
		if (!id || !title) continue;
		const permalink = atomHref(entry, 'link').trim() || `https://www.reddit.com/r/${SUBREDDIT}/comments/${id}/`;
		const content = decodeEntities(atomText(entry, 'content'));
		// RSS 会用 [link] 标出链接帖的目标地址，就在被我们截掉的页脚里，先捞出来。
		const target = (content.match(/<a\s+href="([^"]+)"[^>]*>\s*\[link\]\s*<\/a>/i)?.[1] ?? '').trim();
		const externalUrl = target && !target.includes(`/comments/${id}`) ? target : '';
		const raw = stripRssFooter(content).trim();
		const body = hasReadableBody(raw) ? raw : '';
		posts.push({
			id,
			title,
			author: atomText(entry, 'name').replace(/^\/u\//, '').trim(),
			permalink,
			createdAt: Math.floor(Date.parse(atomText(entry, 'published')) / 1000) || 0,
			body,
			externalUrl,
			image: IMAGE_URL_RE.test(externalUrl) ? externalUrl : '',
			summary: summarizeReddit(body),
			score: null,
			comments: null,
		});
	}
	return posts;
}

/** 官方接口的 JSON → 帖子列表。 */
function parseListing(raw: unknown): RedditPost[] {
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
		const body = hasReadableBody(raw) ? raw : '';
		const externalUrl = data.is_self ? '' : String(data.url ?? '');
		posts.push({
			id,
			title,
			author: String(data.author ?? ''),
			permalink: `https://www.reddit.com${String(data.permalink ?? `/r/${SUBREDDIT}/comments/${id}/`)}`,
			createdAt: Number(data.created_utc) || 0,
			body,
			externalUrl,
			image: IMAGE_URL_RE.test(externalUrl) ? externalUrl : '',
			summary: summarizeReddit(body),
			score: Number(data.score) || 0,
			comments: Number(data.num_comments) || 0,
		});
	}
	return posts;
}

// ---------------------------------------------------------------- 抓取

/** 配了应用凭据就走官方 OAuth（app-only），失败一律退到 RSS。 */
async function fetchViaOAuth(): Promise<RedditPost[] | null> {
	const clientId = process.env.REDDIT_CLIENT_ID;
	const clientSecret = process.env.REDDIT_CLIENT_SECRET;
	if (!clientId || !clientSecret) return null;

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
	const token = (await tokenResponse.json().catch(() => null)) as { access_token?: string } | null;
	if (!token?.access_token) return null;

	const listing = await get(`https://oauth.reddit.com/r/${SUBREDDIT}/hot?limit=${MAX_POSTS}&raw_json=1`, {
		headers: { Authorization: `bearer ${token.access_token}`, 'User-Agent': USER_AGENT },
	});
	if (!listing) return null;

	const posts = parseListing(await listing.json().catch(() => null));
	return posts.length > 0 ? posts.slice(0, MAX_POSTS) : null;
}

async function fetchViaRss(): Promise<RedditPost[] | null> {
	const response = await get(`https://www.reddit.com/r/${SUBREDDIT}/hot/.rss`, {
		headers: { 'User-Agent': USER_AGENT, Accept: 'application/atom+xml,application/xml,text/xml,*/*' },
	});
	if (!response) return null;
	const posts = parseRss(await response.text());
	return posts.length > 0 ? posts.slice(0, MAX_POSTS) : null;
}

let postsPromise: Promise<RedditPost[]> | null = null;

/** r/DotA2 热帖。一次构建只抓一轮，页面多处共用。 */
export function fetchRedditPosts(): Promise<RedditPost[]> {
	if (!postsPromise) postsPromise = loadPosts();
	return postsPromise;
}

/** 正文 HTML → 用于翻译的纯文字段落。 */
function bodyToText(html: string, limit: number): string {
	return decodeEntities(
		html
			.replace(/<\/(?:p|div|blockquote|li|h[1-6])>/gi, '\n')
			.replace(/<br\s*\/?>/gi, '\n')
			.replace(/<[^>]+>/g, ''),
	)
		.split('\n')
		.map((line) => line.replace(/[ \t]+/g, ' ').trim())
		.filter(Boolean)
		.join('\n')
		.slice(0, limit);
}

async function mapLimit<T>(items: T[], limit: number, run: (item: T) => Promise<void>): Promise<void> {
	let cursor = 0;
	const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
		while (cursor < items.length) await run(items[cursor++]);
	});
	await Promise.all(workers);
}

/** 标题、摘要、正文各翻一遍；失败就用英文，绝不因为翻译挂掉构建。 */
async function withTranslations(posts: RedditPost[]): Promise<RedditPost[]> {
	const texts = new Map<string, string | null>();
	const translate = async (text: string) => {
		if (!text) return null;
		if (!texts.has(text)) texts.set(text, await translateToChinese(text));
		return texts.get(text) ?? null;
	};
	await mapLimit(posts, 3, async (post) => {
		post.titleZh = (await translate(post.title)) ?? undefined;
		post.summaryZh = (await translate(post.summary)) ?? undefined;
		const text = bodyToText(post.body, MAX_TRANSLATE_CHARS);
		if (text) post.bodyZh = (await translate(text)) ?? undefined;
	});
	return posts;
}

async function loadPosts(): Promise<RedditPost[]> {
	const cached = await readCache();
	if (cached && cached.ageMs < LIST_TTL_SECONDS * 1000) return cached.posts;
	if (OFFLINE) return cached?.posts ?? [];

	// 先试官方接口，再退到匿名 RSS；两条都不通就用过期缓存。
	const posts = (await fetchViaOAuth()) ?? (await fetchViaRss());
	if (!posts) return cached?.posts ?? [];

	await writeCache(await withTranslations(posts));
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
		title: post.titleZh ?? post.title,
		originalTitle: post.titleZh ? post.title : undefined,
		summary: post.summaryZh ?? post.summary ?? '该帖只有标题，正文在 Reddit 上。',
		date: new Date(post.createdAt * 1000).toISOString().slice(0, 10),
		img: post.image || undefined,
		tags: ['Reddit'],
		badge: 'Reddit 社区',
		meta: post.score != null ? `r/${SUBREDDIT} · ${post.score} 赞 · ${post.comments} 评论` : `r/${SUBREDDIT} · 热度排序`,
		href: `/news/reddit/${post.id}`,
	};
}
