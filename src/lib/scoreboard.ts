/**
 * 对抗明细表的纯逻辑：队伍合计与条形图的相对宽度。
 *
 * 两个地方错了不会报错、只会安静地显示错数字，所以单独抽出来并挂上自检：
 *
 * 1. **合计的加总口径**。`goldPerMinute` / `experiencePerMinute` 看着像"平均值"，
 *    其实是**每分钟的量**，五个人相加就是"全队每分钟多少钱/多少经验"，这正是团队口径，
 *    也和 STRATZ 自己的表一致；`imp` 是加减分，同样可以相加。把这两列按平均值算，
 *    会得到「全队 GPM 只有五六百」这种比单核还低的假数字。
 * 2. **条形的相对宽度**。NW 条是「占全场最高经济的比例」，IMP 条是「占全场最大绝对值的比例」——
 *    后者有正有负，拿带符号的值直接当宽度会得到负宽度。
 */

export interface ScoreRow {
	kills: number;
	deaths: number;
	assists: number;
	networth: number;
	gpm: number;
	xpm: number;
	lastHits: number;
	denies: number;
	heroDamage: number;
	towerDamage: number;
	heroHealing: number;
	imp: number | null;
}

export interface ScoreTotals {
	kills: number;
	deaths: number;
	assists: number;
	networth: number;
	gpm: number;
	xpm: number;
	lastHits: number;
	denies: number;
	heroDamage: number;
	towerDamage: number;
	heroHealing: number;
	imp: number;
}

const ZERO: ScoreTotals = {
	kills: 0,
	deaths: 0,
	assists: 0,
	networth: 0,
	gpm: 0,
	xpm: 0,
	lastHits: 0,
	denies: 0,
	heroDamage: 0,
	towerDamage: 0,
	heroHealing: 0,
	imp: 0,
};

/** 一方的合计。空数组给全 0，不要留给页面一堆 NaN。 */
export function teamTotals(rows: ScoreRow[]): ScoreTotals {
	const totals = { ...ZERO };
	for (const row of rows) {
		totals.kills += row.kills;
		totals.deaths += row.deaths;
		totals.assists += row.assists;
		totals.networth += row.networth;
		totals.gpm += row.gpm;
		totals.xpm += row.xpm;
		totals.lastHits += row.lastHits;
		totals.denies += row.denies;
		totals.heroDamage += row.heroDamage;
		totals.towerDamage += row.towerDamage;
		totals.heroHealing += row.heroHealing;
		// 上游对未解析完整的行会给 null，按 0 计——IMP 是加减分，缺值不该把合计拉成 NaN。
		totals.imp += row.imp ?? 0;
	}
	return totals;
}

/** 条形宽度（0–100）：`value` 占 `max` 的比例；`max` 非正时返回 0。 */
export function barWidth(value: number, max: number): number {
	if (!Number.isFinite(value) || !Number.isFinite(max) || max <= 0) return 0;
	return Math.max(0, Math.min(100, (value / max) * 100));
}

/** 带符号量（IMP）的条形宽度：按绝对值占 `maxAbs` 的比例，负号只影响颜色不影响宽度。 */
export function signedBarWidth(value: number, maxAbs: number): number {
	return barWidth(Math.abs(value), maxAbs);
}

/** 一组数值里最大的绝对值，用来给 IMP 条定标；全 0 时返回 0。 */
export function maxAbs(values: (number | null)[]): number {
	let max = 0;
	for (const value of values) if (typeof value === 'number' && Number.isFinite(value)) max = Math.max(max, Math.abs(value));
	return max;
}

/** 一组数值里的最大值，用来给 NW 条定标。 */
export function maxValue(values: number[]): number {
	let max = 0;
	for (const value of values) if (Number.isFinite(value)) max = Math.max(max, value);
	return max;
}

/**
 * 大数字的紧凑写法：`39.4千` / `112.7千` / `940`。
 *
 * 明细表有 11 列，千分位（`112,700`）会把整张表撑到横向滚动；「千」是社区里看惯的口径
 * （STRATZ 自己的表也是这么写的）。
 */
export function compact(value: number): string {
	if (!Number.isFinite(value)) return '—';
	const abs = Math.abs(value);
	if (abs < 1000) return String(Math.round(value));
	return `${(value / 1000).toFixed(1)}千`;
}

/** 带符号的整数：`+11` / `-10` / `0`。IMP 这类加减分要能一眼看出正负。 */
export function signedInt(value: number): string {
	if (!Number.isFinite(value)) return '—';
	const rounded = Math.round(value);
	return rounded > 0 ? `+${rounded}` : String(rounded);
}
