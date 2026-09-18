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
 */
assert.ok(page.includes('id="draft-ai-side"'), '要有"对面交给 AI"的开关');
assert.ok(page.includes('id="draft-ai-move"'), '要有 AI 落子的区块');
assert.ok(page.includes('id="draft-ai-play"'), '关掉自动时要能手动让它出招');
assert.match(script, /window\.setTimeout\([\s\S]{0,80}playOpponentMove/, '自动出招要有定时器');
assert.match(script, /ourSide: turn\.side/, 'AI 要走对面那一手，就得用对面的视角算候选');
assert.match(script, /'theirs'/, '替对面落子要用对手模式的提示词');
assert.match(script, /const why = reason \|\| '按号位胜率与剩余手数判断'/, '模型没给理由时要退回数据决策的说明');
assert.match(script, /async function askModelForOpponentMove[\s\S]*?catch \{[\s\S]*?return null;/, '模型调用失败要返回 null，由调用方退回数据决策');

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

console.log(`draftPage 断言通过（${pageIds.size} 个 id，脚本引用 ${queriedIds.size} 个）`);
