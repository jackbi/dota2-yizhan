import type { EsportsMatch } from '../data/types';
import { getTournaments } from './tournamentsApi';

/**
 * 详情页索引。
 *
 * 比赛与队伍详情都不再请求外部接口：超凡只提供赛事日历，没有可用的比赛/队伍详情
 * 接口，所以详情页统一基于一次构建拿到的 bundle 做聚合。
 */
export interface TournamentIndex {
	/** 可渲染详情页的比赛，按开赛时间倒序。 */
	matchList: EsportsMatch[];
	/** 真正存在详情页的赛事 id，用于避免链接到不存在的路由。 */
	eventIds: Set<string>;
}

async function buildIndex(): Promise<TournamentIndex> {
	const bundle = await getTournaments();
	const matches = new Map<string, EsportsMatch>();

	const add = (match: EsportsMatch) => {
		if (!matches.has(match.id)) matches.set(match.id, match);
	};

	for (const event of bundle.events) {
		for (const match of event.matches) add(match);
	}
	// OpenDota 的实时对局可能不属于任何赛事，同样需要详情页承接列表页的链接。
	for (const match of bundle.live) add(match);

	return {
		matchList: [...matches.values()].sort((a, b) => b.startTime - a.startTime),
		eventIds: new Set(bundle.events.map((event) => event.id)),
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
