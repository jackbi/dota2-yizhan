import type { APIRoute } from 'astro';
import { getTeamNameIndex } from '../lib/opendota';

export const prerender = true;

/**
 * `/draft-teams.json`：队伍名 → OpenDota 队伍 id 的索引，给阵容分析页手动填队名时查表。
 *
 * 单独一份静态文件而不是内联进 `/draft`：它是几十 KB，而绝大多数时候用户是从赛程下拉里
 * 选比赛的（那条路页面上直接带着 id），只有手填队名才需要这份表。
 * 键的规则见 `opendota.getTeamNameIndex`——**必须和 `resolveTeam` 一致**。
 */
export const GET: APIRoute = async () => {
	const index = await getTeamNameIndex();
	return new Response(JSON.stringify(index), {
		headers: {
			'Content-Type': 'application/json; charset=utf-8',
			// 队名变化很慢，但构建产物每次部署都会换，交给浏览器缓存一天即可。
			'Cache-Control': 'public, max-age=86400',
		},
	});
};
