import type { CommunityThread } from './ngaApi';
import { fetchCommunityThreads } from './ngaApi';
import { fetchHupuThreads } from './hupuApi';
import { hupuPost, ngaPost } from './communityPost';
import type { CommunityPost } from './communityPost';

/**
 * 映射本身在 `communityPost.ts`（纯模块）：列表的「加载更多」是运行时按需取下一页的，
 * 那边不能引 `ngaApi` / `hupuApi`（带 `node:fs`）。这里再导出一次，组件与页面的引用不用改。
 */
export { SOURCE_LABEL } from './communityPost';
export type { CommunityPost, CommunitySource } from './communityPost';

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

/** 两个来源拼成一条，各自保持自己列表的顺序。 */
export async function fetchCommunityFeed(): Promise<CommunityPost[]> {
	const [nga, hupu] = await Promise.all([
		fetchCommunityThreads().catch((): CommunityThread[] => []),
		fetchHupuThreads().catch(() => []),
	]);

	return [
		...nga.map((thread) => ngaPost(thread)),
		...hupu.map((thread) => hupuPost(thread)),
	];
}
