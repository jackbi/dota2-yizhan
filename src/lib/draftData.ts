import { fetchHeroList } from './heroApi';
import { reportSource } from './dataHealth';
import { fetchProHeroStats, getHeroMap, openDotaFetchCount } from './opendota';
import { HERO_META_BRACKET_LABEL, HERO_META_WINDOW_DAYS, fetchHeroMeta, stratzFetchCount } from './stratzApi';

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
}

export interface DraftData {
	updatedAt: string;
	/** 号位胜率的口径说明，直接展示在页面上。 */
	bracketLabel: string;
	windowDays: number;
	minPositionMatches: number;
	heroes: DraftHero[];
	/** 职业样本总量，页面上用来说明"这点样本只能当热度看"。 */
	proSample: { picks: number; bans: number };
	/** 两类数据的可用性，缺哪一类界面上就少一类建议依据。 */
	hasPositionData: boolean;
	hasProData: boolean;
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
		const [heroList, meta, proStats] = await Promise.all([
			fetchHeroList().catch(() => []),
			fetchHeroMeta(),
			fetchProHeroStats(),
		]);

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
			return {
				id: hero.id,
				name: hero.name,
				nameEn: hero.nameEn,
				attr: hero.attr,
				img: hero.img,
				positions,
				pro: pro ? [pro.picks, pro.wins, pro.bans] : [0, 0, 0],
			};
		});

		const hasPositionData = heroes.some((hero) => hero.positions.some((cell) => cell !== null));
		const hasProData = proPicks > 0 || proBans > 0;
		const fetched = stratzFetchCount() + openDotaFetchCount() > before;

		await reportSource(
			'draft-data',
			'阵容分析数据',
			// 一份英雄都拿不到才算空；其余按"这轮有没有真的联网抓过"区分新数据与缓存，
			// 不按有没有号位样本来判断——那会把"吃了缓存"说成"新抓的"。
			heroes.length === 0 ? 'empty' : fetched ? 'fresh' : 'cache',
			`${heroes.length} 个英雄；号位样本${hasPositionData ? '可用' : '缺失'}；职业样本 ${proPicks} 出场 / ${proBans} 被禁`,
		);

		return {
			updatedAt: new Date().toISOString(),
			bracketLabel: HERO_META_BRACKET_LABEL,
			windowDays: HERO_META_WINDOW_DAYS,
			minPositionMatches: MIN_POSITION_MATCHES,
			heroes,
			proSample: { picks: proPicks, bans: proBans },
			hasPositionData,
			hasProData,
		};
	})();
	return dataPromise;
}
