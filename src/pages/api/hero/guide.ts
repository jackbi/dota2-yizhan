import type { APIRoute } from 'astro';
import { StratzError, stratzRuntimeConfigured } from '../../../lib/stratzRuntime';
import { loadGuideDetail, loadGuideIndex } from '../../../lib/stratzGuides';

export const prerender = false;

/**
 * 英雄攻略页展开某一份攻略时用：
 * `GET /api/hero/guide?heroId=<英雄 id>&matchId=<比赛 id>&steamAccountId=<选手 id>`。
 *
 * 为什么要过一次服务端：token / 中转口令在服务端，下发到浏览器等于把额度送人。
 * 详情只在用户点开时取，一次一场比赛——把「一屏 10 份攻略各取一遍」摊到按需，
 * 是这个功能能守住 STRATZ 每天 1 万次额度的前提（见 `stratzGuides.ts`）。
 *
 * 会先核对这份攻略确实在该英雄的索引里：否则这个接口就是一个可以拿任意 matchId
 * 反复刷的通用比赛查询代理，别人刷掉的是我们的额度。
 */

function respond(body: unknown, status: number, maxAge = 0): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: {
			'Content-Type': 'application/json; charset=utf-8',
			// 已结束的比赛不会变，允许浏览器缓存一天，省掉来回点同一份攻略的重复请求。
			'Cache-Control': maxAge > 0 ? `private, max-age=${maxAge}` : 'no-store',
		},
	});
}

export const GET: APIRoute = async ({ url }) => {
	const heroId = Number(url.searchParams.get('heroId'));
	const matchId = Number(url.searchParams.get('matchId'));
	const accountId = Number(url.searchParams.get('steamAccountId'));
	if (![heroId, matchId, accountId].every((value) => Number.isSafeInteger(value) && value > 0)) {
		return respond({ ok: false, reason: 'heroId / matchId / steamAccountId 都必须是正整数' }, 400);
	}
	if (!stratzRuntimeConfigured()) {
		return respond({ ok: false, reason: '服务端没有配置 STRATZ token 或中转，取不到攻略数据' }, 200);
	}

	try {
		// 索引取不到（上游抖动）时放行，不让一个次要校验把详情本身也挡掉。
		const groups = await loadGuideIndex(heroId).catch(() => null);
		if (groups && !groups.some((group) => group.hits.some((hit) => hit.matchId === matchId && hit.steamAccountId === accountId))) {
			return respond({ ok: false, reason: '这份攻略已经不在该英雄的列表里了，回攻略页刷新看看' }, 200, 60);
		}

		const detail = await loadGuideDetail(matchId, accountId, heroId);
		if (!detail) return respond({ ok: false, reason: '这场比赛里没有这位选手的数据' }, 200, 600);
		return respond({ ok: true, detail }, 200, 3600);
	} catch (error) {
		return respond({ ok: false, reason: error instanceof StratzError ? error.message : '取攻略详情失败' }, 200);
	}
};
