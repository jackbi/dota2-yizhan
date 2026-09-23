import path from 'node:path';
import type { NewsCardItem } from '../data/types';
import { decodeEntities, sanitizeArticleHtml, summarizeArticle } from './articleHtml';
import { cacheFile as cachePath, isFresh, readCacheJson, readRawJson, writeCacheFile } from './buildCache';
import { mapLimit } from './concurrency';
import { reportSource } from './dataHealth';
import { type ImageChannel, type LocalImageSource, localizeImages } from './localImages';

/**
 * 完美世界电竞（DOTA2 国服运营方）的资讯。
 *
 * **两条路，直连优先。**
 *
 * - 主路直连它自己的两个 JSON 接口：列表 `getHomeInformation`、正文 `getAppNewsById`。
 *   无 cookie、无 puppeteer，两个接口在开发机与 GitHub runner 上实测都是 0.7 秒左右，
 *   `title` / `summary` / `publishTime` / `content` / `thumbnail` 全是现成字段。
 * - 兜底走 RSSHub 的 `/wmpvp/news/1`。它的价值不在"能取到"（直连也能），而在上游改字段时
 *   那条路由由 RSSHub 的维护者跟着改，等于白捡一层别人替你维护的解析。代价是它自带 5 分钟缓存、
 *   而且是**别人的服务**，所以只当备胎：它挂了不该让这一栏空掉，反过来也一样。
 *
 * 两条都不通就退回旧缓存（多旧都用）。
 *
 * 这一层是构建期跑的（`appengine.wmpvp.com` 没有 CORS 头，浏览器里取不到），
 * 与官网新闻层同理。
 */

const LIST_URL =
	'https://appengine.wmpvp.com/steamcn/community/homepage/getHomeInformation?gameTypeStr=1&pageNum=1&pageSize=20';
const DETAIL_URL = (id: string) => `https://appactivity.wmpvp.com/steamcn/app/news/getAppNewsById?gameType=1&newsId=${id}`;
/** 原文地址，页面上给读者的出口。 */
const ARTICLE_URL = (id: string) => `https://news.wmpvp.com/news.html?id=${id}&gameTypeStr=1`;
/**
 * RSSHub 实例。默认这个公共实例（实测 GitHub runner 上 200 / 103KB / 5.3 秒）；
 * 官方那个 `rsshub.app` 被 Cloudflare 挑战挡着，实测 403，用不了。
 * 要换自建实例只改环境变量，不用动代码。
 */
const RSSHUB_BASE = (process.env.RSSHUB_BASE || 'https://rsshub.rssforever.com').replace(/\/+$/, '');
const RSSHUB_ROUTE = '/wmpvp/news/1';

const CACHE_DIR = path.join(process.cwd(), '.cache', 'wmpvp');
/** 列表半小时——和官网新闻那条一致；正文发布后基本不改，命中就永久用。 */
const LIST_TTL_SECONDS = 30 * 60;
const OFFLINE = process.env.TOURNAMENTS_OFFLINE === '1';
const FETCH_CONCURRENCY = 4;
const USER_AGENT =
	'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/**
 * 配图频道。
 *
 * `cdn.wmpvp.com` 判 Referer：实测不带 403、带本站 403、只有带 `news.wmpvp.com` 才 200。
 * 而站里的 `<img>` 一律 `referrerpolicy="no-referrer"`（为了迁就 Steam 的 CDN），
 * 热链出去必然是满屏 403——只能构建期带上它自己家的 Referer 把图取回来。
 *
 * 尺寸给得宽松、`fit` 用 `contain`：这是文章配图，不能像头像那样裁成固定比例。
 */
export const WMPVP_IMAGE_CHANNEL: ImageChannel = {
	dir: 'wmpvp-images',
	width: 1200,
	height: 1200,
	// 实测单张 0.5MB 上下，留 4MB 余量；再大就当抓错了。
	maxBytes: 4 * 1024 * 1024,
	concurrency: 4,
	headers: { Referer: 'https://news.wmpvp.com/' },
	fit: 'contain',
};

/**
 * 让图床自己把图压小。
 *
 * 原图最大 3.8MB、中位 1.5MB，111 张就是 200MB——部署要传、读者要下，两边都不能接受。
 * 好在 `cdn.wmpvp.com` 是阿里云 OSS，认 `x-oss-process` 这类参数（那些带
 * `resize,m_fixed,h_599,w_948` 的地址就是它自己生成的）。把参数换成我们要的尺寸与格式，
 * 取回来的就已经压好了：实测同一张图 553KB → 77KB（长边 1080 / q80 / webp）。
 *
 * 参数是**替换**不是追加：一个地址上挂两个 `x-oss-process`，行为不可控。
 */
function optimizeImageUrl(url: string): string {
	const [base] = url.split('?');
	return `${base}?x-oss-process=image/resize,m_lfit,w_1080/quality,q_80/format,webp`;
}

/**
 * 把一条资讯里用到的图取回本地，并把 HTML 与封面上的外链换成本站路径。
 *
 * 缓存里存的仍是**原始外链**（见 `load()`）：本地化只在渲染这一轮做，所以哪天图床不判 Referer、
 * 或者换了策略，删掉 `.cache/wmpvp-images/` 重跑就行，不用把正文缓存一起作废。
 */
async function localizeItemImages(items: WmpvpNews[]): Promise<void> {
	const sources = new Map<string, LocalImageSource>();
	for (const item of items) {
		for (const match of item.content.matchAll(/<img[^>]*\ssrc="([^"]+)"/gi)) {
			const url = decodeEntities(match[1]);
			if (/^https?:\/\//i.test(url)) sources.set(url, { key: url, url });
		}
		if (item.cover) sources.set(item.cover, { key: item.cover, url: item.cover });
	}
	if (sources.size === 0) return;

	const list = [...sources.values()];
	// 先按「让 CDN 压过」的地址取：字节少七倍，构建与被访问都省。
	const map = await localizeImages(
		WMPVP_IMAGE_CHANNEL,
		list.map((source) => ({ ...source, url: optimizeImageUrl(source.url ?? '') })),
	);
	// 压过的地址不一定都认（原图不在 OSS 上、参数被拒），这些退回原地址再来一轮。
	const missing = list.filter((source) => !map.has(source.key));
	if (missing.length > 0) {
		for (const [key, value] of await localizeImages(WMPVP_IMAGE_CHANNEL, missing)) map.set(key, value);
	}

	const rewrite = (_whole: string, prefix: string, url: string, suffix: string): string => {
		const to = map.get(decodeEntities(url));
		return to ? `${prefix}${to}${suffix}` : _whole;
	};
	for (const item of items) {
		const local = map.get(item.cover);
		if (local) item.cover = local;
		item.content = item.content.replace(/(<img[^>]*\ssrc=")([^"]+)(")/gi, rewrite);
	}
}

export interface WmpvpNews {
	/** `newsId`，同时是站内详情页的路由参数。 */
	id: string;
	title: string;
	/** 北京时间 `YYYY-MM-DD`：这条源是中文站，日期按东八区算（不能拿 UTC 直接切）。 */
	date: string;
	/** 发布时刻，ISO 串，页面显示绝对时间用。 */
	published: string;
	author: string;
	summary: string;
	cover: string;
	/** 原文地址。 */
	url: string;
	/** 正文 HTML（已清洗，可直接注入页面）。拿不到就是空串，页面只显示标题。 */
	content: string;
}

export function toWmpvpCard(item: WmpvpNews): NewsCardItem {
	return {
		id: item.id,
		title: item.title,
		summary: item.summary,
		date: item.date,
		img: item.cover || undefined,
		tags: ['国服资讯'],
		meta: item.author ? `来源：完美世界电竞 · ${item.author}` : '来源：完美世界电竞',
		badge: '完美世界',
		href: `/news/wmpvp/${item.id}`,
	};
}

interface RawNews {
	newsId?: number | string;
	title?: string;
	publishTime?: number | string;
	summary?: string;
	thumbnail?: string;
	author?: string;
}

async function getJson(url: string): Promise<any> {
	const res = await fetch(url, {
		headers: { Accept: 'application/json', 'User-Agent': USER_AGENT },
		signal: AbortSignal.timeout(20_000),
	});
	if (!res.ok) throw new Error(`HTTP ${res.status}`);
	return res.json();
}

/** 毫秒时间戳 → 北京时间的 `YYYY-MM-DD`。东八区没有夏令时，直接加 8 小时最省事。 */
function beijingDay(ms: number): string {
	return new Date(ms + 8 * 3600_000).toISOString().slice(0, 10);
}

function fromRaw(raw: RawNews): WmpvpNews | null {
	const id = raw.newsId === undefined || raw.newsId === null ? '' : String(raw.newsId);
	const title = (raw.title ?? '').trim();
	if (!id || !title) return null;
	const ms = Number(raw.publishTime) || 0;
	return {
		id,
		title,
		date: ms ? beijingDay(ms) : '',
		published: ms ? new Date(ms).toISOString() : '',
		author: (raw.author ?? '').trim(),
		summary: (raw.summary ?? '').trim(),
		cover: raw.thumbnail ?? '',
		url: ARTICLE_URL(id),
		content: '',
	};
}

/** 直连列表。返回里夹着 banner 之类的非新闻条目，只留带 `news` 的。 */
async function fetchDirectList(): Promise<WmpvpNews[]> {
	const data = await getJson(LIST_URL);
	const rows: any[] = Array.isArray(data?.result) ? data.result : [];
	return rows
		.map((row) => (row?.news ? fromRaw(row.news as RawNews) : null))
		.filter((item): item is WmpvpNews => item !== null);
}

/**
 * 极简 RSS 解析：只取 `<item>` 里的几个标签。
 *
 * 只为这几个字段引一个 XML 解析库不划算，站里的 Atom 那头也是这么干（见 `redditApi.ts`）。
 * RSSHub 的 `<description>` 里就是正文 HTML，所以兜底这条路不用再打一次详情接口。
 */
export function parseRss(xml: string): WmpvpNews[] {
	const items: WmpvpNews[] = [];
	for (const match of xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)) {
		const block = match[1];
		const pick = (tag: string): string => {
			const found = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i'));
			if (!found) return '';
			return decodeEntities(found[1].replace(/^\s*<!\[CDATA\[/, '').replace(/\]\]>\s*$/, '').trim());
		};
		const link = pick('link');
		const id = (link.match(/[?&]id=(\d+)/) ?? pick('guid').match(/[?&]id=(\d+)/))?.[1] ?? '';
		const title = pick('title');
		if (!id || !title) continue;
		const ms = Date.parse(pick('pubDate'));
		const content = sanitizeArticleHtml(pick('description'));
		items.push({
			id,
			title,
			date: Number.isFinite(ms) ? beijingDay(ms) : '',
			published: Number.isFinite(ms) ? new Date(ms).toISOString() : '',
			author: pick('author') || '完美世界电竞',
			// RSS 里没有摘要字段（`description` 是整篇正文），从正文首段反推，和官网新闻同一条规矩。
			summary: summarizeArticle(content),
			cover: '',
			url: link || ARTICLE_URL(id),
			content,
		});
	}
	return items;
}

function articleCacheFile(id: string): string {
	/*
	 * 文件名里的版本号跟**清洗规则**绑定：这里存的是清洗完的正文，而它的 TTL 是「永久」
	 * （正文发布后基本不改），清洗一变旧结果就再也不会被重写。v2 = 清洗从黑名单换成白名单。
	 */
	return cachePath(CACHE_DIR, `news-v2-${id.replace(/[^a-z0-9]+/gi, '')}.json`);
}

/** 正文：先看永久缓存（正文发布后基本不改），没有再联网。拿不到返回空串，页面只显示标题。 */
async function fetchArticle(id: string, counters: { network: number }): Promise<string> {
	const cached = await readRawJson<{ html?: string }>(articleCacheFile(id));
	if (cached && typeof cached.html === 'string') return cached.html;
	if (OFFLINE) return '';
	try {
		const data = await getJson(DETAIL_URL(id));
		const html = sanitizeArticleHtml(String(data?.result?.news?.content ?? ''));
		counters.network += 1;
		if (html) await writeCacheFile(articleCacheFile(id), JSON.stringify({ html }));
		return html;
	} catch {
		return '';
	}
}

interface CachedList {
	items: WmpvpNews[];
}

function isCachedList(value: unknown): boolean {
	return Array.isArray((value as CachedList)?.items);
}

let listPromise: Promise<WmpvpNews[]> | null = null;

/** 一次构建只算一次；列表自缓存好的正文会一起带进来。 */
export function fetchWmpvpNews(): Promise<WmpvpNews[]> {
	listPromise ??= load();
	return listPromise;
}

async function load(): Promise<WmpvpNews[]> {
	const file = cachePath(CACHE_DIR, 'list.json');
	const cached = await readCacheJson<CachedList>(file, isCachedList);
	const counters = { network: 0 };
	let items: WmpvpNews[] = [];
	let via = '';
	let freshList = false;

	if (cached && isFresh(cached.ageMs, LIST_TTL_SECONDS)) {
		items = cached.value.items;
		via = '缓存';
	} else if (!OFFLINE) {
		try {
			items = await fetchDirectList();
			counters.network += 1;
			freshList = true;
			via = '直连';
		} catch {
			try {
				const res = await fetch(`${RSSHUB_BASE}${RSSHUB_ROUTE}`, {
					headers: { Accept: 'application/xml, text/xml, */*', 'User-Agent': USER_AGENT },
					signal: AbortSignal.timeout(25_000),
				});
				if (!res.ok) throw new Error(`HTTP ${res.status}`);
				items = parseRss(await res.text());
				counters.network += 1;
				freshList = true;
				via = 'RSSHub 兜底';
			} catch {
				items = [];
			}
		}
	}

	// 列表通了就把缺的正文补齐（按 id 永久缓存，所以下一轮只有新帖会联网）。
	if (freshList && items.length > 0) {
		await mapLimit(items, FETCH_CONCURRENCY, async (item) => {
			if (item.content) return;
			item.content = await fetchArticle(item.id, counters);
			if (!item.summary) item.summary = summarizeArticle(item.content);
		});
		await writeCacheFile(file, JSON.stringify({ items } satisfies CachedList));
	}

	// 两条路都没通就退回旧缓存，多旧都用——总比整栏空掉强。
	if (items.length === 0 && cached) {
		items = cached.value.items;
		via = '旧缓存';
	}

	// 配图一律构建期取回本地：直接热链必然 403（见 `WMPVP_IMAGE_CHANNEL`）。
	// 放在这里而不是 `fetchArticle()` 里，是因为列表命中缓存的那一轮也得把图重新标记成
	// 「本轮用到过」，否则它们会被 30 天回收规则当成没人要的图删掉。
	await localizeItemImages(items);

	await reportSource(
		'wmpvp',
		'完美世界电竞',
		items.length === 0 ? 'empty' : counters.network > 0 ? 'fresh' : 'cache',
		items.length === 0
			? '直连与 RSSHub 兜底都没通，也没有可用缓存'
			: `${items.length} 篇（${via}），联网抓取 ${counters.network} 次`,
	);
	return items;
}
