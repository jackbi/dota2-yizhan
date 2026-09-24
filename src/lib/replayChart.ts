/**
 * 复盘面板的曲线几何。
 *
 * 手写 SVG 路径而不是引图表库：整站没有图表依赖（见 `MatchTrend.astro` 的同款注释），
 * 经济曲线只是一条折线加一块按正负分色的面积，为它拉进 recharts 要多背几百 KB，
 * 而 SSR 下还得处理水合。
 *
 * 这里只做「数值 → 路径字符串」的换算，判据都摆在明面上：坐标必须落在画布内、
 * 单点序列不能产生退化路径、全零序列不能把 y 轴缩放到 0。这些错了不会抛异常，
 * 只会画出一张空图或一条冲出边界的线，所以 `scripts/matchReview.check.ts` 会钉住它们。
 */

export interface PlotBox {
	width: number;
	height: number;
	/** 左右留白：刻度文字要占位。 */
	padX: number;
	/** 上下留白。 */
	padY: number;
}

export const LEAD_BOX: PlotBox = { width: 760, height: 220, padX: 46, padY: 18 };
export const RATE_BOX: PlotBox = { width: 760, height: 140, padX: 46, padY: 16 };

export interface SeriesPoint {
	minute: number;
	value: number;
}

/** 折线路径。空序列给空串——调用方据此不画这条线，而不是画成 `M NaN NaN`。 */
export function polylinePath(points: [number, number][]): string {
	if (points.length === 0) return '';
	return points.map(([x, y], index) => `${index === 0 ? 'M' : 'L'}${round(x)} ${round(y)}`).join(' ');
}

/** 折线 → 到零轴闭合的面积路径，用来给「天辉领先 / 落后」分色填充。 */
export function areaPath(points: [number, number][], zeroY: number): string {
	if (points.length < 2) return '';
	const first = points[0];
	const last = points[points.length - 1];
	if (!first || !last) return '';
	return `${polylinePath(points)} L${round(last[0])} ${round(zeroY)} L${round(first[0])} ${round(zeroY)} Z`;
}

/** 把某一分钟的序号映射到画布 x。`count` 是分钟点总数（末点贴右边缘）。 */
export function plotX(minute: number, count: number, box: PlotBox): number {
	const usable = box.width - box.padX * 2;
	if (count <= 1) return box.padX + usable / 2;
	return box.padX + (usable * minute) / (count - 1);
}

/** 把某一分钟的数值映射到画布 y。`maxAbs` 是纵轴半幅（正负对称）。 */
export function plotY(value: number, maxAbs: number, box: PlotBox): number {
	const usable = box.height - box.padY * 2;
	const center = box.padY + usable / 2;
	if (maxAbs <= 0) return center;
	const clamped = Math.max(-maxAbs, Math.min(maxAbs, value));
	return center - (usable / 2) * (clamped / maxAbs);
}

/**
 * 纵轴半幅：取序列绝对值的最大值再向上取整到「好看的刻度」，
 * 且**至少为 1000**——否则优势方一路微幅领先（比如全程 ±300）时，
 * 一条毫无意义的抖动会被放大成剧烈波动。
 */
export function niceMaxAbs(values: number[]): number {
	let max = 0;
	for (const value of values) if (Number.isFinite(value)) max = Math.max(max, Math.abs(value));
	max = Math.max(max, 1000);
	const magnitude = 10 ** Math.floor(Math.log10(max));
	for (const step of [1, 2, 2.5, 5, 10]) {
		const candidate = magnitude * step;
		if (max <= candidate) return candidate;
	}
	return magnitude * 10;
}

/** 经济/经验差的刻度文案：`+12k` / `-8.3k` / `+430` / `0`。 */
export function formatLead(value: number): string {
	const abs = Math.abs(value);
	const sign = value > 0 ? '+' : value < 0 ? '-' : '';
	// 千以内写原值：曲线半幅最小是 1000，刻度里常出现 500、250 这种数，
	// 写成 `+0.5k` 只会让人多换算一步。
	if (abs < 1000) return `${sign}${Math.round(abs)}`;
	const thousands = abs / 1000;
	return `${sign}${thousands >= 10 ? Math.round(thousands) : thousands.toFixed(1)}k`;
}

/** 等距的分钟刻度（含首尾）。分钟点太少时不标刻度，免得挤成一团。 */
export function minuteTicks(count: number, step = 10): number[] {
	if (count < 6) return [];
	const ticks: number[] = [];
	for (let minute = 0; minute < count; minute += step) ticks.push(minute);
	const last = count - 1;
	if (ticks[ticks.length - 1] !== last) ticks.push(last);
	return ticks;
}

export interface LeadChart {
	box: PlotBox;
	zeroY: number;
	maxAbs: number;
	/** 经济差折线与其按正负分色的两块面积。 */
	networth: string;
	networthPositive: string;
	networthNegative: string;
	/** 经验差折线（虚线，不填充）。 */
	experience: string;
	ticks: { x: number; minute: number; label: string }[];
	levels: { y: number; text: string }[];
	/** 结束时两侧的数值，给页面写一句结论用。 */
	finalNetworth: number;
}

/**
 * 经济/经验差曲线。输入按分钟正序、索引即分钟；缺失的分钟按 0 处理（数组短于时长时上游还没算完）。
 */
export function buildLeadChart(
	minutes: { networthLead: number; experienceLead: number }[],
	box: PlotBox = LEAD_BOX,
): LeadChart | null {
	if (minutes.length === 0) return null;
	const maxAbs = niceMaxAbs(minutes.flatMap((minute) => [minute.networthLead, minute.experienceLead]));
	const zeroY = plotY(0, maxAbs, box);
	const networthPoints = minutes.map(
		(minute, index) => [plotX(index, minutes.length, box), plotY(minute.networthLead, maxAbs, box)] as [number, number],
	);
	const experiencePoints = minutes.map(
		(minute, index) => [plotX(index, minutes.length, box), plotY(minute.experienceLead, maxAbs, box)] as [number, number],
	);
	return {
		box,
		zeroY,
		maxAbs,
		networth: polylinePath(networthPoints),
		networthPositive: areaPath(networthPoints, zeroY),
		networthNegative: areaPath(networthPoints, zeroY),
		experience: polylinePath(experiencePoints),
		ticks: minuteTicks(minutes.length).map((minute) => ({
			x: plotX(minute, minutes.length, box),
			minute,
			label: `${minute}′`,
		})),
		levels: [maxAbs, maxAbs / 2, 0, -maxAbs / 2, -maxAbs].map((value) => ({
			y: plotY(value, maxAbs, box),
			text: formatLead(value),
		})),
		finalNetworth: minutes[minutes.length - 1]?.networthLead ?? 0,
	};
}

export interface RateChart {
	box: PlotBox;
	line: string;
	/** 起始与结束的胜率（0–1），页面用它说明走势。 */
	start: number;
	end: number;
	/** 50% 基准线的 y。 */
	midY: number;
	ticks: { x: number; minute: number; label: string }[];
	levels: { y: number; text: string }[];
}

/**
 * 胜率曲线（STRATZ 模型，天辉视角）。
 *
 * 上游给的数组比经济差短一格（实测 50 对 49），且开头可能是空的——没有值就不画点，
 * 不能补齐成 50%，那等于凭空造出一段「势均力敌」。
 */
export function buildRateChart(
	minutes: { winRate: number | null }[],
	box: PlotBox = RATE_BOX,
): RateChart | null {
	const rated = minutes
		.map((minute, index) => ({ minute: index, value: minute.winRate }))
		.filter((entry): entry is { minute: number; value: number } => typeof entry.value === 'number' && Number.isFinite(entry.value));
	if (rated.length < 2) return null;
	const usable = box.height - box.padY * 2;
	const points = rated.map(
		(entry) => [plotX(entry.minute, minutes.length, box), box.padY + usable * (1 - entry.value)] as [number, number],
	);
	return {
		box,
		line: polylinePath(points),
		start: rated[0]?.value ?? 0.5,
		end: rated[rated.length - 1]?.value ?? 0.5,
		midY: box.padY + usable / 2,
		ticks: minuteTicks(minutes.length).map((minute) => ({
			x: plotX(minute, minutes.length, box),
			minute,
			label: `${minute}′`,
		})),
		levels: [1, 0.5, 0].map((value) => ({ y: box.padY + usable * (1 - value), text: `${Math.round(value * 100)}%` })),
	};
}

/** 浮点坐标写进 SVG 时留两位小数就够，省得属性串长得离谱。 */
function round(value: number): number {
	return Math.round(value * 100) / 100;
}
