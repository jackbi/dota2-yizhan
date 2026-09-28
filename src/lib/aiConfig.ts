/**
 * 阵容分析用的模型配置。
 *
 * 三条边界写在这里而不是散在各页面：
 * - 配置**只存在这台浏览器**（localStorage），请求由浏览器直接发给用户自己填的地址，
 *   本站不经手、不落库。这也是这个功能能开源的前提：别人 clone 之后用自己的 key。
 * - 旧版本把 key 与模型名塞在 BP 进度那个对象里（`d2s-draft-v1`）。`loadAiConfig` 会把它们
 *   搬过来，老用户不用重填；搬完就不再读旧的，所以「清除 key」不会被迁移复活。
 * - 这里只管配置的形状与读写。提示词与请求体在 `draftPrompt.ts`，网络调用在页面脚本里。
 */
import { AI_PROVIDERS } from './aiProviders.ts';

/** 配置自己的键。与 BP 进度分开，改配置才不会顺带把 BP 进度覆盖掉。 */
export const AI_STORE_KEY = 'd2s-ai-v1';
/** 旧版把 key 与 model 存在这里；只当迁移来源读，不再写。 */
export const LEGACY_STORE_KEY = 'd2s-draft-v1';

/**
 * 默认那一套（地址与模型名）**取自预设表里的 DeepSeek 那条**，不在这里再抄一遍：
 * 抄两遍就得靠自检盯着别漂移，而本来可以只有一个地方写它。
 *
 * 默认地址就是老版本写死的那个，只是现在可以改。请求按 `<baseUrl>/chat/completions`、
 * `<baseUrl>/models` 拼；DeepSeek 这两条都在根路径下，所以默认值不含 `/v1`。
 */
const DEFAULT_PROVIDER = AI_PROVIDERS.find((provider) => provider.id === 'deepseek');
export const DEFAULT_AI_BASE_URL = DEFAULT_PROVIDER?.baseUrl ?? 'https://api.deepseek.com';
export const DEFAULT_AI_MODEL = DEFAULT_PROVIDER?.models?.[0] ?? 'deepseek-flash';

export interface AiConfig {
	baseUrl: string;
	apiKey: string;
	model: string;
	/** 上次「测试连接」的时间戳（毫秒）；0 表示没测过。 */
	lastCheckedAt: number;
	/** 上次测试是否通过。`lastCheckedAt` 为 0 时无意义。 */
	lastCheckOk: boolean;
}

/**
 * 未配置 / 上次失败 / 可用。
 *
 * 「没测过」算可用：配置写对了但没点测试的人，不该被界面当异常对待；这种差别留在文案里说。
 */
export type AiConfigState = 'unset' | 'failed' | 'ready';

/** 只用到读写的这两个方法，抽出来是为了自检脚本能塞一个假存储进来。 */
export interface AiStorage {
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
}

/**
 * 浏览器里的 localStorage。
 *
 * `typeof` 判断是为了让 `scripts/*.check.ts` 能在 Node 里直接 import 这个模块；
 * try 是为了隐私模式下访问它会抛异常的情况。
 */
export function browserStorage(): AiStorage | null {
	try {
		return typeof localStorage === 'undefined' ? null : localStorage;
	} catch {
		return null;
	}
}

export function emptyAiConfig(): AiConfig {
	return { baseUrl: DEFAULT_AI_BASE_URL, apiKey: '', model: DEFAULT_AI_MODEL, lastCheckedAt: 0, lastCheckOk: false };
}

/**
 * 地址规范化：去掉首尾空白与结尾的斜杠；没写协议时补 `https://`。
 *
 * 补协议不是好心，是必须的：`new URL('api.deepseek.com')` 会抛，而下面判断"要不要关思考"
 * 要靠域名。少了这一步，用户手打一个不带协议的地址，DeepSeek 那边就会因为没关思考而返回空内容。
 */
export function normalizeBaseUrl(value: string): string {
	const trimmed = value.trim().replace(/\/+$/, '');
	if (!trimmed) return '';
	return /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

/** 地址是否可用；可用返回 null，否则返回给用户看的一句话。 */
export function validateBaseUrl(value: string): string | null {
	const normalized = normalizeBaseUrl(value);
	if (!normalized) return '请填 API 地址';
	let parsed: URL;
	try {
		parsed = new URL(normalized);
	} catch {
		return '地址格式不对，例：https://api.deepseek.com';
	}
	if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return '地址只支持 http 与 https';
	return null;
}

function text(value: unknown): string {
	return typeof value === 'string' ? value : '';
}

/** 把任意来源（localStorage 里的旧数据、表单）收成一份可用的配置，坏字段各自退回默认值。 */
export function parseAiConfig(raw: unknown): AiConfig {
	const input = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
	const lastCheckedAt =
		typeof input.lastCheckedAt === 'number' && Number.isFinite(input.lastCheckedAt) && input.lastCheckedAt > 0
			? input.lastCheckedAt
			: 0;
	return {
		baseUrl: normalizeBaseUrl(text(input.baseUrl)) || DEFAULT_AI_BASE_URL,
		apiKey: text(input.apiKey).trim(),
		model: text(input.model).trim() || DEFAULT_AI_MODEL,
		lastCheckedAt,
		lastCheckOk: lastCheckedAt > 0 && input.lastCheckOk === true,
	};
}

export function isConfigured(config: AiConfig): boolean {
	return Boolean(config.baseUrl.trim() && config.apiKey.trim() && config.model.trim());
}

export function stateOf(config: AiConfig): AiConfigState {
	if (!isConfigured(config)) return 'unset';
	return config.lastCheckedAt > 0 && !config.lastCheckOk ? 'failed' : 'ready';
}

/** 界面上一句话状态。各页面按需要再往后接「去配置」之类的入口。 */
export function aiStateLabel(config: AiConfig): string {
	const state = stateOf(config);
	if (state === 'unset') return '未配置模型';
	if (state === 'failed') return `已配置 ${config.model}，但上次测试没通过`;
	return config.lastCheckedAt > 0 ? `已配置 ${config.model}` : `已配置 ${config.model}（还没测过连接）`;
}

/** 聊天补全地址。 */
export function endpointOf(config: AiConfig): string {
	return `${normalizeBaseUrl(config.baseUrl)}/chat/completions`;
}

/** 列模型地址，给「测试连接」用。 */
export function modelsEndpointOf(config: AiConfig): string {
	return `${normalizeBaseUrl(config.baseUrl)}/models`;
}

function readJson(storage: AiStorage, key: string): Record<string, unknown> | null {
	try {
		const raw = storage.getItem(key);
		if (!raw) return null;
		const parsed: unknown = JSON.parse(raw);
		return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
	} catch {
		// 手改坏了、或者存的是半截 JSON：当作没有配置，不要让整页挂掉。
		return null;
	}
}

/**
 * 读配置，并在第一次读时把旧版塞在 BP 进度里的 key / 模型名搬过来。
 *
 * 迁移只在**本地还没有这份配置**时发生。所以用户在设置页点过「清除 key」之后，
 * 旧数据不会再被搬回来——那正是一次「我不要了」的表达。
 */
export function loadAiConfig(storage: AiStorage | null = browserStorage()): AiConfig {
	if (!storage) return emptyAiConfig();
	const own = readJson(storage, AI_STORE_KEY);
	if (own) return parseAiConfig(own);

	const legacy = readJson(storage, LEGACY_STORE_KEY);
	if (!legacy) return emptyAiConfig();

	const migrated = parseAiConfig({ baseUrl: DEFAULT_AI_BASE_URL, model: legacy.model, apiKey: legacy.key });
	// 只有真搬到东西才写回：什么都没配过的用户不该凭空多出一份配置。
	if (migrated.apiKey || migrated.model !== DEFAULT_AI_MODEL) saveAiConfig(migrated, storage);
	return migrated;
}

export function saveAiConfig(config: AiConfig, storage: AiStorage | null = browserStorage()): void {
	if (!storage) return;
	try {
		storage.setItem(AI_STORE_KEY, JSON.stringify(config));
	} catch {
		// 隐私模式写不进去，不影响本次会话继续用。
	}
}

/** 清掉 key 与测试结果，保留地址与模型名——下一把 key 通常还是同一家。 */
export function clearAiKey(config: AiConfig): AiConfig {
	return { ...config, apiKey: '', lastCheckedAt: 0, lastCheckOk: false };
}
