import path from 'node:path';
import { cacheFile as cachePath, readRawJson, writeCacheFile } from './buildCache';
import { reportSource } from './dataHealth';

/**
 * Dota 2 的在线人数，以及我们自己记下来的趋势。
 *
 * **三个数字里的两个来自 Valve 官方接口**，不需要 key：
 *
 * - 当前在线：`ISteamUserStats/GetNumberOfCurrentPlayers`
 * - 24 小时峰值与全站排名：`ISteamChartsService/GetMostPlayedGames`（只列前 100，DOTA2 常年在第 2 名）
 *
 * 第三个「历史峰值」**没有官方口径**，只能取第三方的统计值当常量放在这里（见 `ALL_TIME_PEAK`）。
 *
 * **趋势不是第三方给的，是自己记的。** SteamDB 那张图表页（`/app/570/charts/`）是 Cloudflare
 * 保护着的，实测 403——那是它自己的数据产品，抓它既不礼貌也不稳。所以每轮构建往
 * `.cache/players/history.json` 记一笔：站点半小时重建一次，一天 48 个点，一周就是一条真曲线。
 *
 * 话说明白：这份历史**从我们开始记录的那天算起**，图上会标出起点；GitHub Actions 的缓存
 * 长期不用会被淘汰，那之后就从头再来——不假装我们有长期数据。
 */

const APP_ID = 570;
const CURRENT_URL = `https://api.steampowered.com/ISteamUserStats/GetNumberOfCurrentPlayers/v1/?appid=${APP_ID}`;
const TOP_URL = 'https://api.steampowered.com/ISteamChartsService/GetMostPlayedGames/v1/';

const CACHE_DIR = path.join(process.cwd(), '.cache', 'players');
const CACHE_VERSION = 1;
const OFFLINE = process.env.TOURNAMENTS_OFFLINE === '1';

/** 留 30 天：够画月线，也不会让缓存文件无限长。 */
const KEEP_DAYS = 30;
/** 两个点挨得太近（本地连着构建、或一轮失败后重跑）就覆盖，不新起一个点。 */
const MIN_GAP_SECONDS = 15 * 60;
/** 页面上最多画这么多点：7 天 × 48 已经 336 个，再多 SVG 路径只会更长。 */
const MAX_CHART_POINTS = 400;

/**
 * 历史峰值。**Steam 没有官方口径**，这个数只能来自第三方统计，而且各家还不一样：
 * SteamCharts 记 1,291,328（2016 年 3 月），SteamDB 记 1,295,114——采样间隔不同，
 * 谁都说得通。这里取 SteamCharts 那个，页面上标注来源，不假装是官方数字。
 *
 * 纪录是 2016 年 3 月创下的，十年没破；真破了得手动改这一行（届时两个来源都该有数）。
 */
export const ALL_TIME_PEAK = {
	players: 1_291_328,
	/** 纪录所在的月份。 */
	month: '2016 年 3 月',
	source: 'SteamCharts',
	url: 'https://steamcharts.com/app/570',
} as const;

export interface PlayerPoint {
	/** Unix 秒。 */
	at: number;
	players: number;
	peak: number | null;
}

export interface PlayerSnapshot {
	/** 当前在线。官方接口这次没通时，退回到历史里最后一个点。 */
	players: number;
	/** 24 小时峰值（Steam 的 `peak_in_game` 就是这个口径），拿不到就是 null。 */
	peak: number | null;
	/** Steam 全站排名，拿不到就是 null。 */
	rank: number | null;
	/** `players` 这个数字实际是什么时候的（ISO）。 */
	at: string;
	/** 趋势折线的点，按时间升序。 */
	points: PlayerPoint[];
	/** 约 24 小时前那个点，用来算变化；不够长就是 null。 */
	dayAgo: PlayerPoint | null;
	/** 这次没抓到官方接口、数字来自历史（页面上要说明白）。 */
	stale: boolean;
}

interface HistoryFile {
	version: number;
	points: PlayerPoint[];
}

async function getJson(url: string): Promise<any> {
	const res = await fetch(url, {
		headers: { Accept: 'application/json' },
		signal: AbortSignal.timeout(15_000),
	});
	if (!res.ok) throw new Error(`HTTP ${res.status}`);
	return res.json();
}

async function fetchCurrent(): Promise<number | null> {
	const data = await getJson(CURRENT_URL);
	const count = Number(data?.response?.player_count);
	return Number.isFinite(count) && count > 0 ? count : null;
}

/** 24 小时峰值与排名。榜单里没有 DOTA2（掉出前 100）就返回 null，不算错。 */
async function fetchTop(): Promise<{ peak: number; rank: number } | null> {
	const data = await getJson(TOP_URL);
	const rows: any[] = Array.isArray(data?.response?.ranks) ? data.response.ranks : [];
	const row = rows.find((entry) => Number(entry?.appid) === APP_ID);
	if (!row) return null;
	const peak = Number(row.peak_in_game);
	const rank = Number(row.rank);
	return {
		peak: Number.isFinite(peak) && peak > 0 ? peak : 0,
		rank: Number.isFinite(rank) && rank > 0 ? rank : 0,
	};
}

async function readHistory(): Promise<PlayerPoint[]> {
	const file = cachePath(CACHE_DIR, 'history.json');
	const cached = await readRawJson<HistoryFile>(file);
	if (!cached || cached.version !== CACHE_VERSION || !Array.isArray(cached.points)) return [];
	return cached.points.filter(
		(point) => Number.isFinite(point?.at) && Number.isFinite(point?.players) && point.players > 0,
	);
}

/**
 * 记一笔。挨得太近就覆盖上一个点——否则本地连着跑几次构建，图上会多出一串同一时刻的点。
 */
function appendPoint(points: PlayerPoint[], next: PlayerPoint): PlayerPoint[] {
	const last = points[points.length - 1];
	const merged = last && next.at - last.at < MIN_GAP_SECONDS ? [...points.slice(0, -1), next] : [...points, next];
	const cutoff = next.at - KEEP_DAYS * 24 * 3600;
	return merged.filter((point) => point.at >= cutoff);
}

/** 页面上用不到那么多点：均匀抽稀到 `MAX_CHART_POINTS` 以内（保留首尾）。 */
function downsample(points: PlayerPoint[]): PlayerPoint[] {
	if (points.length <= MAX_CHART_POINTS) return points;
	const step = Math.ceil(points.length / MAX_CHART_POINTS);
	return points.filter((_, index) => index % step === 0 || index === points.length - 1);
}

/** 最接近 24 小时前的点；历史不够长就返回 null。 */
function pointADayAgo(points: PlayerPoint[], now: number): PlayerPoint | null {
	const target = now - 24 * 3600;
	let best: PlayerPoint | null = null;
	for (const point of points) {
		if (point.at > target) break;
		best = point;
	}
	// 只有一个小时前那种「差得远」的点不算，否则涨幅会算成假的。
	return best && target - best.at <= 6 * 3600 ? best : null;
}

let snapshotPromise: Promise<PlayerSnapshot | null> | null = null;

/** 一次构建只算一次。 */
export function fetchPlayers(): Promise<PlayerSnapshot | null> {
	snapshotPromise ??= load();
	return snapshotPromise;
}

async function load(): Promise<PlayerSnapshot | null> {
	const file = cachePath(CACHE_DIR, 'history.json');
	const stored = await readHistory();
	const now = Math.floor(Date.now() / 1000);

	let players: number | null = null;
	let top: { peak: number; rank: number } | null = null;
	if (!OFFLINE) {
		// 两个接口互不依赖，一个挂不该带倒另一个。
		[players, top] = await Promise.all([fetchCurrent().catch(() => null), fetchTop().catch(() => null)]);
	}

	const latest = stored[stored.length - 1] ?? null;
	const point: PlayerPoint | null =
		players !== null
			? { at: now, players, peak: top?.peak ?? null }
			: // 官方接口这次没通：不记点（免得把旧数字当成新样本记进去），页面退回历史里最后一个点。
				latest;

	const points = players !== null ? appendPoint(stored, point as PlayerPoint) : stored;
	if (players !== null) await writeCacheFile(file, JSON.stringify({ version: CACHE_VERSION, points } satisfies HistoryFile));

	const shown = point;
	const snapshot: PlayerSnapshot | null = shown
		? {
				players: shown.players,
				peak: top?.peak ?? shown.peak,
				rank: top?.rank ?? null,
				at: new Date(shown.at * 1000).toISOString(),
				points: downsample(points),
				dayAgo: pointADayAgo(points, now),
				stale: players === null,
			}
		: null;

	await reportSource(
		'steam-players',
		'Dota 2 在线人数',
		!snapshot ? 'empty' : players !== null ? 'fresh' : 'cache',
		!snapshot
			? '官方接口与本地历史都没有数据'
			: players !== null
				? `当前 ${players.toLocaleString('en-US')}${top ? `，24 小时峰值 ${top.peak.toLocaleString('en-US')}，全站第 ${top.rank}` : ''}，历史 ${points.length} 个点`
				: `官方接口没通，退回历史最后一个点（${shown ? new Date(shown.at * 1000).toISOString().slice(0, 16).replace('T', ' ') : '-'}）`,
	);
	return snapshot;
}
