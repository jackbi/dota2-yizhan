import path from 'node:path';
import { summarizeArticle, toArticleContent } from './articleHtml';
import { NEWS_FEEDS, byDateDesc, newsFeedPageUrl, parseNewsFeedPage } from './newsFeed';
import type { FeedItem, NewsFeedId, OfficialNews } from './newsFeed';
import { cacheFile as cachePath, readCacheText, writeCacheFile } from './buildCache';
import { mapLimit } from './concurrency';
import { reportSource, sourceState } from './dataHealth';

/**
 * 栏目表、列表解析与卡片映射搬到了 `newsFeed.ts`（纯模块）：列表的「加载更多」是运行时
 * 按需往回翻页的，那边不能引 `node:fs`。这里把它们再导出一次，页面与自检的引用不用改。
 */
export { FEED_LABEL, NEWS_FEEDS, toNewsCard } from './newsFeed';
export type { NewsFeedId, OfficialNews } from './newsFeed';

/** 列表页的筛选栏目：综合新闻汇总全部官方栏目。 */
export const NEWS_FILTERS = NEWS_FEEDS.map((feed) => ({ id: feed.id, label: feed.label }));

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

// ---------------------------------------------------------------- 抓取与缓存

function cacheFile(url: string): string {
	return cachePath(CACHE_DIR, `${url.replace(`${ORIGIN}/`, '').replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '')}.html`);
}

/**
 * 正文本轮联网抓了几篇。
 *
 * **只进构建汇总的说明文字，不参与状态判定**：这一源的状态看的是它的主数据（列表）本轮是不是
 * 从上游取到的（见 `sourceState`）。按整个模块的抓取次数判，列表吃缓存、正文补抓的那一轮，
 * 摘要就会把这一源写成"联网抓取"。
 */
let articleFetched = 0;

/**
 * 正文缓存是不是一份完整的页面。
 *
 * 判据只有两条：**长度够**、**结尾是 `</html>`**（实测抓下来的正文 14~41 KB，都以此收尾）。
 * 这是给「写入被打断留下的半截文件」兜底的：正文的 TTL 是「永久」（见 `ARTICLE_TTL_SECONDS`），
 * 半截内容一旦被当成新鲜命中就再也不会重抓，所以宁可当没命中重抓一次。
 *
 * 它**不是**正文正确性的判据——上游换成一张错误页时，两条都过得去。那种情况靠构建汇总里的
 * 抓取次数（列表与正文分开记）看出来。
 */
function isCompleteHtml(text: string): boolean {
	return text.length > 2000 && text.trimEnd().endsWith('</html>');
}

/** 一次取数的结果：内容，以及**这一份**是本轮联网抓的还是吃缓存的。 */
interface FetchedPage {
	text: string | null;
	network: boolean;
}

/** 抓取官方页面并落盘；命中新鲜缓存就直接返回，失败时退回过期缓存。 */
async function fetchHtml(url: string, ttlSeconds: number): Promise<FetchedPage> {
	const file = cacheFile(url);
	const cached = await readCacheText(file, isCompleteHtml);
	if (cached && cached.ageMs < ttlSeconds * 1000) return { text: cached.text, network: false };

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
	if (fresh === null) return { text: cached?.text ?? null, network: false };

	await writeCacheFile(file, fresh);
	return { text: fresh, network: true };
}


const articleCache = new Map<string, Promise<string>>();

/** 单篇文章正文（已清洗）。同一篇文章在一次构建里只会抓一次。 */
export function fetchNewsArticle(url: string): Promise<string> {
	let pending = articleCache.get(url);
	if (!pending) {
		pending = (async () => {
			const page = await fetchHtml(url, ARTICLE_TTL_SECONDS);
			if (page.network) articleFetched += 1;
			return page.text ? toArticleContent(page.text) : '';
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
	/** 列表页本轮联网抓到几页。**整源的状态只看它**，正文是次要数据。 */
	let listFetched = 0;

	const byId = new Map<string, OfficialNews>();
	for (const feed of NEWS_FEEDS) {
		for (let page = 1; page <= LIST_PAGES; page++) {
			const fetched = await fetchHtml(newsFeedPageUrl(feed.path, page), LIST_TTL_SECONDS);
			if (fetched.network) listFetched += 1;
			if (!fetched.text) continue;
			const items = parseNewsFeedPage(fetched.text);
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

	await reportSource(
		'news',
		'DOTA2 官网新闻',
		sourceState(listFetched > 0, list.length),
		`${list.length} 篇文章，列表联网抓取 ${listFetched} 页，正文联网抓取 ${articleFetched} 篇`,
	);
	return list;
}
