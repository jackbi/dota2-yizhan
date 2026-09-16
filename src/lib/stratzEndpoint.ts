/**
 * STRATZ 的端点与鉴权：直连官方，或走固定出口的中转。
 *
 * 两种形态的存在理由是 **token 绑定调用方 IP**：换了出口就 403（纯文本
 * `You cannot use different IP Addresses when using the API.`，连 content-type 都没有）。
 * 而站点的两条取数路径都没有稳定出口：
 *
 * - 运行时的个人战绩跑在 Cloudflare Workers 上，边缘出口按 colo 漂；
 * - 构建期跑在开发机上，本机直连 douyu / 虎牙 / B 站 CDN 会被重置，所以平时挂着代理，
 *   代理组按延迟自动选节点时出口也跟着变。
 *
 * 所以真正稳妥的形态是：token 交给一台出口固定的机器（见 `scripts/stratz-relay.mjs`），
 * 本地与 Worker 都只带一个**中转口令**去跟它说话。**配了中转就一律走中转**——那说明这台
 * 机器自己的出口不可信。
 */

export const STRATZ_GRAPHQL_URL = 'https://api.stratz.com/graphql';
/** 接口前面挂着 Cloudflare，只放行官方文档指定的这个 UA，改了会被挑战页随机拦下。 */
export const STRATZ_USER_AGENT = 'STRATZ_API';

export type StratzMode = 'relay' | 'token' | 'none';

export interface StratzEndpoint {
	mode: StratzMode;
	/** 实际要 POST 的地址。 */
	url: string;
	/** 已经带好鉴权头，调用方直接铺开用即可。 */
	headers: Record<string, string>;
	/** 配置自相矛盾时的说明（比如只配了中转地址没配口令），没问题时是 undefined。 */
	problem?: string;
}

const BASE_HEADERS = {
	'Content-Type': 'application/json',
	Accept: 'application/json',
	'User-Agent': STRATZ_USER_AGENT,
};

/**
 * 解析该用哪个地址、带哪个口令。
 *
 * @param input.relayUrl 固定出口中转的地址（`STRATZ_RELAY_URL`）
 * @param input.relayToken 中转口令（`STRATZ_RELAY_TOKEN`）
 * @param input.token 直连时用的 STRATZ token（`STRATZ_TOKEN`）
 */
export function resolveStratzEndpoint(input: {
	relayUrl?: string | undefined;
	relayToken?: string | undefined;
	token?: string | undefined;
}): StratzEndpoint {
	const relayUrl = (input.relayUrl ?? '').trim();
	const relayToken = (input.relayToken ?? '').trim();
	const token = (input.token ?? '').trim();

	if (relayUrl && relayToken) {
		return {
			mode: 'relay',
			url: relayUrl,
			headers: { ...BASE_HEADERS, 'x-relay-token': relayToken },
		};
	}

	if (relayUrl || relayToken) {
		// 只配一半：不静默退回直连（那会绕过你以为已经生效的中转），按「没开这个功能」处理，
		// 并把原因带出去，让调用方能说清是哪里配漏了。
		return {
			mode: 'none',
			url: STRATZ_GRAPHQL_URL,
			headers: { ...BASE_HEADERS },
			problem: relayUrl ? '配了 STRATZ_RELAY_URL 但没配 STRATZ_RELAY_TOKEN' : '配了 STRATZ_RELAY_TOKEN 但没配 STRATZ_RELAY_URL',
		};
	}

	if (token) {
		return { mode: 'token', url: STRATZ_GRAPHQL_URL, headers: { ...BASE_HEADERS, Authorization: `Bearer ${token}` } };
	}

	return { mode: 'none', url: STRATZ_GRAPHQL_URL, headers: { ...BASE_HEADERS } };
}
