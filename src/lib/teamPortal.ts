import { fetchLiquipediaTeamPortal } from './liquipediaApi';
import { liquipediaTeamId } from './liquipediaParse';
import { teamRegionLabel } from './teamRegions';
import { localizeTeamLogos } from './teamLogos';

/**
 * 战队名录的「现在活跃的强队」名单，来自 Liquipedia 的 `Portal:Teams`。
 *
 * 为什么不继续用赛程窗口反推：窗口只覆盖我们抓的那几届赛事，谁在这几届里露过面谁就上榜，
 * 于是"打进 T1 预选赛的二线队"和"休赛期没打 T1/T2 的强队"两头都会错。门户是人工维护的，
 * 也天然按地区分好了组——这就是名录要的那个轴（理由与实测见 `liquipediaApi` 的
 * `loadTeamPortal`）。档位因此从这里退场：它继续管赛事（`/tournaments`），不再给队伍分层。
 *
 * 队标沿用赛程页那条频道（`.cache/teamlogos/` → `/teamlogos/`），只是门户给的缩略图更大
 * （它自带的 2x 档），所以门户独有队伍拿到的图比赛程页那份清楚。取不到字节就保留外链，
 * 页面上不会出现破图——和 `localizeTeamLogos()` 的约定一致。
 */

export interface TeamPortalEntry {
	/** 站内队伍 id，与赛程页同一套（见 `liquipediaTeamId`），这样两个来源能对上同一支队。 */
	id: string;
	name: string;
	wiki: string;
	/** 已本地化的站内地址；没取到字节时仍是 Liquipedia 外链。 */
	logo?: string;
}

export interface TeamPortalSection {
	key: string;
	label: string;
	teams: TeamPortalEntry[];
}

let portalPromise: Promise<TeamPortalSection[]> | null = null;

/**
 * 门户的地区分区。多进程下每个进程各跑一遍，靠 `fetchLiquipediaTeamPortal()` 的缓存摊平；
 * 这里再单飞一次，避免同一个进程里几个页面各下一遍队标。
 */
export function getTeamPortal(): Promise<TeamPortalSection[]> {
	portalPromise ??= loadTeamPortal();
	return portalPromise;
}

async function loadTeamPortal(): Promise<TeamPortalSection[]> {
	const regions = await fetchLiquipediaTeamPortal();
	if (regions.length === 0) return [];

	const raw = regions
		.flatMap((region) => region.teams)
		.map((team) => ({ id: liquipediaTeamId(team.wiki ?? team.name), logo: team.logo }));
	const local = await localizeTeamLogos(raw);

	/*
	 * **一个 id 只能出现在一个区块里**：门户理论上不会重复列一支队，但真重复了一支队就会出现
	 * 两张卡片、两个链接。（同一个队名在不同地区里出现也同理。）后出现的丢掉，保留先列的那次。
	 */
	const seen = new Set<string>();
	const sections: TeamPortalSection[] = [];
	for (const region of regions) {
		const teams: TeamPortalEntry[] = [];
		for (const team of region.teams) {
			const id = liquipediaTeamId(team.wiki ?? team.name);
			if (seen.has(id)) continue;
			seen.add(id);
			teams.push({ id, name: team.name, wiki: team.wiki ?? team.name, logo: local.get(id) ?? team.logo });
		}
		if (teams.length === 0) continue;
		sections.push({ key: region.key, label: teamRegionLabel(region.key, region.label), teams });
	}
	return sections;
}
