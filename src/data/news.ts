import type { NewsCardItem } from './types';

/**
 * 社区小道消息 —— 示例数据，暂无真实来源，详情页也未开放。
 * 官方新闻请见 src/lib/newsApi.ts（构建期抓取 dota2.com.cn）。
 */
export const RUMOR_NEWS: NewsCardItem[] = [
	{
		id: 'r-ob-shanghai',
		title: 'OB 天团上海线下聚会直播：排队开黑还是引战？',
		summary: '据可靠小道消息，OB 几位老将近期将再次线下碰面，预计会有整晚的排位直播和经典对局回放，其中某位队长疑似又要“抬人”。',
		date: '2026-08-26',
		tags: ['OB'],
		meta: '小道消息 · 待核实',
		rumor: true,
	},
	{
		id: 'r-kez',
		title: '新英雄“凯兹（Kez）”官方数据曝光，双形态机制引热议',
		summary: '依据官方数据文件与英雄特性，最新英雄 Kez 具备近战/远程双形态切换，玩家对其强度与定位展开了激烈讨论，评论区褒贬不一。',
		date: '2026-08-24',
		tags: ['英雄'],
		meta: '社区爆料 · 待核实',
		rumor: true,
	},
	{
		id: 'r-740',
		title: '版本 7.40 前瞻：野区资源与经济分配迎来重构',
		summary: '多位数据分析师根据测试服改动推测，7.40 可能对野区中立生物、经验分配体系做较大重构，辅助的经济地位有望再次提升。',
		date: '2026-08-20',
		tags: ['版本'],
		meta: '社区爆料 · 待核实',
		rumor: true,
	},
];
