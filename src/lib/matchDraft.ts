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
import { fetchMatchDetail as fetchStratzMatch, fetchTeamMatches, stratzFetchCount } from './stratzApi';
import type { StratzMatch } from './stratzApi';

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
 * 命中不了就不展示，绝不靠队名近似去猜一场比赛。
 */

export interface MatchDraftHero {
	heroId: number;
	name: string;
	img: string;
	/** 0 = 主队，1 = 客队；已按队名对齐，不依赖天辉/夜魇。 */
	team: number;
}

export interface MatchDraftPlayer {
	heroId: number;
	heroName: string;
	heroImg: string;
	name: string;
	/** 是否属于超凡主队。 */
	home: boolean;
	kills: number;
	deaths: number;
	assists: number;
}

export interface MatchDraft {
	/** 对应的 Valve 比赛 id，用于外链。 */
	matchId: number;
	/** 明细来自哪个源，页面据此标注出处。 */
	source: 'stratz' | 'opendota';
	picks: MatchDraftHero[];
	bans: MatchDraftHero[];
	players: MatchDraftPlayer[];
}

/** 两个源统一成同一份中间结构后再对齐主客队。 */
interface NormalizedDraft {
	matchId: number;
	startTime: number;
	radiantTeamId: number | null;
	direTeamId: number | null;
	source: MatchDraft['source'];
	picksBans: { heroId: number; isPick: boolean; order: number; isRadiant: boolean }[];
	players: { heroId: number; name: string; isRadiant: boolean; kills: number; deaths: number; assists: number }[];
}

function fromStratz(detail: StratzMatch): NormalizedDraft {
	return {
		matchId: detail.matchId,
		startTime: detail.startTime,
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

function toDraft(detail: NormalizedDraft, homeIsRadiant: boolean, heroes: Map<number, HeroInfo>): MatchDraft | null {
	const sideOf = (isRadiant: boolean) => (isRadiant === homeIsRadiant ? 0 : 1);
	const heroOf = (heroId: number): HeroInfo => heroes.get(heroId) ?? { name: `英雄 #${heroId}`, img: '' };

	const picks: MatchDraftHero[] = [];
	const bans: MatchDraftHero[] = [];
	for (const entry of [...detail.picksBans].sort((a, b) => a.order - b.order)) {
		const hero = heroOf(entry.heroId);
		const item = { heroId: entry.heroId, name: hero.name, img: hero.img, team: sideOf(entry.isRadiant) };
		if (entry.isPick) picks.push(item);
		else bans.push(item);
	}

	const players = detail.players
		.filter((player) => player.heroId)
		.map((player) => {
			const hero = heroOf(player.heroId);
			return {
				heroId: player.heroId,
				heroName: hero.name,
				heroImg: hero.img,
				name: player.name || '匿名选手',
				home: sideOf(player.isRadiant) === 0,
				kills: player.kills,
				deaths: player.deaths,
				assists: player.assists,
			};
		})
		.sort((a, b) => Number(b.home) - Number(a.home) || b.kills - a.kills);

	return picks.length > 0 || players.length > 0 ? { matchId: detail.matchId, source: detail.source, picks, bans, players } : null;
}

interface Candidate {
	id: number;
	startTime: number;
	delta: number;
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

/**
 * 找出日历里这场比赛对应的 Valve 比赛：双方队伍 id 都要出现在明细里，
 * 开赛时间也要落在窗口内，避免把同一对队伍的不同场次对错。
 */
async function resolveMatch(match: EsportsMatch, heroes: Map<number, HeroInfo>): Promise<MatchDraft | null> {
	const [home, away] = await Promise.all([resolveTeam(match.home), resolveTeam(match.away)]);
	if (!home || !away) return null;

	const candidates = await findCandidates(home, away, match.startTime);
	for (const candidate of candidates.slice(0, 3)) {
		const stratz = await fetchStratzMatch(candidate.id);
		const detail = stratz ? fromStratz(stratz) : await fetchOpenDotaMatch(candidate.id).then((raw) => (raw ? fromOpenDota(raw) : null));
		if (!detail) continue;
		if (Math.abs(detail.startTime - match.startTime) > MATCH_WINDOW_SECONDS) continue;
		// 用队伍 id 校验：两个源的队名写法可能不同（NaVi / Natus Vincere），按名字比会误判。
		const ids = new Set([detail.radiantTeamId, detail.direTeamId]);
		if (!ids.has(home.team_id) || !ids.has(away.team_id)) continue;
		// 主队不一定是天辉，按队伍 id 对齐，避免两边阵容颠倒。
		return toDraft(detail, detail.radiantTeamId === home.team_id, heroes);
	}
	return null;
}

/**
 * 本轮构建的匹配情况累计。
 * 详情页逐页调用（每次只传一场比赛），单次结果说明不了整体，
 * 所以累计到模块级再上报——最后写入的那份就是本轮的总数。
 */
let totalPlayed = 0;
let totalMatched = 0;
let totalFromStratz = 0;
/** 第一次调用时的网络计数，用来判断本轮到底有没有真的联网抓过。 */
let fetchBaseline: number | null = null;

/**
 * 为一批比赛补齐 BP 与选手英雄。只处理已开赛/已结束的比赛（未开赛没有 BP），
 * 返回的 Map 以日历的比赛 id 为键，取不到的比赛直接没有条目。
 */
export async function loadMatchDrafts(matches: EsportsMatch[]): Promise<Map<string, MatchDraft>> {
	const out = new Map<string, MatchDraft>();
	fetchBaseline ??= stratzFetchCount() + openDotaFetchCount();
	const heroes = await getHeroMap();
	for (const match of matches) {
		if (match.status === 'upcoming') continue;
		totalPlayed += 1;
		const draft = await resolveMatch(match, heroes);
		if (draft) {
			out.set(match.id, draft);
			totalMatched += 1;
			if (draft.source === 'stratz') totalFromStratz += 1;
		}
	}
	if (matches.some((match) => match.status !== 'upcoming')) {
		const fetched = stratzFetchCount() + openDotaFetchCount() > fetchBaseline;
		await reportSource(
			'drafts',
			'比赛阵容与 BP',
			totalMatched === 0 ? 'empty' : fetched ? 'fresh' : 'cache',
			`${totalPlayed} 场已开赛比赛匹配到 ${totalMatched} 场 Valve 比赛（STRATZ ${totalFromStratz} 场）`,
		);
	}
	return out;
}
