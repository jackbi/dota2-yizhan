import type { CommunityThread } from './ngaApi';
import { fetchCommunityThreads } from './ngaApi';
import { fetchHupuThreads } from './hupuApi';

/**
 * 社区版块的多来源聚合层。
 *
 * 页面只认这里的 `CommunityPost`：来源、回复数、跳转地址都在这一层定好，
 * 组件与页面不用再关心 NGA / 虎扑各自的数据形状。
 *
 * **两个来源各自保持来源自己的顺序，这里不合并、不重排。**
 *
 * - NGA 那一栏是它自己的**热榜**（按回复数倒序）；
 * - 虎扑那一栏是版面页的**最新回复**顺序（按时间，见 `hupuApi` 的文件头）；
 *
 * 两边的"热"不是一回事，回复数也不能换算（NGA 是榜单口径的回复数，虎扑是帖子总回复数）。
 * 早先这里把两边拼起来按回复数重排，等于拿两把尺子量同一列，还会把虎扑的新帖挤下去；
 * 现在页面上按来源分栏，各排各的，读者切换来源时看到的就是那个来源自己的样子。
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

/** 两个来源拼成一条，各自保持自己列表的顺序。 */
export async function fetchCommunityFeed(): Promise<CommunityPost[]> {
	const [nga, hupu] = await Promise.all([
		fetchCommunityThreads().catch((): CommunityThread[] => []),
		fetchHupuThreads().catch(() => []),
	]);

	return [
		...nga.map(
			(thread): CommunityPost => ({
				id: `nga-${thread.tid}`,
				source: 'nga',
				title: thread.title,
				author: thread.author,
				replies: thread.replies,
				lastReplyAt: thread.lastReplyAt,
				summary: thread.summary,
				href: `/community/nga/${thread.tid}`,
			}),
		),
		...hupu.map(
			(thread): CommunityPost => ({
				id: `hupu-${thread.pid}`,
				source: 'hupu',
				title: thread.title,
				author: thread.author,
				replies: thread.replies,
				views: thread.views,
				lastReplyAt: thread.lastReplyAt,
				summary: thread.summary,
				href: `/community/hupu/${thread.pid}`,
			}),
		),
	];
}
