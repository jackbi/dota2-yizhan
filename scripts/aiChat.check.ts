import assert from 'node:assert/strict';
import { DEFAULT_AI_MODEL } from '../src/lib/aiConfig.ts';
import {
	CHAT_FALLBACKS,
	DEFAULT_CHAT_MAX_TOKENS,
	buildChatRequest,
	chatErrorMessage,
	requestChat,
} from '../src/lib/aiChat.ts';
import type { PromptMessage } from '../src/lib/aiChat.ts';
import { ADVICE_MAX_TOKENS } from '../src/lib/draftPrompt.ts';
import type { ChatShape } from '../src/lib/aiProviders.ts';

/**
 * 浏览器直连模型这一层的自检。
 *
 * 这一层是**所有联网 AI 功能共用的那一段**（`draftBoard` 与赛后分析都调它），走错一步的
 * 后果是静默的：请求体的字段名错了会被上游 400、退让顺序错了会把能用的调用直接判死、
 * 失败时给用户的文案错了会让人以为是自己的 key 坏了。所以这里盯三件：
 *
 * 1. `buildChatRequest` 的形状——默认那套必须是最保守的（不发某家专有参数）；
 * 2. `requestChat` 的退让与判死——只有 400 值得退一步重发，401/402/429 与网络错误立刻返回；
 * 3. 与 `draftPrompt` 的默认上限不漂移（两处各写了一个 900）。
 *
 * 跑：`pnpm check`（或 `node --experimental-strip-types scripts/aiChat.check.ts`）。
 */

const messages: PromptMessage[] = [
	{ role: 'system', content: '你是教练' },
	{ role: 'user', content: '这一手怎么走' },
];

/** 请求形状：默认那套与 DeepSeek / OpenAI 那一类各来一份。定义见 `aiProviders`。 */
const DEEPSEEK_SHAPE: ChatShape = { thinking: true, maxTokensField: 'max_tokens', temperature: true };
const STRICT_SHAPE: ChatShape = { thinking: false, maxTokensField: 'max_completion_tokens', temperature: false };

// ---------------------------------------------------------------- 请求体

const request = buildChatRequest({ model: 'deepseek-flash', messages });
assert.equal('thinking' in request, false, '默认形状不发任何一家专有的参数');
assert.deepEqual(request.response_format, { type: 'json_object' }, '默认要求 JSON 输出');
assert.equal(request.model, 'deepseek-flash');
assert.equal(request.max_tokens, 900);
assert.equal(request.temperature, 0.3);
assert.ok(Array.isArray(request.messages) && request.messages.length === 2, '请求里要带上两条消息');

// 显式给了上限就用给的。
assert.equal(buildChatRequest({ model: 'x', messages, maxTokens: 2200 }).max_tokens, 2200, '给了上限就不能退回默认值');

/**
 * 关掉思考这条是实测出来的，不是可选项：默认开着的时候模型把 token 上限全用在
 * `reasoning_tokens` 上，`content` 是空的（900 与 4000 都试过），页面上表现为"点了没结果"。
 */
const deepseekBody = buildChatRequest({ model: 'deepseek-flash', messages, shape: DEEPSEEK_SHAPE });
assert.deepEqual(deepseekBody.thinking, { type: 'disabled' }, 'DeepSeek 必须显式关掉思考');
assert.equal(deepseekBody.max_tokens, 900, 'DeepSeek 的上限仍写在 max_tokens 上');

// OpenAI / Grok 那一类：上限换字段，且不发 temperature（部分推理模型只接受默认值）。
const strictBody = buildChatRequest({ model: 'gpt-x', messages, shape: STRICT_SHAPE });
assert.equal(strictBody.max_completion_tokens, 900, '换了形状要把上限写到 max_completion_tokens 上');
assert.equal('max_tokens' in strictBody, false, '换了字段名就不该再出现 max_tokens');
assert.equal('temperature' in strictBody, false, '不发 temperature 时整个字段不出现');

// 被 400 拒掉时可以退一步：去掉 response_format，其它参数不变。
const withoutJson = buildChatRequest({ model: 'deepseek-flash', messages, jsonMode: false, shape: DEEPSEEK_SHAPE });
assert.equal('response_format' in withoutJson, false, 'jsonMode 为假时不应带 response_format');
assert.deepEqual(withoutJson.thinking, { type: 'disabled' }, '去掉 JSON 模式也要保持关闭思考');

// 两个 900：默认上限（这一层）与「给一手建议」的上限（draftPrompt）是同一个数，别改飘。
assert.equal(DEFAULT_CHAT_MAX_TOKENS, ADVICE_MAX_TOKENS, '默认上限与建议那一路的上限必须一致');
assert.equal(CHAT_FALLBACKS.length, 3, '退让顺序三步：JSON+温度 → 只去 JSON → 再去温度');

// ---------------------------------------------------------------- 发请求

const config = {
	baseUrl: 'https://api.deepseek.com',
	apiKey: 'sk-test',
	model: DEFAULT_AI_MODEL,
	lastCheckedAt: 0,
	lastCheckOk: false,
};

interface Seen {
	url: string;
	body: { response_format?: unknown; temperature?: unknown; max_tokens?: unknown };
	headers: Record<string, string>;
}

function jsonResponse(content: string, status = 200): Response {
	return new Response(JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }] }), {
		status,
		headers: { 'content-type': 'application/json' },
	});
}

/** 记录每次调用；按 `script` 依次返回。`script` 用完后一律返回成功。 */
function fakeFetch(script: (() => Response)[]): { fetchImpl: typeof fetch; calls: Seen[] } {
	const calls: Seen[] = [];
	let index = 0;
	const fetchImpl = (async (input: string, init: RequestInit) => {
		calls.push({
			url: String(input),
			body: JSON.parse(String(init.body)) as Seen['body'],
			headers: (init.headers ?? {}) as Record<string, string>,
		});
		const next = script[index];
		index += 1;
		return next ? next() : jsonResponse('{"ok":true}');
	}) as unknown as typeof fetch;
	return { fetchImpl, calls };
}

{
	// 401：key 不对，换参数重发也一样，必须一次就返回。
	const { fetchImpl, calls } = fakeFetch([() => jsonResponse('unauthorized', 401)]);
	const reply = await requestChat(config, messages, { fetchImpl });
	assert.equal(reply.ok, false);
	assert.equal(calls.length, 1, '401 不该退让重发');
	assert.equal(reply.ok ? 0 : reply.status, 401);
	assert.equal(chatErrorMessage(reply.ok ? { status: 0, text: '' } : reply), 'key 无效或已过期');
}

{
	// 网络/跨域/超时：一次就返回 status 0，且不重发。
	const calls: string[] = [];
	const fetchImpl = (async (input: string) => {
		calls.push(String(input));
		throw new TypeError('Failed to fetch');
	}) as unknown as typeof fetch;
	const reply = await requestChat(config, messages, { fetchImpl });
	assert.equal(reply.ok, false);
	assert.equal(reply.ok ? 0 : reply.status, 0);
	assert.equal(calls.length, 1, '发不出去就不该再试');
	assert.equal(chatErrorMessage(reply.ok ? { status: 0, text: '' } : reply), '请求发不出去：网络、代理，或这家服务没放开跨域');
}

{
	// 400：第一步被拒，去掉 response_format 再来，第二次成功。
	const { fetchImpl, calls } = fakeFetch([() => jsonResponse('bad param', 400)]);
	const reply = await requestChat(config, messages, { maxTokens: 1400, fetchImpl });
	assert.equal(reply.ok, true, '400 之后第二步应当成功');
	assert.equal(calls.length, 2, '400 应当退一步重发一次');
	assert.equal(calls[0]?.url, 'https://api.deepseek.com/chat/completions', '地址按 baseUrl 拼');
	assert.deepEqual(calls[0]?.body.response_format, { type: 'json_object' }, '第一步仍要求 JSON');
	assert.equal('response_format' in (calls[1]?.body ?? {}), false, '第二步去掉 response_format');
	assert.equal(calls[1]?.body.max_tokens, 1400, '退让不该动上限');
	assert.equal(calls[0]?.headers.Authorization, 'Bearer sk-test', '要带上 key');
}

{
	// 三步都被 400：返回最后一次的状态，而不是抛出去。
	const { fetchImpl, calls } = fakeFetch([() => jsonResponse('bad', 400), () => jsonResponse('bad', 400), () => jsonResponse('bad', 400)]);
	const reply = await requestChat(config, messages, { fetchImpl });
	assert.equal(reply.ok, false);
	assert.equal(calls.length, 3, '三步退让都用完');
	assert.equal(reply.ok ? 0 : reply.status, 400);
}

{
	// 成功：读出正文与结束原因。
	const { fetchImpl } = fakeFetch([() => jsonResponse('{"headline":"天辉靠前中期"}')]);
	const reply = await requestChat(config, messages, { fetchImpl });
	assert.ok(reply.ok);
	assert.equal(reply.ok ? reply.content : '', '{"headline":"天辉靠前中期"}');
}

// 失败文案：只对最常见的三种单独说清楚，其余带上状态码与一小段响应。
assert.equal(chatErrorMessage({ status: 402, text: '' }), '余额不足或额度用尽');
assert.equal(chatErrorMessage({ status: 429, text: '' }), '触发限流，稍后再试');
assert.match(chatErrorMessage({ status: 500, text: 'boom' }), /HTTP 500/);

console.log('aiChat 全部断言通过');
