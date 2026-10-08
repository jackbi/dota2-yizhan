import type { NewsCardItem } from '../data/types.ts';
import { decodeEntities } from './articleHtml.ts';
import { formatCount } from './format.ts';

/**
 * 微博 DOTA2 超话「最新版块」的**解析**（不含取数、不碰 `node:*`）。
 *
 * 与 `newsFeed.ts` / `ngaThread.ts` / `hupuThread.ts` 同样的理由：资讯列表的「加载更多」是
 * 运行时按需往回翻页的，那边不能引构建期的磁盘缓存。取数在 `weiboApi.ts`，这里只描述
 * 地址形态与字段口径，两边共用同一份。
 *
 * ## 入口是怎么找到的
 *
 * 超话页面（`weibo.com/p/<超话id>`）自己不走 `m.weibo.cn` 那套 container 接口，而是
 * `weibo.com/ajax_proxy/chaohua/page?flowId=…`：实测免登录免 cookie 直接返回 JSON
 * （`m.weibo.cn/api/container/getIndex` 同一时刻是 432，那条路走不通）。
 *
 * 页面上那排「热门 / 最新 / 精华 / 水帖专区 / 攻略 / 游戏日常 / 萌新求助」是**版块**，
 * 版块下面的「最新」又是两个子页签：
 *
 * | 子页签 | flowId 后缀 | 口径 |
 * | --- | --- | --- |
 * | 最新评论 | `_-_feed` | 按最后回复时间，`page=N` 直接翻页 |
 * | 最新发帖 | `_-_sort_time` | 按发帖时间，**没有 page 参数**，只认 `since_id` 游标 |
 *
 * 站里取的是**最新发帖**——按时间序，和虎扑那一栏同一种口径；「最新评论」会把几天前的老帖
 * 因为一条新回复顶上来，列表看着会跳。
 */

/** DOTA2 超话的 id（页面地址 `weibo.com/p/<id>` 里那一段）。 */
export const WEIBO_TOPIC_ID = '1008080a7614bd4a7b1331677f9bc690323e64';

/** 超话主页，用于署名跳转与请求头里的 Referer。 */
export const WEIBO_TOPIC_URL = `https://weibo.com/p/${WEIBO_TOPIC_ID}`;

/** 「最新 · 最新发帖」这个版块的 flowId。 */
const FEED_FLOW = `${WEIBO_TOPIC_ID}_-_sort_time`;

const API = 'https://weibo.com/ajax_proxy/chaohua/page';

/**
 * 这个接口要的头。
 *
 * `x-requested-with` 与 `client-version` 是它自己页面发的值；**没有 cookie 也能过**（实测
 * 连续 6 次都是 200），所以不引访客 cookie 那套——那套只是页面的门禁，接口不吃。
 */
export const CHAOHUA_HEADERS: Record<string, string> = {
	Accept: 'application/json, text/plain, */*',
	Referer: WEIBO_TOPIC_URL,
	'x-requested-with': 'XMLHttpRequest',
	'client-version': 'v1.1.250',
};

/** 一页的地址。`sinceId` 是上一页响应里带回来的游标（见 `chaohuaNextCursor`）。 */
export function chaohuaFeedUrl(sinceId?: string | null): string {
	const base = `${API}?flowId=${FEED_FLOW}`;
	return sinceId ? `${base}&since_id=${encodeURIComponent(sinceId)}` : base;
}

/**
 * 下一页的游标。
 *
 * 形状是 `moreInfo.params.since_id`，值本身是一段 JSON 字符串（`{"max_id":5351770596577510}`），
 * 原样回传即可。**别改写成 `page=N`**：实测 `_-_sort_time&page=2` 返回的还是第 1 页那一份，
 * 它的 page 参数是假的（与 NGA 热榜那个坑同款）。
 */
export function chaohuaNextCursor(json: unknown): string | null {
	const params = (json as { moreInfo?: { params?: { since_id?: unknown } } } | null)?.moreInfo?.params;
	const value = params?.since_id;
	return typeof value === 'string' && value.length > 0 ? value : null;
}

/** 一条超话帖在站内这一层的样子。 */
export interface WeiboPost {
	/** 微博的十进制 mid，同时是站内的去重键。 */
	id: string;
	author: string;
	/** 清洗过的正文（表情留成 `[泪]` 这种文本，话题标签只留文字）。 */
	text: string;
	/** 发帖时间，Unix 秒（微博给的是 UTC+8，见 `parseCreatedAt`）。 */
	createdAt: number;
	reposts: number;
	comments: number;
	likes: number;
	/** 卡片上的配图（`bmiddle`，约 360px 宽）；没有配图就是空串。 */
	image: string;
	/** 原帖地址，页面上点卡片就是去这里。 */
	url: string;
	/**
	 * 构建期取回站内的配图路径（`/weibo-pics/…`）。
	 *
	 * 只有构建期那一屏有：微博图床只认它自己家的 Referer（站外引用一律 403），
	 * 运行时翻出来的那批没法在 Workers 上落地，于是不带图——与完美世界那一栏同款降级。
	 */
	localImage?: string;
}

/** `Thu Oct 08 15:36:44 +0800 2026` 这种格式 `new Date()` 解析不了（年份在最后），自己拆。 */
const CREATED_RE = /^\w{3} (\w{3}) (\d{2}) (\d{2}):(\d{2}):(\d{2}) \+0800 (\d{4})$/;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** 微博的时间戳**显式带 UTC+8**：构建机时区不定，按本地时区解会让同一份数据漂到别的日子。 */
export function parseCreatedAt(raw: string): number {
	const matched = CREATED_RE.exec(raw.trim());
	if (!matched) return 0;
	const month = MONTHS.indexOf(matched[1]);
	if (month < 0) return 0;
	const seconds = Date.UTC(
		Number(matched[6]),
		month,
		Number(matched[2]),
		Number(matched[3]) - 8,
		Number(matched[4]),
		Number(matched[5]),
	);
	return Math.floor(seconds / 1000);
}

/**
 * 正文清洗。
 *
 * 微博给的是 HTML：表情是 `<img alt="[泪]">`、话题与 @ 是 `<a>`。表情**留 alt 的文字形态**
 * ——丢掉的话「吸欧气[哆啦A梦吃惊]」会变成「吸欧气」，同一句话的语气就没了。
 */
export function cleanWeiboText(raw: string): string {
	const text = String(raw ?? '')
		.replace(/<img\b[^>]*\balt="([^"]*)"[^>]*>/g, '$1')
		.replace(/<img\b[^>]*>/g, '')
		.replace(/<br\s*\/?>/gi, '\n')
		.replace(/<[^>]+>/g, '');
	return decodeEntities(text)
		.replace(/\u200b/g, '')
		.replace(/[ \t]+/g, ' ')
		.replace(/\s*\n\s*/g, '\n')
		.trim();
}

function asCount(value: unknown): number {
	const num = Number(value);
	return Number.isFinite(num) && num > 0 ? num : 0;
}

/** 卡片用的小图：优先 `bmiddle`（约 360px），退到缩略图再退到大图。 */
function firstPicture(data: Record<string, unknown>): string {
	const ids = Array.isArray(data.pic_ids) ? data.pic_ids : [];
	const first = String(ids[0] ?? '');
	const infos = data.pic_infos as Record<string, Record<string, { url?: unknown }>> | undefined;
	const sizes = first ? infos?.[first] : undefined;
	for (const key of ['bmiddle', 'wap360', 'thumbnail', 'large', 'largest']) {
		const url = sizes?.[key]?.url;
		if (typeof url === 'string' && url) return url;
	}
	return '';
}

/**
 * 响应 → 帖子清单。
 *
 * 只认 `category === 'feed'` 的条目：同一份 `items` 里还混着提示卡片、子页签卡、
 * 写帖入口这些 `cell` / `card`。字段不齐（没有 mid 或没有 mblogid）的直接丢——
 * 拼不出原帖地址的卡片在页面上就是个死链。
 */
export function parseChaohuaFeed(json: unknown): WeiboPost[] {
	const items = (json as { items?: unknown } | null)?.items;
	if (!Array.isArray(items)) return [];

	const posts: WeiboPost[] = [];
	for (const item of items) {
		const row = item as { category?: unknown; data?: Record<string, unknown> } | null;
		if (!row || row.category !== 'feed' || !row.data) continue;
		const data = row.data;
		const id = String(data.idstr ?? data.id ?? '');
		const mblogid = String(data.mblogid ?? '');
		const user = (data.user ?? {}) as Record<string, unknown>;
		const authorId = String(user.idstr ?? user.id ?? '');
		if (!id || !mblogid || !authorId) continue;

		let text = cleanWeiboText(String(data.text ?? ''));
		if (!text) {
			// 纯转发：自己没有正文，拿原微博顶上，免得卡片上是一块空白。
			const origin = (data.retweeted_status ?? null) as Record<string, unknown> | null;
			const originText = origin ? cleanWeiboText(String(origin.text ?? '')) : '';
			text = originText ? `转发：${originText}` : '（转发微博）';
		}

		posts.push({
			id,
			author: String(user.screen_name ?? ''),
			text,
			createdAt: parseCreatedAt(String(data.created_at ?? '')),
			reposts: asCount(data.reposts_count),
			comments: asCount(data.comments_count),
			likes: asCount(data.attitudes_count),
			image: firstPicture(data),
			url: `https://weibo.com/${authorId}/${mblogid}`,
		});
	}

	// 推荐位与时间序会重叠，同一 mid 只留第一条。
	const seen = new Set<string>();
	return posts.filter((post) => {
		if (seen.has(post.id)) return false;
		seen.add(post.id);
		return true;
	});
}

/** 卡片标题的长度上限（超出一行的按它切开，剩下的进摘要）。 */
const CARD_TITLE_MAX = 42;

/** 正文 → 卡片的标题与摘要：第一段当标题，其余进摘要。 */
export function splitWeiboText(text: string): { title: string; summary: string } {
	const compact = text.replace(/\n+/g, ' ').replace(/\s+/g, ' ').trim();
	if (compact.length <= CARD_TITLE_MAX) return { title: compact, summary: '' };
	return { title: `${compact.slice(0, CARD_TITLE_MAX)}…`, summary: compact.slice(CARD_TITLE_MAX).trim() };
}

/** Unix 秒 → `YYYY-MM-DD`（按微博自己的 UTC+8 算）。 */
export function beijingDate(seconds: number): string {
	return new Date(seconds * 1000 + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

/**
 * 帖子 → 资讯卡。
 *
 * 卡片**直接指向原帖**，站内不做镜像：超话帖子的正文本来就短（实测多为 1–3 行），
 * 卡片的标题加摘要已经覆盖；而做镜像就要多出一批页面，其中「加载更多」翻出来的那些是
 * 运行时才知道的、没有静态页——那正是 SEO 报告里「未找到 (404)」的来源之一，不给自己挖。
 */
export function toWeiboCard(post: WeiboPost): NewsCardItem {
	const { title, summary } = splitWeiboText(post.text);
	return {
		id: post.id,
		title: title || '（转发微博）',
		summary,
		date: beijingDate(post.createdAt),
		img: post.localImage,
		tags: ['DOTA2 超话'],
		badge: '微博',
		meta:
			`@${post.author} · 转发 ${formatCount(post.reposts)}` +
			` 评论 ${formatCount(post.comments)} 赞 ${formatCount(post.likes)}`,
		href: post.url,
	};
}
