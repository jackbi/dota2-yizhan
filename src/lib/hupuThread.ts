import { sanitizeArticleHtml, summarizeArticle } from './articleHtml.ts';

/**
 * 虎扑帖子的**解析**（不含取数、不碰 `node:*`）。
 *
 * 与 `ngaThread.ts` 同样的理由：详情页的「加载更多回复」是运行时按需取下一页的，
 * 而 `hupuApi.ts` 里挂着构建期的磁盘缓存（`node:fs`）。解析这段两边共用。
 *
 * 分页契约（实测）：详情页是 Next.js，`__NEXT_DATA__` 里的 `detail.replies` 自带分页元信息
 * ——`{ count: 216, size: 20, current: 2, total: 11, baseUrl: '/642044480_0.html' }`。
 * **页码从 0 起**，而且真实地址是 `/<pid>-<页码>.html`（第 1 页就是 `/<pid>.html`，
 * 分页链接在渲染出来的 DOM 里也是 `642044480-2.html` 这种相对形式）。
 * 试过 `?page=2` 与 `baseUrl` 那种 `_1.html`：前者内容不变、后者回一页空壳，都不是真入口。
 */

const ORIGIN = 'https://bbs.hupu.com';

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

/** 帖子的**一页**：主楼、亮评与 `replies.list` 里那一页回复。 */
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
	/** 亮评，按键（亮数）降序；不分页，每次都在 */
	hotReplies: HupuReply[];
	/** 这一页的回复，按时间正序 */
	floors: HupuReply[];
	/** 这一页的页码，1 起（接口给的 `current` 已经是 1 起） */
	page: number;
	/** 每页回复数 */
	perPage: number;
	/** 总页数 */
	totalPages: number;
	location: string;
	topic: string;
}

/** 第 N 页的地址。1 起：第 1 页就是帖子地址本身，之后是 `/<pid>-<n>.html`。 */
export function hupuThreadPageUrl(pid: string, page: number): string {
	return page <= 1 ? `${ORIGIN}/${pid}.html` : `${ORIGIN}/${pid}-${page}.html`;
}

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
 * 正文是用户内容，清洗一律走 `articleHtml.ts` 的白名单（那边有整套用例），
 * 这里只提供两件虎扑特有的事：相对地址按 **bbs.hupu.com** 补（不能沿用官方新闻那套
 * dota2.com.cn 的域名），以及把 `data-imgid` 这类虎扑自己的私有属性交给白名单自动丢掉。
 */
export function sanitizeHupuHtml(html: string): string {
	return sanitizeArticleHtml(html, { baseOrigin: ORIGIN });
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

/** 帖子页 HTML → 这一页的内容。结构变了就退回只救主楼的降级解析。 */
export function parseHupuThread(html: string): HupuThreadDetail | null {
	const rawJson = NEXT_DATA_RE.exec(html)?.[1];
	if (!rawJson) return parseDetailFallback(html);
	let root: Json | null = null;
	try {
		root = asObject(JSON.parse(rawJson));
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
	const paging = asObject(detail?.replies);
	const floors = asArray(paging?.list)
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
		// 接口的 `current` 是 1 起的页码，`total` 是总页数（实测 216 条 / 每页 20 / 共 11 页）。
		page: asCount(paging?.current, 1) || 1,
		perPage: asCount(paging?.size, 20) || 20,
		totalPages: asCount(paging?.total, 0),
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
		page: 1,
		perPage: 20,
		totalPages: 0,
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
