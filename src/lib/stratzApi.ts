import path from 'node:path';
import { cacheFile as cachePath, readCacheJson, writeCacheFile } from './buildCache';
import { reportSource } from './dataHealth';
import { LANE_MIN_GAMES, LANE_POSITIONS, buildLaneSlice, type HeroLanes, type LaneData } from './draftLanes';
import type { HeroMatchups } from './draftMatchup';
import { createPace } from './pace';
import { resolveStratzEndpoint } from './stratzEndpoint';

/**
 * STRATZ 数据层（api.stratz.com/graphql）。
 *
 * 分工：OpenDota 负责把日历里的队名解析成 Valve 队伍 id（它的队名索引命中率更高），
 * STRATZ 负责取 BP、选手明细与英雄数据——两者共用 Valve 的比赛 id 空间，
 * 所以同一场比赛可以无缝换源，而 STRATZ 的限速宽得多。
 *
 * 鉴权：需要 `STRATZ_TOKEN`（在 stratz.com/api 生成，有效期一年）。没有 token 或请求
 * 失败时不会联网，但有缓存就复用上次结果；完全拿不到数据时返回 null，调用方回落到
 * OpenDota 或直接不展示。
 *
 * 限速：响应头给出 8/秒、150/分、1500/时、15000/天。这里串行到约 6/秒，
 * 并把重试余量留给网络抖动（实测偶发 TLS ECONNRESET）。
 *
 * 请求头：接口前面挂着 Cloudflare，只对 `User-Agent: STRATZ_API`（官方文档指定的值）
 * 放行。实测浏览器 UA 与不带 UA 一律返回 "Just a moment..." 挑战页（HTTP 403），
 * 自造的应用名时好时坏——所以这个 UA 由 `stratzEndpoint.ts` 固定带上，不能改。
 */

const CACHE_DIR = path.join(process.cwd(), '.cache', 'stratz');
/** 离线构建只读缓存，不联网。 */
const OFFLINE = process.env.TOURNAMENTS_OFFLINE === '1';

/**
 * 直连官方，或走固定出口的中转——为什么需要中转写在 `stratzEndpoint.ts` 的注释里。
 * 构建机平时挂着代理，出口跟着代理组漂，所以这里的 token 与运行时的 token 最好都从中转走，
 * 只在确实有固定出口的机器上才直接用 `STRATZ_TOKEN`。
 */
const ENDPOINT = resolveStratzEndpoint({
	relayUrl: process.env.STRATZ_RELAY_URL,
	relayToken: process.env.STRATZ_RELAY_TOKEN,
	token: process.env.STRATZ_TOKEN,
});

/** 配了 token 才算"该有数据"：没有 token 时英雄区块是有意不展示，不是故障。 */
export function stratzConfigured(): boolean {
	return ENDPOINT.mode !== 'none';
}

/** 已结束的比赛与历史统计不会变，只有英雄数据需要定期刷新。 */
const HERO_META_TTL_SECONDS = 6 * 3600;
const MATCH_TTL_SECONDS = 30 * 24 * 3600;
const TEAM_MATCHES_TTL_SECONDS = 3600;

/** 英雄数据的分段：高分局最能反映版本强度。 */
export const HERO_META_BRACKET = 'DIVINE_IMMORTAL';
export const HERO_META_BRACKET_LABEL = '超凡入圣及以上';
/** 英雄数据的统计窗口（天）。banDay 会多给几天，按天索引裁到窗口内。 */
export const HERO_META_WINDOW_DAYS = 7;

// ---------------------------------------------------------------- 请求

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const MIN_INTERVAL_MS = 160;
/** 串行化限速，避免并发调用同时穿过限速窗口。 */
const pace = createPace(MIN_INTERVAL_MS);

interface GraphQLBody<T> {
	data?: T | null;
	errors?: unknown[];
}

/** 本轮成功联网查询的次数，用来区分"新抓的"和"吃缓存的"。 */
let networkFetches = 0;

export function stratzFetchCount(): number {
	return networkFetches;
}

/** 查询失败返回 null：对构建来说"这个区块没有数据"永远是可接受的降级。 */
async function query<T>(document: string, variables: Record<string, unknown>): Promise<T | null> {
	if (OFFLINE || ENDPOINT.mode === 'none') return null;
	for (let attempt = 0; attempt < 3; attempt += 1) {
		if (attempt > 0) await sleep(500 * attempt);
		await pace();
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), 20_000);
		try {
			const res = await fetch(ENDPOINT.url, {
				method: 'POST',
				signal: controller.signal,
				headers: ENDPOINT.headers,
				body: JSON.stringify({ query: document, variables }),
			});
			// 429、5xx，以及 Cloudflare 的挑战页都值得重试；挑战页是随机的，
			// 而同为 403 的鉴权失败是 JSON，重试没有意义，直接放弃。
			if (res.status === 429 || res.status >= 500) continue;
			if (res.status === 403 && (res.headers.get('content-type') ?? '').includes('text/html')) continue;
			if (!res.ok) return null;
			const body = (await res.json()) as GraphQLBody<T>;
			if (!body.data || body.errors?.length) return null;
			networkFetches += 1;
			return body.data;
		} catch {
			// 网络抖动，交给下一轮重试。
		} finally {
			clearTimeout(timer);
		}
	}
	return null;
}

// ---------------------------------------------------------------- 缓存

interface CacheEntry<T> {
	at: number;
	value: T;
}

async function readCache<T>(key: string): Promise<CacheEntry<T> | null> {
	const hit = await readCacheJson<CacheEntry<T>>(cachePath(CACHE_DIR, `${key}.json`), (value) =>
		typeof (value as CacheEntry<T>)?.at === 'number',
	);
	return hit?.value ?? null;
}

async function writeCache<T>(key: string, value: T): Promise<void> {
	await writeCacheFile(cachePath(CACHE_DIR, `${key}.json`), JSON.stringify({ at: Date.now(), value }));
}

/** 缓存优先；请求失败时退回过期缓存（离线构建靠它拿到上次的结果）。 */
async function cached<T>(key: string, ttlSeconds: number, load: () => Promise<T | null>): Promise<T | null> {
	const hit = await readCache<T>(key);
	if (hit && Date.now() - hit.at < ttlSeconds * 1000) return hit.value;
	const fresh = await load();
	if (fresh !== null) {
		await writeCache(key, fresh);
		return fresh;
	}
	return hit ? hit.value : null;
}

// ---------------------------------------------------------------- 比赛明细

export interface StratzPickBan {
	heroId: number;
	isPick: boolean;
	order: number;
	isRadiant: boolean;
}

export interface StratzMatchPlayer {
	name: string;
	heroId: number;
	isRadiant: boolean;
	kills: number;
	deaths: number;
	assists: number;
}

export interface StratzMatch {
	matchId: number;
	startTime: number;
	durationSeconds: number;
	radiantTeamId: number | null;
	direTeamId: number | null;
	radiantWin: boolean | null;
	pickBans: StratzPickBan[];
	players: StratzMatchPlayer[];
}

interface RawPickBan {
	heroId?: number | null;
	isPick?: boolean | null;
	order?: number | null;
	isRadiant?: boolean | null;
}

interface RawMatchPlayer {
	steamAccountId?: number | null;
	steamAccount?: { name?: string | null } | null;
	heroId?: number | null;
	isRadiant?: boolean | null;
	kills?: number | null;
	deaths?: number | null;
	assists?: number | null;
}

interface RawMatch {
	id?: number | null;
	startDateTime?: number | null;
	durationSeconds?: number | null;
	radiantTeamId?: number | null;
	direTeamId?: number | null;
	didRadiantWin?: boolean | null;
	pickBans?: RawPickBan[] | null;
	players?: RawMatchPlayer[] | null;
}

const MATCH_DOCUMENT = `query Match($id: Long!) {
	match(id: $id) {
		id
		startDateTime
		durationSeconds
		radiantTeamId
		direTeamId
		didRadiantWin
		pickBans { heroId isPick order isRadiant }
		players { steamAccountId steamAccount { name } heroId isRadiant kills deaths assists }
	}
}`;

/** 队伍 id 为负数是 STRATZ 对未知队伍的表达，按"没有"处理。 */
const teamIdOrNull = (id: number | null | undefined): number | null =>
	typeof id === 'number' && id > 0 ? id : null;

function toMatch(raw: RawMatch): StratzMatch | null {
	if (!raw.id) return null;
	const pickBans: StratzPickBan[] = [];
	for (const entry of raw.pickBans ?? []) {
		if (typeof entry.heroId !== 'number') continue;
		pickBans.push({
			heroId: entry.heroId,
			isPick: Boolean(entry.isPick),
			order: entry.order ?? 0,
			isRadiant: Boolean(entry.isRadiant),
		});
	}
	const players: StratzMatchPlayer[] = [];
	for (const entry of raw.players ?? []) {
		if (typeof entry.heroId !== 'number') continue;
		players.push({
			name: entry.steamAccount?.name?.trim() || '匿名选手',
			heroId: entry.heroId,
			isRadiant: Boolean(entry.isRadiant),
			kills: entry.kills ?? 0,
			deaths: entry.deaths ?? 0,
			assists: entry.assists ?? 0,
		});
	}
	if (pickBans.length === 0 && players.length === 0) return null;
	return {
		matchId: raw.id,
		startTime: raw.startDateTime ?? 0,
		durationSeconds: raw.durationSeconds ?? 0,
		radiantTeamId: teamIdOrNull(raw.radiantTeamId),
		direTeamId: teamIdOrNull(raw.direTeamId),
		radiantWin: typeof raw.didRadiantWin === 'boolean' ? raw.didRadiantWin : null,
		pickBans,
		players,
	};
}

/** 取一场比赛的 BP 与选手数据；取不到返回 null，由调用方回落到 OpenDota。 */
export function fetchMatchDetail(matchId: number): Promise<StratzMatch | null> {
	return cached<StratzMatch>(`match-${matchId}`, MATCH_TTL_SECONDS, async () => {
		const data = await query<{ match: RawMatch | null }>(MATCH_DOCUMENT, { id: matchId });
		return data?.match ? toMatch(data.match) : null;
	});
}

// ---------------------------------------------------------------- 队伍比赛

export interface StratzTeamMatch {
	matchId: number;
	startTime: number;
	radiantTeamId: number | null;
	direTeamId: number | null;
}

interface RawTeamMatch {
	id?: number | null;
	startDateTime?: number | null;
	radiantTeamId?: number | null;
	direTeamId?: number | null;
}

const TEAM_MATCHES_DOCUMENT = `query TeamMatches($id: Int!, $from: Long!) {
	team(teamId: $id) {
		matches(request: { startDateTime: $from, take: 50, skip: 0 }) {
			id
			startDateTime
			radiantTeamId
			direTeamId
		}
	}
}`;

/** 最近 30 天的队伍比赛，用于补 OpenDota 的 proMatches 索引漏掉的场次。 */
export const TEAM_MATCHES_WINDOW_DAYS = 30;

export async function fetchTeamMatches(teamId: number): Promise<StratzTeamMatch[]> {
	const key = `team-matches-${teamId}`;
	const rows = await cached<StratzTeamMatch[]>(key, TEAM_MATCHES_TTL_SECONDS, async () => {
		// 缓存键按队伍固定，窗口起点每次请求都取当下，避免旧缓存把新比赛挡在外面。
		const from = Math.floor(Date.now() / 1000) - TEAM_MATCHES_WINDOW_DAYS * 24 * 3600;
		const data = await query<{ team: { matches: RawTeamMatch[] | null } | null }>(TEAM_MATCHES_DOCUMENT, { id: teamId, from });
		const list = data?.team?.matches;
		if (!list) return null;
		return list
			.filter((entry) => entry.id && entry.startDateTime)
			.map((entry) => ({
				matchId: entry.id as number,
				startTime: entry.startDateTime as number,
				radiantTeamId: teamIdOrNull(entry.radiantTeamId),
				direTeamId: teamIdOrNull(entry.direTeamId),
			}));
	});
	return rows ?? [];
}

// ---------------------------------------------------------------- 英雄数据

export interface HeroPositionStat {
	/** 1–5，对应一号位到五号位。 */
	position: number;
	matches: number;
	wins: number;
	kills: number;
	deaths: number;
	assists: number;
}

export interface HeroMetaEntry {
	matches: number;
	wins: number;
	/** 被禁用场次，数据不可用时为 0。 */
	bans: number;
	positions: HeroPositionStat[];
}

export interface HeroMeta {
	updatedAt: string;
	bracketLabel: string;
	windowDays: number;
	/** key 为 Valve 英雄 id，与站内英雄页一致。 */
	heroes: Map<number, HeroMetaEntry>;
}

interface RawPositionStat {
	heroId?: number | null;
	position?: string | null;
	matchCount?: number | null;
	winCount?: number | null;
	kills?: number | null;
	deaths?: number | null;
	assists?: number | null;
}

interface RawBanStat {
	heroId?: number | null;
	day?: number | null;
	matchCount?: number | null;
}

const HERO_STATS_DOCUMENT = `query HeroStats($bracket: [RankBracketBasicEnum]) {
	heroStats {
		stats(bracketBasicIds: $bracket, groupByPosition: true) {
			heroId
			position
			matchCount
			winCount
			kills
			deaths
			assists
		}
	}
}`;

/**
 * 禁用数据。
 *
 * STRATZ 的这个字段要求传 heroId，但实测它并不生效（传 1 与传 100 返回同一份
 * "全部英雄按天分组的禁用数"）。所以这里只当它是"全英雄每日禁用表"来用，并在
 * 解析后校验覆盖的英雄数，万一将来变成真的按 heroId 过滤，就整体放弃禁用数据，
 * 而不是把某个英雄的数字当成所有人的。
 */
const HERO_BANS_DOCUMENT = `query HeroBans($bracket: [RankBracketBasicEnum], $day: Int!) {
	heroStats {
		banDay(heroId: 1, day: $day, bracketBasicIds: $bracket, groupByDay: true) {
			heroId
			day
			matchCount
		}
	}
}`;

const BAN_COVERAGE_MIN_HEROES = 50;
const SECONDS_PER_DAY = 24 * 3600;

const POSITION_RE = /^POSITION_([1-5])$/;

function buildHeroMeta(statRows: RawPositionStat[], banRows: RawBanStat[]): HeroMeta | null {
	const heroes = new Map<number, HeroMetaEntry>();
	for (const row of statRows) {
		if (typeof row.heroId !== 'number') continue;
		let entry = heroes.get(row.heroId);
		if (!entry) {
			entry = { matches: 0, wins: 0, bans: 0, positions: [] };
			heroes.set(row.heroId, entry);
		}
		const matches = row.matchCount ?? 0;
		entry.matches += matches;
		entry.wins += row.winCount ?? 0;
		const position = POSITION_RE.exec(row.position ?? '');
		if (position) {
			entry.positions.push({
				position: Number(position[1]),
				matches,
				wins: row.winCount ?? 0,
				kills: row.kills ?? 0,
				deaths: row.deaths ?? 0,
				assists: row.assists ?? 0,
			});
		}
	}
	if (heroes.size === 0) return null;

	const banHeroes = new Set(banRows.map((row) => row.heroId).filter((id): id is number => typeof id === 'number'));
	if (banHeroes.size >= BAN_COVERAGE_MIN_HEROES) {
		const oldestDay = Math.floor(Date.now() / 1000 / SECONDS_PER_DAY) - HERO_META_WINDOW_DAYS + 1;
		for (const row of banRows) {
			if (typeof row.heroId !== 'number' || typeof row.day !== 'number' || row.day < oldestDay) continue;
			const entry = heroes.get(row.heroId);
			if (entry) entry.bans += row.matchCount ?? 0;
		}
	}

	for (const entry of heroes.values()) entry.positions.sort((a, b) => a.position - b.position);

	return {
		updatedAt: new Date().toISOString(),
		bracketLabel: HERO_META_BRACKET_LABEL,
		windowDays: HERO_META_WINDOW_DAYS,
		heroes,
	};
}

let heroMetaPromise: Promise<HeroMeta | null> | null = null;

/**
 * 近一周的英雄出场/胜率/禁用。构建期多个页面共用一次请求。
 * 拿不到就返回 null，页面整块不展示。
 */
export function fetchHeroMeta(): Promise<HeroMeta | null> {
	heroMetaPromise ??= (async () => {
		const before = networkFetches;
		const statRows = await cached<RawPositionStat[]>('hero-stats', HERO_META_TTL_SECONDS, async () => {
			const data = await query<{ heroStats: { stats: RawPositionStat[] | null } }>(HERO_STATS_DOCUMENT, {
				bracket: [HERO_META_BRACKET],
			});
			const rows = data?.heroStats?.stats;
			return rows && rows.length > 0 ? rows : null;
		});
		if (!statRows || statRows.length === 0) {
			await reportSource(
				'stratz-hero',
				'STRATZ 英雄数据',
				'empty',
				ENDPOINT.mode !== 'none' ? '请求未拿到数据（限流、挑战页或接口异常）' : '未配置 STRATZ_TOKEN / STRATZ_RELAY_URL',
			);
			return null;
		}

		const banRows =
			(await cached<RawBanStat[]>('hero-bans', HERO_META_TTL_SECONDS, async () => {
				const data = await query<{ heroStats: { banDay: RawBanStat[] | null } }>(HERO_BANS_DOCUMENT, {
					bracket: [HERO_META_BRACKET],
					day: Math.floor(Date.now() / 1000),
				});
				const rows = data?.heroStats?.banDay;
				return rows && rows.length > 0 ? rows : null;
			})) ?? [];

		const meta = buildHeroMeta(statRows, banRows);
		if (meta) {
			await reportSource(
				'stratz-hero',
				'STRATZ 英雄数据',
				networkFetches > before ? 'fresh' : 'cache',
				`${meta.heroes.size} 个英雄，联网抓取 ${networkFetches - before} 次`,
			);
		}
		return meta;
	})();
	return heroMetaPromise;
}

// ---------------------------------------------------------------- 英雄对位（克制）

/**
 * 对位数据的场次门槛。
 *
 * 原来是「场次 ≥500 **且** 偏差 ≥4%」，两道一起把数据筛没了：实测（超凡入圣分段、10 个英雄、
 * 1260 条对手行）够 500 场的只有 51 条，再叠偏差 ≥4% 只剩 16 条；全池 127 个英雄去重后
 * 就 79 对，而且**没有任何一对过 1000 场**——那个分段下每对的样本天然就小。
 * 结果是对位这一项在建议里几乎不出声，复盘里的「对位偏差」常年显示 0.0%。
 *
 * 现在只留场次门槛，取 200：
 * - 200 场的胜率标准误是 ±3.5%（p=0.5），比它更小的样本不值得当依据，再大又会把数据筛没；
 * - **不再按偏差筛**。留下的是"明显克制/明显被克制"的那一小撮时，平均值会系统性偏向极端
 *   （第一版复盘跑出 ±48 个百分点，一半原因是重复计算，另一半就是这个偏差）。现在收
 *   接近五五开的对位一起进来，平均值才是这套阵容真实的平均对位强度。
 */
export const MATCHUP_MIN_GAMES = 200;
/** 对位数据按周滚动，一天一次足够，也少给中转添麻烦。 */
const MATCHUP_TTL_SECONDS = 24 * 3600;
/** 一次查几个英雄。实测接口支持 heroIds 数组，10 个一批，127 个英雄只发 13 次请求。 */
const MATCHUP_CHUNK = 10;

// 数据形状与查询放在 draftMatchup 里：那一层要同时给构建期和浏览器用，不能带 Node 依赖。
export type { HeroMatchups };

export interface HeroMatchupData {
	pairs: HeroMatchups;
	/** 留存的对位数，页面上用来说明覆盖面。 */
	pairCount: number;
}

interface RawMatchupHero {
	heroId?: number | null;
	vs?: { heroId2?: number | null; matchCount?: number | null; winCount?: number | null }[] | null;
}

/**
 * `bracketBasicIds` 用与英雄页相同的高分局口径；`winCount` 是**所查英雄**的胜场
 * （实测：单英雄 126 个对位的 winCount 之和等于它的总胜率乘总场次，误差在万分之几）。
 */
const MATCHUP_DOCUMENT = `query Matchups($heroIds: [Short], $bracket: [RankBracketBasicEnum], $take: Int) {
	heroStats {
		matchUp(heroIds: $heroIds, bracketBasicIds: $bracket, take: $take) {
			heroId
			vs { heroId2 matchCount winCount }
		}
	}
}`;

let matchupPromise: Promise<HeroMatchupData | null> | null = null;

/**
 * 取英雄对位数据，构建期一次。
 *
 * 缓存键带上英雄集合的规模与首尾 id：英雄池变了（新英雄上线）就重新抓，否则复用当天的结果。
 * 单飞，一次构建只跑一轮。
 */
export function fetchHeroMatchups(heroIds: readonly number[]): Promise<HeroMatchupData | null> {
	matchupPromise ??= (async () => {
		const ids = [...new Set(heroIds)].filter((id) => Number.isInteger(id) && id > 0).sort((a, b) => a - b);
		if (ids.length === 0) return null;
		const before = networkFetches;
		/*
		 * 缓存键里带上门槛：门槛改过之后，旧口径的结果还在缓存里躺着（TTL 一天），
		 * 不在键里区分就会照样读回来——数字变了却查不出原因，正是最难查的那种。
		 */
		const key = `hero-matchups-v2-${ids.length}-${ids[0]}-${ids[ids.length - 1]}-${MATCHUP_MIN_GAMES}`;

		const data = await cached<HeroMatchupData>(key, MATCHUP_TTL_SECONDS, async () => {
			const pairs: HeroMatchups = {};
			for (let index = 0; index < ids.length; index += MATCHUP_CHUNK) {
				const chunk = ids.slice(index, index + MATCHUP_CHUNK);
				const result = await query<{ heroStats: { matchUp: RawMatchupHero[] | null } }>(MATCHUP_DOCUMENT, {
					heroIds: chunk,
					bracket: [HERO_META_BRACKET],
					take: 200,
				});
				for (const hero of result?.heroStats?.matchUp ?? []) {
					const a = hero.heroId;
					if (typeof a !== 'number') continue;
					for (const row of hero.vs ?? []) {
						const b = row.heroId2;
						const games = row.matchCount ?? 0;
						const wins = row.winCount ?? 0;
						if (typeof b !== 'number' || a === b || games < MATCHUP_MIN_GAMES) continue;
						const rate = wins / games;
						const [low, high] = a < b ? [a, b] : [b, a];
						const lowRate = a < b ? rate : 1 - rate;
						const pairKey = `${low}-${high}`;
						const existing = pairs[pairKey];
						// 两个方向都查到同一条对位时以样本大的那次为准。
						if (!existing || games > existing[0]) pairs[pairKey] = [games, Number(lowRate.toFixed(3))];
					}
				}
			}
			const pairCount = Object.keys(pairs).length;
			return pairCount > 0 ? { pairs, pairCount } : null;
		});

		if (!data) {
			await reportSource('stratz-matchup', 'STRATZ 英雄对位', 'empty', '请求未拿到数据（限流、挑战页或接口异常）');
			return null;
		}
	await reportSource(
			'stratz-matchup',
			'STRATZ 英雄对位',
			networkFetches > before ? 'fresh' : 'cache',
			`${data.pairCount} 个对位（场次 ≥ ${MATCHUP_MIN_GAMES}）`,
		);
		return data;
	})();
	return matchupPromise;
}

// ---------------------------------------------------------------- 时间曲线（前中后期）

/**
 * 曲线取哪两个切点：5 分钟与 35 分钟。
 *
 * `groupByTime` 返回的是**累计口径**（所有打到该分钟的对局），所以绝对值不是"前五分钟的表现"，
 * 而是"这场打到至少 N 分钟时这个英雄的胜率"。两点相减才是我们要的：
 * 拖得越久越强，还是越拖越弱。
 */
const TIMELINE_EARLY_MINUTE = 5;
const TIMELINE_LATE_MINUTE = 35;
/** 切点上的样本下限：低于这个数就当这个英雄没有可用曲线。 */
const TIMELINE_MIN_MATCHES = 500;
const TIMELINE_TTL_SECONDS = 6 * 3600;

/** 英雄 id → [5 分钟切点胜率, 35 分钟切点胜率]。 */
export type HeroTimeline = Map<number, [number, number]>;

interface RawTimelineRow {
	heroId?: number | null;
	time?: number | null;
	matchCount?: number | null;
	winCount?: number | null;
}

const TIMELINE_DOCUMENT = `query HeroTimeline($bracket: [RankBracketBasicEnum]) {
	heroStats {
		stats(bracketBasicIds: $bracket, groupByTime: true) {
			heroId
			time
			matchCount
			winCount
		}
	}
}`;

let timelinePromise: Promise<HeroTimeline | null> | null = null;

/**
 * 全部英雄的时间曲线，构建期一次。拿不到就返回 null，打分里就不算时间这一项。
 */
export function fetchHeroTimeline(): Promise<HeroTimeline | null> {
	timelinePromise ??= (async () => {
		const before = networkFetches;
		const rows = await cached<RawTimelineRow[]>('hero-timeline', TIMELINE_TTL_SECONDS, async () => {
			const data = await query<{ heroStats: { stats: RawTimelineRow[] | null } }>(TIMELINE_DOCUMENT, {
				bracket: [HERO_META_BRACKET],
			});
			const list = data?.heroStats?.stats;
			return list && list.length > 0 ? list : null;
		});
		if (!rows || rows.length === 0) {
			await reportSource('stratz-timeline', 'STRATZ 时间曲线', 'empty', '请求未拿到数据（限流、挑战页或接口异常）');
			return null;
		}

		const pick = (list: RawTimelineRow[], minute: number): [number, number] | null => {
			// 取最接近该分钟的切点（接口给的是逐分钟 0..35）。
			let best: RawTimelineRow | null = null;
			for (const row of list) {
				if (typeof row.time !== 'number' || typeof row.matchCount !== 'number' || row.matchCount <= 0) continue;
				if (row.matchCount < TIMELINE_MIN_MATCHES) continue;
				if (!best || Math.abs(row.time - minute) < Math.abs((best.time ?? 0) - minute)) best = row;
			}
			if (!best || typeof best.matchCount !== 'number' || best.matchCount <= 0) return null;
			return [best.winCount ?? 0, best.matchCount];
		};

		const byHero = new Map<number, RawTimelineRow[]>();
		for (const row of rows) {
			if (typeof row.heroId !== 'number') continue;
			const bucket = byHero.get(row.heroId);
			if (bucket) bucket.push(row);
			else byHero.set(row.heroId, [row]);
		}

		const out: HeroTimeline = new Map();
		for (const [heroId, list] of byHero) {
			const early = pick(list, TIMELINE_EARLY_MINUTE);
			const late = pick(list, TIMELINE_LATE_MINUTE);
			if (!early || !late) continue;
			out.set(heroId, [Number((early[0] / early[1]).toFixed(3)), Number((late[0] / late[1]).toFixed(3))]);
		}
		if (out.size === 0) return null;

		await reportSource(
			'stratz-timeline',
			'STRATZ 时间曲线',
			networkFetches > before ? 'fresh' : 'cache',
			`${out.size} 个英雄的 ${TIMELINE_EARLY_MINUTE} / ${TIMELINE_LATE_MINUTE} 分钟切点（切点样本 ≥ ${TIMELINE_MIN_MATCHES}）`,
		);
		return out;
	})();
	return timelinePromise;
}

// ---------------------------------------------------------------- 线上对位（谁在线上打谁 / 和谁走一路）

/**
 * `heroStats.laneOutcome` 的整池取数。
 *
 * 三个与直觉不同的地方，都是实测出来的：
 *
 * 1. **不带 `heroId` 就返回全部英雄**（15,808 行、一百万场），所以「127 个英雄要 127 次请求」
 *    是错的——真正的成本是 `2 个方向 × 5 个号位 = 10 次`，缓存一天，构建期完全吃得下。
 * 2. **不带 `positionIds` 时只给一号位**，不是「全部号位」。所以五个号位要逐个问，
 *    每次约 1.4MB / 7,000–9,000 行。
 * 3. `isWith` 是必填参数：`false` 是线上的**对手**，`true` 是**同一条线上的搭档**。
 *    行形状完全一样，所以整理逻辑共用一份（`buildHeroLanes`）。
 *
 * 数据本身是「某英雄打某号位时，线上遇到的对手/搭档」，与 `heroStats.matchUp`（整局、不分路）
 * 是两回事，别混用。按 `LANE_MIN_GAMES` 裁剪后约 7,600 格 / 0.2MB，单独出一份静态 JSON。
 */
const LANE_TTL_SECONDS = 24 * 3600;

interface RawLaneRow {
	heroId1?: number | null;
	heroId2?: number | null;
	position?: string | null;
	matchCount?: number | null;
	winCount?: number | null;
	lossCount?: number | null;
}

const LANE_DOCUMENT = `query HeroLanes($isWith: Boolean!, $positions: [MatchPlayerPositionType]) {
	heroStats {
		laneOutcome(isWith: $isWith, bracketBasicIds: [${HERO_META_BRACKET}], positionIds: $positions) {
			heroId1
			heroId2
			position
			matchCount
			winCount
			lossCount
		}
	}
}`;

let lanesPromise: Promise<LaneData | null> | null = null;

/**
 * 全池的线上对位。拿不到（没有 token、上游挂了）就返回 null，页面与打分里都当「没有这一项」，
 * 不与整局对位互相顶替——两者的口径不同，混用等于把两件事加在一起。
 */
export function fetchHeroLanes(): Promise<LaneData | null> {
	lanesPromise ??= (async () => {
		const before = networkFetches;
	const data = await cached<LaneData>('hero-lanes-v2', LANE_TTL_SECONDS, async () => {
		/**
		 * 一个方向：五个号位各问一次，按**请求的号位**建表。
		 *
		 * 不能用行里的 `position`：批量查询时那个字段永远是 `POSITION_1`（见 `buildLaneSlice`）。
		 * 缓存键因此从 `hero-lanes` 升到 `hero-lanes-v2`——旧缓存里正是那份落错号位的表。
		 */
		const collect = async (isWith: boolean): Promise<HeroLanes> => {
			const out: HeroLanes = {};
			for (const position of LANE_POSITIONS) {
				const one = await query<{ heroStats: { laneOutcome: RawLaneRow[] | null } }>(LANE_DOCUMENT, {
					isWith,
					positions: [`POSITION_${position}`],
				});
				const list = one?.heroStats?.laneOutcome;
				if (!list) return {};
				Object.assign(out, buildLaneSlice(list, position));
			}
			return out;
		};
		// 先对手后搭档：任一步拿不到就整份不算数，免得页面拿到半份数据还以为覆盖率高。
		const vs = await collect(false);
		const withLanes = await collect(true);
		if (Object.keys(vs).length === 0 || Object.keys(withLanes).length === 0) return null;
		return { vs, with: withLanes };
	});
		if (!data) {
			await reportSource('stratz-lanes', 'STRATZ 线上对位', 'empty', '请求未拿到数据（限流、挑战页或接口异常）');
			return null;
		}
		await reportSource(
			'stratz-lanes',
			'STRATZ 线上对位',
			networkFetches > before ? 'fresh' : 'cache',
			`线上对手 ${Object.keys(data.vs).length.toLocaleString('zh-CN')} 格 / 同路搭档 ${Object.keys(data.with).length.toLocaleString('zh-CN')} 格（每格 ≥ ${LANE_MIN_GAMES} 场）`,
		);
		return data;
	})();
	return lanesPromise;
}
