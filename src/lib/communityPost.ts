/**
 * 社区帖在**页面这一层**的形状（`CommunityPost`），以及两个来源到它的映射。
 *
 * 单独成文件的原因与 `ngaThread.ts` 一样：列表的「加载更多」是运行时按需取下一页的，
 * 而原先这份映射住在 `communityFeed.ts` 里，那个文件要引 `ngaApi` / `hupuApi`（带 `node:fs`），
 * 上 Workers 就废了。映射是纯逻辑，放这里两边共用。
 *
 * 参数用**结构类型**而不是 `CommunityThread` / `HupuThread`：那两个类型住在各自的取数模块里，
 * 引进来就把 `node:*` 又拖回来了。
 */

export type CommunitySource = 'nga' | 'hupu';

export const SOURCE_LABEL: Record<CommunitySource, string> = {
	nga: 'NGA',
	hupu: '虎扑',
};

export interface CommunityPost {
	/** 站内唯一 key：来源 + 原生 id */
	id: string;
	source: CommunitySource;
	title: string;
	author: string;
	/** 回复数：NGA 是热榜口径的，虎扑是帖子总回复数 */
	replies: number;
	/** 浏览数，只有虎扑列表给 */
	views?: number;
	/** 最后回复时间，Unix 秒 */
	lastReplyAt: number;
	summary: string;
	/** 站内详情页地址：两个来源都镜像到 `/community/...`，原帖外链在详情页里给 */
	href: string;
}

export function ngaPost(thread: {
	tid: string;
	title: string;
	author: string;
	replies: number;
	lastReplyAt: number;
	summary: string;
}): CommunityPost {
	return {
		id: `nga-${thread.tid}`,
		source: 'nga',
		title: thread.title,
		author: thread.author,
		replies: thread.replies,
		lastReplyAt: thread.lastReplyAt,
		summary: thread.summary,
		href: `/community/nga/${thread.tid}/`,
	};
}

export function hupuPost(thread: {
	pid: string;
	title: string;
	author: string;
	replies: number;
	views?: number;
	lastReplyAt: number;
	summary: string;
}): CommunityPost {
	return {
		id: `hupu-${thread.pid}`,
		source: 'hupu',
		title: thread.title,
		author: thread.author,
		replies: thread.replies,
		views: thread.views,
		lastReplyAt: thread.lastReplyAt,
		summary: thread.summary,
		href: `/community/hupu/${thread.pid}/`,
	};
}
