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
const statusEl = element<HTMLSpanElement>('settings-status');
const detailEl = element<HTMLParagraphElement>('settings-detail');

let config: AiConfig = loadAiConfig();

function setStatus(text: string): void {
	if (statusEl) statusEl.textContent = text;
}

/** 表单里当下这套值；校验不过就返回一句给用户看的话。 */
function readForm(): { config: AiConfig } | { error: string } {
	const baseUrl = normalizeBaseUrl(baseUrlInput?.value ?? '');
	const baseError = validateBaseUrl(baseUrl);
	if (baseError) return { error: baseError };
	const model = (modelInput?.value ?? '').trim();
	if (!model) return { error: '请填模型名' };
	return { config: { ...config, baseUrl, model, apiKey: (keyInput?.value ?? '').trim() } };
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
			headers: { Authorization: `Bearer ${target.apiKey}` },
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

fillForm();
if (!isConfigured(config)) setStatus('还没配置；不配也能用，配置之后才会有模型写的那段解释');
