import type { DraftData, DraftHero } from './draftData.ts';
import type { LaneData } from './draftLanes.ts';
import { laneEdge, laneEdgeEither, lanePartnerPosition } from './draftLanes.ts';
import type { DraftSide } from './draftOrder.ts';
import type { FoeForm } from './draftFoe.ts';
import { foeHeroOf, foeWinRate } from './draftFoe.ts';
import type { LineupReport } from './draftScore.ts';
import { COUNTER_WEIGHT, compositionDimensions, lineupReport } from './draftScore.ts';

/**
 * 双方阵容都选完之后的那次对比。
 *
 * 这份东西和 `advise` 的分工：`advise` 是**还没选完**的时候给下一手出主意，所以它关心的是
 * 「现在拿还是以后补」；这里两边都定了，没有"以后"，只回答「哪边更强、强在哪」。
 * 两者共用同一套号位分配、结构画像与对位口径（都来自 `draftScore`），不会各算一套标准。
 *
 * ## 胜率是怎么来的（这一条必须写清楚，否则就是在编）
 *
 * `0.5 + 号位偏差 + 对位偏差`：
 * - **号位偏差**：两边各自五个号位的胜率之和相减。一个号位高 1 个百分点就是 1 个百分点，
 *   五个号位加在一起就是这套阵容的领先幅度；
 * - **对位偏差**：每个英雄对对面五个人平均下来的对位胜率差，乘 `COUNTER_WEIGHT`，
 *   量与号位胜率同尺度（见 `draftScore` 的说明）。
 *
 * 这两项都是**实测的比赛胜率**。**阵容结构、时间曲线、团战点不进这个数**——它们是从官方
 * 角色等级和人工名单算出来的启发式，没有可用的换算系数，硬折算进去只是把猜测包装成小数。
 * 所以它们只在对比表里横向列出来，并且界面上会写清「不进胜率」。
 *
 * 即便如此，这个数也只是**相对强弱读数**，不是校准过的概率：把胜率偏差直接相加没有做回归，
 * 上限也压在 15%–85%（真实 BP 里几乎没有一边倒到 95% 的情况）。界面上照这个口径说话。
 */

/** 胜率上下限。真实比赛里一支阵容领先到 90% 以上的情况极少，写出来只会显得假。 */
const WIN_RATE_FLOOR = 0.15;
const WIN_RATE_CEIL = 0.85;

export interface VerdictSide {
	label: string;
	heroes: DraftHero[];
	/** 按号位排好的人与该号位**本身**的胜率（不含对位加成，对位单独一行）。 */
	rows: { position: number; hero: DraftHero | null; rate: number }[];
	/** 五个号位胜率的平均值（不含对位加成），0-1。 */
	average: number;
	/** 结构分：维度满意度减红线惩罚。只用于横向对比。 */
	structure: number;
	/**
	 * 每个英雄对另一套阵容的平均对位偏差（不乘权重、不求和）。
	 *
	 * 这里**必须是平均值而不是总和**，这是被实测抓出来的：留存的对位是「场次 ≥200」筛过的
	 * 约一千六百对，五个人的对位优势**加起来**能凑出 ±40 个百分点，那不是胜率该有的量级。
	 */
	counter: number;
	counterPairs: number;
}

export interface VerdictRow {
	key: string;
	label: string;
	ours: number;
	theirs: number;
	/** 参考值：达标线或基准线。 */
	target: number;
	/** 越小越好（近战数、纯核数这类上限）。 */
	lowerIsBetter?: boolean;
	/** 百分比展示（胜率、对位偏差）。 */
	percent?: boolean;
	better: 'ours' | 'theirs' | 'even';
	text: string;
}

export interface VerdictFoePick {
	hero: DraftHero;
	picks: number;
	decided: number;
	wins: number;
	rate: number | null;
}

/**
 * 一条线上的对位：**我们某个人打某个号位时，线上真的遇到的那几个人**。
 *
 * 为什么不按「我方几号位 vs 对方几号位」配对：Dota 的分路本来就不是同位对位——
 * 我们的优势路核心（一号位）在线上打的是对面的三、四号位。而 `laneOutcome` 的行天然记着
 * 「这个英雄打这个号位时，线上遇到的是谁」，把它与对面阵容求交集，得到的就是真实的对线对象。
 * 另一层原因：号位分配在并列时是任意的（实测对面五个人的样本相等时，一号位英雄会被分到二号位），
 * 靠号位对齐配对会配出根本不存在的对线。
 */
export interface VerdictLaneEdge {
	side: 'ours' | 'theirs';
	position: number;
	hero: DraftHero;
	/** 这几个对手的净对线平均。 */
	net: number;
	/** 合计场次。 */
	matches: number;
	/** 真正在线上遇到过的对手，按场次降序。 */
	opponents: { hero: DraftHero; net: number; matches: number }[];
}

/** 常规分路上「和谁走一条线」：一号位 ↔ 五号位、三号位 ↔ 四号位。 */
export interface VerdictLanePartner {
	side: 'ours' | 'theirs';
	position: number;
	hero: DraftHero;
	partner: DraftHero;
	net: number;
	matches: number;
}

export interface DraftVerdict {
	ourSide: DraftSide;
	ours: VerdictSide;
	theirs: VerdictSide;
	rows: VerdictRow[];
	/** 两边胜率，和是 1。 */
	winRate: { ours: number; theirs: number };
	/** 这个胜率由哪几项加出来（都是百分点）。 */
	edge: { position: number; counter: number; total: number };
	/** 对面拿到了几个近期熟手——只列出来，不折算进胜率。 */
	foePicks: VerdictFoePick[];
	/** 分路对位：我方与对面各号位在线上实际遇到的对位。没有可用数据时是空数组。 */
	laneEdges: VerdictLaneEdge[];
	/** 同路搭档（常规分路）。没有可用数据时是空数组。 */
	lanePartners: VerdictLanePartner[];
	/** 口径与限制，界面与提示词都要照实说。 */
	notes: string[];
}

export interface VerdictInput {
	data: DraftData;
	ourIds: readonly number[];
	theirIds: readonly number[];
	ourSide: DraftSide;
	selfTeam: string;
	foeTeam: string;
	foeForm?: FoeForm | null;
	/**
	 * 线上对位（谁在线上打谁、和谁走一路）。**可选**：拿不到就不出「分路对位」这一行，
	 * 也不影响胜率——它本来就只做横向对比，不进 `0.5 + 号位偏差 + 对位偏差`。
	 */
	lanes?: LaneData | null;
}

const clamp = (value: number, low: number, high: number): number => Math.min(high, Math.max(low, value));

function sideFrom(report: LineupReport, label: string): VerdictSide {
	const size = Math.max(1, report.slots.filter((slot) => slot.hero).length);
	return {
		label,
		heroes: report.slots.map((slot) => slot.hero).filter((hero): hero is DraftHero => Boolean(hero)),
		rows: report.slots.map((slot) => ({ position: slot.position, hero: slot.hero, rate: slot.baseRate ?? slot.rate })),
		average: report.baseTotal / 5,
		structure: report.structure,
		counter: report.counter.delta / size,
		counterPairs: report.counter.pairs,
	};
}

/** 一行对比：谁高谁低、参考值是多少。差值小于 0.5% 的按「持平」处理，免得把噪声写成结论。 */
function makeRow(input: {
	key: string;
	label: string;
	ours: number;
	theirs: number;
	target: number;
	lowerIsBetter?: boolean;
	percent?: boolean;
}): VerdictRow {
	const { ours, theirs, target, lowerIsBetter } = input;
	const gap = ours - theirs;
	const even = Math.abs(gap) < (input.percent ? 0.005 : 0.05);
	const oursBetter = lowerIsBetter ? gap < 0 : gap > 0;
	const fmt = (value: number): string => (input.percent ? `${(value * 100).toFixed(1)}%` : value.toFixed(0));
	return {
		...input,
		better: even ? 'even' : oursBetter ? 'ours' : 'theirs',
		text: `${input.label} ${fmt(ours)} : ${fmt(theirs)}（参考 ${fmt(target)}）`,
	};
}

/**
 * 生成对比。两边人数不足 5 时返回 null——没有「双方的阵容」可比，
 * 界面上那颗按钮本来也不该亮。
 */
export function buildVerdict(input: VerdictInput): DraftVerdict | null {
	if (input.ourIds.length < 5 || input.theirIds.length < 5) return null;
	const oursReport = lineupReport(input.data, input.ourIds, input.theirIds);
	const theirsReport = lineupReport(input.data, input.theirIds, input.ourIds);
	if (!oursReport || !theirsReport) return null;

	const byId = new Map(input.data.heroes.map((hero) => [hero.id, hero]));
	const ours = sideFrom(oursReport, input.selfTeam.trim() || '我方');
	const theirs = sideFrom(theirsReport, input.foeTeam.trim() || '对方');

	// 清场的要求看**全局**：只要有一边是幻象/召唤体系，另一边也得有清场能力，参考值统一取 2。
	const summonOverall = [...input.ourIds, ...input.theirIds].some((id) => byId.get(id)?.summon ?? false);
	const oursDims = compositionDimensions(oursReport.profile, summonOverall);
	const theirsDims = compositionDimensions(theirsReport.profile, summonOverall);

	/**
	 * 对位只算**一边**：同一对英雄的两个方向是同一份记录的反面（见 `draftMatchup`），
	 * 两边各算一次等于把同一件事数了两遍，还会放大成 ±40 个百分点那种不像胜率的数。
	 * 我方有记录就用我方；我方一对都没有时才取对面的反面。
	 *
	 * 但两边的「平均」不是精确的相反数：对位表本身有缺失（5v5 最多 25 对，实测常见 22–24 对），
	 * 而我方算的是「每个我方英雄对他对面五个人的平均」，对面算的是按他们的人分组——
	 * 同一批缺失的对位，在两种分组下的分母不一样。直接取一边会让同一场对局
	 * 从两边算出来的胜率加起来不是 100（实测能差 3 个百分点）。
	 * 所以两边都有数据时取中间值：结论与视角无关，也与界面上「镜像展示」的说法一致。
	 */
	const oursView = ours.counterPairs > 0 ? ours.counter : null;
	const theirsView = theirs.counterPairs > 0 ? -theirs.counter : null;
	const matchupAverage = oursView !== null && theirsView !== null ? (oursView + theirsView) / 2 : (oursView ?? theirsView ?? 0);
	ours.counter = matchupAverage;
	// 镜像展示：同一份记录换一边看就是反号。写成两个"独立"的数会让人以为有两份证据。
	theirs.counter = -matchupAverage;

	/*
	 * 分路对位：按号位一一对应，我们的 1 号位 vs 他们的 1 号位，以此类推。
	 * 线上搭档按常规分路取（1↔5、3↔4），中路没有固定搭档——那只是挑一个人的约定，
	 * 数字本身仍是实测的线上净胜。
	 */
	const lanes = input.lanes ?? null;
	const laneEdges: VerdictLaneEdge[] = [];
	for (const side of ['ours', 'theirs'] as const) {
		const rows = side === 'ours' ? ours.rows : theirs.rows;
		const foeRows = side === 'ours' ? theirs.rows : ours.rows;
		// 反方向查表要用对面的号位（见 `laneEdgeEither`）：两个方向的留存率差很多。
		const foes = foeRows.filter((row) => row.hero).map((row) => ({ id: row.hero!.id, position: row.position }));
		for (const row of rows) {
			if (!row.hero) continue;
			const edge = laneEdgeEither(lanes?.vs, row.hero.id, row.position, foes);
			if (!edge) continue;
			laneEdges.push({
				side,
				position: row.position,
				hero: row.hero,
				net: edge.net,
				matches: edge.matches,
				opponents: edge.cells
					.map((cell) => ({ hero: byId.get(cell.otherId) ?? null, net: cell.net, matches: cell.matches }))
					.filter((entry): entry is { hero: DraftHero; net: number; matches: number } => entry.hero !== null),
			});
		}
	}
	const average = (values: number[]): number | null => (values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : null);
	const laneOurs = average(laneEdges.filter((edge) => edge.side === 'ours').map((edge) => edge.net));
	const laneTheirs = average(laneEdges.filter((edge) => edge.side === 'theirs').map((edge) => edge.net));
	const lanePartners: VerdictLanePartner[] = [];
	for (const side of ['ours', 'theirs'] as const) {
		const rows = side === 'ours' ? ours.rows : theirs.rows;
		for (const row of rows) {
			const partnerPosition = lanePartnerPosition(row.position);
			if (partnerPosition === null || !row.hero) continue;
			const partner = rows.find((entry) => entry.position === partnerPosition)?.hero ?? null;
			if (!partner) continue;
			const edge = laneEdge(lanes?.with, row.hero.id, row.position, [partner.id]);
			if (!edge) continue;
			lanePartners.push({ side, position: row.position, hero: row.hero, partner, net: edge.net, matches: edge.matches });
		}
	}

	const rows: VerdictRow[] = [
		makeRow({ key: 'average', label: '平均号位胜率', ours: ours.average, theirs: theirs.average, target: 0.5, percent: true }),
		makeRow({ key: 'counter', label: '对位偏差', ours: matchupAverage, theirs: -matchupAverage, target: 0, percent: true }),
		// 一边都没数据时不出这一行：写两个 0 会让人以为线上是打平的。
		...(laneOurs !== null || laneTheirs !== null
			? [
					makeRow({
						key: 'lane',
						label: '分路对位（线上）',
						// 两边各自取自己的行平均；某一侧在号位上完全没有采样时按镜像展示。
						ours: laneOurs ?? -(laneTheirs ?? 0),
						theirs: laneTheirs ?? -(laneOurs ?? 0),
						target: 0,
						percent: true,
					}),
				]
			: []),
		...oursDims.map((dim, index) =>
			makeRow({
				key: dim.key,
				label: dim.label,
				ours: dim.value,
				theirs: theirsDims[index]?.value ?? 0,
				target: dim.target,
			}),
		),
		makeRow({
			key: 'greedyCore',
			label: '纯核（上限 2）',
			ours: oursReport.profile.greedyCore,
			theirs: theirsReport.profile.greedyCore,
			target: 2,
			lowerIsBetter: true,
		}),
		makeRow({
			key: 'melee',
			label: '近战（上限 3）',
			ours: oursReport.profile.melee,
			theirs: theirsReport.profile.melee,
			target: 3,
			lowerIsBetter: true,
		}),
		makeRow({ key: 'structure', label: '结构分', ours: ours.structure, theirs: theirs.structure, target: 0.5 }),
	];

	const positionEdge = oursReport.baseTotal - theirsReport.baseTotal;
	const counterEdge = matchupAverage * COUNTER_WEIGHT;
	const total = positionEdge + counterEdge;
	const winOurs = clamp(0.5 + total, WIN_RATE_FLOOR, WIN_RATE_CEIL);

	const foePicks: VerdictFoePick[] = [];
	if (input.foeForm) {
		for (const heroId of input.theirIds) {
			const row = foeHeroOf(input.foeForm, heroId);
			if (!row || row.picks < 2) continue;
			const hero = byId.get(heroId);
			if (hero) foePicks.push({ hero, picks: row.picks, decided: row.decided, wins: row.wins, rate: foeWinRate(row) });
		}
	}

	const notes: string[] = [
		`胜率由「号位偏差 ${(positionEdge * 100).toFixed(1)} + 对位偏差 ${(counterEdge * 100).toFixed(1)}」相加得到（百分点），没有做回归，所以它是相对强弱的读数，不是校准过的概率。`,
		'结构分、能力维度、时间曲线来自官方角色等级与人工名单，是启发式，只做横向对比，不进胜率。',
		`对位只收了样本 ≥${input.data.matchupMinGames} 场的那些对偶（共 ${input.data.matchupPairs} 对，见 \`draftMatchup\`），接近五五开的也在里面——正因为不按偏差筛，平均值才不偏向极端；两个方向是同一份记录的正反面，故按镜像展示。`,
		'对位偏差按五个号位摊开：一个英雄的克制关系不完全等于整队的胜率优势，摊开之后它与号位胜率的量级可比。',
		`号位胜率口径：${input.data.bracketLabel}近 ${input.data.windowDays} 天，少于 ${input.data.minPositionMatches} 场的号位不算数${input.data.patch.version ? `；版本 ${input.data.patch.version}` : ''}。`,
	];
	if (input.data.patch.straddles) notes.push(`近 ${input.data.windowDays} 天的样本跨了一次版本更新，胜率是新旧版本混算的。`);
	if (ours.counterPairs === 0 && theirs.counterPairs === 0) notes.push('这局没有任何可用对位数据，对位偏差按 0 处理。');
	if (laneEdges.length > 0) {
		notes.push(
			`分路对位是线上阶段的净胜（线上胜 − 线上负，平局只在分母里），取「这个人打这个号位时线上真的遇到过的对手」，` +
				`所以它天然按真实分路走（不是同位对位）；它与「对位偏差」不是一回事、也不进胜率；两边的列是各自独立测出来的，采样不同，所以不是严格的反号。`,
		);
		if (lanePartners.length > 0) {
			notes.push('同路搭档按常规分路取（一号位 ↔ 五号位、三号位 ↔ 四号位），中路没有固定搭档，只作参考。');
		}
	} else if (lanes) {
		notes.push('这局的号位组合没有可用的线上对位数据（线上样本门槛见 `draftLanes`），分路对位这一项按缺失处理。');
	}
	if (foePicks.length > 0) {
		notes.push('对面拿到了近期熟手（见下），但**没有可信的换算系数**，所以只列出来、不折算进胜率。');
	}
	return {
		ourSide: input.ourSide,
		ours,
		theirs,
		rows,
		winRate: { ours: winOurs, theirs: 1 - winOurs },
		edge: { position: positionEdge, counter: counterEdge, total },
		foePicks,
		laneEdges,
		lanePartners,
		notes,
	};
}
