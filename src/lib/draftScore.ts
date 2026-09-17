/*
 * 相对导入带 `.ts` 后缀：这一层要能被 `scripts/draftScore.check.ts` 直接用
 * `node --experimental-strip-types` 加载，Node 不做后缀补全。仓库的 tsconfig 里
 * `allowImportingTsExtensions` 是开着的，Vite 也照常解析。
 */
import type { DraftData, DraftHero } from './draftData.ts';
import type { DraftAction, DraftOwner, DraftSide, RecordedHand } from './draftOrder.ts';
import { CM_STEPS, snapshot, sideOfOwner } from './draftOrder.ts';

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

interface PoolHero {
	hero: DraftHero;
	/** 按号位索引（0 是一号位）的胜率，样本不足处为 null。 */
	rates: (number | null)[];
	matches: number[];
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

/** 已经落在某方手上的英雄在某个号位上的胜率；没有样本按中性。 */
function rateAt(entry: PoolHero, position: number): number {
	return entry.rates[position - 1] ?? NEUTRAL_WIN_RATE;
}

/**
 * 把一组英雄分配到五个号位，让胜率之和最大（每个号位一个人）。
 * 一支队伍最多五个人，穷举 5! = 120 种分配，比任何近似都便宜且准确。
 *
 * 超过五个时只分配前五个：调用方本来就该先判断"这一方是不是已经挑满了"，
 * 这里只是不让越界变成崩溃。
 */
function bestAssignment(entries: readonly PoolHero[]): { positions: number[]; total: number } {
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
			walk(index + 1, total + rateAt(list[index], position));
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
 */
function expectedPick(pool: readonly PoolHero[], position: number, used: ReadonlySet<number>, contested: number): GapSlot {
	const options = pool
		.filter((entry) => !used.has(entry.hero.id))
		.map((entry) => ({ entry, rate: entry.rates[position - 1] }))
		.filter((row): row is { entry: PoolHero; rate: number } => typeof row.rate === 'number')
		.sort((a, b) => b.rate - a.rate);
	if (contested >= options.length) return { position, hero: null, rate: 0 };
	const picked = options[contested];
	return { position, hero: picked.entry.hero, rate: picked.rate };
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
function estimate(pool: readonly PoolHero[], ownedIds: readonly number[], byId: ReadonlyMap<number, DraftHero>, contested: number): Estimate {
	const owned = idsToPool(byId, ownedIds);
	const assignment = bestAssignment(owned);
	const used = new Set(ownedIds);
	const slots: LineupSlot[] = [];

	for (let position = 1; position <= 5; position += 1) {
		const ownerIndex = assignment.positions.findIndex((assigned) => assigned === position);
		if (ownerIndex >= 0) {
			const entry = owned[ownerIndex];
			slots.push({ position, hero: entry.hero, rate: rateAt(entry, position), settled: true });
			continue;
		}
		const gap = expectedPick(pool, position, used, contested);
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
	/** 一句话总体判断，界面直接显示。 */
	summary: string;
}

export interface AdviseInput {
	data: DraftData;
	recorded: readonly RecordedHand[];
	ourSide: DraftSide;
	firstPicker: DraftSide;
	/** 返回几个候选。 */
	limit?: number;
}

const pct = (rate: number): string => `${(rate * 100).toFixed(1)}%`;

/** 胜率的抽样波动。用最保守的 p=0.5 估，只为了提示这个数字有多虚。 */
function noise(matches: number): string {
	return `±${(1.96 * Math.sqrt(0.25 / Math.max(matches, 1)) * 100).toFixed(1)}`;
}

/**
 * 给当前这一手出建议。顺序走完、或者一份英雄数据都没有时返回 null，
 * 调用方按"这次给不出建议"处理，不要挡住录制。
 */
export function advise(input: AdviseInput): Advice | null {
	const { data, recorded, ourSide, firstPicker } = input;
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

	const ourBase = estimate(pool, ourIds, byId, contestedByUs);
	const theirBase = estimate(pool, theirIds, byId, contestedByThem);
	/** 有一方已经挑满五个人时，再算"多拿一个"没有意义，也不能拿去分配号位。 */
	const oursFull = ourIds.length >= 5;
	const theirsFull = theirIds.length >= 5;

	const candidates: AdviceCandidate[] = [];
	for (const entry of pool) {
		const hero = entry.hero;
		const proText = hero.pro[0] + hero.pro[2] > 0 ? `职业样本里出场 ${hero.pro[0]} 次、被禁 ${hero.pro[2]} 次` : '';

		if (state.action === 'pick') {
			const oursAfter = oursFull ? ourBase : estimate(pool, [...ourIds, hero.id], byId, contestedByUs);
			const assignment = bestAssignment(idsToPool(byId, [...ourIds, hero.id]));
			const position = assignment.positions[assignment.positions.length - 1] ?? 1;
			const rate = entry.rates[position - 1];
			const matches = entry.matches[position - 1];
			const reasons = [
				rate === null
					? `${position} 号位近 ${data.windowDays} 天没有足够样本，只能按中性估`
					: `${position} 号位近 ${data.windowDays} 天胜率 ${pct(rate)}（${matches.toLocaleString('zh-CN')} 场）`,
				`现在拿：五号位估值 ${pct(ourBase.total / 5)} → ${pct(oursAfter.total / 5)}`,
			];
			if (proText) reasons.push(proText);
			candidates.push({
				heroId: hero.id,
				position,
				rate: rate ?? NEUTRAL_WIN_RATE,
				hasSample: rate !== null,
				ranking: oursAfter.total - ourBase.total,
				reasons,
				risk:
					rate === null
						? '这个号位几乎没有高分局样本，估值只能当参考'
						: `样本 ${matches.toLocaleString('zh-CN')} 场，胜率波动约 ${noise(matches)} 个百分点`,
			});
			continue;
		}

		// 禁用：对面拿了能涨多少（威胁），我们自己拿了能涨多少（该不该留）。
		const theirsAfter = theirsFull ? theirBase : estimate(pool, [...theirIds, hero.id], byId, contestedByThem);
		const oursAfter = oursFull ? ourBase : estimate(pool, [...ourIds, hero.id], byId, contestedByUs);
		const threat = theirsAfter.total - theirBase.total;
		const ownGain = oursAfter.total - ourBase.total;
		const assignment = bestAssignment(idsToPool(byId, [...theirIds, hero.id]));
		const position = assignment.positions[assignment.positions.length - 1] ?? 1;
		const rate = entry.rates[position - 1];
		const matches = entry.matches[position - 1];
		const reasons = [
			rate === null
				? `对面可能拿它打 ${position} 号位，但这个位置没有足够样本`
				: `对面拿它打 ${position} 号位的话，该号位胜率 ${pct(rate)}（${matches.toLocaleString('zh-CN')} 场）`,
			`禁掉它，对面阵容估值 ${pct(theirBase.total / 5)} → ${pct((theirBase.total - threat) / 5)}`,
		];
		if (ownGain > 0) reasons.push(`我们自己拿它可以涨 ${((ownGain * 100) / 5).toFixed(2)} 个百分点`);
		if (proText) reasons.push(proText);
		candidates.push({
			heroId: hero.id,
			position,
			rate: rate ?? NEUTRAL_WIN_RATE,
			hasSample: rate !== null,
			// 自己更想要的英雄先不急着禁：威胁减去一半的自身收益。
			ranking: threat - ownGain * 0.5,
			reasons,
			risk: ownGain > threat ? '我们自己拿它收益更大，后面还轮得到的话可以考虑留' : '禁用只是止损，补不上我们自己阵容的缺口',
		});
	}

	candidates.sort((a, b) => b.ranking - a.ranking);

	const gaps = ourBase.slots.filter((slot) => !slot.settled).map((slot) => slot.position);
	const turnText = `${ownerIsOurs ? '我方' : '对方'}${state.action === 'ban' ? '禁用' : '挑选'}`;
	const tailText =
		tail.ban === tail.pick
			? `最后一手禁用和最后一手挑选都在${tail.ban === 'ours' ? '我方' : '对方'}手上`
			: `最后一手禁用归${tail.ban === 'ours' ? '我方' : '对方'}、最后一手挑选归${tail.pick === 'ours' ? '我方' : '对方'}`;
	const gapText = gaps.length > 0 ? `我方还缺 ${gaps.join('、')} 号位` : '我方五个号位都已经落人';
	const summary = `第 ${state.nextStep} 手：${turnText}。我方还剩 ${remaining.ours.bans} 禁 ${remaining.ours.picks} 选，对方还剩 ${remaining.theirs.bans} 禁 ${remaining.theirs.picks} 选；${tailText}。${gapText}，当前估值 ${pct(ourBase.total / 5)}。`;

	return {
		action: state.action,
		owner: state.owner,
		ours: ownerIsOurs,
		step: state.nextStep,
		remaining,
		tail,
		lineup: ourBase.slots,
		candidates: candidates.slice(0, limit),
		summary,
	};
}
