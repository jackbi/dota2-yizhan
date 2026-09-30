import { getTeamNameIndex, normalizeTeamName } from './opendota';
import type { RosterMember } from './liquipediaParse';
import { getTournamentIndex } from './tournamentIndex';

/**
 * 阵容分析页的两份「战队」数据：**下拉框的选项**与**每支队的名单招牌**。
 *
 * 为什么单独成一份、并在构建期把队名换好 id：
 *
 * - 页面上那两个选择框要能直接列出站内认识的队伍。以前是一行纯文本框 + 一份 `队名 → id`
 *   的词表，用户得先知道队名的**写法**（`Team Spirit` / `team spirit` / 带上后缀），
 *   输错一个字符不会报错，只会让对面那份「近期英雄偏好」永远取不回来；
 * - 名单里的招牌英雄已经按版本算好了（`playerHeroes.ts`），这份数据只在构建期拿得到，
 *   放进静态 JSON 一起发下去，浏览器就不用为它再发一次请求。
 *
 * 收录哪些队：**门户（`Portal:Teams`）里的全部**，加上窗口里出现过、且有 Liquipedia 页面的
 * 队伍（有页面才有名单）。OpenDota 实时对局里那种没有页面的临时队名不进这个列表——
 * 它们既没有名单也没有队标，出现在下拉里只是噪声。
 */

export interface DraftTeamMember {
	nick: string;
	/** 一到五号位；名单里缺省时省略，界面上按"位置不详"处理。 */
	position?: number;
	/**
	 * 这位选手招牌英雄的统计口径（`7.41f 版本` / `近 90 天`）。
	 * 全队口径一致时才会被 `buildTeamSignature` 采纳成一个版本号，所以这里要逐人带上。
	 */
	scope: string;
	heroes: { heroId: number; games: number; wins: number }[];
}

export interface DraftTeamEntry {
	/** 站内队伍 id（`lp-team-...`），与战队页、赛程页同一套。 */
	id: string;
	name: string;
	/** 已本地化的站内地址；没有队标时省略。 */
	logo?: string;
	/** OpenDota 队伍 id，运行时取"近期英雄偏好"要用；按队名定位不到时是 null。 */
	odId: number | null;
	/** 门户地区 key 与中文标签；不在门户里时都是空串（界面上归到「其他」）。 */
	region: string;
	regionLabel: string;
	/** 现役名单；取不到时是空数组。 */
	roster: DraftTeamMember[];
}

export interface DraftTeamSection {
	key: string;
	label: string;
}

export interface DraftTeamCatalog {
	/** 门户地区的顺序（下拉里的分组就按它排）。 */
	sections: DraftTeamSection[];
	teams: DraftTeamEntry[];
}

let catalogPromise: Promise<DraftTeamCatalog> | null = null;

/** 与其它数据源一致做单飞：页面与 `/draft-teams.json` 在同一次构建里共用一份。 */
export function loadDraftTeams(): Promise<DraftTeamCatalog> {
	catalogPromise ??= build();
	return catalogPromise;
}

/**
 * 招牌英雄的口径文案。
 *
 * 必须**跟着数据的实际窗口走**：`scope` 是 `patch` 时写版本号，是 `window` 时写 90 天。
 * 这两句与战队页上的标签是同一套说法（那边是 `heroScopeLabel`），同一份数据在两处
 * 不能一个写版本、一个不写。
 */
function poolScope(member: RosterMember): string {
	const pool = member.heroPool;
	if (!pool) return '';
	return pool.scope === 'patch' ? `${pool.version} 版本` : '近 90 天';
}

function toMember(member: RosterMember): DraftTeamMember | null {
	const pool = member.heroPool;
	if (!pool || pool.heroes.length === 0) return null;
	return {
		nick: member.nick,
		...(member.position ? { position: member.position } : {}),
		scope: poolScope(member),
		heroes: pool.heroes.map((stat) => ({ heroId: stat.heroId, games: stat.games, wins: stat.wins })),
	};
}

async function build(): Promise<DraftTeamCatalog> {
	const [index, nameIndex] = await Promise.all([getTournamentIndex(), getTeamNameIndex()]);
	const ids = new Map<string, number>(nameIndex);

	/** 门户里每个地区各有哪些队；同一支队只认第一次出现。 */
	const regionOf = new Map<string, { key: string; label: string }>();
	for (const region of index.regions) {
		for (const teamId of region.teamIds) {
			if (!regionOf.has(teamId)) regionOf.set(teamId, { key: region.key, label: region.label });
		}
	}

	const teams: DraftTeamEntry[] = [];
	for (const team of index.teams.values()) {
		const region = regionOf.get(team.id);
		const roster = (team.roster?.players ?? []).map(toMember).filter((member): member is DraftTeamMember => member !== null);
		/*
		 * 门户里的队一律收录（哪怕暂时没有名单）；其余必须有 **Liquipedia 页面上的名单**——
		 * 判据用名单而不是本地的招牌英雄：招牌英雄要多一次 STRATZ 请求才拿得到，拿不到是常态，
		 * 而那些队仍然是有名单的正经战队，不该因为这一项缺失就从下拉里消失。
		 * 这样滤掉的是 OpenDota 实时对局里那种没有页面的临时队名（既没名单也没队标）。
		 */
		if (!region && !(team.wiki && (team.roster?.players.length ?? 0) > 0)) continue;
		const key = normalizeTeamName(team.name);
		teams.push({
			id: team.id,
			name: team.name,
			...(team.logo ? { logo: team.logo } : {}),
			odId: ids.get(`n:${key}`) ?? ids.get(`t:${key}`) ?? null,
			region: region?.key ?? '',
			regionLabel: region?.label ?? '',
			roster,
		});
	}

	/*
	 * 排序：先按门户地区（门户里的顺序就是权威顺序），地区内按队名；不在门户里的排最后。
	 * 用 `localeCompare('en')` 而不是默认比较：队名基本都是拉丁字母，拼音化的中文排序
	 * 反而会把 `Team Spirit` 排到 `Virtus.pro` 后面。
	 */
	const regionRank = new Map(index.regions.map((region, position) => [region.key, position]));
	teams.sort((a, b) => {
		const rankA = a.region ? (regionRank.get(a.region) ?? Number.MAX_SAFE_INTEGER) : Number.MAX_SAFE_INTEGER;
		const rankB = b.region ? (regionRank.get(b.region) ?? Number.MAX_SAFE_INTEGER) : Number.MAX_SAFE_INTEGER;
		return rankA - rankB || a.name.localeCompare(b.name, 'en');
	});

	return {
		sections: index.regions.map((region) => ({ key: region.key, label: region.label })),
		teams,
	};
}
