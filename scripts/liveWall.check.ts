import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/**
 * `/live` 监控室那几处「构建期说明有没有真的画出来」的静态自检。
 *
 * `LiveStatus.note` 是构建期写下的补充说明：旧缓存兜底时它是「这是 N 分钟前的快照」，
 * 平台关了播放时它是「房间还在、播放被关了」。**绿点本身不会说这些**——不画出来，读者
 * 只会看到一个干净的「直播中」。踩过的坑是两个方向都出现过：先是全仓没人读它，
 * 后来只画在待播遮罩上（一点播放，遮罩连同说明一起被移除），左列表行仍然看不到。
 *
 * 这一页的渲染是客户端拼字符串（`liveWall.ts`），没有单元测试可挂，所以对着源码钉：
 * 列表行与格子各有一处，且都走 `esc()`（note 里可能有主播昵称这类上游内容）。
 *
 * 跑：`pnpm check`（或 `node --experimental-strip-types scripts/liveWall.check.ts`）。
 */

const wall = readFileSync(new URL('../src/scripts/liveWall.ts', import.meta.url), 'utf8');
const types = readFileSync(new URL('../src/data/types.ts', import.meta.url), 'utf8');
const page = readFileSync(new URL('../src/pages/live.astro', import.meta.url), 'utf8');
const card = readFileSync(new URL('../src/components/LiveCard.astro', import.meta.url), 'utf8');

let cases = 0;
const ok = (label: string): void => {
	cases += 1;
	console.log(`  ✓ ${label}`);
};

// 1. note 得从构建期一路带到客户端
{
	assert.match(types, /\/\*\*[\s\S]*?开播状态的补充说明[\s\S]*?\*\/\s*note\?: string;/, 'RoomRef 要带 note 字段');
	assert.match(page, /note: s\?\.note,/, '监控室的内联数据要带上 note');
	ok('note 从构建期传到客户端');
}

// 2. 列表行（挑房间的地方）与格子各画一处，且都转义；格子里那处要**常驻**
{
	const noteLines = wall.split('\n').filter((line) => line.includes('r.note'));
	assert.ok(noteLines.length >= 2, `note 至少要在列表行与格子里各画一处，现在只有 ${noteLines.length} 处`);
	for (const line of noteLines) {
		assert.ok(line.includes('esc(r.note)'), `note 要转义（内容来自上游）：${line.trim()}`);
	}
	assert.match(wall, /title="\$\{esc\(r\.note\)\}"/, '列表行那条要带 title，截断之后还能悬停看全');

	/*
	 * 格子那处必须画在**待播遮罩之外**。
	 *
	 * 点播放时 `tile.querySelector('.tile-idle')?.remove()` 会把整层遮罩拆掉——说明挂在里面就
	 * 跟着没了。沉浸模式下 `#wall-panel` 是 fixed/inset:0，直接把左列表盖住，画面上于是再也没有
	 * 任何提示（"这个绿点是旧快照"、"平台已经关了播放"全看不到了）。
	 */
	const idleStart = wall.indexOf('class="tile-idle');
	assert.ok(idleStart > 0, '没找到待播遮罩，解析多半坏了');
	// 遮罩外面那层 `.tile-body` 收口在 3 个 tab 的 `</div>`，先出现的就是它。
	const idleEnd = wall.indexOf('\n\t\t\t</div>', idleStart);
	const idleBlock = wall.slice(idleStart, idleEnd);
	assert.ok(idleBlock.length > 0 && idleBlock.length < 3000, '没切出待播遮罩块，解析多半坏了');
	assert.ok(!idleBlock.includes('r.note'), '说明不能画在待播遮罩里：点播放时遮罩被整体移除，说明跟着消失');
	assert.match(wall, /class="tile-note[^"]*"/, '格子里的说明要有一个自己的常驻元素');

	/*
	 * 也不能贴格子底边：那一带是控制条的地盘——取景微调与播放控制都是 `bottom-2 left-2 z-10`，
	 * 斗鱼的「打开直播间」是 `bottom-2 right-2 z-10` 配近乎不透明的底色。横幅原先挂在
	 * `.tile-body` 之后（最后一条流内元素），正好落进这二十几像素里，文字被按钮糊住：
	 * 说明留在了 DOM 里，人还是看不见。所以它必须在画面**之前**。
	 */
	const noteAt = wall.indexOf('class="tile-note');
	const bodyAt = wall.indexOf('class="tile-body');
	assert.ok(noteAt > 0 && bodyAt > 0, '没找到说明横幅或画面容器，解析多半坏了');
	assert.ok(noteAt < bodyAt, '说明横幅要画在画面之前：格子底边被控制条占着，贴上去会被糊住');
	ok('列表行与格子各画一处、都转义，格子那处在遮罩之外且在控制条之上');
}

// 3. 首页那条（SSR，走 LiveCard）也不能只给绿点
{
	assert.match(card, /live\?\.note &&/, '首页直播条要画 note');
	assert.match(card, /\{live\.note\}/, '首页那条用文本插值（Astro 会自动转义）');
	ok('首页直播条也画 note');
}

console.log(`liveWall 全部断言通过（${cases} 组）`);
