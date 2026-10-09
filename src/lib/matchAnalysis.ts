/*
 * 相对导入带 `.ts` 后缀：这一层要能被 `scripts/*.check.ts` 用
 * `node --experimental-strip-types` 直接加载，Node 不做后缀补全。
 */
import { laneLabel, laneOutcomeLabel, positionLabel } from './dotaLabels.ts';
import { BARRACKS_PER_SIDE, MAP_BUILDINGS, TOWERS_PER_SIDE } from './dotaMap.ts';
import type { HeroRef, ItemRef } from './gameRefs.ts';
import type { MatchReview, ReviewMinute, ReviewPlayer } from './matchReview.ts';

/**
 * 赛后分析要给模型的那份摘要。
 *
 * **这一层只搬数据、不产生任何新数字**：经济差、伤害、眼位、建筑倒塌全部取自 `MatchReview`，
 * 一个字段都不加工。摘要之所以存在，是因为原始对象里有两样东西不能直接喂给模型——
 * 一个是 40 多点的逐分钟曲线（模型读不出重点，还占满上下文），所以这里按每 5 分钟采样并
 * 标出峰值 / 谷值 / 最大单分钟变化；另一个是英雄与装备的 id（模型不认识 41 是谁），
 * 这里就地换成名字。
 *
 * 它同时是页面上内联的那份 JSON（`MatchAnalysis.astro`），所以每一格都要能 `JSON.parse` 回来，
 * 不许出现 `undefined`、`NaN` 或函数。
 */

export interface AnalysisPlayerRow {
	name: string;
	hero: string;
	side: '天辉' | '夜魇';
	/** 「1 号位」这类中文标签；上游缺值时是「未知」。 */
	position: string;
	/** 「优势路 / 中路 / 劣势路」；上游缺值时是「未知」。 */
	lane: string;
	kills: number;
	deaths: number;
	assists: number;
	networth: number;
	level: number;
	gpm: number;
	xpm: number;
	lastHits: number;
	denies: number;
	heroDamage: number;
	towerDamage: number;
	heroHealing: number;
	/** 个人表现分，上游缺值时是 null。 */
	imp: number | null;
	/** 出过的装备名（含背包与中立物品），认不出名字的格子丢掉。 */
	items: string[];
}

/** 某一刻的三条曲线读数。用来把「建筑什么时候倒」与「经济差什么时候翻」对上。 */
export interface AnalysisLead {
	networthLead: number;
	experienceLead: number;
	winRate: number | null;
}

/** 曲线上的一点。永远是天辉视角：正数 = 天辉领先。 */
export interface AnalysisMoment extends AnalysisLead {
	minute: number;
}

/**
 * 每 10 分钟的净变化，天辉视角。
 *
 * 「15 分钟后为什么领先」这个问题，答案就藏在这一段里：某一段窗口的经济/经验净涨了多少，
 * 说明那一波团战或那段时间谁在赚。逐点曲线能给，但模型几乎不会自己去算差分。
 */
export interface AnalysisSegment {
	from: number;
	to: number;
	networthDelta: number;
	experienceDelta: number;
}

/** 一边的合计，用来做队与队的横向对照（逐人表看不出「谁在扛输出」）。 */
export interface AnalysisTotals {
	side: '天辉' | '夜魇';
	kills: number;
	deaths: number;
	assists: number;
	networth: number;
	heroDamage: number;
	towerDamage: number;
	heroHealing: number;
	/** 队伍平均等级，一位小数。 */
	avgLevel: number;
}

export interface AnalysisCurve {
	/** 每 5 分钟一点，外加最后一点（时长未必是 5 的倍数）。 */
	timeline: AnalysisMoment[];
	/** 天辉经济领先最多的那一刻（可能是负的，即全程落后）。 */
	peak: AnalysisMoment;
	/** 天辉最落后的那一刻。 */
	trough: AnalysisMoment;
	/** 单分钟内经济差变化最大的一分钟，用来指认「哪一分钟崩的 / 翻的」。 */
	swing: { minute: number; delta: number } | null;
	/** 每 10 分钟的净变化，用来指认「哪一段被拉爆」。 */
	segments: AnalysisSegment[];
}

/** 一边的眼位统计，字段与 `wardStats.WardSideSummary` 一一对应。 */
export interface AnalysisWards {
	side: '天辉' | '夜魇';
	placed: number;
	observer: number;
	sentry: number;
	taken: number;
	lost: number;
	expired: number;
}

export interface MatchAnalysisInput {
	matchId: number;
	durationSeconds: number;
	radiantName: string;
	direName: string;
	/** 上游没给结果时为 null。 */
	winner: '天辉' | '夜魇' | null;
	firstBloodTime: number | null;
	/** 三路结果，已翻成中文。值为 null 的格子在渲染时标「未记录」。 */
	lanes: { lane: string; outcome: string }[];
	/** 两边的建筑账：还剩几座、被推了几座。 */
	buildings: {
		side: '天辉' | '夜魇';
		towersAlive: number;
		towersTotal: number;
		barracksAlive: number;
		barracksTotal: number;
		towersFallen: number;
		barracksFallen: number;
	}[];
	/**
	 * 建筑倒塌时间轴（按时间排好），`by` 是被拆的那一方。
	 *
	 * `lead` 是**那一刻**的经济与经验差（没有曲线时为 null）。把这两个数对齐是这份摘要里
	 * 最有用的一格：它让「18:42 拆中路一塔」变成「拆塔时天辉已经反超 X」，而不只是一个时间点。
	 */
	falls: { time: number; label: string; by: '天辉' | '夜魇'; attacker: string; lead: AnalysisLead | null }[];
	/** 十名选手，天辉在前、同队按经济从高到低（与 `MatchReview.players` 同序）。 */
	players: AnalysisPlayerRow[];
	/** 两边的合计。 */
	totals: AnalysisTotals[];
	/** 没有逐分钟曲线时为 null（未解析的对局）。 */
	curve: AnalysisCurve | null;
	/** 没有眼位数据时为 null（未下载录像的对局）。 */
	wards: AnalysisWards[] | null;
}

/** 曲线上取点的间隔：整局铺满 40 多个点，模型读不出重点。 */
const CURVE_STEP_MINUTES = 5;

/** npcId → 建筑类别，用来把推塔事件分回「塔」与「兵营」。表在 `dotaMap`，那边有坐标与依据。 */
const BUILDING_KIND = new Map(MAP_BUILDINGS.map((building) => [building.npcId, building.kind]));

function heroName(heroes: Map<number, HeroRef>, heroId: number): string {
	return heroes.get(heroId)?.name ?? `英雄 #${heroId}`;
}

/** 一名选手出过的装备名；空格与认不出名字的格子直接丢掉。 */
function itemNames(player: ReviewPlayer, items: Map<number, ItemRef>): string[] {
	const ids = [...player.items, ...player.backpack, player.neutral].filter(
		(id): id is number => typeof id === 'number' && id > 0,
	);
	const names: string[] = [];
	for (const id of ids) {
		const name = items.get(id)?.name;
		if (name && !names.includes(name)) names.push(name);
	}
	return names;
}

function toRow(player: ReviewPlayer, heroes: Map<number, HeroRef>, items: Map<number, ItemRef>): AnalysisPlayerRow {
	return {
		name: player.name,
		hero: heroName(heroes, player.heroId),
		side: player.isRadiant ? '天辉' : '夜魇',
		position: positionLabel(player.position),
		lane: laneLabel(player.lane),
		kills: player.kills,
		deaths: player.deaths,
		assists: player.assists,
		networth: player.networth,
		level: player.level,
		gpm: player.gpm,
		xpm: player.xpm,
		lastHits: player.lastHits,
		denies: player.denies,
		heroDamage: player.heroDamage,
		towerDamage: player.towerDamage,
		heroHealing: player.heroHealing,
		imp: player.imp,
		items: itemNames(player, items),
	};
}

/** 某一分钟的三条曲线读数；分钟超出曲线长度时取最后一个点。没有曲线返回 null。 */
function leadAt(minutes: ReviewMinute[], minute: number): AnalysisLead | null {
	if (minutes.length === 0) return null;
	let best = minutes[0]!;
	for (const point of minutes) {
		if (point.minute <= minute) best = point;
		else break;
	}
	return { networthLead: best.networthLead, experienceLead: best.experienceLead, winRate: best.winRate };
}

/**
 * 每 10 分钟的净变化。
 *
 * 逐点曲线模型是会读的，但它几乎不会自己去算差分——而「哪一段被拉爆」正是复盘里最该说清的
 * 一句。所以这里替它算好：每段取该段最后一个点与上一段最后一个点之差，段标签用真实的分钟数
 * （对局未必是 10 的整数倍，最后一段可能是 3 分钟）。
 */
function toSegments(minutes: ReviewMinute[]): AnalysisSegment[] {
	if (minutes.length === 0) return [];
	const last = minutes[minutes.length - 1]!;
	if (last.minute <= 0) return [];

	const segments: AnalysisSegment[] = [];
	let previous = leadAt(minutes, 0)!;
	let previousMinute = 0;
	for (let end = 10; ; end += 10) {
		const to = Math.min(end, last.minute);
		const point = leadAt(minutes, to)!;
		segments.push({
			from: previousMinute,
			to,
			networthDelta: point.networthLead - previous.networthLead,
			experienceDelta: point.experienceLead - previous.experienceLead,
		});
		previous = point;
		previousMinute = to;
		if (end >= last.minute) break;
	}
	return segments;
}

/** 一边的合计。平均等级保留一位小数，别的都是整数。 */
function toTotals(rows: AnalysisPlayerRow[], side: '天辉' | '夜魇'): AnalysisTotals {
	const sum = (pick: (row: AnalysisPlayerRow) => number): number => rows.reduce((total, row) => total + pick(row), 0);
	const level = rows.length > 0 ? sum((row) => row.level) / rows.length : 0;
	return {
		side,
		kills: sum((row) => row.kills),
		deaths: sum((row) => row.deaths),
		assists: sum((row) => row.assists),
		networth: sum((row) => row.networth),
		heroDamage: sum((row) => row.heroDamage),
		towerDamage: sum((row) => row.towerDamage),
		heroHealing: sum((row) => row.heroHealing),
		avgLevel: Math.round(level * 10) / 10,
	};
}

/**
 * 逐分钟曲线 → 给模型的那份：每 5 分钟一点 + 峰谷 + 最大单分钟变化 + 每 10 分钟净变化。
 *
 * 「峰 / 谷」取的是**天辉视角**，写进提示词时会带上队名，模型才不会把视角搞反。
 * `swing` 是相邻两分钟经济差的差值的最大值——正的一跳多半是一波团灭加推塔，负的一跳多半是被翻，
 * 这比「哪一分钟领先最多」更接近「哪一分钟定的胜负」。逐分钟数据本来就有噪声，所以不额外平滑。
 */
function toCurve(review: MatchReview): AnalysisCurve | null {
	const minutes = review.minutes;
	if (minutes.length === 0) return null;

	const timeline: AnalysisMoment[] = [];
	for (const point of minutes) {
		if (point.minute % CURVE_STEP_MINUTES === 0) timeline.push(point);
	}
	const last = minutes[minutes.length - 1];
	if (last && timeline[timeline.length - 1]?.minute !== last.minute) timeline.push(last);

	let peak = minutes[0]!;
	let trough = minutes[0]!;
	let swing: { minute: number; delta: number } | null = null;
	for (let index = 0; index < minutes.length; index += 1) {
		const point = minutes[index]!;
		if (point.networthLead > peak.networthLead) peak = point;
		if (point.networthLead < trough.networthLead) trough = point;
		const previous = minutes[index - 1];
		if (previous) {
			const delta = point.networthLead - previous.networthLead;
			if (!swing || Math.abs(delta) > Math.abs(swing.delta)) swing = { minute: point.minute, delta };
		}
	}

	return { timeline, peak, trough, swing, segments: toSegments(minutes) };
}

/**
 * 把 `MatchReview` 收成模型好读的一份摘要。
 *
 * 选手、建筑、时间轴都原样搬；只有曲线与 id 两处做了压缩与换名，理由见文件头的注释。
 */
export function buildAnalysisInput(
	review: MatchReview,
	heroes: Map<number, HeroRef>,
	items: Map<number, ItemRef>,
): MatchAnalysisInput {
	const towersFallen = review.falls.filter((fall) => BUILDING_KIND.get(fall.npcId) === 'tower');
	const barracksFallen = review.falls.filter((fall) => BUILDING_KIND.get(fall.npcId) === 'barracks');
	const players = review.players.map((player) => toRow(player, heroes, items));

	return {
		matchId: review.matchId,
		durationSeconds: review.durationSeconds,
		radiantName: review.radiantName ?? '天辉',
		direName: review.direName ?? '夜魇',
		winner: review.radiantWin === null ? null : review.radiantWin ? '天辉' : '夜魇',
		firstBloodTime: review.firstBloodTime,
		lanes: [
			{ lane: '上路', outcome: laneOutcomeLabel(review.lanes.top) },
			{ lane: '中路', outcome: laneOutcomeLabel(review.lanes.mid) },
			{ lane: '下路', outcome: laneOutcomeLabel(review.lanes.bottom) },
		],
		buildings: [
			{
				side: '天辉',
				towersAlive: review.towersAlive.radiant,
				towersTotal: TOWERS_PER_SIDE,
				barracksAlive: review.barracksAlive.radiant,
				barracksTotal: BARRACKS_PER_SIDE,
				towersFallen: towersFallen.filter((fall) => fall.side === 0).length,
				barracksFallen: barracksFallen.filter((fall) => fall.side === 0).length,
			},
			{
				side: '夜魇',
				towersAlive: review.towersAlive.dire,
				towersTotal: TOWERS_PER_SIDE,
				barracksAlive: review.barracksAlive.dire,
				barracksTotal: BARRACKS_PER_SIDE,
				towersFallen: towersFallen.filter((fall) => fall.side === 1).length,
				barracksFallen: barracksFallen.filter((fall) => fall.side === 1).length,
			},
		],
		falls: review.falls.map((fall) => ({
			time: fall.time,
			label: fall.label,
			by: fall.side === 0 ? '天辉' : '夜魇',
			attacker: fall.attackerHeroId === null ? '未记录' : heroName(heroes, fall.attackerHeroId),
			// 把倒塌时刻与曲线对齐：这一格让「什么时候倒的」变成「倒的时候谁领先多少」。
			lead: leadAt(review.minutes, Math.floor(fall.time / 60)),
		})),
		players,
		totals: [
			toTotals(players.filter((row) => row.side === '天辉'), '天辉'),
			toTotals(players.filter((row) => row.side === '夜魇'), '夜魇'),
		],
		curve: toCurve(review),
		wards: review.wards
			? [
					{ side: '天辉', ...review.wards.sides[0] },
					{ side: '夜魇', ...review.wards.sides[1] },
				]
			: null,
	};
}
