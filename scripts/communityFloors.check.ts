import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
	MAX_FLOOR_PAGE,
	floorProgress,
	hupuProgress,
	ngaProgress,
	renderHupuFloorItem,
	renderNgaFloorItem,
} from '../src/lib/communityFloors.ts';
import { ngaReadUrl, parseThreadJson } from '../src/lib/ngaThread.ts';
import { hupuThreadPageUrl, parseHupuThread } from '../src/lib/hupuThread.ts';

/**
 * 社区帖「加载更多回复」这一层的自检。
 *
 * 这一层坏掉**页面照样能看**：首屏是预渲染的静态 HTML，按钮点不动、取错页码、把亮评重复摆一遍，
 * 都不会报错，只有读者一路点到某个角落才发现。所以把四件事钉住：
 *
 * 1. **分页口径**：NGA 的 `page` 参数与 `__PAGE/__ROWS/__R__ROWS_PAGE`、虎扑的
 *    `/<pid>-<n>.html` 与 `{count,size,current,total}`——两边的字段名与页码起点都不一样（虎扑是 0 起），
 *    写反了就是「第二页永远返回第一页的内容」。
 * 2. **「还剩多少」只有一处算术**（`floorProgress`），并且两个源的口径差异被它吸收掉。
 * 3. **渲染只有一处**：首屏与「加载更多」用的是同一个函数，`data-pid` 必须在（浏览器靠它去重），
 *    昵称这类用户文本必须转义。
 * 4. **接口与页面的约定**：接口不能让调用方指定地址、必须有页码上限与 noindex；页面上必须有
 *    触发块与那句「前往原帖」的兜底。
 *
 * 跑：`pnpm check`（或 `node --experimental-strip-types scripts/communityFloors.check.ts`）。
 */

let cases = 0;
const ok = (label: string): void => {
	cases += 1;
	console.log(`  ✓ ${label}`);
};

// ---------------------------------------------------------------- NGA

/** 照 read.php 的形状裁的样本：第 1 页含主楼 0 层与 1–2 层，全帖 36 层、每页 20 层。 */
const NGA_PAGE_1 = {
	data: {
		__PAGE: 1,
		__ROWS: 36,
		__R__ROWS_PAGE: 20,
		__R: [
			{
				lou: 0,
				pid: '100',
				postdatetimestamp: 1791000000,
				score: 3,
				authorid: '60657712',
				content: '主楼正文，说了句够长的话让摘要能取到。',
				hotreply: [
					{ lou: 1, pid: '101', postdatetimestamp: 1791000100, score: 9, authorid: '1', content: '热评一' },
					{ lou: 2, pid: '102', postdatetimestamp: 1791000200, score: 20, authorid: '2', content: '热评二' },
				],
			},
			{ lou: 1, pid: '101', postdatetimestamp: 1791000100, score: 9, authorid: '1', content: '[quote]某位[/quote]正文一' },
			{ lou: 2, pid: '102', postdatetimestamp: 1791000200, score: 0, authorid: '2', content: '正文二' },
			{ lou: 3, pid: '103', postdatetimestamp: 1791000300, score: 0, authorid: '3', content: '' },
		],
	},
};

/** 第 2 页从第 20 层开始，没有主楼。 */
const NGA_PAGE_2 = {
	data: {
		__PAGE: 2,
		__ROWS: 36,
		__R__ROWS_PAGE: 20,
		__R: [
			{ lou: 20, pid: '200', postdatetimestamp: 1791002000, score: 0, authorid: '9', content: '第二页第一层' },
			{ lou: 21, pid: '201', postdatetimestamp: 1791002100, score: 4, authorid: '9', content: '第二页第二层' },
		],
	},
};

{
	const page1 = parseThreadJson(NGA_PAGE_1, 1);
	assert.ok(page1, '第 1 页要能解析出来');
	assert.equal(page1.page, 1);
	assert.equal(page1.perPage, 20, '每页层数取自 __R__ROWS_PAGE');
	assert.equal(page1.totalFloors, 36, '总楼层数取自 __ROWS');
	assert.equal(page1.content, '主楼正文，说了句够长的话让摘要能取到。', '第 1 页的 content 是主楼');
	assert.equal(page1.summary.length > 0, true, '主楼要给得出摘要');
	// 没有正文的楼层（纯图片被吞掉）不该混进列表里。
	assert.deepEqual(
		page1.floors.map((floor) => floor.floor),
		[0, 1, 2],
		'空正文的楼层要丢掉',
	);
	// 热评按赞数倒序，最多 5 条。
	assert.deepEqual(
		page1.hotReplies.map((floor) => floor.score),
		[20, 9],
		'热评按赞数倒序',
	);
	ok('NGA 第 1 页：摘要、楼层、热评与总量');
}

{
	const page2 = parseThreadJson(NGA_PAGE_2, 2);
	assert.ok(page2, '第 2 页没有主楼也应当解析成功（否则读者一点就是空白）');
	assert.equal(page2.content, '', '第 2 页没有主楼，content 必须为空而不是拿第一层冒充');
	assert.equal(page2.summary, '');
	assert.equal(page2.hotReplies.length, 0, '热评只在第 1 页有');
	assert.equal(page2.floors[0].floor, 20, '第 2 页从第 20 层开始');
	ok('NGA 第 2 页：没有主楼也算成功');
}

{
	assert.equal(parseThreadJson({ data: { __R: [] } }, 1), null, '一层都解析不出来要返回 null');
	assert.equal(parseThreadJson({}, 1), null, '没有 data 要返回 null');
	assert.match(ngaReadUrl('47683317', 1), /tid=47683317&__output=11$/, '第 1 页不带 page 参数');
	assert.match(ngaReadUrl('47683317', 3), /&page=3$/, '第 3 页要带 page=3');
	ok('NGA：坏响应与页码参数');
}

// ---------------------------------------------------------------- 虎扑

const hupuFixture = (page: number, listSize = 3): string => {
	const detail = {
		thread: {
			tid: '642044480',
			title: '标题',
			content: '<p>主楼正文足够长，能取到摘要。</p>',
			lights: 1378,
			recommend: 2,
			read: 90000,
			replies: 216,
			createdAt: 1791000000000,
			repliedAt: 1791005000000,
			location: '',
			topic: { name: 'DOTA2' },
		},
		lights: [
			{ pid: '900', content: '<p>亮评一</p>', count: 12, createdAt: 1791001000000, isStarter: false },
			{ pid: '901', content: '<p>亮评二</p>', count: 300, createdAt: 1791002000000, isStarter: true },
		],
		replies: {
			count: 216,
			size: 20,
			current: page,
			total: 11,
			baseUrl: '/642044480_0.html',
			list: Array.from({ length: listSize }, (_value, index) => ({
				pid: `${page}0${index}`,
				content: `<p>第 ${page} 页第 ${index + 1} 条</p>`,
				count: index,
				replyNum: index === 0 ? 2 : 0,
				isStarter: index === 0,
				createdAt: 1791003000000 + index * 1000,
			})),
		},
	};
	return `<html><script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps: { detail } } })}</script></html>`;
};

{
	const page1 = parseHupuThread(hupuFixture(1));
	assert.ok(page1, '虎扑第 1 页要能解析出来');
	assert.equal(page1.page, 1, 'current 直接就是 1 起的页码');
	assert.equal(page1.perPage, 20, '每页条数取自 size');
	assert.equal(page1.totalPages, 11, '总页数取自 total');
	assert.equal(page1.replies, 216, '总回复数取自 thread.replies');
	assert.equal(page1.floors.length, 3);
	assert.deepEqual(
		page1.hotReplies.map((reply) => reply.lights),
		[300, 12],
		'亮评按键降序（接口给的不是排好的）',
	);
	assert.equal(page1.hotReplies[0].isStarter, true, '楼主标记要带上');
	assert.equal(page1.hotReplies[0].createdAt, 1791002000, '虎扑的时间是毫秒，要换成秒');

	const page2 = parseHupuThread(hupuFixture(2));
	assert.ok(page2);
	assert.equal(page2.page, 2);
	assert.equal(page2.floors[0].pid, '200', '第 2 页的回复来自第 2 页那一批');

	assert.equal(hupuThreadPageUrl('642044480', 1), 'https://bbs.hupu.com/642044480.html', '第 1 页就是帖子地址');
	assert.equal(
		hupuThreadPageUrl('642044480', 2),
		'https://bbs.hupu.com/642044480-2.html',
		'第 2 页是 /<pid>-2.html（不是 ?page=2，也不是 baseUrl 那种 _1.html）',
	);
	ok('虎扑：页码、每页条数、亮评排序与地址形态');
}

{
	assert.equal(parseHupuThread('<html>没有 __NEXT_DATA__</html>'), null, '连主楼都抽不出来要返回 null');
	ok('虎扑：结构变了不硬编');
}

// ---------------------------------------------------------------- 还剩多少

{
	const page1 = floorProgress(1, 20, 36);
	assert.equal(page1.remaining, 16, 'NGA 第 1 页之后还剩 16 层（36 层含主楼）');
	assert.equal(page1.nextPage, 2);
	assert.equal(page1.hasMore, true);
	const page2 = floorProgress(2, 20, 36);
	assert.equal(page2.remaining, 0, '尾页不满时不能算出负数');
	assert.equal(page2.hasMore, false);
	assert.equal(page2.nextPage, null);

	const detail = parseHupuThread(hupuFixture(1));
	const progress = hupuProgress(detail as NonNullable<typeof detail>);
	assert.equal(progress.remaining, 196, '虎扑按总回复数算：216 − 20');
	assert.equal(progress.hasMore, true);

	const ngaDetail = parseThreadJson(NGA_PAGE_1, 1);
	assert.equal(ngaProgress(ngaDetail as NonNullable<typeof ngaDetail>).remaining, 16);
	ok('「还剩多少」：两个源口径不同但走同一条算术');
}

// ---------------------------------------------------------------- 渲染

{
	const html = renderNgaFloorItem(
		{ pid: '102', floor: 2, time: 1791000200, score: 3, content: '[b]正文[/b]', authorId: '2' },
		{ nickname: '<script>alert(1)</script>', now: 1791001000 },
	);
	assert.match(html, /data-pid="102"/, '浏览器靠 data-pid 去重，必须在');
	assert.ok(!html.includes('<script>alert(1)</script>'), '昵称是用户文本，必须转义');
	assert.match(html, /#2 楼/, '普通楼层要带楼层号');
	assert.match(html, /<strong>正文<\/strong>/, 'NGA 正文走 BBCode 渲染（[b] → <strong>）');

	const hot = renderNgaFloorItem(
		{ pid: '101', floor: 1, time: 1791000100, score: 9, content: 'x', authorId: '1' },
		{ now: 1791001000, highlighted: true },
	);
	assert.match(hot, /赞 9/, '热评那段把赞数提到最前面');

	const hupuHtml = renderHupuFloorItem(
		{ pid: '77', author: '虎扑用户', lights: 2, replyNum: 0, isStarter: false, createdAt: 1791000200, content: '<p>x</p>' },
		{ now: 1791001000 },
	);
	assert.match(hupuHtml, /data-pid="77"/);
	assert.match(hupuHtml, /亮 2/);
	ok('渲染：data-pid、转义与两种形态');
}

// ---------------------------------------------------------------- 接口与页面的约定

{
	const api = readFileSync(new URL('../src/pages/api/community/floors.ts', import.meta.url), 'utf8');
	assert.match(api, /'X-Robots-Tag': 'noindex'/, '这条接口不可索引，否则爬虫会把它当成刷上游的代理');
	assert.match(api, /page > MAX_FLOOR_PAGE/, '页码要有上限');
	assert.match(api, /source !== 'nga' && source !== 'hupu'/, 'source 只认这两个源');
	assert.ok(!/searchParams\.get\('url'\)/.test(api), '不能接调用方给的地址');
	assert.ok(!/href=/.test(api), '接口里不该出现链接');
	assert.ok(MAX_FLOOR_PAGE >= 10, '页码上限别小到正常帖子都翻不完');

	for (const [file, source] of [
		['../src/pages/community/nga/[tid].astro', 'nga'],
		['../src/pages/community/hupu/[pid].astro', 'hupu'],
	] as const) {
		const page = readFileSync(new URL(file, import.meta.url), 'utf8');
		assert.match(page, /data-floors-more/, `${file} 要有「加载更多」的触发块`);
		assert.match(page, new RegExp(`data-source="${source}"`), `${file} 要写明是哪个源`);
		assert.match(page, /data-floors-list/, `${file} 的楼层列表要标出追加目标`);
		assert.match(page, /前往原帖/, `${file} 要保留去原帖的兜底出口`);
		assert.match(page, /import '\.\.\/\.\.\/\.\.\/scripts\/communityMore'/, `${file} 要引入加载逻辑`);
		assert.match(page, /render(Hupu|Nga)Floors/, `${file} 的楼层要走上共用的渲染函数`);
	}
	ok('接口与页面：noindex、上限、触发块与共用渲染');
}

console.log(`communityFloors 全部断言通过（${cases} 组）`);
