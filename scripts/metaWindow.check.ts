import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DAY_MS, WEEK_MS, dayInWeek, inWeek, previousStatWeek, weekAnchorSeconds } from '../src/lib/metaWindow.ts';

/**
 * `src/lib/metaWindow.ts` 的自检。
 *
 * 这个窗口把三处消费方绑在一起（号位胜率、`banDay` 累加、版本提醒），它算错一天，
 * 页面上那句话就不准，而且**没有任何东西会报错**：数字照常显示，只是口径不同。
 *
 * 窗口的定义不是想出来的，是实测出来的（2026-09-29）：上游按 **Unix 纪元对齐的 7 天桶**
 * 切窗，边界落在**周四 00:00 UTC**——跨过 `2026-09-24T00:00Z` 总场次从 1,763,328 跳到
 * 1,073,094，而桶内换任意时刻结果一致。所以下面钉的就是这个边界，外加"传给上游的锚点必须
 * 落在上一桶里"（差一点就会拿到当前那个没走完的桶，正是这条修复要躲开的）。
 *
 * 跑：`pnpm check`（或 `node --experimental-strip-types scripts/metaWindow.check.ts`）。
 */

let cases = 0;
const ok = (label: string): void => {
	cases += 1;
	console.log(`  ✓ ${label}`);
};

const at = (iso: string): number => Date.parse(iso);
/** 东八区墙上时间 → 时刻，写测试数据时少换算一次。 */
const shanghai = (iso: string): number => Date.parse(`${iso}+08:00`);

// 1. 实测的那个边界：2026-09-24T00:00Z 之前之后，窗口整整差一周
{
	const after = previousStatWeek(at('2026-09-29T02:12:00Z')); // 探针当天
	assert.equal(after.startMs, at('2026-09-17T00:00:00Z'), '窗口起点');
	assert.equal(after.endMs, at('2026-09-24T00:00:00Z'), '窗口终点（= 实测的跳变点）');

	const justBefore = previousStatWeek(at('2026-09-23T22:13:00Z')); // 探针里还是旧桶的那一刻
	assert.equal(justBefore.endMs, at('2026-09-17T00:00:00Z'));
	assert.equal(after.startMs - justBefore.startMs, WEEK_MS, '边界前后正好差一个桶');
	assert.notEqual(previousStatWeek(at('2026-09-24T00:00:00Z')).startMs, justBefore.startMs, '边界那一刻已经换桶');
	ok('边界：周四 00:00 UTC（纪元的 7 天桶）');
}

// 2. 锚点必须落在上一桶里：差一秒就会拿到当前那个没走完的桶
{
	for (const iso of ['2026-09-29T02:12:00Z', '2026-09-24T00:00:01Z', '2026-09-30T23:59:59Z', '2026-01-01T00:00:00Z']) {
		const week = previousStatWeek(at(iso));
		const anchorMs = weekAnchorSeconds(week) * 1000;
		assert.ok(anchorMs >= week.startMs && anchorMs < week.endMs, `${iso}：锚点要落在窗口内（否则上游返回当前桶）`);
		assert.ok(anchorMs < at(iso), `${iso}：锚点在"现在"之前`);
	}
	ok('上游锚点落在目标桶内');
}

// 3. 不变量：长度 7 天、终点是周四 00:00 UTC、不越过"现在"、日序号与窗口一致
{
	for (const iso of ['2026-01-01T00:00:00Z', '2026-03-08T10:00:00Z', '2026-09-24T00:00:00Z', '2026-12-31T23:59:59Z', '2027-03-08T10:00:00Z']) {
		const now = at(iso);
		const week = previousStatWeek(now);
		assert.equal(week.endMs - week.startMs, WEEK_MS, `${iso}：窗口长度要正好 7 天`);
		assert.equal(week.lastDay - week.firstDay, 6, `${iso}：日序号也跨 7 天`);
		assert.ok(week.endMs <= now, `${iso}：窗口不能越过"现在"（否则拿到的是没走完的桶）`);
		assert.equal(week.firstDay, week.startMs / DAY_MS, `${iso}：起点要落在 UTC 日边界上`);
		assert.equal(week.lastDay, week.endMs / DAY_MS - 1);
		assert.equal(new Date(week.endMs).getUTCDay(), 4, `${iso}：窗口终点要是周四（纪元对齐）`);
		assert.equal(new Date(week.endMs).getUTCHours(), 0);
		assert.equal(inWeek(week.startMs, week), true, `${iso}：起点含`);
		assert.equal(inWeek(week.endMs, week), false, `${iso}：终点不含`);
		assert.equal(dayInWeek(week.firstDay, week) && dayInWeek(week.lastDay, week), true);
		assert.equal(dayInWeek(week.firstDay - 1, week), false);
		assert.equal(dayInWeek(week.lastDay + 1, week), false);
	}
	ok('不变量：7 天整桶、终点周四 00:00 UTC、含前不含后');
}

// 4. 东八区的读者不用管时区：本机时间怎么变都不影响窗口边界
{
	const week = previousStatWeek(shanghai('2026-09-29T10:12:00'));
	assert.equal(week.startMs, at('2026-09-17T00:00:00Z'));
	assert.equal(week.endMs, at('2026-09-24T00:00:00Z'));
	ok('窗口按 UTC 算，与读者所在时区无关');
}

// 5. 接线：三处消费方共用这一个窗口，别各算各的
{
	const lib = (name: string): string => readFileSync(new URL(`../src/lib/${name}`, import.meta.url), 'utf8');
	const draftData = lib('draftData.ts');
	assert.match(
		draftData,
		/inWeek\(releasedAt, previousStatWeek\(now\)\)/,
		'版本提醒要按同一个窗口判断"跨版本"，不能再用滚动 7 天',
	);
	assert.ok(
		!/Date\.now\(\) - releasedAt <= HERO_META_WINDOW_DAYS/.test(draftData),
		'别把"现在往前 7 天"当窗口：它对窗口外的补丁误报、对窗口里的漏报',
	);

	const stratz = lib('stratzApi.ts');
	assert.match(stratz, /dayInWeek\(row\.day, week\)/, '被禁用数要裁进同一个窗口');
	assert.match(stratz, /week: weekAnchorSeconds\(week\)/, 'stats 查询要显式要上一桶，不能靠"不传 week"');
	assert.match(stratz, /take: \$\{BAN_TAKE_DAYS\}/, 'banDay 要说明取多少天');
	const takeDays = Number(/const BAN_TAKE_DAYS = (\d+)/.exec(stratz)?.[1]);
	assert.ok(takeDays >= 14, `日桶至少要覆盖 14 天（窗口最远 13 天前），现在是 ${takeDays}`);
	ok('接线：版本提醒、被禁用数、stats 查询共用同一个窗口');
}

console.log(`metaWindow 全部断言通过（${cases} 组）`);
