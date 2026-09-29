import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

/**
 * `/donate` 的自检。
 *
 * 这一页有两类**只在真要扫码时才发现**的坏法，页面本身看着一切正常：二维码挂了（热链失效、
 * 文件被挪走）与图上没有可读的名字（`alt` 为空，读屏与加载失败时都不知道那是什么）。
 * 另外两条是这一页的对外承诺，改文案时很容易顺手删掉：「自愿原则」与「赞赏不改变功能」。
 *
 * 页头那个入口由 `headerNav.check.ts` 盯着；这里只管这一页自己。
 *
 * 跑：`pnpm check`（或 `node --experimental-strip-types scripts/donatePage.check.ts`）。
 */

const ROOT = new URL('../', import.meta.url);
const page = readFileSync(new URL('src/pages/donate.astro', ROOT), 'utf8');

// ---------------------------------------------------------------- 二维码：自托管，而且真能扫

/*
 * README 里那两张是图床热链，站点这边必须自己发：图床换域名、加防盗链或者关站之后，
 * 热链只剩一张破图——而扫码的人正好卡在这一步，没有任何替代路径。
 */
assert.ok(!/imgbed\.hiwenbin\.com/.test(page), '收款码要自托管，不能热链图床');

const sources = [...page.matchAll(/src: '(\/donate\/[^']+)'/g)].map((match) => match[1]);
assert.equal(sources.length, 2, `应当有微信与支付宝两张收款码，实际解析出 ${sources.length} 张`);
for (const src of sources) {
	assert.ok(existsSync(new URL(`public${src}`, ROOT)), `${src} 不在 public/ 里：页面上会是一张破图`);
}

const alts = [...page.matchAll(/alt: '([^']*)'/g)].map((match) => match[1]);
assert.equal(alts.length, 2, '两张收款码都要有 alt');
for (const alt of alts) assert.ok(alt.trim().length > 0, '收款码的 alt 不能空：读屏与加载失败时全靠它');

/*
 * 宽高写死：不写的话图片加载完页面会往下跳一截，而这一页的主要内容就是这两张图。
 * 源码里只有一个 `<img>`（两张图是同一个 `map` 渲染出来的），所以这里只钉那个模板，
 * 「两张都在」由上面 `sources` / `alts` 各两条来保证。
 */
const images = [...page.matchAll(/<img[\s\S]*?\/>/g)].map((match) => match[0]);
assert.ok(images.length >= 1, '没从 donate.astro 里解析出 img，解析多半坏了');
for (const tag of images) {
	assert.match(tag, /alt=\{[^}]+\}|alt="[^"]+"/, `收款码要有 alt：${tag.slice(0, 60)}`);
	assert.match(tag, /width=\{[^}]+\}|width="\d+"/, '收款码要写死 width：不然加载完会跳版');
	assert.match(tag, /height=\{[^}]+\}|height="\d+"/, '收款码要写死 height');
}

// ---------------------------------------------------------------- 对外承诺

assert.match(page, /自愿原则/, '要写明自愿原则');
assert.match(page, /提高开发积极性和开发环境/, '要说清赞赏用在哪（README 里就是这句话）');
assert.match(page, /赞赏不改变任何功能/, '要说清边界：赞赏不改变任何功能');

// ---------------------------------------------------------------- 名单

/*
 * 名单是一小段手写数据，加人就是往数组里 append 一条。两条会静默出错的：名单为空时页面得
 * 说点人话（不然只剩一个空标题），以及金额要跟着数据算（写死一个数字，加了下一位就对不上）。
 */
assert.match(page, /const DONORS: Donor\[\] = \[/, '名单要是一个能直接 append 的数组');
assert.ok(page.includes('Soren.H'), '目前那位捐赠人要在名单里');
assert.match(page, /DONORS\.length === 0 \?/, '名单为空时要有兜底文案');
assert.match(page, /total\.toFixed\(2\)/, '累计金额按名单算，不要写死');
assert.match(page, /donor\.amount\.toFixed\(2\)/, '每个人的金额也按数据渲染');

console.log('donatePage.check 通过');
