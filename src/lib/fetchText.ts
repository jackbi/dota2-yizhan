/**
 * 抓取层：直连优先，被网络重置时退回读取代理。
 *
 * 本机到 `douyu.com` / `huya.com` 的 TLS 握手会被直接重置，而这两家的接口都没有
 * CORS 头，浏览器里也取不到，所以构建期必须留一条代理退路（`LIVE_PROXY` 控制：
 * auto / jina / off）。直播开播状态、房间列表都用这条路。
 *
 * 走文件而不是内存来共享状态是因为 Astro 会并行开多个渲染进程：
 * 计数器用模块级变量只统计得到本进程，因此每次构建的汇总打印出来只反映其中一个进程。
 */

const JINA_PREFIX = 'https://r.jina.ai/';

export const PROXY_MODE = (process.env.LIVE_PROXY ?? 'auto').toLowerCase();

const DIRECT_TIMEOUT_MS = 6000;
const PROXY_TIMEOUT_MS = 25_000;
/** 直连与代理都不稳，两路各重试若干轮。 */
const ATTEMPTS = 3;
const ATTEMPT_DELAY_MS = 600;

const UA =
	'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

let networkFetches = 0;
let viaProxy = 0;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export { sleep };

/** 直连，被网络重置时返回 null。 */
async function tryDirect(url: string): Promise<string | null> {
	if (PROXY_MODE === 'jina') return null;
	try {
		const res = await fetch(url, {
			headers: { 'User-Agent': UA, Accept: 'text/html,application/json,text/plain,*/*' },
			signal: AbortSignal.timeout(DIRECT_TIMEOUT_MS),
		});
		if (!res.ok) return null;
		return await res.text();
	} catch {
		// 直连被重置（本机到 douyu/huya 就是这样），换代理。
		return null;
	}
}

async function tryProxy(url: string, html: boolean): Promise<string | null> {
	if (PROXY_MODE === 'off') return null;
	try {
		// 不要给 r.jina.ai 带 User-Agent：带上浏览器 UA 反而会触发它的 Cloudflare
		// 人机验证（403 "Just a moment..."），不带才会正常返回内容。
		// 这和 STRATZ 那边"UA 必须是 STRATZ_API"是同一类坑。
		const headers: Record<string, string> = {};
		// 默认它会把页面转成 markdown；要解析页面里内嵌的 JSON 就得要原始 HTML。
		if (html) headers['x-respond-with'] = 'html';
		const res = await fetch(`${JINA_PREFIX}${url}`, {
			headers,
			signal: AbortSignal.timeout(PROXY_TIMEOUT_MS),
		});
		if (!res.ok) return null;
		viaProxy += 1;
		return await res.text();
	} catch {
		// 代理也不通。
		return null;
	}
}

export interface FetchOptions {
	/** 需要原始 HTML 时置 true（会在代理请求上加 `x-respond-with: html`）。 */
	html?: boolean;
	/** 只读本地缓存、不联网。 */
	offline?: boolean;
}

/** 直连优先，被网络重置时退回读取代理；两条路都会偶发失败，所以各重试若干轮。 */
export async function fetchText(url: string, options: FetchOptions = {}): Promise<string | null> {
	if (options.offline) return null;
	for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
		const text = (await tryDirect(url)) ?? (await tryProxy(url, options.html === true));
		if (text) {
			networkFetches += 1;
			return text;
		}
		if (attempt < ATTEMPTS - 1) await sleep(ATTEMPT_DELAY_MS);
	}
	return null;
}

/** 从纯 JSON 或 r.jina.ai 的 "Markdown Content:" 包裹里取出 JSON 对象。 */
export function extractJson(text: string): unknown {
	const start = text.indexOf('{');
	const end = text.lastIndexOf('}');
	if (start < 0 || end <= start) return null;
	try {
		return JSON.parse(text.slice(start, end + 1));
	} catch {
		return null;
	}
}

/** 本轮抓取计数，用于构建汇总。只统计当前进程。 */
export function fetchStats(): { total: number; viaProxy: number } {
	return { total: networkFetches, viaProxy };
}

/** 拼给构建汇总的一段说明。 */
export function fetchNote(): string {
	const { total, viaProxy: proxy } = fetchStats();
	if (total === 0) return '';
	return `，联网抓取 ${total} 次${proxy > 0 ? `（代理 ${proxy}）` : ''}`;
}
