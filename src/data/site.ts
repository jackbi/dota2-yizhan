import type { Streamer, Platform } from './types';

export const NAV = [
	{ href: '/', label: '首页' },
	{ href: '/live', label: '分屏直播' },
	{ href: '/ob', label: 'OB 大家庭' },
	{ href: '/news', label: '新闻' },
	{ href: '/tournaments', label: '赛事' },
	{ href: '/patches', label: '版本' },
	{ href: '/heroes', label: '英雄' },
	{ href: '/items', label: '装备' },
] as const;

export const PLATFORM_META: Record<Platform, { label: string; color: string; short: string }> = {
	douyu: { label: '斗鱼', color: '#E9502D', short: 'DY' },
	huya: { label: '虎牙', color: '#FF9600', short: 'HY' },
	bilibili: { label: '哔哩哔哩', color: '#FB7299', short: 'B站' },
	youtube: { label: 'YouTube', color: '#FF0000', short: 'YT' },
};

/**
 * OB 大家庭主播列表 —— 示例数据。
 * `embedUrl` 请替换为各平台实际的直播间嵌入地址，`roomId` 为房间号。
 * 头像目前用首字母占位，可换成真实头像 URL。
 */
export const STREAMERS: Streamer[] = [
	{
		id: 'yyf',
		name: 'YYF',
		alias: '枫哥',
		platform: 'douyu',
		roomId: 'xxxxx1',
		embedUrl: 'https://www.douyu.com/xxxxx1',
		tag: '前 iG 三号位',
		live: true,
		viewers: 128000,
		description: 'OB 天团核心，直播风格幽默，深受玩家喜爱。',
	},
	{
		id: 'xiao8',
		name: 'xiao8',
		alias: '八弟',
		platform: 'douyu',
		roomId: 'xxxxx2',
		embedUrl: 'https://www.douyu.com/xxxxx2',
		tag: '前 LGD / Newbee 队长',
		live: true,
		viewers: 92000,
		description: '曾带队夺得 TI 冠军，战术理解顶级。',
	},
	{
		id: '430',
		name: '430',
		alias: '奶牛',
		platform: 'douyu',
		roomId: 'xxxxx3',
		embedUrl: 'https://www.douyu.com/xxxxx3',
		tag: '前 iG 中单',
		live: true,
		viewers: 88000,
		description: 'TI 冠军中单，操作细腻，骚话不断。',
	},
	{
		id: 'mu',
		name: 'Mu',
		alias: '木',
		platform: 'bilibili',
		roomId: 'xxxxx4',
		embedUrl: 'https://live.bilibili.com/xxxxx4',
		tag: '前 Newbee 中单',
		live: false,
		viewers: 0,
		description: 'TI 冠军中单，冷静沉稳的顶级大赛选手。',
	},
	{
		id: 'zhou',
		name: 'Zhou',
		alias: '周神',
		platform: 'douyu',
		roomId: 'xxxxx5',
		embedUrl: 'https://www.douyu.com/xxxxx5',
		tag: '前 iG 一号位',
		live: false,
		viewers: 0,
		description: 'TI 冠军一号位，大核接管比赛的代表。',
	},
	{
		id: '820',
		name: '820',
		alias: '传奇队长',
		platform: 'huya',
		roomId: 'xxxxx6',
		embedUrl: 'https://www.huya.com/xxxxx6',
		tag: '前 EHOME 队长',
		live: false,
		viewers: 0,
		description: '中国 DOTA 最早的传奇队长之一，经典解说。',
	},
];

/** 首页“正在直播”的一排推荐 */
export const LIVE_NOW = STREAMERS.filter((s) => s.live);
