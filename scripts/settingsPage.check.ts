import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/**
 * `/settings` 的静态自检。
 *
 * 这一页是**全站唯一会让人输入 key 的地方**，所以除了页面 id 与脚本 id 对账（照
 * `draftPage.check.ts` 的做法），还钉两条对外承诺的文案——它们是这个功能能开源的前提，
 * 改文案的时候很容易顺手删掉：
 *
 * 1. key 只存在本机、站点不经手；
 * 2. key 输入框是 password 且关掉浏览器自动填充。
 *
 * 跑：`pnpm check`（或 `node --experimental-strip-types scripts/settingsPage.check.ts`）。
 */

const page = readFileSync(new URL('../src/pages/settings.astro', import.meta.url), 'utf8');
const script = readFileSync(new URL('../src/scripts/settingsForm.ts', import.meta.url), 'utf8');

/** 页面上的 id。 */
const pageIds = new Set([...page.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]));
assert.ok(pageIds.size > 5, `只从 settings.astro 里解析出 ${pageIds.size} 个 id，解析多半坏了`);

// ---------------------------------------------------------------- id 对账

const queriedIds = new Set([...script.matchAll(/element<[^>]*>\('([^']+)'\)/g)].map((match) => match[1]));
assert.ok(queriedIds.size > 5, `只从 settingsForm 里解析出 ${queriedIds.size} 个 id，解析多半坏了`);

for (const id of queriedIds) {
	assert.ok(pageIds.has(id), `脚本在找 #${id}，但 settings.astro 里没有这个 id`);
}

// 反方向：页面上的输入框与按钮必须真的被脚本接管，否则点了没反应。
for (const id of [
	'settings-base-url',
	'settings-key',
	'settings-model',
	'settings-model-options',
	'settings-models',
	'settings-models-state',
	'settings-provider-hint',
	'settings-save',
	'settings-test',
	'settings-clear',
]) {
	assert.ok(pageIds.has(id), `设置页缺少 #${id}`);
	assert.ok(queriedIds.has(id), `#${id} 在页面上，但脚本没有接管它`);
}

/**
 * 服务商那排按钮。
 *
 * 三种情况都要拦住：页面没渲染出来（`AI_PROVIDERS.map` 被删）、脚本没挂钩子（点了没反应）、
 * 或者两边用的属性名不一致（脚本找 `[data-provider]`，页面写 `data-providers`）。
 */
assert.ok(page.includes('AI_PROVIDERS.map'), '服务商按钮要由预设表渲染，别手写一份会过期的列表');
assert.ok(page.includes('data-provider={provider.id}'), '每个服务商按钮要带 data-provider');
assert.ok(script.includes("querySelectorAll<HTMLButtonElement>('[data-provider]')"), '脚本要接管服务商按钮');

// ---------------------------------------------------------------- 显隐手法

// 与 /draft 同一条规矩：藏东西用内联 display，别用 Tailwind 的 hidden 类。
const tags = page.match(/<[a-z][^>]*>/gi) ?? [];
for (const tag of tags) {
	const classValue = /class="([^"]*)"/i.exec(tag)?.[1] ?? '';
	const classes = classValue.split(/\s+/).filter(Boolean);
	assert.ok(!classes.includes('hidden'), `用 hidden 类藏东西会盖过脚本写的内联 display：${tag.slice(0, 80)}`);
}

// ---------------------------------------------------------------- 对外承诺

assert.match(page, /key 只存在这台浏览器/, '要写明 key 存在本机');
assert.match(page, /本站不经手/, '要写明站点不经手请求');

/*
 * 两个「坏掉了页面照样看着正常」的行为。
 *
 * 它们是同一批修掉的静默失效，当时只补了 draft 侧的断言，这里漏了——而设置页恰恰是
 * 这两条唯一会露出来的地方。
 */
assert.match(
	script,
	/baseUrlInput\?\.addEventListener\('input', \(\) => \{\s*renderProviders\(\);/,
	'手打地址要重认服务商：不监听的话，域名换了那排按钮与提示还停在上一家（Ollama / Cloudflare 的注意事项就写在提示里）',
);
assert.match(
	script,
	/fetchedFor && fetchedFor === normalizeBaseUrl\(baseUrlInput\?\.value \?\? ''\)/,
	'换地址要作废拉过的模型列表：那份列表属于上一家',
);
assert.match(script, /fetchedFor = target\.baseUrl;/, '拉到列表后要记住它属于哪个地址');
assert.match(page, /公共电脑上别存/, '公共电脑的提醒不能删');

const keyInput = /<input[^>]*id="settings-key"[^>]*>/i.exec(page)?.[0] ?? '';
assert.match(keyInput, /type="password"/, 'key 输入框必须是 password');
assert.match(keyInput, /autocomplete="off"/, 'key 输入框要关掉浏览器自动填充');

// 地址填成黑洞时，按钮不能永远停在「测试中…」。
assert.match(script, /AbortSignal\.timeout\(TEST_TIMEOUT_MS\)/, '测试连接必须带超时');

// 请求头要按服务商拼（Anthropic 那个跨域开关头就挂在里面）。**两处请求都要**：
// 漏了测试连接那一处，就会出现「测试不过但实际能用」这种最费解的反馈。
assert.equal(
	(script.match(/headersFor\(target\.baseUrl, target\.apiKey\)/g) ?? []).length,
	2,
	'测试连接与拉模型列表都要带服务商的额外头',
);

assert.ok(page.includes("import '../scripts/settingsForm'"), '页面要加载客户端脚本');

// 地址与模型名是这一版唯一能改的两项：填了它们才谈得上「不只限于一家」。
assert.ok(page.includes('id="settings-base-url"'), '要能填 API 地址');
assert.ok(page.includes('id="settings-model"'), '要能填模型名');

console.log('settingsPage.check 通过');
