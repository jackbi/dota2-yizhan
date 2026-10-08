import type { NewsCardItem } from '../data/types.ts';

/**
 * 完美世界电竞资讯**列表**的解析（不含取数、不碰 `node:*`）。
 *
 * 与 `newsFeed.ts` 同样的理由：资讯列表的「加载更多」是运行时按需往回翻页的，
 * 而原先这份解析住在 `wmpvpApi.ts`——那个文件挂着构建期的磁盘缓存与图片本地化（`node:fs`）。
 *
 * 列表接口的分页就是 `pageNum`（实测第 2 页与第 1 页不重叠；`pageSize` 固定 20）。
 */

const LIST_BASE = 'https://appengine.wmpvp.com/steamcn/community/homepage/getHomeInformation';
/** 原文地址，列表卡片与详情页都用它署名。 */
const ARTICLE_URL = (id: string) => `https://news.wmpvp.com/news.html?id=${id}&gameTypeStr=1`;

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

interface RawNews {
	newsId?: number | string;
	title?: string;
	publishTime?: number | string;
	summary?: string;
	thumbnail?: string;
	author?: string;
}

/** 某一页的列表地址。页码 1 起。 */
export function wmpvpListUrl(page: number, pageSize = 20): string {
	return `${LIST_BASE}?gameTypeStr=1&pageNum=${page}&pageSize=${pageSize}`;
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

/** 直连列表的响应 → 条目。返回里夹着 banner 之类的非新闻条目，只留带 `news` 的。 */
export function parseWmpvpList(data: unknown): WmpvpNews[] {
	const rows: any[] = Array.isArray((data as { result?: unknown })?.result)
		? ((data as { result: any[] }).result as any[])
		: [];
	return rows
		.map((row) => (row?.news ? fromRaw(row.news as RawNews) : null))
		.filter((item): item is WmpvpNews => item !== null);
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
		href: `/news/wmpvp/${item.id}/`,
	};
}

/**
 * 列表条目 → 卡片。**运行时的这一份不带配图**：封面原图挂在 `cdn.wmpvp.com`，
 * 那台图床只认 `Referer: news.wmpvp.com`（不带也是 403），而配图是构建期抓回站内的
 * （见 `wmpvpApi.ts` 的图片频道）。运行时没法把图搬回来，热链必然是张裂图——
 * 那就干脆不摆图，比留一个破图框体面。
 */
export function listItemToNewsCard(item: WmpvpNews): NewsCardItem {
	return toWmpvpCard({ ...item, cover: '' });
}
