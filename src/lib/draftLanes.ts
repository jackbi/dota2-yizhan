/**
 * 线上对位：某个英雄打某个号位时，**线上**跟谁对上、净对线多少。
 *
 * 与 `draftMatchup` 的区别，这是它存在的全部理由：
 * - `draftMatchup` 是「英雄 A 对英雄 B 的**整局**胜率」，不分路——四号位对对面一号位也照样算进去；
 * - 这里是 STRATZ `heroStats.laneOutcome` 的**线上**口径：以「我打几号位」为坐标，
 *   只统计同一条线上的对手，还能順手拿到「与我同路的是谁」（`isWith: true`）。
 *
 * 口径三条，界面上与提示词里都要照实说：
 * 1. **净对线 =（线上胜 − 线上负）/ 场次**，平局不进分子。0 表示这条线打平，
 *    与「整局胜率」不是一个东西，也不能相加；
 * 2. 位置是**我方的号位**，对手的号位不由这份数据给出（同一条线上本来就可能是一打二）；
 * 3. 分段与窗口跟站内其它数据一致（超凡入圣及以上、近一周），见 `stratzApi`。
 *
 * 单独一个文件、不引任何依赖：构建期喂数据（`stratzApi`）、浏览器里算（`draftScore`、
 * `draftVerdict`）与自检脚本都要用它，放进 `stratzApi` 会把 Node 依赖带进客户端。
 */

/** 键是 `英雄id|号位|另一个英雄id`，值是 [线上场次, 净对线千分比]。 */
export type HeroLanes = Record<string, [matches: number, netPerMille: number]>;

/** 两个方向各一份：`vs` 是线上的对手，`with` 是同一条线上的搭档。 */
export interface LaneData {
	/** 线上对手。 */
	vs: HeroLanes;
	/** 同路搭档。 */
	with: HeroLanes;
}

export const LANE_POSITIONS = [1, 2, 3, 4, 5] as const;
export type LanePosition = (typeof LANE_POSITIONS)[number];

/**
 * 开局和谁走一条线（号位对号位的常规分路）：优势路是一号位 + 五号位，劣势路是三号位 + 四号位，
 * 中路一个人。
 *
 * 这只是给「同路搭档」这张表挑一个对手英雄用的**约定**，不是从数据里读出来的：
 * 换线、双辅助游走、四号位去中都很常见。所以它只在依据里当一句参考，
 * 而且线上搭档表的样本量会说话——实测五号位与四号位各有几千格，二号位只有几十格
 * （中路本来就没有固定搭档）。
 */
export const LANE_PARTNER_POSITION: Record<number, number | null> = { 1: 5, 2: null, 3: 4, 4: 3, 5: 1 };

/** 我打 `position` 号位时，常规分路上应该和我同路的是几号位；中路没有搭档，返回 null。 */
export function lanePartnerPosition(position: number): number | null {
	return LANE_PARTNER_POSITION[position] ?? null;
}

/**
 * 一格要有多少场才留。
 *
 * 线上对局的样本天然比整局小（一场只有一个线上阶段），全池 127 英雄 × 5 号位 × 126 个对手
 * 实测 79,000 多格里绝大多数是个位数；50 场以上只剩 7,600 格左右、约 0.2MB，
 * 再往下放宽只是把噪声塞进依据里。
 */
export const LANE_MIN_GAMES = 50;

/** 一格的查询结果：这条线上打过多少场、净对线多少。 */
export interface LaneCell {
	matches: number;
	/** （胜 − 负）/ 场次，−1 到 1。 */
	net: number;
}

/** 一组对位汇总：平均值、用到几格、合计多少场，以及每一格的明细。 */
export interface LaneEdge {
	/** 各格净对线的**平均**（不按场次加权，与站内其它对位口径一致）。 */
	net: number;
	pairs: number;
	/** 合计场次，用来说明这个平均值背后有多少依据。 */
	matches: number;
	/** 按场次降序的明细，调用方拿去写依据。 */
	cells: { otherId: number; net: number; matches: number }[];
}

const key = (heroId: number, position: number, otherId: number): string => `${heroId}|${position}|${otherId}`;

function cellOf(lanes: HeroLanes | undefined | null, heroId: number, position: number, otherId: number): LaneCell | null {
	if (!lanes || heroId === otherId) return null;
	const hit = lanes[key(heroId, position, otherId)];
	if (!hit || !(hit[0] > 0)) return null;
	return { matches: hit[0], net: hit[1] / 1000 };
}

/** 我打 `position` 号位时，线上对上 `otherId` 的净对线；没这一格返回 null。 */
export function laneCell(lanes: HeroLanes | undefined | null, heroId: number, position: number, otherId: number): LaneCell | null {
	return cellOf(lanes, heroId, position, otherId);
}

/**
 * 我打 `position` 号位时，线上对上一整套阵容的平均净对线。
 *
 * 与站内的对位口径一致：**取平均，不求和**——求和会把五个人的线上优势加成 ±40 个百分点，
 * 那不是任何东西的量级。
 */
export function laneEdge(lanes: HeroLanes | undefined | null, heroId: number, position: number, others: readonly number[]): LaneEdge | null {
	const found: { otherId: number; net: number; matches: number }[] = [];
	for (const other of others) {
		const cell = cellOf(lanes, heroId, position, other);
		if (cell) found.push({ otherId: other, net: cell.net, matches: cell.matches });
	}
	if (found.length === 0) return null;
	found.sort((a, b) => b.matches - a.matches);
	return {
		net: found.reduce((sum, cell) => sum + cell.net, 0) / found.length,
		pairs: found.length,
		matches: found.reduce((sum, cell) => sum + cell.matches, 0),
		cells: found,
	};
}

/** 对面阵容里的一个人：id + 他打几号位（反方向查表要用）。 */
export interface LaneOther {
	id: number;
	position: number;
}

/**
 * 双向查表：先看「我打这个号位时线上遇到他们」，没有再看反方向「他打他的号位时线上遇到我」并取反号。
 *
 * 为什么要双向：两个方向的留存率差得很远，实测经常只有一边过门槛——
 * 比如水晶室女五号位对暗影萨满，正方向（暗影萨满五号位遇到水晶室女）没有格子，
 * 反方向有 74 场。只查一边会让这条依据大半时候不出现。
 *
 * 反方向的数字要**取反**：那是同一场线上遭遇从对面视角记的一笔。两个方向都在时只用正方向，
 * 免得把同一件事数两遍。
 */
export function laneEdgeEither(lanes: HeroLanes | undefined | null, heroId: number, position: number, others: readonly LaneOther[]): LaneEdge | null {
	const forward = laneEdge(lanes, heroId, position, others.map((other) => other.id));
	if (forward) return forward;
	const found: { otherId: number; net: number; matches: number }[] = [];
	for (const other of others) {
		const cell = cellOf(lanes, other.id, other.position, heroId);
		if (cell) found.push({ otherId: other.id, net: -cell.net, matches: cell.matches });
	}
	if (found.length === 0) return null;
	found.sort((a, b) => b.matches - a.matches);
	return {
		net: found.reduce((sum, cell) => sum + cell.net, 0) / found.length,
		pairs: found.length,
		matches: found.reduce((sum, cell) => sum + cell.matches, 0),
		cells: found,
	};
}

/**
 * 把一整批 `laneOutcome` 行整理成查表。
 *
 * `isWith` 在 STRATZ 那边是一个查询参数（false = 线上的对手，true = 同路的人），
 * 行的形状一模一样，所以整理逻辑共用一份，只是落进不同的表。
 */
export interface RawLaneRow {
	heroId1?: number | null;
	heroId2?: number | null;
	position?: string | null;
	matchCount?: number | null;
	winCount?: number | null;
	lossCount?: number | null;
	/** 上游给的平局数。净对线的分子里没有它——平局只在分母（`matchCount`）里出现。 */
	drawCount?: number | null;
}

/** `POSITION_3` → 3；其它形状返回 null（上游偶尔给聚合行）。 */
/**
 * 把**一个号位切片**的行整理成查表。
 *
 * 号位由调用方给，**不看行里的 `position` 字段**：实测批量查询（不带 `heroId`）时，
 * 那个字段永远是 `POSITION_1`——按 5 号位问水晶室女会回来 8,183 场，行的 `position` 却写
 * `POSITION_1`，而按 1 号位问只有 19 场。过滤是准的，字段不能信。
 * （曾经照字段分组，结果 4,811 格全落进一号位，2–5 号位永远查不到数据。）
 */
export function buildLaneSlice(rows: readonly RawLaneRow[], position: LanePosition, minGames = LANE_MIN_GAMES): HeroLanes {
	const out: HeroLanes = {};
	for (const row of rows) {
		const heroId = row.heroId1;
		const otherId = row.heroId2;
		const matches = row.matchCount ?? 0;
		if (!heroId || !otherId || heroId === otherId) continue;
		if (matches < minGames) continue;
		const net = ((row.winCount ?? 0) - (row.lossCount ?? 0)) / matches;
		const perMille = Math.round(net * 1000);
		const id = key(heroId, position, otherId);
		// 同一格出现两次（上游把不同周或不同分段的行混在一起）时取样本大的那次。
		const existing = out[id];
		if (!existing || matches > existing[0]) out[id] = [matches, perMille];
	}
	return out;
}

/** 净对线怎么写：`+1.8%` / `−0.4%` / `0.0%`。 */
export function formatNet(net: number): string {
	const value = Math.abs(net) < 0.0005 ? 0 : net;
	const sign = value > 0 ? '+' : value < 0 ? '−' : '';
	return `${sign}${Math.abs(value * 100).toFixed(1)}%`;
}

/**
 * 一条依据：我打这个号位时，线上对上他们这套阵容平均是赢是输。
 *
 * 英雄名不在这层拼（这里不认识中文名）：调用方按 `edge.cells` 自己接名字，
 * 与 `draftScore.counterText` 同一套路。
 */
export function laneEdgeText(prefix: string, edge: LaneEdge, position: number): string {
	return `${prefix}（${position} 号位线上 ${edge.matches.toLocaleString('zh-CN')} 场、${edge.pairs} 个对手）：平均净对线 ${formatNet(edge.net)}`;
}
