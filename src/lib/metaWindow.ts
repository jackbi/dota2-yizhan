/**
 * 英雄统计的窗口：**上一个完整的统计周**。
 *
 * 先说清「统计周」是什么——它**不是自然周**。STRATZ 的 `heroStats.stats(week:)` 按**Unix 纪元
 * 对齐的 7 天桶**切窗（1970-01-01 是周四，所以边界落在周四 00:00 UTC）。实测（2026-09-29）：
 *
 * - 桶边界在 `2026-09-24T00:00Z`：跨过它，总场次从 1,763,328 跳到 1,073,094；按 2 小时步进
 *   定位到 22:13Z 还是旧桶、00:13Z 已是新桶；
 * - 同一个桶内换任意时刻，返回逐行一致（`week` 参数按"落在哪个桶里"吸附）；
 * - **不传 `week` 给的是当前那个还没走完的桶**（周二构建时只有 5/7 天）。仓库里"不传 = 上一个
 *   完整自然周"的旧说法是错的——缓存里那份 stats 只有 1,040,817 场，正好是当前桶的量。
 *
 * 所以这里显式要上一整桶：`week` 传一个落在上一桶里的时刻（见 `weekAnchorSeconds`）。
 *
 * 这个窗口有三个消费方，各算一遍就会漂移，所以只在这里算：
 *
 * 1. 号位胜率 / 出场（`stratzApi.fetchHeroMeta` 的 `stats`）；
 * 2. 被禁用数（同一个接口按天给的 `banDay`，要裁进**同一个窗口**再累加）；
 * 3. 版本提醒里的「这批数据是不是跨了一次版本更新」。
 */

export const DAY_MS = 86_400_000;
export const WEEK_MS = 7 * DAY_MS;

export interface StatWeek {
	/** 窗口起点（含）。 */
	startMs: number;
	/** 窗口终点（不含）。 */
	endMs: number;
	/** 起点所在的日序号（UTC 日，0 是 1970-01-01）。`banDay` 的 `day` 就在这个空间里比。 */
	firstDay: number;
	/** 终点所在的日序号（含）。 */
	lastDay: number;
}

/**
 * `nowMs` 时刻的「上一个完整统计周」。
 *
 * 当前桶的起点就是上一桶的终点：`floor(now / 7 天) * 7 天`。桶边界因此永远落在
 * 周四 00:00 UTC（纪元日 0 是周四），与上游一致。
 */
export function previousStatWeek(nowMs: number): StatWeek {
	const endMs = Math.floor(nowMs / WEEK_MS) * WEEK_MS;
	const startMs = endMs - WEEK_MS;
	return { startMs, endMs, firstDay: startMs / DAY_MS, lastDay: endMs / DAY_MS - 1 };
}

/** 某个时刻是否落在这个窗口里。 */
export function inWeek(ms: number, week: StatWeek): boolean {
	return ms >= week.startMs && ms < week.endMs;
}

/** 某个日序号（UTC 日）是否落在这个窗口里。 */
export function dayInWeek(day: number, week: StatWeek): boolean {
	return day >= week.firstDay && day <= week.lastDay;
}

/**
 * 一批日桶是不是把窗口**盖满**了（少一天都不算）。
 *
 * `banDay` 那边只能靠 `take: 20` 这个字面量假设"给得够多"，而这层假设一旦破了，累加是**静默**的：
 * 缺哪儿少哪儿，页面上只表现为禁用数偏小。所以累加之前先问一句这个，缺一天就整块不给数字——
 * 宁可这一列空着，也不要给一个看着正常的少算值。
 *
 * 只看覆盖、不看顺序：上游的排序不是我们的契约。
 */
export function daysCoverWeek(days: Iterable<number>, week: StatWeek): boolean {
	const present = days instanceof Set ? days : new Set(days);
	for (let day = week.firstDay; day <= week.lastDay; day += 1) {
		if (!present.has(day)) return false;
	}
	return true;
}

/**
 * 传给 STRATZ `week` 参数的值（秒）：落在**上一桶**里的任意时刻。
 *
 * 桶内任意时刻等价（实测），取"终点前一秒"最不容易在实现变化时越界。
 */
export function weekAnchorSeconds(week: StatWeek): number {
	return Math.floor((week.endMs - 1000) / 1000);
}
