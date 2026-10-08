// 带扩展名：自检要直接用 Node 跑这个模块，Node 的 ESM 解析不补扩展名。
import { decodeEntities } from './articleHtml.ts';
import { collectNicknames } from './ngaBbcode.ts';

/**
 * NGA 帖子的**解析**（不含取数、不碰 `node:*`）。
 *
 * 为什么要从 `ngaApi.ts` 里分出来：详情页的「加载更多回复」是**运行时**按需取下一页的，
 * 而 `ngaApi.ts` 里挂着构建期的磁盘缓存（`node:fs`），上 Cloudflare Workers 就废了。
 * 解析这段逻辑两边共用——构建期抓第一页、运行时抓第 N 页，看到的是同一份字段口径。
 *
 * 分页契约（实测）：`read.php?tid=<tid>&__output=11&page=<n>`，1 起、每页 20 层，
 * `__ROWS` 是全帖楼层总数（含主楼 0 层）、`__PAGE` 是页码、`__R__ROWS_PAGE` 是每页层数。
 */

const API = 'https://bbs.nga.cn';
/** DOTA2 版块，取自 app_api.php?__lib=home&__act=category。 */
const DOTA2_FID = 321;

/** 热帖榜的一个时间窗。 */
export interface HotWindow {
	days: number;
	label: string;
}

/** 热帖榜里的一条（还没有合并时间窗）。 */
export interface HotThread {
	tid: string;
	title: string;
	author: string;
	/** 窗口内的回复数；NGA 的热榜就是按它倒序。 */
	replies: number;
	/** 发帖时间，Unix 秒 */
	postedAt: number;
	/** 最后回复时间，Unix 秒 */
	lastReplyAt: number;
	lastPoster: string;
	/** 主楼首段摘要；主楼只有图片时为空 */
	summary: string;
}

/**
 * 热帖榜的地址。
 *
 * **这个接口没有分页**：实测带上 `&page=2`、`&page=3` 返回的都是同一份（201 条），
 * 也就是说整份榜单一次给全。站内要"接着往下看"时是在本地切片（见 `listMore.ts`），
 * 不是翻上游的页——别照 `read.php` 的形态想当然写成 `&page=N`。
 */
export function ngaHotUrl(days: number, fid = DOTA2_FID): string {
	return `${API}/app_api.php?__lib=subject&__act=hot&fid=${fid}&days=${days}&__output=11`;
}

/** 一层楼。站内详情页只展示正文，昵称见 `ThreadDetail.nicknames`。 */
export interface ThreadFloor {
	pid: string;
	/** 楼层号，主楼为 0。 */
	floor: number;
	/** 发帖时间，Unix 秒。 */
	time: number;
	/** 赞数 */
	score: number;
	/** 原始 BBCode 正文 */
	content: string;
	/** 楼层作者 id，用于反查昵称。 */
	authorId: string;
}

/** 帖子的**一页**：主楼在其中的是第 1 页，其余页只有楼层。 */
export interface ThreadDetail {
	/** 主楼首段摘要，列表页用 */
	summary: string;
	/** 主楼 BBCode 正文；不是第 1 页时为空 */
	content: string;
	/** 本页楼层。第 1 页含主楼 */
	floors: ThreadFloor[];
	/** 楼主筛出的热评，按赞数倒序。只有第 1 页有 */
	hotReplies: ThreadFloor[];
	/** 全帖楼层总数（含主楼） */
	totalFloors: number;
	/** 这一页的页码，1 起 */
	page: number;
	/** 每页层数，用来算「还有多少」 */
	perPage: number;
	/**
	 * 楼层作者 id → 昵称。
	 * 接口对未登录访问会把昵称打码成 `UID:123`，只有引用文本里带着真实昵称，
	 * 所以这里只能从正文里反推，拿不到的就留空。
	 */
	nicknames: Record<string, string>;
}

/** 某一页的接口地址。第 1 页与带 `page=1` 等价，`ngaThreadPageUrl` 另有别名。 */
export function ngaReadUrl(tid: string, page: number): string {
	const suffix = page > 1 ? `&page=${page}` : '';
	return `${API}/read.php?tid=${tid}&__output=11${suffix}`;
}

/** 锁定的帖子与合集入口不该出现在热帖榜里。 */
const TYPE_LOCKED = 1 << 10;
const TYPE_COLLECTION = 1 << 15;

/**
 * 热帖榜的响应 → 条目。`data[0]` 是帖子数组，`data[1]` 是附加信息。
 *
 * 少于 `minReplies` 条回复的不算热帖——页面上那一栏是「热帖」，把刚发的帖混进去
 * 只会让它看起来像最新回复列表。
 */
export function parseHotThreads(raw: unknown, minReplies = 5): HotThread[] | null {
	const groups = (raw as { data?: unknown })?.data;
	if (!Array.isArray(groups) || !Array.isArray(groups[0])) return null;
	const threads = (groups[0] as Record<string, unknown>[])
		.filter((row) => {
			const type = Number(row.type) || 0;
			return !(type & (TYPE_LOCKED | TYPE_COLLECTION));
		})
		.map((row) => ({
			tid: String(row.tid ?? ''),
			title: String(row.subject ?? '').trim(),
			author: String(row.author ?? ''),
			replies: Number(row.replies) || 0,
			postedAt: Number(row.postdate) || 0,
			lastReplyAt: Number(row.lastpost) || 0,
			lastPoster: String(row.lastposter ?? ''),
			summary: '',
		}))
		.filter((thread) => thread.tid && thread.title && thread.replies >= minReplies);
	return threads.length > 0 ? threads : null;
}

/** `__R` 有时是数组、有时是以 tid 为键的对象，两种都要能取到楼层列表。 */
function firstFloorList(data: unknown): Record<string, unknown>[] | null {
	const replies = (data as { __R?: unknown })?.__R;
	if (Array.isArray(replies)) return replies as Record<string, unknown>[];
	if (replies && typeof replies === 'object') {
		for (const value of Object.values(replies)) {
			if (Array.isArray(value)) return value as Record<string, unknown>[];
		}
	}
	return null;
}

/**
 * 主楼正文是 HTML + BBCode 混排，摘要只取第一段可读文字。
 *
 * 注意别剥掉 [quote]：主楼常是"引用公告"的形态（如更新说明），整段剥掉就什么都不剩，
 * 所以引用只去标签、保留正文。附件在正文里以 `mon_202609/10/xxx.jpg` 这样的裸路径出现，
 * 外链则是 `[标题] https://...` 的形式，两者都会让摘要变成无意义字符，先去掉。
 *
 * 12 字的门槛用来跳过噪声行，但整帖都短于 12 字时不能直接返回空——
 * 实测有主楼就是"终于开了"的直播帖，那句话本身就是摘要。
 */
export function summarizePost(content: string): string {
	const text = decodeEntities(
		content
			.replace(/<img\b[^>]*>/gi, ' ')
			.replace(/\[img\][\s\S]*?\[\/img\]/gi, ' ')
			.replace(/\[collapse[^\]]*\][\s\S]*?\[\/collapse\]/gi, ' ')
			.replace(/\[s:[^\]]*\]/gi, ' ')
			.replace(/\[\/?[a-z*][^\]]*\]/gi, ' ')
			.replace(/\.?\/?mon_\d{6}\/[\w./-]+/gi, ' ')
			.replace(/<br\s*\/?>/gi, '\n')
			.replace(/<[^>]+>/g, ' '),
	);
	/** 够长的那一行最像摘要；整帖都很短时的候选，见循环后面的说明。 */
	let fallbackLine = '';
	for (const line of text.split('\n')) {
		const clean = line
			.replace(/https?:\/\/\S+/gi, ' ')
			.replace(/[[\]]/g, ' ')
			.replace(/\s+/g, ' ')
			.trim();
		if (clean.length >= 12) return clean.length > 96 ? `${clean.slice(0, 96)}…` : clean;
		if (clean.length > fallbackLine.length) fallbackLine = clean;
	}
	// 没有一句够 12 字时退回最长的那行。主楼本来就只有"终于开了"这种短句时，
	// 它已经是全部内容，丢掉不如留着；纯图片帖抽不出任何文字，仍然是空。
	return fallbackLine.length >= 4 ? fallbackLine : '';
}

/** 一层楼 → 站内展示结构；没有正文的楼层（纯图片被吞掉的情况）直接丢弃。 */
function toFloor(row: Record<string, unknown>): ThreadFloor | null {
	const content = typeof row.content === 'string' ? row.content : '';
	if (!content) return null;
	return {
		pid: String(row.pid ?? ''),
		floor: Number(row.lou) || 0,
		time: Number(row.postdatetimestamp) || 0,
		score: Number(row.score) || 0,
		content,
		authorId: String(row.authorid ?? ''),
	};
}

function toFloors(rows: unknown): ThreadFloor[] {
	if (!Array.isArray(rows)) return [];
	return rows.map((row) => toFloor(row as Record<string, unknown>)).filter((floor): floor is ThreadFloor => floor !== null);
}

/** read.php 的响应 → 这一页的帖子内容。 */
export function parseThreadJson(raw: unknown, wantedPage = 1): ThreadDetail | null {
	const data = (raw as { data?: Record<string, unknown> })?.data;
	if (!data) return null;
	const rows = firstFloorList(data) ?? [];
	const floors = toFloors(rows);
	// 第 2 页起没有主楼：那是正常的，只有整页一层都解析不出来才算失败。
	if (floors.length === 0) return null;
	const main = floors.find((floor) => floor.floor === 0) ?? null;
	const page = Number(data.__PAGE) || wantedPage;

	// 热评挂在主楼的 hotreply 字段上，按赞数取前几条。
	const mainRow = rows.find((row) => Number(row.lou) === 0) ?? rows[0];
	const hotReplies = toFloors(mainRow?.hotreply)
		.sort((a, b) => b.score - a.score)
		.slice(0, 5);

	// 昵称只能从引用文本里反推，主楼、楼层、热评的正文一起参与匹配。
	const nicknames = Object.fromEntries(
		collectNicknames([
			...floors.map((floor) => floor.content),
			...hotReplies.map((floor) => floor.content),
		]),
	);

	return {
		summary: main ? summarizePost(main.content) : '',
		content: main?.content ?? '',
		floors,
		hotReplies,
		totalFloors: Number(data.__ROWS) || floors.length,
		page,
		perPage: Number(data.__R__ROWS_PAGE) || floors.length || 20,
		nicknames,
	};
}

/**
 * read.php 的 JSON 会因为正文里的 `\u`、`\t` 之类字符整段解析失败（官方文档也承认），
 * 这时退回去掉 `__output` 的 HTML 版本：GBK 编码，主楼在 `<p id='postcontent0'>`。
 * 只能救回主楼，楼层与热评就欠奉了——那种情况下页面不摆「加载更多」。
 */
export function parseThreadHtmlPage(html: string): ThreadDetail | null {
	const match = html.match(/<p[^>]*\bid=['"]postcontent0['"][^>]*>([\s\S]*?)<\/p>/i);
	if (!match) return null;
	const content = match[1];
	return {
		summary: summarizePost(content),
		content,
		floors: [{ pid: '', floor: 0, time: 0, score: 0, content, authorId: '' }],
		hotReplies: [],
		totalFloors: 1,
		page: 1,
		perPage: 20,
		nicknames: {},
	};
}
