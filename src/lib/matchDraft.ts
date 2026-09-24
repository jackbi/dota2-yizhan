import type { EsportsMatch } from '../data/types';
import { reportSource } from './dataHealth';
import {
	MATCH_WINDOW_SECONDS,
	fetchMatchDetail as fetchOpenDotaMatch,
	findPairMatches,
	getHeroMap,
	openDotaFetchCount,
	resolveTeam,
} from './opendota';
import type { HeroInfo, OdMatchDetail, OdTeam } from './opendota';
import { fetchMatchDetail as fetchStratzMatch, fetchSeriesGames, fetchTeamMatches, stratzFetchCount } from './stratzApi';
import type { StratzMatch } from './stratzApi';
import {
	byStartTime,
	coversBothTeams,
	seriesNearAnchor,
	toGames,
} from './matchSeries.ts';
import type { Candidate, MatchSeriesDraft, NormalizedDraft } from './matchSeries.ts';

/**
 * 比赛阵容层：把日历里的比赛对到 Valve 的比赛上，取回 BP 与选手英雄。
 *
 * 两个数据源的分工：
 * - 队伍解析只走 OpenDota（`/api/teams` + `proMatches` 的队名索引命中率更高，
 *   STRATZ 的 `stratz.search` 在三线队上又少又容易给错队）；
 * - 候选比赛取两边的并集：OpenDota 的联赛索引，加 STRATZ 的"队伍近 30 天比赛"
 *   求交集——后者能补上 `proMatches` 没收录的场次；
 * - 明细优先 STRATZ（同一个 Valve 比赛 id，字段更全，限速宽 7 倍），取不到才回 OpenDota。
 *
 * 粒度是**小局**，不是"一场比赛"：日历上的一条是系列（BO3/BO5），而 Valve 的每个比赛 id
 * 只对应其中一局。所以这里返回整个系列的所有小局，页面上"第 1/2/3 局"就是这个数组。
 * 小局清单以 STRATZ 的 series 关系为准，拿不到才回落到"候选里时间相近的几场"。
 *
 * 小局模型与纯逻辑（顺序、主客队对齐、系列边界）在 `matchSeries.ts`，那边可以离线自检。
 *
 * 命中不了就不展示，绝不靠队名近似去猜一场比赛。
 */

function fromStratz(detail: StratzMatch): NormalizedDraft {
	return {
		matchId: detail.matchId,
		startTime: detail.startTime,
		duration: detail.durationSeconds,
		radiantWin: detail.radiantWin,
		radiantTeamId: detail.radiantTeamId,
		direTeamId: detail.direTeamId,
		source: 'stratz',
		picksBans: detail.pickBans,
		players: detail.players.map((player) => ({ ...player })),
	};
}

function fromOpenDota(detail: OdMatchDetail): NormalizedDraft {
	return {
		matchId: detail.matchId,
		startTime: detail.startTime,
		// 这两个字段是后补的，早先写下的缓存条目里没有，按"取不到"处理。
		duration: detail.duration ?? 0,
		radiantWin: detail.radiantWin ?? null,
		radiantTeamId: detail.radiantTeamId,
		direTeamId: detail.direTeamId,
		source: 'opendota',
		// OpenDota 里 picks_bans.team 0 是天辉、1 是夜魇。
		picksBans: detail.picksBans.map((entry) => ({
			heroId: entry.heroId,
			isPick: entry.isPick,
			order: entry.order,
			isRadiant: entry.team === 0,
		})),
		players: detail.players,
	};
}

/**
 * 候选比赛：OpenDota 的联赛索引与 STRATZ 的两队近 30 天比赛求交集，按时间接近度排序。
 * 两个源给出的都是 Valve 比赛 id，可以直接按 id 去重。
 */
async function findCandidates(home: OdTeam, away: OdTeam, startTime: number): Promise<Candidate[]> {
	const byId = new Map<number, number>();
	for (const entry of await findPairMatches(home.team_id, away.team_id)) byId.set(entry.matchId, entry.startTime);

	const [homeMatches, awayMatches] = await Promise.all([fetchTeamMatches(home.team_id), fetchTeamMatches(away.team_id)]);
	const awayIds = new Set(awayMatches.map((entry) => entry.matchId));
	for (const entry of homeMatches) {
		if (awayIds.has(entry.matchId)) byId.set(entry.matchId, entry.startTime);
	}

	return [...byId]
		.map(([id, time]) => ({ id, startTime: time, delta: Math.abs(time - startTime) }))
		.filter((candidate) => candidate.delta <= MATCH_WINDOW_SECONDS)
		.sort((a, b) => a.delta - b.delta);
}

/** 一场比赛的明细：STRATZ 优先，取不到才问 OpenDota。 */
async function fetchAnyDetail(matchId: number): Promise<NormalizedDraft | null> {
	const stratz = await fetchStratzMatch(matchId);
	if (stratz) return fromStratz(stratz);
	const raw = await fetchOpenDotaMatch(matchId);
	return raw ? fromOpenDota(raw) : null;
}

/** 找锚点时最多试几场：候选已按时间接近度排序，靠前的才可能是日历里的这一场。 */
const MAX_ANCHOR_ATTEMPTS = 3;

/**
 * 找出日历里这场比赛对应的 Valve 比赛，并把它所属系列的每一局都取回来。
 *
 * 两步：先定锚点（离日历开赛时间最近、且双方队伍 id 都核对上的那一局），
 * 再用锚点问 STRATZ 要整个系列的小局清单，逐局取明细。
 */
async function resolveSeries(match: EsportsMatch, heroes: Map<number, HeroInfo>): Promise<MatchSeriesDraft | null> {
	const [home, away] = await Promise.all([resolveTeam(match.home), resolveTeam(match.away)]);
	if (!home || !away) return null;

	const candidates = await findCandidates(home, away, match.startTime);

	/** 已取到明细的小局，key 是 Valve 比赛 id。 */
	const details = new Map<number, NormalizedDraft>();
	let anchor: Candidate | null = null;

	for (const candidate of candidates.slice(0, MAX_ANCHOR_ATTEMPTS)) {
		const detail = await fetchAnyDetail(candidate.id);
		if (!detail) continue;
		if (Math.abs(detail.startTime - match.startTime) > MATCH_WINDOW_SECONDS) continue;
		if (!coversBothTeams(detail, home.team_id, away.team_id)) continue;
		anchor = candidate;
		details.set(candidate.id, detail);
		break;
	}
	if (!anchor) return null;

	// 小局清单：优先用 STRATZ 的 series 关系；拿不到（不是系列赛、未配置 token、离线构建）
	// 才回落到候选里时间相近的几场。两条路都给"第几局"提供了权威位次。
	const seriesGames = await fetchSeriesGames(anchor.id);
	const ordered = seriesGames.length > 0 ? seriesGames : byStartTime(seriesNearAnchor(candidates, anchor));

	for (const { id } of ordered) {
		if (details.has(id)) continue;
		const detail = await fetchAnyDetail(id);
		// 逐局再核一次队伍：系列关系会有脏数据，宁可少展示一局也不要串队。
		if (!detail || !coversBothTeams(detail, home.team_id, away.team_id)) continue;
		details.set(id, detail);
	}

	const games = toGames(ordered, details, home.team_id, heroes);
	return games.length > 0 ? { games, total: ordered.length } : null;
}

/**
 * 本轮构建的匹配情况累计。
 * 详情页逐页调用（每次只传一场比赛），单次结果说明不了整体，
 * 所以累计到模块级再上报——最后写入的那份就是本轮的总数。
 */
let totalPlayed = 0;
let totalMatched = 0;
let totalGames = 0;
let totalGamesFromStratz = 0;
/** 第一次调用时的网络计数，用来判断本轮到底有没有真的联网抓过。 */
let fetchBaseline: number | null = null;

/**
 * 为一批比赛补齐 BP 与选手英雄。只处理已开赛/已结束的比赛（未开赛没有 BP），
 * 返回的 Map 以日历的比赛 id 为键，取不到的比赛直接没有条目。
 */
export async function loadMatchDrafts(matches: EsportsMatch[]): Promise<Map<string, MatchSeriesDraft>> {
	const out = new Map<string, MatchSeriesDraft>();
	fetchBaseline ??= stratzFetchCount() + openDotaFetchCount();
	const heroes = await getHeroMap();
	for (const match of matches) {
		if (match.status === 'upcoming') continue;
		totalPlayed += 1;
		const series = await resolveSeries(match, heroes);
		if (series) {
			out.set(match.id, series);
			totalMatched += 1;
			totalGames += series.games.length;
			totalGamesFromStratz += series.games.filter((game) => game.source === 'stratz').length;
		}
	}
	if (matches.some((match) => match.status !== 'upcoming')) {
		const fetched = stratzFetchCount() + openDotaFetchCount() > fetchBaseline;
		await reportSource(
			'drafts',
			'比赛阵容与 BP',
			totalMatched === 0 ? 'empty' : fetched ? 'fresh' : 'cache',
			`${totalPlayed} 场已开赛比赛匹配到 ${totalMatched} 个系列、共 ${totalGames} 小局（STRATZ ${totalGamesFromStratz} 小局）`,
		);
	}
	return out;
}
