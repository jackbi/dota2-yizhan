/**
 * 服务商预设。
 *
 * 这一张表里的地址与「浏览器直连能不能成立」都是**实测**来的（2026-09-28），不是照抄文档：
 *
 * - 地址：用无效 key 打各家的 `/models`，401/400 说明路径存在，404 就是错的（OpenRouter 与
 *   魔搭的 `/models` 是公开的，直接 200）；
 * - 跨域：发 OPTIONS 预检，看回不回 `Access-Control-Allow-Origin` 与放不放行 `authorization`。
 *   这一条是本站的硬门槛：请求从浏览器直接发出，服务商不放行就只能自建代理；
 * - 参数差异：以 linshenkx/prompt-optimizer 的适配器为准（它把各家的上限字段与思考开关分了家）。
 *
 * Chrome 内置模型（Gemini Nano）**不在这张表里**：它没有 HTTP 端点，走的是浏览器里的
 * `LanguageModel`，与本站「填一个地址直接发请求」的结构接不上。想接它得另写一条调用路径。
 */

/**
 * 请求形状：各服务商认的字段不一样，把差异收成三个开关。
 *
 * 默认那套是**最保守**的：只发 OpenAI 兼容的基础字段，不发任何一家专有的东西——专有字段
 * 正是最容易被别家当未知参数拒掉的。具体谁用哪套见下面 `AI_PROVIDERS` 的表（值有实测依据）。
 *
 * 定义放在这一层而不是 `draftPrompt`：它是「按地址决定请求长什么样」的一部分，与预设表同源；
 * 组装请求体的是 `aiChat.buildChatRequest`。
 */
export interface ChatShape {
	/** 要不要发 DeepSeek 那套 `thinking: { type: 'disabled' }`。 */
	thinking: boolean;
	/** 输出上限写在哪个字段上。OpenAI 与 Grok 的新模型已经不认 `max_tokens`。 */
	maxTokensField: 'max_tokens' | 'max_completion_tokens';
	/** 发不发 `temperature`。部分推理模型只接受默认值，传了会被 400 拒掉。 */
	temperature: boolean;
}

export const DEFAULT_CHAT_SHAPE: ChatShape = { thinking: false, maxTokensField: 'max_tokens', temperature: true };

export interface AiProvider {
	id: string;
	label: string;
	/** 认领用的域名，用来判断用户填的地址属于哪一家（自定义地址认不出来时就按默认形状走）。 */
	host: string;
	/** 预设地址。空串表示要用户自己填（自定义）。 */
	baseUrl: string;
	/** 建议模型名；能拉到模型列表时就以列表为准。 */
	models?: readonly string[];
	/** 需要在请求里额外带的东西（比如 Anthropic 那个跨域开关头）。 */
	headers?: Record<string, string>;
	/** 与默认形状不同的地方，见 `ChatShape`。 */
	shape?: Partial<ChatShape>;
	/** 界面上给用户看的一句提醒。 */
	hint?: string;
}

export const AI_PROVIDERS: readonly AiProvider[] = [
	{
		id: 'deepseek',
		label: 'DeepSeek',
		host: 'api.deepseek.com',
		baseUrl: 'https://api.deepseek.com',
		// 与 `aiConfig.DEFAULT_AI_MODEL` 保持一致（`aiProviders.check` 会把两处钉在一起）：
		// 这两个名字是本站一直在用的，没验证过的名字不往上加。
		models: ['deepseek-flash', 'deepseek-v4-pro'],
		// 独占一条：`thinking: { type: 'disabled' }` 是 DeepSeek 的口径，不关掉就只出思考不出正文。
		shape: { thinking: true },
	},
	{
		id: 'openai',
		label: 'OpenAI',
		host: 'api.openai.com',
		baseUrl: 'https://api.openai.com/v1',
		models: ['gpt-5.6-terra', 'gpt-5.6-luna'],
		// 新模型的 `max_tokens` 已废弃（参考项目里标着 Deprecated），上限走 max_completion_tokens。
		shape: { maxTokensField: 'max_completion_tokens' },
	},
	{
		id: 'gemini',
		label: 'Google Gemini',
		host: 'generativelanguage.googleapis.com',
		baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
		models: ['gemini-3.8-flash', 'gemini-3.1-pro-preview'],
		hint: '走 Google 的 OpenAI 兼容入口（地址末尾那段 /openai 不要删）。',
	},
	{
		id: 'anthropic',
		label: 'Anthropic',
		host: 'api.anthropic.com',
		baseUrl: 'https://api.anthropic.com/v1',
		models: ['claude-sonnet-5', 'claude-haiku-4-5-20251001'],
		headers: { 'anthropic-dangerous-direct-browser-access': 'true' },
		hint: '走它的 OpenAI 兼容入口。浏览器直连必须带一个专门的头部，实测不带会被跨域拦掉——本站自动带上，你不用管。',
	},
	{
		id: 'openrouter',
		label: 'OpenRouter',
		host: 'openrouter.ai',
		baseUrl: 'https://openrouter.ai/api/v1',
		hint: '一个 key 通很多家模型；模型名要写它那边的全称（如 deepseek/deepseek-chat）。',
	},
	{
		id: 'dashscope',
		label: 'DashScope（阿里云百炼）',
		host: 'dashscope.aliyuncs.com',
		baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
		models: ['qwen3.8-max', 'qwen3.8-flash'],
	},
	{
		id: 'zhipu',
		label: '智谱',
		host: 'open.bigmodel.cn',
		baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
		models: ['glm-5.3', 'glm-5.3-flash'],
	},
	{
		id: 'siliconflow',
		label: '硅基流动',
		host: 'api.siliconflow.cn',
		baseUrl: 'https://api.siliconflow.cn/v1',
		models: ['deepseek-ai/DeepSeek-V3', 'Qwen/Qwen3-8B'],
	},
	{
		id: 'minimax',
		label: 'MiniMax（国际站）',
		host: 'api.minimax.io',
		baseUrl: 'https://api.minimax.io/v1',
		models: ['MiniMax-M3', 'MiniMax-M2.7'],
		hint: '国内账号用下面那个国内站地址。',
	},
	{
		id: 'minimax-cn',
		label: 'MiniMax（国内站）',
		host: 'api.minimaxi.com',
		baseUrl: 'https://api.minimaxi.com/v1',
		models: ['MiniMax-M3', 'MiniMax-M2.7'],
	},
	{
		id: 'modelscope',
		label: '魔搭 ModelScope',
		host: 'api-inference.modelscope.cn',
		baseUrl: 'https://api-inference.modelscope.cn/v1',
		hint: '模型名用魔搭上的全称，例如 Qwen/Qwen3-8B。',
	},
	{
		id: 'grok',
		label: 'Grok',
		host: 'api.x.ai',
		baseUrl: 'https://api.x.ai/v1',
		models: ['grok-4.6'],
		shape: { maxTokensField: 'max_completion_tokens' },
	},
	{
		id: 'xiaomi-mimo',
		label: '小米 MiMo',
		host: 'token-plan-cn.xiaomimimo.com',
		baseUrl: 'https://token-plan-cn.xiaomimimo.com/v1',
		models: ['mimo-v2.5-pro', 'mimo-v2.5'],
	},
	{
		id: 'ollama',
		label: 'Ollama（本地）',
		host: 'localhost',
		baseUrl: 'http://localhost:11434/v1',
		hint: '本地服务：要先在 Ollama 那边放开跨域（环境变量 OLLAMA_ORIGINS 带上本站域名），否则浏览器会被拦；端口按你实际的改。',
	},
	{
		id: 'cloudflare',
		label: 'Cloudflare Workers AI',
		host: 'api.cloudflare.com',
		baseUrl: 'https://api.cloudflare.com/client/v4/accounts/{accountId}/ai/v1',
		hint: '地址里的 {accountId} 要换成你的账号 id（实测它的 /models 不接受 GET，所以「测试连接」会报 405，那不代表配错）。',
	},
	{
		id: 'custom',
		label: 'OpenAI 兼容（自定义）',
		host: '',
		baseUrl: '',
		hint: '任何 OpenAI 兼容服务：地址填到版本段为止，请求会拼成「地址 + /chat/completions」。',
	},
];

/** 找这个地址属于哪一家预设；认不出来（自建、中转）返回 null。 */
export function providerOf(baseUrl: string): AiProvider | null {
	let hostname: string;
	try {
		hostname = new URL(baseUrl).hostname.toLowerCase();
	} catch {
		return null;
	}
	return (
		AI_PROVIDERS.find((provider) => provider.host && (hostname === provider.host || hostname.endsWith(`.${provider.host}`))) ?? null
	);
}

/**
 * 这个地址该用哪套请求形状。
 *
 * 认不出来的地址一律按最保守的一套：只发 OpenAI 兼容的基础字段（`max_tokens` + `temperature`），
 * **不发** `thinking` 这类某一家专有的东西——那正是最容易被别家当未知参数拒掉的。
 */
export function shapeFor(baseUrl: string): ChatShape {
	const provider = providerOf(baseUrl);
	return { ...DEFAULT_CHAT_SHAPE, ...(provider?.shape ?? {}) };
}

/** 请求头。各家的额外头（目前只有 Anthropic）在这里统一加上。 */
export function headersFor(baseUrl: string, apiKey: string): Record<string, string> {
	const provider = providerOf(baseUrl);
	return { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}`, ...(provider?.headers ?? {}) };
}

/** 界面上初始选中的是哪一家：按当前地址倒推，认不出来就落到「自定义」。 */
export function initialProviderId(baseUrl: string): string {
	return providerOf(baseUrl)?.id ?? 'custom';
}

/**
 * 从各家 `/models` 的返回里挖出模型名。
 *
 * 形状不止一种，都是实测看到的：OpenAI 那一派是 `data[].id`，Cloudflare 是 `result[].name`，
 * Ollama 的原生接口是 `models[].name`。认不出来的形状返回空数组——调用方据此提示「手填也行」，
 * 而不是把半截数据塞进下拉里。
 */
export function modelIdsOf(payload: unknown): string[] {
	const record = (payload ?? {}) as { data?: unknown; result?: unknown; models?: unknown };
	const list = Array.isArray(record.data)
		? record.data
		: Array.isArray(record.result)
			? record.result
			: Array.isArray(record.models)
				? record.models
				: [];
	const ids: string[] = [];
	for (const row of list) {
		if (typeof row === 'string') {
			ids.push(row);
			continue;
		}
		const entry = (row ?? {}) as { id?: unknown; name?: unknown; model?: unknown };
		for (const value of [entry.id, entry.name, entry.model]) {
			if (typeof value === 'string' && value.trim()) {
				ids.push(value.trim());
				break;
			}
		}
	}
	return [...new Set(ids)];
}
