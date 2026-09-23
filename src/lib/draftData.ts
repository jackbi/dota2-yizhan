import { AOE_CLEAR_NAMES, SUMMON_ILLUSION_NAMES, TEAMFIGHT_NAMES, resolveHeroNames } from '../data/heroTraits';
import { ROLE_COUNT, fetchHeroProfile } from './heroApi';
import { fetchHeroListCached } from './heroList';
import { reportSource } from './dataHealth';
import { fetchProHeroStats, getHeroMap, openDotaFetchCount } from './opendota';
import { fetchPatchUpdates } from './patchesApi';
import {
	HERO_META_BRACKET_LABEL,
	HERO_META_WINDOW_DAYS,
	MATCHUP_MIN_GAMES,
	fetchHeroMatchups,
	fetchHeroMeta,
	fetchHeroTimeline,
	stratzFetchCount,
} from './stratzApi';
import type { HeroMatchups } from './draftMatchup';
import { LANE_MIN_GAMES } from './draftLanes';

/**
 * 阵容分析要用的一份数据。
 *
 * 三种来源各管一段，缺任何一段都还能降级使用：
 * - **英雄本身**（id、中英文名、属性、头像）走官方 datafeed，站内英雄页也是这一份；
 * - **号位胜率**走 STRATZ 的高分局统计（与英雄页同一个口径），这是打分的主信号：
 *   样本够大，而且是按号位分组的；
 * - **职业热度**走 OpenDota 的职业出场与被禁场次，样本很小（见 `fetchProHeroStats` 的说明），
 *   只当旁证，界面上按实数展示，不换算成百分比。
 *
 * 故意**不引克制关系**：那要 127 个英雄逐个拉数据，构建时间不划算，而且会诱导提示词
 * 拿它编故事。等真正需要时再单独接。
 */

/**
 * 某个号位至少要有这么多场，胜率才进统计。
 *
 * 门槛取 200：高分局一周里一个英雄打某个号位通常有几百到几千场，200 场对应的胜率
 * 波动约 ±3.5 个百分点，比这个再低就纯是噪声了。页面上会把这条口径写出来。
 */
export const MIN_POSITION_MATCHES = 200;

export interface DraftHero {
	id: number;
	name: string;
	nameEn: string;
	/** STR / AGI / INT / UNI，与英雄页的属性筛选一致。 */
	attr: string;
	img: string;
	/**
	 * 每个号位的 [场次, 胜场]，索引 0 是一号位。
	 * 样本不足 `MIN_POSITION_MATCHES` 的位置为 null（例如某个英雄这周没打过三号位）。
	 */
	positions: ([number, number] | null)[];
	/** 职业样本：[出场, 取胜, 被禁]，拿不到时为 [0, 0, 0]。 */
	pro: [number, number, number];
	/**
	 * 官方角色等级（9 项，0-3），顺序见 `heroApi.ROLE_ORDER`：
	 * 核心/辅助/爆发/控制/打野/耐久/逃生/推进/先手。拿不到时是全 0。
	 */
	roles: number[];
	/** 会造幻象或召唤物（判断对面是不是体系阵容）。 */
	summon: boolean;
	/** 有稳定的 AoE 清场能力（清幻象、清兵）。 */
	aoe: boolean;
	/** 团战点：范围伤害、群体控制或无视技能免疫的团战技能（人工名单，见 heroTraits）。 */
	teamfight: boolean;
	/** 近战还是远程：全近战的阵容线上会被压，远程位要单独算。 */
	attack: 'melee' | 'ranged';
	/**
	 * 时间曲线：[打到 5 分钟时的胜率, 打到 35 分钟时的胜率]。
	 * 两个数相减就是"这个英雄越拖越强还是越拖越弱"，拿不到时是 [0, 0]。
	 */
	timeline: [number, number];
}

export interface DraftData {
	updatedAt: string;
	/** 号位胜率的口径说明，直接展示在页面上。 */
	bracketLabel: string;
	windowDays: number;
	/** 这批胜率对应的游戏版本。 */
	patch: DraftPatch;
	minPositionMatches: number;
	heroes: DraftHero[];
	/** 职业样本总量，页面上用来说明"这点样本只能当热度看"。 */
	proSample: { picks: number; bans: number };
	/** 英雄对位（克制）数据：键 `小id-大id`，值 [场次, 小 id 一方胜率]。 */
	matchups: HeroMatchups;
	/** 留存的对位数；0 表示这次没拿到，打分里就不算克制这一项。 */
	matchupPairs: number;
	/** 对位的场次门槛。页面上要把口径写出来，所以由构建期带出来，不在这里另抄一个数。 */
	matchupMinGames: number;
	/** 线上对位每格的场次门槛（记了结果的场次）。理由同上：文案里的数字只能有一处来源。 */
	laneMinGames: number;
	/** 两类数据的可用性，缺哪一类界面上就少一类建议依据。 */
	hasPositionData: boolean;
	hasProData: boolean;
}

export interface DraftPatch {
	/** 版本号，例如 `7.41f`；拿不到就是空串。 */
	version: string;
	/** 发布日期，例如 `2026-09-15`。 */
	date: string;
	/**
	 * 统计窗口里是否包含了一次版本更新。
	 *
	 * 近 7 天的样本里如果刚发过新版本，胜率就是新旧两个版本混在一起算的，这时候拿它当
	 * "当前版本的英雄强度"会看偏，所以页面上和提示词里都要把这条说出来。
	 */
	straddles: boolean;
}

let dataPromise: Promise<DraftData> | null = null;

/**
 * 组装页面数据。模块级单飞：构建期只有一个页面用它，但自检脚本与将来可能的
 * API 路由也会调，重复调用不应重复联网。
 */
export function loadDraftData(): Promise<DraftData> {
	dataPromise ??= (async () => {
		// 起点的联网计数：末尾拿它判断这一轮到底是新抓的还是吃缓存。
		const before = stratzFetchCount() + openDotaFetchCount();
		const [heroList, meta, proStats, patchList] = await Promise.all([
			fetchHeroListCached().catch(() => []),
			fetchHeroMeta(),
			fetchProHeroStats(),
			fetchPatchUpdates().catch(() => []),
		]);
		// 官方角色标签与攻击类型来自每个英雄的详情，与英雄页共用同一份去重缓存。
		const profiles = await fetchHeroProfile().catch(() => new Map());
		const timeline = await fetchHeroTimeline();

		let proPicks = 0;
		let proBans = 0;
		for (const stat of proStats.values()) {
			proPicks += stat.picks;
			proBans += stat.bans;
		}

		/**
		 * 官方 datafeed 挂了也要有英雄池：退回 OpenDota 的英雄表。
		 * 那份只有名字和头像、没有属性，所以属性一律按「全才」处理，页面上照样能录 BP。
		 */
		const base =
			heroList.length > 0
				? heroList.map((hero) => ({ id: hero.id, name: hero.name, nameEn: hero.nameEn, attr: hero.attr, img: hero.img }))
				: [...(await getHeroMap())].map(([id, info]) => ({ id, name: info.name, nameEn: info.name, attr: 'UNI', img: info.img }));

		// 人工名单与英雄表对账：对不上的名字写进日志，不静默丢掉。
		const summonNames = resolveHeroNames(SUMMON_ILLUSION_NAMES, base);
		const aoeNames = resolveHeroNames(AOE_CLEAR_NAMES, base);
		const teamfightNames = resolveHeroNames(TEAMFIGHT_NAMES, base);
		const summonIds = summonNames.ids;
		const aoeIds = aoeNames.ids;
		const teamfightIds = teamfightNames.ids;
		const missedNames = [...summonNames.missing, ...aoeNames.missing, ...teamfightNames.missing];

		const heroes: DraftHero[] = base.map((hero) => {
			const entry = meta?.heroes.get(hero.id);
			const positions: ([number, number] | null)[] = [null, null, null, null, null];
			for (const stat of entry?.positions ?? []) {
				const index = stat.position - 1;
				if (index < 0 || index > 4) continue;
				if (stat.matches < MIN_POSITION_MATCHES) continue;
				// 同一个号位出现多行时取样本大的那行，避免把两段数据加起来当成一次统计。
				const current = positions[index];
				if (!current || stat.matches > current[0]) positions[index] = [stat.matches, stat.wins];
			}
			const pro = proStats.get(hero.id);
			const profile = profiles.get(hero.id);
			return {
				id: hero.id,
				name: hero.name,
				nameEn: hero.nameEn,
				attr: hero.attr,
				img: hero.img,
				positions,
				pro: pro ? [pro.picks, pro.wins, pro.bans] : [0, 0, 0],
				roles: profile?.roles.length === ROLE_COUNT ? profile.roles : new Array(ROLE_COUNT).fill(0),
				attack: profile?.attack ?? 'melee',
				summon: summonIds.has(hero.id),
				aoe: aoeIds.has(hero.id),
				teamfight: teamfightIds.has(hero.id),
				timeline: timeline?.get(hero.id) ?? [0, 0],
			};
		});

		const hasPositionData = heroes.some((hero) => hero.positions.some((cell) => cell !== null));
		const hasProData = proPicks > 0 || proBans > 0;
		const fetched = stratzFetchCount() + openDotaFetchCount() > before;

		// 对位数据依赖英雄集合，只能等英雄表拿到之后再抓。
		const matchups = await fetchHeroMatchups(heroes.map((hero) => hero.id));

		const patch = toPatch(patchList);

		await reportSource(
			'draft-data',
			'阵容分析数据',
			// 一份英雄都拿不到才算空；其余按"这轮有没有真的联网抓过"区分新数据与缓存，
			// 不按有没有号位样本来判断——那会把"吃了缓存"说成"新抓的"。
			heroes.length === 0 ? 'empty' : fetched ? 'fresh' : 'cache',
			// 人工名单对不上的名字接在末尾：英雄改名、写错字都会落到这里。
			`${heroes.length} 个英雄；号位样本${hasPositionData ? '可用' : '缺失'}；对位 ${matchups?.pairCount ?? 0} 对；职业样本 ${proPicks} 出场 / ${proBans} 被禁；版本 ${patch.version || '未知'}` +
				(missedNames.length > 0 ? `；名单对不上：${missedNames.join('、')}` : ''),
		);

		return {
			updatedAt: new Date().toISOString(),
			bracketLabel: HERO_META_BRACKET_LABEL,
			windowDays: HERO_META_WINDOW_DAYS,
			patch,
			minPositionMatches: MIN_POSITION_MATCHES,
			heroes,
			proSample: { picks: proPicks, bans: proBans },
			matchups: matchups?.pairs ?? {},
			matchupPairs: matchups?.pairCount ?? 0,
			matchupMinGames: MATCHUP_MIN_GAMES,
			laneMinGames: LANE_MIN_GAMES,
			hasPositionData,
			hasProData,
		};
	})();
	return dataPromise;
}

/**
 * 取最新的版本号，并判断统计窗口里是不是跨了一次版本更新。
 *
 * 版本列表按时间倒序，第一条就是当前版本。`date` 是官方给的发布日（UTC 当天零点），
 * 拿不到日期时不算跨版本，因为"不知道"不该说成"跨了"。
 */
function toPatch(list: readonly { version: string; date: string }[]): DraftPatch {
	const latest = list[0];
	if (!latest) return { version: '', date: '', straddles: false };
	const releasedAt = Date.parse(`${latest.date}T00:00:00Z`);
	const straddles = Number.isFinite(releasedAt) && Date.now() - releasedAt <= HERO_META_WINDOW_DAYS * 24 * 3600 * 1000;
	return { version: latest.version, date: latest.date, straddles };
}
