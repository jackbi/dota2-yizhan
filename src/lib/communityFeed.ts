import type { CommunityThread, HotWindowDays } from './ngaApi';
import { HOT_WINDOWS, fetchCommunityThreads } from './ngaApi';
import { fetchHupuThreads } from './hupuApi';

/**
 * 社区版块的多来源聚合层。
 *
 * 页面只认这里的 `CommunityPost`：来源、回复数、窗口、跳转地址都在这一层定好，
 * 组件与页面不用再关心 NGA / 虎扑各自的数据形状。
 *
 * **回复数不可跨来源比较。** NGA 的 `replies` 是时间窗内的回复数（它自己的热榜接口给的），
 * 虎扑的是帖子总回复数——两个口径没法换算，所以这里不做归一化，只保证"按回复数倒序"这
 * 一个排序规则；页面上按来源筛选后各自才可比，文案里也写明了。
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
	/** 回复数：NGA 是窗口内的，虎扑是帖子总数 */
	replies: number;
	/** 浏览数，只有虎扑列表给 */
	views?: number;
	/** 最后回复时间，Unix 秒 */
	lastReplyAt: number;
	summary: string;
	/** 该帖归属哪些时间窗 */
	windows: HotWindowDays[];
	/** 站内详情页地址：两个来源都镜像到 `/community/...`，原帖外链在详情页里给 */
	href: string;
}

/**
 * 虎扑没有窗口参数，只能按「最后回复时间落在窗口内」归属。
 *
 * 这和 NGA 的语义不同（NGA 是"这个窗口内足够热才上榜"，这里是"最近有人回"），
 * 是能做到的最接近的近似；窗口标签只是筛掉太久没人理的帖子，不代表窗口内的热度。
 */
function windowsOf(lastReplyAt: number, nowSec: number): HotWindowDays[] {
	return HOT_WINDOWS.filter((window) => lastReplyAt > 0 && nowSec - lastReplyAt <= window.days * 86400).map(
		(window) => window.days,
	);
}

/** 两个来源合并去重（各自内部已按回复数倒序），整体仍按回复数倒序。 */
export async function fetchCommunityFeed(): Promise<CommunityPost[]> {
	const [nga, hupu] = await Promise.all([
		fetchCommunityThreads().catch((): CommunityThread[] => []),
		fetchHupuThreads().catch(() => []),
	]);

	const nowSec = Math.floor(Date.now() / 1000);
	const posts: CommunityPost[] = [
		...nga.map(
			(thread): CommunityPost => ({
				id: `nga-${thread.tid}`,
				source: 'nga',
				title: thread.title,
				author: thread.author,
				replies: thread.replies,
				lastReplyAt: thread.lastReplyAt,
				summary: thread.summary,
				windows: thread.windows,
				href: `/community/nga/${thread.tid}`,
			}),
		),
		...hupu
			.map((thread): CommunityPost => ({
				id: `hupu-${thread.pid}`,
				source: 'hupu',
				title: thread.title,
				author: thread.author,
				replies: thread.replies,
				views: thread.views,
				lastReplyAt: thread.lastReplyAt,
				summary: thread.summary,
				windows: windowsOf(thread.lastReplyAt, nowSec),
				href: `/community/hupu/${thread.pid}`,
			}))
			// 超过最长的窗口（30 天）没人回，就不算热帖了。
			.filter((post) => post.windows.length > 0),
	];

	return posts.sort(
		(a, b) => b.replies - a.replies || b.lastReplyAt - a.lastReplyAt || a.id.localeCompare(b.id),
	);
}

/** 按来源统计条数，页面上的来源页签用。 */
export function countBySource(posts: CommunityPost[]): Record<'all' | CommunitySource, number> {
	return {
		all: posts.length,
		nga: posts.filter((post) => post.source === 'nga').length,
		hupu: posts.filter((post) => post.source === 'hupu').length,
	};
}
