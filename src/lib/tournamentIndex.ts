import type { EsportsEvent, EsportsMatch, MatchStatus, TeamRef } from '../data/types';
import { fetchLiquipediaPlayerIds, fetchLiquipediaTeamRosters } from './liquipediaApi';
import type { TeamRoster } from './liquipediaParse';
import { loadPlayerHeroPools } from './playerHeroes';
import { getTeamPortal } from './teamPortal';
import { getTournaments } from './tournamentsApi';

/**
 * 详情页索引。
 *
 * 比赛与队伍详情都不再请求外部接口：日历源只提供赛程，没有可用的比赛/队伍详情
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
	/** Liquipedia 页面标题；取名单要用它。OpenDota 兜底来的队伍没有。 */
	wiki?: string;
	/** 现役名单；取不到时缺省，页面显示"暂无名单"。 */
	roster?: TeamRoster;
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
	/**
	 * Liquipedia 门户的地区分区（战队名录的骨架），每区是一串队伍 id。
	 * 门户抓不到时是空数组，页面退回"窗口里出现过的队伍"单列一区。
	 */
	regions: TournamentRegionRef[];
	/** 在门户任何地区里出现过的队伍 id；`regions` 为空时也是空集。 */
	portalIds: Set<string>;
}

/** 门户的一个地区区块。队伍顺序就是门户上的顺序。 */
export interface TournamentRegionRef {
	key: string;
	label: string;
	teamIds: string[];
}

async function buildIndex(): Promise<TournamentIndex> {
	const bundle = await getTournaments();
	const matches = new Map<string, EsportsMatch>();
	const teams = new Map<string, TeamDetail>();

	const touchTeam = (team: TeamRef, event?: TeamEventRef): TeamDetail => {
		let entry = teams.get(team.id);
		if (!entry) {
			entry = { id: team.id, name: team.name, logo: team.logo, wiki: team.wiki, wins: 0, losses: 0, matches: [], events: [] };
			teams.set(team.id, entry);
		}
		if (!entry.logo && team.logo) entry.logo = team.logo;
		if (!entry.wiki && team.wiki) entry.wiki = team.wiki;
		if (event && !entry.events.some((e) => e.id === event.id)) entry.events.push(event);
		return entry;
	};

	const add = (match: EsportsMatch, event?: EsportsEvent) => {
		if (matches.has(match.id)) return;
		matches.set(match.id, match);

		const eventRef: TeamEventRef | undefined = event
			? {
					id: event.id,
					name: event.name,
					status: event.status,
					startTime: event.startTime,
					endTime: event.endTime,
				}
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

	/*
	 * 门户里那些**这几届赛事没出现过**的队伍也要进索引：它们没有战绩，但有队标、名单与招牌英雄，
	 * 页面照样成立（`/teams/[id]` 靠这份索引生成静态路径）。反过来，窗口里出现过、门户没收录的
	 * 队伍留在索引里不动，由页面放进最后那个「其他」区块——名录换了主来源，但不该让已有的队伍页
	 * 从站上消失（对阵页、赛事页都还链着它们）。
	 */
	const portal = await getTeamPortal();
	const regions: TournamentRegionRef[] = [];
	const portalIds = new Set<string>();
	for (const region of portal) {
		const teamIds: string[] = [];
		for (const team of region.teams) {
			const entry = teams.get(team.id);
			if (entry) {
				// 窗口里那份有比赛数据，只补它缺的字段；名字与队标以已经有数据的那份为准。
				if (!entry.logo && team.logo) entry.logo = team.logo;
				if (!entry.wiki) entry.wiki = team.wiki;
			} else {
				teams.set(team.id, { id: team.id, name: team.name, logo: team.logo, wiki: team.wiki, wins: 0, losses: 0, matches: [], events: [] });
			}
			teamIds.push(team.id);
			portalIds.add(team.id);
		}
		if (teamIds.length > 0) regions.push({ key: region.key, label: region.label, teamIds });
	}

	/*
	 * 战队名单：**一次取全**。`fetchLiquipediaTeamRosters` 内部按 50 个标题一批请求，
	 * 几十支队两批就够；每支队各取一次会变成几十个请求，而 Liquipedia 的条款要求低频调用。
	 * 拿不到（页面没收录、或这一轮上游抖动）就是没有名单，页面照常渲染。
	 */
	const rosters = await fetchLiquipediaTeamRosters(
		[...teams.values()].map((team) => team.wiki).filter((wiki): wiki is string => !!wiki),
	);
	for (const team of teams.values()) {
		if (team.wiki) team.roster = rosters.get(team.wiki);
	}

	/*
	 * 名单里的人还没有账号 id——它写在**选手页**上（`|playerid=`），所以要多取一层。
	 * 有账号才谈得上"这个人打过什么英雄"：昵称会改（实测一个账号在 Liquipedia 上叫
	 * Gotthejuice、游戏里已经叫 realm），按名字根本对不上人。
	 */
	const playerPages = [...rosters.values()].flatMap((roster) => roster.players.map((member) => member.page));
	const accountIds = await fetchLiquipediaPlayerIds(playerPages.filter((page): page is string => !!page));
	for (const roster of rosters.values()) {
		for (const member of roster.players) {
			const accountId = member.page ? accountIds.get(member.page) : undefined;
			if (accountId) member.accountId = accountId;
		}
	}

	/*
	 * 招牌英雄：按当前版本统计，样本不够就回退到近 90 天（口径会写进数据里，页面照实标）。
	 * 一位选手一个请求，靠缓存摊平——只有缓存过期的那几位会真的联网。
	 */
	const pools = await loadPlayerHeroPools(
		[...rosters.values()].flatMap((roster) => roster.players.map((member) => member.accountId ?? 0)),
	);
	for (const roster of rosters.values()) {
		for (const member of roster.players) {
			const pool = member.accountId ? pools.get(member.accountId) : undefined;
			if (pool) member.heroPool = pool;
		}
	}

	return {
		matchList: [...matches.values()].sort((a, b) => b.startTime - a.startTime),
		eventIds: new Set(bundle.events.map((event) => event.id)),
		teams,
		regions,
		portalIds,
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
