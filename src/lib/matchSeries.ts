import type { HeroInfo } from './opendota';

/**
 * 对阵页的"小局"模型与纯逻辑。
 *
 * 日历上的一条是系列（BO3/BO5），而 Valve 的每个比赛 id 只对应其中一局，所以展示与
 * 取数是两个粒度。这里放前者——不碰网络、不碰缓存，只做"哪几局算一个系列""每局怎么按
 * 主客队摆"这类判断，好让 `scripts/matchSeries.check.ts` 直接钉住它们：
 * 这几处错了不会抛异常，只会安静地把某一局的数据挂到别的局上。
 *
 * 取数（队伍解析、候选、小局明细）在 `matchDraft.ts`。
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
	/** 是否属于日历上的主队。 */
	home: boolean;
	kills: number;
	deaths: number;
	assists: number;
}

/** 系列里的一局。 */
export interface MatchDraftGame {
	/**
	 * 在系列里是第几局，从 1 开始。它来自系列的小局清单，不是"有数据的局"里的次序：
	 * 中间某局取不到明细时会被跳过，后面几局的局号留在原位。
	 */
	ordinal: number;
	/** 该小局对应的 Valve 比赛 id，用于外链。 */
	matchId: number;
	startTime: number;
	/** 时长（秒）；拿不到时为 0。 */
	duration: number;
	/** 该局胜者，按主客队视角给出；未解析或取不到时为 null。 */
	winner: 'home' | 'away' | null;
	/** 明细来自哪个源，页面据此标注出处。 */
	source: 'stratz' | 'opendota';
	picks: MatchDraftHero[];
	bans: MatchDraftHero[];
	players: MatchDraftPlayer[];
}

/** 一个系列的全部小局，**按开始时间正序**——页面上的"第 1 局"就是 `games[0]`。 */
export interface MatchSeriesDraft {
	games: MatchDraftGame[];
	/** 这个系列已知有几局。可能大于 `games.length`：取不到明细的局不在 `games` 里，但位置要留着。 */
	total: number;
}

/** 两个源统一成同一份中间结构后再对齐主客队。 */
export interface NormalizedDraft {
	matchId: number;
	startTime: number;
	duration: number;
	radiantWin: boolean | null;
	radiantTeamId: number | null;
	direTeamId: number | null;
	source: MatchDraftGame['source'];
	picksBans: { heroId: number; isPick: boolean; order: number; isRadiant: boolean }[];
	players: { heroId: number; name: string; isRadiant: boolean; kills: number; deaths: number; assists: number }[];
}

/** 候选就是"这两支队伍在日历时间附近的比赛"，按时间接近度排序后交给调用方。 */
export interface Candidate {
	id: number;
	startTime: number;
	delta: number;
}

/**
 * 主客队对齐：把"天辉赢了"翻译成"主队赢了"。
 *
 * 天辉/夜魇与主客队是两回事（日历上的主队不一定在天辉），所以胜者要按队伍 id 换算，
 * 不能直接拿 radiantWin 去标记比分。
 */
export function winnerSide(radiantWin: boolean | null, homeIsRadiant: boolean): MatchDraftGame['winner'] {
	if (radiantWin === null) return null;
	return radiantWin === homeIsRadiant ? 'home' : 'away';
}

/**
 * 这一局是不是这两支队伍在打。
 *
 * 两个源的队名写法可能不同（NaVi / Natus Vincere），按名字比会误判，只能靠队伍 id。
 * 缺 id 的一侧一律判定为"不是"，免得把无关比赛并进系列。
 */
export function coversBothTeams(
	detail: Pick<NormalizedDraft, 'radiantTeamId' | 'direTeamId'>,
	homeTeamId: number,
	awayTeamId: number,
): boolean {
	const ids = new Set([detail.radiantTeamId, detail.direTeamId]);
	return ids.has(homeTeamId) && ids.has(awayTeamId);
}

/**
 * 小局按开始时间正序。
 *
 * STRATZ 的 `series.matches` 是**倒序**给的（最新一局在最前），直接用会让页面上的
 * "第 1 局"变成决胜局；候选列表的顺序也没有保证。所以一律在这里排一次。
 */
export function byStartTime<T extends { startTime: number }>(games: T[]): T[] {
	return [...games].sort((a, b) => a.startTime - b.startTime);
}

/** 同一个系列里相邻两局的间隔通常不超过几小时，用它给"拿不到 series 关系"的情况兜底。 */
export const SERIES_WINDOW_SECONDS = 6 * 3600;

/**
 * 拿不到 STRATZ 的 series 关系时，从候选里圈出同一系列的小局：锚点前后
 * {@link SERIES_WINDOW_SECONDS} 以内的都算。返回候选本身（而不只是 id），
 * 调用方还要用它们的开始时间排顺序、算局号。
 *
 * 这条路径只在 STRATZ 不可用时走到，所以放宽到 6 小时；再宽（比如铺满 12 小时的候选窗口）
 * 就有把同一天两轮比赛并成一个系列的风险。
 */
export function seriesNearAnchor(candidates: Candidate[], anchor: Candidate, window = SERIES_WINDOW_SECONDS): Candidate[] {
	const byId = new Map<number, Candidate>([[anchor.id, anchor]]);
	for (const candidate of candidates) {
		if (Math.abs(candidate.startTime - anchor.startTime) <= window) byId.set(candidate.id, candidate);
	}
	return [...byId.values()];
}

/**
 * 中间结构 → 页面要的每局数据：BP 与选手都按日历的主客队分到 0 / 1 两侧。
 *
 * `homeIsRadiant` 由调用方用队伍 id 算出来（主队这一局在天辉还是夜魇），这里只做投影；
 * 一局既没有 BP 也没有选手时返回 null——没有内容的局不占页面位置。
 */
function toDraft(
	detail: NormalizedDraft,
	homeIsRadiant: boolean,
	heroes: Map<number, HeroInfo>,
): Omit<MatchDraftGame, 'ordinal'> | null {
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

	if (picks.length === 0 && players.length === 0) return null;

	return {
		matchId: detail.matchId,
		startTime: detail.startTime,
		duration: detail.duration,
		winner: winnerSide(detail.radiantWin, homeIsRadiant),
		source: detail.source,
		picks,
		bans,
		players,
	};
}

/**
 * 按系列的**权威位次**把已取到明细的小局摆成页面数组。
 *
 * "第几局"来自 `ordered`（系列的小局清单，已按开始时间正序），不是过滤后的数组下标：
 * 中间某局取不到明细时会被跳过，但后面那几局的局号必须留在原位——否则三局系列缺了第 2 局，
 * 第 3 局会显示成"第 2 局"，读者又一次分不清自己看的是哪一局。
 */
export function toGames(
	ordered: { id: number }[],
	details: Map<number, NormalizedDraft>,
	homeTeamId: number,
	heroes: Map<number, HeroInfo>,
): MatchDraftGame[] {
	const games: MatchDraftGame[] = [];
	for (const [index, entry] of ordered.entries()) {
		const detail = details.get(entry.id);
		if (!detail) continue;
		const game = toDraft(detail, detail.radiantTeamId === homeTeamId, heroes);
		if (game) games.push({ ...game, ordinal: index + 1 });
	}
	return games;
}
