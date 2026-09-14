import type { Platform } from './types';

export const NAV = [
	{ href: '/', label: '首页' },
	{ href: '/live', label: '分屏直播' },
	{ href: '/ob', label: 'OB 大家庭' },
	{ href: '/news', label: '新闻' },
	{ href: '/community', label: '社区' },
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
 * 直播间地址。OB 名单与房间号见 `src/data/ob.ts`——那里只收录核实过的房间，
 * 并且会在构建期用平台接口自查房间是否已注销或易主。
 */
export function roomUrl(platform: Platform, roomId: string): string {
	if (platform === 'douyu') return `https://www.douyu.com/${roomId}`;
	if (platform === 'huya') return `https://www.huya.com/${roomId}`;
	if (platform === 'bilibili') return `https://live.bilibili.com/${roomId}`;
	return `https://www.youtube.com/${roomId}`;
}
