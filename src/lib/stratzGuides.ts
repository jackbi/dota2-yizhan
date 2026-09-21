/**
 * STRATZ「高手攻略」：某个英雄在某个位置上的高分 / 职业比赛，以及这些比赛的加点与出装。
 *
 * 数据源是 STRATZ 公开 schema 里的 `heroStats.guide`（**不是爬网页**）：它按
 * （英雄 × 位置）返回一批比赛，每条是 `matchId` + 选手 `steamAccountId`。加点顺序与
 * 出装时间轴不在这条查询里，要拿 matchId 去 `match(id:)` 取 `abilities` 与
 * `stats.itemPurchases`——所以列表与详情是**两次**取数，详情那次按用户点击触发。
 *
 * 额度是这里的设计约束：STRATZ 默认 token 是 1 万次/天，而站点每 30 分钟重建一次、
 * 一轮冷构建就要花掉一百多次。所以列表页固定三次请求（一次索引、两次批量玩家名，
 * 一屏 10 份攻略的账号要拆成两批），
 * 详情页一次，且都进运行时内存缓存。**不要**改成构建期把 126 个英雄 × 5 个位置 ×
 * 10 场详情（6000+ 次）全抓一遍——那样当天额度会被一轮构建吃光，站点数据全线下线。
 *
 * 技能与天赋用官方 datafeed 反查（`heroApi`）：官方 ability / talent 的 id
 * 与 STRATZ 的 `abilityId` **实测完全一致**（如赏金猎人 5286 = 忍术），
 * 图标也就跟英雄页同源，不必再引一套素材。
 */
import { itemRefMap, type ItemRef } from './gameRefs';
import { fetchHero, resolveTemplate, type Hero } from './heroApi';
import { cached } from './ssrCache';
import { StratzError, stratzGql } from './stratzRuntime';
import {
	GUIDE_POSITIONS,
	firstPurchaseTime,
	keyPurchases,
	levelAtTime,
	neutralTimeline,
	SCEPTER_ITEM_IDS,
	SHARD_ITEM_IDS,
	skillSteps,
	splitPurchases,
	talentTreeRows,
	type GuideAuthor,
	type GuideDetailView,
	type GuideHit,
	type GuideInventory,
	type GuideItemView,
	type GuidePosition,
	type GuidePositionGroup,
	type GuidePurchase,
	type GuidePurchaseView,
	type GuideUpgrade,
} from './guideBuild';

/*
 * 纯计算（编号规则、成型件门槛、时间格式）在 `guideBuild.ts`，这里只做取数与拼装；
 * 那边能被自检脚本直接 import，这边要引 `astro:env` 所以不行。
 */
export * from './guideBuild';

/**
 * 索引的缓存窗口。
 *
 * STRATZ 只给每个（英雄 × 位置）最近 10 场，所以这份数据是按小时换的；但换得不快
 * （实测同一位置两小时里首位没动），半小时足够新鲜，也把重复访问挡在缓存里。
 */
const INDEX_TTL_MS = 30 * 60 * 1000;
/** 玩家名与头像一天内基本不变。 */
const AUTHOR_TTL_MS = 24 * 3600 * 1000;
/** 已结束的比赛不会变，详情可以放心留一天。 */
const DETAIL_TTL_MS = 24 * 3600 * 1000;

// ------------------------------------------------------------------ 取数

/** 五个位置一次问完：同一条 GraphQL 请求里用别名并行问，比逐位置问省四次调用。 */
const GUIDE_INDEX_DOCUMENT = `query GuideIndex($heroId: Short!) {
	heroStats {
${GUIDE_POSITIONS.map(
	(position) => `\t\tp${position}: guide(heroId: $heroId, positionId: POSITION_${position}) { matchCount guides { matchId steamAccountId createdDateTime } }`,
).join('\n')}
	}
}`;

interface RawGuide {
	matchId?: number | null;
	steamAccountId?: number | null;
	createdDateTime?: number | null;
}

interface RawGuideList {
	matchCount?: number | null;
	guides?: RawGuide[] | null;
}

function toGroup(position: GuidePosition, raw: RawGuideList | null | undefined): GuidePositionGroup {
	const hits: GuideHit[] = [];
	for (const guide of raw?.guides ?? []) {
		// 两个 id 缺一个就没法定位这份攻略，直接丢掉而不是留半条。
		if (!guide.matchId || !guide.steamAccountId) continue;
		hits.push({ matchId: guide.matchId, steamAccountId: guide.steamAccountId, createdAt: guide.createdDateTime ?? 0 });
	}
	return { position, poolSize: raw?.matchCount ?? 0, hits };
}

/** 五个位置的攻略索引，一次请求。 */
export function loadGuideIndex(heroId: number): Promise<GuidePositionGroup[]> {
	return cached(`stratz-guides:${heroId}`, INDEX_TTL_MS, async () => {
		const data = await stratzGql<{ heroStats: Record<string, RawGuideList[] | null> | null }>(GUIDE_INDEX_DOCUMENT, { heroId });
		const stats = data?.heroStats;
		if (!stats) throw new StratzError('STRATZ 没有返回这个英雄的攻略');
		return GUIDE_POSITIONS.map((position) => toGroup(position, stats[`p${position}`]?.[0]));
	});
}

const GUIDE_AUTHORS_DOCUMENT = `query GuideAuthors($ids: [Long]!) {
	players(steamAccountIds: $ids) { steamAccountId steamAccount { name avatar } }
}`;

interface RawPlayer {
	steamAccountId?: number | null;
	steamAccount?: { name?: string | null; avatar?: string | null } | null;
}

/**
 * `players` 一次最多认 5 个 id（实测给 10 个直接返回
 * `You have surpassed the maximum take value of : 5`），所以一屏 10 份攻略要拆两批。
 */
const AUTHOR_CHUNK = 5;

/** 批量取玩家名与头像；整页 10 份攻略 = 两批。 */
export function loadGuideAuthors(ids: number[]): Promise<Map<number, GuideAuthor>> {
	const unique = [...new Set(ids.filter((id) => Number.isSafeInteger(id) && id > 0))].sort((a, b) => a - b);
	if (unique.length === 0) return Promise.resolve(new Map());
	return cached(`stratz-guide-authors:${unique.join(',')}`, AUTHOR_TTL_MS, async () => {
		const out = new Map<number, GuideAuthor>();
		for (let index = 0; index < unique.length; index += AUTHOR_CHUNK) {
			const data = await stratzGql<{ players: (RawPlayer | null)[] | null }>(GUIDE_AUTHORS_DOCUMENT, { ids: unique.slice(index, index + AUTHOR_CHUNK) });
			for (const player of data?.players ?? []) {
				if (!player?.steamAccountId) continue;
				out.set(player.steamAccountId, {
					steamAccountId: player.steamAccountId,
					name: player.steamAccount?.name?.trim() || '匿名玩家',
					avatar: player.steamAccount?.avatar ?? '',
				});
			}
		}
		return out;
	});
}

const GUIDE_DETAIL_DOCUMENT = `query GuideDetail($id: Long!) {
	match(id: $id) {
		id
		durationSeconds
		startDateTime
		didRadiantWin
		players {
			steamAccountId
			heroId
			isRadiant
			position
			kills
			deaths
			assists
			imp
			level
			numLastHits
			numDenies
			goldPerMinute
			experiencePerMinute
			networth
			heroDamage
			towerDamage
			item0Id
			item1Id
			item2Id
			item3Id
			item4Id
			item5Id
			steamAccount { name }
			abilities { abilityId time }
			stats { itemPurchases { itemId time } }
			playbackData {
				playerUpdateLevelEvents { time level }
				inventoryEvents {
					time
					item0 { itemId }
					item1 { itemId }
					item2 { itemId }
					item3 { itemId }
					item4 { itemId }
					item5 { itemId }
					backPack0 { itemId }
					backPack1 { itemId }
					backPack2 { itemId }
					teleport0 { itemId }
					neutral0 { itemId }
				}
			}
		}
	}
}`;

interface RawInventoryObject {
	itemId?: number | null;
}

interface RawInventory {
	time?: number | null;
	item0?: RawInventoryObject | null;
	item1?: RawInventoryObject | null;
	item2?: RawInventoryObject | null;
	item3?: RawInventoryObject | null;
	item4?: RawInventoryObject | null;
	item5?: RawInventoryObject | null;
	backPack0?: RawInventoryObject | null;
	backPack1?: RawInventoryObject | null;
	backPack2?: RawInventoryObject | null;
	teleport0?: RawInventoryObject | null;
	neutral0?: RawInventoryObject | null;
}

interface RawPlayback {
	playerUpdateLevelEvents?: { time?: number | null; level?: number | null }[] | null;
	inventoryEvents?: RawInventory[] | null;
}

interface RawMatchPlayer {
	steamAccountId?: number | null;
	heroId?: number | null;
	isRadiant?: boolean | null;
	position?: string | null;
	kills?: number | null;
	deaths?: number | null;
	assists?: number | null;
	imp?: number | null;
	level?: number | null;
	numLastHits?: number | null;
	numDenies?: number | null;
	goldPerMinute?: number | null;
	experiencePerMinute?: number | null;
	networth?: number | null;
	heroDamage?: number | null;
	towerDamage?: number | null;
	item0Id?: number | null;
	item1Id?: number | null;
	item2Id?: number | null;
	item3Id?: number | null;
	item4Id?: number | null;
	item5Id?: number | null;
	steamAccount?: { name?: string | null } | null;
	abilities?: { abilityId?: number | null; time?: number | null }[] | null;
	stats?: { itemPurchases?: { itemId?: number | null; time?: number | null }[] | null } | null;
	playbackData?: RawPlayback | null;
}

interface RawGuideMatch {
	id?: number | null;
	durationSeconds?: number | null;
	startDateTime?: number | null;
	didRadiantWin?: boolean | null;
	players?: RawMatchPlayer[] | null;
}

/** 英雄数据只是用来把 id 翻成名字和图标，拿不到不该让整页崩。 */
async function safeHero(heroId: number): Promise<Hero | null> {
	try {
		return await fetchHero(heroId);
	} catch {
		return null;
	}
}

/** 装备表是官方接口（614 件），同样按"拿不到就退化成 id"处理。 */
async function safeItems(): Promise<Map<number, ItemRef>> {
	try {
		return await itemRefMap();
	} catch {
		return new Map();
	}
}

function itemView(itemId: number, items: Map<number, ItemRef>, costOf: (id: number) => number): GuideItemView {
	const ref = items.get(itemId);
	return { id: itemId, name: ref?.name ?? `装备 ${itemId}`, img: ref?.img ?? '', cost: costOf(itemId) };
}

/** 背包快照里的一个槽位；空槽（0 / null）统一成 0。 */
const slotId = (slot: RawInventoryObject | null | undefined): number =>
	typeof slot?.itemId === 'number' && slot.itemId > 0 ? slot.itemId : 0;

/**
 * 回放里的背包快照。
 *
 * 只有**被解析过的**比赛才有这份数据；没解析过的比赛这里是空数组，
 * 界面会退回到"截至这一刻买到了什么"（见 `inventoryAtTime` 的调用方）。
 */
function toInventory(rows: RawInventory[] | null | undefined): GuideInventory[] {
	const out: GuideInventory[] = [];
	for (const row of rows ?? []) {
		if (typeof row.time !== 'number') continue;
		out.push({
			time: row.time,
			slots: [row.item0, row.item1, row.item2, row.item3, row.item4, row.item5].map(slotId),
			backpack: [row.backPack0, row.backPack1, row.backPack2].map(slotId),
			teleport: slotId(row.teleport0),
			neutral: slotId(row.neutral0),
		});
	}
	return out;
}

/**
 * 一份攻略的详情：加点顺序 + 出装时间轴 + 本场数据。
 *
 * `heroId` 由调用方给：这场比赛的英雄就是攻略所属英雄，但让调用方传进来比再从
 * 玩家数据里猜更直接。选手不在这一场里（参数被改过）时返回 null。
 */
export function loadGuideDetail(matchId: number, steamAccountId: number, heroId: number): Promise<GuideDetailView | null> {
	return cached(`stratz-guide-detail:${matchId}:${steamAccountId}`, DETAIL_TTL_MS, async () => {
		const [data, hero, items] = await Promise.all([stratzGql<{ match: RawGuideMatch | null }>(GUIDE_DETAIL_DOCUMENT, { id: matchId }), safeHero(heroId), safeItems()]);
		const match = data?.match;
		if (!match) return null;
		const player = (match.players ?? []).find((entry) => entry.steamAccountId === steamAccountId);
		if (!player) return null;

		/*
		 * 官方 datafeed 里天赋是独立一份（`talents`），id 与 STRATZ 的 abilityId 一致。
		 *
		 * 天赋文本取 `name`（`name_loc`）而不是 `desc`：实测 `desc_loc` 是空的，
		 * 那句话就写在 `name` 里（如 `+{s:bonus_slow_duration}秒 投掷飞镖减速`），
		 * 英雄页的天赋树也是这么取的。`{s:xxx}` 占位用英雄的特殊数值替换。
		 */
		const talentText = new Map<number, string>();
		const abilityById = new Map<number, { name: string; img: string }>();
		const special = hero?.specialMap ?? {};
		for (const talent of hero?.talents ?? []) {
			const text =
				resolveTemplate(talent.name, special, talent.key) || resolveTemplate(talent.desc, special, talent.key) || talent.name || `天赋 ${talent.id}`;
			talentText.set(talent.id, text);
		}
		for (const ability of hero?.abilities ?? []) {
			abilityById.set(ability.id, { name: ability.nameLoc, img: ability.img });
		}

		/*
		 * 回放数据：等级时间线决定加点摆在第几列，背包快照决定游标那一刻的六格。
		 * 两者都只有被解析过的比赛才有——拿不到时 `levels` / `inventory` 是空数组，
		 * 加点退化成"第几点"、游标退化成"已买到什么"。
		 */
		const levels = (player.playbackData?.playerUpdateLevelEvents ?? [])
			.filter((event) => typeof event.time === 'number' && typeof event.level === 'number')
			.map((event) => ({ time: event.time as number, level: event.level as number }));
		const inventory = toInventory(player.playbackData?.inventoryEvents);

		// 成型件的判定只看单价，所以先把"编号 → 单价"包成一个查表函数，纯函数那层不认装备表。
		const costOf = (itemId: number): number => items.get(itemId)?.cost ?? 0;
		const steps = skillSteps(
			(player.abilities ?? []).map((ability) => ({ abilityId: ability.abilityId ?? 0, time: ability.time ?? 0 })),
			(id) => talentText.has(id),
		).map((step) => ({
			order: step.order,
			time: step.time,
			isTalent: step.isTalent,
			name: step.isTalent ? (talentText.get(step.abilityId) ?? `天赋 ${step.abilityId}`) : (abilityById.get(step.abilityId)?.name ?? `技能 ${step.abilityId}`),
			img: step.isTalent ? '' : (abilityById.get(step.abilityId)?.img ?? ''),
			level: levelAtTime(levels, step.time),
		}));

		const purchases = (player.stats?.itemPurchases ?? []).map((entry) => ({ itemId: entry.itemId ?? 0, time: entry.time ?? 0 }));
		const { starting, timeline } = splitPurchases(purchases);
		const view = (entry: GuidePurchase): GuidePurchaseView => ({ time: entry.time, item: itemView(entry.itemId, items, costOf) });
		const finalIds = [player.item0Id, player.item1Id, player.item2Id, player.item3Id, player.item4Id, player.item5Id].filter(
			(itemId): itemId is number => typeof itemId === 'number' && itemId > 0,
		);
		const neutrals = neutralTimeline(inventory);

		// 背包快照里会出现"从没买过"的装备（中立掉落、掉落物），所以单独出一张 id → 装备的表。
		const usedIds = new Set<number>([
			...timeline.map((entry) => entry.itemId),
			...finalIds,
			...neutrals.map((entry) => entry.itemId),
			...inventory.flatMap((snapshot) => [...snapshot.slots, ...snapshot.backpack, snapshot.teleport, snapshot.neutral]),
			// 蓝杖与碎片不管这位选手买没买都要出图标（没买就画成灰的），所以固定带上。
			...SCEPTER_ITEM_IDS,
			...SHARD_ITEM_IDS,
		]);
		const itemMap: Record<number, GuideItemView> = {};
		for (const itemId of usedIds) {
			if (itemId > 0) itemMap[itemId] = itemView(itemId, items, costOf);
		}

		/*
		 * 悬停面板要的两份"看穿到英雄本体"的数据：
		 *
		 * - 天赋树：这一局点了哪几个（按 id 比对，不按文字——同一句话的数值会随版本变）；
		 * - 蓝杖/魔晶：各自升级或召唤了哪几个技能，取官方 datafeed 的原生标记。
		 */
		const treeTalents = (hero?.talents ?? []).map((talent) => ({
			id: talent.id,
			name: resolveTemplate(talent.name, special, talent.key) || talent.name,
		}));
		const pickedTalentIds = new Set<number>();
		for (const ability of player.abilities ?? []) {
			const abilityId = ability.abilityId ?? 0;
			if (abilityId > 0 && talentText.has(abilityId)) pickedTalentIds.add(abilityId);
		}

		const upgradeOf = (itemIds: number[], pick: (ability: Hero['abilities'][number]) => boolean, granted: (ability: Hero['abilities'][number]) => boolean): GuideUpgrade => ({
			item: itemView(itemIds[0], items, costOf),
			time: firstPurchaseTime(purchases, itemIds),
			abilities: (hero?.abilities ?? [])
				.filter(pick)
				.map((ability) => ({ id: ability.id, name: ability.nameLoc, img: ability.img, granted: granted(ability) })),
		});

		return {
			matchId: match.id ?? matchId,
			startTime: match.startDateTime ?? 0,
			durationSeconds: match.durationSeconds ?? 0,
			radiantWin: typeof match.didRadiantWin === 'boolean' ? match.didRadiantWin : null,
			authorName: player.steamAccount?.name?.trim() || '匿名玩家',
			position: player.position ?? null,
			isRadiant: Boolean(player.isRadiant),
			kills: player.kills ?? 0,
			deaths: player.deaths ?? 0,
			assists: player.assists ?? 0,
			imp: player.imp ?? null,
			level: player.level ?? null,
			lastHits: player.numLastHits ?? 0,
			denies: player.numDenies ?? 0,
			gpm: player.goldPerMinute ?? 0,
			xpm: player.experiencePerMinute ?? 0,
			networth: player.networth ?? 0,
			heroDamage: player.heroDamage ?? 0,
			buildingDamage: player.towerDamage ?? 0,
			steps,
			starting: starting.map(view),
			timeline: timeline.map(view),
			keyItems: keyPurchases(timeline, costOf).map(view),
			finalItems: finalIds.map((itemId) => itemView(itemId, items, costOf)),
			levels,
			inventory,
			neutrals,
			itemMap,
			talentTree: talentTreeRows(treeTalents, pickedTalentIds),
			upgrades: {
				scepter: upgradeOf(SCEPTER_ITEM_IDS, (a) => a.scepterUpgrade || a.grantedByScepter, (a) => a.grantedByScepter),
				shard: upgradeOf(SHARD_ITEM_IDS, (a) => a.shardUpgrade || a.grantedByShard, (a) => a.grantedByShard),
			},
		};
	});
}
