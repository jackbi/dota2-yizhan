/**
 * 英雄对位数据的形状与查询。
 *
 * 单独一个文件、不引任何依赖，是因为两边都要用它：构建期在 `stratzApi` 里抓数据，
 * 浏览器里打分（`draftScore`）要用同一套口径查。放在 `stratzApi` 里的话，
 * 打分那层就会顺着它把 Node 的文件系统依赖带进客户端和自检脚本。
 */

/**
 * 英雄两两对位。键是 `小id-大id`，值是 [场次, 小 id 那一方的胜率]。
 *
 * 只存一个方向：另一方向就是它的反面（1 减胜率），存两份等于把体积翻倍。
 */
export type HeroMatchups = Record<string, [number, number]>;

/**
 * 查 a 打 b 的胜率。没有留存的对位（样本不够或接近五五开）时返回 null，
 * 调用方按"这一对没有依据"处理。
 */
export function matchupRate(matchups: HeroMatchups | undefined, a: number, b: number): { rate: number; games: number } | null {
	if (!matchups || a === b) return null;
	const [low, high] = a < b ? [a, b] : [b, a];
	const cell = matchups[`${low}-${high}`];
	if (!cell) return null;
	return { rate: a < b ? cell[1] : 1 - cell[1], games: cell[0] };
}
