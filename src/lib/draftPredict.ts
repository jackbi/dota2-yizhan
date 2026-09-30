/*
 * 相对导入带 `.ts` 后缀：这一层要能被 `scripts/*.check.ts` 用
 * `node --experimental-strip-types` 直接加载，Node 不做后缀补全。
 */
import type { DraftData } from './draftData.ts';
import type { LaneData } from './draftLanes.ts';
import type { DraftSide, RecordedHand } from './draftOrder.ts';
import { CM_STEPS, sideOfOwner } from './draftOrder.ts';
import { advise, assignLineup } from './draftScore.ts';
import type { RosterProfile } from './teamSignature.ts';
import { rosterHeroOf } from './teamSignature.ts';

/**
 * 「AI 预测 BP」里**不依赖模型**的那条路。
 *
 * 预测的含义要说清楚：它不是"这两队真的会这么打"，而是"照站内的号位胜率、对位与两边的招牌，
 * 一手一手地推下去会走到哪"。所以它跟逐手建议共用同一个打分层（`advise`），不另写一套标准——
 * 否则同一个局面，建议面板说 A、预测面板说 B，用户没法判断该信哪个。
 *
 * 模型那条路（`draftPrompt` 里的预测提示词）从这个结果之外单独走：模型给出的是
 * **两边的禁选名单 + 一段理由**，不要求它排出 24 手的顺序——一手一手问模型要 24 次请求，
 * 又慢又贵，而且在没有真实 BP 记录的情况下，那个"顺序"本身就是编的。
 */

export interface PredictedPick {
	heroId: number;
	/**
	 * 这一手算在几号位。
	 *
	 * 挑选：这一方的五个号位里它填的是哪一个；禁用：**对面**会拿它打几号位（禁用的价值就来自
	 * "它落进对面哪个位置"）。所以界面上要给两行不同的说法，不能都写成"几号位"。
	 */
	position: number;
	/** 一句话依据（本地路径取打分层的头一条依据；模型路径是模型写的）。 */
	reason: string;
}

export interface PredictedSide {
	/** 按预测的先后顺序。 */
	bans: PredictedPick[];
	picks: PredictedPick[];
}

export interface DraftPrediction {
	radiant: PredictedSide;
	dire: PredictedSide;
	summary: string;
	/** 这份预测是谁给的：本地打分层，还是模型。界面上的措辞跟着它变。 */
	source: 'local' | 'model';
	/**
	 * 只有模型那条路会有：因为"同一个英雄既被禁又被选"而丢掉的禁用条数。
	 * 界面要照实说出来，否则读者会以为模型的禁用就只有那几条。
	 */
	droppedBans?: number;
	/** 只有模型那条路会有：禁用不足 7 条时，由站内引擎补齐的条数。理由同上，要照实说。 */
	filledBans?: number;
}

/**
 * 把模型给的禁用与本地推演的禁用合成一份**完整且合法**的禁用表（每边 7 条）。
 *
 * 为什么需要这一步：实测 DeepSeek 反复写出"各队禁对面的熟手、又各拿自己的熟手"——
 * 这在逻辑上就不可能（同一个英雄不能既被禁又被选），它给的禁用里往往有六成与自己的挑选撞车，
 * 丢掉之后一边只剩一两条。
 *
 * 挑选是模型最在行的部分（按号位挑得又准、理由也带得出场次），所以**挑选一律用模型的**；
 * 禁用则先用模型给的不冲突的那些，不够 7 条就按站内引擎那份补齐——两边是同一个口径
 * （都是"先掐对面该号位的熟手"），所以拼在一起不会互相打架。补了几条要如实报出来。
 */
export function mergeBans(
	modelBans: readonly { heroId: number; reason: string }[],
	localBans: readonly { heroId: number; reason: string }[],
	/**
	 * 已经被占用的英雄（两边共用的集合，调用方传同一个进来）：两边的十手挑选 + 已经定下来的禁用。
	 * 传集合而不是数组，是因为两边要**共用**它——先合成天辉的禁用，再合成夜魇的，后者能看到前者。
	 */
	taken: Set<number>,
	limit = 7,
): { bans: { heroId: number; reason: string }[]; filled: number } {
	const bans: { heroId: number; reason: string }[] = [];
	for (const ban of modelBans) {
		if (bans.length >= limit) break;
		if (taken.has(ban.heroId)) continue;
		taken.add(ban.heroId);
		bans.push(ban);
	}
	let filled = 0;
	for (const ban of localBans) {
		if (bans.length >= limit) break;
		if (taken.has(ban.heroId)) continue;
		taken.add(ban.heroId);
		bans.push(ban);
		filled += 1;
	}
	return { bans, filled };
}

export interface PredictInput {
	data: DraftData;
	/** 先选方所在的阵营。 */
	firstPicker: DraftSide;
	signatures?: { radiant?: RosterProfile | null; dire?: RosterProfile | null } | null;
	lanes?: LaneData | null;
}

const emptySide = (): PredictedSide => ({ bans: [], picks: [] });

/**
 * 预测的规则：**熟手优先，拿不到才退回版本强势**。
 *
 * 两条路回答的不是同一个问题：建议回答"该怎么打"（号位胜率优先，熟手只当同档里的优先项，
 * 用 `FAMILIARITY_WEIGHT` 那点加成），预测回答"**他们两会怎么打**"——而人是偏向熟手的，
 * 不然"别让他们拿到某某"这句话就不会存在。
 *
 * ## 为什么是"首选"而不是"加分"
 *
 * 这一版先试过给熟手加权重（0.04 / 0.12 / 0.2 三档都跑过），结论是**加不出来**：
 * 熟手英雄的胜率往往就**不高**——实测 Xm 的灰烬之灵中单 49.3%，而同期版本强势点动辄
 * 高出十来个百分点的分差；要压过它就得说"愿意让掉十个百分点以上的号位胜率"，那个陈述站不住。
 * 加了权重之后挑选落在池子里的比例只有 1–3/10（权重越大禁用越集中在对面熟手上，
 * 挑选几乎不动）。
 *
 * 想清楚这层就好办了：**两份数据的用途不同**。号位胜率回答"这一手强不强"，英雄池回答
 * "**这一手像不像他们**"。预测要的是后者当骨架、前者当备选，所以这里不再调系数，
 * 而是直接写下规则：**这一手先看该号位那个人的池子，池子里有就挑池子里最强的那个；
 * 被禁掉、被拿了、或本来就没记录，才退回按号位胜率与对位挑**。禁用同理，优先掐对面的熟手。
 *
 * 这样推出来的名单是**这两支队的样子**（谁拿什么一眼认得出），而"哪几个熟手已经被对面禁掉了"
 * 会自然地把顺序推到备选上——真 BP 就是这么走的。
 *
 * 代价也得说清楚：这条路上**版本强势对挑选的影响被压到很低**，一个 44% 胜率的熟手照样会入选。
 * 那是有意的（预测不是建议），但读者要能从卡片上分辨出来——每一手都标着"熟手（多少场）"
 * 还是"不在他的池子里"。
 */
/** 每一手扫多少个候选去找熟手。熟手常常排在几十名开外（胜率不高），所以要扫得宽一些。 */
const CANDIDATE_SCAN = 60;

/**
 * 一手一手推完整局。任何一步算不出候选（英雄池空了、数据缺失）就停下，
 * 已经推出来的部分照样返回——**不猜**，也绝不把同一个英雄写两次。
 */
export function predictDraftLocal(input: PredictInput): DraftPrediction | null {
	const { data, firstPicker } = input;
	if (data.heroes.length === 0) return null;

	let recorded: RecordedHand[] = [];
	const radiant = emptySide();
	const dire = emptySide();
	/** 已经用掉的英雄；`advise` 内部也会排除，这里再挡一道，防止某一步的候选为空时出错。 */
	const used = new Set<number>();

	for (const entry of CM_STEPS) {
		const side = sideOfOwner(entry.owner, firstPicker);
		/*
		 * 挑选看**自己**那个号位是谁在打；禁用看**对面**那个号位是谁在打——
		 * `advise` 的禁用分支里，候选的 `position` 正是"对面会拿它打几号位"。
		 */
		const own = side === 'radiant' ? input.signatures?.radiant : input.signatures?.dire;
		const foe = side === 'radiant' ? input.signatures?.dire : input.signatures?.radiant;
		const profile = entry.action === 'ban' ? foe : own;
		const advice = advise({
			data,
			recorded,
			ourSide: side,
			firstPicker,
			// 这一手要看"熟手里最好的是哪个"，所以不能只要一个候选；熟手加成先关掉，
			// 下面的阈值是按**基础分**比的（加进去会让两边都带上同一个方向的偏移，比不清）。
			limit: CANDIDATE_SCAN,
			signatures: input.signatures ?? null,
			familiarityWeight: 0,
			lanes: input.lanes ?? null,
		});
		const available = advice?.candidates.filter((candidate) => !used.has(candidate.heroId)) ?? [];
		/*
		 * 熟手优先：候选已经按"号位胜率 + 对位 + 结构"排好了，所以池子里的第一个
		 * 就是"他的熟手里最强的那个"。池子里一个都没有（被禁、被拿，或本来没记录）才退回第一顺位。
		 */
		const best = available[0];
		const bestComfort = available.find((candidate) => rosterHeroOf(profile, candidate.position, candidate.heroId));
		const top = bestComfort ?? best;
		if (!top) break;
		used.add(top.heroId);
		recorded = [...recorded, top.heroId];
		const bucket = side === 'radiant' ? radiant : dire;
		const pick: PredictedPick = { heroId: top.heroId, position: top.position, reason: top.reasons[0] ?? '' };
		if (entry.action === 'ban') bucket.bans.push(pick);
		else bucket.picks.push(pick);
	}

	// 一手都没推出来（例如号位数据整体缺失）时按"给不出预测"处理，别在界面上摆一块空的。
	if (radiant.bans.length + radiant.picks.length + dire.bans.length + dire.picks.length === 0) return null;

	/*
	 * 收尾重排号位：逐手推的时候每一手都按"当时的阵容"算号位，五手下来会出现两个"1 号位"。
	 * 整局推完再排一次，五个号位就恰好各占一个——与模型那条路（要求它给满 1–5）以及界面上
	 * "谁打哪个号位"的读法都对得上。
	 */
	for (const side of ['radiant', 'dire'] as const) {
		const bucket = side === 'radiant' ? radiant : dire;
		const profile = side === 'radiant' ? input.signatures?.radiant : input.signatures?.dire;
		const positions = new Map(
			assignLineup(data, bucket.picks.map((pick) => pick.heroId), { profile }).map((row) => [row.heroId, row.position]),
		);
		bucket.picks = bucket.picks.map((pick) => ({ ...pick, position: positions.get(pick.heroId) ?? pick.position }));
	}

	return {
		radiant,
		dire,
		summary: '按站内的号位胜率与对位，一手一手推出来的走向；不是胜率预测，也不代表两队的真实战术。',
		source: 'local',
	};
}
