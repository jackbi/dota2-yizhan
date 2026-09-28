import assert from 'node:assert/strict';
import {
	AI_STORE_KEY,
	DEFAULT_AI_BASE_URL,
	DEFAULT_AI_MODEL,
	LEGACY_STORE_KEY,
	aiStateLabel,
	clearAiKey,
	emptyAiConfig,
	endpointOf,
	isConfigured,
	loadAiConfig,
	modelsEndpointOf,
	normalizeBaseUrl,
	parseAiConfig,
	saveAiConfig,
	stateOf,
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

console.log('aiConfig.check 通过');
