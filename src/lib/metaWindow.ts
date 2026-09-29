/**
 * 英雄统计窗口：**上一个完整自然周**（周一 00:00 起算，东八区）。
 *
 * 单独一个文件是因为它有三个消费方，各算一遍就会漂移：
 *
 * 1. STRATZ 的号位胜率与出场——数据本身就是「上一完整自然周」（实测不传 `week` 与
 *    `week = 现在 - 7 天` 逐行一致，见 `stratzApi.HERO_META_WINDOW_LABEL` 的注释）；
 * 2. 同一个接口按天给的 `banDay`——要裁进**同一个窗口**再累加，否则同一张卡片上的
 *    「出场 / 胜率」与「被禁用」是两个口径（上一版就是滚动 7 天，标签却写着自然周）；
 * 3. 版本提醒里的「这批数据是不是跨了一次版本更新」——按滚动 7 天算会对窗口外的补丁
 *    误报、对窗口内的补丁漏报。
 *
 * 边界取周一，是对外说的那个口径（页面与提示词里写的都是「上一完整自然周」）。
 * STRATZ 自己的周切点没有实测确认；真要差一天，改这一处就够了。
 */

export const DAY_MS = 86_400_000;
/** 东八区偏移。站点其它地方的日期口径也在东八区（`format.ts` 的 `TIME_ZONE`）。 */
const TZ_OFFSET_MS = 8 * 3600_000;

export interface MetaWeek {
	/** 窗口起点（含），毫秒时间戳。 */
	startMs: number;
	/** 窗口终点（不含），毫秒时间戳。 */
	endMs: number;
	/** 起点所在的日序号（东八区日，0 是 1970-01-01）。`banDay` 的 `day` 就在这个空间里比。 */
	firstDay: number;
	/** 终点所在的日序号（含）。 */
	lastDay: number;
}

/**
 * `nowMs` 时刻的「上一个完整自然周」。
 *
 * 先把时间挪到东八区的墙上时间再取整，免得边界落在 UTC 的周日夜——那样周日 16:00 之后
 * 写的日期会被算进下一周。
 */
export function previousWeek(nowMs: number): MetaWeek {
	const days = Math.floor((nowMs + TZ_OFFSET_MS) / DAY_MS);
	// 周一为一周之始：1970-01-01 是周四，所以 +3 之后周一正好落到 0。
	const mondayIndex = (((days + 3) % 7) + 7) % 7;
	const thisMonday = days - mondayIndex;
	const firstDay = thisMonday - 7;
	const lastDay = thisMonday - 1;
	return {
		startMs: firstDay * DAY_MS - TZ_OFFSET_MS,
		endMs: thisMonday * DAY_MS - TZ_OFFSET_MS,
		firstDay,
		lastDay,
	};
}

/** 某个时刻是否落在这个窗口里。 */
export function inWeek(ms: number, week: MetaWeek): boolean {
	return ms >= week.startMs && ms < week.endMs;
}

/** 某个日序号（东八区日）是否落在这个窗口里。 */
export function dayInWeek(day: number, week: MetaWeek): boolean {
	return day >= week.firstDay && day <= week.lastDay;
}
