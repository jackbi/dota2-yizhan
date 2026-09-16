import type { APIRoute } from 'astro';
import { resolveDouyu } from '../../../lib/liveStream';

export const prerender = false;

/**
 * 给分屏页用的**直链**接口：`GET /api/live/stream-url?platform=douyu&room=58718`
 *
 * 只回一条**一次性**的播放地址，不回视频字节——**视频流量不过服务器**，浏览器直接去斗鱼 CDN 拉
 * （实测 CDN 给 `Access-Control-Allow-Origin: *`，同源限制不存在）。
 *
 * ## 三条必须守住的规矩（都是实测踩出来的）
 *
 * 1. **直链只能消费一次。** 同一个 token 第一次拉能一直推（实测 6 秒 11MB），第二次只剩约
 *    400KB 就断。所以这个接口**绝不缓存 URL**，调用方拿到就得立刻播，播之前不能拿它去
 *    HEAD/探测/预加载。
 * 2. **有效期很短。** 解析完等 25 秒再拉就已经断了（1 秒内拉没事）。所以是「点击 → 解析 →
 *    立刻播」，不能提前解析了揣着。重试、换清晰度、重新播放统统要**重新解析**，
 *    绝不复用旧地址。
 * 3. **不绑 IP。** 实测在代理出口解析、再从另一个出口（直连）拉流照样持续推，
 *    所以服务器放哪儿都行（Vercel / Cloudflare / 自己的机器），观众在自己那边直连 CDN 即可。
 *
 * 这也是为什么之前「自己播流」的尝试全是假的失败：诊断先拿这条地址请求了三次探 CORS，
 * token 被用掉了，后面谁来播都只剩试看量级。
 */
export const GET: APIRoute = async ({ url }) => {
	const platform = (url.searchParams.get('platform') ?? 'douyu').trim();
	const room = (url.searchParams.get('room') ?? '').trim();
	if (platform !== 'douyu') {
		return json({ ok: false, error: `暂不支持 platform=${platform}` }, 400);
	}
	if (!/^\d{1,9}$/.test(room)) {
		return json({ ok: false, error: 'room 必须是数字房间号，例如 58718' }, 400);
	}
	const rate = Number(url.searchParams.get('rate') ?? 0);

	const started = Date.now();
	const resolved = await resolveDouyu(room, Number.isFinite(rate) ? { rate: [rate] } : {});
	if (!resolved.url) {
		return json(
			{
				ok: false,
				error: resolved.errors[0] ?? '没拿到直链',
				live: resolved.live,
				steps: resolved.steps,
				errors: resolved.errors,
			},
			502,
		);
	}
	return json({
		ok: true,
		platform,
		room,
		url: resolved.url,
		kind: resolved.kind ?? 'flv',
		quality: resolved.quality,
		live: resolved.live,
		owner: resolved.owner,
		title: resolved.title,
		elapsedMs: Date.now() - started,
	});
};

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: {
			'Content-Type': 'application/json; charset=utf-8',
			// 里面那条地址是一次性的，谁都不许留。
			'Cache-Control': 'no-store, private',
			'X-Robots-Tag': 'noindex',
		},
	});
}
