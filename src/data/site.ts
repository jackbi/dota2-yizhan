import type { Platform } from './types';

export const NAV = [
	{ href: '/', label: '首页' },
	{ href: '/party', label: '开黑房间' },
	{ href: '/live', label: '监控' },
	{ href: '/ob', label: 'OB 大家庭' },
	{ href: '/news', label: '新闻' },
	{ href: '/community', label: '社区' },
	{ href: '/tournaments', label: '赛事' },
	{ href: '/draft', label: '阵容分析' },
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
 * 开播状态由 `src/lib/liveApi.ts` 在构建期抓取。
 */
export function roomUrl(platform: Platform, roomId: string): string {
	if (platform === 'douyu') return `https://www.douyu.com/${roomId}`;
	if (platform === 'huya') return `https://www.huya.com/${roomId}`;
	if (platform === 'bilibili') return `https://live.bilibili.com/${roomId}`;
	return `https://www.youtube.com/${roomId}`;
}

/**
 * 分屏页里每一格**兜底**要嵌的地址——**和 `roomUrl()` 不是一回事**：那是给人点开看的整页，
 * 这是给 `<iframe>` 嵌的。默认路线是服务端解直链、浏览器用 `mpegts.js` 自播
 * （斗鱼与虎牙都可，见 docs/live.md 的「分屏页的画面」），只有解析不出来或用户手动切时才用这里。
 *
 * 虎牙有官方的「纯播放器」页 `liveshare.huya.com/iframe/{房间号}`（无头 Chrome 实测：200、
 * **没有** `X-Frame-Options`、**没有** `frame-ancestors`；数字房间号与 `longdd` 这类靓号都认）。
 * 它渲染出来就是一个 `<video>` + 一条极简控制条（暂停/刷新、**音量滑杆**、清晰度、弹幕开关），
 * 没有导航、广告和推荐位，`<iframe>` 铺满就是画面，所以虎牙这一格**不需要**任何裁切。
 * 它从默认路线降级成兜底，是因为**只给约 10 分钟试看**（详见 `huyaStream.ts`）。
 *
 * 斗鱼没有这种页面（查过开放平台，没有），所以它兜底嵌的是**整个房间页**，靠 `liveWall.ts` 的
 * `CROP` 表把播放器区域裁出来。
 */
export function embedUrl(platform: Platform, roomId: string): string {
	if (platform === 'huya') return `https://liveshare.huya.com/iframe/${roomId}`;
	return roomUrl(platform, roomId);
}
