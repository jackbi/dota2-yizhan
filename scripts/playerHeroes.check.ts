import assert from 'node:assert/strict';
import type { PlayerMatchRow } from '../src/lib/heroPool.ts';
import { summarizeHeroPool } from '../src/lib/heroPool.ts';

/**
 * 「选手招牌英雄」的挑选规则。
 *
 * 这块最容易悄悄错的是**版本口径**：本版本样本不够时要回退到更长的窗口，而回退之后
 * 必须如实标成跨版本——标错了页面上照样显示得好好的，只是那个名单其实不是本版本的。
 * 第二条是英雄门槛：只打过一场的英雄上榜就是噪音，而这个错读者是能感觉到的（"这也算擅长？"）。
 *
 * 跑：`pnpm check`（或 `node --experimental-strip-types scripts/playerHeroes.check.ts`）。
 */

let cases = 0;
const ok = (label: string): void => {
	cases += 1;
	console.log(`  ✓ ${label}`);
};

const PATCH_START = 1_000_000;
const OPTIONS = { patchStart: PATCH_START, version: '7.41f' };

/** 造几场「这位选手用某英雄、结果某」的比赛。`beforePatch` 决定它算不算本版本。 */
function games(heroId: number, count: number, wins: number, beforePatch = false): PlayerMatchRow[] {
	return Array.from({ length: count }, (_, index) => ({
		heroId,
		win: index < wins,
		startTime: (beforePatch ? PATCH_START - 100 : PATCH_START + 100) + index,
	}));
}

// 1. 本版本样本够（≥5 场）就用本版本，且不掺版本之前的场次
{
	const pool = summarizeHeroPool(
		[
			...games(1, 3, 2),
			...games(2, 2, 2),
			...games(3, 1, 0),
			// 上一个版本打了 5 场同一个英雄——回退时它会是第一名，本版本够用就不该出现
			...games(9, 5, 5, true),
		],
		OPTIONS,
	);
	assert.ok(pool, '本版本样本够，应当有结果');
	assert.equal(pool.scope, 'patch', '样本全在本版本内，口径就是 patch');
	assert.equal(pool.version, '7.41f');
	assert.equal(pool.games, 6, '只统计本版本的 6 场');
	assert.deepEqual(
		pool.heroes.map((h) => [h.heroId, h.games, h.wins]),
		[
			[1, 3, 2],
			[2, 2, 2],
		],
		'场次多的在前；只打一场的英雄（3）不进榜；上版本的英雄（9）在这条路上不出现',
	);
	assert.equal(pool.since, PATCH_START + 100, '窗口起点是选中样本的第一场');
	ok('本版本够用：只用本版本、只留打满门槛的英雄');
}

// 2. 本版本不够（<5 场）才回退，而且必须标成跨版本
{
	const pool = summarizeHeroPool([...games(1, 2, 1), ...games(2, 4, 2, true), ...games(3, 3, 3, true)], OPTIONS);
	assert.ok(pool);
	assert.equal(pool.scope, 'window', '回退之后样本里有版本之前的场次，口径必须写 window');
	assert.equal(pool.games, 9, '回退时统计整个窗口');
	assert.equal(pool.heroes[0]?.heroId, 2, '回退后按整个窗口排，场次最多的那个在前');
	assert.equal(pool.since, PATCH_START - 100, '窗口起点跟着回退');
	ok('本版本不够：回退整个窗口，并把口径改成跨版本');
}

// 3. 门槛：一个英雄只打过一场就不算「擅长」；全都只打过一场时宁可不给结果
{
	const oneEach = summarizeHeroPool([1, 2, 3, 4, 5, 6].map((heroId) => ({ heroId, win: true, startTime: PATCH_START + heroId })), OPTIONS);
	assert.equal(oneEach, null, '每个英雄都只打一场，等于没有招牌英雄，返回 null 而不是硬凑五个');

	const withTwo = summarizeHeroPool([...games(7, 2, 1), ...games(8, 1, 1), ...games(9, 1, 0), ...games(10, 1, 0)], OPTIONS);
	assert.deepEqual(
		withTwo?.heroes.map((h) => h.heroId),
		[7],
		'只留打满两场的那个，其余单场的丢掉',
	);
	ok('英雄门槛：至少两场才算擅长');
}

// 4. 没有对局就没有结论（新版本刚开、或者这支队这几周没打官方赛）
{
	assert.equal(summarizeHeroPool([], OPTIONS), null);
	ok('一场都没有：返回 null，页面不显示这一块');
}

console.log(`playerHeroes 全部断言通过（${cases} 组）`);
