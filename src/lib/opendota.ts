import path from 'node:path';
import type { TeamRef } from '../data/types';
import { cacheFile as cachePath, readCacheJson, writeCacheFile } from './buildCache';
import { fetchHeroList } from './heroApi';
import { createPace } from './pace';

/**
 * OpenDota 数据层：队伍解析、阵容名单，以及比赛候选与明细。
 *
 * 为什么是"尽力而为"：
 * - 赛事日历来自 Liquipedia，只有赛程没有阵容/英雄，队伍与比赛只能按"队名/队标 + 开赛时间"推断；
 * - 队名索引来自 `/api/teams` 与 `proMatches`，三线队伍常常不在其中，命中不了就如实不展示；
 * - 所有请求都落盘缓存，冷启动需要一两分钟，之后构建只拉增量；
 * - 任何一步失败都只意味着"这队/这场没有数据"，不会影响构建。
 *
 * 阵容与 BP 的编排在 `matchDraft.ts`：那里优先用 STRATZ 取明细，取不到才回到这里。
 */

const API = 'https://api.opendota.com/api';
const CACHE_DIR = path.join(process.cwd(), '.cache', 'opendota');
/** 离线构建完全不联网，保持快速、可复现。 */
const OFFLINE = process.env.TOURNAMENTS_OFFLINE === '1';

const DAY_SECONDS = 24 * 3600;
/** 日历与 OpenDota 的开赛时间允许的偏差，也是比赛配对时的校验窗口。 */
export const MATCH_WINDOW_SECONDS = 12 * 3600;

// ---------------------------------------------------------------- 请求与缓存

/** OpenDota 未鉴权时限流约 60 次/分钟：只拉开请求间隔，不并发轰炸。 */
const MIN_INTERVAL_MS = 1100;
/** 一旦被限流就停止后续请求，避免把整个构建拖慢。 */
let rateLimited = false;
/** 用队列串行化限速，避免并发调用同时穿过限速窗口。 */
const pace = createPace(MIN_INTERVAL_MS);

/** 本轮成功联网请求的次数，供上层判断数据是新抓的还是吃缓存的。 */
let networkFetches = 0;

export function openDotaFetchCount(): number {
	return networkFetches;
}

async function fetchJson<T>(url: string, timeoutMs = 25_000): Promise<T | null> {
	if (OFFLINE || rateLimited) return null;
	await pace();
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const res = await fetch(url, { signal: controller.signal });
		if (res.status === 429) {
			rateLimited = true;
			return null;
		}
		if (!res.ok) return null;
		networkFetches += 1;
		return (await res.json()) as T;
	} catch {
		return null;
	} finally {
		clearTimeout(timer);
	}
}

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

/** 缓存优先；请求成功后回写，请求失败时退回过期缓存。 */
async function cachedJson<T>(key: string, url: string, ttlSeconds: number): Promise<T | null> {
	const hit = await readCache<T>(key);
	if (hit && Date.now() - hit.at < ttlSeconds * 1000) return hit.value;
	const fresh = await fetchJson<T>(url);
	if (fresh !== null) {
		await writeCache(key, fresh);
		return fresh;
	}
	return hit ? hit.value : null;
}

/** 同 cachedJson，但只缓存裁剪后的结果（比赛详情原始响应有几百 KB）。 */
async function cachedDerived<TRaw, TValue>(
	key: string,
	url: string,
	ttlSeconds: number,
	reduce: (raw: TRaw) => TValue,
): Promise<TValue | null> {
	const hit = await readCache<TValue>(key);
	if (hit && Date.now() - hit.at < ttlSeconds * 1000) return hit.value;
	const raw = await fetchJson<TRaw>(url);
	if (raw === null) return hit ? hit.value : null;
	const value = reduce(raw);
	await writeCache(key, value);
	return value;
}

const norm = (value: string): string => value.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]/g, '');

// ---------------------------------------------------------------- 对外类型

export interface TeamMember {
	accountId: number;
	name: string;
	games: number;
	wins: number;
	isCurrent: boolean;
}

export interface TeamRoster {
	teamId: number;
	name: string;
	members: TeamMember[];
}

// ---------------------------------------------------------------- 英雄

export interface HeroInfo {
	name: string;
	img: string;
}

let heroMapPromise: Promise<Map<number, HeroInfo>> | null = null;

/**
 * 英雄 id 与站内英雄页完全一致，所以优先取中文名与国语站点图；
 * 国语接口不可用时退回 OpenDota 的英文名与 Valve CDN 图。
 */
export async function getHeroMap(): Promise<Map<number, HeroInfo>> {
	heroMapPromise ??= (async () => {
		const map = new Map<number, HeroInfo>();
		try {
			for (const hero of await fetchHeroList()) map.set(hero.id, { name: hero.name, img: hero.img });
		} catch {
			// 下面用 OpenDota 兜底。
		}
		if (map.size === 0) {
			const list =
				(await cachedJson<{ id: number; name: string; localized_name: string }[]>('heroes', `${API}/heroes`, 7 * DAY_SECONDS)) ?? [];
			for (const hero of list) {
				const slug = hero.name.replace(/^npc_dota_hero_/, '');
				map.set(hero.id, {
					name: hero.localized_name || slug,
					img: `https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/heroes/${slug}.png`,
				});
			}
		}
		return map;
	})();
	return heroMapPromise;
}

export interface ProHeroStat {
	/** 该英雄在职业比赛里的出场、取胜与被禁场次。 */
	picks: number;
	wins: number;
	bans: number;
}

/** 职业样本变化慢，缓存一天足够，也避免每次构建都多打一个请求。 */
const PRO_HERO_TTL_SECONDS = DAY_SECONDS;

interface OdHeroStatRow {
	id?: number | null;
	pro_pick?: number | null;
	pro_win?: number | null;
	pro_ban?: number | null;
}

let proHeroStatsPromise: Promise<Map<number, ProHeroStat>> | null = null;

/**
 * 职业比赛的英雄出场与被禁场次（`/api/heroStats` 的 `pro_*`）。
 *
 * 取之前先说清口径：这两个数字**不是**「近一周」也不是「全部历史」，而是 OpenDota 数据库里
 * 滚动的职业样本。实测全部英雄加起来只有 600 多次出场，折合约 60 场对局，单个英雄常常只有
 * 个位数。所以它只能当**热度**的旁证，不能当胜率用；界面上也照实数展示场次，不换算成百分比
 * 唬人。真正有统计意义的号位胜率走 STRATZ 的高分局数据（见 `stratzApi.fetchHeroMeta`）。
 *
 * 拿不到就返回空 Map，调用方按"没有职业样本"降级。
 */
export function fetchProHeroStats(): Promise<Map<number, ProHeroStat>> {
	proHeroStatsPromise ??= (async () => {
		const rows = await cachedJson<OdHeroStatRow[]>('hero-stats', `${API}/heroStats`, PRO_HERO_TTL_SECONDS);
		const map = new Map<number, ProHeroStat>();
		for (const row of rows ?? []) {
			if (typeof row.id !== 'number') continue;
			const picks = row.pro_pick ?? 0;
			const bans = row.pro_ban ?? 0;
			if (picks === 0 && bans === 0) continue;
			map.set(row.id, { picks, wins: row.pro_win ?? 0, bans });
		}
		return map;
	})();
	return proHeroStatsPromise;
}

// ---------------------------------------------------------------- 队伍映射

export interface OdTeam {
	team_id: number;
	name: string | null;
	tag: string | null;
}

let teamIndexPromise: Promise<Map<string, OdTeam>> | null = null;

async function getTeamIndex(): Promise<Map<string, OdTeam>> {
	teamIndexPromise ??= (async () => {
		const list = (await cachedJson<OdTeam[]>('teams', `${API}/teams`, DAY_SECONDS)) ?? [];
		const index = new Map<string, OdTeam>();
		for (const team of list) {
			if (team.name) index.set(`n:${norm(team.name)}`, team);
		}
		// `/api/teams` 只给评分前 1000 的队伍，三线队往往只出现在 proMatches 里。
		const pro = (await cachedJson<OdProMatch[]>('pro-matches', `${API}/proMatches`, 6 * 3600)) ?? [];
		for (const match of pro) {
			const pairs: [string | null, number | null][] = [
				[match.radiant_name, match.radiant_team_id],
				[match.dire_name, match.dire_team_id],
			];
			for (const [name, id] of pairs) {
				if (!name || !id) continue;
				const key = `n:${norm(name)}`;
				if (!index.has(key)) index.set(key, { team_id: id, name, tag: null });
			}
		}
		// 队标单独一轮，避免短队标覆盖真实队名。
		for (const team of list) {
			if (!team.tag) continue;
			const key = `t:${norm(team.tag)}`;
			if (!index.has(key)) index.set(key, team);
		}
		return index;
	})();
	return teamIndexPromise;
}

/**
 * 把日历里的队伍解析成 OpenDota 队伍。
 * 队名一致可以直接采信；只对得上队标时必须回查一次，短队标撞名的情况很多。
 */
export async function resolveTeam(team: TeamRef): Promise<OdTeam | null> {
	const key = norm(team.name);
	if (!key) return null;
	const index = await getTeamIndex();
	const byName = index.get(`n:${key}`);
	if (byName) return byName;
	const byTag = index.get(`t:${key}`);
	if (!byTag) return null;
	const info = await cachedJson<{ name?: string | null; tag?: string | null }>(
		`team-${byTag.team_id}`,
		`${API}/teams/${byTag.team_id}`,
		7 * DAY_SECONDS,
	);
	if (info && (norm(info.name ?? '') === key || norm(info.tag ?? '') === key)) return byTag;
	return null;
}

// ---------------------------------------------------------------- 队员名单

interface OdMember {
	account_id: number;
	name: string | null;
	games_played: number;
	wins: number;
	is_current_team_member: boolean;
}

/** 取队伍当前阵容；OpenDota 不认识这支队伍时返回 null。 */
export async function loadTeamRoster(team: TeamRef): Promise<TeamRoster | null> {
	if (OFFLINE) return null;
	const od = await resolveTeam(team);
	if (!od) return null;
	const players = (await cachedJson<OdMember[]>(`roster-${od.team_id}`, `${API}/teams/${od.team_id}/players`, DAY_SECONDS)) ?? [];
	const members = players
		.filter((player) => player.name)
		.map((player) => ({
			accountId: player.account_id,
			name: player.name as string,
			games: player.games_played ?? 0,
			wins: player.wins ?? 0,
			isCurrent: Boolean(player.is_current_team_member),
		}))
		.sort((a, b) => Number(b.isCurrent) - Number(a.isCurrent) || b.games - a.games);
	return members.length > 0 ? { teamId: od.team_id, name: od.name ?? team.name, members } : null;
}

// ---------------------------------------------------------------- 比赛英雄

interface OdProMatch {
	match_id: number;
	start_time: number;
	radiant_team_id: number | null;
	dire_team_id: number | null;
	radiant_name: string | null;
	dire_name: string | null;
	leagueid: number | null;
}

interface OdLeagueMatch {
	match_id: number;
	start_time: number;
	radiant_team_id: number | null;
	dire_team_id: number | null;
}

export interface OdScheduleEntry {
	matchId: number;
	startTime: number;
}

const pairKey = (a: number, b: number): string => [a, b].sort((x, y) => x - y).join('|');

let schedulePromise: Promise<Map<string, OdScheduleEntry[]>> | null = null;

/**
 * 候选比赛表：把"双方队伍 id"映射到可能的 OpenDota 比赛。
 *
 * 只用 `/api/teams/{id}/matches` 求交集是不可行的——弱队的比赛历史很短，
 * 只要有一边没收录到这场，交集就空了（实测只能命中 2 场）。改成以
 * `proMatches`（含双方队伍 id）为主，再把它涉及到的联赛整份拉下来，
 * 覆盖率提高明显。
 */
async function loadSchedule(): Promise<Map<string, OdScheduleEntry[]>> {
	schedulePromise ??= (async () => {
		const map = new Map<string, OdScheduleEntry[]>();
		const push = (radiantId?: number | null, direId?: number | null, matchId?: number, startTime?: number) => {
			if (!radiantId || !direId || !matchId || !startTime) return;
			const key = pairKey(radiantId, direId);
			const entry = { matchId, startTime };
			const bucket = map.get(key);
			if (bucket) bucket.push(entry);
			else map.set(key, [entry]);
		};

		const pro = (await cachedJson<OdProMatch[]>('pro-matches', `${API}/proMatches`, 6 * 3600)) ?? [];
		for (const match of pro) push(match.radiant_team_id, match.dire_team_id, match.match_id, match.start_time);

		const leagueIds = new Set<number>();
		for (const match of pro) if (match.leagueid) leagueIds.add(match.leagueid);
		for (const leagueId of leagueIds) {
			const list = (await cachedJson<OdLeagueMatch[]>(`league-${leagueId}`, `${API}/leagues/${leagueId}/matches`, 7 * DAY_SECONDS)) ?? [];
			for (const match of list) push(match.radiant_team_id, match.dire_team_id, match.match_id, match.start_time);
		}
		return map;
	})();
	return schedulePromise;
}

/** 取这对队伍在 OpenDota 索引里的候选比赛，交给 matchDraft 与 STRATZ 的结果合并。 */
export async function findPairMatches(homeTeamId: number, awayTeamId: number): Promise<OdScheduleEntry[]> {
	const schedule = await loadSchedule();
	return schedule.get(pairKey(homeTeamId, awayTeamId)) ?? [];
}

interface OdMatchRaw {
	match_id: number;
	start_time: number;
	radiant_win: boolean;
	radiant_team_id: number | null;
	dire_team_id: number | null;
	radiant_name: string | null;
	dire_name: string | null;
	picks_bans?: { hero_id: number; is_pick: boolean; team: number; order: number }[] | null;
	players?: { hero_id: number; name?: string | null; isRadiant: boolean; kills: number; deaths: number; assists: number }[] | null;
}

/** 裁剪后的比赛明细：原始响应有几百 KB，只留阵容需要的字段。 */
export interface OdMatchDetail {
	matchId: number;
	startTime: number;
	radiantTeamId: number | null;
	direTeamId: number | null;
	picksBans: { heroId: number; isPick: boolean; team: number; order: number }[];
	players: { heroId: number; name: string; isRadiant: boolean; kills: number; deaths: number; assists: number }[];
}

export function fetchMatchDetail(matchId: number): Promise<OdMatchDetail | null> {
	return cachedDerived<OdMatchRaw, OdMatchDetail>(
		`match-${matchId}`,
		`${API}/matches/${matchId}`,
		Number.MAX_SAFE_INTEGER,
		(raw) => ({
			matchId: raw.match_id,
			startTime: raw.start_time,
			radiantTeamId: raw.radiant_team_id ?? null,
			direTeamId: raw.dire_team_id ?? null,
			picksBans: (raw.picks_bans ?? []).map((p) => ({ heroId: p.hero_id, isPick: p.is_pick, team: p.team, order: p.order })),
			players: (raw.players ?? []).map((p) => ({
				heroId: p.hero_id,
				name: p.name ?? '',
				isRadiant: Boolean(p.isRadiant),
				kills: p.kills ?? 0,
				deaths: p.deaths ?? 0,
				assists: p.assists ?? 0,
			})),
		}),
	);
}
