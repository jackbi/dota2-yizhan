import { STRATZ_RELAY_TOKEN, STRATZ_RELAY_URL, STRATZ_TOKEN } from 'astro:env/server';
import { pace } from './ssrCache';
import { resolveStratzEndpoint } from './stratzEndpoint';

/**
 * 运行时（SSR）访问 STRATZ 的公共底座：解析端点、发 GraphQL、重试。
 *
 * 单独抽一层是因为运行时有**两个**互不相干的用途——个人战绩页（`stratzPlayer.ts`）
 * 和开黑页之外的队伍阵容（`stratzTeamForm.ts`）。两者共用的是「怎么把一次查询发出去、
 * 失败怎么分类」，不共用任何数据结构，所以这里只放前者。
 *
 * 用 STRATZ 而不是 OpenDota：限速是 8/秒 vs 60/分，运行时要按用户点击取数，
 * 宽的那档才扛得住。token 绑调用方 IP，而 Workers 的边缘出口会漂，所以生产上
 * 多半要配 `STRATZ_RELAY_URL` 走固定出口的中转（见 `stratzEndpoint.ts`）。
 */
const ENDPOINT = resolveStratzEndpoint({
	relayUrl: STRATZ_RELAY_URL,
	relayToken: STRATZ_RELAY_TOKEN,
	token: STRATZ_TOKEN,
});

export function stratzRuntimeConfigured(): boolean {
	return ENDPOINT.mode !== 'none';
}

/** 上游故障时抛错，调用方据此区分「取不到」与「这项数据本来就没有」。 */
export class StratzError extends Error {}

interface GraphQLBody<T> {
	data?: T | null;
	errors?: unknown[];
}

/**
 * 发一次 GraphQL。失败重试三次（STRATZ 偶发 TLS ECONNRESET，构建期也踩过），
 * 重试耗尽后抛错——**不返回 null**，免得把上游故障当成「这个队伍不存在」缓存起来。
 */
export async function stratzGql<T>(document: string, variables: Record<string, unknown>): Promise<T> {
	// 没配 token 也没配中转是「没开这个功能」，与请求失败不是一回事，交给调用方按未配置处理。
	if (ENDPOINT.mode === 'none') {
		throw new StratzError(ENDPOINT.problem ?? '未配置 STRATZ_TOKEN');
	}

	let lastError = '请求失败';
	for (let attempt = 0; attempt < 3; attempt += 1) {
		if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 400 * attempt));
		await pace();
		try {
			const res = await fetch(ENDPOINT.url, {
				method: 'POST',
				signal: AbortSignal.timeout(20_000),
				headers: ENDPOINT.headers,
				body: JSON.stringify({ query: document, variables }),
			});
			// 429 与 5xx 值得重试；403 要读完 body 才能分辨原因（见下）。
			if (res.status === 429 || res.status >= 500) {
				lastError = `HTTP ${res.status}`;
				continue;
			}
			if (res.status === 403) {
				// 先读 body 再分类。STRATZ 对「换出口 IP」的拒绝是 403 + **纯文本**
				// （连 content-type 都没有），必须和同为 403 的 Cloudflare 挑战页分开：
				// 不特判的话页面上只剩一句「HTTP 403」，看不出该去改什么。
				const body = await res.text().catch(() => '');
				if (body.includes('different IP Addresses')) {
					throw new StratzError('STRATZ 拒绝了这个出口 IP：同一个 token 只能从固定 IP 调用，过一会儿重试可能恢复');
				}
				// 其余 403 一律按「可能短暂」重试：挑战页换着花样返回 HTML 与纯文本，只认
				// content-type 会把一部分挑战页当成硬失败。但重试耗尽的文案要保留原始状态码，
				// 不能统一说成挑战页——否则 token 失效这类硬失败会被描述成「稍后再试」。
				lastError = (res.headers.get('content-type') ?? '').includes('text/html') ? 'Cloudflare 挑战页' : `HTTP ${res.status}`;
				continue;
			}
			// 中转这一层自己拒绝：说明两边口令不一致，跟 STRATZ 无关，重试也没用。
			if (res.status === 401 && ENDPOINT.mode === 'relay') {
				throw new StratzError('STRATZ 中转拒绝了这次请求：STRATZ_RELAY_TOKEN 与中转机器上的 RELAY_TOKEN 不一致');
			}
			if (!res.ok) throw new StratzError(`STRATZ 返回 HTTP ${res.status}`);
			const body = (await res.json()) as GraphQLBody<T>;
			if (body.errors?.length) {
				throw new StratzError(`GraphQL 报错：${JSON.stringify(body.errors[0]).slice(0, 200)}`);
			}
			if (!body.data) throw new StratzError('STRATZ 返回空数据');
			return body.data;
		} catch (error) {
			if (error instanceof StratzError) throw error;
			lastError = error instanceof Error ? error.message : String(error);
		}
	}
	throw new StratzError(`STRATZ 请求失败：${lastError}`);
}
