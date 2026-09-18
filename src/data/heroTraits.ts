/**
 * 体系与清场能力的人工标注。
 *
 * 为什么这两类要人写：官方 datafeed 只给 9 个角色标签（核心/辅助/爆发/控制/打野/耐久/逃生/
 * 推进/先手），没有"幻象与召唤体系"和"清幻象的 AoE"这两类；
 * STRATZ 的分位统计里倒是有 stunDuration / castDamage / cs 这些字段，但实测单位对不上
 * （沙王三号位场均眩晕 1.1 秒、陈在单场里"减速 5925 秒"），拿它打分只会得到看着很专业、
 * 实际没意义的结果，所以宁可用一张能被人一眼看懂的名单。
 *
 * 名单按**英雄中文名**写，构建期与英雄表对账：对不上的名字会写进数据源日志，
 * 不会静默丢掉（改名或错别字都能被发现）。每次版本大改后需要有人过一眼。
 */

/** 会大量产生幻象或召唤物的英雄（对面有这些，就需要清场能力）。 */
export const SUMMON_ILLUSION_NAMES = [
	'幻影长矛手',
	'混沌骑士',
	'娜迦海妖',
	'天穹守望者',
	'米波',
	'育母蜘蛛',
	'陈',
	'兽王',
	// 站内用的是官方中文名"自然先知"，别写成社区惯称的"先知"（那是另一层意思，
	// 而且名字对不上会在构建日志里报出来）。
	'自然先知',
	'维萨吉',
	'狼人',
	'谜团',
	'不朽尸王',
	'剧毒术士',
];

/** 有稳定 AoE、清幻象与清兵都靠得住的英雄。 */
export const AOE_CLEAR_NAMES = [
	// 同理：官方中文名是"撼地者"。
	'撼地者',
	'沙王',
	'潮汐猎人',
	'谜团',
	'巫妖',
	'光之守卫',
	'莉娜',
	'宙斯',
	'术士',
	'伐木机',
	'钢背兽',
	'死亡先知',
	'昆卡',
	'蝙蝠骑士',
	'灰烬之灵',
	'帕格纳',
	'电炎绝手',
	'大地之灵',
];

export interface ResolvedNames {
	ids: Set<number>;
	/** 没能和英雄表对上的名字，写进数据源日志。 */
	missing: string[];
}

/**
 * 把名单解析成英雄 id。只认中文名精确匹配：模糊匹配会在英雄改名时悄悄指错人，
 * 宁可让它出现在 missing 里让人来看。
 */
export function resolveHeroNames(names: readonly string[], heroes: readonly { id: number; name: string }[]): ResolvedNames {
	const byName = new Map(heroes.map((hero) => [hero.name, hero.id]));
	const ids = new Set<number>();
	const missing: string[] = [];
	for (const name of names) {
		const id = byName.get(name);
		if (typeof id === 'number') ids.add(id);
		else missing.push(name);
	}
	return { ids, missing };
}
