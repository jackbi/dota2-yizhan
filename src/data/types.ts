export type Platform = 'douyu' | 'huya' | 'bilibili' | 'youtube';

/**
 * OB 大家庭的一员。
 *
 * 只放能核实或有明确社区共识的字段；`aliases` 与 `jokes` 属于社区流传内容，
 * 页面必须整体标注出处，且不收感情纠纷、赌博与私生活相关的梗。
 */
export interface ObMember {
	id: string;
	/** 游戏 ID */
	name: string;
	realName: string;
	/** 社区外号，粉丝整理，非官方 */
	aliases: string[];
	platform: Platform;
	roomId: string;
	/**
	 * 平台接口返回的房主昵称里应当出现的关键词（小写比较）。
	 * 用于构建期自查房间是否已注销或易主——房间号会随主播转平台而失效。
	 */
	ownerMatch: string[];
	/**
	 * 名单来源标注：十人正式名单，还是前身「龙宝川」的老成员。
	 * 目前只作数据溯源保留，页面上不做区分展示。
	 */
	membership: '正式成员' | '编外';
	role: string;
	achievement: string;
	champions: string[];
	tag: string;
	description: string;
	/** 社区流传的梗，非官方 */
	jokes: string[];
}

export type LiveState = 'live' | 'replay' | 'offline' | 'unknown';

/** 一个直播间在构建期的实际状态。 */
export interface LiveStatus {
	state: LiveState;
	/** 平台返回的房主昵称 */
	ownerName?: string;
	roomName?: string;
	category?: string;
	/** 平台自定义的「热度 / 人气」，**不是**真实观看人数 */
	popularity?: number;
	/** 房间当前房主与本人对不上（已注销或已易主） */
	ownerMismatch: boolean;
	/** 本次抓取时间，ISO 字符串 */
	fetchedAt: string;
	/** 房间失效等需要额外说明的情况 */
	note?: string;
}

/** 一次构建拿到的全部开播状态快照。 */
export interface LiveSnapshot {
	/** 抓取时间，ISO 字符串 */
	at: string;
	/** key 为 `${platform}:${roomId}` */
	statuses: Record<string, LiveStatus>;
}

/** 新闻列表卡片的展示数据。 */
export interface NewsCardItem {
	id: string;
	title: string;
	summary: string;
	/** YYYY-MM-DD */
	date: string;
	img?: string;
	/** 栏目标签，展示用 */
	tags: string[];
	/** 右下角的来源说明 */
	meta: string;
	/** 左上角徽章，缺省为「官方信息」；社区来源可覆盖 */
	badge?: string;
	/** 译文之外的原文标题，展示在标题下方 */
	originalTitle?: string;
	/** 站内详情页地址 */
	href?: string;
	featured?: boolean;
}

/** 赛事数据的来源，用于在页面上标注出处。 */
export type DataSource = 'liquipedia' | 'opendota' | 'seed';

/** postponed 表示延期/中断的对局；赛事层面的 completed 判定会忽略它。 */
export type MatchStatus = 'live' | 'upcoming' | 'completed' | 'postponed';

export interface TeamRef {
	id: string;
	name: string;
	logo?: string;
	score?: number;
}

/** 一场具体的对阵（BO1/BO3/BO5 中的一场）。 */
export interface EsportsMatch {
	id: string;
	eventId: string;
	eventName: string;
	/** 开赛时间，Unix 秒。 */
	startTime: number;
	status: MatchStatus;
	/** 赛制，如 3 表示 BO3；未知时缺省。 */
	bo?: number;
	home: TeamRef;
	away: TeamRef;
	winner?: 'home' | 'away';
	source: DataSource;
	/** 数据源里对应的页面地址，用于署名回链。 */
	sourceUrl?: string;
}

/** 一个赛事/联赛，聚合了它的全部对阵与参赛队伍。 */
export interface EsportsEvent {
	id: string;
	name: string;
	status: MatchStatus;
	/** 首场比赛时间，Unix 秒。 */
	startTime: number;
	/** 末场比赛时间，Unix 秒。 */
	endTime: number;
	matches: EsportsMatch[];
	teams: TeamRef[];
	source: DataSource;
	/** 数据源里对应的页面地址，用于署名回链。 */
	sourceUrl?: string;
}

export interface DataSourceStatus {
	id: DataSource;
	label: string;
	ok: boolean;
}

/** 赛事页一次构建拿到的全部数据。 */
export interface TournamentsBundle {
	events: EsportsEvent[];
	/** 正在进行的比赛（含 OpenDota 实时接口）。 */
	live: EsportsMatch[];
	/** 数据生成时间，ISO 字符串。 */
	updatedAt: string;
	/** 是否走了降级路径（未拿到主数据源）。 */
	degraded: boolean;
	sources: DataSourceStatus[];
}

export type ItemType =
	| 'carry'
	| 'support'
	| 'caster'
	| 'utility'
	| 'offlane'
	| 'boots'
	| 'neutral';

export interface Item {
	id: string;
	name: string;
	cn: string;
	type: ItemType;
	cost: number;
	active: boolean;
	components: string[];
	short: string;
}
