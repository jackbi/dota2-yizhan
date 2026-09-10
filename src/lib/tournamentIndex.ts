import type { EsportsEvent, EsportsMatch, MatchStatus, TeamRef } from '../data/types';
import { getTournaments } from './tournamentsApi';

/**
 * 详情页索引。
 *
 * 比赛与队伍详情都不再请求外部接口：超凡只提供赛事日历，没有可用的比赛/队伍详情
 * 接口，所以详情页统一基于一次构建拿到的 bundle 做聚合。
 */

/** 队伍页用到的赛事摘要，不含对阵，避免 props 体积随赛事规模膨胀。 */
export interface TeamEventRef {
	id: string;
	name: string;
	status: MatchStatus;
	startTime: number;
	endTime: number;
}

export interface TeamDetail {
	id: string;
	name: string;
	logo?: string;
	/** 已完赛对阵中的胜/负场次；延期与未开赛不计入。 */
	wins: number;
	losses: number;
	/** 全部对阵，按开赛时间倒序。 */
	matches: EsportsMatch[];
	/** 参加过的赛事，按开赛时间倒序。 */
	events: TeamEventRef[];
}

export interface TournamentIndex {
	/** 可渲染详情页的比赛，按开赛时间倒序。 */
	matchList: EsportsMatch[];
	/** 真正存在详情页的赛事 id，用于避免链接到不存在的路由。 */
	eventIds: Set<string>;
	/** 可渲染详情页的队伍，key 为队伍 id。 */
	teams: Map<string, TeamDetail>;
}

async function buildIndex(): Promise<TournamentIndex> {
	const bundle = await getTournaments();
	const matches = new Map<string, EsportsMatch>();
	const teams = new Map<string, TeamDetail>();

	const touchTeam = (team: TeamRef, event?: TeamEventRef): TeamDetail => {
		let entry = teams.get(team.id);
		if (!entry) {
			entry = { id: team.id, name: team.name, logo: team.logo, wins: 0, losses: 0, matches: [], events: [] };
			teams.set(team.id, entry);
		}
		if (!entry.logo && team.logo) entry.logo = team.logo;
		if (event && !entry.events.some((e) => e.id === event.id)) entry.events.push(event);
		return entry;
	};

	const add = (match: EsportsMatch, event?: EsportsEvent) => {
		if (matches.has(match.id)) return;
		matches.set(match.id, match);

		const eventRef: TeamEventRef | undefined = event
			? { id: event.id, name: event.name, status: event.status, startTime: event.startTime, endTime: event.endTime }
			: undefined;
		const home = touchTeam(match.home, eventRef);
		const away = touchTeam(match.away, eventRef);
		home.matches.push(match);
		if (away.id !== home.id) away.matches.push(match);

		if (match.status === 'completed' && match.winner && home.id !== away.id) {
			if (match.winner === 'home') {
				home.wins += 1;
				away.losses += 1;
			} else {
				away.wins += 1;
				home.losses += 1;
			}
		}
	};

	for (const event of bundle.events) {
		for (const match of event.matches) add(match, event);
	}
	// OpenDota 的实时对局可能不属于任何赛事，同样需要详情页承接列表页的链接。
	for (const match of bundle.live) add(match);

	for (const team of teams.values()) {
		team.matches.sort((a, b) => b.startTime - a.startTime);
		team.events.sort((a, b) => b.startTime - a.startTime);
	}

	return {
		matchList: [...matches.values()].sort((a, b) => b.startTime - a.startTime),
		eventIds: new Set(bundle.events.map((event) => event.id)),
		teams,
	};
}

let indexPromise: Promise<TournamentIndex> | null = null;

/** 与 getTournaments 一致做单飞：多个路由的 getStaticPaths 共用一次聚合结果。 */
export function getTournamentIndex(): Promise<TournamentIndex> {
	indexPromise ??= buildIndex();
	return indexPromise;
}

/** 同赛事的其他对阵，优先取开赛时间最接近的几场。 */
export function relatedMatches(match: EsportsMatch, list: EsportsMatch[], limit = 6): EsportsMatch[] {
	return list
		.filter((m) => m.id !== match.id && m.eventId === match.eventId)
		.sort((a, b) => Math.abs(a.startTime - match.startTime) - Math.abs(b.startTime - match.startTime))
		.slice(0, limit);
}

/** 两队在当前数据窗口内的交手记录，按开赛时间倒序。 */
export function headToHead(match: EsportsMatch, list: EsportsMatch[], limit = 6): EsportsMatch[] {
	const teamIds = new Set([match.home.id, match.away.id]);
	return list
		.filter(
			(m) =>
				m.id !== match.id &&
				m.home.id !== m.away.id &&
				teamIds.has(m.home.id) &&
				teamIds.has(m.away.id),
		)
		.sort((a, b) => b.startTime - a.startTime)
		.slice(0, limit);
}
