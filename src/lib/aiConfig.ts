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
import { AI_PROVIDERS, providerOf } from './aiProviders.ts';

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

/**
 * 两份配置是否**完全**一样，含「上次测试」那两个字段。
 *
 * 判等必须按全部字段来：界面状态就吃 `lastCheckedAt` / `lastCheckOk`——在设置页点一次
 * 「测试连接」再切回 BP 台，只比地址与 key 的话这里会当成"没变化"提前返回，台头仍旧写着
 * 「还没测过连接」。
 */
export function sameAiConfig(a: AiConfig, b: AiConfig): boolean {
	return (
		a.baseUrl === b.baseUrl &&
		a.apiKey === b.apiKey &&
		a.model === b.model &&
		a.lastCheckedAt === b.lastCheckedAt &&
		a.lastCheckOk === b.lastCheckOk
	);
}

/**
 * 决定「发给哪家、用哪个模型、拿什么 key」的那几项是否一样。
 *
 * 与上面分开是因为它管的是另一件事：只要这几项变了，上一份模型建议就是按旧配置问出来的，
 * 不能再挂在面板上（台头写着「未配置模型」、建议面板却还挂着上一个模型的 picks，
 * 正是文档里禁止的"假装有 AI"）。
 */
export function sameAiTarget(a: AiConfig, b: AiConfig): boolean {
	return a.baseUrl === b.baseUrl && a.apiKey === b.apiKey && a.model === b.model;
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
 * 一份存下来的配置：上面那套字段，外加一个 id 与给人看的名字。
 *
 * id 只在本机当键用；label 只给人看——同一个服务商完全可以存两把 key（团队一把、自己一把），
 * 光看地址与模型名分不出谁是谁，所以名字要能自己改。
 */
export interface AiProfile extends AiConfig {
	id: string;
	label: string;
}

/** 存储里放的东西：多份配置 + 当前启用的是哪一份。 */
export interface AiStore {
	/** 当前启用的那份的 id；一份都没有时是空串。 */
	activeId: string;
	profiles: AiProfile[];
}

export function emptyAiStore(): AiStore {
	return { activeId: '', profiles: [] };
}

let idSeq = 0;
/** 本机用的 id。不引 crypto：只要同一个浏览器里不撞就够了。 */
function newProfileId(): string {
	idSeq += 1;
	return `p${Date.now().toString(36)}${idSeq.toString(36)}`;
}

/** 剥掉 id 与名字，只留那套配置字段。判等、发请求、回填表单要的都是它。 */
export function configOf(profile: AiConfig): AiConfig {
	return {
		baseUrl: profile.baseUrl,
		apiKey: profile.apiKey,
		model: profile.model,
		lastCheckedAt: profile.lastCheckedAt,
		lastCheckOk: profile.lastCheckOk,
	};
}

/** 没起名字时给一个：认得出服务商就用它的名字，认不出就用域名。 */
export function defaultProfileLabel(config: AiConfig): string {
	const provider = providerOf(config.baseUrl);
	if (provider) return provider.label;
	try {
		return new URL(normalizeBaseUrl(config.baseUrl)).hostname;
	} catch {
		return '未命名';
	}
}

function parseProfile(raw: unknown, taken: Set<string>): AiProfile {
	const input = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
	const config = parseAiConfig(input);
	let id = text(input.id);
	if (!id || taken.has(id)) id = newProfileId();
	taken.add(id);
	return { ...config, id, label: text(input.label).trim() || defaultProfileLabel(config) };
}

/** 把任意来源收成一份可用的存储：坏字段各自退回默认值，启用的那一个必须真的存在。 */
export function parseAiStore(raw: unknown): AiStore {
	const input = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
	const taken = new Set<string>();
	const profiles = (Array.isArray(input.profiles) ? input.profiles : []).map((item) => parseProfile(item, taken));
	const wanted = text(input.activeId);
	return { activeId: profiles.some((profile) => profile.id === wanted) ? wanted : (profiles[0]?.id ?? ''), profiles };
}

/**
 * 读存储，并把更早的两种单份写法搬成「只有一份的存储」。
 *
 * 两种老形状：这个键里存的**裸对象**（单份配置），以及更早把 key / 模型名塞在 BP 进度里的那次。
 * 迁移都只在本地还没有多份存储时发生，所以用户在设置页删掉过之后，旧数据不会再自己回来——
 * 那正是一次「我不要了」的表达。
 */
export function loadAiStore(storage: AiStorage | null = browserStorage()): AiStore {
	if (!storage) return emptyAiStore();
	const own = readJson(storage, AI_STORE_KEY);
	if (own) {
		// 出现这两个键里的任何一个，都是在往"多份"那个形状上存（哪怕内容坏了），按存储解析。
		if ('profiles' in own || 'activeId' in own) return parseAiStore(own);
		// 单份那份写法：整份当一份配置搬过来，名字按地址推。
		return parseAiStore({ activeId: '', profiles: [own] });
	}

	const legacy = readJson(storage, LEGACY_STORE_KEY);
	if (!legacy) return emptyAiStore();

	const migrated = parseAiConfig({ baseUrl: DEFAULT_AI_BASE_URL, model: legacy.model, apiKey: legacy.key });
	// 只有真搬到东西才写回：什么都没配过的用户不该凭空多出一份配置。
	if (!migrated.apiKey && migrated.model === DEFAULT_AI_MODEL) return emptyAiStore();
	const store = parseAiStore({ activeId: '', profiles: [migrated] });
	saveAiStore(store, storage);
	return store;
}

export function saveAiStore(store: AiStore, storage: AiStorage | null = browserStorage()): void {
	if (!storage) return;
	try {
		storage.setItem(AI_STORE_KEY, JSON.stringify(store));
	} catch {
		// 隐私模式写不进去，不影响本次会话继续用。
	}
}

export function activeProfile(store: AiStore): AiProfile | null {
	return store.profiles.find((profile) => profile.id === store.activeId) ?? null;
}

function profileWith(config: AiConfig, label: string | undefined, id: string): AiProfile {
	const fields = configOf(config);
	return { ...fields, id, label: (label ?? '').trim() || defaultProfileLabel(fields) };
}

/**
 * 新增一份，并**立刻启用**它。
 *
 * 刚填好的那套就是要用的那套——新增完还要再点一次「启用」是多余的一步。想改回原来那份，
 * 列表里点一下「启用」就切回去了。
 */
export function addAiProfile(store: AiStore, config: AiConfig, label?: string): { store: AiStore; profile: AiProfile } {
	const profile = profileWith(config, label, newProfileId());
	return { store: { activeId: profile.id, profiles: [...store.profiles, profile] }, profile };
}

/** 改一份；id 认不出来时当作新增。 */
export function updateAiProfile(store: AiStore, id: string, config: AiConfig, label?: string): AiStore {
	if (!store.profiles.some((profile) => profile.id === id)) return addAiProfile(store, config, label).store;
	return { ...store, profiles: store.profiles.map((item) => (item.id === id ? profileWith(config, label, id) : item)) };
}

export function activateAiProfile(store: AiStore, id: string): AiStore {
	return store.profiles.some((profile) => profile.id === id) ? { ...store, activeId: id } : store;
}

/** 删掉一份。删的正是启用着的那份时，落到剩下的第一份（一份不剩就是没有启用）。 */
export function removeAiProfile(store: AiStore, id: string): AiStore {
	const profiles = store.profiles.filter((profile) => profile.id !== id);
	if (profiles.length === store.profiles.length) return store;
	return { activeId: store.activeId === id ? (profiles[0]?.id ?? '') : store.activeId, profiles };
}

/** 当前启用的那一份；一份都没有时给一份空配置（界面按"未配置"处理）。 */
export function loadAiConfig(storage: AiStorage | null = browserStorage()): AiConfig {
	const active = activeProfile(loadAiStore(storage));
	return active ? configOf(active) : emptyAiConfig();
}

/** 把一套配置写回**当前启用**的那一份；一份都没有时新建并启用。 */
export function saveAiConfig(config: AiConfig, storage: AiStorage | null = browserStorage()): void {
	const store = loadAiStore(storage);
	const active = activeProfile(store);
	saveAiStore(active ? updateAiProfile(store, active.id, config, active.label) : addAiProfile(store, config).store, storage);
}

/** 清掉 key 与测试结果，保留地址与模型名——下一把 key 通常还是同一家。 */
export function clearAiKey(config: AiConfig): AiConfig {
	return { ...config, apiKey: '', lastCheckedAt: 0, lastCheckOk: false };
}
