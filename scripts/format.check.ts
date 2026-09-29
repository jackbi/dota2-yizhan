import assert from 'node:assert/strict';
import { formatCount, formatElapsed, formatMatchTime, formatRange } from '../src/lib/format.ts';

/**
 * `src/lib/format.ts` 的自检。
 *
 * 这一层的坏法都很安静：日期差一天、0 被印成 1970、负数被印成 `-1:-30`。它没有依赖、
 * 也不需要网络，直接喂边界值就行——所以专挑那些"上游真会给"的脏值：
 *
 * - OpenDota 的进行中比赛给 `activate_time: 0`（`??` 挡不住 0）；
 * - 对局内的秒数上游偶尔给负（开局前的选人/策略时间）；
 * - 热度与播放量在 1 万上下横跳。
 *
 * 跑：`pnpm check`（或 `node --experimental-strip-types scripts/format.check.ts`）。
 */

let cases = 0;
const ok = (label: string): void => {
	cases += 1;
	console.log(`  ✓ ${label}`);
};

/** 2026-09-29 20:30（东八区）。 */
const NOW = Math.floor(Date.parse('2026-09-29T12:30:00Z') / 1000);
const TODAY = NOW;

// 1. 时间：0 / NaN / 负数一律"时间待定"，正常值给「今天 20:30」
{
	assert.equal(formatMatchTime(0, NOW), '时间待定', '0 不是"1970-01-01 08:00"，是"不知道"');
	assert.equal(formatMatchTime(Number.NaN, NOW), '时间待定');
	assert.equal(formatMatchTime(-1, NOW), '时间待定');
	assert.equal(formatMatchTime(Number.POSITIVE_INFINITY, NOW), '时间待定');
	assert.equal(formatMatchTime(TODAY, NOW), '今天 20:30');
	assert.equal(formatMatchTime(TODAY - 86_400, NOW), '昨天 20:30');
	ok('时间：0 / NaN / 负数 → 时间待定，正常值照旧');
}

// 2. 区间：同一天只写一天，跨天写两端
{
	assert.equal(formatRange(TODAY, TODAY + 3600), '2026.09.29');
	assert.equal(formatRange(TODAY, TODAY + 3 * 86_400), '2026.09.29 — 10.02', '同年只写月日');
	const yearEnd = Math.floor(Date.parse('2026-12-30T12:30:00Z') / 1000);
	assert.equal(formatRange(yearEnd, yearEnd + 7 * 86_400), '2026.12.30 — 2027.01.06', '跨年要带上年份');
	ok('区间：同一天 / 跨天 / 跨年');
}

// 3. 对局内秒数：负数与小数都要收敛到"这一天打了多久"
{
	assert.equal(formatElapsed(-5), '0:00', '上游会给负的开局时间');
	assert.equal(formatElapsed(0), '0:00');
	assert.equal(formatElapsed(59.9), '0:59');
	assert.equal(formatElapsed(1123), '18:43');
	assert.equal(formatElapsed(3725), '1:02:05', '超过一小时要带小时位');
	ok('对局内秒数：负数归零、超过一小时带小时位');
}

// 4. 大数字：一万以下保持原样，避免"541 写成 0.1 万"
{
	assert.equal(formatCount(0), '0');
	assert.equal(formatCount(9999), '9999');
	assert.equal(formatCount(12_000), '1.2 万');
	assert.equal(formatCount(123_456_789), '1.2 亿');
	ok('大数字：一万以下原样，万/亿按国内习惯缩写');
}

console.log(`format 全部断言通过（${cases} 组）`);
