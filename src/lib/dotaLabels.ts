/**
 * Dota 的枚举与中文标签。
 *
 * 这里的映射是**两套 key 并存**：比赛明细接口回的是字符串枚举（`gameMode: "TURBO"`），
 * 而聚合接口回的是 Valve 的数字 id（`gameMode: 23`）。两者在页面上要显示成同一个词，
 * 所以按 id 立一张表，再由 id 反推字符串枚举 —— 只维护一份中文。
 *
 * 只标注号而不标名字的地方（分路、位置）另立小表，因为它们的取值集合是封闭的。
 */

/** Valve game_mode id → 中文。表来自 STRATZ `constants { gameModes }` 的顺序，已逐条核对。 */
const GAME_MODE_BY_ID: Record<number, string> = {
	0: '无',
	1: '全英雄选择',
	2: '队长模式',
	3: '随机征召',
	4: '单一征召',
	5: '全英雄随机',
	6: '介绍',
	7: '夜魇暗潮',
	8: '反队长模式',
	9: '小贪魔节',
	10: '教程',
	11: '单中模式',
	12: '生疏模式',
	13: '新玩家模式',
	14: '勇士令状匹配',
	15: '自定义',
	16: '队长征召',
	17: '平衡征召',
	18: '技能征召',
	19: '活动',
	20: '全英雄随机死亡竞赛',
	21: '中路对单',
	// 22 在 Valve 里与 1 同为 All Pick，但只在天梯队列出现；STRATZ 的枚举也叫 ALL_PICK_RANKED。
	22: '天梯全英雄选择',
	23: '加速模式',
	24: '突变模式',
};

/** 字符串枚举 → id。只用得上几个常见的，其余走名字兜底。 */
const GAME_MODE_ENUM_TO_ID: Record<string, number> = {
	ALL_PICK: 1,
	CAPTAINS_MODE: 2,
	RANDOM_DRAFT: 3,
	SINGLE_DRAFT: 4,
	ALL_RANDOM: 5,
	INTRO: 6,
	THE_DIRETIDE: 7,
	REVERSE_CAPTAINS_MODE: 8,
	THE_GREEVILING: 9,
	TUTORIAL: 10,
	MID_ONLY: 11,
	LEAST_PLAYED: 12,
	NEW_PLAYER_POOL: 13,
	COMPENDIUM_MATCHMAKING: 14,
	CUSTOM: 15,
	CAPTAINS_DRAFT: 16,
	BALANCED_DRAFT: 17,
	ABILITY_DRAFT: 18,
	EVENT: 19,
	ALL_RANDOM_DEATH_MATCH: 20,
	SOLO_MID: 21,
	ALL_PICK_RANKED: 22,
	TURBO: 23,
	MUTATION: 24,
};

export function gameModeLabel(input: string | number | null | undefined): string {
	if (input === null || input === undefined) return '未知';
	if (typeof input === 'number') return GAME_MODE_BY_ID[input] ?? `模式 ${input}`;
	const id = GAME_MODE_ENUM_TO_ID[input];
	return id !== undefined ? (GAME_MODE_BY_ID[id] ?? input) : input;
}

const LOBBY_BY_ID: Record<number, string> = {
	'-1': '无效',
	0: '非天梯',
	1: '练习',
	2: '联赛',
	3: '教程',
	4: '合作人机',
	5: '团队比赛',
	6: '单排',
	7: '天梯',
	8: '中路对单',
	9: '勇士联赛',
	12: '活动',
	14: '新玩家模式',
};

export function lobbyLabel(input: string | number | null | undefined): string {
	if (input === null || input === undefined) return '未知';
	if (typeof input === 'string') return input;
	return LOBBY_BY_ID[input] ?? `类型 ${input}`;
}

const LANE_LABEL: Record<string, string> = {
	SAFE_LANE: '优势路',
	MID_LANE: '中路',
	OFF_LANE: '劣势路',
	JUNGLE: '野区',
	ROAMING: '游走',
	UNKNOWN: '未知',
};

export function laneLabel(lane: string | null | undefined): string {
	if (!lane) return '未知';
	return LANE_LABEL[lane] ?? lane;
}

/**
 * 位置。1–5 号位是中文社区的通行叫法，括号里补上 STRATZ/官方的那套路名，
 * 免得只看「4 号位」的人对不上「半辅助」。
 */
const POSITION_LABEL: Record<string, string> = {
	POSITION_1: '1 号位',
	POSITION_2: '2 号位',
	POSITION_3: '3 号位',
	POSITION_4: '4 号位',
	POSITION_5: '5 号位',
};

const POSITION_FULL_LABEL: Record<string, string> = {
	POSITION_1: '1 号位 · 优势路核心',
	POSITION_2: '2 号位 · 中路',
	POSITION_3: '3 号位 · 劣势路',
	POSITION_4: '4 号位 · 半辅助',
	POSITION_5: '5 号位 · 纯辅助',
};

export function positionLabel(position: string | null | undefined, full = false): string {
	if (!position || position === 'UNKNOWN') return '未知';
	const table = full ? POSITION_FULL_LABEL : POSITION_LABEL;
	return table[position] ?? position;
}

/** 段位徽章。rank 是 Byte：十位是奖章，个位是星数；0 或缺失表示未定级。 */
const MEDAL_LABEL = ['未定级', '先锋', '卫士', '中军', '统帅', '传奇', '万古', '超凡', '冠绝'];

export interface RankInfo {
	medal: number;
	star: number;
	label: string;
	/** 徽章图。未定级时指向 medal_0（STRATZ 用同一张灰图）。 */
	medalImg: string;
	starImg: string | null;
}

const MEDAL_CDN = 'https://cdn.stratz.com/images/dota2/seasonal_rank';

export function rankInfo(seasonRank: number | null | undefined): RankInfo {
	const rank = typeof seasonRank === 'number' && seasonRank > 0 ? seasonRank : 0;
	const medal = Math.floor(rank / 10);
	const star = rank % 10;
	// 冠绝（8）没有星，最高只到 medal_7；>8 按 0 处理，避免拼出不存在的图。
	const safeMedal = medal >= 1 && medal <= 8 ? medal : 0;
	return {
		medal,
		star,
		label: rank > 0 ? `${MEDAL_LABEL[safeMedal] ?? '未知'}${star > 0 ? ` ${star} 星` : ''}` : '未定级',
		medalImg: `${MEDAL_CDN}/medal_${safeMedal === 0 ? 0 : safeMedal - 1}.png`,
		starImg: star > 0 ? `${MEDAL_CDN}/star_${star}.png` : null,
	};
}

/**
 * STRATZ 的地区名 → 中文。
 *
 * 名字取自 `constants { regions }`（运行时拉，跟着上游变），这里是**全量**映射：
 * 上游 23 个地区一个不落，包括完美世界那几个机房——国服玩家绝大多数比赛都落在
 * 「中国电信 / 电信（浙江）」这类分组里，漏掉的话地区面板会整片显示英文。
 * 文案与 STRATZ 站内中文版一致，便于两边对照。
 */
const REGION_LABEL: Record<string, string> = {
	unspecified: '不详',
	USWest: '美西',
	USEast: '美东',
	Europe: '欧洲',
	Singapore: '新加坡',
	Dubai: '迪拜',
	Australia: '澳大利亚',
	Stockholm: '斯德哥尔摩',
	Austria: '奥地利',
	Brazil: '巴西',
	SouthAfrica: '南非',
	PerfectWorldTelecom: '中国电信',
	PerfectWorldUnicom: '中国联通',
	Chile: '智利',
	Peru: '秘鲁',
	India: '印度',
	PerfectWorldTelecomGuangdong: '电信（广东）',
	PerfectWorldTelecomZhejiang: '电信（浙江）',
	Japan: '日本',
	PerfectWorldTelecomWuhan: '电信（武汉）',
	PerfectWorldUnicomTianjin: '联通（天津）',
	Taiwan: '台湾',
	Argentina: '阿根廷',
};

/** 名字没在表里就原样返回：上游加地区时退化成英文，好过显示「未知」。 */
export function regionLabel(name: string): string {
	return REGION_LABEL[name] ?? name;
}

/** 三围，用于英雄卡片的左侧色条。和 `heroApi.ATTRIBUTE_META` 保持同色。 */
export const ATTR_COLOR: Record<string, string> = {
	STR: '#C0392B',
	AGI: '#2E8B57',
	INT: '#2980B9',
	UNI: '#E0A93F',
};

/** IMP 分档：STRATZ 的 -100～100，用颜色区分「扛了」和「拖了」。 */
export function impTone(imp: number | null | undefined): 'good' | 'bad' | 'flat' {
	if (typeof imp !== 'number') return 'flat';
	if (imp >= 10) return 'good';
	if (imp <= -10) return 'bad';
	return 'flat';
}
