import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/**
 * `/draft` 页面的静态自检：**标记里的 id 和脚本里找的 id 必须对得上**。
 *
 * 这类错在别的页面真实发生过（开黑房间那次的症状是"页面上什么都没有，也不报错"），
 * 因为 `getElementById` 找不到只会返回 null，而脚本里的 `if (!node) return` 会把整段逻辑
 * 静悄悄跳过。所以这里把两个文件对着读：
 *
 * 1. 脚本里 `element('x')` 找的每个 id，页面上都要有；
 * 2. 页面里不许用 `hidden` 类藏东西（Tailwind 的 utility 层会盖过脚本写的内联 display），
 *    要藏就用内联 `style="display: none"`，并且脚本里必须有让它显示出来的代码；
 * 3. 页面上那些 `data-*` 挂钩（属性、号位、阵营、先选权）要成组存在，缺一个按钮就少一档功能。
 *
 * 跑：`pnpm check`（或 `node --experimental-strip-types scripts/draftPage.check.ts`）。
 */

const page = readFileSync(new URL('../src/pages/draft.astro', import.meta.url), 'utf8');
const script = readFileSync(new URL('../src/scripts/draftBoard.ts', import.meta.url), 'utf8');

/** 页面上的 id。 */
const pageIds = new Set([...page.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]));
assert.ok(pageIds.size > 20, `只从 draft.astro 里解析出 ${pageIds.size} 个 id，解析多半坏了`);

// ---------------------------------------------------------------- id 对账

const queriedIds = new Set([...script.matchAll(/element<[^>]*>\('([^']+)'\)/g)].map((match) => match[1]));
assert.ok(queriedIds.size > 8, `只从 draftBoard.ts 里解析出 ${queriedIds.size} 个 id，解析多半坏了`);

for (const id of queriedIds) {
	assert.ok(pageIds.has(id), `脚本在找 #${id}，但 draft.astro 里没有这个 id`);
}

// 反方向只提示不失败：有些 id 是脚本动态拼出来的（比如 `draft-bans-${side}`）。
const dynamic = new Set([...script.matchAll(/element<[^>]*>\(`([^`]+)`\)/g)].map((match) => match[1]));
assert.ok(dynamic.size > 0, '脚本里应该有按阵营拼出来的 id');

// ---------------------------------------------------------------- 显隐手法

// 规则 1：页面里不许出现 hidden 类，藏东西一律用内联 display。
const tags = page.match(/<[a-z][^>]*>/gi) ?? [];
for (const tag of tags) {
	const classValue = /class="([^"]*)"/i.exec(tag)?.[1] ?? '';
	const classes = classValue.split(/\s+/).filter(Boolean);
	assert.ok(!classes.includes('hidden'), `用 hidden 类藏东西会盖过脚本写的内联 display：${tag.slice(0, 80)}`);
}

// 规则 2：内联藏起来的元素，脚本里必须有显示它的代码。
const hiddenIds = [...page.matchAll(/\sid="([^"]+)"[^>]*style="display:\s*none"/g)].map((match) => match[1]);
assert.ok(hiddenIds.length > 0, '页面里应该有默认折叠的区域（比如建议面板）');
for (const id of hiddenIds) {
	// 脚本要么直接操作这个 id 的 style.display，要么通过一个变量统一控制。
	const mentioned = script.includes(`'${id}'`) || script.includes(`#${id}`);
	assert.ok(mentioned, `#${id} 默认是隐藏的，但脚本里找不到任何提到它的地方，它永远露不出来`);
}
assert.match(script, /style\.display/, '脚本必须用 style.display 控制显隐');

// ---------------------------------------------------------------- 挂钩齐不齐

for (const attr of ['data-attr', 'data-position', 'data-side', 'data-first-pick']) {
	assert.ok(page.includes(`${attr}="`), `页面上缺少 ${attr} 挂钩`);
	assert.ok(script.includes(`[${attr}]`), `脚本没有监听 ${attr}`);
}
// 英雄池分组必须换一个属性名：分组和筛选按钮共用 `data-attr` 时，点英雄会冒泡到分组上，
// 顺手把过滤器切到这个英雄的属性（实测症状：点一下英雄，池子里只剩一组）。
assert.ok(script.includes('dataset.attrGroup'), '分组要用 data-attr-group，别和筛选按钮抢 data-attr');
assert.ok(!/group\.dataset\.attr\b/.test(script), '分组不能把属性写在 data-attr 上');
assert.ok(page.includes('data-attr="STR"') && page.includes('data-attr="UNI"'), '属性筛选要覆盖四个属性');
// 号位按钮是循环生成的，源码里只会看到 `data-position={position}`，所以查循环的取值。
assert.ok(page.includes('data-position={position}'), '号位筛选按钮要走循环生成');
assert.match(page, /\[1, 2, 3, 4, 5\]\.map/, '号位筛选要覆盖 1 到 5');

// 数据与脚本都必须挂上，否则页面是一片空白。
assert.ok(page.includes('id="draft-data"'), '页面要带上构建期数据');
assert.ok(page.includes("import '../scripts/draftBoard'"), '页面要加载客户端脚本');

// ---------------------------------------------------------------- 人机对战

/**
 * 这块是"和 AI 对着打"的入口，几个点缺一个就退化成只能看建议：
 * 总开关、AI 的落子区块、自动出招的定时器，以及**调用失败要退回数据决策**的兜底。
 *
 * 另外三条是「不许假装有 AI」：没配模型时台头要写「本地」而不是「AI」，手动出招那个按钮
 * 要换成「让对面走这一手」，开关要禁用。以前没配 key 时界面照样写着「（AI）」，而实际走的是
 * 本地启发式——用户从结果上看不出差别，所以这几条要钉住。
 */
assert.ok(page.includes('id="draft-ai-side"'), '要有"对面交给 AI"的开关');
assert.ok(page.includes('id="draft-ai-move"'), '要有 AI 落子的区块');
assert.ok(page.includes('id="draft-ai-play"'), '关掉自动时要能手动让它出招');
assert.match(script, /window\.setTimeout\([\s\S]{0,80}playOpponentMove/, '自动出招要有定时器');
assert.match(script, /ourSide: turn\.side/, 'AI 要走对面那一手，就得用对面的视角算候选');
assert.match(script, /'theirs'/, '替对面落子要用对手模式的提示词');
assert.match(script, /let why = localMoveReason\(top, turn\.action\)/, '模型没给理由时要退回本地依据，而不是留一句没信息量的话');
// 失败（网络、限流、参数被拒、解析不过）一律返回 null，由调用方退回数据决策。
assert.match(script, /async function askModelForOpponentMove[\s\S]*?if \(!reply\.ok\) return null;/, '模型调用失败要返回 null，由调用方退回数据决策');
assert.match(script, /isConfigured\(ai\) \? 'AI' : '本地'/, '没配模型时台头必须写"本地"，不能还写 AI');
assert.match(script, /isConfigured\(ai\) \? '让 AI 解释这几手' : '配置模型后可以解释'/, '"让 AI 解释"那个按钮在没配模型时要改成说得通的入口文案');
assert.match(
	script,
	/isConfigured\(ai\) \? '让 AI 走这一手' : '让对面走这一手'/,
	'手动出招那个按钮在没配模型时不能还写"让 AI 走"',
);
assert.match(script, /aiSideInput\.disabled = !configured/, '没配模型时要禁用"对面交给 AI"，否则开关看着是开的却没有 AI');
// 光禁用不够：原因要写在开关旁边。文档说"禁用并在旁边写明原因"，这里就是那个"旁边"。
assert.ok(page.includes('id="draft-ai-hint"'), '开关旁边要有写原因的位置');
assert.match(script, /aiHint\.textContent = configured \? '' : '未配置模型，对面由本地数据出招'/, '要把原因写进开关旁边那一句');
assert.match(script, /aiSidePref/, '开关要区分"用户的选择"与"被配置逼出来的值"，否则配好模型回来还是关的');
// 模型从「对面近期拿过的」那一栏里挑人也要算数：两栏都得查，否则会静默丢掉它的选择。
assert.match(script, /advice\.foeCandidates\.find\(\(item\) => item\.heroId === pick\.heroId\)/, '模型选到"对面擅长"那栏时不能把它丢掉');
// 配置在别处改了要跟上：bfcache 返回、另一个标签页保存。
assert.match(script, /addEventListener\('pageshow'/, '从 bfcache 返回时要重读配置');
assert.match(script, /event\.key === AI_STORE_KEY/, '另一个标签页改了配置要跟上');
// 变更判定要覆盖**全部**字段：只比地址与 key 的话，在设置页点完「测试连接」切回来不会重画。
assert.match(script, /if \(sameAiConfig\(next, ai\)\) return;/, '重读配置后要按全部字段判等（含上次测试结果）');
// 换了地址/key/模型要把**两处**模型产物都撤掉：建议面板（aiResult）与复盘文字（verdictAi）。
// 上一版只撤了前者，复盘面板还挂着上个模型的文字，而 renderAll() 不会重画它。
	assert.match(
		script,
		/if \(!sameAiTarget\(next, ai\)\) \{\s*aiGeneration \+= 1;\s*aiResult = null;\s*verdictAi = null;\s*renderVerdict\(\);/,
		'换了地址/key/模型要撤掉上一份 AI 建议与复盘文字、重画复盘面板，并推进配置世代号',
	);
/*
 * 只撤"当时已经落在面板上"的那份还不够：请求是异步的，最长能跑 30 秒。这中间另一个标签页
 * 保存了新配置时，在飞的那一份回来照样会把自己写回去——台头写「未配置模型」、下面挂着上一个
 * 模型的分析。所以两处 await 之后都要先对一眼世代号。
 */
	assert.match(script, /let aiGeneration = 0;/, '要有配置世代号');
	assert.equal(
		(script.match(/if \(generation !== aiGeneration\) return;/g) ?? []).length,
		2,
	'复盘与建议两条 await 之后都要丢弃过期回复',
);
// 地址可填之后，填错一个地址就是一次挂起的请求：自动出招会停在那儿，盘面推不动。
assert.match(script, /signal: AbortSignal\.timeout\(MODEL_TIMEOUT_MS\)/, '模型请求必须带超时，超时后走原有的失败回落');
// 三条调用路径走同一个入口：退让顺序、超时、按服务商拼的请求头都只写一遍。
assert.match(script, /async function requestChat\(/, '三条模型调用要走同一个 requestChat，别各写一遍');
assert.match(script, /headersFor\(ai\.baseUrl, ai\.apiKey\)/, '请求头要按服务商拼（Anthropic 那个跨域开关头在里面）');
assert.match(script, /shapeFor\(ai\.baseUrl\)/, '请求形状（思考开关、上限字段名）要按地址决定');

/**
 * 模型配置只住在 `/settings`。
 *
 * 这一页留一行状态和一个入口；如果谁又把 key 输入框搬回来，两处都能改配置，存储又会打架。
 */
assert.ok(page.includes('id="draft-ai-state"'), 'BP 台要显示配置状态');
assert.ok(page.includes('href="/settings"'), 'BP 台要能走到设置页');
assert.ok(!page.includes('id="draft-key"'), 'key 输入框只在 /settings，别在 BP 台再放一个');

/**
 * 两处提示词组装都必须按"视角"传队名（`selfTeam` / `foeTeam`）。
 *
 * 这里踩过：`PromptInput` 的字段从 `ourTeam/theirTeam` 改成视角命名之后，只改了替对面落子的
 * 那一处，"让 AI 解释这几手"还在传旧字段名——类型上是错的，运行时 `input.selfTeam.trim()`
 * 直接抛异常。所以把这几条钉在这里。
 */
assert.ok((script.match(/selfTeam:/g) ?? []).length >= 2, '两处提示词组装都要传 selfTeam');
assert.ok((script.match(/foeTeam:/g) ?? []).length >= 2, '两处提示词组装都要传 foeTeam');
assert.ok(!/data!\s*[.,)]/.test(script), '不要用 data! 压类型：收窄后取个别名（draft）');

// ---------------------------------------------------------------- 布局约束

/**
 * 这几条都是实测踩出来的，删掉不会报错，只会让页面看起来"没做完"：
 *
 * 1. 右边的 BP 板要和左边的英雄池**等高**。面板本身会被栅拉高，但里面那层只有内容高度，
 *    改回两列挑选（或去掉 flex 拉伸）就会空出四五百像素。
 * 2. 挑选区排**一列**，禁用区保持小格子，两者的高度差靠栅格分配。
 * 3. 比赛下拉必须限宽：原生 select 会按最长的那条 option 撑开，窄屏上顶出横向滚动条
 *    （实测 390px 视口下页面被撑到 534px）。
 */
assert.ok(page.includes('class="draft-board '), 'BP 板要带 draft-board 类');
assert.ok(page.includes('id="draft-board-grid"'), 'BP 板要有一个放 24 行的容器');
assert.match(page, /@media \(min-width: 1280px\)/, '等高拉伸要放在 xl 断点里，否则移动端会被拉伸');
assert.match(page, /\.draft-board-grid\s*\{[^}]*flex:\s*1 1 auto/, 'draft-board-grid 必须撑满面板高度');
assert.ok(page.includes('一行一手'), '文案要说明这张表是一行一手');
assert.ok(!page.includes('min-w-56'), '比赛下拉不能用 min-w 定宽，会被最长的 option 撑破布局');
assert.match(page, /id="draft-match"[^>]*class="[^"]*w-full[^"]*sm:w-72/, '比赛下拉要限宽');

/**
 * 右侧 BP 板照客户端的排法：天辉一列、夜魇一列、中间夹手号，一行一手。
 * 这两条是用户对着客户端截图提的，改回去页面就不是那个东西了。
 */
assert.match(page, /\.draft-row\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s*2\.5rem\s*minmax\(0,\s*1fr\)/, '一行要排成"格子 + 手号 + 格子"');
// 禁用格比挑选格矮：客户端的禁用是一张缩略图加个叉，挑选才是看阵容的地方。
assert.match(page, /\.draft-row\[data-action='ban'\]\s*\{[^}]*--cell-width:\s*55px[^}]*--cell-height:\s*30px/, '禁用框要是 55×30');
assert.match(page, /\.draft-row\[data-action='pick'\]\s*\{[^}]*--cell-width:\s*70px[^}]*--cell-height:\s*40px/, '挑选框要是 70×40');
assert.match(script, /row\.dataset\.action = entry\.action/, '每行要带上是禁用还是挑选，样式靠它分档');
assert.match(page, /margin-top:\s*0\.35rem/, '阶段之间要留间距');
assert.ok(page.includes('id="draft-label-radiant">天辉') && page.includes('id="draft-label-dire">夜魇'), '列头要写明天辉和夜魇');
assert.match(page, /data-action='ban'\]\[data-state='filled'\]::after[\s\S]{0,80}✕/, '禁用格要打叉，和客户端一致');
// 禁用与挑选必须在同一列里按手号混排，不能再分成"七个禁用 + 五个挑选"两段。
assert.ok(!script.includes('draft-bans-'), 'BP 板不该再有独立的禁用区');
assert.ok(!script.includes('draft-picks-'), 'BP 板不该再有独立的挑选区');
assert.match(script, /cell\.dataset\.action = entry\.action/, '每一行都要带上是禁用还是挑选');

/**
 * 英雄池照客户端的排法：四个属性各占一列并排，每列里是竖版头像墙 45×80。
 * 第一版是四组上下堆叠的横版大图，一屏只看得到半组，挑人要来回滚。
 */
assert.match(page, /\.pool-root\s*\{[^}]*grid-template-columns:\s*repeat\(4,/, '四个属性要并排成四列');
assert.match(page, /\.pool-grid\s*\{[^}]*grid-template-columns:\s*repeat\(auto-fill,\s*45px\)/, '头像格要按 45 宽定宽排');
assert.match(page, /\.hero-tile\s*\{[^}]*width:\s*45px[^}]*height:\s*80px/, '头像格要是 45×80 的竖版');
assert.ok(!page.includes('aspect-ratio: 16 / 10'), '头像格改成定高之后不该再留宽高比');
// 属性图标：分组标题与筛选按钮都要有，跟客户端一样。
assert.ok(page.includes('ATTRIBUTE_ICON'), '属性图标要用 heroApi 里那一份，别各写一份');
assert.match(script, /pool-group-icon/, '分组标题要渲染属性图标');
assert.match(page, /\.pool-group-icon\s*\{[^}]*width:\s*14px/, '分组标题的图标要定尺寸');

console.log(`draftPage 断言通过（${pageIds.size} 个 id，脚本引用 ${queriedIds.size} 个）`);
