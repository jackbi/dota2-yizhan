import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { NewsCardItem } from '../data/types';
import { decodeEntities, summarizeArticle, toArticleContent } from './articleHtml';

/**
 * 官方新闻层：构建期抓取 dota2.com.cn 的新闻列表与正文。
 *
 * 官网没有 JSON 接口，列表与正文都是服务端渲染的 HTML，而且不带 CORS 头，
 * 浏览器端无法直接 fetch，所以只能在构建期（Node）抓取，再落盘成静态页面。
 *
 * 所有页面都会缓存到 .cache/news/，正文发布后不再改动因此永久缓存，
 * 列表页缓存半小时；网络不可用时退回过期缓存，离线构建（TOURNAMENTS_OFFLINE=1）
 * 完全不联网。
 */

const ORIGIN = 'https://www.dota2.com.cn';
const CACHE_DIR = path.join(process.cwd(), '.cache', 'news');
const OFFLINE = process.env.TOURNAMENTS_OFFLINE === '1';
const USER_AGENT =
	'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/** 每个栏目往回翻几页，官方列表每页 8 条。 */
const LIST_PAGES = 3;
const LIST_TTL_SECONDS = 30 * 60;
/** 官方正文发布后不会再改，命中后永久使用缓存。 */
const ARTICLE_TTL_SECONDS = Number.POSITIVE_INFINITY;
/** 官网是传统单机服务，别一次并发太多。 */
const FETCH_CONCURRENCY = 6;

/**
 * 官方新闻栏目。general 是官网新闻首页的混合流，作为主列表；
 * 其余栏目用于给文章打标签，列表页据此筛选。
 */
export const NEWS_FEEDS = [
	{ id: 'general', label: '综合新闻', path: '/news' },
	{ id: 'gamenews', label: '官方新闻', path: '/news/gamenews' },
	{ id: 'competition', label: '赛事新闻', path: '/news/competition' },
	{ id: 'activity', label: '活动新闻', path: '/news/activity' },
	{ id: 'announcement', label: '公告', path: '/news/announcement' },
] as const;

export type NewsFeedId = (typeof NEWS_FEEDS)[number]['id'];

export const FEED_LABEL: Record<NewsFeedId, string> = {
	general: '综合新闻',
	gamenews: '官方新闻',
	competition: '赛事新闻',
	activity: '活动新闻',
	announcement: '公告',
};

/** 列表页的筛选栏目：综合新闻汇总全部官方栏目，小道消息来自站内示例数据。 */
export const NEWS_FILTERS = NEWS_FEEDS.map((feed) => ({ id: feed.id, label: feed.label }));

export interface OfficialNews {
	/** 官方文章 id（形如 220533），同时作为站内详情页的路由参数。 */
	id: string;
	title: string;
	/** 官方原文地址，只用于构建期抓正文，不会出现在页面上。 */
	url: string;
	/** YYYY-MM-DD */
	date: string;
	img: string;
	/** 文章被收录进哪些官网栏目，可能不止一个。 */
	feeds: NewsFeedId[];
	summary: string;
}

// ---------------------------------------------------------------- 抓取与缓存

function cacheFile(url: string): string {
	return path.join(CACHE_DIR, `${url.replace(`${ORIGIN}/`, '').replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '')}.html`);
}

async function readCache(file: string): Promise<{ text: string; ageMs: number } | null> {
	try {
		const stat = await fs.stat(file);
		return { text: await fs.readFile(file, 'utf8'), ageMs: Date.now() - stat.mtimeMs };
	} catch {
		return null;
	}
}

/** 抓取官方页面并落盘；命中新鲜缓存就直接返回，失败时退回过期缓存。 */
async function fetchHtml(url: string, ttlSeconds: number): Promise<string | null> {
	const file = cacheFile(url);
	const cached = await readCache(file);
	if (cached && cached.ageMs < ttlSeconds * 1000) return cached.text;

	let fresh: string | null = null;
	if (!OFFLINE) {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), 20_000);
		try {
			const res = await fetch(url, { signal: controller.signal, headers: { 'User-Agent': USER_AGENT } });
			if (res.ok) fresh = await res.text();
		} catch {
			fresh = null;
		} finally {
			clearTimeout(timer);
		}
	}
	if (fresh === null) return cached?.text ?? null;

	await fs.mkdir(CACHE_DIR, { recursive: true });
	await fs.writeFile(file, fresh, 'utf8');
	return fresh;
}

/** 限制并发，避免一次性把官网打满。 */
async function mapLimit<T>(items: T[], limit: number, run: (item: T) => Promise<void>): Promise<void> {
	let cursor = 0;
	const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
		while (cursor < items.length) await run(items[cursor++]);
	});
	await Promise.all(workers);
}

// ---------------------------------------------------------------- 列表解析

const ITEM_RE = /<a href="(https:\/\/www\.dota2\.com\.cn\/article\/details\/[^"]+)" class="item"[^>]*>([\s\S]*?)<\/a>/g;
const TITLE_RE = /<h2 class="title">([\s\S]*?)<\/h2>/;
const DATE_RE = /<p class="date">([\s\S]*?)<\/p>/;
const IMG_RE = /<img src="([^"]+)"/;

type FeedItem = Pick<OfficialNews, 'id' | 'title' | 'url' | 'date' | 'img'>;

/**
 * 官网列表页一次只渲染当前栏目，其余栏目是空占位节点，
 * 而 `class="item"` 只在真正的条目上出现，所以整页扫描即可。
 */
function parseFeedPage(html: string): FeedItem[] {
	const items: FeedItem[] = [];
	for (const match of html.matchAll(ITEM_RE)) {
		const body = match[2];
		const rawTitle = body.match(TITLE_RE)?.[1];
		const date = body.match(DATE_RE)?.[1];
		if (!rawTitle || !date) continue;
		items.push({
			id: match[1].match(/(\d+)\.html$/)?.[1] ?? match[1],
			title: decodeEntities(rawTitle.replace(/<[^>]+>/g, '')).trim(),
			url: match[1],
			date: date.trim(),
			img: body.match(IMG_RE)?.[1] ?? '',
		});
	}
	return items;
}

function feedPageUrl(basePath: string, page: number): string {
	return `${ORIGIN}${basePath}/${page === 1 ? 'index' : `index${page}`}.htm`;
}

/** 新文章在前，同日按 id 倒序。 */
function byDateDesc(a: OfficialNews, b: OfficialNews): number {
	if (a.date !== b.date) return a.date < b.date ? 1 : -1;
	return b.id.localeCompare(a.id);
}

// ---------------------------------------------------------------- 对外接口

/** 官方新闻 → 列表卡片数据。没有入选具体栏目的文章按综合新闻展示。 */
export function toNewsCard(item: OfficialNews, featured = false): NewsCardItem {
	return {
		id: item.id,
		title: item.title,
		summary: item.summary,
		date: item.date,
		img: item.img || undefined,
		tags: item.feeds.length > 0 ? item.feeds.map((feed) => FEED_LABEL[feed]) : ['综合新闻'],
		meta: '来源：DOTA2 官网',
		href: `/news/${item.id}`,
		featured,
	};
}

const articleCache = new Map<string, Promise<string>>();

/** 单篇文章正文（已清洗）。同一篇文章在一次构建里只会抓一次。 */
export function fetchNewsArticle(url: string): Promise<string> {
	let pending = articleCache.get(url);
	if (!pending) {
		pending = (async () => {
			const html = await fetchHtml(url, ARTICLE_TTL_SECONDS);
			return html ? toArticleContent(html) : '';
		})();
		articleCache.set(url, pending);
	}
	return pending;
}

let newsPromise: Promise<OfficialNews[]> | null = null;

/**
 * 官方新闻列表。列表页、首页与详情页的 getStaticPaths 共用同一份结果，
 * 一次构建只抓一轮。
 */
export function fetchOfficialNews(): Promise<OfficialNews[]> {
	if (!newsPromise) newsPromise = loadNews();
	return newsPromise;
}

async function loadNews(): Promise<OfficialNews[]> {
	const byId = new Map<string, OfficialNews>();
	for (const feed of NEWS_FEEDS) {
		for (let page = 1; page <= LIST_PAGES; page++) {
			const html = await fetchHtml(feedPageUrl(feed.path, page), LIST_TTL_SECONDS);
			if (!html) continue;
			const items = parseFeedPage(html);
			// 翻到没有条目的页码（官方对超出范围的页码仍返回 200）就停下。
			if (!items.length) break;
			for (const item of items) {
				const existing = byId.get(item.id);
				if (!existing) {
					byId.set(item.id, { ...item, feeds: feed.id === 'general' ? [] : [feed.id], summary: '' });
				} else if (feed.id !== 'general' && !existing.feeds.includes(feed.id)) {
					existing.feeds.push(feed.id);
				}
			}
		}
	}

	const list = [...byId.values()].sort(byDateDesc);
	// 官方列表页的摘要字段是空的，摘要只能从正文首段反推；顺手把正文抓下来，
	// 详情页随后复用同一份缓存，不会重复请求。
	await mapLimit(list, FETCH_CONCURRENCY, async (item) => {
		item.summary = summarizeArticle(await fetchNewsArticle(item.url));
	});
	return list;
}
