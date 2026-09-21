import type { APIRoute } from 'astro';
import { LANE_MIN_GAMES } from '../lib/draftLanes';
import { HERO_META_BRACKET_LABEL, HERO_META_WINDOW_DAYS, fetchHeroLanes } from '../lib/stratzApi';

export const prerender = true;

/**
 * `/draft-lanes.json`：全池的线上对位（谁在线上打谁、和谁走一路）。
 *
 * 为什么单独一份静态文件、不内联进 `/draft`：裁剪后还有 0.2MB 左右，而 `/draft` 已经内联了
 * 90KB 的阵容数据——再加一份会让首屏更慢。它是**可选增强**：拉不到就少一条依据，
 * 录 BP、算胜率、给建议都不受影响，所以页面是在启动后异步取它。
 *
 * 门槛、分段与窗口都跟着站内其它数据走（见 `stratzApi`），页面上要把这三条写出来。
 */
export const GET: APIRoute = async () => {
	const lanes = await fetchHeroLanes();
	return new Response(
		JSON.stringify({
			minGames: LANE_MIN_GAMES,
			bracket: HERO_META_BRACKET_LABEL,
			windowDays: HERO_META_WINDOW_DAYS,
			vs: lanes?.vs ?? {},
			with: lanes?.with ?? {},
		}),
		{
			headers: {
				'Content-Type': 'application/json; charset=utf-8',
				// 线上统计一天一变，构建产物每次部署都会换，交给浏览器缓存一天即可。
				'Cache-Control': 'public, max-age=86400',
			},
		},
	);
};
