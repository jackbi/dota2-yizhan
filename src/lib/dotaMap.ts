/**
 * 地图回放的底图几何与建筑坐标表。
 *
 * 坐标统一用 STRATZ `playbackData` 的口径：Valve 的 0–255 网格，**y 轴向上**，
 * 天辉基地在左下、夜魇基地在右上。渲染时再翻一次 y（见 `toCanvas`）。
 *
 * 这几张表都是**实测固化**的，不是从哪儿抄的：
 *
 * - 建筑坐标：取 4 场职业对局（9012784253 / 9012488967 / 9012656646 / 9012915370）的
 *   `buildingEvents`，按 npcId 汇总——四场完全一致（只有基地塔 25 / 35 差 1–2 格，
 *   取均值）。固化成表的好处是每场少拉 500–1000 条建筑事件，而且复盘面板能给
 *   「哪座塔倒了」配上中文名——`MatchType.towerDeaths` 只给 npcId，光看数字没人知道是什么。
 * - 路数与层数：按坐标归类。上路沿左边+上边（天辉塔 x≈76，夜魇塔 y≈81），下路沿下边+右边
 *   （天辉塔 y≈176，夜魇塔 x≈177），中路走对角线（`x + y ≈ 230`）。层数按到**本方基地**的
 *   距离排：一塔离河道最近、三塔贴着基地。塔本来就长在路边，所以这是几何事实而非猜测。
 * - 可行走区域、河与两个肉山坑：由两场比赛 4.6 万个真实英雄位置点按方位取 99 分位半径得到；
 *   肉山坑取实际出现过的两处落点——7.33 起肉山在河两端的两坑之间来回走，所以是两点不是一点。
 *
 * 这张底图是**按真实坐标画的示意图，不是游戏内地图贴图**：Valve / STRATZ / OpenDota 的
 * 常见小地图路径实测全是 404，自己画既避开了版本化图片（redota 那份 20MB），也不必让站点
 * 为了几张底图去背一套图片托管。坐标对得上，英雄轨迹与建筑就落在该在的位置上。
 */

/** 0 = 天辉，1 = 夜魇。与记分板、地图标记的配色一致。 */
export type MapSide = 0 | 1;
export type MapLane = 'top' | 'mid' | 'bottom';

export const LANE_TEXT: Record<MapLane, string> = { top: '上路', mid: '中路', bottom: '下路' };
const TIER_TEXT = { 1: '一塔', 2: '二塔', 3: '三塔' } as const;

export interface MapBuilding {
	npcId: number;
	side: MapSide;
	kind: 'tower' | 'barracks' | 'fort';
	x: number;
	y: number;
	lane: MapLane | null;
	/** 一塔离河道最近，三塔挨着本方基地。王座没有层数。 */
	tier: 1 | 2 | 3 | null;
}

export const MAP_BUILDINGS: MapBuilding[] = [
	// ---------------------------------------------------------------- 天辉
	{ npcId: 16, side: 0, kind: 'tower', x: 78, y: 142, lane: 'top', tier: 1 },
	{ npcId: 19, side: 0, kind: 'tower', x: 76, y: 120, lane: 'top', tier: 2 },
	{ npcId: 22, side: 0, kind: 'tower', x: 76, y: 100, lane: 'top', tier: 3 },
	{ npcId: 17, side: 0, kind: 'tower', x: 114, y: 116, lane: 'mid', tier: 1 },
	{ npcId: 20, side: 0, kind: 'tower', x: 102, y: 104, lane: 'mid', tier: 2 },
	{ npcId: 23, side: 0, kind: 'tower', x: 90, y: 94, lane: 'mid', tier: 3 },
	{ npcId: 18, side: 0, kind: 'tower', x: 164, y: 78, lane: 'bottom', tier: 1 },
	{ npcId: 21, side: 0, kind: 'tower', x: 124, y: 78, lane: 'bottom', tier: 2 },
	{ npcId: 24, side: 0, kind: 'tower', x: 96, y: 80, lane: 'bottom', tier: 3 },
	{ npcId: 25, side: 0, kind: 'tower', x: 83, y: 88, lane: null, tier: null },
	{ npcId: 38, side: 0, kind: 'barracks', x: 78, y: 98, lane: 'top', tier: null },
	{ npcId: 41, side: 0, kind: 'barracks', x: 74, y: 98, lane: 'top', tier: null },
	{ npcId: 39, side: 0, kind: 'barracks', x: 90, y: 92, lane: 'mid', tier: null },
	{ npcId: 42, side: 0, kind: 'barracks', x: 88, y: 94, lane: 'mid', tier: null },
	{ npcId: 40, side: 0, kind: 'barracks', x: 94, y: 78, lane: 'bottom', tier: null },
	{ npcId: 43, side: 0, kind: 'barracks', x: 94, y: 82, lane: 'bottom', tier: null },
	{ npcId: 50, side: 0, kind: 'fort', x: 80, y: 86, lane: null, tier: null },
	// ---------------------------------------------------------------- 夜魇
	{ npcId: 26, side: 1, kind: 'tower', x: 86, y: 174, lane: 'top', tier: 1 },
	{ npcId: 29, side: 1, kind: 'tower', x: 126, y: 174, lane: 'top', tier: 2 },
	{ npcId: 32, side: 1, kind: 'tower', x: 154, y: 172, lane: 'top', tier: 3 },
	{ npcId: 27, side: 1, kind: 'tower', x: 132, y: 132, lane: 'mid', tier: 1 },
	{ npcId: 30, side: 1, kind: 'tower', x: 146, y: 144, lane: 'mid', tier: 2 },
	{ npcId: 33, side: 1, kind: 'tower', x: 160, y: 156, lane: 'mid', tier: 3 },
	{ npcId: 28, side: 1, kind: 'tower', x: 176, y: 110, lane: 'bottom', tier: 1 },
	{ npcId: 31, side: 1, kind: 'tower', x: 178, y: 130, lane: 'bottom', tier: 2 },
	{ npcId: 34, side: 1, kind: 'tower', x: 176, y: 150, lane: 'bottom', tier: 3 },
	{ npcId: 35, side: 1, kind: 'tower', x: 167, y: 163, lane: null, tier: null },
	{ npcId: 44, side: 1, kind: 'barracks', x: 158, y: 170, lane: 'top', tier: null },
	{ npcId: 47, side: 1, kind: 'barracks', x: 158, y: 174, lane: 'top', tier: null },
	{ npcId: 45, side: 1, kind: 'barracks', x: 164, y: 156, lane: 'mid', tier: null },
	{ npcId: 48, side: 1, kind: 'barracks', x: 160, y: 160, lane: 'mid', tier: null },
	{ npcId: 46, side: 1, kind: 'barracks', x: 178, y: 154, lane: 'bottom', tier: null },
	{ npcId: 49, side: 1, kind: 'barracks', x: 174, y: 154, lane: 'bottom', tier: null },
	{ npcId: 51, side: 1, kind: 'fort', x: 170, y: 166, lane: null, tier: null },
];

const BUILDING_BY_NPC = new Map(MAP_BUILDINGS.map((building) => [building.npcId, building]));

/**
 * 只能给名字、给不出坐标的建筑。
 *
 * 每方有**两座**基地塔，但 `buildingEvents` 里始终只出现过一座（25 / 35）——另一座在采样的
 * 4 场里从没被记录过坐标。它却真的会在推基地时倒塌（推塔事件里出现过 36 / 37），所以：
 * 文案照给，地图上不画，免得凭空捏一个坐标。
 */
const LABEL_ONLY: Record<number, string> = {
	36: '天辉基地塔',
	37: '夜魇基地塔',
};

/** npcId → 中文名；认不出的返回 null，调用方退回「建筑 #id」。 */
export function buildingLabel(npcId: number): string | null {
	const building = BUILDING_BY_NPC.get(npcId);
	if (!building) return LABEL_ONLY[npcId] ?? null;
	const side = building.side === 0 ? '天辉' : '夜魇';
	if (building.kind === 'fort') return `${side}王座`;
	if (building.kind === 'barracks') return `${side}${LANE_TEXT[building.lane ?? 'mid']}兵营`;
	if (building.lane === null || building.tier === null) return `${side}基地塔`;
	return `${side}${LANE_TEXT[building.lane]}${TIER_TEXT[building.tier]}`;
}

/** 三路的中心线，按建筑坐标连出来：上路走左边+上边，下路走下边+右边，中路是对角线。 */
export const LANE_PATHS: Record<MapLane, [number, number][]> = {
	top: [
		[80, 86],
		[76, 100],
		[76, 120],
		[78, 142],
		[78, 168],
		[86, 174],
		[126, 174],
		[154, 172],
		[170, 166],
	],
	mid: [
		[80, 86],
		[90, 94],
		[102, 104],
		[114, 116],
		[132, 132],
		[146, 144],
		[160, 156],
		[170, 166],
	],
	bottom: [
		[80, 86],
		[96, 80],
		[124, 78],
		[164, 78],
		[180, 80],
		[176, 110],
		[178, 130],
		[176, 150],
		[170, 166],
	],
};

/** 河：从左上角流到右下角，两端各有一个肉山坑（7.33 起肉山在两坑之间来回走）。 */
export const RIVER_PATH: [number, number][] = [
	[74, 176],
	[102, 146],
	[127, 127],
	[150, 106],
	[180, 74],
];

/** 两个肉山坑的实际落点（由 `roshanEvents` 里出现过的坐标聚类得到）。 */
export const ROSHAN_PITS: [number, number][] = [
	[102, 146],
	[150, 106],
];

/**
 * 可行走区域的外框：10 万分位以上的位置点都落在这个范围内，四角是圆的——
 * 实测各方位 99 分位半径在正方向约 63 格、对角方向约 78 格，所以是个圆角方形而不是矩形。
 */
export const PLAYFIELD = { x0: 58, y0: 58, x1: 197, y1: 197, radius: 30 };

/** 坐标空间边长：Valve 的网格是 0–255。 */
export const GRID_SIZE = 255;

/**
 * 每方塔与兵营的总数，用来把「还剩 9 座塔」说成「还剩 9 / 11 座」。
 *
 * 数字来自上游的位掩码宽度：`towerStatusRadiant` 满值是 11 个 1（三路各三塔 + 两座基地塔），
 * `barracksStatusRadiant` 满值是 6 个 1（三路各两座）。不是从别处抄的常量。
 */
export const TOWERS_PER_SIDE = 11;
export const BARRACKS_PER_SIDE = 6;

/**
 * 数据坐标 → 画布坐标。
 *
 * 只翻 y：Valve 的 y 轴向上（天辉在左下），画布 y 轴向下。不翻的话整张地图会上下颠倒，
 * 而「天辉在左下」是所有人看小地图的默认预期。
 */
export function toCanvas(x: number, y: number): [number, number] {
	return [x, GRID_SIZE - y];
}

/** 天辉 / 夜魇的标记色，与记分板一致。 */
export const SIDE_COLOR: [string, string] = ['#4ade80', '#f87171'];

/**
 * 眼位描点的填充色：**按真假眼分**，不按阵营分。
 *
 * 「一眼看出这是个假眼还是真眼」比「这是谁插的」更常被问——真眼要在对方假眼旁边才生效、
 * 假眼要躲着真眼插，这两种判断都只需要知道类型。插眼方改由描边色承载（见 `SIDE_COLOR`），
 * 于是两个信息都不用丢。认不出的类型按假眼上色。
 */
export function wardKindColor(kind: string | null | undefined): string {
	return kind === 'SENTRY' ? '#38bdf8' : '#4ade80';
}
