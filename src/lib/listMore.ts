import { renderNewsCard, renderThreadCard } from './cardHtml.ts';
import { hupuPost, ngaPost } from './communityPost.ts';
import { hupuBoardUrl, selectBoardThreads, toThreads } from './hupuBoard.ts';
import { feedItemToNewsCard, newsFeedPageUrl, parseNewsFeedPage } from './newsFeed.ts';
import { ngaHotUrl, parseHotThreads } from './ngaThread.ts';
import {
	CHAOHUA_HEADERS,
	WEIBO_WINDOW_PAGES,
	chaohuaFeedUrl,
	chaohuaNextCursor,
	parseChaohuaFeed,
	toWeiboCard,
} from './weiboChaohua.ts';
import { listItemToNewsCard, parseWmpvpList, wmpvpListUrl } from './wmpvpList.ts';
import { cached, pace } from './ssrCache.ts';

/**
 * 资讯列表的「加载更多」：**运行时**按需往回翻页，并把条目渲染成与首屏**同一份**卡片标记。
 *
 * ## 为什么需要这一层
 *
 * `/news/` 的每一栏都是构建期抓回来的固定一屏（官网新闻 3 页、完美世界 20 条、NGA 热榜、
 * 虎扑版面 20 条）。读者想接着往下看，原先只有「去上游」一条路。现在按钮按栏跟着走：
 * 每个来源用**它自己的分页**往回翻，取到的条目按 `key` 去重后追加。
 *
 * ## 每条源能翻到哪
 *
 * | 栏 | 分页形态 | 备注 |
 * | --- | --- | --- |
 * | 官网新闻 | `…/news/indexN.htm` | 构建期只取 3 页，运行时从第 4 页起；那批卡片没有摘要（见 `newsFeed.ts`） |
 * | 完美世界 | `pageNum=N` | 运行时卡片不带配图（图床只认它自己的 Referer，见 `wmpvpList.ts`） |
 * | NGA | `__act=hot&days=7&page=N` | 热榜本身有页；按 7 天窗往下翻，重复的由 `key` 去重 |
 * | 虎扑 | `/dota2-N` | 版面页分页，取帖口径与构建期那份共用 `hupuBoard.ts` |
 * | 微博超话 | `since_id` 游标 | **没有 page 参数**（实测 `page=2` 返回的还是第 1 页）；游标由上一页回传，见 `weiboPage` |
 * | Reddit | —— | **没有分页**：官方接口的游标要 OAuth 凭据（`REDDIT_CLIENT_ID/SECRET`），
 *   而现在没配，走的是 RSS，那份只有一屏。所以这一栏不摆按钮 |
 *
 * ## 三条约定（与 `communityFloors.ts` 一致）
 *
 * 1. **只响应点击**：接口带 `X-Robots-Tag: noindex`，页面上也没有 `<a href>` 指向它；
 * 2. **同一页 10 分钟内只打一次上游**，地址只有固定模板；页码上限默认 `MAX_MORE_PAGE`，
 *    微博那一栏是构建期镜像的那个窗口 `WEIBO_WINDOW_PAGES`（游标走一步就打一次上游）；
 * 3. **缓存里放解析结果、不放拼好的 HTML**：卡片上有「最后回复 今天 14:22」这种相对时间。
 *
 * 这个文件**不能碰 `node:*`**：它同时被页面（构建期）与 `/api/news/more`（Workers 运行时）引用。
 */

export type MoreSource = 'news' | 'wmpvp' | 'nga' | 'hupu' | 'weibo';

/** 页面上摆「加载更多」的栏，顺序与标签页一致。 */
export const MORE_SOURCES: readonly MoreSource[] = ['news', 'wmpvp', 'nga', 'hupu', 'weibo'];

/** 最多往回翻多少页：给爬虫/好事者一个上限，正常读者也用不到。 */
export const MAX_MORE_PAGE = 40;
/** 同一页的缓存时长。 */
const MORE_TTL_MS = 10 * 60 * 1000;
const FETCH_TIMEOUT_MS = 20 * 1000;
/** NGA 的 APP 接口认这个 UA。 */
const NGA_USER_AGENT = 'NGA_WP_JW';
const BROWSER_USER_AGENT =
	'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

export interface MoreCard {
	/** 去重键：同一栏里唯一（NGA 用 tid、虎扑用 pid、资讯用文章来源的 id）。 */
	key: string;
	html: string;
}

export interface MorePage {
	source: MoreSource;
	page: number;
	/** 还有下一页吗（上游说没有条目时就是到头了）。 */
	hasMore: boolean;
	nextPage: number | null;
	items: MoreCard[];
}

function pageResult(source: MoreSource, page: number, items: MoreCard[]): MorePage {
	const hasMore = items.length > 0 && page < MAX_MORE_PAGE;
	return { source, page, hasMore, nextPage: hasMore ? page + 1 : null, items };
}

/** 官网新闻：接着构建期抓完的那几页往后翻。那批卡片没有摘要（见 `newsFeed.ts`）。 */
async function newsPage(page: number, nowSec: number): Promise<MorePage> {
	const items = await cached(`more-news:${page}`, MORE_TTL_MS, async () => {
		await pace();
		const response = await fetch(newsFeedPageUrl('/news', page), {
			headers: { 'User-Agent': BROWSER_USER_AGENT },
			signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
		});
		if (!response.ok) return null;
		return parseNewsFeedPage(await response.text());
	});
	if (!items) return pageResult('news', page, []);
	return pageResult(
		'news',
		page,
		items.map((item) => ({ key: item.id, html: renderNewsCard(feedItemToNewsCard(item)) })),
	);
}

/** 完美世界：`pageNum` 直接翻页。卡片不带配图（见 `wmpvpList.ts`）。 */
async function wmpvpPage(page: number): Promise<MorePage> {
	const items = await cached(`more-wmpvp:${page}`, MORE_TTL_MS, async () => {
		await pace();
		const response = await fetch(wmpvpListUrl(page), {
			headers: { Accept: 'application/json', 'User-Agent': BROWSER_USER_AGENT },
			signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
		});
		if (!response.ok) return null;
		return parseWmpvpList(await response.json());
	});
	if (!items) return pageResult('wmpvp', page, []);
	return pageResult(
		'wmpvp',
		page,
		items.map((item) => ({ key: item.id, html: renderNewsCard(listItemToNewsCard(item)) })),
	);
}

/**
 * NGA：热榜按 **7 天窗**往下翻。
 *
 * 首屏那一栏是三个时间窗（24 小时 / 7 天 / 30 天）合并去重的，"再往后"没有唯一的定义；
 * 取 7 天窗是因为它落在中间：24 小时窗太窄（翻不了几页）、30 天窗太杂。翻出来与首屏重复的
 * 由浏览器按 `key` 丢掉。
 *
 * **上游这个接口没有分页**（实测 `&page=2` 返回的还是同一份，201 条一次给全），
 * 所以这里的"页"是**本地切片**：第 1 页对应榜单前 15 名（构建期每窗取的就是 15 条），
 * 第 N 页接着往下取。整份榜单一次出完。
 */
const NGA_RANKING_DAYS = 7;
const NGA_PER_PAGE = 15;

async function ngaRanking() {
	return cached(`more-nga:ranking`, MORE_TTL_MS, async () => {
		await pace();
		const response = await fetch(ngaHotUrl(NGA_RANKING_DAYS), {
			headers: { 'User-Agent': NGA_USER_AGENT },
			signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
		});
		if (!response.ok) return null;
		try {
			return parseHotThreads(await response.json());
		} catch {
			// 正文里的非法转义会让整段 JSON 解析失败——这一栏就当没取到。
			return null;
		}
	});
}

async function ngaPage(page: number, nowSec: number): Promise<MorePage> {
	const ranking = await ngaRanking();
	if (!ranking) return pageResult('nga', page, []);
	const threads = ranking.slice((page - 1) * NGA_PER_PAGE, page * NGA_PER_PAGE);
	return pageResult(
		'nga',
		page,
		threads.map((thread) => ({ key: thread.tid, html: renderThreadCard(ngaPost(thread), nowSec) })),
	);
}

/** 虎扑：版面页分页，取帖口径与构建期共用（见 `hupuBoard.ts`）。 */
async function hupuPage(page: number, nowSec: number): Promise<MorePage> {
	const threads = await cached(`more-hupu:${page}`, MORE_TTL_MS, async () => {
		await pace();
		const response = await fetch(hupuBoardUrl(page), {
			headers: { 'User-Agent': BROWSER_USER_AGENT, Accept: 'text/html,application/xhtml+xml' },
			signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
		});
		if (!response.ok) return null;
		const parsed = toThreads(await response.text(), Math.floor(Date.now() / 1000));
		return parsed ? selectBoardThreads(parsed) : null;
	});
	if (!threads) return pageResult('hupu', page, []);
	return pageResult(
		'hupu',
		page,
		threads.map((thread) => ({ key: thread.pid, html: renderThreadCard(hupuPost(thread), nowSec) })),
	);
}

/**
 * 微博超话：「最新发帖」是**游标**分页，不是 `page=N`。
 *
 * 实测 `flowId=…_-_sort_time&page=2` 返回的还是第 1 页那一份（与 NGA 热榜同款假分页），
 * 唯一的翻页方式是回传上一页响应里的 `since_id`。而本站的接口契约是「给一个页码」，
 * 于是这一栏的"第 N 页"= **从第一页顺着游标走 N 步**。
 *
 * 每一步都进缓存（`more-weibo:<步数>:<游标>`），所以读者按顺序点下去时，每点一次只多打
 * 一次上游——只有直接跳页（或缓存过期后重来）才需要补走前面几步。
 *
 * 上限就是构建期镜像的那个窗口（`WEIBO_WINDOW_PAGES`）：详情页是预渲染的，翻出窗口之外的
 * 卡片就是死链，两边必须同一个数，所以这里直接引 `weiboChaohua.ts` 里的那一份。
 *
 * 卡片**不带配图**：微博图床只认它自己家的 Referer，运行时的 Workers 落不了地；首屏那批
 * 才有构建期取回来的图（见 `weiboApi.ts`）。这一条与完美世界那一栏同款降级。
 */
async function weiboPage(page: number): Promise<MorePage> {
	if (page > WEIBO_WINDOW_PAGES) return pageResult('weibo', page, []);

	const headers = { ...CHAOHUA_HEADERS, 'User-Agent': BROWSER_USER_AGENT };
	/** 走一步：取这一页的帖子与下一页的游标。步数进缓存，读者顺序点击时每步只打一次上游。 */
	const step = (index: number, sinceId: string | null) =>
		cached(`more-weibo:${index}:${sinceId ?? 'head'}`, MORE_TTL_MS, async () => {
			await pace();
			const response = await fetch(chaohuaFeedUrl(sinceId), {
				headers,
				signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
			});
			if (!response.ok) return null;
			const json = await response.json();
			const parsed = parseChaohuaFeed(json);
			if (parsed.length === 0) return null;
			return { posts: parsed, next: chaohuaNextCursor(json) };
		});

	let current = await step(0, null);
	if (!current) return pageResult('weibo', page, []);
	for (let index = 1; index < page; index++) {
		// 游标为空表示上游说到头了，按"到底"处理。
		if (!current.next) return pageResult('weibo', page, []);
		const next = await step(index, current.next);
		if (!next) return pageResult('weibo', page, []);
		current = next;
	}

	const items = current.posts.map((post) => ({ key: post.id, html: renderNewsCard(toWeiboCard(post)) }));
	return pageResult('weibo', page, items);
}

/**
 * 取某一栏的下一页。
 *
 * 上面几条**只缓存解析结果**，卡片在这里按 `nowSec` 现渲染——缓存里存 HTML 的话，
 * 「最后回复 今天 14:22」会被冻住，跨过零点就说错日子。
 */
export async function fetchMoreCards(source: MoreSource, page: number, nowSec: number): Promise<MorePage> {
	if (source === 'news') return newsPage(page, nowSec);
	if (source === 'wmpvp') return wmpvpPage(page, nowSec);
	if (source === 'nga') return ngaPage(page, nowSec);
	if (source === 'weibo') return weiboPage(page);
	return hupuPage(page, nowSec);
}
