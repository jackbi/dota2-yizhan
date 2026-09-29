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

// 2. 列表行（挑房间的地方）与格子（待播时的遮罩）各画一处，且都转义
{
	const noteLines = wall.split('\n').filter((line) => line.includes('r.note'));
	assert.ok(noteLines.length >= 2, `note 至少要在列表行与格子里各画一处，现在只有 ${noteLines.length} 处`);
	for (const line of noteLines) {
		assert.ok(line.includes('esc(r.note)'), `note 要转义（内容来自上游）：${line.trim()}`);
	}
	assert.match(wall, /title="\$\{esc\(r\.note\)\}"/, '列表行那条要带 title，截断之后还能悬停看全');
	ok('列表行与格子各画一处，且都转义');
}

// 3. 首页那条（SSR，走 LiveCard）也不能只给绿点
{
	assert.match(card, /live\?\.note &&/, '首页直播条要画 note');
	assert.match(card, /\{live\.note\}/, '首页那条用文本插值（Astro 会自动转义）');
	ok('首页直播条也画 note');
}

console.log(`liveWall 全部断言通过（${cases} 组）`);
