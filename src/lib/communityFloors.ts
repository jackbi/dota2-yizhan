import { escapeHtml, renderNgaPost } from './ngaBbcode.ts';
import { formatMatchTime } from './format.ts';
import { ngaReadUrl, parseThreadJson } from './ngaThread.ts';
import { hupuThreadPageUrl, parseHupuThread } from './hupuThread.ts';
import type { ThreadDetail, ThreadFloor } from './ngaThread.ts';
import type { HupuReply, HupuThreadDetail } from './hupuThread.ts';
import { cached, pace } from './ssrCache.ts';

/**
 * 社区帖的「加载更多回复」：**运行时**按需取下一页，并把一层回复渲染成同一份 HTML。
 *
 * ## 为什么需要这一层
 *
 * 详情页是预渲染的（构建期一次抓完），而 NGA 与虎扑的正文都按页给：NGA 每页 20 层、
 * 虎扑每页 20 条。原先页面只摆热评 + 前 10 层，剩下的靠一句「去原帖看」——读者能看到的东西
 * 太少，而这正是这个站存在的理由。所以：**首屏照旧预渲染（爬虫与无 JS 的访客看到的就是它），
 * 想看更多的人在页面上点一下，由这个模块去上游取下一页**。
 *
 * ## 三条约定
 *
 * 1. **只有点击才会打上游。** 爬虫拿到的是构建期的静态页，`/api/community/floors` 只被
 *    XHR 调用、且带 `X-Robots-Tag: noindex`——否则「把上游当免费代理刷」的就是搜索引擎。
 * 2. **同一页 10 分钟内只打一次上游**（`ssrCache` 的内存缓存，按实例）。上游挂了就回一个
 *    可读的原因，页面上仍是「去原帖」那条出口。
 * 3. **渲染只有一处。** 首屏那几条楼层与点出来的下一页走的是下面同一个渲染函数，
 *    否则两边的样式与字段迟早会分家。
 *
 * 这个文件**不能碰 `node:*`**：它同时被 `.astro`（构建期）与 `/api/community/floors`（Workers 运行时）引用。
 */

export type CommunitySource = 'nga' | 'hupu';

/** 每页再往外翻多少页就不再给了：给爬虫/好事者一个上限，正常读者也用不到。 */
export const MAX_FLOOR_PAGE = 40;
/** 同一页的缓存时长：热帖的楼层增长不慢，10 分钟足够新鲜，也压得住重复点击。 */
const FLOOR_TTL_MS = 10 * 60 * 1000;
const FETCH_TIMEOUT_MS = 20 * 1000;

/** NGA 的 APP 接口认这个 UA；虎扑要一个像浏览器的。与构建期那两处保持一致。 */
const NGA_USER_AGENT = 'NGA_WP_JW';
const HUPU_USER_AGENT =
	'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/** 一页里的条目：`pid` 用来在浏览器里去重（亮评与楼层会重叠），`html` 直接塞进列表。 */
export interface FloorItem {
	pid: string;
	html: string;
}

/** 「翻到哪儿了」——首屏与接口共用这一份算术。 */
export interface FloorProgress {
	/** 已经渲染到第几页（1 起） */
	page: number;
	perPage: number;
	/** 总量：NGA 是总楼层数（含主楼），虎扑是总回复数 */
	total: number;
	/** 还没显示的条数 */
	remaining: number;
	hasMore: boolean;
	nextPage: number | null;
}

/**
 * 还剩多少、下一跳是第几页。
 *
 * 两个源的 `total` 口径不同（NGA 数的是楼层、含主楼；虎扑数的是回复），但 `page * perPage`
 * 对两边都是「已经过去的条数」，所以一条公式够用：NGA 的主楼正好补上它多算的那一条。
 * 尾页不满时 `total - page * perPage` 会是负数，钳到 0。
 */
export function floorProgress(page: number, perPage: number, total: number): FloorProgress {
	const safePerPage = perPage > 0 ? perPage : 20;
	const remaining = Math.max(0, total - page * safePerPage);
	return {
		page,
		perPage: safePerPage,
		total,
		remaining,
		hasMore: remaining > 0,
		nextPage: remaining > 0 ? page + 1 : null,
	};
}

export function ngaProgress(detail: ThreadDetail): FloorProgress {
	return floorProgress(detail.page || 1, detail.perPage, detail.totalFloors);
}

export function hupuProgress(detail: HupuThreadDetail): FloorProgress {
	return floorProgress(detail.page || 1, detail.perPage, detail.replies);
}

// ---------------------------------------------------------------- 渲染

const ROW = 'flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-faint';
const CARD = 'rounded-2xl border border-line bg-surface p-4';

/**
 * 一层 NGA 楼 → `<li>`。
 *
 * `highlighted` 是「热门回复」那一段：赞数提到最前面做成金色标签；普通楼层只把赞数
 * 平铺在行里。两段用的是同一份结构，别各写一套。
 */
export function renderNgaFloorItem(
	floor: ThreadFloor,
	options: { nickname?: string; now: number; highlighted?: boolean },
): string {
	const scoreBadge = options.highlighted
		? `<span class="rounded bg-gold/15 px-2 py-0.5 font-semibold text-gold">赞 ${floor.score}</span>`
		: `<span>#${floor.floor} 楼</span>`;
	const scorePlain =
		!options.highlighted && floor.score > 0 ? `<span class="text-gold">赞 ${floor.score}</span>` : '';
	const nickname = options.nickname
		? `<span class="text-muted">${escapeHtml(options.nickname)}</span>`
		: '';
	return (
		`<li class="${CARD}" data-pid="${escapeHtml(floor.pid)}">` +
		`<div class="${ROW}">${scoreBadge}${scorePlain}${nickname}` +
		`<span class="ml-auto">${formatMatchTime(floor.time, options.now)}</span></div>` +
		`<div class="nga-post mt-2 text-sm">${renderNgaPost(floor.content)}</div>` +
		`</li>`
	);
}

/** 一条虎扑回复 → `<li>`。「亮评」与「最新回复」的差别只在亮数标签的形式。 */
export function renderHupuFloorItem(
	reply: HupuReply,
	options: { now: number; highlighted?: boolean },
): string {
	const starter = reply.isStarter
		? '<span class="rounded bg-dota/15 px-1.5 py-0.5 font-semibold text-dota-light">楼主</span>'
		: '';
	const lights = options.highlighted
		? `<span class="rounded bg-gold/15 px-2 py-0.5 font-semibold text-gold">亮 ${reply.lights}</span>`
		: reply.lights > 0
			? `<span class="text-gold">亮 ${reply.lights}</span>`
			: '';
	const dialog = reply.replyNum > 0 ? `<span>${reply.replyNum} 条对话</span>` : '';
	return (
		`<li class="${CARD}" data-pid="${escapeHtml(reply.pid)}">` +
		`<div class="${ROW}">${lights}${starter}<span class="text-muted">${escapeHtml(reply.author)}</span>` +
		`${dialog}<span class="ml-auto">${formatMatchTime(reply.createdAt, options.now)}</span></div>` +
		`<div class="hupu-post mt-2 text-sm">${reply.content}</div>` +
		`</li>`
	);
}

/** 首屏的楼层列表（构建期）与「加载更多」的追加（运行时）都走这里。 */
export function renderNgaFloors(
	detail: ThreadDetail,
	floors: ThreadFloor[],
	now: number,
	options: { highlighted?: boolean } = {},
): string {
	return floors
		.map((floor) =>
			renderNgaFloorItem(floor, {
				nickname: detail.nicknames[floor.authorId],
				now,
				highlighted: options.highlighted,
			}),
		)
		.join('');
}

export function renderHupuFloors(
	replies: HupuReply[],
	now: number,
	options: { highlighted?: boolean } = {},
): string {
	return replies.map((reply) => renderHupuFloorItem(reply, { now, highlighted: options.highlighted })).join('');
}

// ---------------------------------------------------------------- 取数

export interface FloorPage {
	source: CommunitySource;
	id: string;
	page: number;
	progress: FloorProgress;
	items: FloorItem[];
	/** NGA 有楼层号：这一页最后一层的楼层号，页面用它把「回复 #1 – #19」接上去。 */
	toFloor?: number;
}

/*
 * 取 NGA 某一页的楼层。`page` 必须是 1 起的正整数（1 页＝20 层）。
 *
 * **缓存里放的是解析结果，不是拼好的 HTML**：HTML 带着「今天 / 昨天 / 09.12」这种相对时间，
 * 跟缓存冻在一起的话，跨过零点的那一页会说错日子。渲染每请求做一遍，很便宜。
 */
export async function fetchNgaFloorPage(tid: string, page: number, now: number): Promise<FloorPage | null> {
	const parsed = await cached<ThreadDetail | null>(`community-floors:nga:${tid}:${page}`, FLOOR_TTL_MS, async () => {
		await pace();
		const response = await fetch(ngaReadUrl(tid, page), {
			headers: { 'User-Agent': NGA_USER_AGENT },
			signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
		});
		if (!response.ok) return null;
		// 正文里出现非法转义会让整个 JSON 解析失败——那一页只能回「去原帖」。
		try {
			return parseThreadJson(await response.json(), page);
		} catch {
			return null;
		}
	});
	if (!parsed) return null;
	// 主楼在第 1 页已经渲染过，这里只给楼层。
	const floors = parsed.floors.filter((floor) => floor.floor > 0);
	return {
		source: 'nga',
		id: tid,
		page: parsed.page,
		progress: ngaProgress(parsed),
		toFloor: floors.at(-1)?.floor,
		items: floors.map((floor) => ({
			pid: floor.pid,
			html: renderNgaFloorItem(floor, { nickname: parsed.nicknames[floor.authorId], now }),
		})),
	};
}

/** 取虎扑某一页的回复。`page` 必须是 1 起的正整数（1 页＝20 条）。缓存口径同 NGA。 */
export async function fetchHupuFloorPage(pid: string, page: number, now: number): Promise<FloorPage | null> {
	const parsed = await cached<HupuThreadDetail | null>(`community-floors:hupu:${pid}:${page}`, FLOOR_TTL_MS, async () => {
		await pace();
		const response = await fetch(hupuThreadPageUrl(pid, page), {
			headers: { 'User-Agent': HUPU_USER_AGENT, Accept: 'text/html,application/xhtml+xml' },
			signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
		});
		if (!response.ok) return null;
		return parseHupuThread(await response.text());
	});
	if (!parsed) return null;
	return {
		source: 'hupu',
		id: pid,
		page: parsed.page || page,
		progress: hupuProgress(parsed),
		items: parsed.floors.map((reply) => ({
			pid: reply.pid,
			html: renderHupuFloorItem(reply, { now }),
		})),
	};
}
