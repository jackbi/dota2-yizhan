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
	'settings-model-toggle',
	'settings-models',
	'settings-models-state',
	'settings-provider-hint',
	'settings-save',
	'settings-test',
	'settings-clear',
	'settings-cancel',
	'settings-list',
	'settings-empty',
	'settings-new',
	'settings-label',
	'settings-editor-title',
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

// ---------------------------------------------------------------- 模型候选的下拉

/*
 * 候选模型名原先走原生 `datalist`：弹层由浏览器画，配色与位置都是系统那套，和这个深色输入框
 * 之间永远隔着一条白边——看着就是两块分离的东西，而且一条 CSS 都改不动。现在是自绘的 `ul`，
 * 用 `absolute` + `top-full` 贴在输入框下面。
 *
 * 换掉之后有三条**页面看着一切正常**的责任要自己扛：收起、键盘、以及选项按下时别让输入框失焦。
 * 原生那三样都是免费的，自绘一份不写就是点了没反应。
 */
assert.ok(!page.includes('<datalist'), '模型候选别再用原生 datalist：它的弹层与输入框必然是分离的两块');
assert.ok(page.includes('id="settings-model-options"') && page.includes('role="listbox"'), '候选要换成自绘的 listbox');
assert.match(
	page,
	/id="settings-model-options"[\s\S]{0,200}?absolute[\s\S]{0,200}?top-full/,
	'候选列表要贴着输入框（absolute + top-full），不能飘在别的地方',
);
assert.match(page, /role="listbox"[\s\S]{0,300}?style="display: none"/, '候选列表初始要收起');
assert.match(page, /aria-controls="settings-model-options"/, '输入框要指向它控制的那个列表');

assert.match(script, /modelOptions\.style\.display = '';/, '展开要把列表放出来');
assert.match(script, /modelOptions\.style\.display = 'none';/, '收起要把列表藏掉');
assert.match(script, /setAttribute\('aria-expanded'/, '展开状态要同步给读屏');
assert.match(script, /ArrowDown/, '键盘要能上下选');
assert.match(script, /event\.key === 'Escape'/, 'Esc 要能收起');
assert.match(
	script,
	/document\.addEventListener\('click'[\s\S]{0,500}?closeModelList\(\)/,
	'点到别处要收起：弹层浮在表单上面，不收会一直挡着下面的地址与 key',
);
assert.match(
	script,
	/addEventListener\('mousedown'[\s\S]{0,120}?event\.preventDefault\(\)/,
	'选项按下时不能让输入框先失焦：列表会在 click 之前被收掉，点起来像点空了',
);

// ---------------------------------------------------------------- 多份配置

/*
 * 「存两份、启用其中一份」是这一页现在的用法：新增的那份直接启用，换一份点它那行的「启用」。
 * 会**静默出错**的三处：写回单份（新增第二份时把第一份顶掉）、列表用 innerHTML 拼
 * （名字与地址都是用户输入的），以及删除不做二次确认（key 只在这台浏览器里，删了就真没了）。
 */
assert.match(script, /loadAiStore\(\)/, '要读"多份"那份存储，不是单份那一套');
assert.match(script, /addAiProfile\(/, '「新增一份」要真的往列表里加');
assert.match(script, /activateAiProfile\(/, '「启用」要能切换阵容分析用哪一份');
assert.match(script, /removeAiProfile\(/, '要能删掉某一份');
assert.match(script, /updateAiProfile\(/, '「保存这一份」要写回原来那份，而不是又加一份');
assert.match(script, /saveAiStore\(store\)/, '改完要落盘');

// 列表里那一行是用户自己的名字与地址拼出来的，拼 HTML 字符串等于给自己开一个 XSS 口子。
assert.ok(!/\.innerHTML/.test(script), '列表与提示都不许写 innerHTML：名字、地址都是用户输入');

assert.match(script, /pendingDeleteId === profile\.id \? '再点一次删除' : '删除'/, '删除要在按钮上二次确认');
assert.match(script, /if \(pendingDeleteId !== id\)/, '第一次点删除只挂起，第二次才真删');
assert.match(script, /setTimeout\(\(\) => \{\s*disarmDelete\(\);\s*renderList\(\);/, '挂起的删除要自己超时复原，不能一直悬着');

assert.match(script, /editorTitle\.textContent/, '编辑器标题要跟着正在编的那一份走');
assert.match(
	script,
	/saveButton\.textContent = profile \? '保存这一份' : '新增并启用'/,
	'按钮文案要分得清"改一份"和"加一份"',
);
assert.match(script, /emptyEl\.style\.display = store\.profiles\.length > 0 \? 'none' : ''/, '一份都没有时要显示空状态');

console.log('settingsPage.check 通过');
