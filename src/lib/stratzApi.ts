import { promises as fs } from 'node:fs';
import path from 'node:path';

/**
 * STRATZ 数据层（api.stratz.com/graphql）。
 *
 * 分工：OpenDota 负责把超凡的队名解析成 Valve 队伍 id（它的队名索引命中率更高），
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
 * 必须带 `User-Agent`：不带时 Cloudflare 会直接返回 "Just a moment..." 的挑战页
 * （HTTP 403），Node 默认没有 UA，所以这里必须显式设置。
 */

const API = 'https://api.stratz.com/graphql';
/** 接口要求标识调用方，同时也是绕过 Cloudflare 挑战页的必要条件。 */
const USER_AGENT = 'dota2-news-portal/1.0';
const CACHE_DIR = path.join(process.cwd(), '.cache', 'stratz');
/** 离线构建只读缓存，不联网。 */
const OFFLINE = process.env.TOURNAMENTS_OFFLINE === '1';
const TOKEN = (process.env.STRATZ_TOKEN ?? '').trim();

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
let lastRequestAt = 0;
/** 串行化限速，避免并发调用同时穿过限速窗口。 */
let paceQueue: Promise<void> = Promise.resolve();

async function pace(): Promise<void> {
	paceQueue = paceQueue.then(async () => {
		const wait = lastRequestAt + MIN_INTERVAL_MS - Date.now();
		if (wait > 0) await sleep(wait);
		lastRequestAt = Date.now();
	});
	return paceQueue;
}

interface GraphQLBody<T> {
	data?: T | null;
	errors?: unknown[];
}

/** 查询失败返回 null：对构建来说"这个区块没有数据"永远是可接受的降级。 */
async function query<T>(document: string, variables: Record<string, unknown>): Promise<T | null> {
	if (OFFLINE || !TOKEN) return null;
	for (let attempt = 0; attempt < 3; attempt += 1) {
		if (attempt > 0) await sleep(500 * attempt);
		await pace();
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), 20_000);
		try {
			const res = await fetch(API, {
				method: 'POST',
				signal: controller.signal,
				headers: {
					'Content-Type': 'application/json',
					Accept: 'application/json',
					'User-Agent': USER_AGENT,
					Authorization: `Bearer ${TOKEN}`,
				},
				body: JSON.stringify({ query: document, variables }),
			});
			// 429 与 5xx 值得重试，其余错误（含鉴权失败）直接放弃。
			if (res.status === 429 || res.status >= 500) continue;
			if (!res.ok) return null;
			const body = (await res.json()) as GraphQLBody<T>;
			if (!body.data || body.errors?.length) return null;
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
	try {
		const raw = await fs.readFile(path.join(CACHE_DIR, `${key}.json`), 'utf8');
		const parsed = JSON.parse(raw) as CacheEntry<T>;
		return parsed && typeof parsed.at === 'number' ? parsed : null;
	} catch {
		return null;
	}
}

async function writeCache<T>(key: string, value: T): Promise<void> {
	try {
		await fs.mkdir(CACHE_DIR, { recursive: true });
		await fs.writeFile(path.join(CACHE_DIR, `${key}.json`), JSON.stringify({ at: Date.now(), value }), 'utf8');
	} catch {
		// 缓存写入失败不影响构建。
	}
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
		const statRows = await cached<RawPositionStat[]>('hero-stats', HERO_META_TTL_SECONDS, async () => {
			const data = await query<{ heroStats: { stats: RawPositionStat[] | null } }>(HERO_STATS_DOCUMENT, {
				bracket: [HERO_META_BRACKET],
			});
			const rows = data?.heroStats?.stats;
			return rows && rows.length > 0 ? rows : null;
		});
		if (!statRows || statRows.length === 0) return null;

		const banRows =
			(await cached<RawBanStat[]>('hero-bans', HERO_META_TTL_SECONDS, async () => {
				const data = await query<{ heroStats: { banDay: RawBanStat[] | null } }>(HERO_BANS_DOCUMENT, {
					bracket: [HERO_META_BRACKET],
					day: Math.floor(Date.now() / 1000),
				});
				const rows = data?.heroStats?.banDay;
				return rows && rows.length > 0 ? rows : null;
			})) ?? [];

		return buildHeroMeta(statRows, banRows);
	})();
	return heroMetaPromise;
}
