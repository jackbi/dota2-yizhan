/*
 * 相对导入带 `.ts` 后缀：这一层要能被 `scripts/*.check.ts` 用
 * `node --experimental-strip-types` 直接加载，Node 不做后缀补全。
 */
import type { AiConfig } from './aiConfig.ts';
import { endpointOf } from './aiConfig.ts';
import type { ChatShape } from './aiProviders.ts';
import { DEFAULT_CHAT_SHAPE, headersFor, shapeFor } from './aiProviders.ts';

/**
 * 与 OpenAI 兼容端点对话的那一层。
 *
 * 四件事收在这里，因为所有联网的 AI 功能用的是同一段：请求体的形状（`buildChatRequest`）、
 * 被 400 拒掉时的退让顺序（`CHAT_FALLBACKS`）、一次调用的超时（`MODEL_TIMEOUT_MS`），
 * 以及失败时给用户的那句话（`chatErrorMessage`）。早先它们长在 `draftBoard` 里，第二个用它的
 * 功能（`/replay` 的赛后分析）一出现就得抄第二份，所以提到这一层——改一处不会漏三处。
 *
 * 边界：这一层**只管发请求**。提示词在各功能的 `*Prompt.ts`，key 的读写与形状的判定分别在
 * `aiConfig` 与 `aiProviders`。请求由浏览器直接发给用户自己填的地址，服务端不经手。
 */

export interface PromptMessage {
	role: 'system' | 'user';
	content: string;
}

export interface ChatRequestOptions {
	model: string;
	messages: PromptMessage[];
	/** 是否要求 JSON 输出。被 400 拒掉时调用方会去掉它重试。 */
	jsonMode?: boolean;
	maxTokens?: number;
	/**
	 * 请求形状，按服务商给（见 `aiProviders.shapeFor`）。不传就是下面那套最保守的默认值。
	 *
	 * 「被 400 拒掉」那条退让路径在 `requestChat`：它是一步步去掉 `response_format` 与
	 * `temperature`，而不是换一家的形状。
	 */
	shape?: ChatShape;
}

/** 没写上限时给多少。900 是「给一手建议」那一路的实测值，也是几条调用里最短的一条。 */
export const DEFAULT_CHAT_MAX_TOKENS = 900;

/**
 * 组装 `chat/completions` 请求体。
 *
 * DeepSeek 那一家**必须显式关掉思考**（形状里的 `thinking`）。这不是调优，是不关就没有结果：
 * `deepseek-flash` 默认开着思考，实测同样一条提示词下 900 的 token 上限全被 `reasoning_tokens`
 * 吃光，`content` 是空的（`finish_reason: length`）；把上限提到 4000 也一样空，耗时 21 秒。
 * 关掉之后 1.8 秒返回 288 个 token 的正常 JSON。
 */
export function buildChatRequest(options: ChatRequestOptions): Record<string, unknown> {
	const shape = options.shape ?? DEFAULT_CHAT_SHAPE;
	return {
		model: options.model,
		messages: options.messages,
		...(shape.temperature ? { temperature: 0.3 } : {}),
		[shape.maxTokensField]: options.maxTokens ?? DEFAULT_CHAT_MAX_TOKENS,
		...(options.jsonMode === false ? {} : { response_format: { type: 'json_object' } }),
		...(shape.thinking ? { thinking: { type: 'disabled' } } : {}),
	};
}

/**
 * 模型请求的超时。
 *
 * 地址可填之后这条才变成必需：地址写错、或者服务商那边黑洞掉连接时，`fetch` 会一直挂着，
 * 页面就卡在「模型思考中…」，看得见却推不动，还以为是页面坏了。
 * 30 秒的依据：实测同一条提示词关掉思考后 1.8 秒返回，给慢服务商留足余量，又不至于把一次
 * 点错地址变成永久卡死。超时后走的是既有的失败路径（各功能自己决定退回什么）。
 */
export const MODEL_TIMEOUT_MS = 30_000;

/**
 * 请求体被 400 拒掉时的退让顺序：每步只去掉一个「不是每家都认」的可选参数。
 *
 * 1. `response_format`（要求 JSON 输出）——不认它的服务商会直接 400；
 * 2. `temperature`——部分推理模型只接受默认值。
 *
 * 换来换去都在参数上，不换服务商的形状（那由 `aiProviders` 的表决定）。解析层本来就能处理
 * 带代码块围栏的回复，所以退到最后一步功能仍然成立。
 */
export const CHAT_FALLBACKS = [
	{ jsonMode: true, temperature: true },
	{ jsonMode: false, temperature: true },
	{ jsonMode: false, temperature: false },
] as const;

/** 一次模型调用的结果。`status` 为 0 表示请求根本没发出去（网络、跨域或超时）。 */
export type ChatReply = { ok: true; content: string; finishReason: string } | { ok: false; status: number; text: string };

/** `requestChat` 的可选参数；`fetchImpl` 只有自检脚本会换，用来验退让顺序。 */
export interface ChatCallOptions {
	maxTokens?: number;
	timeoutMs?: number;
	fetchImpl?: typeof fetch;
}

/**
 * 发一次模型请求。
 *
 * 退让顺序、超时、请求头都在这里，调用方只负责拼消息与解释失败。网络、跨域、超时直接返回
 * `status: 0`——换参数再试没有意义；只有 400（多半是不认某个可选字段）才退一步重发。
 */
export async function requestChat(config: AiConfig, messages: PromptMessage[], options: ChatCallOptions = {}): Promise<ChatReply> {
	const shape = shapeFor(config.baseUrl);
	const timeout = options.timeoutMs ?? MODEL_TIMEOUT_MS;
	const send = options.fetchImpl ?? fetch;
	let last: { status: number; text: string } = { status: 0, text: '' };
	for (const step of CHAT_FALLBACKS) {
		let response: Response;
		try {
			response = await send(endpointOf(config), {
				method: 'POST',
				// 请求头按服务商拼：Anthropic 那个跨域开关头就挂在这里。
				headers: headersFor(config.baseUrl, config.apiKey),
				signal: AbortSignal.timeout(timeout),
				body: JSON.stringify(
					buildChatRequest({
						model: config.model,
						messages,
						jsonMode: step.jsonMode,
						maxTokens: options.maxTokens,
						shape: { ...shape, temperature: step.temperature },
					}),
				),
			});
		} catch {
			// 网络、跨域、超时：换参数再试没有意义，直接交给调用方去说明。
			return { ok: false, status: 0, text: '' };
		}
		if (response.ok) {
			const body = (await response.json().catch(() => null)) as
				| { choices?: { message?: { content?: string }; finish_reason?: string }[] }
				| null;
			const choice = body?.choices?.[0];
			return { ok: true, content: choice?.message?.content ?? '', finishReason: choice?.finish_reason ?? '' };
		}
		const text = await response.text().catch(() => '');
		// 只有「参数不认」这类 400 值得退一步；key、额度、限流换了参数也一样。
		if (response.status !== 400) return { ok: false, status: response.status, text };
		last = { status: response.status, text };
	}
	return { ok: false, status: last.status, text: last.text };
}

/** 一次失败调用给用户看的一句话。key、额度、限流是最常见的三种，单独说清楚。 */
export function chatErrorMessage(reply: { status: number; text: string }): string {
	if (reply.status === 0) return '请求发不出去：网络、代理，或这家服务没放开跨域';
	if (reply.status === 401) return 'key 无效或已过期';
	if (reply.status === 402) return '余额不足或额度用尽';
	if (reply.status === 429) return '触发限流，稍后再试';
	return `请求失败（HTTP ${reply.status}）${reply.text.slice(0, 80)}`;
}
