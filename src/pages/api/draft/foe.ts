import type { APIRoute } from 'astro';
import { StratzError, stratzRuntimeConfigured } from '../../../lib/stratzRuntime';
import { loadTeamForm } from '../../../lib/stratzTeamForm';

export const prerender = false;

/**
 * 阵容分析页用：`GET /api/draft/foe?id=<队伍 id>` → 这支队伍近 30 天的英雄偏好。
 *
 * 为什么要过一次服务端：STRATZ 的 token / 中转口令都在服务端，**不能下发到浏览器**，
 * 否则等于把额度送给别人。所以浏览器只认队伍 id，取数在这里做。
 *
 * 失败一律回 200 + `{ok:false, reason}`，不抛给前端：阵容分析页的主功能是录 BP，
 * 「对面擅长什么」取不到只是少一个依据，不该让整页报错。
 */

function respond(body: unknown, status: number, maxAge = 0): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: {
			'Content-Type': 'application/json; charset=utf-8',
			// 队伍偏好是公开数据，允许浏览器缓存一会儿，省掉来回切换队名时的重复请求。
			'Cache-Control': maxAge > 0 ? `private, max-age=${maxAge}` : 'no-store',
		},
	});
}

export const GET: APIRoute = async ({ url }) => {
	const id = Number(url.searchParams.get('id'));
	if (!Number.isSafeInteger(id) || id <= 0) {
		return respond({ ok: false, reason: 'id 必须是正整数（OpenDota 的队伍 id）' }, 400);
	}
	if (!stratzRuntimeConfigured()) {
		return respond({ ok: false, reason: '服务端没有配置 STRATZ token 或中转，取不到队伍数据' }, 200);
	}

	try {
		const form = await loadTeamForm(id);
		// 查得到队伍但窗口内没有比赛，和「这个 id 不存在」在界面上是同一件事：没有可用的依据。
		// 文案里的天数取实际用的窗口（30 天没比赛时会放宽到 90 天，别写成 30）。
		if (!form) return respond({ ok: false, reason: 'STRATZ 里没有这支队伍的记录' }, 200, 600);
		if (form.matches === 0) return respond({ ok: false, reason: `这支队伍近 ${form.windowDays} 天没有职业比赛记录` }, 200, 600);
		return respond({ ok: true, form }, 200, 600);
	} catch (error) {
		return respond({ ok: false, reason: error instanceof StratzError ? error.message : '取队伍数据失败' }, 200);
	}
};
