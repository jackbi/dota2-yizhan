import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { sourceState } from '../src/lib/dataHealth.ts';

/**
 * 「这一源的数据是从哪来的」这份说明要如实。
 *
 * 构建汇总里每个源都有一行（`fresh` 联网抓取 / `cache` 使用缓存 / `empty` 没有数据）。
 * 一个源常常有**两级数据**：列表是主，详情/正文是次，两者缓存的 TTL 各管各的。原先五个源
 * 按抓取次数判（四个用自己模块里的计数，热门直播间用取数层那个**进程级**的），于是
 * "列表吃旧缓存兜底、详情补抓了几个"会被写成"联网抓取"——上游挂着的那一轮，恰好是这份旧数据
 * 最像新数据的时候。`liveApi` 早先改成了按房间记来源，这五个是同一种形状，
 * `src/lib/dataHealth.ts` 的 `sourceState` 就是那套判据。
 *
 * 分工与 `liveApi` 那边一致：行为断言只钉 `sourceState` 本身；**谁把哪个来源接上去**靠读源码
 * 钉住——把某个源的接线换成次要数据的来源，行为断言照样全绿。
 *
 * 跑：`pnpm check`（或 `node --experimental-strip-types scripts/sourceState.check.ts`）。
 */

let cases = 0;
const ok = (label: string): void => {
	cases += 1;
	console.log(`  ✓ ${label}`);
};

// 1. 优先级：一条数据都没有就是"没拿到"，哪怕这一轮确实发过请求
{
	assert.equal(sourceState(true, 3), 'fresh', '主数据本轮抓到了就是联网抓取');
	assert.equal(sourceState(false, 3), 'cache', '主数据吃缓存就是使用缓存');
	assert.equal(sourceState(false, 0), 'empty', '一份数据都没有就是没拿到');
	assert.equal(
		sourceState(true, 0),
		'empty',
		'页面取回来了却一条都没解析出来（结构变了）也不能算新数据，和 liveApi 那边全未知算没拿到是同一档',
	);
	ok('状态：先看有没有数据，再看它是不是本轮抓的');
}

// 2. 接线：状态要取自**主数据（列表）**的来源，不能取自会被详情/正文顶起来的模块级计数
{
	const ROOT = new URL('../', import.meta.url);
	const read = (name: string): string => readFileSync(new URL(`src/lib/${name}`, ROOT), 'utf8');

	for (const [name, label, wiring] of [
		['newsApi.ts', '官方新闻', /sourceState\(listFetched > 0, list\.length\)/],
		['hupuApi.ts', '虎扑 DOTA2 区', /sourceState\(board\.network, threads\.length\)/],
		['ngaApi.ts', 'NGA 刀塔版块', /sourceState\(listFetched > 0, threads\.length\)/],
		['patchesApi.ts', '官方更新日志', /sourceState\(list\.network, updates\.length\)/],
		['roomList.ts', '热门直播间', /sourceState\(douyu\.fetched \|\| huya\.fetched, usable\)/],
	] as const) {
		const code = read(name);
		assert.match(code, wiring, `${label}的状态要接在列表那一级的来源上`);
		assert.ok(
			!/networkFetches > 0 \? 'fresh'/.test(code),
			`${label}不能再拿模块级的抓取次数当状态：详情/正文补抓一次就把整源顶成"联网抓取"`,
		);
		ok(`${label}：状态取自列表的来源`);
	}

	// 热门直播间那处形状不同：原先读的是取数层的进程级计数，缺陷是"**别的源**抓过东西也算它抓过"。
	assert.ok(
		!/note \? 'fresh'/.test(read('roomList.ts')),
		'热门直播间不能拿 fetchNote() 判状态：那是整个进程的抓取次数，别的源抓过它也会非空',
	);
	ok('热门直播间：不拿进程级的抓取次数当状态');
}

console.log(`sourceState 全部断言通过（${cases} 组）`);
