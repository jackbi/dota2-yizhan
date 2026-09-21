import assert from 'node:assert/strict';
import {
	LANE_MIN_GAMES,
	buildLaneSlice,
	formatNet,
	laneCell,
	laneEdge,
	laneEdgeEither,
	laneEdgeText,
} from '../src/lib/draftLanes.ts';

/**
 * 线上对位（`draftLanes`）的自检。三处会静默算错的地方：
 *
 * 1. **净对线的分母**。STRATZ 给的是胜 / 负 / 平三个数，写成「胜 / 场次」会把平局算成输；
 *    口径是 (胜 − 负) / 场次，平局只在分母里出现。
 * 2. **平均值不是加权平均**。一格 50 场、一格 5,000 场时按场次加权会让大样本那格吃掉整条依据，
 *    而站内其它对位口径（`draftScore.counterSummary`）都是各格等权平均。
 * 3. **门槛**。线上样本天然比整局小，门槛写松会把个位数场次的噪声塞进依据里。
 *
 * 跑：`pnpm check`（或 `node --experimental-strip-types scripts/draftLanes.check.ts`）。
 */
let cases = 0;
const ok = (label: string): void => {
	cases += 1;
	console.log(`  ✓ ${label}`);
};

// ---- 号位由调用方给，**不看行里的 `position` ----
//
// 这是真踩过的坑：批量查询（不带 `heroId`）时上游那个字段永远是 `POSITION_1`——
// 按五号位问水晶室女会回来 8,183 场，行的 `position` 却写 `POSITION_1`，而按一号位问只有 19 场。
// 过滤是准的，字段不能信。照它分组的话，全表会落进一号位，其余号位永远查不到东西。
{
	const rows = [{ heroId1: 62, heroId2: 10, position: 'POSITION_1', matchCount: 80, winCount: 51, lossCount: 25, drawCount: 4 }];
	assert.deepEqual(buildLaneSlice(rows, 4)['62|4|10'], [80, 325], '号位取调用方给的那个');
	assert.equal(buildLaneSlice(rows, 4)['62|1|10'], undefined, '不能跟着行里的 position 落进一号位');
	assert.equal(buildLaneSlice(rows, 5)['62|4|10'], undefined, '换一个号位就是另一张表');
	assert.deepEqual(buildLaneSlice([], 4), {}, '空数组不炸');
	ok('号位以调用方为准，不读行的 position 字段');
}

// ---- 建表：净对线的算法、门槛与脏数据 ----
{
	// 80 场 51 胜 25 负 4 平 → (51 − 25) / 80 = 0.325
	const rows = [
		{ heroId1: 62, heroId2: 10, position: 'POSITION_4', matchCount: 80, winCount: 51, lossCount: 25, drawCount: 4 },
		// 49 场：门槛之下，丢掉
		{ heroId1: 62, heroId2: 11, position: 'POSITION_4', matchCount: LANE_MIN_GAMES - 1, winCount: 49, lossCount: 0 },
		// 正好 50 场：留下（门槛是「至少」）
		{ heroId1: 62, heroId2: 12, position: 'POSITION_4', matchCount: LANE_MIN_GAMES, winCount: 10, lossCount: 40 },
		// 脏数据：自己打自己、缺 id
		{ heroId1: 7, heroId2: 7, position: 'POSITION_1', matchCount: 900, winCount: 900, lossCount: 0 },
		{ heroId1: 7, heroId2: null, position: 'POSITION_1', matchCount: 900, winCount: 900, lossCount: 0 },
	];
	const lanes = buildLaneSlice(rows, 4);
	assert.equal(lanes['62|4|10'][1], 325, '净对线 = (胜 − 负) / 场次，平局不进分子');
	assert.equal(lanes['62|4|10'][0], 80, '场次原样保留');
	assert.equal(lanes['62|4|11'], undefined, '低于门槛的对位不建表');
	assert.deepEqual(lanes['62|4|12'], [50, -600], '正好到门槛的留下');
	assert.equal(Object.keys(lanes).length, 2, '自己和自己的对位、缺 id 的两行都不建表');
	assert.deepEqual(
		buildLaneSlice([{ heroId1: 7, heroId2: 8, position: 'unknown', matchCount: 900, winCount: 900, lossCount: 0 }], 1)['7|1|8'],
		[900, 1000],
		'行里的 position 写成什么都不影响建表（号位只看调用方给的那个）',
	);

	// 平局只影响分母：把上面那行的平局数改掉，净对线不变
	const moreDraws = buildLaneSlice([{ ...rows[0], winCount: 60, lossCount: 0, drawCount: 20 }], 4);
	assert.equal(moreDraws['62|4|10'][1], 750, '60 胜 0 负 20 平 → +75.0%，平局不算输');

	// 同一格出现两次（上游把不同周的行混在一起）：取样本大的那次
	const dup = buildLaneSlice([
		{ heroId1: 3, heroId2: 4, position: 'POSITION_2', matchCount: 60, winCount: 30, lossCount: 30 },
		{ heroId1: 3, heroId2: 4, position: 'POSITION_2', matchCount: 600, winCount: 420, lossCount: 180 },
	], 2);
	assert.deepEqual(dup['3|2|4'], [600, 400], '同一格取样本大的那次');
	ok('建表：净对线算法、门槛、脏数据与去重');
}

// ---- 查表：单格查询与「自己查自己」 ----
{
	const lanes = buildLaneSlice([
		{ heroId1: 62, heroId2: 10, position: 'POSITION_4', matchCount: 80, winCount: 48, lossCount: 32 },
	], 4);
	assert.deepEqual(laneCell(lanes, 62, 4, 10), { matches: 80, net: 0.2 }, '查得到：净对线 +20%');
	assert.equal(laneCell(lanes, 62, 4, 11), null, '没有这一格返回 null');
	assert.equal(laneCell(lanes, 62, 1, 10), null, '号位不同就是另一格，不能串');
	assert.equal(laneCell(lanes, 10, 4, 10), null, '自己对自己没有线上对位');
	assert.equal(laneCell(undefined, 62, 4, 10), null, '没有数据时返回 null');
	ok('查表：命中、号位隔离与缺失');
}

// ---- 汇总：各格等权平均，不是按场次加权 ----
{
	// 一格 100 场 net +0.40，一格 5,000 场 net −0.10 → 等权 (−10) 与加权 (+? ) 差很多
	const lanes = buildLaneSlice([
		{ heroId1: 5, heroId2: 6, position: 'POSITION_3', matchCount: 100, winCount: 90, lossCount: 50 },
		{ heroId1: 5, heroId2: 7, position: 'POSITION_3', matchCount: 5000, winCount: 2250, lossCount: 2750 },
	], 3);
	const edge = laneEdge(lanes, 5, 3, [6, 7])!;
	assert.ok(Math.abs(edge.net - 0.15) < 1e-9, `各格等权平均：(+0.40 + −0.10) / 2 = +0.15，实际 ${edge.net}`);
	assert.notEqual(edge.net, (0.4 * 100 + -0.1 * 5000) / 5100, '不能按场次加权');
	assert.equal(edge.pairs, 2, '两格都有数据');
	assert.equal(edge.matches, 5100, '合计场次照实相加');
	assert.deepEqual(edge.cells.map((cell) => cell.otherId), [7, 6], '明细按场次降序');

	// 只有一格有数据：平均值就是那一格，不能按「五个人」摊
	assert.equal(laneEdge(lanes, 5, 3, [6, 99])!.net, 0.4, '只算有数据的那几格');
	assert.equal(laneEdge(lanes, 5, 3, [99, 98]), null, '一格都没有返回 null');
	assert.equal(laneEdge(undefined, 5, 3, [6]), null, '没有数据时返回 null');
	assert.equal(laneEdge(lanes, 5, 3, [5, 6])!.pairs, 1, '自己不算对手');
	ok('汇总：等权平均、覆盖数与缺失');
}

// ---- 双向查表：正方向没有就用反方向，并且要取反号 ----
//
// 实测两个方向的留存率差很多（水晶室女五号位对暗影萨满：正方向没有格子，反方向 74 场），
// 只查一边会让这条依据大半时候不出现。
{
	const lanes = buildLaneSlice(
		[
			// 反方向才有：水晶室女(5) 打 5 号位时线上遇到暗影萨满(27)，净对线 +18.9%
			{ heroId1: 5, heroId2: 27, matchCount: 74, winCount: 40, lossCount: 26 },
		],
		5,
	);
	const theirs = [{ id: 5, position: 5 }];
	const edge = laneEdgeEither(lanes, 27, 5, theirs);
	assert.ok(edge, '正方向没有格子时要退到反方向');
	assert.ok(Math.abs(edge!.net - -0.189) < 1e-9, `反方向的数字要取反号（从暗影萨满视角是 −18.9%），实际 ${formatNet(edge!.net)}`);
	assert.equal(edge!.matches, 74, '场次照旧');
	assert.equal(edge!.cells[0].otherId, 5, '明细里写的是对面那个英雄');

	// 两个方向都在时只用正方向，不能把同一件事数两遍。
	const both = buildLaneSlice(
		[
			{ heroId1: 27, heroId2: 5, matchCount: 60, winCount: 45, lossCount: 15 },
			{ heroId1: 5, heroId2: 27, matchCount: 74, winCount: 40, lossCount: 26 },
		],
		5,
	);
	const forward = laneEdgeEither(both, 27, 5, theirs);
	assert.ok(forward, '正方向有数据时用正方向');
	assert.equal(forward!.matches, 60, '只用正方向那 60 场，不去混反方向');
	assert.ok(Math.abs(forward!.net - 0.5) < 1e-9, '正方向净对线 +50%');

	assert.equal(laneEdgeEither(lanes, 27, 5, [{ id: 5, position: 1 }]), null, '反方向的号位对不上就没有');
	assert.equal(laneEdgeEither(undefined, 27, 5, theirs), null, '没有数据时返回 null');
	ok('双向查表：反方向兜底、取反号、正方向优先');
}

// ---- 文案：数字要写全，且不能出现 NaN / undefined ----
{
	assert.equal(formatNet(0.0182), '+1.8%', '正数带 +');
	assert.equal(formatNet(-0.004), '−0.4%', '负数用减号而不是连字符');
	assert.equal(formatNet(0), '0.0%', '打平不写 +0.0%');
	const lanes = buildLaneSlice([
		{ heroId1: 62, heroId2: 10, position: 'POSITION_4', matchCount: 1234, winCount: 634, lossCount: 600 },
	], 4);
	const text = laneEdgeText('线上对线', laneEdge(lanes, 62, 4, [10])!, 4);
	// 634 − 600 = 34，34 / 1234 = 2.76% → +2.8%
	assert.match(text, /线上对线（4 号位线上 1,234 场、1 个对手）：平均净对线 \+2\.8%/, `文案不对：${text}`);
	assert.doesNotMatch(text, /NaN|undefined/, '不能漏出 NaN / undefined');
	ok('文案：格式与缺失');
}

console.log(`draftLanes 全部断言通过（${cases} 组）`);
