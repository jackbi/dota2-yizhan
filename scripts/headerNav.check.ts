import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { NAV } from '../src/data/site.ts';

/**
 * 导航的自检：页头右侧那一组，加上「每个导航项都得有页面」。
 *
 * 顺序是固定的：**开源仓库 · AI 设置 · Steam 登录**。前两个原先分别只在页脚的链接表和页脚
 * 底行，页头没有入口；它们被挪走或删掉时**页面照样能看**，只是想看代码、想配自己那把 key 的人
 * 找不到地方——这类"坏掉了不报错"的正是这一层要钉的东西。
 *
 * 小屏只留图标（文字到 xl 才出现），所以两个链接都必须带 `aria-label`，否则读屏的访问者
 * 只能听到一个没有名字的链接。
 *
 * 第二组是主导航项与页面的对应关系。加一个导航项最容易漏的一步就是忘了建那个页面：
 * 链接照样渲染、照样能点，点下去才是 404，而 404 不会让构建失败。
 *
 * 跑：`pnpm check`（或 `node --experimental-strip-types scripts/headerNav.check.ts`）。
 */

const layout = readFileSync(new URL('../src/layouts/Layout.astro', import.meta.url), 'utf8');
const start = layout.indexOf('<header');
const header = start >= 0 ? layout.slice(start, layout.indexOf('</header>')) : '';
assert.ok(header.length > 500, '没从 Layout.astro 里切出页头，解析多半坏了');

const REPO_URL = 'https://github.com/jackbi/dota2-yizhan';
const DONATE = 'href="/donate"';

assert.ok(header.includes(REPO_URL), '开源仓库的入口要在页头');
assert.ok(header.includes(DONATE), '赞赏的入口要在页头');
assert.ok(header.includes('href="/settings"'), 'AI 设置的入口要在页头');

/*
 * 位置：都在登录入口的**左边**。这是这一页的用户明确要的排布，也是"右侧这一组"里唯一
 * 能自动检查的部分——`justify-between` 会让它们在视觉上贴到右边，但顺序只由标记决定。
 */
const authAt = header.indexOf('<AuthEntry />');
assert.ok(authAt > 0, '页头要有 Steam 登录入口');
assert.ok(header.indexOf(REPO_URL) < authAt, '开源仓库要排在 Steam 登录左边');
assert.ok(header.indexOf(DONATE) < authAt, '赞赏要排在 Steam 登录左边');
assert.ok(header.indexOf('href="/settings"') < authAt, 'AI 设置要排在 Steam 登录左边');
// 「在设置旁边」：赞赏要挨着 AI 设置，排在它左边。
assert.ok(header.indexOf(DONATE) < header.indexOf('href="/settings"'), '赞赏要挨着 AI 设置（排在它左边）');

// 外链不能把 referrer 带出去，也不能让打开的页面反向控制本站窗口。
assert.match(
	header,
	/href="https:\/\/github\.com\/jackbi\/dota2-yizhan"[\s\S]{0,200}?rel="noopener noreferrer"/,
	'开源仓库是外链，要带 rel="noopener noreferrer"',
);

// 小屏只剩图标，链接必须有可读的名字。
assert.match(header, /aria-label="开源仓库"/, '图标态要能被读屏念出来（aria-label）');
assert.match(header, /aria-label="赞赏项目"/, '图标态要能被读屏念出来（aria-label）');
assert.match(header, /aria-label="AI 设置"/, '图标态要能被读屏念出来（aria-label）');
assert.match(header, /title="[^"]*源码[^"]*"/, '图标态要有 title 提示');
assert.match(header, /title="[^"]*咖啡[^"]*"/, '图标态要有 title 提示');

/*
 * **这几个入口都只留图标**：右侧这一组后面还有登录入口，加上文字会把中间那排导航挤到换行
 * （`justify-between` 下最先被牺牲的就是它们）。所以这里钉住"没有可见文字"，名字只走
 * aria-label 与 title——少了那两样，图标就成了一个没有名字的链接。
 */
assert.ok(!/>\s*开源仓库\s*</.test(header), '开源仓库只留图标：文字会把导航挤换行');
assert.ok(!/>\s*赞赏项目\s*</.test(header), '赞赏只留图标：文字会把导航挤换行');
assert.ok(!/>\s*AI 设置\s*</.test(header), 'AI 设置只留图标：文字会把导航挤换行');

// 站在这一页上时它要能高亮，否则读者不知道自己在这一页。
assert.match(header, /aria-current=\{isActive\('\/settings'\)/, 'AI 设置要以当前页高亮');
assert.match(header, /aria-current=\{isActive\('\/donate'\)/, '赞赏要以当前页高亮');

/*
 * 导航项到页面的映射：`/teams` 可能是 `src/pages/teams.astro`，也可能是
 * `src/pages/teams/index.astro`，两种都认（`/news` 现在是前者、曾经是后者）。
 * 首页那条是空段，对应 `src/pages/index.astro`。NAV 里的 `href` 带不带尾斜杠都行。
 */
{
	const PAGES = new URL('../src/pages/', import.meta.url);
	for (const item of NAV) {
		const segment = item.href.replace(/^\/+|\/+$/g, '');
		const candidates = segment === '' ? ['index.astro'] : [`${segment}.astro`, `${segment}/index.astro`];
		assert.ok(
			candidates.some((rel) => existsSync(new URL(rel, PAGES))),
			`导航项「${item.label}」（${item.href}）没有对应的页面：${candidates.join(' 与 ')} 都不存在`,
		);
	}
	console.log(`  ✓ 导航 ${NAV.length} 项都指向真实存在的页面`);
}

console.log('headerNav.check 通过');
