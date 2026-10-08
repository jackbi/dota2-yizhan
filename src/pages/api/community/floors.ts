import type { APIRoute } from 'astro';
import { MAX_FLOOR_PAGE, fetchHupuFloorPage, fetchNgaFloorPage } from '../../../lib/communityFloors';

export const prerender = false;

/**
 * 社区帖详情页的「加载更多回复」：
 * `GET /api/community/floors?source=nga&id=47683317&page=2`
 *
 * ## 为什么要有这条接口
 *
 * 详情页是预渲染的，构建期一次只抓得回第一页（NGA 20 层、虎扑 20 条）。原先页面只摆热评 +
 * 前 10 层，剩下的要读者自己回原帖——能看到的太少。现在想看更多的人点一下，由这条接口去上游
 * 取下一页，**按页返回**，与上游自己的分页一一对应。
 *
 * ## 三条必须守住的规矩
 *
 * 1. **只响应点击。** 它不可索引（`X-Robots-Tag: noindex`）、页面上也没有任何 `<a href>` 指向它，
 *    否则搜索引擎会把这里当成刷上游的免费代理。第 1 页不在这里发——它已经在页面的静态 HTML 里。
 * 2. **不能变成任意帖子的抓取器。** `id` 只接受数字帖子号、`page` 有上限（`MAX_FLOOR_PAGE`），
 *    且只打两个固定的上游模板，不接任何由调用方给出的地址。
 * 3. **上游挂了要说人话。** 失败一律回 `{ ok: false, reason }`，页面照旧有「前往原帖」那条出口。
 */

function respond(body: unknown, status: number, maxAge = 0): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: {
			'Content-Type': 'application/json; charset=utf-8',
			// 楼层是活的，但同一页 10 分钟内没必要重复问上游；浏览器这边给 5 分钟。
			'Cache-Control': maxAge > 0 ? `private, max-age=${maxAge}` : 'no-store',
			'X-Robots-Tag': 'noindex',
		},
	});
}

export const GET: APIRoute = async ({ url }) => {
	const source = (url.searchParams.get('source') ?? '').trim();
	const id = (url.searchParams.get('id') ?? '').trim();
	const page = Number(url.searchParams.get('page'));

	if (source !== 'nga' && source !== 'hupu') {
		return respond({ ok: false, reason: 'source 只能是 nga 或 hupu' }, 400);
	}
	if (!/^\d{1,12}$/.test(id)) {
		return respond({ ok: false, reason: 'id 必须是数字帖子号' }, 400);
	}
	if (!Number.isSafeInteger(page) || page < 1 || page > MAX_FLOOR_PAGE) {
		return respond({ ok: false, reason: `page 是 1 到 ${MAX_FLOOR_PAGE} 的整数` }, 400);
	}

	const now = Math.floor(Date.now() / 1000);
	try {
		const result =
			source === 'nga' ? await fetchNgaFloorPage(id, page, now) : await fetchHupuFloorPage(id, page, now);
		if (!result) {
			return respond({ ok: false, reason: '这一页暂时取不到（上游没响应，或者页码已经超出）' }, 200, 60);
		}
		return respond({ ok: true, ...result }, 200, 300);
	} catch (error) {
		return respond(
			{ ok: false, reason: `取下一页时出错：${error instanceof Error ? error.message : String(error)}` },
			200,
		);
	}
};
