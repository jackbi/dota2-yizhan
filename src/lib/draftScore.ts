/*
 * 相对导入带 `.ts` 后缀：这一层要能被 `scripts/draftScore.check.ts` 直接用
 * `node --experimental-strip-types` 加载，Node 不做后缀补全。仓库的 tsconfig 里
 * `allowImportingTsExtensions` 是开着的，Vite 也照常解析。
 */
import type { DraftData, DraftHero } from './draftData.ts';
import type { LaneData } from './draftLanes.ts';
import { formatNet, laneEdge, laneEdgeEither, lanePartnerPosition, type LaneEdge } from './draftLanes.ts';
import type { DraftAction, DraftOwner, DraftSide, RecordedHand } from './draftOrder.ts';
import { CM_STEPS, snapshot, sideOfOwner } from './draftOrder.ts';
import type { HeroMatchups } from './draftMatchup.ts';
import { matchupRate } from './draftMatchup.ts';
import type { FoeForm } from './draftFoe.ts';
import { foeHeroLine, foeHighlights } from './draftFoe.ts';

/**
 * 阵容分析的打分层：**先把候选和依据算出来，再交给模型排序和解释**。
 *
 * 这么分工的理由：模型的强项是把一堆数字讲成人话，弱项是记住 127 个英雄这周在某号位上
 * 的胜率。让它自己"回忆"数据，结果就是一本正经地编。所以这里把该算的算完，每个候选都带上
 * 可以逐条核对的依据，提示词只允许它引用这些字段。
 *
 * 估计的对象是**一套阵容在每个号位上能拿到的胜率之和**。关键的一条是"现在拿"和"以后补"的区别：
 * 一个英雄再强，如果它这个号位后面还排着一堆不输它的选择，这一手拿它就没赚；
 * 反过来，某个号位只有它能打，不拿就没了。所以还没定人的号位用**被打劫之后**的预期值：
 * 把当前可选英雄按该号位胜率降序排，取第 `对手剩余挑选数 + 1` 个（封顶三档）。
 * 对手剩得越多，能指望的就越差。
 *
 * 三种输出都从这一个估计推出来：
 * - 轮到我方挑选：把候选代进我方阵容，看总估值涨多少；
 * - 轮到我方禁用：把它代进**对面**阵容，看对面涨多少（威胁），同时算我们自己拿它的收益，
 *   自己更想要的降低禁用优先级；
 * - 界面上那句"还缺几号位"，就是估计里还没落人的位置。
 *
 * 这是启发式，不是胜率预测，只用了号位胜率一条公开统计。只在"两边水平相当、阵容按位置站好"
 * 的前提下有意义，所以建议里也照这个口径说话，不写成"胜算 xx%"。
 */

/** 号位没有样本时按中性估值，既不奖励也不惩罚；依据里要写清是没有样本。 */
const NEUTRAL_WIN_RATE = 0.5;
/**
 * "会被别人抢走几个"的封顶档位。
 *
 * 不封顶的话，开局对面剩 5 手挑选，五个号位都得按第六顺位去估，估出来的阵容惨得不真实。
 * 封在三档，取的是"对面接下来两三次挑选里挑走最想要的人"这个量级。
 */
const CONTEST_CAP = 3;

/**
 * 克制在总估值里的权重。
 *
 * 估值的尺度是"五个号位胜率之和"，一个号位的胜率差 5 个百分点就是 0.05。
 * 对位偏差取 1.5 倍，于是一个 5 个百分点的克制优势约等于给整套阵容加 0.075，
 * 和换一个号位人选带来的差别同一个量级，不会盖过号位胜率本身。
 *
 * 这个系数没有客观标准，是拍的：对位数据本身是高分路人局的口径，波动也不小，
 * 所以给建议时始终把对位的原始数字写在依据里，让人能自己判断值不值。
 */
export const COUNTER_WEIGHT = 1.5;

// 官方角色标签的下标，顺序见 `heroApi.ROLE_ORDER`（核心/辅助/爆发/控制/打野/耐久/逃生/推进/先手）。
const ROLE_CARRY = 0;
const ROLE_SUPPORT = 1;
const ROLE_NUKER = 2;
const ROLE_DISABLER = 3;
const ROLE_DURABLE = 5;
const ROLE_PUSHER = 7;
const ROLE_INITIATOR = 8;

/**
 * 阵容结构：拿分项与红线。
 *
 * 拿分项是"有没有"（控制/爆发/先手/上高/前排/辅助/远程/清场 + 前中后期各有几个人不弱），
 * 红线是"过没过量"。**只奖不罚是不够的**：上一版只检查缺口，结果选出了
 * 斯温 + 幻影长矛手 + 龙骑士 + 赏金猎人 + 天涯墨客这种"四个近战、三个吃资源、没有清场"的阵容，
 * 它在缺口检查里居然是达标的。所以过量要单独扣分，而且扣得比补缺口更重。
 */
const COMPOSITION_TARGETS = [
	{ key: 'control', label: '控制', role: ROLE_DISABLER, target: 4 },
	{ key: 'burst', label: '爆发', role: ROLE_NUKER, target: 4 },
	{ key: 'initiate', label: '先手', role: ROLE_INITIATOR, target: 2 },
	{ key: 'push', label: '上高', role: ROLE_PUSHER, target: 2 },
	{ key: 'front', label: '前排', role: ROLE_DURABLE, target: 2 },
	{ key: 'support', label: '辅助', role: ROLE_SUPPORT, target: 4 },
] as const;

/** 清场（AoE）：对面有幻象/召唤体系时要求两个点，否则一个。 */
const AOE_TARGET_BASE = 1;
const AOE_TARGET_VS_SUMMON = 2;

/** 远程位：五个近战在线上会被压死，目标是至少两个能打的远程。 */
const RANGED_TARGET = 2;
/**
 * 团战点：至少两个能在团战里定事的英雄（范围伤害、群体控制、无视技能免疫，名单见 `heroTraits`）。
 *
 * 团战不单独拍一个系数，而是拆成三块：这一项管"有没有人能干这个事"，
 * 先手/控制/清场那几个维度管"这个人到底能做成什么"。上一套被吐槽的阵容（斯温+幻影长矛手+
 * 龙骑士+赏金猎人+天涯墨客）在这一项上是 0/2。
 */
const TEAMFIGHT_TARGET = 2;
/** 前/中/后期：至少有三个位置在该阶段不弱于同池中位（见 `TimelineContext`）。 */
const PHASE_TARGET = 3;

/**
 * 红线。超了要扣分，扣分权重比补缺口大：
 * - **纯核**（核心等级 ≥ 2 且一点辅助都没有）最多 2 个：三个以上都在等资源，线上与中期必然崩；
 * - **近战**最多 3 个：四个近战意味着线上没人换血、打团也排不开。
 *
 * 「纯核」的判定按实测数据定：官方角色等级里几乎没有英雄是核心 3（斯温、幻影长矛手、
 * 龙骑士都只到 2），所以原先把红线画在 3 上等于没有红线——那套被吐槽的阵容一个都没拦住。
 * 改成"核心 ≥ 2 且辅助 = 0"，三个核心的阵容仍然放行（1/2/3 号位本来就都是核心），
 * 但第四个吃资源的就会被扣下去。
 */
const STRUCTURE_CAPS = [
	{ key: 'greedyCore', label: '纯核', cap: 2, count: (profile: StructureProfile) => profile.greedyCore },
	{ key: 'melee', label: '近战', cap: 3, count: (profile: StructureProfile) => profile.melee },
] as const;
/** 红线扣分的倍率：超一格扣的分，比补一格缺口拿到的分更重。 */
const CAP_PENALTY_SCALE = 2;

/**
 * 阵容结构在总估值里的权重。
 *
 * 与号位胜率同尺度（一个号位胜率差 5 个百分点 = 0.05，五个号位合计最多差 0.25）：
 * 这里取 0.3，意味着一手"把阵容结构从及格线拉到好"的差别，和"某个号位胜率高 2 个百分点"
 * 相当；而踩红线（第四个近战、第三个纯核）扣的分足以让它排到替代方案后面。
 */
export const COMPOSITION_WEIGHT = 0.3;

interface PoolHero {
	hero: DraftHero;
	/** 按号位索引（0 是一号位）的胜率，样本不足处为 null。 */
	rates: (number | null)[];
	matches: number[];
}

/** 打分时要看的对手阵容：对面已经选了谁，就按这些对位来算克制。 */
interface RateContext {
	matchups: HeroMatchups | undefined;
	foeIds: readonly number[];
}

export interface CounterSummary {
	/** 与对面已选英雄的平均胜率偏差（正数代表好打）。没有可用对位时为 0。 */
	delta: number;
	/** 用上的对位数。 */
	pairs: number;
	/** 这些对位的总场次。 */
	games: number;
	/** 每个可用对位的明细，按场次从多到少，用来写依据。 */
	details: { heroId: number; rate: number; games: number }[];
}

/**
 * 一个英雄面对对面已选的这几个英雄，对位数据怎么说。
 *
 * 平均的是**偏差**而不是胜率：没有对位记录的对手不参与，免得把"没有样本"算成五五开。
 * 一件要说明的事：这里不区分分路，四号位和对面一号位的对位也算在里面，
 * 所以它是个粗口径的克制信号，不是分路克制。
 */
function counterSummary(matchups: HeroMatchups | undefined, heroId: number, foeIds: readonly number[]): CounterSummary {
	const details: CounterSummary['details'] = [];
	for (const foeId of foeIds) {
		const cell = matchupRate(matchups, heroId, foeId);
		if (cell) details.push({ heroId: foeId, rate: cell.rate, games: cell.games });
	}
	if (details.length === 0) return { delta: 0, pairs: 0, games: 0, details: [] };
	details.sort((a, b) => b.games - a.games);
	const delta = details.reduce((sum, row) => sum + (row.rate - 0.5), 0) / details.length;
	return { delta, pairs: details.length, games: details.reduce((sum, row) => sum + row.games, 0), details };
}

function toPoolHero(hero: DraftHero): PoolHero {
	const rates: (number | null)[] = [];
	const matches: number[] = [];
	for (let index = 0; index < 5; index += 1) {
		const cell = hero.positions[index];
		rates.push(cell && cell[0] > 0 ? cell[1] / cell[0] : null);
		matches.push(cell?.[0] ?? 0);
	}
	return { hero, rates, matches };
}

/**
 * 某个英雄在某个号位上的"有效胜率"：号位胜率再加上对位上的加减。
 * 号位没有样本时按中性，再叠对位；对位也没有时就是中性值。
 */
function rateAt(entry: PoolHero, position: number, ctx: RateContext): number {
	const base = entry.rates[position - 1] ?? NEUTRAL_WIN_RATE;
	const counter = counterSummary(ctx.matchups, entry.hero.id, ctx.foeIds);
	return base + counter.delta * COUNTER_WEIGHT;
}

/**
 * 把一组英雄分配到五个号位，让胜率之和最大（每个号位一个人）。
 * 一支队伍最多五个人，穷举 5! = 120 种分配，比任何近似都便宜且准确。
 *
 * 超过五个时只分配前五个：调用方本来就该先判断"这一方是不是已经挑满了"，
 * 这里只是不让越界变成崩溃。
 */
function bestAssignment(entries: readonly PoolHero[], ctx: RateContext): { positions: number[]; total: number } {
	const list = entries.slice(0, 5);
	const used = new Array(5).fill(false);
	const picked = new Array(list.length).fill(0);
	let bestTotal = -Infinity;
	let bestPositions = list.map((_, index) => index + 1);

	const walk = (index: number, total: number): void => {
		if (index === list.length) {
			if (total > bestTotal) {
				bestTotal = total;
				bestPositions = [...picked];
			}
			return;
		}
		for (let position = 1; position <= 5; position += 1) {
			if (used[position - 1]) continue;
			used[position - 1] = true;
			picked[index] = position;
			walk(index + 1, total + rateAt(list[index], position, ctx));
			used[position - 1] = false;
		}
	};

	walk(0, 0);
	return { positions: bestPositions, total: bestTotal };
}

export interface LineupSlot {
	position: number;
	/** 预计站这个号位的人。 */
	hero: DraftHero | null;
	rate: number;
	/**
	 * 不含对位加成的号位胜率。复盘要把「号位强」和「对位强」分开说，
	 * 所以两个口径都得留着；建议面板只用 `rate`。
	 */
	baseRate?: number;
	/** 这一手已经拿到手（true），还是估计以后能补上（false）。 */
	settled: boolean;
}

interface GapSlot {
	position: number;
	hero: DraftHero | null;
	rate: number;
}

/**
 * 还没落人的号位，预计能补到什么。
 *
 * 把可选英雄在该号位的胜率降序排，取第 `contested + 1` 个：对面每挑走一个，我们能指望的
 * 就差一档。**选项不够拿走时按 0 算**，不退回最后一个：某个号位整个英雄池只有两个人能打，
 * 而对面还有三手挑选，那这个位置就是真的靠不住。
 *
 * 这一条是"现在拿"能不能体现出收益的前提。如果选项不够时仍按最好的那个估，就等于假设
 * 最强的英雄一定留得到后面，于是每个候选的收益都趋近于零，建议也就没有意义了。
 *
 * 五个号位**一起**填，已经填过的英雄不再参与后面的号位：分开算的话，同一个英雄会同时出现在
 * 四号位和五号位的"预计能补到"里，界面上看起来像多了一个人。
 */
function fillGaps(
	pool: readonly PoolHero[],
	hasOwner: ReadonlySet<number>,
	used: ReadonlySet<number>,
	contested: number,
	ctx: RateContext,
): Map<number, GapSlot> {
	const optionsAt = (position: number, taken: ReadonlySet<number>) =>
		pool
			.filter((entry) => !taken.has(entry.hero.id))
			// 排序口径要和打分一致（号位胜率 + 对位加成），否则"预计能补到谁"和"该不该现在拿"会打架。
			.map((entry) => ({
				entry,
				rate: entry.rates[position - 1],
				delta: counterSummary(ctx.matchups, entry.hero.id, ctx.foeIds).delta,
			}))
			.filter((row): row is { entry: PoolHero; rate: number; delta: number } => typeof row.rate === 'number')
			.map((row) => ({ entry: row.entry, rate: row.rate + row.delta * COUNTER_WEIGHT }))
			.sort((a, b) => b.rate - a.rate);

	const gaps = new Map<number, GapSlot>();
	const taken = new Set(used);
	/** 先填选择最少的号位：这类位置最容易"没得补"，留给后面会低估。 */
	const positions = [1, 2, 3, 4, 5]
		.filter((position) => !hasOwner.has(position))
		.sort((a, b) => optionsAt(a, taken).length - optionsAt(b, taken).length);

	for (const position of positions) {
		const options = optionsAt(position, taken);
		if (contested >= options.length) {
			gaps.set(position, { position, hero: null, rate: 0 });
			continue;
		}
		const picked = options[contested];
		gaps.set(position, { position, hero: picked.entry.hero, rate: picked.rate });
		taken.add(picked.entry.hero.id);
	}
	return gaps;
}

interface Estimate {
	slots: LineupSlot[];
	total: number;
}

/** 把一串英雄 id 变成可分配的对象；表里查不到的 id（英雄被删之类）直接跳过。 */
function idsToPool(byId: ReadonlyMap<number, DraftHero>, ids: readonly number[]): PoolHero[] {
	return ids
		.map((id) => byId.get(id))
		.filter((hero): hero is DraftHero => Boolean(hero))
		.map(toPoolHero);
}

/**
 * 估一套阵容：已经拿到的人按最优方式落位，还没落人的号位按"被打劫之后还能补到谁"折价。
 * `contested` 是对面剩下的挑选手数（调用方已经封顶）。
 */
function estimate(
	pool: readonly PoolHero[],
	ownedIds: readonly number[],
	byId: ReadonlyMap<number, DraftHero>,
	contested: number,
	ctx: RateContext,
): Estimate {
	const owned = idsToPool(byId, ownedIds);
	const assignment = bestAssignment(owned, ctx);
	const used = new Set(ownedIds);
	const hasOwner = new Set(assignment.positions);
	const gaps = fillGaps(pool, hasOwner, used, contested, ctx);
	const slots: LineupSlot[] = [];

	for (let position = 1; position <= 5; position += 1) {
		const ownerIndex = assignment.positions.findIndex((assigned) => assigned === position);
		if (ownerIndex >= 0) {
			const entry = owned[ownerIndex];
			slots.push({ position, hero: entry.hero, rate: rateAt(entry, position, ctx), settled: true });
			continue;
		}
		const gap = gaps.get(position) ?? { position, hero: null, rate: 0 };
		slots.push({ position, hero: gap.hero, rate: gap.rate, settled: false });
	}

	return { slots, total: slots.reduce((sum, slot) => sum + slot.rate, 0) };
}

export interface AdviceCandidate {
	heroId: number;
	/** 建议让它打几号位。 */
	position: number;
	/** 该号位胜率（0-1）。 */
	rate: number;
	/** 这个号位有没有真实样本。 */
	hasSample: boolean;
	/** 排序用分值，不直接展示。 */
	ranking: number;
	/** 主要依据，全部带数字，可逐条核对。 */
	reasons: string[];
	/** 风险或不适用条件。 */
	risk: string;
}

export interface Advice {
	action: DraftAction;
	owner: DraftOwner;
	/** 这一手是不是我方的。 */
	ours: boolean;
	step: number;
	remaining: { ours: { bans: number; picks: number }; theirs: { bans: number; picks: number } };
	/** 最后一手禁用与最后一手挑选各归谁。 */
	tail: { ban: 'ours' | 'theirs'; pick: 'ours' | 'theirs' };
	/** 我方阵容现状：已经到手的人，加上各号位预计能补到谁。 */
	lineup: LineupSlot[];
	candidates: AdviceCandidate[];
	/**
	 * 对面近期真的在拿、且**不在** `candidates` 前几名里的英雄。
	 *
	 * 单独一栏而不是并进 `candidates`：全局号位胜率与「这支队爱用什么」是两种依据，
	 * 混在一起排会让其中一种悄悄决定顺序。界面上分开放，模型两边都能挑。
	 */
	foeCandidates: AdviceCandidate[];
	/** 一句话总体判断，界面直接显示。 */
	summary: string;
	/** 阵容能力维度的现状与缺口，界面上单列一行；也是模型判断"这一手补什么"的依据。 */
	composition: { text: string; enemySummon: boolean };
}

/** 时间曲线的比较基准：同池中位，避免拿绝对值硬比（不同版本、不同分段都在变）。 */
interface TimelineContext {
	early: number;
	late: number;
}

/** 中位数。样本为空时返回 0，调用方按"没有基准"处理。 */
function median(values: number[]): number {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/** 池子里所有英雄的前/后期切点中位，作为"不弱于中位"的基准线。 */
function timelineContext(pool: readonly PoolHero[]): TimelineContext {
	const early = pool.map((entry) => entry.hero.timeline?.[0] ?? 0).filter((value) => value > 0);
	const late = pool.map((entry) => entry.hero.timeline?.[1] ?? 0).filter((value) => value > 0);
	return { early: median(early), late: median(late) };
}

export interface StructureProfile {
	/** 控制/爆发/先手/上高/前排/辅助，都是官方角色等级之和。 */
	values: Record<string, number>;
	/** 远程与清场（AoE）的人数。 */
	ranged: number;
	clear: number;
	/** 团战点人数。 */
	teamfight: number;
	/** 前期、后期不弱于同池中位的人数。 */
	phaseEarly: number;
	phaseLate: number;
	/** 红线：纯核（核心 ≥ 2 且没有辅助等级）人数与近战人数。 */
	greedyCore: number;
	melee: number;
	summon: boolean;
}

/**
 * 算一套阵容的结构画像。
 *
 * 能力维度用官方角色标签的等级之和，不是"有几个英雄会控制"：
 * 一个 3 级控制（如沙王）和一个 1 级控制，在阵容里的分量本来就不同。
 */
function structureProfile(heroes: readonly DraftHero[], timeline: TimelineContext): StructureProfile {
	const values: Record<string, number> = {};
	for (const dim of COMPOSITION_TARGETS) values[dim.key] = 0;
	const profile: StructureProfile = { values, ranged: 0, clear: 0, teamfight: 0, phaseEarly: 0, phaseLate: 0, greedyCore: 0, melee: 0, summon: false };
	for (const hero of heroes) {
		for (const dim of COMPOSITION_TARGETS) values[dim.key] += hero.roles[dim.role] ?? 0;
		if (hero.attack === 'ranged') profile.ranged += 1;
		else profile.melee += 1;
		if (hero.aoe) profile.clear += 1;
		if (hero.teamfight) profile.teamfight += 1;
		if ((hero.roles[ROLE_CARRY] ?? 0) >= 2 && (hero.roles[ROLE_SUPPORT] ?? 0) === 0) profile.greedyCore += 1;
		if (hero.summon) profile.summon = true;
		// 曲线为 0 表示没拿到这个英雄的曲线，不参与前后期计数。
		const earlyRate = hero.timeline?.[0] ?? 0;
		const lateRate = hero.timeline?.[1] ?? 0;
		if (earlyRate > 0 && earlyRate >= timeline.early) profile.phaseEarly += 1;
		if (lateRate > 0 && lateRate >= timeline.late) profile.phaseLate += 1;
	}
	return profile;
}

interface StructureScore {
	/** 总分：满意度减去红线惩罚，可能为负。 */
	score: number;
	/** 达标程度（0-1）：各拿分项"填满比例"的平均。 */
	satisfaction: number;
	/** 红线惩罚（0 起，越大越糟）。 */
	penalty: number;
}

/** 一套阵容的结构得分。**过量要扣分**，这是上一版缺的那一半。 */
function structureScore(profile: StructureProfile, enemySummon: boolean): StructureScore {
	const dims: number[] = COMPOSITION_TARGETS.map((dim) => {
		const value = profile.values[dim.key] ?? 0;
		return Math.min(value, dim.target) / dim.target;
	});
	dims.push(Math.min(profile.ranged, RANGED_TARGET) / RANGED_TARGET);
	dims.push(Math.min(profile.teamfight, TEAMFIGHT_TARGET) / TEAMFIGHT_TARGET);
	dims.push(Math.min(profile.clear, enemySummon ? AOE_TARGET_VS_SUMMON : AOE_TARGET_BASE) / (enemySummon ? AOE_TARGET_VS_SUMMON : AOE_TARGET_BASE));
	dims.push(Math.min(profile.phaseEarly, PHASE_TARGET) / PHASE_TARGET);
	dims.push(Math.min(profile.phaseLate, PHASE_TARGET) / PHASE_TARGET);
	const satisfaction = dims.reduce((sum, value) => sum + value, 0) / dims.length;

	const penalties = STRUCTURE_CAPS.map((cap) => Math.max(0, cap.count(profile) - cap.cap) / cap.cap);
	const penalty = penalties.reduce((sum, value) => sum + value, 0) / penalties.length;

	return { score: satisfaction - CAP_PENALTY_SCALE * penalty, satisfaction, penalty };
}

interface StructureDelta {
	/** 这一手对结构得分的影响（正数=变好）。 */
	delta: number;
	/** 填得最多的那个缺口，用来写正面依据。 */
	/** 填上的缺口，最多两条（控制 + 团战这种组合要能一起说出来）。 */
	fills: { label: string; current: number; target: number; supply: number }[];
	/** 踩到的红线，用来写风险。 */
	violation: { label: string; count: number; cap: number } | null;
}

/**
 * 把一个候选代进阵容，看结构是变好还是变差。
 *
 * 和上一版的区别：这里比的是**整队结构分**，所以第四个近战、第三个纯核会被算成负收益，
 * 而不是像过去那样"只要还有别的缺口就继续加分"。
 */
function structureDelta(candidate: DraftHero, ours: readonly DraftHero[], timeline: TimelineContext, enemySummon: boolean): StructureDelta {
	const before = structureScore(structureProfile(ours, timeline), enemySummon);
	const after = structureScore(structureProfile([...ours, candidate], timeline), enemySummon);

	const beforeProfile = structureProfile(ours, timeline);
	/** 拿分项要和 `structureScore` 里那套完全一致，否则"补了什么"会说错。 */
	const dims = [
		...COMPOSITION_TARGETS.map((dim) => ({
			label: dim.label,
			current: beforeProfile.values[dim.key] ?? 0,
			target: dim.target,
			supply: candidate.roles[dim.role] ?? 0,
		})),
		{ label: '远程', current: beforeProfile.ranged, target: RANGED_TARGET, supply: candidate.attack === 'ranged' ? 1 : 0 },
		{ label: '团战', current: beforeProfile.teamfight, target: TEAMFIGHT_TARGET, supply: candidate.teamfight ? 1 : 0 },
		{
			label: '清场',
			current: beforeProfile.clear,
			target: enemySummon ? AOE_TARGET_VS_SUMMON : AOE_TARGET_BASE,
			supply: candidate.aoe ? 1 : 0,
		},
		{
			label: '前期',
			current: beforeProfile.phaseEarly,
			target: PHASE_TARGET,
			supply: (candidate.timeline?.[0] ?? 0) > 0 && (candidate.timeline?.[0] ?? 0) >= timeline.early ? 1 : 0,
		},
		{
			label: '后期',
			current: beforeProfile.phaseLate,
			target: PHASE_TARGET,
			supply: (candidate.timeline?.[1] ?? 0) > 0 && (candidate.timeline?.[1] ?? 0) >= timeline.late ? 1 : 0,
		},
	];
	const fills = dims
		.map((dim) => ({ ...dim, filled: Math.min(Math.max(0, dim.target - dim.current), dim.supply) }))
		.sort((a, b) => b.filled - a.filled);

	// 红线：候选把哪一项推过了上限。只看"越过"的那一格，已经在红线外的阵容不再重复扣。
	const violation =
		STRUCTURE_CAPS.map((cap) => {
			const count = cap.count(structureProfile([...ours, candidate], timeline));
			const previous = cap.count(beforeProfile);
			return { label: cap.label, count, cap: cap.cap, crossed: count > cap.cap && count > previous };
		}).find((item) => item.crossed) ?? null;

	return {
		delta: after.score - before.score,
		fills: fills.filter((dim) => dim.filled > 0).slice(0, 2),
		violation: violation ? { label: violation.label, count: violation.count, cap: violation.cap } : null,
	};
}

export interface AdviseInput {
	data: DraftData;
	recorded: readonly RecordedHand[];
	ourSide: DraftSide;
	firstPicker: DraftSide;
	/** 返回几个候选。 */
	limit?: number;
	/** 对面近期的英雄偏好；没有就按「不认识这支队」算。 */
	foeForm?: FoeForm | null;
	/**
	 * 线上对位（谁在线上打谁、和谁走一路）。**可选增强**：拿不到就少一条依据，
	 * 不影响号位胜率、估值与其它依据——它与整局对位是两套口径，不能互相顶替。
	 */
	lanes?: LaneData | null;
	/**
	 * 这份偏好属于哪一边，默认 `theirs`（对面）。
	 * 替对面落子时传 `ours`：同一个队的数据，人称要翻过来。
	 */
	foeSide?: 'ours' | 'theirs';
}

const pct = (rate: number): string => `${(rate * 100).toFixed(1)}%`;

/** 胜率的抽样波动。用最保守的 p=0.5 估，只为了提示这个数字有多虚。 */
function noise(matches: number): string {
	return `±${(1.96 * Math.sqrt(0.25 / Math.max(matches, 1)) * 100).toFixed(1)}`;
}

/**
 * 把对位结果写成一句依据。
 *
 * 列名字时按样本从多到少取前三个，样本列出来，是因为这种"平均胜率"最容易让人忘记
 * 它背后有多少场：两个对位、每个几百场，和一个对位一万场，可信度差着量级。
 */
function counterText(
	counter: CounterSummary,
	foeIds: readonly number[],
	byId: ReadonlyMap<number, DraftHero>,
	prefix: string,
): string {
	const names = counter.details
		.slice(0, 3)
		.map((row) => byId.get(row.heroId)?.name ?? `英雄 #${row.heroId}`)
		.join('、');
	const rest = foeIds.length > counter.details.length ? `，另有 ${foeIds.length - counter.details.length} 个对手没有可用对位` : '';
	return `${prefix} ${names}${rest}：平均胜率 ${pct(0.5 + counter.delta)}（覆盖 ${counter.games.toLocaleString('zh-CN')} 场）`;
}

/**
 * 把线上对位写成一句依据。
 *
 * 与 `counterText` 分开，是因为这两个数字不是一个东西：那里是**整局**胜率，这里是**线上**
 * 净胜（线上胜 − 线上负）。写在同一句里会让人以为是一件事的两半。
 */
function laneText(edge: LaneEdge, byId: ReadonlyMap<number, DraftHero>, prefix: string): string {
	const names = edge.cells
		.slice(0, 3)
		.map((cell) => byId.get(cell.otherId)?.name ?? `英雄 #${cell.otherId}`)
		.join('、');
	const rest = edge.pairs > 3 ? `，另有 ${edge.pairs - 3} 个` : '';
	return `${prefix} ${names}${rest}：平均净对线 ${formatNet(edge.net)}（线上 ${edge.matches.toLocaleString('zh-CN')} 场）`;
}

/**
 * 号位这件事的风险提示。
 *
 * 建议的号位来自"五个号位胜率之和最大"的分配，可能落在英雄的次级位置上（它的主位置
 * 已经被别人占着）。这种情况要写出来：一个英雄在四号位有 58% 胜率但只有 300 场样本，
 * 和一个在三号位打了一万场的英雄，可信度不是一回事。
 */
function positionRisk(hero: DraftHero, position: number, matches: number): string {
	const base = `样本 ${matches.toLocaleString('zh-CN')} 场，胜率波动约 ${noise(matches)} 个百分点`;
	let main: { position: number; matches: number } | null = null;
	for (let index = 0; index < 5; index += 1) {
		const cell = hero.positions[index];
		if (!cell) continue;
		if (!main || cell[0] > main.matches) main = { position: index + 1, matches: cell[0] };
	}
	if (main && main.position !== position && main.matches > matches * 2) {
		return `${base}；它本周主要打 ${main.position} 号位（${main.matches.toLocaleString('zh-CN')} 场），放在 ${position} 号位是次级位置`;
	}
	return base;
}

/**
 * 给当前这一手出建议。顺序走完、或者一份英雄数据都没有时返回 null，
 * 调用方按"这次给不出建议"处理，不要挡住录制。
 */
export function advise(input: AdviseInput): Advice | null {
	const { data, recorded, ourSide, firstPicker } = input;
	const foeForm = input.foeForm ?? null;
	const foeSide = input.foeSide ?? 'theirs';
	const lanes = input.lanes ?? null;
	const limit = input.limit ?? 5;
	const state = snapshot(recorded);
	if (state.done || !state.action || !state.owner || data.heroes.length === 0) return null;

	const byId = new Map(data.heroes.map((hero) => [hero.id, hero]));
	const ourIds: number[] = [];
	const theirIds: number[] = [];
	for (let index = 0; index < state.cursor; index += 1) {
		const heroId = recorded[index];
		if (typeof heroId !== 'number') continue;
		// 手号从 1 起，索引正好对应顺序表里的第 index + 1 手。
		const step = CM_STEPS[index];
		// 只有挑选才进阵容：被禁掉的英雄已经从候选池里排除了，不属于任何一方的阵容。
		if (step.action !== 'pick') continue;
		const side = sideOfOwner(step.owner, firstPicker);
		if (side === ourSide) ourIds.push(heroId);
		else theirIds.push(heroId);
	}

	const pool = data.heroes.filter((hero) => !state.used.has(hero.id)).map(toPoolHero);
	const ownerIsOurs = sideOfOwner(state.owner, firstPicker) === ourSide;

	// 剩余手数按先选/后选分别数，再折到我方/对方。
	const remaining: Advice['remaining'] = { ours: { bans: 0, picks: 0 }, theirs: { bans: 0, picks: 0 } };
	for (let index = state.cursor; index < CM_STEPS.length; index += 1) {
		const step = CM_STEPS[index];
		const bucket = sideOfOwner(step.owner, firstPicker) === ourSide ? remaining.ours : remaining.theirs;
		if (step.action === 'ban') bucket.bans += 1;
		else bucket.picks += 1;
	}

	const tail: Advice['tail'] = {
		ban: sideOfOwner(state.tail.ban, firstPicker) === ourSide ? 'ours' : 'theirs',
		pick: sideOfOwner(state.tail.pick, firstPicker) === ourSide ? 'ours' : 'theirs',
	};
	const contestedByUs = Math.min(CONTEST_CAP, remaining.theirs.picks);
	const contestedByThem = Math.min(CONTEST_CAP, remaining.ours.picks);

	/**
	 * 两边的对位口径各看对方的阵容：我们的阵容按"对面已经选了谁"评估，
	 * 对面的阵容按"我们已经选了谁"评估。
	 */
	const ourCtx: RateContext = { matchups: data.matchups, foeIds: theirIds };
	const theirCtx: RateContext = { matchups: data.matchups, foeIds: ourIds };
	const ourBase = estimate(pool, ourIds, byId, contestedByUs, ourCtx);
	const theirBase = estimate(pool, theirIds, byId, contestedByThem, theirCtx);
	/** 能力维度只跟我们自己（或对面）已经选到的人有关，没选的先不算。 */
	const ourHeroes = ourIds.map((id) => byId.get(id)).filter((hero): hero is DraftHero => Boolean(hero));
	const theirHeroes = theirIds.map((id) => byId.get(id)).filter((hero): hero is DraftHero => Boolean(hero));
	/*
	 * 线上对位要「谁打几号位」才能反方向查表（见 `laneEdgeEither`）：号位用估值那一步分配好的结果，
	 * 不然就得为每一手重新分配一次。
	 *
	 * **只取 `settled` 的人**：估值那一步的空位是拿「预计能补到」的预测英雄填的，
	 * 把它们也算进来，依据里那句「线上对上他们已选」就名不副实了——同一张卡片里的整局对位
	 * 用的是真实已选，两个数字会互相核不上。前面还没人选时就不出这条依据，与整局对位一致。
	 */
	const slotsOf = (report: { slots: { position: number; hero: DraftHero | null; settled: boolean }[] }): { id: number; position: number }[] =>
		report.slots.filter((slot) => slot.settled && slot.hero).map((slot) => ({ id: slot.hero!.id, position: slot.position }));
	const ourSlots = slotsOf(ourBase);
	const theirSlots = slotsOf(theirBase);
	const enemySummon = theirHeroes.some((hero) => hero.summon);
	/** 前后期基准取同池中位：不拿绝对值硬比（不同版本、不同分段都在变）。 */
	const timeline = timelineContext(pool);
	const ourProfile = structureProfile(ourHeroes, timeline);
	/** 有一方已经挑满五个人时，再算"多拿一个"没有意义，也不能拿去分配号位。 */
	const oursFull = ourIds.length >= 5;
	const theirsFull = theirIds.length >= 5;

	const candidates: AdviceCandidate[] = [];
	for (const entry of pool) {
		const hero = entry.hero;
		const proText = hero.pro[0] + hero.pro[2] > 0 ? `职业样本里出场 ${hero.pro[0]} 次、被禁 ${hero.pro[2]} 次` : '';

		if (state.action === 'pick') {
			const oursAfter = oursFull ? ourBase : estimate(pool, [...ourIds, hero.id], byId, contestedByUs, ourCtx);
			const assignment = bestAssignment(idsToPool(byId, [...ourIds, hero.id]), ourCtx);
			const position = assignment.positions[assignment.positions.length - 1] ?? 1;
			const rate = entry.rates[position - 1];
			const matches = entry.matches[position - 1];
			const reasons = [
				rate === null
					? `${position} 号位近 ${data.windowDays} 天没有足够样本，只能按中性估`
					: `${position} 号位近 ${data.windowDays} 天胜率 ${pct(rate)}（${matches.toLocaleString('zh-CN')} 场）`,
				`现在拿：五号位估值 ${pct(ourBase.total / 5)} → ${pct(oursAfter.total / 5)}`,
			];
			// 对面近期真拿过的英雄单独点一句：这一手是抢对面的熟手，还是与我们无关。
			const foeLine = foeHeroLine(foeForm, hero.id, foeSide);
			if (foeLine) reasons.push(foeLine);
			// 对位（克制）单独列一条，数字原样给出来：它是个粗口径信号，让人能自己判断。
			const counter = counterSummary(data.matchups, hero.id, theirIds);
			if (counter.pairs > 0) reasons.push(counterText(counter, theirIds, byId, '对阵对面已选'));
			/*
			 * 线上两条：这是一整套阵容打完的胜率之外的另一半信息。
			 * 整局对位说「这一手值不值」，线上的说「这条线开局好过不好过」——BP 里这是两回事。
			 */
			const lane = laneEdgeEither(lanes?.vs, hero.id, position, theirSlots);
			if (lane) reasons.push(laneText(lane, byId, '线上对上他们已选'));
			const partnerPosition = lanePartnerPosition(position);
			const partnerIndex = partnerPosition === null ? -1 : assignment.positions.findIndex((assigned) => assigned === partnerPosition);
			if (partnerIndex >= 0 && partnerIndex !== assignment.positions.length - 1) {
				const partner = [...ourIds, hero.id][partnerIndex];
				const partnerLane = laneEdge(lanes?.with, hero.id, position, [partner]);
				if (partnerLane) {
					const partnerName = byId.get(partner)?.name ?? `英雄 #${partner}`;
					reasons.push(`和我们的 ${partnerName} 同路（${partnerLane.matches.toLocaleString('zh-CN')} 场）：线上净对线 ${formatNet(partnerLane.net)}`);
				}
			}
			const structure = structureDelta(hero, ourHeroes, timeline, enemySummon);
			if (structure.fills.length > 0) {
				const labels = structure.fills.map((dim) => dim.label).join('、');
				const detail = structure.fills.map((dim) => `${dim.label} ${dim.current}/${dim.target}，它能给 ${dim.supply}`).join('；');
				reasons.push(`补上阵容缺的${labels}（${detail}）`);
			}
			if (proText) reasons.push(proText);
			// 结构扣分要写进风险：光说"补了什么"会让一个把阵容带歪的选择显得很好。
			const structureRisk = structure.violation
				? `会让阵容变成 ${structure.violation.count} 个${structure.violation.label}（上限 ${structure.violation.cap}）`
				: '';
			candidates.push({
				heroId: hero.id,
				position,
				rate: rate ?? NEUTRAL_WIN_RATE,
				hasSample: rate !== null,
				ranking: oursAfter.total - ourBase.total + structure.delta * COMPOSITION_WEIGHT,
				reasons,
				risk:
					structureRisk ||
					(rate === null
						? '这个号位几乎没有高分局样本，估值只能当参考'
						: positionRisk(hero, position, matches)),
			});
			continue;
		}

		// 禁用：对面拿了能涨多少（威胁），我们自己拿了能涨多少（该不该留）。
		const theirsAfter = theirsFull ? theirBase : estimate(pool, [...theirIds, hero.id], byId, contestedByThem, theirCtx);
		const oursAfter = oursFull ? ourBase : estimate(pool, [...ourIds, hero.id], byId, contestedByUs, ourCtx);
		const threat = theirsAfter.total - theirBase.total;
		const ownGain = oursAfter.total - ourBase.total;
		const assignment = bestAssignment(idsToPool(byId, [...theirIds, hero.id]), theirCtx);
		const position = assignment.positions[assignment.positions.length - 1] ?? 1;
		const rate = entry.rates[position - 1];
		const matches = entry.matches[position - 1];
		const reasons = [
			rate === null
				? `对面可能拿它打 ${position} 号位，但这个位置没有足够样本`
				: `对面拿它打 ${position} 号位的话，该号位胜率 ${pct(rate)}（${matches.toLocaleString('zh-CN')} 场）`,
			`禁掉它，对面阵容估值 ${pct(theirBase.total / 5)} → ${pct((theirBase.total - threat) / 5)}`,
		];
		// 对面的熟手优先禁：这一句是他们近期比赛里的次数与胜率，不是「版本强势」的转述。
		const foeLine = foeHeroLine(foeForm, hero.id, foeSide);
		if (foeLine) reasons.push(foeLine);
		const counter = counterSummary(data.matchups, hero.id, ourIds);
		if (counter.pairs > 0) reasons.push(counterText(counter, ourIds, byId, '它打我们已选'));
		// 对面拿它之后，我们这条线要被压成什么样——与整局对位分开写。
		const lane = laneEdgeEither(lanes?.vs, hero.id, position, ourSlots);
		if (lane) reasons.push(laneText(lane, byId, '它在线上对上我们已选'));
		// 对面拿到它能补上他们缺的维度，也算威胁。
		const structureForThem = structureDelta(hero, theirHeroes, timeline, ourHeroes.some((item) => item.summon));
		if (structureForThem.fills.length > 0) {
			const labels = structureForThem.fills.map((dim) => dim.label).join('、');
			const detail = structureForThem.fills.map((dim) => `${dim.label} ${dim.current}/${dim.target}`).join('；');
			reasons.push(`对面拿到它正好补上他们的${labels}（${detail}）`);
		}
		if (ownGain > 0) reasons.push(`我们自己拿它可以涨 ${((ownGain * 100) / 5).toFixed(2)} 个百分点`);
		if (proText) reasons.push(proText);
		candidates.push({
			heroId: hero.id,
			position,
			rate: rate ?? NEUTRAL_WIN_RATE,
			hasSample: rate !== null,
			// 自己更想要的英雄先不急着禁：威胁减去一半的自身收益。
			ranking: threat + structureForThem.delta * COMPOSITION_WEIGHT - ownGain * 0.5,
			reasons,
			risk: ownGain > threat ? '我们自己拿它收益更大，后面还轮得到的话可以考虑留' : '禁用只是止损，补不上我们自己阵容的缺口',
		});
	}

	candidates.sort((a, b) => b.ranking - a.ranking);
	/** 已经排进候选前列的，不再重复出现在「对面擅长」那一栏。 */
	const shown = candidates.slice(0, limit);
	const shownIds = new Set(shown.map((candidate) => candidate.heroId));
	const byHeroId = new Map(candidates.map((candidate) => [candidate.heroId, candidate]));
	const foeCandidates = foeHighlights(foeForm)
		.map((row) => byHeroId.get(row.heroId))
		.filter((candidate): candidate is AdviceCandidate => candidate !== undefined && !shownIds.has(candidate.heroId));

	const gaps = ourBase.slots.filter((slot) => !slot.settled).map((slot) => slot.position);
	const turnText = `${ownerIsOurs ? '我方' : '对方'}${state.action === 'ban' ? '禁用' : '挑选'}`;
	const tailText =
		tail.ban === tail.pick
			? `最后一手禁用和最后一手挑选都在${tail.ban === 'ours' ? '我方' : '对方'}手上`
			: `最后一手禁用归${tail.ban === 'ours' ? '我方' : '对方'}、最后一手挑选归${tail.pick === 'ours' ? '我方' : '对方'}`;
	const gapText = gaps.length > 0 ? `我方还缺 ${gaps.join('、')} 号位` : '我方五个号位都已经落人';
	const summary = `第 ${state.nextStep} 手：${turnText}。我方还剩 ${remaining.ours.bans} 禁 ${remaining.ours.picks} 选，对方还剩 ${remaining.theirs.bans} 禁 ${remaining.theirs.picks} 选；${tailText}。${gapText}，当前估值 ${pct(ourBase.total / 5)}。`;
	/** 界面上那行结构现状：拿分项 + 红线 + 时间曲线，一次说清"这套阵容缺什么、怕什么"。 */
	const structureParts = COMPOSITION_TARGETS.map((dim) => `${dim.label} ${ourProfile.values[dim.key] ?? 0}/${dim.target}`);
	structureParts.push(`远程 ${ourProfile.ranged}/${RANGED_TARGET}`);
	structureParts.push(`团战 ${ourProfile.teamfight}/${TEAMFIGHT_TARGET}`);
	structureParts.push(`清场 ${ourProfile.clear}/${enemySummon ? AOE_TARGET_VS_SUMMON : AOE_TARGET_BASE}`);
	structureParts.push(`纯核 ${ourProfile.greedyCore}/${STRUCTURE_CAPS[0].cap}`);
	structureParts.push(`近战 ${ourProfile.melee}/${STRUCTURE_CAPS[1].cap}`);
	structureParts.push(`前期不弱 ${ourProfile.phaseEarly}/${PHASE_TARGET}`);
	structureParts.push(`后期不弱 ${ourProfile.phaseLate}/${PHASE_TARGET}`);
	const compositionText = `阵容结构：${structureParts.join('、')}${enemySummon ? '（对面是幻象/召唤体系，清场要求提高）' : ''}`;

	return {
		action: state.action,
		owner: state.owner,
		ours: ownerIsOurs,
		step: state.nextStep,
		remaining,
		tail,
		lineup: ourBase.slots,
		candidates: shown,
		foeCandidates,
		summary,
		composition: { text: compositionText, enemySummon },
	};
}

// ---------------------------------------------------------------- 双方阵容锁定的对比

/**
 * 一套阵容的侧写，给「双方都选完之后」的复盘用。
 *
 * 与 `advise` 同源：同一套号位分配、同一个结构画像、同一个对位口径。
 * 这样「边打边给的建议」和「打完了给的复盘」不会各用一套标准。
 */
export interface LineupReport {
	/** 五个号位分别落在谁身上；没人的位置 `hero` 是 null、胜率按中性值算。 */
	slots: LineupSlot[];
	/** 五个号位胜率之和，**只含号位本身**（不含对位加成）。 */
	baseTotal: number;
	/** 五个号位胜率之和，含对位加成。界面上的「平均号位胜率」用它除以 5。 */
	total: number;
	profile: StructureProfile;
	/** 结构分：维度满意度减去红线惩罚，可能为负。 */
	structure: number;
	/** 这套阵容每个人对对面五个人平均下来的对位偏差之和。 */
	counter: CounterSummary;
}

export function lineupReport(data: DraftData, heroIds: readonly number[], foeIds: readonly number[]): LineupReport | null {
	const byId = new Map(data.heroes.map((hero) => [hero.id, hero]));
	const owned = idsToPool(byId, heroIds);
	if (owned.length === 0) return null;

	const ctx: RateContext = { matchups: data.matchups, foeIds };
	const assignment = bestAssignment(owned, ctx);
	const slots: LineupSlot[] = [];
	let baseTotal = 0;
	let total = 0;
	for (let position = 1; position <= 5; position += 1) {
		const index = assignment.positions.findIndex((assigned) => assigned === position);
		const entry = index >= 0 ? owned[index] : undefined;
		const rate = entry ? rateAt(entry, position, ctx) : NEUTRAL_WIN_RATE;
		const base = entry ? entry.rates[position - 1] ?? NEUTRAL_WIN_RATE : NEUTRAL_WIN_RATE;
		baseTotal += base;
		total += rate;
		slots.push({ position, hero: entry?.hero ?? null, rate, baseRate: base, settled: Boolean(entry) });
	}

	// 时间曲线的基准取全池中位：两边都选完了，「还能补到谁」已经不是问题。
	const timeline = timelineContext(data.heroes.map(toPoolHero));
	const heroes = owned.map((entry) => entry.hero);
	const profile = structureProfile(heroes, timeline);
	const structure = structureScore(profile, foeIds.some((id) => byId.get(id)?.summon ?? false));
	return { slots, baseTotal, total, profile, structure: structure.score, counter: lineupCounter(data.matchups, heroIds, foeIds) };
}

/** 一套阵容对另一套阵容的对位偏差：每个英雄对对面五个人的平均值，再按人数相加。 */
export function lineupCounter(matchups: HeroMatchups | undefined, heroIds: readonly number[], foeIds: readonly number[]): CounterSummary {
	const details: CounterSummary['details'] = [];
	let delta = 0;
	let pairs = 0;
	let games = 0;
	for (const heroId of heroIds) {
		const one = counterSummary(matchups, heroId, foeIds);
		if (one.pairs === 0) continue;
		delta += one.delta;
		pairs += one.pairs;
		games += one.games;
		details.push(...one.details);
	}
	details.sort((a, b) => b.games - a.games);
	return { delta, pairs, games, details };
}

/**
 * 阵容能力维度的展示口径：标签、当前值、参考值。
 *
 * 打分与「双方对比」共用一份，免得同一个维度在两处说法不一致
 * （打分看「补上了多少」，复盘看「两边谁多」）。
 */
export function compositionDimensions(profile: StructureProfile, enemySummon: boolean): { key: string; label: string; value: number; target: number }[] {
	const rows = COMPOSITION_TARGETS.map((dim) => ({
		key: dim.key,
		label: dim.label,
		value: profile.values[dim.key] ?? 0,
		target: dim.target,
	}));
	rows.push({ key: 'ranged', label: '远程', value: profile.ranged, target: RANGED_TARGET });
	rows.push({ key: 'teamfight', label: '团战点', value: profile.teamfight, target: TEAMFIGHT_TARGET });
	rows.push({ key: 'clear', label: '清场', value: profile.clear, target: enemySummon ? AOE_TARGET_VS_SUMMON : AOE_TARGET_BASE });
	rows.push({ key: 'phaseEarly', label: '前期不弱', value: profile.phaseEarly, target: PHASE_TARGET });
	rows.push({ key: 'phaseLate', label: '后期不弱', value: profile.phaseLate, target: PHASE_TARGET });
	return rows;
}
