/**
 * 眼位统计。
 *
 * 数据来自 STRATZ 的 `playbackData.wardEvents`，每条是「插下 / 消失」中的一个动作，
 * 用 `indexId` 把两次动作配成一只眼。三件事决定了统计口径，都是实测出来的：
 *
 * 1. **谁插的**：`fromPlayer` 是 Valve 的**玩家槽位**（天辉 0–4、夜魇 128–132），不是数组下标，
 *    所以归属要靠选手自己的 `playerSlot` 去对（`MatchPlayerType.playerSlot`）。实测用「插眼时刻
 *    最近的那个英雄」去猜有 41% 会猜错，用槽位对则是确定的。
 * 2. **自然到期 vs 被反**：`playerDestroyed` 为空 = 没人排掉它，也就是到期；有值 = 被那个人排掉。
 *    实测印证：空值那批的存活时长中位数正好是 360 秒（假眼）和 420 秒（真眼），与游戏里的
 *    6 / 7 分钟一致；有值那批的中位数只有 113–142 秒。所以两件事必须分开报，
 *    否则「反眼数」会把自然到期也算进去，直接虚高。
 * 3. **归属到人**：被反的那只眼算「反眼者 +1、插眼者 -1」，两侧都记——只记一边会让
 *    「谁在浪费眼」和「谁在排眼」两个问题都答不了。
 */

export interface WardEventRaw {
	indexId?: number | null;
	wardType?: string | null;
	/** `SPAWN` / `DESPAWN`。 */
	action?: string | null;
	fromPlayer?: number | null;
	playerDestroyed?: number | null;
}

/** 一名选手的槽位与队别，用来把槽位翻译成「谁」。 */
export interface WardOwner {
	slot: number;
	isRadiant: boolean;
	heroId: number;
	name: string;
}

export interface WardRow {
	heroId: number;
	name: string;
	isRadiant: boolean;
	/** 插下的假眼（观察者）数量。 */
	observer: number;
	/** 插下的真眼（岗哨）数量。 */
	sentry: number;
	/** 排掉的敌方眼位数量。 */
	taken: number;
	/** 自己被排掉的眼位数量。 */
	lost: number;
}

export interface WardSideSummary {
	/** 插下的总数（假眼 + 真眼）。 */
	placed: number;
	observer: number;
	sentry: number;
	/** 排掉敌方的眼位。 */
	taken: number;
	/** 被敌方排掉的眼位。 */
	lost: number;
	/** 到期消失（含极少数没记录到反眼者的）眼位。 */
	expired: number;
}

export interface WardSummary {
	/** 0 = 天辉，1 = 夜魇。 */
	sides: [WardSideSummary, WardSideSummary];
	rows: WardRow[];
	/** 认不出归属的事件数：槽位对不上任何选手时用它兜底，页面可以据此少说一句。 */
	unknown: number;
}

function emptySide(): WardSideSummary {
	return { placed: 0, observer: 0, sentry: 0, taken: 0, lost: 0, expired: 0 };
}

/** 槽位 → 归属。对不上任何选手时返回 null（宁可少算，也不要挂到别人头上）。 */
export function ownerOfSlot(slot: number | null | undefined, owners: Map<number, WardOwner>): { side: 0 | 1; owner: WardOwner } | null {
	if (typeof slot !== 'number') return null;
	const owner = owners.get(slot);
	if (!owner) return null;
	return { side: owner.isRadiant ? 0 : 1, owner };
}

/**
 * 把动作流折成「每人插了几只、反了几只」。
 *
 * 返回 null 表示这场没有眼位数据（未下载录像的对局就是空的），调用方据此不显示这一块。
 */
export function summarizeWards(events: WardEventRaw[], owners: WardOwner[]): WardSummary | null {
	if (events.length === 0) return null;

	const bySlot = new Map(owners.map((owner) => [owner.slot, owner]));
	const rows = owners.map((owner) => ({
		heroId: owner.heroId,
		name: owner.name,
		isRadiant: owner.isRadiant,
		observer: 0,
		sentry: 0,
		taken: 0,
		lost: 0,
	}));
	const rowOfSlot = new Map(owners.map((owner, index) => [owner.slot, rows[index]]));

	const sides: [WardSideSummary, WardSideSummary] = [emptySide(), emptySide()];
	/** indexId → 这只眼插在哪儿、是谁的。反眼事件要回来查。 */
	const placed = new Map<number, { side: 0 | 1; row: WardRow | undefined }>();
	let unknown = 0;

	for (const event of events) {
		if (event.action !== 'DESPAWN') {
			const placer = ownerOfSlot(event.fromPlayer, bySlot);
			if (!placer) {
				unknown += 1;
				continue;
			}
			const side = sides[placer.side];
			side.placed += 1;
			const sentry = event.wardType === 'SENTRY';
			if (sentry) side.sentry += 1;
			else side.observer += 1;
			const row = rowOfSlot.get(placer.owner.slot);
			if (row) {
				if (sentry) row.sentry += 1;
				else row.observer += 1;
			}
			if (typeof event.indexId === 'number') placed.set(event.indexId, { side: placer.side, row });
			continue;
		}

		const origin = typeof event.indexId === 'number' ? placed.get(event.indexId) : undefined;
		if (!origin) {
			// 开局前插下、录制窗口里只剩消失事件的眼位会走到这儿。算不清归属就不算。
			unknown += 1;
			continue;
		}

		const killer = ownerOfSlot(event.playerDestroyed, bySlot);
		if (!killer) {
			sides[origin.side].expired += 1;
			continue;
		}
		sides[killer.side].taken += 1;
		sides[origin.side].lost += 1;
		const killerRow = rowOfSlot.get(killer.owner.slot);
		if (killerRow) killerRow.taken += 1;
		if (origin.row) origin.row.lost += 1;
	}

	return { sides, rows, unknown };
}
