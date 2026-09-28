import assert from 'node:assert/strict';
import { collectNicknames, renderNgaPost } from '../src/lib/ngaBbcode.ts';

/**
 * `src/lib/ngaBbcode.ts` 的自检。
 *
 * NGA 楼层正文是**用户内容**，而渲染结果会经 `set:html` 注入页面——转义顺序（先反转义、
 * 再统一转义、最后才做 BBCode → HTML 替换）是唯一的一道防线。顺序一乱，或者哪个标签忘了
 * 走转义，就是本站域名下的存储型 XSS。
 *
 * 所以下面盯的是"输出里没有可执行的东西"，不是"输出等于某个字符串"：
 *
 * 1. 白名单之外的标签一个都不留（正文里的尖括号必须变成可见文字）；
 * 2. 标签的属性值里不能有裸引号——否则用户写一个 `"` 就能提前关掉 `src="…"` 再挂 `onerror`；
 * 3. `[url=javascript:…]` 这类地址一律不生成链接，`[img]` 只认白名单里的几种来源。
 *
 * 跑：`pnpm check`（或 `node --experimental-strip-types scripts/ngaBbcode.check.ts`）。
 */

let cases = 0;
const ok = (label: string): void => {
	cases += 1;
	console.log(`  ✓ ${label}`);
};

/**
 * 我们自己会生成的标签（与 `renderNgaPost` 里的那几种一一对应）。
 *
 * 属性部分只接受 `名字="值"`、且值里没有裸引号与尖括号的写法——这条同时管住两件事：
 * 用户正文里的 `<` 不会被当成标签，用户正文里的 `"` 也关不掉我们的属性。
 */
const OWN_TAG_RE = /<\/?(?:br|strong|em|u|del|details|summary|div|blockquote|img|span|a)((?:\s+[a-z-]+="[^"<>]*")*)\s*\/?>/g;

function assertNoForeignTags(output: string, what: string): void {
	const rest = output.replace(OWN_TAG_RE, '');
	assert.ok(
		!/[<>]/.test(rest),
		`${what}：除了白名单标签，正文里的尖括号都该是转义后的可见文字 → ${output}`,
	);
}

// 1. 正文里的 HTML 标签不能变成活标签
{
	const output = renderNgaPost('[b]粗[/b]<script>alert(1)</script><img src=x onerror=alert(1)>');
	assert.ok(!/<script/i.test(output), `不该留下 <script> → ${output}`);
	assert.ok(!/<img/i.test(output), `不该留下用户写的 <img> → ${output}`);
	assert.ok(output.includes('&lt;script&gt;'), '尖括号应当变成可见的文字');
	assertNoForeignTags(output, 'HTML 混在 BBCode 里');
	ok('正文里的 HTML 标签只留文字');
}

// 2. 引号不能关掉我们的属性（[img] 与 [url] 两条路都要挡）
{
	const output = renderNgaPost('[img]https://img.nga.cn/a.jpg" onerror="alert(1)[/img]');
	assertNoForeignTags(output, 'img 地址里塞引号');
	assert.ok(!/"\s+onerror="/.test(output), `属性没有被提前关掉 → ${output}`);

	const link = renderNgaPost('[url=https://bbs.nga.cn/a?x=1&y=2"]x[/url]');
	assertNoForeignTags(link, 'url 地址里塞引号');
	ok('引号关不掉属性');
}

// 3. 危险协议：只留文字，不生成链接
{
	for (const payload of [
		'[url=javascript:alert(1)]点我[/url]',
		'[url=JavaScript:alert(1)]点我[/url]',
		'[url=  javascript:alert(1)]点我[/url]',
		'[url=data:text/html,<script>alert(1)</script>]点我[/url]',
		'[url=/relative/x]点我[/url]',
	]) {
		const output = renderNgaPost(payload);
		assert.ok(!/<a\b/i.test(output), `${payload} 不该生成链接 → ${output}`);
		assert.ok(output.includes('点我'), '文字仍要留着，只是不当链接');
		assertNoForeignTags(output, payload);
	}
	const good = renderNgaPost('[url=https://bbs.nga.cn/read.php?tid=1]公告[/url]');
	assert.ok(good.includes('<a href="https://bbs.nga.cn/read.php?tid=1"'), `正常地址要能成链 → ${good}`);
	ok('只给 http(s) 生成链接');
}

// 4. 图片：只认绝对地址、站内路径与附件相对路径，且一律抬成 https
{
	assert.equal(renderNgaPost('[img]javascript:alert(1)[/img]'), '', '不认识的来源直接不渲染');
	assert.equal(renderNgaPost('[img]ftp://x/y.jpg[/img]'), '');
	assert.equal(
		renderNgaPost('[img]http://img.nga.cn/a.jpg[/img]'),
		'<img src="https://img.nga.cn/a.jpg" alt="" loading="lazy" referrerpolicy="no-referrer" />',
		'http 要抬成 https：页面上是 https，混内容会被浏览器拦掉',
	);
	assert.equal(
		renderNgaPost('[img]//img.nga.cn/a.jpg[/img]'),
		'<img src="https://img.nga.cn/a.jpg" alt="" loading="lazy" referrerpolicy="no-referrer" />',
	);
	assert.equal(
		renderNgaPost('[img]./mon_202609/07/a.jpg[/img]'),
		'<img src="https://img.nga.cn/attachments/mon_202609/07/a.jpg" alt="" loading="lazy" referrerpolicy="no-referrer" />',
		'附件相对路径要补上附件基址',
	);
	assert.equal(
		renderNgaPost('[img]/attachments/a.jpg[/img]'),
		'<img src="https://bbs.nga.cn/attachments/a.jpg" alt="" loading="lazy" referrerpolicy="no-referrer" />',
	);
	ok('图片白名单与协议抬升');
}

// 5. 常用 BBCode 照旧渲染
{
	assert.equal(renderNgaPost('[b]粗[/b]'), '<strong>粗</strong>');
	assert.equal(renderNgaPost('[i]斜[/i][u]下划[/u][del]删[/del]'), '<em>斜</em><u>下划</u><del>删</del>');
	assert.equal(renderNgaPost('[quote]引用[/quote]'), '<blockquote class="nga-quote">引用</blockquote>');
	assert.equal(
		renderNgaPost('[collapse=摘要]里面[/collapse]'),
		'<details class="nga-collapse"><summary>摘要</summary><div>里面</div></details>',
	);
	assert.ok(renderNgaPost('[collapse]里面[/collapse]').includes('<summary>展开</summary>'), '折叠块没给标题时用默认文案');
	assert.equal(
		renderNgaPost('[uid=123]某位[/uid]'),
		'<a href="https://bbs.nga.cn/nuke.php?func=ucp&uid=123" target="_blank" rel="noopener noreferrer nofollow">某位</a>',
	);
	assert.equal(
		renderNgaPost('[pid=456,789]某楼[/pid]'),
		'<a href="https://bbs.nga.cn/read.php?pid=456" target="_blank" rel="noopener noreferrer nofollow">某楼</a>',
		'pid 可以给一串，取第一个',
	);
	assert.equal(
		renderNgaPost('[tid=9]某帖[/tid]'),
		'<a href="https://bbs.nga.cn/read.php?tid=9" target="_blank" rel="noopener noreferrer nofollow">某帖</a>',
	);
	assert.equal(renderNgaPost('[s:微笑]'), '<span class="nga-emote">微笑</span>', '表情渲染成文字标签（表情图部分网络不可达）');
	assert.equal(renderNgaPost('[完全没见过的标签]文字[/完全没见过的标签]'), '文字', '没处理的标签去掉标记、保留文字');
	ok('常用 BBCode');
}

// 6. 换行与空白：官方换行与真实换行都统一成 <br/>，行首尾不留空白
{
	assert.equal(renderNgaPost('第一行<br/>第二行'), '第一行<br/>第二行');
	assert.equal(renderNgaPost('  第一行  \n 第二行 '), '第一行<br/>第二行');
	assert.equal(renderNgaPost('第一行<br />第二行'), '第一行<br/>第二行', '自闭合写法也要认');
	ok('换行归一');
}

// 7. 引用里的昵称是站内唯一能拿到真实昵称的来源（未登录访问别处都被打码）
{
	const nicknames = collectNicknames([
		'[quote][uid=111]张三[/uid]：说过一句[/quote]',
		'[uid=222]UID:222[/uid] 自己的楼是打码的',
		'[uid=333]  [/uid]',
		'[uid=444]李四[/uid][uid=444]李四[/uid]',
	]);
	assert.equal(nicknames.get('111'), '张三');
	assert.equal(nicknames.has('222'), false, '打码的昵称不要当名字收进去');
	assert.equal(nicknames.has('333'), false, '只有空白的也不要');
	assert.equal(nicknames.size, 2, '同一个 uid 只留一条');
	ok('从引用里收昵称');
}

console.log(`ngaBbcode 全部断言通过（${cases} 组）`);
