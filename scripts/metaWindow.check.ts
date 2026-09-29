import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DAY_MS, dayInWeek, inWeek, previousWeek } from '../src/lib/metaWindow.ts';

/**
 * `src/lib/metaWindow.ts` 的自检。
 *
 * 这个窗口把三处消费方绑在一起（号位胜率、`banDay` 累加、版本提醒），它算错一天，
 * 页面上那句话就不准，而且**没有任何东西会报错**：数字照常显示，只是口径不同。
 *
 * 所以这里钉的是边界：东八区周一 00:00 起、到下一个周一 00:00 止（不含），
 * 以及"上一完整自然周"在整个星期里都要落在一周之前——不能把当前这个还没走完的周算进去。
 *
 * 跑：`pnpm check`（或 `node --experimental-strip-types scripts/metaWindow.check.ts`）。
 */

let cases = 0;
const ok = (label: string): void => {
	cases += 1;
	console.log(`  ✓ ${label}`);
};

/** 用东八区的墙上时间写测试数据，免得读的人自己心算偏移。只写日期时按当天 00:00 算。 */
const at = (iso: string): number => Date.parse(`${iso.includes('T') ? iso : `${iso}T00:00:00`}+08:00`);
const day = (iso: string): number => Math.floor((at(iso) + 8 * 3600_000) / DAY_MS);

// 1. 一周中间的某天：窗口是上一个完整自然周
{
	// 2026-09-30 是周三；上一个完整自然周是 09-21（周一）到 09-27（周日）。
	const week = previousWeek(at('2026-09-30T12:00:00'));
	assert.equal(week.startMs, at('2026-09-21T00:00:00'), '窗口从上周一 00:00 开始');
	assert.equal(week.endMs, at('2026-09-28T00:00:00'), '窗口到本周一 00:00 结束（不含）');
	assert.equal(week.firstDay, day('2026-09-21'));
	assert.equal(week.lastDay, day('2026-09-27'));
	ok('周三看到的窗口 = 上周一到上周日');
}

// 2. 周一当天：刚过去的那一周就是上一个完整自然周（边界最容易算错的那天）
{
	const week = previousWeek(at('2026-09-28T00:30:00'));
	assert.equal(week.startMs, at('2026-09-21T00:00:00'));
	assert.equal(week.endMs, at('2026-09-28T00:00:00'));
	ok('周一凌晨：窗口仍是刚结束的那一周，不包含今天');
}

// 3. 周日深夜：本周还没走完，窗口不该把本周算进来
{
	const week = previousWeek(at('2026-09-27T23:59:59'));
	assert.equal(week.startMs, at('2026-09-14T00:00:00'), '周日深夜时"上一完整自然周"是 09-14~09-20');
	assert.equal(week.endMs, at('2026-09-21T00:00:00'));
	assert.equal(inWeek(at('2026-09-27T23:59:59'), week), false, '当前这一周不算（还没走完）');
	ok('周日深夜：不把当前这个未完成的周算进去');
}

// 4. 不变量：窗口永远是 7 天、永远整周落在"现在"之前、周内每一天都算在内
{
	for (const iso of [
		'2026-01-01T00:00:00',
		'2026-02-28T23:59:59',
		'2026-06-15T08:00:00',
		'2026-09-28T00:00:00',
		'2026-12-31T23:59:59',
		'2027-03-08T10:00:00',
	]) {
		const now = at(iso);
		const week = previousWeek(now);
		assert.equal(week.endMs - week.startMs, 7 * DAY_MS, `${iso}：窗口长度要正好 7 天`);
		assert.equal(week.lastDay - week.firstDay, 6, `${iso}：日序号也跨 7 天`);
		assert.ok(week.endMs <= now, `${iso}：窗口不能越过"现在"`);
		assert.ok(week.startMs <= week.endMs);
		assert.equal(inWeek(week.startMs, week), true, `${iso}：起点含`);
		assert.equal(inWeek(week.endMs, week), false, `${iso}：终点不含`);
		assert.equal(inWeek(week.endMs - 1, week), true, `${iso}：终点前一毫秒还在窗口里`);
		assert.equal(dayInWeek(week.firstDay, week) && dayInWeek(week.lastDay, week), true);
		assert.equal(dayInWeek(week.firstDay - 1, week), false);
		assert.equal(dayInWeek(week.lastDay + 1, week), false);
		// 起点必须是东八区的周一 00:00。
		const shifted = new Date(week.startMs + 8 * 3600_000);
		assert.equal(shifted.getUTCDay(), 1, `${iso}：窗口起点要是周一`);
		assert.equal(shifted.getUTCHours(), 0);
	}
	ok('不变量：7 天整周、不越界、边界含前不含后、起点是东八区周一');
}

// 5. 接线：三处消费方都得用这一个窗口，不能各算各的
{
	const lib = (name: string): string => readFileSync(new URL(`../src/lib/${name}`, import.meta.url), 'utf8');
	const draftData = lib('draftData.ts');
	assert.match(
		draftData,
		/inWeek\(releasedAt, previousWeek\(now\)\)/,
		'版本提醒要按同一个自然周判断"跨版本"，不能再用滚动 7 天',
	);
	assert.ok(
		!/Date\.now\(\) - releasedAt <= HERO_META_WINDOW_DAYS/.test(draftData),
		'别把"现在往前 7 天"当窗口：它对窗口外的补丁误报、对窗口里的漏报',
	);

	const stratz = lib('stratzApi.ts');
	assert.match(stratz, /dayInWeek\(row\.day, week\)/, '被禁用数要裁进同一个自然周');
	assert.ok(
		!/const oldestDay = Math\.floor\(Date\.now\(\) \/ 1000 \/ SECONDS_PER_DAY\)/.test(stratz),
		'被禁用数不该再按滚动 7 天累加',
	);
	ok('接线：版本提醒与被禁用数共用同一个窗口');
}

console.log(`metaWindow 全部断言通过（${cases} 组）`);
