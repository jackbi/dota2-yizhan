import type { AiConfig } from '../lib/aiConfig.ts';
import {
	aiStateLabel,
	clearAiKey,
	isConfigured,
	loadAiConfig,
	modelsEndpointOf,
	normalizeBaseUrl,
	saveAiConfig,
	validateBaseUrl,
} from '../lib/aiConfig.ts';
import { AI_PROVIDERS, headersFor, initialProviderId, modelIdsOf } from '../lib/aiProviders.ts';

/**
 * `/settings` 的表单：读写都走 `lib/aiConfig.ts`，这里只管校验、发请求与文案。
 *
 * 两条与别处一致的边界：
 * - **测试连接也是保存**。测的就是表单里现在这套值；不把结果落库的话，BP 台没法显示
 *   「已配但还是连不上」，用户下次还得回来重测一遍才知道。
 * - 地址 / key / 模型**任意一项变了，上次的测试结果就作废**。留着它只会让状态栏说假话。
 */

function element<T extends HTMLElement>(id: string): T | null {
	return document.getElementById(id) as T | null;
}

/**
 * 测试连接的超时。
 *
 * 没有它的话，地址填成一个黑洞（比如打错的域名、只在内网可达的地址），按钮会永远停在
 * 「测试中…」——用户既得不到结论，也不知道是自己填错了。判定「连不上」比「永远在连」有用。
 */
const TEST_TIMEOUT_MS = 20_000;

const baseUrlInput = element<HTMLInputElement>('settings-base-url');
const keyInput = element<HTMLInputElement>('settings-key');
const modelInput = element<HTMLInputElement>('settings-model');
const saveButton = element<HTMLButtonElement>('settings-save');
const testButton = element<HTMLButtonElement>('settings-test');
const clearButton = element<HTMLButtonElement>('settings-clear');
const modelsButton = element<HTMLButtonElement>('settings-models');
const statusEl = element<HTMLSpanElement>('settings-status');
const detailEl = element<HTMLParagraphElement>('settings-detail');
const providerHint = element<HTMLParagraphElement>('settings-provider-hint');
const modelsState = element<HTMLSpanElement>('settings-models-state');
const modelOptions = element<HTMLDataListElement>('settings-model-options');

/** 服务商那排按钮。按 `data-provider` 挂钩子，不走 id 对账那一套。 */
const providerChips = [...document.querySelectorAll<HTMLButtonElement>('[data-provider]')];

let config: AiConfig = loadAiConfig();
/**
 * 上一次「拉取模型列表」的结果，以及它是给哪个地址拉的。
 *
 * 记下地址是为了让它能被重画：保存、测试连接、清 key 都会重画那一块，如果每次都回落到内置的
 * 一两个建议值，用户拉完列表再点保存就白拉了，换第二个模型还得再打一次 `/models`。
 */
let fetchedModels: string[] = [];
let fetchedFor = '';

function setStatus(text: string): void {
	if (statusEl) statusEl.textContent = text;
}

/** 表单里当下这套值；校验不过就返回一句给用户看的话。拉模型列表时不要求先填模型名。 */
function readForm(options: { requireModel?: boolean } = {}): { config: AiConfig } | { error: string } {
	const baseUrl = normalizeBaseUrl(baseUrlInput?.value ?? '');
	const baseError = validateBaseUrl(baseUrl);
	if (baseError) return { error: baseError };
	const model = (modelInput?.value ?? '').trim();
	if (options.requireModel !== false && !model) return { error: '请填模型名' };
	return { config: { ...config, baseUrl, model, apiKey: (keyInput?.value ?? '').trim() } };
}

/** 当前地址对应哪一家预设。地址手改之后按地址重认，不记「上次点过谁」。 */
function currentProviderId(): string {
	return initialProviderId(normalizeBaseUrl(baseUrlInput?.value ?? ''));
}

/** 把候选模型名写进 datalist。用 DOM 建节点而不是拼 HTML：这些字符串来自服务商的返回。 */
function fillModelOptions(ids: readonly string[]): void {
	if (!modelOptions) return;
	modelOptions.replaceChildren(
		...ids.map((id) => {
			const option = document.createElement('option');
			option.value = id;
			return option;
		}),
	);
}

/** 把「用哪一家」那排按钮、提示与模型候选摆到与当前地址一致的位置。 */
function renderProviders(): void {
	const id = currentProviderId();
	for (const chip of providerChips) chip.setAttribute('aria-pressed', String(chip.dataset.provider === id));
	const provider = AI_PROVIDERS.find((item) => item.id === id);
	if (providerHint) providerHint.textContent = provider?.hint ?? '';
	// 拉过的那份比内置建议准，优先用它；换了地址就作废（那份列表属于上一家）。
	const cached = fetchedFor && fetchedFor === normalizeBaseUrl(baseUrlInput?.value ?? '') ? fetchedModels : [];
	fillModelOptions(cached.length > 0 ? cached : provider?.models ?? []);
	if (modelsState) {
		if (cached.length > 0) modelsState.textContent = `拿到 ${cached.length} 个模型，点输入框就能选`;
		else {
			modelsState.textContent = provider?.models?.length
				? '可以手填；点「拉取模型列表」会向这家要一份准的。'
				: '这家没内置建议模型名：手填，或者点「拉取模型列表」从它那儿拿。';
		}
	}
}

function renderDetail(): void {
	if (!detailEl) return;
	const parts = [`当前：${aiStateLabel(config)}`];
	if (config.lastCheckedAt > 0) {
		const when = new Date(config.lastCheckedAt).toLocaleString('zh-CN');
		parts.push(`上次测试 ${when}：${config.lastCheckOk ? '连接正常' : '没通过'}`);
	}
	detailEl.textContent = parts.join(' · ');
}

/** 回填表单。地址会被规范化，回填是为了让人看见实际存下来的那个值。 */
function fillForm(): void {
	if (baseUrlInput) baseUrlInput.value = config.baseUrl;
	if (keyInput) keyInput.value = config.apiKey;
	if (modelInput) modelInput.value = config.model;
	renderProviders();
	renderDetail();
}

function persist(next: AiConfig, message: string): void {
	config = next;
	saveAiConfig(config);
	fillForm();
	setStatus(message);
}

saveButton?.addEventListener('click', () => {
	const read = readForm();
	if ('error' in read) {
		setStatus(read.error);
		return;
	}
	const changed =
		read.config.baseUrl !== config.baseUrl || read.config.apiKey !== config.apiKey || read.config.model !== config.model;
	persist(
		// 换了地址、key 或模型，旧的测试结果就对应不上现在这套值了。
		changed ? { ...read.config, lastCheckedAt: 0, lastCheckOk: false } : read.config,
		read.config.apiKey ? '已保存' : '已保存；没填 key 时阵容分析仍可用，只是不会有模型解释',
	);
});

async function testConnection(): Promise<void> {
	const read = readForm();
	if ('error' in read) {
		setStatus(read.error);
		return;
	}
	const target = read.config;
	if (!target.apiKey) {
		setStatus('先填 key 再测');
		keyInput?.focus();
		return;
	}
	setStatus('测试中…');
	if (testButton) testButton.disabled = true;
	const checkedAt = Date.now();
	try {
		const response = await fetch(modelsEndpointOf(target), {
			// 与拉模型列表走同一套头：Anthropic 那边少了它就会被跨域拦掉，
			// 而实际对话请求是带上的——两处不一致会出现「测试不过但能用」这种最费解的反馈。
			headers: headersFor(target.baseUrl, target.apiKey),
			signal: AbortSignal.timeout(TEST_TIMEOUT_MS),
		});
		const hint =
			response.status === 401
				? 'key 不对或没有权限'
				: response.status === 404
					? '地址可能不对：检查是否少了一段路径'
					: '看看服务商那边的额度与限流';
		persist(
			{ ...target, lastCheckedAt: checkedAt, lastCheckOk: response.ok },
			response.ok ? '连接正常，已保存' : `没通过：HTTP ${response.status}（${hint}）`,
		);
	} catch {
		// 跨域被挡也走这里。浏览器直连要求服务商放开 CORS，这一条不是配置能绕过去的，
		// 所以文案里把它和网络问题并列说清楚。
		persist(
			{ ...target, lastCheckedAt: checkedAt, lastCheckOk: false },
			'请求发不出去：地址不通、网络/代理问题，或这家服务没放开跨域',
		);
	} finally {
		if (testButton) testButton.disabled = false;
	}
}

testButton?.addEventListener('click', () => {
	void testConnection();
});

clearButton?.addEventListener('click', () => {
	// 只清 key 与测试结果，地址与模型名留着——下一把 key 通常还是同一家。
	persist(clearAiKey(config), '已清除 key');
});

/**
 * 点一家服务商：把地址（与建议模型）填好。
 *
 * 它只改表单，不碰已保存的配置——想生效还是要按「保存」。好处是挨个点着看地址也安全。
 */
for (const chip of providerChips) {
	chip.addEventListener('click', () => {
		const provider = AI_PROVIDERS.find((item) => item.id === chip.dataset.provider);
		if (!provider) return;
		if (baseUrlInput) baseUrlInput.value = provider.baseUrl;
		/*
		 * 模型名只在「空着」或「还是别家的建议值」时才被覆盖：用户手打过的那一串比预设更可信，
		 * 换个服务商就把它抹掉是最容易挨骂的一种"聪明"。
		 */
		const current = (modelInput?.value ?? '').trim();
		const knownDefault = AI_PROVIDERS.some((item) => item.models?.includes(current));
		if (modelInput && provider.models?.[0] && (!current || knownDefault)) modelInput.value = provider.models[0];
		renderProviders();
		setStatus('');
	});
}

/*
 * 手打地址也要重认服务商。不监听的话，输入框里换了域名，那排按钮和提示还停在上一家——
 * 而 Ollama 与 Cloudflare 的注意事项只写在提示里，那两家恰恰是最需要看见提示的。
 */
baseUrlInput?.addEventListener('input', () => {
	renderProviders();
});

/** 向服务商要一份模型列表，塞进下拉候选。拿不到也不影响手填。 */
async function fetchModels(): Promise<void> {
	const read = readForm({ requireModel: false });
	if ('error' in read) {
		setStatus(read.error);
		return;
	}
	const target = read.config;
	if (!target.apiKey) {
		setStatus('先填 key 再拉模型列表');
		keyInput?.focus();
		return;
	}
	if (modelsState) modelsState.textContent = '拉取中…';
	if (modelsButton) modelsButton.disabled = true;
	try {
		const response = await fetch(modelsEndpointOf(target), {
			headers: headersFor(target.baseUrl, target.apiKey),
			signal: AbortSignal.timeout(TEST_TIMEOUT_MS),
		});
		if (!response.ok) {
			if (modelsState) modelsState.textContent = `拿不到列表（HTTP ${response.status}），手填模型名也行`;
			return;
		}
		const ids = modelIdsOf(await response.json().catch(() => null));
		if (ids.length === 0) {
			if (modelsState) modelsState.textContent = '这家没返回可用的模型名，手填吧';
			return;
		}
		fetchedModels = ids;
		fetchedFor = target.baseUrl;
		fillModelOptions(ids);
		if (modelsState) modelsState.textContent = `拿到 ${ids.length} 个模型，点输入框就能选`;
	} catch {
		if (modelsState) modelsState.textContent = '拉取失败：网络、跨域或超时；手填模型名也行';
	} finally {
		if (modelsButton) modelsButton.disabled = false;
	}
}

modelsButton?.addEventListener('click', () => {
	void fetchModels();
});

fillForm();
if (!isConfigured(config)) setStatus('还没配置；不配也能用，配置之后才会有模型写的那段解释');
