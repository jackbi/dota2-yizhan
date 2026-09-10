import type { EsportsEvent, MatchStatus } from './types';

/**
 * 赛事兜底数据。
 *
 * 真实赛程由 `src/lib/tournamentsApi.ts` 在构建期抓取；当所有数据源都不可用时，
 * 赛事页会回退到这里，保证页面始终能渲染。因此这里只保留赛事名称与时间，
 * 不编造对阵和比分。
 */
interface SeedEvent {
	id: string;
	name: string;
	start: string;
	end: string;
}

const SEED: SeedEvent[] = [
	{ id: 'ti26', name: 'The International 2026', start: '2026-10-12', end: '2026-10-30' },
	{ id: 'esl-one', name: 'ESL One 秋季总决赛', start: '2026-09-04', end: '2026-09-08' },
	{ id: 'cac', name: '中国 DOTA2 超级联赛', start: '2026-09-15', end: '2026-09-22' },
	{ id: 'dreamleague', name: '梦幻联赛 S26', start: '2026-08-20', end: '2026-08-31' },
	{ id: 'pgl-major', name: 'PGL 瓦拉几亚 Major', start: '2026-07-11', end: '2026-07-18' },
];

/** 把 「YYYY-MM-DD」 按东八区解析成 Unix 秒。 */
function toUnix(date: string): number {
	return Math.floor(Date.parse(`${date}T00:00:00+08:00`) / 1000);
}

function statusOf(startTime: number, endTime: number, now: number): MatchStatus {
	if (now < startTime) return 'upcoming';
	if (now > endTime + 86_400) return 'completed';
	return 'live';
}

export function seedEvents(now = Date.now()): EsportsEvent[] {
	const nowSec = Math.floor(now / 1000);
	return SEED.map((item) => {
		const startTime = toUnix(item.start);
		const endTime = toUnix(item.end);
		return {
			id: `seed-${item.id}`,
			name: item.name,
			status: statusOf(startTime, endTime, nowSec),
			startTime,
			endTime,
			matches: [],
			teams: [],
			source: 'seed' as const,
		};
	});
}
