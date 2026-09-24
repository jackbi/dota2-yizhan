import type { MapSide } from './dotaMap.ts';
import { buildingLabel } from './dotaMap.ts';
import { cached } from './ssrCache';
import { StratzError, stratzGql as gql, stratzRuntimeConfigured } from './stratzRuntime';
import { summarizeWards, type WardEventRaw, type WardOwner, type WardSummary } from './wardStats.ts';

/**
 * 对局复盘（`/replay/[id]`）的数据层。
 *
 * 一次复盘要的东西分两档，**故意分成两次查询**：
 *
 * | | 查询字段 | 上游体积 / 耗时 | 覆盖范围 |
 * | --- | --- | --- | --- |
 * | 复盘面板 | 经济与经验差、逐分钟击杀、塔况、推塔事件、分路结果 | 约 2KB / 1.4s | 所有被 STRATZ 解析的对局 |
 * | 地图回放 | `playbackData`：逐秒位置、眼位、肉山、建筑 | 约 400KB / 2.6s | 只有 STRATZ 下载过录像的对局 |
 *
 * 合起来查的话，面板就会为了一份「几小时前就定死了」的曲线去等 400KB；分开查之后，
 * 面板跟着页面一起在服务端渲染，地图等读者真的点「载入轨迹」再拉（见 `MatchPlayback.astro`）。
 *
 * 地图那条路有个**覆盖率的硬约束**：STRATZ 只对「下载并解析过录像」的对局给 playbackData。
 * 实测 9012488967 / 9012784253 这些近期职业局有 2 万个位置点，而一周前的 8994002904 /
 * 8987082716 是空数组——录像有保留期。所以地图 Tab 不是「做了就有」，是「有数据才亮」，
 * 复盘面板则对自己的覆盖率负责：老的职业局照样有曲线和推塔时间轴。
 *
 * 缓存：成果都在 `ssrCache` 的内存缓存里（运行时不碰文件系统）。已结束的对局不再变化，
 * 给 30 分钟 / 60 分钟；未命中的地图数据也照缓存，免得每来一个访客就替上游跑一次 8 秒的查询。
 */

const REVIEW_TTL_MS = 30 * 60 * 1000;
const PLAYBACK_TTL_MS = 60 * 60 * 1000;

export { StratzError };

export function reviewConfigured(): boolean {
	return stratzRuntimeConfigured();
}

// ---------------------------------------------------------------- 类型

export interface ReviewPlayer {
	accountId: number | null;
	name: string;
	heroId: number;
	isRadiant: boolean;
	/** Valve 的玩家槽位（天辉 0–4、夜魇 128–132）；眼位事件靠它对到人。 */
	slot: number | null;
	kills: number;
	deaths: number;
	assists: number;
	networth: number;
	level: number;
}

/** 一分钟一行：曲线上的一个点。索引即分钟，0 是开局。 */
export interface ReviewMinute {
	minute: number;
	/** 天辉视角的经济差，正数 = 天辉领先。 */
	networthLead: number;
	experienceLead: number;
	/** STRATZ 模型的胜率（0–1，天辉视角）；缺一格时按 null 处理。 */
	winRate: number | null;
}

/** 一次建筑倒塌：说明「什么时候、哪座」。 */
export interface ReviewFall {
	time: number;
	npcId: number;
	label: string;
	side: MapSide;
	/** 补刀的那名英雄 id；上游也会给空（小兵推的、或者数据缺失）。 */
	attackerHeroId: number | null;
}

export interface MatchReview {
	matchId: number;
	startTime: number;
	durationSeconds: number;
	radiantWin: boolean | null;
	radiantName: string | null;
	direName: string | null;
	firstBloodTime: number | null;
	/** 三路结果，值仍是上游枚举（`RADIANT_STOMP` 之类），中文在 `dotaLabels.laneOutcomeLabel`。 */
	lanes: { top: string | null; mid: string | null; bottom: string | null };
	towersAlive: { radiant: number; dire: number };
	barracksAlive: { radiant: number; dire: number };
	minutes: ReviewMinute[];
	falls: ReviewFall[];
	players: ReviewPlayer[];
	/** 眼位统计；这场没有眼位数据时为 null（未下载录像的对局）。 */
	wards: WardSummary | null;
	/** 上游标记「这场下载过录像」。为 true 也仍可能查不到 playbackData（保留期过了），只是概率大。 */
	didRequestDownload: boolean;
}

export interface PlaybackPlayer {
	heroId: number;
	isRadiant: boolean;
	/** 扁平三元组 `[t, x, y, t, x, y, …]`，坐标同 `dotaMap`（0–255，y 轴向上）。 */
	points: number[];
}

export interface PlaybackWard {
	t: number;
	x: number;
	y: number;
	kind: string;
	/** 插眼方阵营，用来按队伍上色；槽位对不上时是 null。 */
	side: MapSide | null;
	/** 被反掉的时间；没被反掉就是 null。 */
	end: number | null;
}

export interface MatchPlayback {
	matchId: number;
	durationSeconds: number;
	players: PlaybackPlayer[];
	wards: PlaybackWard[];
	/** 肉山位置采样，扁平三元组；上游事件大量只有时间没有坐标，那些直接丢掉。 */
	roshan: number[];
	falls: { t: number; npcId: number; side: MapSide }[];
}

// ---------------------------------------------------------------- 原始响应

interface RawReviewMatch {
	id?: number | null;
	startDateTime?: number | null;
	durationSeconds?: number | null;
	didRadiantWin?: boolean | null;
	isStats?: boolean | null;
	firstBloodTime?: number | null;
	radiantNetworthLeads?: number[] | null;
	radiantExperienceLeads?: number[] | null;
	winRates?: number[] | null;
	towerStatusRadiant?: number | null;
	towerStatusDire?: number | null;
	barracksStatusRadiant?: number | null;
	barracksStatusDire?: number | null;
	topLaneOutcome?: string | null;
	midLaneOutcome?: string | null;
	bottomLaneOutcome?: string | null;
	didRequestDownload?: boolean | null;
	radiantTeam?: { name?: string | null } | null;
	direTeam?: { name?: string | null } | null;
	towerDeaths?: { time?: number | null; npcId?: number | null; isRadiant?: boolean | null; attacker?: number | null }[] | null;
	players?: RawReviewPlayer[] | null;
	playbackData?: RawPlayback | null;
}

interface RawReviewPlayer {
	steamAccountId?: number | null;
	playerSlot?: number | null;
	heroId?: number | null;
	isRadiant?: boolean | null;
	kills?: number | null;
	deaths?: number | null;
	assists?: number | null;
	networth?: number | null;
	level?: number | null;
	steamAccount?: { name?: string | null } | null;
	/** 只有地图回放那份查询会带上它。 */
	playbackData?: RawPositionEvents | null;
}

/**
 * 复盘面板那份轻查询。
 *
 * `winRates` 与经济差数组**不是等长的**：同一场里上游给 50 个经济点、49 个胜率点
 * （分钟 0 没有胜率）。所以按经济差的长度铺分钟轴，胜率缺哪一格就是 null，
 * 交给画图那层断线（见 `replayChart.buildRateChart`）而不是补一个假的 50%。
 */
const REVIEW_DOCUMENT = `query MatchReview($id: Long!) {
  match(id: $id) {
    id
    startDateTime
    durationSeconds
    didRadiantWin
    isStats
    firstBloodTime
    radiantNetworthLeads
    radiantExperienceLeads
    winRates
    towerStatusRadiant
    towerStatusDire
    barracksStatusRadiant
    barracksStatusDire
    topLaneOutcome
    midLaneOutcome
    bottomLaneOutcome
    didRequestDownload
    radiantTeam { name }
    direTeam { name }
	towerDeaths { time npcId isRadiant attacker }
    playbackData {
      wardEvents { indexId wardType action fromPlayer playerDestroyed }
    }
    players {
      steamAccountId
      playerSlot
      heroId
      isRadiant
      kills
      deaths
      assists
      networth
      level
      steamAccount { name }
    }
  }
}`;

/**
 * 地图回放那份重查询。
 *
 * 只要位置、眼位、肉山、建筑倒塌四样——装备/技能/伤害那些逐事件数组（`inventoryEvents`、
 * `abilityUsedEvents`…）加起来还能再翻一倍，而这个视图只画得下「谁在哪、什么时候发生了什么」。
 */
const PLAYBACK_DOCUMENT = `query MatchPlayback($id: Long!) {
  match(id: $id) {
    id
    durationSeconds
    towerDeaths { time npcId isRadiant }
    playbackData {
      roshanEvents { time x y }
      wardEvents { indexId time positionX positionY wardType action fromPlayer }
    }
    players {
      playerSlot
      heroId
      isRadiant
      playbackData {
        playerUpdatePositionEvents { time x y }
      }
    }
  }
}`;

/**
 * 建筑存活是**位掩码**（位为 1 = 还在），不是数量。
 *
 * 实测：`barracksStatusRadiant = 63` 是 6 个 1（每方 6 座兵营），`towerStatusRadiant = 1982`
 * 是 9 个 1，而那场天辉确实只掉了 2 座塔。直接当数量用会得到「还剩 1982 座塔」。
 */
function countMaskBits(mask: number | null | undefined): number {
	let value = Math.max(0, Math.trunc(mask ?? 0));
	let count = 0;
	while (value > 0) {
		value &= value - 1;
		count += 1;
	}
	return count;
}

function toReview(raw: RawReviewMatch): MatchReview | null {
	if (!raw.id) return null;

	const networth = raw.radiantNetworthLeads ?? [];
	const experience = raw.radiantExperienceLeads ?? [];
	const winRates = raw.winRates ?? [];
	// 两条曲线可能差一格（`xp` 偶尔比 `nw` 短），按短的那条铺分钟轴，免得拼出一个没有 xp 的尾巴。
	const minuteCount = Math.min(networth.length, experience.length);
	const minutes: ReviewMinute[] = [];
	for (let index = 0; index < minuteCount; index += 1) {
		const winRate = winRates[index];
		minutes.push({
			minute: index,
			networthLead: networth[index] ?? 0,
			experienceLead: experience[index] ?? 0,
			winRate: typeof winRate === 'number' ? winRate : null,
		});
	}

	const falls: ReviewFall[] = (raw.towerDeaths ?? [])
		.filter((fall) => typeof fall.time === 'number' && typeof fall.npcId === 'number')
		.map((fall) => ({
			time: fall.time as number,
			npcId: fall.npcId as number,
			label: buildingLabel(fall.npcId as number) ?? `建筑 #${fall.npcId}`,
			side: (fall.isRadiant ? 0 : 1) as MapSide,
			attackerHeroId: typeof fall.attacker === 'number' && fall.attacker > 0 ? fall.attacker : null,
		}))
		.sort((a, b) => a.time - b.time);

	const players: ReviewPlayer[] = (raw.players ?? [])
		.filter((player) => typeof player.heroId === 'number' && player.heroId > 0)
		.map((player) => ({
			accountId: typeof player.steamAccountId === 'number' && player.steamAccountId > 0 ? player.steamAccountId : null,
			name: player.steamAccount?.name?.trim() || '匿名选手',
			heroId: player.heroId as number,
			isRadiant: Boolean(player.isRadiant),
			slot: typeof player.playerSlot === 'number' ? player.playerSlot : null,
			kills: player.kills ?? 0,
			deaths: player.deaths ?? 0,
			assists: player.assists ?? 0,
			networth: player.networth ?? 0,
			level: player.level ?? 0,
		}))
		.sort((a, b) => Number(b.isRadiant) - Number(a.isRadiant) || b.networth - a.networth);

	// 眼位：槽位 → 选手的对照表来自这一场自己的 `playerSlot`，不靠「谁离得近」猜（实测那样会猜错六成）。
	const owners: WardOwner[] = players
		.filter((player): player is ReviewPlayer & { slot: number } => player.slot !== null)
		.map((player) => ({ slot: player.slot, isRadiant: player.isRadiant, heroId: player.heroId, name: player.name }));
	const wards = summarizeWards((raw.playbackData?.wardEvents ?? []) as WardEventRaw[], owners);

	// 没有曲线也没有推塔事件 = 这一局没有可复盘的东西（路人局、未解析的对局）。
	// 这时返回 null，页面按「没有复盘数据」处理，而不是渲染一堆空图。
	if (minutes.length === 0 && falls.length === 0) return null;

	return {
		matchId: raw.id,
		startTime: raw.startDateTime ?? 0,
		durationSeconds: raw.durationSeconds ?? 0,
		radiantWin: typeof raw.didRadiantWin === 'boolean' ? raw.didRadiantWin : null,
		radiantName: raw.radiantTeam?.name?.trim() || null,
		direName: raw.direTeam?.name?.trim() || null,
		firstBloodTime: typeof raw.firstBloodTime === 'number' && raw.firstBloodTime >= 0 ? raw.firstBloodTime : null,
		lanes: {
			top: raw.topLaneOutcome ?? null,
			mid: raw.midLaneOutcome ?? null,
			bottom: raw.bottomLaneOutcome ?? null,
		},
		towersAlive: { radiant: countMaskBits(raw.towerStatusRadiant), dire: countMaskBits(raw.towerStatusDire) },
		barracksAlive: { radiant: countMaskBits(raw.barracksStatusRadiant), dire: countMaskBits(raw.barracksStatusDire) },
		minutes,
		falls,
		players,
		wards,
		didRequestDownload: Boolean(raw.didRequestDownload),
	};
}

function toPlayback(raw: RawReviewMatch & { playbackData?: RawPlayback | null }): MatchPlayback | null {
	if (!raw.id) return null;

	const players: PlaybackPlayer[] = [];
	for (const player of raw.players ?? []) {
		if (typeof player.heroId !== 'number' || player.heroId <= 0) continue;
		const points: number[] = [];
		for (const event of player.playbackData?.playerUpdatePositionEvents ?? []) {
			if (typeof event.time !== 'number' || typeof event.x !== 'number' || typeof event.y !== 'number') continue;
			points.push(event.time, event.x, event.y);
		}
		if (points.length > 0) players.push({ heroId: player.heroId, isRadiant: Boolean(player.isRadiant), points });
	}

	const wards: PlaybackWard[] = [];
	const spawnIndex = new Map<number, PlaybackWard>();
	// 槽位 → 阵营的对照：只为了给地图上的眼位按队伍上色，认不出就留空（画成中性色）。
	const sideBySlot = new Map<number, MapSide>();
	for (const player of raw.players ?? []) {
		if (typeof player.playerSlot === 'number') sideBySlot.set(player.playerSlot, player.isRadiant ? 0 : 1);
	}
	for (const event of raw.playbackData?.wardEvents ?? []) {
		if (typeof event.time !== 'number' || typeof event.positionX !== 'number' || typeof event.positionY !== 'number') continue;
		if (event.action === 'DESPAWN') {
			const spawn = typeof event.indexId === 'number' ? spawnIndex.get(event.indexId) : undefined;
			if (spawn) spawn.end = event.time;
			continue;
		}
		const ward: PlaybackWard = {
			t: event.time,
			x: event.positionX,
			y: event.positionY,
			kind: event.wardType ?? 'OBSERVER',
			side: sideBySlot.get(event.fromPlayer ?? Number.NaN) ?? null,
			end: null,
		};
		wards.push(ward);
		if (typeof event.indexId === 'number') spawnIndex.set(event.indexId, ward);
	}

	const roshan: number[] = [];
	for (const event of raw.playbackData?.roshanEvents ?? []) {
		if (typeof event.time !== 'number' || typeof event.x !== 'number' || typeof event.y !== 'number') continue;
		roshan.push(event.time, event.x, event.y);
	}

	const falls = (raw.towerDeaths ?? [])
		.filter((fall) => typeof fall.time === 'number' && typeof fall.npcId === 'number')
		.map((fall) => ({ t: fall.time as number, npcId: fall.npcId as number, side: (fall.isRadiant ? 0 : 1) as MapSide }));

	// 一点位置都没有 = STRATZ 没下载（或已越过保留期）这场录像。返回 null 让页面对读者说清楚，
	// 而不是给一张只有底图的空地图。
	if (players.length === 0) return null;

	return { matchId: raw.id, durationSeconds: raw.durationSeconds ?? 0, players, wards, roshan, falls };
}

interface RawPlayback {
	roshanEvents?: { time?: number | null; x?: number | null; y?: number | null }[] | null;
	wardEvents?: RawWardEvent[] | null;
}

interface RawWardEvent {
	indexId?: number | null;
	time?: number | null;
	positionX?: number | null;
	positionY?: number | null;
	wardType?: string | null;
	action?: string | null;
	fromPlayer?: number | null;
	playerDestroyed?: number | null;
}

interface RawPositionEvents {
	playerUpdatePositionEvents?: { time?: number | null; x?: number | null; y?: number | null }[] | null;
}

// ---------------------------------------------------------------- 对外

/**
 * 复盘面板的数据。取不到数据返回 null；上游故障抛 `StratzError`——「这场没有复盘」
 * 与「STRATZ 挂了」在页面上要分开说。
 */
export async function loadMatchReview(matchId: number): Promise<MatchReview | null> {
	// 键里的 v2：这次给解析后的对象补了 `wards`（以及选手的 `playerSlot`）。仓库里记过「加头像
	// 没升版本」那次的教训（见 docs/data-sources.md）——内存缓存里那些旧形状的条目会缺字段，
	// 页面只会安静地少一块，不报错。改形状就换键，别指望缓存自己长出新字段。
	return cached(`review:v2:match:${matchId}`, REVIEW_TTL_MS, async () => {
		const data = await gql<{ match: RawReviewMatch | null }>(REVIEW_DOCUMENT, { id: matchId });
		return data.match ? toReview(data.match) : null;
	});
}

/** 地图回放的数据。同理：没有数据是 null（覆盖率问题），故障是抛错。 */
export async function loadMatchPlayback(matchId: number): Promise<MatchPlayback | null> {
	// 键里的 v2：眼位多了 `side`（按插眼方上色）。
	return cached(`playback:v2:match:${matchId}`, PLAYBACK_TTL_MS, async () => {
		const data = await gql<{ match: (RawReviewMatch & { playbackData?: RawPlayback | null }) | null }>(PLAYBACK_DOCUMENT, {
			id: matchId,
		});
		return data.match ? toPlayback(data.match) : null;
	});
}
