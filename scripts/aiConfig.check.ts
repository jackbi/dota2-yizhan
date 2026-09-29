import assert from 'node:assert/strict';
import {
	AI_STORE_KEY,
	DEFAULT_AI_BASE_URL,
	DEFAULT_AI_MODEL,
	LEGACY_STORE_KEY,
	activateAiProfile,
	activeProfile,
	addAiProfile,
	aiStateLabel,
	clearAiKey,
	emptyAiStore,
	emptyAiConfig,
	endpointOf,
	isConfigured,
	loadAiConfig,
	loadAiStore,
	modelsEndpointOf,
	normalizeBaseUrl,
	parseAiConfig,
	parseAiStore,
	removeAiProfile,
	sameAiConfig,
	sameAiTarget,
	saveAiConfig,
	saveAiStore,
	stateOf,
	updateAiProfile,
	validateBaseUrl,
} from '../src/lib/aiConfig.ts';
import type { AiStorage } from '../src/lib/aiConfig.ts';

/**
 * 模型配置的自检。
 *
 * 盯的是三类会**静默**出错的地方：
 *
 * 1. **迁移**：老用户的 key 存在 BP 进度那个对象里，搬不干净他们会以为 key 丢了；
 *    而搬得太勤又会把「清除 key」变成没用——下次刷新 key 自己回来了。
 * 2. **地址拼接**：少一段或多一道斜杠就是 404，而界面只会说「连不上」。
 * 3. **按服务商决定参数**：`thinking` 只有 DeepSeek 认，发给别家会被 400 拒掉。
 *
 * 跑：`pnpm check`（或 `node --experimental-strip-types scripts/aiConfig.check.ts`）。
 */

/** 一个够用的假存储，把迁移与读写往返放进 Node 里跑。 */
function fakeStorage(initial: Record<string, string> = {}): AiStorage {
	const data = { ...initial };
	return {
		getItem: (key) => (Object.hasOwn(data, key) ? (data[key] ?? null) : null),
		setItem: (key, value) => {
			data[key] = value;
		},
	};
}

/** 取假存储里写下的原始字符串。 */
function rawOf(storage: AiStorage, key: string): string | null {
	return storage.getItem(key);
}

// ---------------------------------------------------------------- 地址

assert.equal(normalizeBaseUrl('  '), '', '空串应当保持空串，交给校验去喊');
assert.equal(normalizeBaseUrl('api.deepseek.com/'), 'https://api.deepseek.com', '没写协议要补 https，并去掉结尾斜杠');
assert.equal(normalizeBaseUrl('https://api.openai.com/v1/'), 'https://api.openai.com/v1', '结尾斜杠要去掉');
assert.equal(normalizeBaseUrl('http://localhost:11434/v1'), 'http://localhost:11434/v1', '本地地址不该被改写');

assert.equal(validateBaseUrl(DEFAULT_AI_BASE_URL), null, '默认地址必须是可用的');
assert.equal(validateBaseUrl('api.deepseek.com'), null, '手打不带协议也认');
assert.ok(validateBaseUrl(''), '空地址要被拦住');
assert.ok(validateBaseUrl('   '), '只有空白也要被拦住');
assert.ok(validateBaseUrl('ftp://example.com'), '非 http(s) 要被拦住');

// ---------------------------------------------------------------- 端点拼接

const deepseek = parseAiConfig({ baseUrl: DEFAULT_AI_BASE_URL, apiKey: 'sk-x', model: DEFAULT_AI_MODEL });
assert.equal(endpointOf(deepseek), 'https://api.deepseek.com/chat/completions', '默认地址要拼出老版本那个端点');
assert.equal(modelsEndpointOf(deepseek), 'https://api.deepseek.com/models', '老版本测试连接的地址也不能变');

const openai = parseAiConfig({ baseUrl: 'https://api.openai.com/v1/', apiKey: 'sk-x', model: 'gpt-x' });
assert.equal(endpointOf(openai), 'https://api.openai.com/v1/chat/completions', '带版本段的地址要拼对');
assert.equal(modelsEndpointOf(openai), 'https://api.openai.com/v1/models');

// ---------------------------------------------------------------- 容错

assert.deepEqual(parseAiConfig(null).apiKey, '', '空配置不该抛');
assert.deepEqual(parseAiConfig('nonsense'), parseAiConfig({}), '半截数据要退回默认值');
assert.equal(parseAiConfig({ apiKey: 123 }).apiKey, '', '类型不对就当没填');
assert.equal(parseAiConfig({}).model, DEFAULT_AI_MODEL, '没写模型名时给默认值');
assert.equal(parseAiConfig({ lastCheckedAt: -5 }).lastCheckedAt, 0, '负数时间戳按「没测过」处理');
assert.equal(parseAiConfig({ lastCheckedAt: 1, lastCheckOk: 'yes' }).lastCheckOk, false, '非布尔的成功标记不算数');

// ---------------------------------------------------------------- 三态

assert.equal(stateOf(parseAiConfig({})), 'unset', '没有 key 就是未配置');
assert.equal(stateOf(parseAiConfig({ apiKey: 'sk-x' })), 'ready', '有 key 且没测过，算可用');
assert.equal(
	stateOf(parseAiConfig({ apiKey: 'sk-x', lastCheckedAt: 1, lastCheckOk: false })),
	'failed',
	'测过且失败要单独成一态',
);
assert.equal(
	stateOf(parseAiConfig({ apiKey: 'sk-x', lastCheckedAt: 1, lastCheckOk: true })),
	'ready',
	'测过且成功',
);
// 只有空白不该算填过：不然界面上会出现「已配置」，点下去却发不出请求。
// 读存储时空白模型名会被补成默认值，所以这种「半配」只可能来自表单，而表单自己会拦住。
assert.equal(isConfigured({ ...emptyAiConfig(), apiKey: '   ' }), false, '空白 key 不算配置');
assert.equal(isConfigured({ ...emptyAiConfig(), apiKey: 'sk-x', model: ' ' }), false, '空白模型名不算配置');
assert.equal(parseAiConfig({ apiKey: 'sk-x', model: '  ' }).model, DEFAULT_AI_MODEL, '存储里的空模型名补默认值');
assert.match(aiStateLabel(parseAiConfig({})), /未配置/, '未配置时文案要说清楚');
assert.match(aiStateLabel(parseAiConfig({ apiKey: 'sk-x', model: 'gpt-x' })), /gpt-x/, '已配置时带上模型名');

// ---------------------------------------------------------------- 读写与迁移

const empty = fakeStorage();
assert.equal(isConfigured(loadAiConfig(empty)), false, '没有存储时是未配置');
assert.equal(rawOf(empty, AI_STORE_KEY), null, '什么都没配时不该凭空建一份配置');

// 新版自己那份配置优先。
const own = fakeStorage({
	[AI_STORE_KEY]: JSON.stringify({ baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-own', model: 'gpt-4o' }),
	[LEGACY_STORE_KEY]: JSON.stringify({ key: 'sk-legacy', model: 'deepseek-v4-pro' }),
});
const ownLoaded = loadAiConfig(own);
assert.equal(ownLoaded.apiKey, 'sk-own', '两份都在时用新的那份');
assert.equal(ownLoaded.model, 'gpt-4o');

// 老数据（key 与模型名在 BP 进度对象里）要被搬过来。
const legacy = fakeStorage({
	[LEGACY_STORE_KEY]: JSON.stringify({ recorded: [1, 2], key: 'sk-legacy', model: 'deepseek-v4-pro', aiSide: true }),
});
const migrated = loadAiConfig(legacy);
assert.equal(migrated.apiKey, 'sk-legacy', '老 key 要搬过来，不能让人重填');
assert.equal(migrated.model, 'deepseek-v4-pro', '老模型名一起搬');
assert.equal(migrated.baseUrl, DEFAULT_AI_BASE_URL, '老数据没有地址字段，补默认值');
assert.ok(rawOf(legacy, AI_STORE_KEY), '搬过之后要写回新键，别每次都重算');

// 清除 key 之后，迁移不能把它复活。
const cleared = clearAiKey(migrated);
assert.equal(cleared.apiKey, '', '清除只清 key');
assert.equal(cleared.model, 'deepseek-v4-pro', '地址与模型名留着，下一把 key 通常还是这家');
assert.equal(cleared.lastCheckedAt, 0, '清除时把测试结果一起作废');
saveAiConfig(cleared, legacy);
assert.equal(loadAiConfig(legacy).apiKey, '', '清除过的 key 不该被老数据搬回来');

// 坏数据不该把整页搞挂。
const broken = fakeStorage({ [AI_STORE_KEY]: '{半截 JSON' });
assert.equal(isConfigured(loadAiConfig(broken)), false, '存储里是坏 JSON 时退回未配置，而不是抛');

// 读写往返。
const roundTrip = fakeStorage();
saveAiConfig({ baseUrl: 'https://api.openai.com/v1/', apiKey: ' sk-rt ', model: ' gpt-4o-mini ', lastCheckedAt: 123, lastCheckOk: true }, roundTrip);
const reloaded = loadAiConfig(roundTrip);
assert.deepEqual(
	{ baseUrl: reloaded.baseUrl, apiKey: reloaded.apiKey, model: reloaded.model, lastCheckedAt: reloaded.lastCheckedAt, lastCheckOk: reloaded.lastCheckOk },
	{ baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-rt', model: 'gpt-4o-mini', lastCheckedAt: 123, lastCheckOk: true },
	'存进去再读出来应当收敛到同一套值（含去空白与去尾斜杠）',
);

/*
 * 判等：界面上的状态文案吃 lastCheckedAt / lastCheckOk，而"上一份 AI 建议还能不能用"只看
 * 地址 / key / 模型。两者混用会出两种错——点完「测试连接」返回 BP 台不重画（台头仍写"还没测过"），
 * 或者清掉 key 后建议面板还挂着上一个模型的 picks。
 */
{
	const base = { baseUrl: 'https://api.deepseek.com', apiKey: 'sk-a', model: 'deepseek-flash', lastCheckedAt: 0, lastCheckOk: false };
	assert.equal(sameAiConfig(base, { ...base }), true, '一模一样的两份要判等');
	assert.equal(sameAiConfig(base, { ...base, lastCheckedAt: 1, lastCheckOk: true }), false, '只改了测试结果也算"配置变了"：状态文案要跟着重画');
	assert.equal(sameAiTarget(base, { ...base, lastCheckedAt: 1, lastCheckOk: true }), true, '只改测试结果不算换模型：上一份建议仍然有效');
	assert.equal(sameAiTarget(base, { ...base, model: 'deepseek-reasoner' }), false, '换模型要认出目标变了');
	assert.equal(sameAiTarget(base, { ...base, apiKey: '' }), false, '清掉 key 要认出目标变了');
	assert.equal(sameAiTarget(base, { ...base, baseUrl: 'https://api.openai.com/v1' }), false, '换地址要认出目标变了');
	assert.equal(sameAiConfig(base, { ...base, apiKey: 'sk-b' }), false);
}

// ---------------------------------------------------------------- 多份配置

/*
 * 「存两份、启用其中一份」是设置页的主要用法。这里钉的是会**静默出错**的几条：
 * 启用了一个不存在的 id、删掉启用着的那份之后没有接上、以及老的单份配置被搬丢。
 */
{
	const base = fakeStorage();
	const deepseek = parseAiConfig({ baseUrl: DEFAULT_AI_BASE_URL, apiKey: 'sk-d', model: 'deepseek-flash' });
	const openai = parseAiConfig({ baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-o', model: 'gpt-x' });

	const first = addAiProfile(emptyAiStore(), deepseek);
	assert.equal(first.profile.label, 'DeepSeek', '没起名字时按地址认出服务商，用它的名字');
	assert.equal(first.store.activeId, first.profile.id, '新增的那一份要立刻启用');

	const second = addAiProfile(first.store, openai, '公司那把');
	assert.equal(second.profile.label, '公司那把', '起了名字就用名字，不再按地址推');
	assert.equal(second.store.profiles.length, 2, '两份都要留着');
	assert.equal(second.store.activeId, second.profile.id, '最新新增的那一份是启用的');
	assert.equal(activeProfile(second.store)?.model, 'gpt-x', '启用的那一份要跟着 activeId 走');

	// 切回第一份：这就是「新增了 deepseek 和 openai 然后启用 openai」反过来那一步。
	const back = activateAiProfile(second.store, first.profile.id);
	assert.equal(back.activeId, first.profile.id);
	assert.equal(activeProfile(back)?.apiKey, 'sk-d');
	assert.equal(activateAiProfile(back, '没有这个 id').activeId, first.profile.id, '启用一个不存在的 id 不能把启用状态弄没');

	// 改一份不能碰到另一份。
	const edited = updateAiProfile(back, first.profile.id, { ...deepseek, model: 'deepseek-v4-pro' });
	assert.equal(activeProfile(edited)?.model, 'deepseek-v4-pro');
	assert.equal(edited.profiles[1]?.model, 'gpt-x', '改一份不能动到另一份');

	// 删掉启用着的那份要自动接到剩下的那份，否则界面会显示"启用中"却什么都没启用。
	const removed = removeAiProfile(edited, first.profile.id);
	assert.equal(removed.profiles.length, 1);
	assert.equal(removed.activeId, second.profile.id, '删掉启用着的那份要落到剩下的那份');
	assert.equal(activeProfile(removed)?.label, '公司那把');
	assert.deepEqual(removeAiProfile(removed, second.profile.id), emptyAiStore(), '全删光就是没有配置');
	assert.deepEqual(removeAiProfile(removed, '没有这个 id'), removed, '删一个不存在的 id 不该改动任何东西');

	// 存进去再读出来：两份都在，启用的那份还是启用的。
	saveAiStore(second.store, base);
	const reloaded = loadAiStore(base);
	assert.equal(reloaded.profiles.length, 2);
	assert.equal(reloaded.activeId, second.profile.id);
	assert.equal(activeProfile(reloaded)?.apiKey, 'sk-o', 'key 要能存住（只在这台浏览器里）');
	assert.equal(activeProfile(reloaded)?.lastCheckOk, false, '测试结果一起存');

	// 老的单份写法（这个键里是个裸配置对象）要搬成一份，而不是丢掉。
	const old = fakeStorage({
		[AI_STORE_KEY]: JSON.stringify({ baseUrl: DEFAULT_AI_BASE_URL, apiKey: 'sk-old', model: 'deepseek-flash' }),
	});
	const upgraded = loadAiStore(old);
	assert.equal(upgraded.profiles.length, 1, '老的单份配置要搬成一份');
	assert.equal(activeProfile(upgraded)?.apiKey, 'sk-old');
	assert.equal(activeProfile(upgraded)?.label, 'DeepSeek', '搬过来的那份也要有能认的名字，否则列表上只剩"未命名"');

	// 坏存储不能把页面搞挂，也不能凭空造出一份。
	assert.deepEqual(loadAiStore(fakeStorage({ [AI_STORE_KEY]: '{"profiles": 3}' })), emptyAiStore(), 'profiles 不是数组就当没有');
	assert.deepEqual(loadAiStore(fakeStorage({ [AI_STORE_KEY]: '{半截' })), emptyAiStore(), '半截 JSON 当没有');
	// activeId 认不出来（比如那份被手改删了）时落到第一份，别让界面显示"启用中"却什么都没启用。
	const unknownActive = parseAiStore({ activeId: '不存在', profiles: [{ apiKey: 'sk-1' }] });
	assert.equal(unknownActive.activeId, unknownActive.profiles[0]?.id, 'activeId 认不出来时落到第一份');

	// id 撞车要自己分开，否则两份共用一个键、后面那份会顶掉前面那份。
	const dup = parseAiStore({ activeId: 'a', profiles: [{ id: 'a', apiKey: 'sk-1' }, { id: 'a', apiKey: 'sk-2' }] });
	assert.equal(dup.profiles.length, 2);
	assert.notEqual(dup.profiles[0]?.id, dup.profiles[1]?.id, 'id 撞车要让第二份另起一个');
}

console.log('aiConfig.check 通过');
