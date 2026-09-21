/**
 * 英雄攻略里「怎么算」的那一半：加点顺序怎么编、哪些算成型件、时间怎么写。
 *
 * 单独拆出来**只为了能被自检脚本直接 import**：取数那一半（`stratzGuides.ts`）要引
 * `astro:env/server`，在纯 node 下加载不起来，而这几条规则恰恰是会静默算错的地方
 * （比如把开局买装的时间夹成 0、按英雄等级而不是加点先后来编号）。
 * 同一套拆法见 `stratzEndpoint.ts` / `stratzRuntime.ts`。
 */

/*
 * 相对导入带 `.ts` 后缀：这一层要能被 `scripts/stratzGuides.check.ts` 直接用
 * `node --experimental-strip-types` 加载，Node 不做后缀补全。与 `draftScore.ts` 同一约定。
 */
import { formatMatchTime } from './format.ts';

export const GUIDE_POSITIONS = [1, 2, 3, 4, 5] as const;
export type GuidePosition = (typeof GUIDE_POSITIONS)[number];

/**
 * 位置的中文名。服务端渲染标签页与浏览器端渲染详情都要用同一个映射——
 * 两边各写一份，改了一处就会出现"标签写四号位、详情写 POSITION_4"。
 */
export const GUIDE_POSITION_LABEL: Record<number, string> = { 1: '一号位', 2: '二号位', 3: '三号位', 4: '四号位', 5: '五号位' };

/** STRATZ 的位置枚举值 → 中文名，取不到时原样返回。 */
export function guidePositionLabel(position: string | null | undefined): string {
	if (!position) return '';
	const index = Number(position.replace('POSITION_', ''));
	return GUIDE_POSITION_LABEL[index] ?? position;
}

/** 「主要装备」的界线：单价过这个数的算成型件，与 STRATZ 页面上那排大件一致。 */
export const KEY_ITEM_COST = 2000;

export interface GuideHit {
	matchId: number;
	steamAccountId: number;
	/** 这份攻略进入 STRATZ 的时间，用作列表上的时间戳。 */
	createdAt: number;
}

export interface GuidePositionGroup {
	position: GuidePosition;
	/** STRATZ 统计的该位置样本量（远大于 10，它不是攻略条数）。 */
	poolSize: number;
	hits: GuideHit[];
}

export interface GuideAuthor {
	steamAccountId: number;
	name: string;
	avatar: string;
}

export interface GuideStep {
	/** 第几点：按实际加点先后编号，不是英雄等级。 */
	order: number;
	time: number;
	abilityId: number;
	isTalent: boolean;
}

export interface GuidePurchase {
	itemId: number;
	time: number;
}

export interface GuideItemView {
	id: number;
	name: string;
	img: string;
	cost: number;
}

export interface GuidePurchaseView {
	time: number;
	item: GuideItemView;
}

export interface GuideStepView {
	order: number;
	time: number;
	isTalent: boolean;
	name: string;
	img: string;
	/** 点这一下的时候英雄是几级。等级表拿不到（比赛没被解析）时是 null。 */
	level: number | null;
}

/** 升级事件：解析回放里的"某时刻到某级"。 */
export interface GuideLevelEvent {
	time: number;
	level: number;
}

/**
 * 某一刻的背包快照，字段与游戏里一一对应（六格 + 背包三格 + 传送 + 中立）。
 *
 * 只有被解析过的比赛才有（STRATZ 用回放解析出的），拿不到时整块退化成"已购买清单"。
 */
export interface GuideInventory {
	time: number;
	slots: number[];
	backpack: number[];
	teleport: number;
	neutral: number;
}

export interface GuideTalentOption {
	id: number;
	name: string;
	/** 这一局是不是点了它。 */
	picked: boolean;
}

export interface GuideTalentRow {
	level: number;
	left: GuideTalentOption;
	right: GuideTalentOption;
}

export interface GuideUpgradeAbility {
	id: number;
	name: string;
	img: string;
	/** 是"新给一个技能"（而不是改原来的那个）。 */
	granted: boolean;
}

export interface GuideUpgrade {
	item: GuideItemView;
	/** 这一局买到它的时间；没买是 null。 */
	time: number | null;
	abilities: GuideUpgradeAbility[];
}

export interface GuideDetailView {
	matchId: number;
	startTime: number;
	durationSeconds: number;
	radiantWin: boolean | null;
	authorName: string;
	position: string | null;
	isRadiant: boolean;
	kills: number;
	deaths: number;
	assists: number;
	imp: number | null;
	level: number | null;
	lastHits: number;
	denies: number;
	gpm: number;
	xpm: number;
	networth: number;
	heroDamage: number;
	buildingDamage: number;
	steps: GuideStepView[];
	/** 开局买的那几件（时间 ≤ 0）。 */
	starting: GuidePurchaseView[];
	/** 全部购买，按时间排。 */
	timeline: GuidePurchaseView[];
	/** 单价 ≥ `KEY_ITEM_COST` 的成型件。 */
	keyItems: GuidePurchaseView[];
	/** 结束时身上的六格（空位已滤掉）。 */
	finalItems: GuideItemView[];
	/** 升级时间线（拿不到时是空数组）。 */
	levels: GuideLevelEvent[];
	/** 每一次背包变化（拿不到时是空数组）。 */
	inventory: GuideInventory[];
	/** 中立物品：从背包快照的中立槽里拣出来的，按第一次拿到的时间。 */
	neutrals: GuidePurchase[];
	/** 这份数据里出现过的所有装备 id → 名字与图标，供背包快照查表。 */
	itemMap: Record<number, GuideItemView>;
	/** 这个英雄的整棵天赋树（25 → 10），标出这一局点了哪些。 */
	talentTree: GuideTalentRow[];
	/** 阿哈利姆神杖 / 魔晶各自升级或召唤了哪些技能。 */
	upgrades: { scepter: GuideUpgrade; shard: GuideUpgrade };
}

/** 秒 → `08:54` / `-01:29`。开局买装的时间是负的，别夹成 0。 */
export function formatDuration(seconds: number): string {
	const value = Math.round(Number(seconds) || 0);
	const sign = value < 0 ? '-' : '';
	const abs = Math.abs(value);
	const minutes = Math.floor(abs / 60);
	const rest = abs % 60;
	return `${sign}${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}`;
}

/**
 * 加点顺序：按时间排成「第几点」，并标出哪几点是天赋。
 *
 * 不写"第几级"：实测一场 22 级英雄只留了 18 条加点记录（技能点可以攒着不点，
 * 天赋也可以不按等级顺序点），按等级编号会与实际不符，按先后编号不会。
 */
export function skillSteps(learns: { abilityId: number; time: number }[], isTalentId: (id: number) => boolean): GuideStep[] {
	return learns
		.filter((learn) => Number.isFinite(learn.abilityId) && learn.abilityId > 0)
		.slice()
		.sort((a, b) => a.time - b.time)
		.map((learn, index) => ({
			order: index + 1,
			time: learn.time,
			abilityId: learn.abilityId,
			isTalent: isTalentId(learn.abilityId),
		}));
}

/** 买卖记录按时间排好；开局（时间 ≤ 0）的那批单独挑出来。 */
export function splitPurchases(purchases: GuidePurchase[]): { starting: GuidePurchase[]; timeline: GuidePurchase[] } {
	const timeline = purchases
		.filter((entry) => Number.isFinite(entry.itemId) && entry.itemId > 0)
		.slice()
		.sort((a, b) => a.time - b.time);
	return { starting: timeline.filter((entry) => entry.time <= 0), timeline };
}

/** 从购买记录里挑单价达标的成型件。 */
export function keyPurchases(purchases: GuidePurchase[], costOf: (itemId: number) => number): GuidePurchase[] {
	return purchases.filter((entry) => costOf(entry.itemId) >= KEY_ITEM_COST);
}

/** 列表上的时间戳，与站点其它页面同一套写法（今天 20:30 / 09.17 10:30）。 */
export function guideTime(createdAt: number, nowSec: number): string {
	return createdAt > 0 ? formatMatchTime(createdAt, nowSec) : '—';
}

/**
 * 拖到某一刻时"已经买到哪了"：该时刻（含）之前的全部购买。
 *
 * 参数只声明它真正用到的 `time`，返回原样的元素类型：页面那一侧拿到的装备是
 * `{ time, item }`（带名字与图标），不是 `{ itemId, time }`，写死成 `GuidePurchase[]`
 * 会逼着调用方去补一个它根本用不到的 `itemId`。
 */
export function purchasesUpTo<T extends { time: number }>(purchases: T[], time: number): T[] {
	return purchases.filter((entry) => entry.time <= time);
}

/** 拖到某一刻时"点了几下技能"。同上：只看 `time`。 */
export function stepsUpTo<T extends { time: number }>(steps: T[], time: number): number {
	return steps.filter((step) => step.time <= time).length;
}

/** 加点汇总：每个技能点了几点、天赋算几条，按第一次点到的先后排。 */
export function summarizeSteps(steps: { name: string; isTalent: boolean }[]): { name: string; isTalent: boolean; count: number }[] {
	const out: { name: string; isTalent: boolean; count: number }[] = [];
	for (const step of steps) {
		const hit = out.find((entry) => entry.name === step.name && entry.isTalent === step.isTalent);
		if (hit) hit.count += 1;
		else out.push({ name: step.name, isTalent: step.isTalent, count: 1 });
	}
	return out;
}

/**
 * 某一刻英雄是几级。
 *
 * 取"该时刻之前出现过的最大等级"，而不是"最后一条事件"：等级只升不降，
 * 最大值就是那一刻的真实等级，这样也不必要求调用方先把事件排好序。
 */
export function levelAtTime(events: GuideLevelEvent[], time: number | null): number | null {
	if (time === null) return null;
	let level: number | null = null;
	for (const event of events) {
		if (event.time > time) continue;
		if (level === null || event.level > level) level = event.level;
	}
	return level;
}

/** 某一刻的背包：取那一刻之前最后一次快照。拿不到快照时返回 null，界面退化成购买清单。 */
export function inventoryAtTime(inventory: GuideInventory[], time: number): GuideInventory | null {
	let best: GuideInventory | null = null;
	for (const snapshot of inventory) {
		if (snapshot.time > time) continue;
		if (!best || snapshot.time >= best.time) best = snapshot;
	}
	return best;
}

/**
 * 这份背包时间线能不能用来画"那一刻身上的装备"。
 *
 * 实测有这种残缺数据：等级时间线 27 条齐全，背包却只有开局那一条、六个格子全空
 * （`9003853027`）。照着画会在整局都显示一个空背包，比不给还糟。所以要求至少有一条
 * 对线开始之后的快照——有它才说明回放真的记了这场比赛。
 */
export function hasInventoryTimeline(inventory: GuideInventory[]): boolean {
	return inventory.some((snapshot) => snapshot.time > 0);
}

/**
 * 中立物品：中立槽里出现过的装备，按第一次拿到的时间排。
 *
 * 中立物品不会出现在购买记录里（是打野掉落的），所以只能从中立槽的变化里读。
 */
export function neutralTimeline(inventory: GuideInventory[]): GuidePurchase[] {
	const out: GuidePurchase[] = [];
	let current = 0;
	for (const snapshot of [...inventory].sort((a, b) => a.time - b.time)) {
		if (snapshot.neutral > 0 && snapshot.neutral !== current) {
			current = snapshot.neutral;
			out.push({ itemId: snapshot.neutral, time: snapshot.time });
		}
	}
	return out;
}

/**
 * 把 `count` 个格子均匀铺在 `columns` 列上（返回列号，从 1 开始）。
 *
 * 官网的装备行是把图标按"每两列一个"摆的，跟时间、等级都没关系；我们改成铺满整行，
 * 至少看起来不像是挤在左半边。只有一个时居中。
 */
export function spreadColumns(count: number, columns: number): number[] {
	if (count <= 0) return [];
	if (count === 1) return [Math.ceil(columns / 2)];
	return Array.from({ length: count }, (_, index) => Math.round(1 + (index * (columns - 1)) / (count - 1)));
}

/** 阿哈利姆神杖（蓝杖）与阿哈利姆魔晶（碎片）的装备 id；魔晶还有个肉山掉落的版本。 */
export const SCEPTER_ITEM_IDS = [108];
export const SHARD_ITEM_IDS = [609, 725];

/**
 * 官方 datafeed 给天赋的顺序是"两两一组、越靠后层级越高"，即
 * 10 / 15 / 20 / 25 各两个选项。这里还原成按层级排的树，并且**25 在最上面**——
 * 游戏里和 STRATZ 的悬停面板都是这个方向。
 */
export function talentTreeRows(talents: { id: number; name: string }[], pickedIds: Set<number>): GuideTalentRow[] {
	const rows: GuideTalentRow[] = [];
	for (let index = 0; index + 1 < talents.length; index += 2) {
		const left = talents[index];
		const right = talents[index + 1];
		rows.push({
			level: (index / 2 + 1) * 5 + 5,
			left: { id: left.id, name: left.name, picked: pickedIds.has(left.id) },
			right: { id: right.id, name: right.name, picked: pickedIds.has(right.id) },
		});
	}
	return rows.reverse();
}

/** 某一局第一次买到这批装备里任意一件的时间；没买过是 null（悬停面板据此决定亮不亮）。 */
export function firstPurchaseTime(purchases: GuidePurchase[], itemIds: number[]): number | null {
	for (const entry of [...purchases].sort((a, b) => a.time - b.time)) {
		if (itemIds.includes(entry.itemId)) return entry.time;
	}
	return null;
}
