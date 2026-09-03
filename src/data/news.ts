import type { NewsItem } from './types';

/** Dota2 相关新闻与小道消息 —— 示例数据，可替换为真实来源（如官网资讯、社区媒体）。 */
export const NEWS: NewsItem[] = [
	{
		id: 'n1',
		title: '新版本 7.39b 平衡性调整上线，多个热门英雄遭削弱',
		summary:
			'本次平衡性补丁重点调整了中路节奏与中后期团队装的经济曲线，影魔、敌法、风暴之灵等热门核心均被小幅削弱，辅助位的勋章与团队装性价比进一步提升。',
		source: 'DOTA2 官网',
		category: 'news',
		date: '2026-08-30',
		tag: '版本',
		readTime: '4 分钟',
		featured: true,
	},
	{
		id: 'n2',
		title: 'TI 年度大赛举办地正式官宣，奖金池再创纪录',
		summary:
			'The International 2026 将在柏林举办，基础奖金池提升至 200 万美元，加上本子分成总额有望再度突破。六大赛区预选赛时间表同步公布。',
		source: 'DOTA2 官网',
		category: 'news',
		date: '2026-08-28',
		tag: '赛事',
		readTime: '3 分钟',
		featured: true,
	},
	{
		id: 'n3',
		title: 'OB 天团上海线下聚会直播：排队开黑还是引战？',
		summary:
			'据可靠小道消息，OB 几位老将近期将再次线下碰面，预计会有整晚的排位直播和经典对局回放，其中某位队长疑似又要“抬人”。',
		source: '小道消息',
		category: 'rumor',
		date: '2026-08-26',
		tag: 'OB',
		readTime: '2 分钟',
	},
	{
		id: 'n4',
		title: '新英雄“凯兹（Kez）”官方数据曝光，双形态机制引热议',
		summary:
			'依据官方数据文件与英雄特性，最新英雄 Kez 具备近战/远程双形态切换，玩家对其强度与定位展开了激烈讨论，评论区褒贬不一。',
		source: '社区爆料',
		category: 'rumor',
		date: '2026-08-24',
		tag: '英雄',
		readTime: '5 分钟',
	},
	{
		id: 'n5',
		title: 'XG 战队官宣新阵容：两位青训小将上调一队',
		summary:
			'XG 官方宣布提拔两名青训选手进入主力名单，并为新阵容配置了专门的战术分析师，目标直指即将到来的 ESL 赛事。',
		source: 'DOTA2 官网',
		category: 'news',
		date: '2026-08-22',
		tag: '战队',
		readTime: '3 分钟',
	},
	{
		id: 'n6',
		title: '版本 7.40 前瞻：野区资源与经济分配迎来重构',
		summary:
			'多位数据分析师根据测试服改动推测，7.40 可能对野区中立生物、经验分配体系做较大重构，辅助的经济地位有望再次提升。',
		source: '社区爆料',
		category: 'rumor',
		date: '2026-08-20',
		tag: '版本',
		readTime: '4 分钟',
	},
];

export const NEWS_TABS = [
	{ id: 'all', label: '全部' },
	{ id: 'news', label: '官方新闻' },
	{ id: 'rumor', label: '小道消息' },
] as const;
