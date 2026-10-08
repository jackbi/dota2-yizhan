import type { NewsCardItem } from '../data/types.ts';
import { decodeEntities } from './articleHtml.ts';

/**
 * 官网新闻列表页的**解析**（不含取数、不碰 `node:*`）。
 *
 * 与 `ngaThread.ts` / `hupuThread.ts` 同样的理由：资讯列表的「加载更多」是运行时按需
 * 往回翻页的，而原先这份解析住在 `newsApi.ts` —— 那个文件挂着构建期的磁盘缓存（`node:fs`）。
 *
 * 列表页的地址形态（实测）：栏目的第 1 页是 `…/index.htm`，第 N 页是 `…/indexN.htm`，
 * 超出范围的页码官方仍然回 200，只是没有条目（`parseNewsFeedPage` 会给出空数组）。
 */

const ORIGIN = 'https://www.dota2.com.cn';

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

export type FeedItem = Pick<OfficialNews, 'id' | 'title' | 'url' | 'date' | 'img'>;

/** 列表页的地址：第 1 页是 `index.htm`，之后是 `indexN.htm`。 */
export function newsFeedPageUrl(basePath: string, page: number): string {
	return `${ORIGIN}${basePath}/${page === 1 ? 'index' : `index${page}`}.htm`;
}

const ITEM_RE = /<a href="(https:\/\/www\.dota2\.com\.cn\/article\/details\/[^"]+)" class="item"[^>]*>([\s\S]*?)<\/a>/g;
const TITLE_RE = /<h2 class="title">([\s\S]*?)<\/h2>/;
const DATE_RE = /<p class="date">([\s\S]*?)<\/p>/;
const IMG_RE = /<img src="([^"]+)"/;

/**
 * 官网列表页一次只渲染当前栏目，其余栏目是空占位节点，
 * 而 `class="item"` 只在真正的条目上出现，所以整页扫描即可。
 */
export function parseNewsFeedPage(html: string): FeedItem[] {
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

/** 新文章在前，同日按 id 倒序。 */
export function byDateDesc(a: OfficialNews, b: OfficialNews): number {
	if (a.date !== b.date) return a.date < b.date ? 1 : -1;
	return b.id.localeCompare(a.id);
}

export function toNewsCard(item: OfficialNews, featured = false): NewsCardItem {
	return {
		id: item.id,
		title: item.title,
		summary: item.summary,
		date: item.date,
		img: item.img || undefined,
		tags: item.feeds.length > 0 ? item.feeds.map((feed) => FEED_LABEL[feed]) : ['综合新闻'],
		meta: '来源：DOTA2 官网',
		href: `/news/${item.id}/`,
		featured,
	};
}

/**
 * 列表页条目 → 卡片。
 *
 * 摘要在构建期是从正文首段反推的（列表页本身不带），运行时的「加载更多」不为了八条摘要
 * 去打八次正文，所以那一批卡片的摘要留空——宁可少一行字，也不让一次点击等五秒。
 */
export function feedItemToNewsCard(item: FeedItem): NewsCardItem {
	return toNewsCard({ ...item, feeds: [], summary: '' });
}
