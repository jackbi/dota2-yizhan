import type { APIRoute } from 'astro';
import { exitIp, probeStreamHeaders, resolveDouyu, sampleStream } from '../../../lib/liveStream';

export const prerender = false;

/**
 * 直播直链解析的**诊断端点**（临时）。
 *
 * 分屏页要从「嵌平台整个页面」换成「自己播 `<video>`」，绕不开两个必须先回答的问题：
 *
 * 1. **服务端能不能解析出直链**——本机到 `douyu.com` 的 TLS 握手是被重置的
 *    （`liveApi.ts` 顶上记着这件事），所以这件事只能在能直连斗鱼的机器上验证：
 *    部署到 Vercel / Cloudflare Workers 后打一次这个接口即可。
 * 2. **浏览器能不能直接拉这条直链**——斗鱼 CDN 要 `Referer`，而浏览器发不了自定义 Referer。
 *    这个接口顺手把三种 Referer 变体各请求一次，把状态码与 `Access-Control-Allow-Origin`
 *    原样回报，用事实代替猜测。
 *
 * 用法（部署后）：`GET /api/live/probe?room=9999`
 *
 * 注意：**它不是给人用的接口**，是给一次判断用的。定下方案后应当删掉——
 * 留在生产环境里等于给别人一个「随便查任意房间直链」的入口，而且每次请求都要打一次斗鱼。
 * 所以这里做了两件小事：只认数字房间号、20 秒内同一房间直接回缓存。
 */
const CACHE_TTL_MS = 20_000;

interface CacheEntry {
	at: number;
	body: unknown;
}

const cache = new Map<string, CacheEntry>();

export const GET: APIRoute = async ({ url, request }) => {
	const room = (url.searchParams.get('room') ?? '9999').trim();
	if (!/^\d{1,9}$/.test(room)) {
		return json({ error: 'room 必须是数字房间号，例如 9999' }, 400);
	}

	const started = Date.now();
	// `&sample=8000` 会让本进程把直链真拉 8 秒，用来验证「同一出口 IP 解析+取流能不能持续推」。
	// 带上它就别用缓存，否则会拿到上一次的采样结果。
	const sampleMs = Math.min(15_000, Math.max(0, Number(url.searchParams.get('sample') ?? 0) || 0));
	const withHeaders = url.searchParams.get('headers') === '1';
	// 直链是**一次性的**（实测：同一 token 第二次拉只给约 400KB 就断），所以缓存直链等于
	// 把 token 存成废纸。缓存键带上 headers / sample：这两个开关会改变响应内容
	// （只有 `headers=1` 才有 `headerProbe`），不带上就会把「这轮没探」回放成「CDN 没给 CORS 头」。
	const cacheKey = `${room}:${sampleMs}:${withHeaders ? 'h' : 'n'}`;
	const noCache = url.searchParams.get('nocache') === '1';

	const cached = cache.get(cacheKey);
	if (!noCache && cached && Date.now() - cached.at < CACHE_TTL_MS) {
		return json({ ...(cached.body as Record<string, unknown>), cached: true });
	}

	const resolved = await resolveDouyu(room);
	// 我们的源按请求头推断，与 `selfOrigin` 一起决定了「浏览器默认会发的 Referer」。
	const selfOrigin = url.origin || `http://${request.headers.get('host') ?? 'localhost'}`;
	/*
	 * CDN 头探测**默认关掉**：它会拿同一条直链请求三次，而实测直链的 token 很可能
	 * 只能被消费一次——先探三次，后面无论谁来播都只剩「试看」量级（约 400KB 就断）。
	 * 这个坑把前几轮的结论全带偏过：不是浏览器不行，是我们自己在测试前就把 token 用掉了。
	 * 要探就显式 `&headers=1`，并且别在同一条 URL 上接着播。
	 */
	const headerProbe = withHeaders && resolved.url ? await probeStreamHeaders(resolved.url, selfOrigin) : [];
	const sample = resolved.url && sampleMs > 0 ? await sampleStream(resolved.url, sampleMs) : null;

	const body = {
		room,
		selfOrigin,
		elapsedMs: Date.now() - started,
		live: resolved.live,
		owner: resolved.owner,
		title: resolved.title,
		kind: resolved.kind,
		quality: resolved.quality,
		qualities: resolved.qualities,
		url: resolved.url,
		steps: resolved.steps,
		errors: resolved.errors,
		headerProbe,
		/** 斗鱼签名时看到的客户端 IP/did（`enc_data.op`）——验证 IP 绑定的关键证据。 */
		encInfo: resolved.encInfo,
		/** 本进程的公网出口（走代理时和浏览器可能不是同一个出口）。 */
		exitIp: await exitIp(),
		sample,
		/** 原样带回来，别让它进日志；排查签名参数时有用。 */
		raw: resolved.raw,
	};
	// 只缓存「没解析出直链」的结果：那种答案再问一次也一样，而带直链的响应里装着的是一次性 token。
	if (!resolved.url) cache.set(cacheKey, { at: Date.now(), body });
	return json(body);
};

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body, null, 2), {
		status,
		headers: {
			'Content-Type': 'application/json; charset=utf-8',
			'Cache-Control': 'no-store, private',
			'X-Robots-Tag': 'noindex',
		},
	});
}
