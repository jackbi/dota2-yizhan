import { decodeEntities } from './articleHtml.ts';

/**
 * 虎扑 DOTA2 区**列表页**（`bbs.hupu.com/dota2`）的解析与取帖口径。
 *
 * 从 `hupuApi.ts` 拆出来只为了一件事：这里不碰网络、不碰缓存，是「HTML → 帖子列表」的纯函数，
 * 所以 `scripts/hupuBoard.check.ts` 能直接喂 HTML 用例，不联网也能盯住下面这条不变量。
 *
 * **口径：跟着版面页走，不自己重排。** 版面页默认选中的是「最新回复」（另一个页签是
 * 「最新发布」），49 条、最新的在最前，实测前 20 条的回复时间落在 0–6 天之间。
 *
 * 早先这里照搬了 NGA 的做法——先按 `回复数 >= 5` 过滤、再按回复数倒序取前 20——结果那一栏
 * 每轮构建都长一个样：新帖回复少，第一刀就被砍掉，剩下的全是几天前的高回复长贴
 * （实测选出来的 20 条里，最新的一条也是 74 小时前）。NGA 那边能这么排，是因为它调的就是
 * **热榜接口**，回复数是它排好的结果；虎扑没有热榜接口，按回复数重排等于专门挑最老的。
 */

export interface HupuThread {
	/** 帖子 id，取自列表里的 `/642425918.html` */
	pid: string;
	title: string;
	author: string;
	/** 帖子总回复数（不是窗口内的） */
	replies: number;
	/** 浏览量 */
	views: number;
	/** 最后回复时间，Unix 秒 */
	lastReplyAt: number;
	/** 主楼首段摘要；抓不到就是空串 */
	summary: string;
}

/**
 * 版面页有 49 条，取**最前面**这 20 条（条数与 NGA 那一栏对齐）。
 * 是「取前 N」不是「按回复数排前 N」，理由见文件头。
 */
export const THREADS_PER_BOARD = 20;

/**
 * 列表页只给 `MM-DD HH:mm`，没有年份。
 *
 * 按**北京时间**（UTC+8）解成 Unix 秒：虎扑的时间是北京时间，而构建机的时区不一定，
 * 用本地时区解会让 `lastReplyAt` 随构建设备漂移。跨年时解出来的时间会比"现在"还晚，
 * 那就退回上一年。
 */
export function parseMonthDay(value: string, nowSec: number): number {
	const match = /^(\d{2})-(\d{2}) (\d{2}):(\d{2})$/.exec(value.trim());
	if (!match) return 0;
	const month = Number(match[1]);
	const day = Number(match[2]);
	const hour = Number(match[3]);
	const minute = Number(match[4]);
	const at = (year: number) => Math.floor(Date.UTC(year, month - 1, day, hour - 8, minute) / 1000);
	const currentYear = new Date(nowSec * 1000).getUTCFullYear();
	const guess = at(currentYear);
	return guess > nowSec + 3600 ? at(currentYear - 1) : guess;
}

/** 列表里的标题与作者带内联标签与实体，统一还原成纯文本。 */
function stripTags(html: string): string {
	return decodeEntities(html.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/** 列表行：标题、地址、`回复 / 浏览`、作者、最后回复时间。顺序就是版面页的顺序。 */
export function toThreads(html: string, nowSec: number): HupuThread[] | null {
	const rows = [...html.matchAll(/<li class="bbs-sl-web-post-body">([\s\S]*?)<\/li>/g)].map((match) => match[1]);
	if (rows.length === 0) return null;
	const threads: HupuThread[] = [];
	for (const block of rows) {
		const href = /<a href="(\/\d+\.html)"/.exec(block)?.[1];
		const pid = href?.replace(/\D/g, '') ?? '';
		const title = stripTags(/class="p-title"[^>]*>([\s\S]*?)<\/a>/.exec(block)?.[1] ?? '');
		const datum = /class="post-datum">([^<]*)</.exec(block)?.[1] ?? '';
		const author = stripTags(/class="post-auth">([\s\S]*?)<\/div>/.exec(block)?.[1] ?? '');
		const [replies, views] = datum.split('/').map((part) => Number(part.trim()) || 0);
		if (!pid || !title || !author) continue;
		threads.push({
			pid,
			title,
			author,
			replies,
			views,
			lastReplyAt: parseMonthDay(/class="post-time">([^<]*)</.exec(block)?.[1] ?? '', nowSec),
			summary: '',
		});
	}
	/** 只剩「时间解不出来」这一种要丢：没有它，「几天没回复」就没法算。 */
	return threads.filter((thread) => thread.lastReplyAt > 0);
}

/**
 * 取版面页最前面的若干条，**不重排**。
 *
 * 单独拎出来是为了留一个能测的缝：这段以前是「按回复数倒序 + 过滤掉回复少的」，
 * 换成 `slice` 之后，`scripts/hupuBoard.check.ts` 里那条「少回复的新帖排在老长贴前面」的
 * 断言才盯得住它，免得以后有人再把排序加回来。
 */
export function selectBoardThreads(threads: HupuThread[], limit = THREADS_PER_BOARD): HupuThread[] {
	return threads.slice(0, limit);
}
