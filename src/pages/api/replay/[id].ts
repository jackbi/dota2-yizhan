import type { APIRoute } from 'astro';
import { StratzError, loadMatchPlayback, reviewConfigured } from '../../../lib/matchReview';

export const prerender = false;

/**
 * 地图回放的数据接口：`GET /api/replay/<Valve 比赛 id>`。
 *
 * 为什么不跟页面一起在服务端渲染出来：这份数据**一大一小两个数量级**——10 个英雄的逐秒位置
 * 实测 2.1 万个点（约 400KB 上游响应、整理后仍有 100KB 级），而复盘面板那份只有 2KB。
 * 内联进 HTML 等于让每个只看记分板的人也下载一遍轨迹，所以这条数据等读者点了
 * 「载入英雄轨迹」再取（见 `MatchPlayback.astro`）。
 *
 * 为什么必须过一次服务端：STRATZ 的 token 与中转口令不能下发到浏览器，否则等于把额度送人。
 *
 * 失败一律 200 + `{ok:false, reason}`，由前端写成一句「这局没有轨迹数据」——地图拿不到数据
 * 只是少一个视图，不该让整页报错。
 */

function respond(body: unknown, status: number, maxAge = 0): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: {
			'Content-Type': 'application/json; charset=utf-8',
			// 已结束对局的轨迹不再变化，允许浏览器缓存一小时，省掉反复切 Tab 时的重复请求。
			'Cache-Control': maxAge > 0 ? `public, max-age=${maxAge}` : 'no-store',
		},
	});
}

export const GET: APIRoute = async ({ params }) => {
	const id = Number(params.id);
	if (!Number.isSafeInteger(id) || id <= 0) {
		return respond({ ok: false, reason: '比赛 id 必须是正整数' }, 400);
	}
	if (!reviewConfigured()) {
		return respond({ ok: false, reason: '服务端没有配置 STRATZ token 或中转，取不到轨迹数据' }, 200);
	}

	try {
		const playback = await loadMatchPlayback(id);
		if (!playback) {
			// 这个「没有」是常态而不是故障：STRATZ 只为下载并解析过录像的对局提供 playbackData，
			// 而录像有保留期（实测一周前的职业局就是空数组）。文案要说清是覆盖率，不是站点坏了。
			return respond({ ok: false, reason: 'STRATZ 没有这场对局的录像数据（只覆盖近期且下载过录像的对局）' }, 200, 600);
		}
		return respond({ ok: true, playback }, 200, 3600);
	} catch (error) {
		return respond({ ok: false, reason: error instanceof StratzError ? error.message : '取轨迹数据失败' }, 200);
	}
};
