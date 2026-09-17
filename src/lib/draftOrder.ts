/**
 * 队长模式的 24 手顺序。
 *
 * 顺序只按「先选方 / 后选方」描述，不写死天辉夜魇：哪一边先选由选边决定，
 * 页面上那两个开关（我方是不是先选、我方是天辉还是夜魇）到最后一步才映射成具体阵营。
 * 这样同一张表能同时喂给「代入某支队」和「只看 BP」两种用法。
 *
 * 表的来源是 Valve 的 7.40 补丁说明：那次只重排了**第一和第三禁用阶段**，第二禁用阶段没动。
 * 表本身与三场 2026-09-13 的真实比赛 BP 记录逐手核对过，两边一致。
 *
 * 一个容易记错的地方：**后选方握着最后一手 ban（第 22 手）和最后一手 pick（第 24 手）**，
 * 先选方的优势是首抢（第 8 手）和一次双选（第 14、15 手）。界面上要能把这条讲出来。
 */

export type DraftAction = 'ban' | 'pick';
/** 一支队伍在某一手里的身份：先选方或后选方。 */
export type DraftOwner = 'first' | 'second';
/** 阵营。与先选权是两件事，靠 `firstPicker` 关联起来。 */
export type DraftSide = 'radiant' | 'dire';

export interface DraftStep {
	/** 1 到 24，与客户端界面上的手号一致。 */
	step: number;
	action: DraftAction;
	owner: DraftOwner;
}

/**
 * 24 手顺序。`B` = ban、`P` = pick；`F` = 先选方、`S` = 后选方。
 *
 * 分阶段看是这样（7.40 起）：
 * - 禁用一 1-7：F F S S F S S
 * - 挑选一 8-9：F S
 * - 禁用二 10-12：F F S
 * - 挑选二 13-18：S F F S S F
 * - 禁用三 19-22：F S F S
 * - 挑选三 23-24：F S
 */
const ORDER = 'BF BF BS BS BF BS BS PF PS BF BF BS PS PF PF PS PS PF BF BS BF BS PF PS';

function parseOrder(): DraftStep[] {
	return ORDER.split(' ').map((token, index) => {
		const action: DraftAction = token[0] === 'B' ? 'ban' : 'pick';
		const owner: DraftOwner = token[1] === 'F' ? 'first' : 'second';
		return { step: index + 1, action, owner };
	});
}

export const CM_STEPS: readonly DraftStep[] = parseOrder();
export const CM_STEP_COUNT = CM_STEPS.length;
/** 每队的 ban 与 pick 数，界面上的「还剩几手」按它算。 */
export const DRAFT_BANS_PER_SIDE = 7;
export const DRAFT_PICKS_PER_SIDE = 5;

/** 已记录的一手：`null` 表示这一手被跳过（只记手号不记英雄）。 */
export type RecordedHand = number | null;

export interface DraftSnapshot {
	/** 已经记了几手，0 到 24。 */
	cursor: number;
	/** 下一手的序号（1 起）；记满后为 25。 */
	nextStep: number;
	/** 下一手是谁在做什么；记满后两者都是 null。 */
	action: DraftAction | null;
	owner: DraftOwner | null;
	done: boolean;
	/** 双方还剩几手 ban / pick。 */
	remaining: Record<DraftOwner, { bans: number; picks: number }>;
	/** 已经用掉的英雄：heroId → 手号。 */
	used: Map<number, number>;
	/** 最后一手 ban 与最后一手 pick 的归属。 */
	tail: { ban: DraftOwner; pick: DraftOwner };
}

const countFor = (owner: DraftOwner, action: DraftAction): number =>
	CM_STEPS.filter((step) => step.owner === owner && step.action === action).length;

/**
 * 由「已记录了哪几手」推出当前的进度。
 *
 * 传入的数组长度就是 cursor，`null` 元素算作已处理（跳过），所以跳过不会让指针回退。
 */
export function snapshot(recorded: readonly RecordedHand[]): DraftSnapshot {
	const cursor = Math.min(recorded.length, CM_STEP_COUNT);
	const remaining: DraftSnapshot['remaining'] = {
		first: { bans: countFor('first', 'ban'), picks: countFor('first', 'pick') },
		second: { bans: countFor('second', 'ban'), picks: countFor('second', 'pick') },
	};
	const used = new Map<number, number>();

	for (let index = 0; index < cursor; index += 1) {
		const step = CM_STEPS[index];
		const heroId = recorded[index];
		remaining[step.owner][step.action === 'ban' ? 'bans' : 'picks'] -= 1;
		if (typeof heroId === 'number' && !used.has(heroId)) used.set(heroId, step.step);
	}

	const next = cursor < CM_STEP_COUNT ? CM_STEPS[cursor] : null;
	const lastBan = [...CM_STEPS].reverse().find((step) => step.action === 'ban');
	const lastPick = [...CM_STEPS].reverse().find((step) => step.action === 'pick');

	return {
		cursor,
		nextStep: cursor + 1,
		action: next?.action ?? null,
		owner: next?.owner ?? null,
		done: cursor >= CM_STEP_COUNT,
		remaining,
		used,
		// 两个 find 不可能落空：表里既有 ban 也有 pick。类型上仍要兜一下。
		tail: { ban: lastBan?.owner ?? 'second', pick: lastPick?.owner ?? 'second' },
	};
}

/** 另一个阵营。 */
export function otherSide(side: DraftSide): DraftSide {
	return side === 'radiant' ? 'dire' : 'radiant';
}

/** 某一手属于哪个阵营：先选权落在谁头上由 `firstPicker` 决定。 */
export function sideOfOwner(owner: DraftOwner, firstPicker: DraftSide): DraftSide {
	return owner === 'first' ? firstPicker : otherSide(firstPicker);
}

/** 某一手轮到哪边，`firstPicker` 是先选方所在的阵营。 */
export function sideOfStep(step: number, firstPicker: DraftSide): DraftSide | null {
	const entry = CM_STEPS[step - 1];
	return entry ? sideOfOwner(entry.owner, firstPicker) : null;
}

/** 某一方按时间顺序拿到的全部手，界面上的两列按它排。 */
export function handsOf(owner: DraftOwner): DraftStep[] {
	return CM_STEPS.filter((step) => step.owner === owner);
}

export interface PlayCheck {
	ok: boolean;
	/** 不能落子时的原因，直接拿去展示。 */
	reason?: string;
}

/** 能不能把某个英雄放进当前手：顺序没走完，且这个英雄还没被 ban/pick。 */
export function canPlay(recorded: readonly RecordedHand[], heroId: number): PlayCheck {
	const state = snapshot(recorded);
	if (state.done) return { ok: false, reason: '24 手已经走完，要改就撤销上一手' };
	const usedAt = state.used.get(heroId);
	if (usedAt) return { ok: false, reason: `这个英雄已经在第 ${usedAt} 手用掉了` };
	return { ok: true };
}

/** 记一手。校验不过时原样返回，调用方不用自己判重复。 */
export function play(recorded: readonly RecordedHand[], heroId: number): RecordedHand[] {
	if (!canPlay(recorded, heroId).ok) return [...recorded];
	return [...recorded, heroId];
}

/** 跳过当前手：手号照推，英雄留空。 */
export function skip(recorded: readonly RecordedHand[]): RecordedHand[] {
	if (snapshot(recorded).done) return [...recorded];
	return [...recorded, null];
}

/** 撤销一手。 */
export function undo(recorded: readonly RecordedHand[]): RecordedHand[] {
	return recorded.slice(0, Math.max(0, recorded.length - 1));
}
