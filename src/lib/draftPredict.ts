/*
 * 相对导入带 `.ts` 后缀：这一层要能被 `scripts/*.check.ts` 用
 * `node --experimental-strip-types` 直接加载，Node 不做后缀补全。
 */
import type { DraftData } from './draftData.ts';
import type { LaneData } from './draftLanes.ts';
import type { DraftSide, RecordedHand } from './draftOrder.ts';
import { CM_STEPS, sideOfOwner } from './draftOrder.ts';
import { advise } from './draftScore.ts';
import type { TeamSignature } from './teamSignature.ts';

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
}

export interface PredictInput {
	data: DraftData;
	/** 先选方所在的阵营。 */
	firstPicker: DraftSide;
	signatures?: { radiant?: TeamSignature | null; dire?: TeamSignature | null } | null;
	lanes?: LaneData | null;
}

const emptySide = (): PredictedSide => ({ bans: [], picks: [] });

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
		const advice = advise({
			data,
			recorded,
			ourSide: side,
			firstPicker,
			limit: 1,
			signatures: input.signatures ?? null,
			lanes: input.lanes ?? null,
		});
		const top = advice?.candidates.find((candidate) => !used.has(candidate.heroId));
		if (!top) break;
		used.add(top.heroId);
		recorded = [...recorded, top.heroId];
		const bucket = side === 'radiant' ? radiant : dire;
		const pick: PredictedPick = { heroId: top.heroId, reason: top.reasons[0] ?? '' };
		if (entry.action === 'ban') bucket.bans.push(pick);
		else bucket.picks.push(pick);
	}

	// 一手都没推出来（例如号位数据整体缺失）时按"给不出预测"处理，别在界面上摆一块空的。
	if (radiant.bans.length + radiant.picks.length + dire.bans.length + dire.picks.length === 0) return null;

	return {
		radiant,
		dire,
		summary: '按站内的号位胜率与对位，一手一手推出来的走向；不是胜率预测，也不代表两队的真实战术。',
		source: 'local',
	};
}
