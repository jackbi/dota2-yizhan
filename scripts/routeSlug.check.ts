import assert from 'node:assert/strict';
import { isPathSegment, routeSlug } from '../src/lib/routeSlug.ts';

/**
 * `src/lib/routeSlug.ts` 的自检。**这一层坏掉的代价是整站构建失败**——不是某一个页面少了。
 *
 * 踩过两次同款：Liquipedia 的赛事路径、OpenDota 的队名（实测出现过 `team yosi/vape`，
 * 还有一个队名就是一个 `?`）。队名里只要有 `/`，Astro 就把它当两段路径、抛
 * `Missing parameter: id`，把整轮构建打断——线上只能停在上一份产物上。
 *
 * 所以这里钉的不是"输出等于某个好看字符串"，而是**输出永远是安全的路径段**：
 * 用一批真实的脏名字（含斜杠、问号、百分号、控制字符、纯标点）过一遍，
 * 断言结果里不含任何会让 Astro 分段或让 URL 变形的字符。
 *
 * 跑：`pnpm check`（或 `node --experimental-strip-types scripts/routeSlug.check.ts`）。
 */

let cases = 0;
const ok = (label: string): void => {
	cases += 1;
	console.log(`  ✓ ${label}`);
};

// 1. 真实踩过的那两个
{
	assert.equal(routeSlug('team yosi/vape'), 'team-yosi-vape', '斜杠必须折叠掉，否则 Astro 会把 id 当成两段路径');
	assert.equal(routeSlug('?'), '', '只有一个问号的队名会产出空 id（调用方要按 isPathSegment 过滤）');
	assert.equal(routeSlug('Team Spirit'), 'team-spirit');
	ok('实测过的那两个脏名字');
}

// 2. 形状：转小写、连字符折叠、首尾不留连字符、汉字保留
{
	assert.equal(routeSlug('中国 DOTA2 超级联赛'), '中国-dota2-超级联赛');
	assert.equal(routeSlug('--a--b--'), 'a-b');
	assert.equal(routeSlug('a   b'), 'a-b', '连续分隔符压成一个');
	assert.equal(routeSlug('  ABC  '), 'abc');
	assert.equal(routeSlug('liquipedia/2026/ESL_One'), 'liquipedia-2026-esl-one');
	ok('大小写、分隔符折叠与汉字保留');
}

// 3. 不变量：不管喂什么，结果都不会带 `/` `\` `?` `#` `%` 或控制字符
{
	const nasty = [
		'team yosi/vape',
		'a\\b',
		'a?b',
		'a#b',
		'a%2Fb',
		'a/b/c',
		'../../etc/passwd',
		'%00',
		'a\u0000b\u001fc',
		'<script>alert(1)</script>',
		'名字/带斜杠/还有?问号',
		'😀 emoji 队伍',
		'',
		'   ',
		'---',
	];
	for (const value of nasty) {
		const slug = routeSlug(value);
		assert.ok(!/[/\\?#%\u0000-\u001f]/.test(slug), `${JSON.stringify(value)} 出来的 ${JSON.stringify(slug)} 还带着不安全字符`);
		assert.ok(!/^-|-$/.test(slug), `${JSON.stringify(value)} 出来的 ${JSON.stringify(slug)} 首尾还有连字符`);
		assert.ok(slug === '' || isPathSegment(slug), `${JSON.stringify(value)} 出来的 ${JSON.stringify(slug)} 过不了 isPathSegment`);
	}
	ok('脏名字一律产出安全路径段（或空串）');
}

// 4. isPathSegment：getStaticPaths 的兜底判据，宽严都要对
{
	assert.equal(isPathSegment('team-spirit'), true);
	assert.equal(isPathSegment('中国'), true);
	assert.equal(isPathSegment('a'.repeat(120)), true, '长度上限之内可用');
	assert.equal(isPathSegment('a'.repeat(121)), false, '超过长度上限就别当路径段');
	assert.equal(isPathSegment(''), false, '空串会让 Astro 抛 Missing parameter');
	assert.equal(isPathSegment('a/b'), false);
	assert.equal(isPathSegment('a\\b'), false);
	assert.equal(isPathSegment('a?b'), false);
	assert.equal(isPathSegment('a#b'), false);
	assert.equal(isPathSegment('a%b'), false);
	assert.equal(isPathSegment('a\u0007b'), false, '控制字符不进路径');
	assert.equal(isPathSegment('a b'), true, '空格是合法的路径段字符（URL 里会编码，但 Astro 不分段）');
	ok('isPathSegment 的宽严');
}

console.log(`routeSlug 全部断言通过（${cases} 组）`);
