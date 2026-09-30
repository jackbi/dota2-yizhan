import type { APIRoute } from 'astro';
import { loadDraftTeams } from '../lib/draftTeams';

export const prerender = true;

/**
 * `/draft-teams.json`：阵容分析页两个选择框背后的那份数据——队名、队标、OpenDota 队伍 id、
 * 以及每支队的现役名单与招牌英雄。
 *
 * 下拉框本身在页面上是**服务端渲染**的（脚本没跑也选得动），这份 JSON 补的是下拉里放不下的东西：
 * 原生 `<option>` 画不了图片，所以队标、名单、招牌英雄都从这里取，选中哪支就显示哪一支。
 *
 * 单独一份静态文件而不是内联进 `/draft`：它是几十 KB，而页面首屏真正要的是上面那份英雄数据；
 * 这份晚几百毫秒到货不影响任何操作（选择框是静态的，招牌英雄是锦上添花）。
 * 两边都调 `loadDraftTeams()`，结构上不可能各漂各的——要加字段就改 `draftTeams.ts`。
 *
 * **队名 → id 的换算在这里做完了**，浏览器拿到的 `odId` 直接能喂给 `/api/draft/foe`。
 * 以前这份文件是一张 `队名 → id` 的词表，查询规则（大小写、标点）在浏览器里另抄了一份，
 * 抄错一个字符的症状是"这支队永远取不到近期数据"且不报错，所以那条路整个撤了。
 */
export const GET: APIRoute = async () => {
	const catalog = await loadDraftTeams();
	return new Response(JSON.stringify(catalog), {
		headers: {
			'Content-Type': 'application/json; charset=utf-8',
			// 名单与招牌英雄一天一变，构建产物每次部署都会换，交给浏览器缓存一天即可。
			'Cache-Control': 'public, max-age=86400',
		},
	});
};
