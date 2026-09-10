export type Platform = 'douyu' | 'huya' | 'bilibili' | 'youtube';

export interface Streamer {
	id: string;
	name: string;
	alias: string;
	platform: Platform;
	roomId: string;
	embedUrl: string;
	avatar?: string;
	tag: string;
	live: boolean;
	viewers: number;
	description: string;
}

export interface NewsItem {
	id: string;
	title: string;
	summary: string;
	source: string;
	category: 'news' | 'rumor';
	date: string;
	tag: string;
	readTime: string;
	featured?: boolean;
}

/** 赛事数据的来源，用于在页面上标注出处。 */
export type DataSource = 'chaofan' | 'opendota' | 'seed';

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

export interface Patch {
	id: string;
	version: string;
	title: string;
	date: string;
	kind: 'major' | 'balance' | 'minor';
	summary: string;
	highlights: string[];
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
