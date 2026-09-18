import assert from 'node:assert/strict';
import {
	CM_STEPS,
	CM_STEP_COUNT,
	CM_PHASE_STARTS,
	DRAFT_BANS_PER_SIDE,
	DRAFT_PICKS_PER_SIDE,
	canPlay,
	handsOf,
	play,
	sideOfStep,
	skip,
	snapshot,
	undo,
} from '../src/lib/draftOrder.ts';

/**
 * 队长模式顺序表的自检。
 *
 * 这张表是整个阵容分析功能的地基，错了不会报错、只会让每一次建议都偏。
 * 两种错法都真实发生过：一是照了没更新的资料（Liquipedia 的表只更新了第一禁用阶段，
 * 第三阶段还是旧的），二是把「先选方」和「天辉」当成同一件事（先选权跟阵营无关）。
 *
 * 所以这里同时钉三样东西：
 * 1. 手数与各阶段的顺序，逐字对着 7.40 补丁说明；
 * 2. 双方 ban/pick 数，以及「后选方握着最后一手 ban 和 pick」这条结论；
 * 3. 状态机的边界：重复英雄要拦、走满 24 手要拦、跳过要推进手号、撤销要能回退。
 *
 * 跑：`pnpm check`（或 `node --experimental-strip-types scripts/draftOrder.check.ts`）。
 */

const sequence = (steps: readonly { action: string; owner: string }[]): string =>
	steps.map((step) => `${step.action === 'ban' ? 'B' : 'P'}${step.owner === 'first' ? 'F' : 'S'}`).join(' ');

// ---------------------------------------------------------------- 顺序表

assert.equal(CM_STEP_COUNT, 24, '队长模式一共 24 手');
assert.equal(
	sequence(CM_STEPS),
	'BF BF BS BS BF BS BS PF PS BF BF BS PS PF PF PS PS PF BF BS BF BS PF PS',
	'24 手顺序被改动了。改之前先去核对 7.40 之后的官方补丁说明与真实比赛记录',
);

// 阶段起点由顺序表推出来，界面靠它在"禁用段/挑选段"之间留间距。
assert.deepEqual(CM_PHASE_STARTS, [1, 8, 10, 13, 19, 23], '阶段起点不对，BP 板上的分段间距会错位');

/** 各阶段是固定的 7 / 2 / 3 / 6 / 4 / 2，隔断错位会让「下一手是谁」整体偏一手。 */
const phases: [string, number, number, string][] = [
	['禁用一', 1, 7, 'BF BF BS BS BF BS BS'],
	['挑选一', 8, 9, 'PF PS'],
	['禁用二', 10, 12, 'BF BF BS'],
	['挑选二', 13, 18, 'PS PF PF PS PS PF'],
	['禁用三', 19, 22, 'BF BS BF BS'],
	['挑选三', 23, 24, 'PF PS'],
];
for (const [label, from, to, expected] of phases) {
	assert.equal(sequence(CM_STEPS.slice(from - 1, to)), expected, `${label}（第 ${from} 到 ${to} 手）的顺序不对`);
}

// 7.40 改的是第一和第三禁用阶段：开局连禁两手归先选方，第三阶段改成两边交替。
assert.equal(sequence(CM_STEPS.slice(0, 7)), 'BF BF BS BS BF BS BS', '7.40 起第一禁用阶段是先-先-后-后-先-后-后');
assert.equal(sequence(CM_STEPS.slice(18, 22)), 'BF BS BF BS', '7.40 起第三禁用阶段是先-后-先-后');

// ---------------------------------------------------------------- 双方手数

const ownerCount = (owner: string, action: string) =>
	CM_STEPS.filter((step) => step.owner === owner && step.action === action).length;
assert.equal(ownerCount('first', 'ban'), DRAFT_BANS_PER_SIDE, '先选方应禁 7 手');
assert.equal(ownerCount('second', 'ban'), DRAFT_BANS_PER_SIDE, '后选方应禁 7 手');
assert.equal(ownerCount('first', 'pick'), DRAFT_PICKS_PER_SIDE, '先选方应选 5 手');
assert.equal(ownerCount('second', 'pick'), DRAFT_PICKS_PER_SIDE, '后选方应选 5 手');

// 头尾归属：先选方拿首抢与第 14、15 手的双选，后选方拿第 16、17 手的双选与最后两手。
assert.deepEqual(
	CM_STEPS.filter((step) => step.action === 'pick' && step.owner === 'first').map((step) => step.step),
	[8, 14, 15, 18, 23],
	'先选方的五个挑选顺位不对',
);
assert.deepEqual(
	CM_STEPS.filter((step) => step.action === 'pick' && step.owner === 'second').map((step) => step.step),
	[9, 13, 16, 17, 24],
	'后选方的五个挑选顺位不对',
);
assert.equal(CM_STEPS[21].owner, 'second', '第 22 手（最后一手禁用）归后选方');
assert.equal(CM_STEPS[23].owner, 'second', '第 24 手（最后一手挑选）归后选方');

// 两列加起来必须是完整的 24 手，既不重不漏（界面按这个分列）。
const firstHands = handsOf('first').map((step) => step.step);
const secondHands = handsOf('second').map((step) => step.step);
assert.equal(firstHands.length + secondHands.length, 24, '两列的格子数加起来应是 24');
assert.equal(new Set([...firstHands, ...secondHands]).size, 24, '两列之间有重复的手号');

// ---------------------------------------------------------------- 先选权与阵营

// 先选权落在哪个阵营由选边决定，跟天辉/夜魇无关。
assert.equal(sideOfStep(8, 'radiant'), 'radiant', '先选方是天辉时，第 8 手归天辉');
assert.equal(sideOfStep(8, 'dire'), 'dire', '先选方是夜魇时，第 8 手归夜魇');
assert.equal(sideOfStep(9, 'radiant'), 'dire', '首抢之后紧接着是后选方的挑选');
assert.equal(sideOfStep(25, 'radiant'), null, '超出 24 手应返回 null');

// ---------------------------------------------------------------- 状态机

const empty = snapshot([]);
assert.equal(empty.cursor, 0);
assert.equal(empty.nextStep, 1);
assert.deepEqual([empty.action, empty.owner], ['ban', 'first'], '第一手是先选方禁用');
assert.equal(empty.done, false);
assert.deepEqual(empty.remaining, { first: { bans: 7, picks: 5 }, second: { bans: 7, picks: 5 } });
assert.deepEqual(empty.tail, { ban: 'second', pick: 'second' });

let recorded: (number | null)[] = [];
for (const heroId of [5, 6, 7, 8, 9, 10, 11, 12]) recorded = play(recorded, heroId);
const midway = snapshot(recorded);
assert.equal(midway.cursor, 8);
assert.equal(midway.nextStep, 9);
assert.deepEqual([midway.action, midway.owner], ['pick', 'second'], '第 9 手是后选方挑选');
assert.deepEqual(midway.remaining.first, { bans: 4, picks: 4 }, '先选方已用掉第 1、2、5 手禁用与第 8 手挑选');
assert.deepEqual(midway.remaining.second, { bans: 3, picks: 5 }, '后选方已用掉第 3、4、6、7 手禁用');
assert.equal(midway.used.get(5), 1, '英雄 5 应记在第 1 手');

// 重复英雄必须拦住，并且要说清是在第几手用掉的（否则界面只会「点了没反应」）。
const duplicate = canPlay(recorded, 5);
assert.equal(duplicate.ok, false);
assert.match(duplicate.reason ?? '', /第 1 手/, '重复英雄的提示要带上手号');
assert.deepEqual(play(recorded, 5), recorded, '重复英雄不应写进记录');

// 跳过：只推进手号，不占英雄。
const skipped = skip(recorded);
assert.equal(skipped.length, 9);
assert.equal(skipped[8], null);
assert.equal(snapshot(skipped).nextStep, 10);

// 撤销：退回一手，被撤掉的英雄立刻可用。
const walked = undo(recorded);
assert.equal(walked.length, 7);
assert.equal(canPlay(walked, 12).ok, true, '撤销之后这一手用过的英雄应重新可用');

// 走满 24 手后不能再记。
let full: (number | null)[] = [];
for (let heroId = 1; heroId <= 24; heroId += 1) full = play(full, heroId);
const finished = snapshot(full);
assert.equal(finished.cursor, 24);
assert.equal(finished.done, true);
assert.deepEqual([finished.action, finished.owner], [null, null], '记满之后没有「下一手」');
assert.deepEqual(finished.remaining, { first: { bans: 0, picks: 0 }, second: { bans: 0, picks: 0 } }, '记满之后双方都不该剩手');
assert.equal(canPlay(full, 25).ok, false, '第 25 个英雄要拦住');
assert.deepEqual(play(full, 25), full, '超出 24 手不应写进记录');
assert.deepEqual(skip(full), full, '走满之后跳过不应再推进');

console.log('draftOrder 全部断言通过');
