import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DEFAULT_AI_MODEL, validateBaseUrl } from '../src/lib/aiConfig.ts';
import { AI_PROVIDERS, headersFor, initialProviderId, providerOf, shapeFor } from '../src/lib/aiProviders.ts';

/**
 * 服务商预设表的自检。
 *
 * 这张表是**按地址决定请求长什么样**的唯一来源，写错一行的后果都不轻：地址错 → 一律 404；
 * 形状错 → 把某一家专有的参数发给别家，被 400 拒掉。所以要盯的是：
 *
 * 1. 表本身自洽：id 与域名不重复、地址合法、该有提醒的有提醒；
 * 2. `shapeFor` 只给 DeepSeek 发 thinking，其余一律走默认那套保守参数；
 * 3. 认不出来的地址（自建、中转）与坏地址都要退回默认形状，而不是乱猜；
 * 4. 与 `aiConfig` 的默认模型不漂移。
 *
 * 表里每一条地址与跨域结论都是在 2026-09-28 实测过的，过程记在 `docs/draft.md`。
 *
 * 跑：`pnpm check`（或 `node --experimental-strip-types scripts/aiProviders.check.ts`）。
 */

// ---------------------------------------------------------------- 表本身

assert.ok(AI_PROVIDERS.length >= 10, '预设表太短了，多半是解析坏了');

const ids = new Set<string>();
const hosts = new Set<string>();
for (const provider of AI_PROVIDERS) {
	assert.ok(provider.id && provider.label, '每个预设都要有 id 与显示名');
	assert.ok(!ids.has(provider.id), `预设 id 重复：${provider.id}`);
	ids.add(provider.id);

	if (provider.host) {
		assert.ok(!hosts.has(provider.host), `域名重复：${provider.host}`);
		hosts.add(provider.host);
	}

	// 地址要么留给用户填（自定义），要么必须是可用的。
	if (provider.baseUrl) {
		assert.equal(validateBaseUrl(provider.baseUrl), null, `${provider.label} 的地址不合法：${provider.baseUrl}`);
		// 本地服务（Ollama）之外一律 https：http 的远端地址在 https 页面上会被浏览器直接拦掉。
		const isLocal = /localhost|127\.0\.0\.1/.test(provider.baseUrl);
		assert.ok(isLocal || provider.baseUrl.startsWith('https://'), `${provider.label} 的地址应当是 https`);
	} else {
		assert.equal(provider.id, 'custom', '只有「自定义」可以不给地址');
	}

	// 需要用户额外动手的那几家必须写清楚要做什么，否则用户只会看到「连不上」。
	if (['ollama', 'cloudflare', 'custom'].includes(provider.id)) {
		assert.ok(provider.hint, `${provider.label} 需要额外配置，必须给一句提醒`);
	}
}

// 只有 DeepSeek 能收到那个非标准参数：它是唯一认它的服务商，发给别家就是 400。
for (const provider of AI_PROVIDERS) {
	if (provider.id === 'deepseek') continue;
	assert.ok(!provider.shape?.thinking, `${provider.label} 不该发 thinking，那是 DeepSeek 专有的`);
}

// 默认模型不能两处各写一份：预设表里 DeepSeek 的第一个与 aiConfig 的默认值必须一致。
const deepseek = AI_PROVIDERS.find((provider) => provider.id === 'deepseek');
assert.ok(deepseek, '预设表里必须有 DeepSeek');
assert.equal(deepseek.models?.[0], DEFAULT_AI_MODEL, 'DeepSeek 的首个建议模型要与 aiConfig 的默认模型一致');

// ---------------------------------------------------------------- 按地址认家

assert.equal(providerOf('https://api.deepseek.com')?.id, 'deepseek');
assert.equal(providerOf('https://api.deepseek.com/v1')?.id, 'deepseek', '带版本段也要认出来');
assert.equal(providerOf('https://api.openai.com/v1')?.id, 'openai');
assert.equal(providerOf('http://localhost:11434/v1')?.id, 'ollama', '本地服务按域名认，不看端口');
assert.equal(providerOf('https://my-proxy.example.com/v1'), null, '自建中转认不出来，交给默认形状');
assert.equal(providerOf('not a url'), null, '坏地址不该抛异常');

assert.equal(initialProviderId('https://api.deepseek.com'), 'deepseek', '界面上要能选中当前那一家');
assert.equal(initialProviderId('https://api.openai.com/v1'), 'openai');
assert.equal(initialProviderId('https://my-proxy.example.com/v1'), 'custom', '认不出来就落到自定义');

// ---------------------------------------------------------------- 请求形状

assert.deepEqual(
	shapeFor('https://api.deepseek.com'),
	{ thinking: true, maxTokensField: 'max_tokens', temperature: true },
	'DeepSeek 要关思考，上限仍用 max_tokens',
);
assert.deepEqual(
	shapeFor('https://api.openai.com/v1'),
	{ thinking: false, maxTokensField: 'max_completion_tokens', temperature: true },
	'OpenAI 的新模型只认 max_completion_tokens',
);
assert.deepEqual(
	shapeFor('https://api.x.ai/v1'),
	{ thinking: false, maxTokensField: 'max_completion_tokens', temperature: true },
	'Grok 与 OpenAI 同类',
);

// 认不出来与地址坏掉：一律最保守的那套，不猜。
const conservative = { thinking: false, maxTokensField: 'max_tokens', temperature: true };
assert.deepEqual(shapeFor('https://my-proxy.example.com/v1'), conservative, '自建中转用默认形状');
assert.deepEqual(shapeFor('not a url'), conservative, '地址坏掉时也要给能用的默认形状，别让调用方拿到 undefined');
assert.deepEqual(shapeFor(''), conservative);

// ---------------------------------------------------------------- 请求头

const anthropicHeaders = headersFor('https://api.anthropic.com/v1', 'sk-x');
assert.equal(
	anthropicHeaders['anthropic-dangerous-direct-browser-access'],
	'true',
	'Anthropic 浏览器直连必须带这个头（实测不带会被跨域拦掉）',
);
assert.equal(anthropicHeaders.Authorization, 'Bearer sk-x', 'key 照常放在 Authorization 里');
assert.equal(anthropicHeaders['Content-Type'], 'application/json');

const openaiHeaders = headersFor('https://api.openai.com/v1', 'sk-y');
assert.deepEqual(
	openaiHeaders,
	{ 'Content-Type': 'application/json', Authorization: 'Bearer sk-y' },
	'别家不该多出莫名其妙的自定义头',
);

/**
 * 探测脚本里的默认 Origin 必须与站点的对外域名一致。
 *
 * 它决定预检时声明「请求来自哪个站点」——写错了这个脚本就开始验错的东西（服务商放行的是
 * 另一个域名，而真实站点仍会被拦）。两处都是写死的字符串，所以拿源码对着比，跟
 * `draftFoe.check.ts` 比对队名规则是同一个套路。
 */
const probe = readFileSync(new URL('./aiProviders.probe.ts', import.meta.url), 'utf8');
const astroConfig = readFileSync(new URL('../astro.config.mjs', import.meta.url), 'utf8');
const siteOrigin = /const SITE_ORIGIN = '([^']+)'/.exec(astroConfig)?.[1];
const probeOrigin = /const DEFAULT_ORIGIN = '([^']+)'/.exec(probe)?.[1];
assert.ok(siteOrigin, '没能从 astro.config.mjs 里读出 SITE_ORIGIN，解析多半坏了');
assert.equal(probeOrigin, siteOrigin, '探测脚本的默认 Origin 要与站点域名一致');

console.log('aiProviders.check 通过');
