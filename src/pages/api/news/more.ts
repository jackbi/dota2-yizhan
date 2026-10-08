import type { APIRoute } from 'astro';
import { MAX_MORE_PAGE, MORE_SOURCES, fetchMoreCards, type MoreSource } from '../../../lib/listMore';

export const prerender = false;

/**
 * 资讯列表的「加载更多」：`GET /api/news/more?source=wmpvp&page=2`
 *
 * `/news/` 的每一栏都是构建期抓回来的固定一屏。读者想接着往下看，这条接口按**各来源自己的
 * 分页**往回取一页，并把条目渲染成与首屏同一份卡片标记（`cardHtml.ts`）。
 *
 * 三条规矩与 `/api/community/floors` 一致：不可索引（`X-Robots-Tag: noindex`）、
 * 页面上没有指向它的链接（只被 XHR 调用）、页码有上限且地址只有固定模板——
 * 免得它变成别人刷上游的免费代理。
 *
 * 注意 **Reddit 那一栏不在这里**：它的官方游标要 OAuth 凭据，而现在没配、走的是 RSS，
 * 那份只有一屏可翻。请求 `source=reddit` 会得到一条说人话的 400。
 *
 * 微博那一栏也留着：它的上游只认 `since_id` 游标、没有页码参数，本站的"第 N 页"是从
 * 第一页顺着游标走 N 步（见 `listMore.ts` 的 `weiboPage`），且有比 `MAX_MORE_PAGE` 更小的上限。
 */

function respond(body: unknown, status: number, maxAge = 0): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: {
			'Content-Type': 'application/json; charset=utf-8',
			'Cache-Control': maxAge > 0 ? `private, max-age=${maxAge}` : 'no-store',
			'X-Robots-Tag': 'noindex',
		},
	});
}

export const GET: APIRoute = async ({ url }) => {
	const source = (url.searchParams.get('source') ?? '').trim();
	const page = Number(url.searchParams.get('page'));

	if (source === 'reddit') {
		return respond(
			{ ok: false, reason: 'Reddit 的公开接口只有一屏，翻更早的要配 OAuth 凭据（目前没配）' },
			400,
		);
	}
	if (!MORE_SOURCES.includes(source as MoreSource)) {
		return respond({ ok: false, reason: `source 只能是 ${MORE_SOURCES.join(' / ')}` }, 400);
	}
	if (!Number.isSafeInteger(page) || page < 2 || page > MAX_MORE_PAGE) {
		return respond({ ok: false, reason: `page 是 2 到 ${MAX_MORE_PAGE} 的整数（第 1 页已经在页面里了）` }, 400);
	}

	const nowSec = Math.floor(Date.now() / 1000);
	try {
		const result = await fetchMoreCards(source as MoreSource, page, nowSec);
		// 一页都取不到时不必报错：页面照旧显示「没有更多了」，读者也能去上游。
		return respond({ ok: true, ...result }, 200, 300);
	} catch (error) {
		return respond(
			{ ok: false, reason: `取下一页时出错：${error instanceof Error ? error.message : String(error)}` },
			200,
		);
	}
};
