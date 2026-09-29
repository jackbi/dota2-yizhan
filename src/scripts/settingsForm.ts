import type { AiConfig, AiProfile, AiStore } from '../lib/aiConfig.ts';
import {
	activateAiProfile,
	addAiProfile,
	aiStateLabel,
	clearAiKey,
	configOf,
	emptyAiConfig,
	isConfigured,
	loadAiStore,
	modelsEndpointOf,
	normalizeBaseUrl,
	removeAiProfile,
	saveAiStore,
	updateAiProfile,
	validateBaseUrl,
} from '../lib/aiConfig.ts';
import { AI_PROVIDERS, headersFor, initialProviderId, modelIdsOf } from '../lib/aiProviders.ts';

/**
 * `/settings` 的表单：读写都走 `lib/aiConfig.ts`，这里只管校验、发请求与文案。
 *
 * 三条与别处一致的边界：
 * - **存多份、启用一份**。列表是这台浏览器里那几份配置，阵容分析只读 `activeId` 指的那一份；
 *   新增的那份直接启用（刚填好就是要用的），换一份点它那行的「启用」。
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
const modelOptions = element<HTMLUListElement>('settings-model-options');
const modelToggle = element<HTMLButtonElement>('settings-model-toggle');
const listEl = element<HTMLUListElement>('settings-list');
const emptyEl = element<HTMLParagraphElement>('settings-empty');
const newButton = element<HTMLButtonElement>('settings-new');
const labelInput = element<HTMLInputElement>('settings-label');
const editorTitle = element<HTMLHeadingElement>('settings-editor-title');
const cancelButton = element<HTMLButtonElement>('settings-cancel');

/** 服务商那排按钮。按 `data-provider` 挂钩子，不走 id 对账那一套。 */
const providerChips = [...document.querySelectorAll<HTMLButtonElement>('[data-provider]')];

/*
 * 这台浏览器里存着哪几份配置，以及编辑器正在编哪一份。
 *
 * `editingId` 为空串 = 编辑器里是一份还没存过的新配置。`config` 始终是"编辑器里那套值"的副本：
 * 保存 / 测试 / 清 key 都先落到它上面，再由 `persistConfig` 写回存储。
 */
let store: AiStore = loadAiStore();
let editingId = '';
let config: AiConfig = emptyAiConfig();
/** 列表里哪一行已经被点过一次「删除」；再点一次才真删。 */
let pendingDeleteId = '';
let deleteTimer: ReturnType<typeof setTimeout> | null = null;
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

/** 候选模型名。下拉的展开、上下键与回车都读它。 */
let modelCandidates: string[] = [];
/** 键盘走到第几项；-1 表示还没选。 */
let highlight = -1;

/** 把候选模型名画进下拉。用 DOM 建节点而不是拼 HTML：这些字符串来自服务商的返回。 */
function fillModelOptions(ids: readonly string[]): void {
	modelCandidates = [...ids];
	highlight = -1;
	if (!modelOptions) return;
	modelOptions.replaceChildren(
		...ids.map((id) => {
			const item = document.createElement('li');
			item.setAttribute('role', 'option');
			item.setAttribute('aria-selected', 'false');
			item.dataset.model = id;
			item.className = modelOptionClass(false);
			item.textContent = id;
			return item;
		}),
	);
	if (ids.length === 0) closeModelList();
}

function modelOptionClass(on: boolean): string {
	return on
		? 'cursor-pointer bg-surface-3 px-2 py-1.5 text-xs text-cream'
		: 'cursor-pointer px-2 py-1.5 text-xs text-muted hover:bg-surface-3 hover:text-cream';
}

function isModelListOpen(): boolean {
	return Boolean(modelOptions && modelOptions.style.display !== 'none');
}

/** 键盘高亮第 index 项（-1 = 取消高亮）。 */
function setHighlight(index: number): void {
	if (!modelOptions) return;
	const items = [...modelOptions.children] as HTMLElement[];
	const next = index < 0 || index >= items.length ? -1 : index;
	highlight = next;
	items.forEach((item, i) => {
		item.setAttribute('aria-selected', String(i === next));
		item.className = modelOptionClass(i === next);
	});
	if (next >= 0) items[next]?.scrollIntoView({ block: 'nearest' });
}

/**
 * 展开与收起。
 *
 * 用内联 `display` 而不是 Tailwind 的 hidden 类：类名一加一减要和 `aria-expanded` 两边对齐，
 * 内联只有一个真值来源（`isModelListOpen` 也读它）。没有候选时不开——点开一个空框更让人困惑，
 * 那种情况由下面那句提示说明「手填」。
 */
function openModelList(): void {
	if (!modelOptions || modelCandidates.length === 0) return;
	modelOptions.style.display = '';
	modelInput?.setAttribute('aria-expanded', 'true');
}

function closeModelList(): void {
	if (!modelOptions) return;
	modelOptions.style.display = 'none';
	modelInput?.setAttribute('aria-expanded', 'false');
	setHighlight(-1);
}

/** 选中一个候选：填进输入框、收起来、把焦点还回去。 */
function pickModel(id: string): void {
	if (modelInput) modelInput.value = id;
	closeModelList();
	modelInput?.focus();
	setStatus('');
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
		if (cached.length > 0) modelsState.textContent = `拿到 ${cached.length} 个模型，点右边的箭头就能选`;
		else {
			modelsState.textContent = provider?.models?.length
				? '可以手填；点右边的箭头看内置建议，点「拉取模型列表」会向这家要一份准的。'
				: '这家没内置建议模型名：手填，或者点「拉取模型列表」从它那儿拿。';
		}
	}
}

function renderDetail(): void {
	if (!detailEl) return;
	const parts: string[] = [];
	if (editingId && editingId === store.activeId) parts.push('这一份正在使用');
	parts.push(aiStateLabel(config));
	if (config.lastCheckedAt > 0) {
		const when = new Date(config.lastCheckedAt).toLocaleString('zh-CN');
		parts.push(`上次测试 ${when}：${config.lastCheckOk ? '连接正常' : '没通过'}`);
	}
	detailEl.textContent = parts.join(' · ');
}

/** 回填三个输入框。地址会被规范化，回填是为了让人看见实际存下来的那个值。 */
function fillForm(): void {
	if (baseUrlInput) baseUrlInput.value = config.baseUrl;
	if (keyInput) keyInput.value = config.apiKey;
	if (modelInput) modelInput.value = config.model;
	renderProviders();
	renderDetail();
}

function profileOf(id: string): AiProfile | null {
	return store.profiles.find((profile) => profile.id === id) ?? null;
}

/** 列表上那一行显示的地址。认不出来就原样显示，别编一个。 */
function hostOf(target: AiConfig): string {
	try {
		return new URL(normalizeBaseUrl(target.baseUrl)).hostname;
	} catch {
		return target.baseUrl || '没填地址';
	}
}

function listButton(label: string, act: string): HTMLButtonElement {
	const button = document.createElement('button');
	button.type = 'button';
	button.dataset.act = act;
	button.className = 'filter-chip';
	button.textContent = label;
	return button;
}

/**
 * 画那份"存了哪几份"的列表。
 *
 * 全部用 createElement + textContent：名字是用户自己输的、地址是他填的，拼 HTML 字符串等于
 * 给自己开一个 XSS 口子（和页头 AuthEntry 里那条规矩一样）。
 */
function renderList(): void {
	if (!listEl) return;
	if (emptyEl) emptyEl.style.display = store.profiles.length > 0 ? 'none' : '';

	listEl.replaceChildren(
		...store.profiles.map((profile) => {
			const on = profile.id === store.activeId;
			const item = document.createElement('li');
			item.dataset.profile = profile.id;
			item.className = on
				? 'rounded-xl border border-dota/60 bg-dota/10 p-3'
				: 'rounded-xl border border-line bg-surface-2/60 p-3';

			const head = document.createElement('div');
			head.className = 'flex flex-wrap items-center gap-2';
			const name = document.createElement('span');
			name.className = 'text-sm font-medium text-cream';
			name.textContent = profile.label;
			const badge = document.createElement('span');
			badge.className = on
				? 'rounded-full bg-dota/20 px-2 py-0.5 text-[11px] text-dota-light'
				: 'rounded-full bg-surface-3 px-2 py-0.5 text-[11px] text-faint';
			badge.textContent = on ? '正在使用' : '未启用';
			head.append(name, badge);
			if (profile.id === editingId) {
				const editing = document.createElement('span');
				editing.className = 'text-[11px] text-faint';
				editing.textContent = '正在编辑';
				head.append(editing);
			}

			const meta = document.createElement('p');
			meta.className = 'mt-1 text-xs text-faint';
			meta.textContent = `${isConfigured(profile) ? profile.model : '还没填 key'} · ${hostOf(profile)}`;

			const actions = document.createElement('div');
			actions.className = 'mt-2 flex flex-wrap items-center gap-2';
			if (!on) actions.append(listButton('启用', 'activate'));
			actions.append(listButton('编辑', 'edit'));
			// 删除要点两次，第二次的文案就写在按钮上——比弹一个原生 confirm 更贴这套界面。
			actions.append(listButton(pendingDeleteId === profile.id ? '再点一次删除' : '删除', 'delete'));

			item.append(head, meta, actions);
			return item;
		}),
	);
}

/** 把一份配置装进编辑器；id 为空串 = 新增一份。 */
function openEditor(id: string): void {
	editingId = id;
	const profile = profileOf(id);
	config = profile ? configOf(profile) : emptyAiConfig();
	if (labelInput) labelInput.value = profile?.label ?? '';
	fillForm();
	if (editorTitle) editorTitle.textContent = profile ? `编辑「${profile.label}」` : '新增一份';
	if (saveButton) saveButton.textContent = profile ? '保存这一份' : '新增并启用';
	if (cancelButton) cancelButton.style.display = profile ? '' : 'none';
	renderList();
	setStatus('');
}

/** 把编辑器里这套值写回存储：编辑中写回那一份，新增则加一份并启用它。 */
function persistConfig(next: AiConfig, message: string): void {
	const label = (labelInput?.value ?? '').trim();
	if (editingId && profileOf(editingId)) {
		store = updateAiProfile(store, editingId, next, label);
	} else {
		const added = addAiProfile(store, next, label);
		store = added.store;
		editingId = added.profile.id;
	}
	saveAiStore(store);
	openEditor(editingId);
	setStatus(message);
}

saveButton?.addEventListener('click', () => {
	const read = readForm();
	if ('error' in read) {
		setStatus(read.error);
		return;
	}
	const isNew = !profileOf(editingId);
	const changed =
		read.config.baseUrl !== config.baseUrl || read.config.apiKey !== config.apiKey || read.config.model !== config.model;
	const base = isNew ? '已新增并启用' : '已保存';
	persistConfig(
		// 换了地址、key 或模型，旧的测试结果就对应不上现在这套值了。
		changed ? { ...read.config, lastCheckedAt: 0, lastCheckOk: false } : read.config,
		read.config.apiKey ? base : `${base}；没填 key 时阵容分析仍可用，只是不会有模型解释`,
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
		persistConfig(
			{ ...target, lastCheckedAt: checkedAt, lastCheckOk: response.ok },
			response.ok ? '连接正常，已保存' : `没通过：HTTP ${response.status}（${hint}）`,
		);
	} catch {
		// 跨域被挡也走这里。浏览器直连要求服务商放开 CORS，这一条不是配置能绕过去的，
		// 所以文案里把它和网络问题并列说清楚。
		persistConfig(
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
	persistConfig(clearAiKey(config), '已清除这份的 key');
});

newButton?.addEventListener('click', () => {
	disarmDelete();
	openEditor('');
	labelInput?.focus();
});

// 编辑到一半想退回去：重新装一遍当前启用的那一份（一份都没有就回到"新增"）。
cancelButton?.addEventListener('click', () => {
	disarmDelete();
	openEditor(store.activeId);
});

function disarmDelete(): void {
	pendingDeleteId = '';
	if (deleteTimer) clearTimeout(deleteTimer);
	deleteTimer = null;
}

/*
 * 列表上的三个动作。
 *
 * 事件挂在列表容器上而不是每一行上：行是每次重画时新建的，逐行挂监听等于每画一次就漏一堆
 * 旧节点；委托给容器只需要挂一次（和页头那个渲染登录态的脚本是同一条思路）。
 */
listEl?.addEventListener('click', (event) => {
	const button = (event.target as HTMLElement | null)?.closest<HTMLElement>('[data-act]');
	const id = button?.closest<HTMLElement>('[data-profile]')?.dataset.profile;
	const act = button?.dataset.act;
	if (!id || !act) return;

	if (act === 'activate') {
		disarmDelete();
		store = activateAiProfile(store, id);
		saveAiStore(store);
		renderList();
		setStatus(`已启用「${profileOf(id)?.label ?? '这一份'}」，阵容分析接下来用它`);
		return;
	}

	if (act === 'edit') {
		disarmDelete();
		openEditor(id);
		return;
	}

	/*
	 * 删除要点两次：key 只存在这台浏览器里，删掉就真没了，而这一行的按钮和「编辑」挨着。
	 * 第一次点只是把按钮文案换成「再点一次删除」，四秒没下文就自己复原。
	 */
	if (pendingDeleteId !== id) {
		pendingDeleteId = id;
		if (deleteTimer) clearTimeout(deleteTimer);
		deleteTimer = setTimeout(() => {
			disarmDelete();
			renderList();
		}, 4000);
		renderList();
		setStatus('再点一次「删除」才会真的删掉');
		return;
	}

	const label = profileOf(id)?.label ?? '这一份';
	disarmDelete();
	store = removeAiProfile(store, id);
	saveAiStore(store);
	// 删掉的正是编辑器里那一份：退回到当前启用的那份，别让「保存」写到一个已经没了的 id 上。
	if (editingId === id) openEditor(store.activeId);
	renderList();
	setStatus(`已删除「${label}」`);
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
		/*
		 * 名字同样只在"没起过名"或"还是别家的名字"时才跟着换：与模型名一个道理，
		 * 用户自己起的名字比预设更可信（"公司那把"被改成"OpenAI"是最容易被骂回来的一种聪明）。
		 */
		const currentLabel = (labelInput?.value ?? '').trim();
		const genericLabel = currentLabel === '' || AI_PROVIDERS.some((item) => item.label === currentLabel);
		if (labelInput && genericLabel) labelInput.value = provider.label;
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
		if (modelsState) modelsState.textContent = `拿到 ${ids.length} 个模型，点右边的箭头就能选`;
		// 拉完就展开：这一步的意图本来就是挑一个，让用户再点一次箭头是多余的。
		openModelList();
	} catch {
		if (modelsState) modelsState.textContent = '拉取失败：网络、跨域或超时；手填模型名也行';
	} finally {
		if (modelsButton) modelsButton.disabled = false;
	}
}

modelsButton?.addEventListener('click', () => {
	void fetchModels();
});

/*
 * 模型候选那个自绘下拉：点开、键选、点到别处收起。
 *
 * 「收起」这一条是自绘才有的责任：弹层是 absolute 浮在表单上的，不收就会一直挡着下面的
 * 地址与 key。原生 datalist 由浏览器负责收，所以这一段是换掉它之后必须补上的。
 */
modelToggle?.addEventListener('click', () => {
	if (isModelListOpen()) closeModelList();
	else openModelList();
});

// 点输入框也展开：手填的人多半是想先看看这家有什么可选。
modelInput?.addEventListener('click', () => {
	openModelList();
});

modelInput?.addEventListener('keydown', (event) => {
	if (event.key === 'Escape') {
		closeModelList();
		return;
	}
	if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
		if (!isModelListOpen()) openModelList();
		if (modelCandidates.length === 0) return;
		event.preventDefault();
		const down = event.key === 'ArrowDown';
		const next = highlight < 0 ? (down ? 0 : modelCandidates.length - 1) : highlight + (down ? 1 : -1);
		setHighlight((next + modelCandidates.length) % modelCandidates.length);
		return;
	}
	if (event.key === 'Enter' && isModelListOpen() && highlight >= 0) {
		event.preventDefault();
		pickModel(modelCandidates[highlight]);
	}
});

/*
 * 选项按下时先挡住默认行为：不挡的话输入框会立刻失焦，列表在 click 之前就被收掉，
 * 点起来像点空了（原生 datalist 没有这个问题，这份也是换掉它之后才有的）。
 */
modelOptions?.addEventListener('mousedown', (event) => {
	event.preventDefault();
});

modelOptions?.addEventListener('click', (event) => {
	const item = (event.target as HTMLElement | null)?.closest<HTMLElement>('[data-model]');
	if (item?.dataset.model) pickModel(item.dataset.model);
});

document.addEventListener('click', (event) => {
	if (!isModelListOpen()) return;
	const target = event.target as Node | null;
	const inside = Boolean(target && (modelInput?.contains(target) || modelToggle?.contains(target) || modelOptions?.contains(target)));
	if (!inside) closeModelList();
});

openEditor(store.activeId);
if (store.profiles.length === 0) setStatus('还没有配置；不配也能用，配好之后才会有模型写的那段解释');
