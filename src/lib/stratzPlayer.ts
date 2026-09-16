import { STRATZ_RELAY_TOKEN, STRATZ_RELAY_URL, STRATZ_TOKEN } from 'astro:env/server';
import { cached, pace } from './ssrCache';
import { resolveStratzEndpoint } from './stratzEndpoint';

/**
 * 运行时（SSR）个人战绩数据层。
 *
 * 与构建期的 `stratzApi.ts` 分开写，不是重复劳动——两者的约束根本不同：
 * - `stratzApi.ts` 跑在构建期，可以用 `node:fs` 把结果落盘、可以用模块级 Promise
 *   在整个构建里只请求一次；
 * - 这里跑在运行时、按用户请求取数，**不能碰文件系统**（换了 adapter 上 Workers 就没有），
 *   缓存只能是内存 + TTL，且必须按账号区分。
 *
 * 用 STRATZ 而不是 OpenDota：STRATZ 的限速宽得多（8/秒 vs 60/分），而且一次 GraphQL
 * 就能把选手行、聚合统计、队友对手一起取回；OpenDota 要按比赛逐个补，串行 1.1 秒的
 * 间隔在这种「一页几十场」的场景下不可接受。
 *
 * 鉴权用站点自己的 `STRATZ_TOKEN`（不需要用户授权）：读的是公开比赛数据，
 * 用户身份来自 Steam OpenID，两者互不相干。这个 token 绑 IP，而 Workers 的边缘出口会漂，
 * 所以生产上多半要配 `STRATZ_RELAY_URL` 走固定出口的中转（见 `stratzEndpoint.ts`）。
 */

/**
 * 直连官方，或走固定出口的中转——**为什么需要中转**写在 `stratzEndpoint.ts` 的注释里。
 * 这里只负责把两个来源拼起来：命中中转时，本进程手里根本没有 STRATZ token。
 */
const ENDPOINT = resolveStratzEndpoint({
	relayUrl: STRATZ_RELAY_URL,
	relayToken: STRATZ_RELAY_TOKEN,
	token: STRATZ_TOKEN,
});

export function stratzPlayerConfigured(): boolean {
	return ENDPOINT.mode !== 'none';
}

/** 上游故障时抛错，调用方据此区分「取不到」与「此人没有数据」。 */
export class StratzError extends Error {}

interface GraphQLBody<T> {
	data?: T | null;
	errors?: unknown[];
}

/**
 * 发一次 GraphQL。失败重试三次（STRATZ 偶发 TLS ECONNRESET，构建期也踩过），
 * 重试耗尽后抛错——**不返回 null**，免得把上游故障当成「这个玩家不存在」缓存起来。
 */
async function gql<T>(document: string, variables: Record<string, unknown>): Promise<T> {
	// 没配 token 也没配中转是「没开这个功能」，与请求失败不是一回事，交给调用方按未配置处理。
	if (ENDPOINT.mode === 'none') {
		throw new StratzError(ENDPOINT.problem ?? '未配置 STRATZ_TOKEN');
	}

	let lastError = '请求失败';
	for (let attempt = 0; attempt < 3; attempt += 1) {
		if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 400 * attempt));
		await pace();
		try {
			const res = await fetch(ENDPOINT.url, {
				method: 'POST',
				signal: AbortSignal.timeout(20_000),
				headers: ENDPOINT.headers,
				body: JSON.stringify({ query: document, variables }),
			});
			// 429 与 5xx 值得重试；403 要读完 body 才能分辨原因（见下）。
			if (res.status === 429 || res.status >= 500) {
				lastError = `HTTP ${res.status}`;
				continue;
			}
			if (res.status === 403) {
				// 先读 body 再分类。STRATZ 对「换出口 IP」的拒绝是 403 + **纯文本**
				// （连 content-type 都没有），必须和同为 403 的 Cloudflare 挑战页分开：
				// 不特判的话页面上只剩一句「HTTP 403」，看不出该去改什么。
				const body = await res.text().catch(() => '');
				if (body.includes('different IP Addresses')) {
					throw new StratzError('STRATZ 拒绝了这个出口 IP：同一个 token 只能从固定 IP 调用，过一会儿重试可能恢复');
				}
				// 其余 403 一律按「可能短暂」重试：挑战页换着花样返回 HTML 与纯文本，只认
				// content-type 会把一部分挑战页当成硬失败。但重试耗尽的文案要保留原始状态码，
				// 不能统一说成挑战页——否则 token 失效这类硬失败会被描述成「稍后再试」。
				lastError = (res.headers.get('content-type') ?? '').includes('text/html') ? 'Cloudflare 挑战页' : `HTTP ${res.status}`;
				continue;
			}
			// 中转这一层自己拒绝：说明两边口令不一致，跟 STRATZ 无关，重试也没用。
			if (res.status === 401 && ENDPOINT.mode === 'relay') {
				throw new StratzError('STRATZ 中转拒绝了这次请求：STRATZ_RELAY_TOKEN 与中转机器上的 RELAY_TOKEN 不一致');
			}
			if (!res.ok) throw new StratzError(`STRATZ 返回 HTTP ${res.status}`);
			const body = (await res.json()) as GraphQLBody<T>;
			if (body.errors?.length) {
				throw new StratzError(`GraphQL 报错：${JSON.stringify(body.errors[0]).slice(0, 200)}`);
			}
			if (!body.data) throw new StratzError('STRATZ 返回空数据');
			return body.data;
		} catch (error) {
			if (error instanceof StratzError) throw error;
			lastError = error instanceof Error ? error.message : String(error);
		}
	}
	throw new StratzError(`STRATZ 请求失败：${lastError}`);
}

// ---------------------------------------------------------------- 缓存时长

/** 进行中的比赛会让统计一直在变，但个人页不需要秒级新鲜度。 */
const PROFILE_TTL_MS = 5 * 60 * 1000;
const MATCHES_TTL_MS = 3 * 60 * 1000;
const AGGREGATE_TTL_MS = 10 * 60 * 1000;
const CONSTANTS_TTL_MS = 24 * 3600 * 1000;

/**
 * 聚合查询的窗口上限。`matchesGroupBy` 的 `take` 限的是**参与聚合的比赛数**，
 * 默认值很小（实测约 20），不放大就只能统计到最近几场——「全部时间」的胜率会假得离谱。
 * 上限 10000 是本层的取舍：STRATZ 单次聚合更大会明显变慢，而个人的第 1 万场之后
 * 对「常用英雄」「位置分布」这类结论几乎没有影响。
 */
const AGG_TAKE = 10_000;

// ---------------------------------------------------------------- 类型

export interface PlayerGuild {
	name: string;
	tag: string;
}

export interface PlayerProfile {
	accountId: number;
	name: string;
	avatar: string;
	realName: string | null;
	countryCode: string | null;
	/** Valve 的段位字节，0/空表示未定级。 */
	seasonRank: number | null;
	isDotaPlus: boolean;
	isAnonymous: boolean;
	behaviorScore: number | null;
	matchCount: number;
	winCount: number;
	firstMatchDate: number | null;
	lastMatchDate: number | null;
	imp: number | null;
	guild: PlayerGuild | null;
}

/** 「只要一个头像」的轻量结果，见 `loadPlayerAvatar`。 */
export interface PlayerAvatar {
	accountId: number;
	name: string;
	avatar: string;
}

export interface HeroPerformance {
	heroId: number;
	matches: number;
	wins: number;
	kills: number;
	deaths: number;
	assists: number;
	gpm: number;
	xpm: number;
	imp: number;
}

export interface PlayerMatch {
	matchId: number;
	startTime: number;
	durationSeconds: number;
	win: boolean;
	heroId: number;
	kills: number;
	deaths: number;
	assists: number;
	networth: number;
	gpm: number;
	xpm: number;
	lastHits: number;
	denies: number;
	level: number;
	imp: number | null;
	position: string | null;
	/** 只保留有效 id（0/负数表示该格为空）。 */
	items: number[];
	gameMode: string | null;
	lobbyType: string | null;
	averageRank: number | null;
}

/** 记分板里的一行：一场比赛里的一个选手。 */
export interface MatchDetailPlayer {
	accountId: number | null;
	name: string;
	avatar: string;
	isRadiant: boolean;
	heroId: number;
	kills: number;
	deaths: number;
	assists: number;
	networth: number;
	gpm: number;
	xpm: number;
	lastHits: number;
	denies: number;
	level: number;
	imp: number | null;
	/** `MVP` / `TOP_CORE` / `TOP_SUPPORT`；没有奖项时为 null（上游给的是 `NONE`）。 */
	award: string | null;
	position: string | null;
	lane: string | null;
	/**
	 * **保留槽位**的六个物品格，空格是 null——不像列表页那样把空的过滤掉。
	 * 记分板上「这个格子是空的」本身是信息（没打完的装备、卖掉的装备一眼能看出来）。
	 */
	items: (number | null)[];
}

/**
 * 单场对局。
 *
 * 不查 `pickBans`：个人对局绝大多数是加速/普通匹配，本来就没有 BP——实测这场
 * Turbo 返回的就是 `null`。为它多写一套 UI 不划算，等真的要看队长模式的场次再说。
 */
export interface MatchDetail {
	matchId: number;
	startTime: number;
	durationSeconds: number;
	/** 天辉是否获胜。为 null 表示上游没给（未解析完的比赛）。 */
	radiantWin: boolean | null;
	gameMode: string | null;
	lobbyType: string | null;
	averageRank: number | null;
	players: MatchDetailPlayer[];
}

export interface PeerRow {
	accountId: number;
	name: string;
	avatar: string;
	matches: number;
	wins: number;
	imp: number | null;
	kda: number | null;
}

export interface GroupRow {
	/** 维度取值（数字或字符串），页面自己决定怎么显示。 */
	key: string;
	matches: number;
	wins: number;
	imp: number | null;
}

export interface PlayerBreakdown {
	position: GroupRow[];
	lane: GroupRow[];
	/**
	 * 已从位置/分路/定位里摘掉的「无记录」场次（三个维度同一批比赛，见 `splitUnclassified`）。
	 * 页面要把它单独说明，否则三个维度的合计会对不上总场次。
	 */
	unclassifiedMatches: number;
	gameMode: GroupRow[];
	lobbyType: GroupRow[];
	faction: GroupRow[];
	party: GroupRow[];
	duration: GroupRow[];
	hour: GroupRow[];
	region: GroupRow[];
	trend: GroupRow[];
	role: GroupRow[];
}

/**
 * `matches` 的 `take` **上游上限是 100**：超过直接返回
 * `You have surpassed the maximum take value of : 100`（不是截断，是报错）。
 * 分页时每页不要超过这个数——`/me/matches` 用的是 25。
 */
export const MATCH_TAKE_LIMIT = 100;

export interface MatchQuery {
	take: number;
	skip: number;
	gameModeIds?: number[];
	lobbyTypeIds?: number[];
	heroIds?: number[];
	isVictory?: boolean;
	positionIds?: string[];
}

// ---------------------------------------------------------------- 查询文档

/**
 * `steamAccount.seasonRank` 才是当前段位；`player.ranks` 是历史快照列表（实测多数账号为空），
 * 所以概览用前者，进展页再用后者补历史。
 */
const PROFILE_DOCUMENT = `query PlayerProfile($id: Long!, $heroTake: Int!) {
  player(steamAccountId: $id) {
    steamAccountId
    matchCount
    winCount
    imp
    firstMatchDate
    lastMatchDate
    behaviorScore
    steamAccount {
      name
      avatar
      realName
      countryCode
      seasonRank
      isDotaPlusSubscriber
      isAnonymous
    }
    guildMember {
      guildId
      guild { name tag }
    }
    heroesPerformance(take: $heroTake) {
      heroId
      matchCount
      winCount
      avgKills
      avgDeaths
      avgAssists
      goldPerMinute
      experiencePerMinute
      imp
    }
  }
}`;

/**
 * `playerList: SINGLE` 很关键：不加它每场都会把十个选手全带回来，
 * 20 场就是 200 行，而列表里只用得上本人那一行。
 */
const MATCHES_DOCUMENT = `query PlayerMatches($id: Long!, $request: PlayerMatchesRequestType!) {
  player(steamAccountId: $id) {
    matches(request: $request) {
      id
      startDateTime
      durationSeconds
      didRadiantWin
      gameMode
      lobbyType
      averageRank
      players {
        steamAccountId
        isRadiant
        heroId
        kills
        deaths
        assists
        networth
        goldPerMinute
        experiencePerMinute
        numLastHits
        numDenies
        level
        imp
        position
        item0Id
        item1Id
        item2Id
        item3Id
        item4Id
        item5Id
      }
    }
  }
}`;

/**
 * 单场对局详情。这里**不加** `playerList: SINGLE`——记分板要的就是全部十个人。
 *
 * 字段全部用真实响应核对过（比赛 7720294433）：`award` / `lane` / `position` 是枚举字符串，
 * 空物品格上游直接不给字段，所以取的时候要按 `null` 处理。
 */
const MATCH_DETAIL_DOCUMENT = `query MatchDetail($id: Long!) {
  match(id: $id) {
    id
    startDateTime
    durationSeconds
    didRadiantWin
    gameMode
    lobbyType
    averageRank
    players {
      steamAccountId
      isRadiant
      heroId
      kills
      deaths
      assists
      networth
      goldPerMinute
      experiencePerMinute
      numLastHits
      numDenies
      level
      imp
      award
      position
      lane
      item0Id
      item1Id
      item2Id
      item3Id
      item4Id
      item5Id
      steamAccount { name avatar }
    }
  }
}`;

/** 队友 / 对手：按对手账号分组，`playerList` 决定是「同队」还是「对面」。 */
const PEERS_DOCUMENT = `query PlayerPeers($id: Long!, $request: PlayerMatchesGroupByRequestType!) {
  player(steamAccountId: $id) {
    matchesGroupBy(request: $request) {
      ... on MatchGroupBySteamAccountIdType {
        steamAccountId
        matchCount
        winCount
        avgImp
        avgKDA
        steamAccount { name avatar }
      }
    }
  }
}`;

/**
 * 一次请求拿回所有维度。拆成多个请求只会把同一次聚合重复算好几遍，
 * 而 STRATZ 的额度是按请求数算的。
 *
 * `playerList: SINGLE` 是必填参数，缺了直接报错；它表示只统计该玩家自己的行。
 */
const BREAKDOWN_DOCUMENT = `query PlayerBreakdown($id: Long!, $take: Int!) {
  player(steamAccountId: $id) {
    position: matchesGroupBy(request: { groupBy: POSITION, playerList: SINGLE, take: $take }) {
      ... on MatchGroupByPositionType { position matchCount winCount avgImp }
    }
    lane: matchesGroupBy(request: { groupBy: LANE, playerList: SINGLE, take: $take }) {
      ... on MatchGroupByLaneType { lane matchCount winCount avgImp }
    }
    role: matchesGroupBy(request: { groupBy: ROLE, playerList: SINGLE, take: $take }) {
      ... on MatchGroupByRoleType { role matchCount winCount avgImp }
    }
    gameMode: matchesGroupBy(request: { groupBy: GAME_MODE, playerList: SINGLE, take: $take }) {
      ... on MatchGroupByGameModeType { gameMode matchCount winCount avgImp }
    }
    lobbyType: matchesGroupBy(request: { groupBy: LOBBY_TYPE, playerList: SINGLE, take: $take }) {
      ... on MatchGroupByLobbyTypeType { lobbyType matchCount winCount avgImp }
    }
    faction: matchesGroupBy(request: { groupBy: FACTION, playerList: SINGLE, take: $take }) {
      ... on MatchGroupByFactionType { isRadiant matchCount winCount avgImp }
    }
    party: matchesGroupBy(request: { groupBy: IS_PARTY, playerList: SINGLE, take: $take }) {
      ... on MatchGroupByIsPartyType { isParty matchCount winCount avgImp }
    }
    duration: matchesGroupBy(request: { groupBy: DURATION_MINUTES, playerList: SINGLE, take: $take }) {
      ... on MatchGroupByDurationMinutesType { durationMinutes matchCount winCount avgImp }
    }
    hour: matchesGroupBy(request: { groupBy: HOUR, playerList: SINGLE, take: $take }) {
      ... on MatchGroupByHourType { hour matchCount winCount avgImp }
    }
    region: matchesGroupBy(request: { groupBy: REGION, playerList: SINGLE, take: $take }) {
      ... on MatchGroupByRegionType { region matchCount winCount avgImp }
    }
    day: matchesGroupBy(request: { groupBy: DATE_DAY, playerList: SINGLE, take: $take }) {
      ... on MatchGroupByDateDayType { dateDay matchCount winCount avgImp }
    }
  }
}`;

const PROGRESSION_DOCUMENT = `query PlayerProgression($id: Long!) {
  player(steamAccountId: $id) {
    matchCount
    winCount
    guildMember { guildId guild { name tag } }
    ranks { seasonRankId rank isCore asOfDateTime }
    names { name lastSeenDateTime }
    leaderboardRanks { seasonLeaderBoardDivisionId rank }
  }
}`;

const REGIONS_DOCUMENT = `{ constants { regions { id name } } }`;

// ---------------------------------------------------------------- 原始类型

interface RawSteamAccount {
	name?: string | null;
	avatar?: string | null;
	realName?: string | null;
	countryCode?: string | null;
	seasonRank?: number | null;
	isDotaPlusSubscriber?: boolean | null;
	isAnonymous?: boolean | null;
}

interface RawHeroPerformance {
	heroId?: number | null;
	matchCount?: number | null;
	winCount?: number | null;
	avgKills?: number | null;
	avgDeaths?: number | null;
	avgAssists?: number | null;
	goldPerMinute?: number | null;
	experiencePerMinute?: number | null;
	imp?: number | null;
}

interface RawPlayer {
	steamAccountId?: number | null;
	matchCount?: number | null;
	winCount?: number | null;
	imp?: number | null;
	firstMatchDate?: number | null;
	lastMatchDate?: number | null;
	behaviorScore?: number | null;
	steamAccount?: RawSteamAccount | null;
	guildMember?: { guild?: { name?: string | null; tag?: string | null } | null } | null;
	heroesPerformance?: RawHeroPerformance[] | null;
}

interface RawMatchPlayer {
	steamAccountId?: number | null;
	steamAccount?: { name?: string | null; avatar?: string | null } | null;
	isRadiant?: boolean | null;
	heroId?: number | null;
	kills?: number | null;
	deaths?: number | null;
	assists?: number | null;
	networth?: number | null;
	goldPerMinute?: number | null;
	experiencePerMinute?: number | null;
	numLastHits?: number | null;
	numDenies?: number | null;
	level?: number | null;
	imp?: number | null;
	position?: string | null;
	lane?: string | null;
	/** `MVP` / `TOP_CORE` / `TOP_SUPPORT` / `NONE`。 */
	award?: string | null;
	item0Id?: number | null;
	item1Id?: number | null;
	item2Id?: number | null;
	item3Id?: number | null;
	item4Id?: number | null;
	item5Id?: number | null;
}

interface RawMatch {
	id?: number | null;
	startDateTime?: number | null;
	durationSeconds?: number | null;
	didRadiantWin?: boolean | null;
	gameMode?: string | null;
	lobbyType?: string | null;
	averageRank?: number | null;
	players?: RawMatchPlayer[] | null;
}

interface RawGroup {
	matchCount?: number | null;
	winCount?: number | null;
	avgImp?: number | null;
	[key: string]: unknown;
}

// ---------------------------------------------------------------- 归一化

const num = (value: unknown, fallback = 0): number => (typeof value === 'number' && Number.isFinite(value) ? value : fallback);
const numOrNull = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);

function toProfile(raw: RawPlayer): PlayerProfile | null {
	if (typeof raw.steamAccountId !== 'number') return null;
	const account = raw.steamAccount ?? {};
	const guildName = raw.guildMember?.guild?.name?.trim();
	return {
		accountId: raw.steamAccountId,
		name: account.name?.trim() || `玩家 ${raw.steamAccountId}`,
		avatar: account.avatar ?? '',
		realName: account.realName?.trim() || null,
		countryCode: account.countryCode?.trim() || null,
		seasonRank: numOrNull(account.seasonRank),
		isDotaPlus: Boolean(account.isDotaPlusSubscriber),
		isAnonymous: Boolean(account.isAnonymous),
		behaviorScore: numOrNull(raw.behaviorScore),
		matchCount: num(raw.matchCount),
		winCount: num(raw.winCount),
		firstMatchDate: numOrNull(raw.firstMatchDate),
		lastMatchDate: numOrNull(raw.lastMatchDate),
		imp: numOrNull(raw.imp),
		guild: guildName ? { name: guildName, tag: raw.guildMember?.guild?.tag?.trim() || '' } : null,
	};
}

function toHeroPerformance(rows: RawHeroPerformance[] | null | undefined): HeroPerformance[] {
	return (rows ?? [])
		.filter((row): row is RawHeroPerformance & { heroId: number } => typeof row.heroId === 'number')
		.map((row) => ({
			heroId: row.heroId,
			matches: num(row.matchCount),
			wins: num(row.winCount),
			kills: num(row.avgKills),
			deaths: num(row.avgDeaths),
			assists: num(row.avgAssists),
			gpm: num(row.goldPerMinute),
			xpm: num(row.experiencePerMinute),
			imp: num(row.imp),
		}))
		.sort((a, b) => b.matches - a.matches);
}

function toMatch(raw: RawMatch): PlayerMatch | null {
	if (typeof raw.id !== 'number') return null;
	// playerList: SINGLE 下这里应该恰好一行；取第一行即可，取不到就跳过这场。
	const me = raw.players?.[0];
	if (!me || typeof me.heroId !== 'number') return null;

	const itemSlots = [me.item0Id, me.item1Id, me.item2Id, me.item3Id, me.item4Id, me.item5Id];
	const items = itemSlots.filter((id): id is number => typeof id === 'number' && id > 0);

	return {
		matchId: raw.id,
		startTime: num(raw.startDateTime),
		durationSeconds: num(raw.durationSeconds),
		// 用 didRadiantWin 与 isRadiant 推出本人胜负，而不是信 isVictory：
		// 后者在个别老比赛里为空，前者两者都在就没得错。
		win: typeof raw.didRadiantWin === 'boolean' ? raw.didRadiantWin === Boolean(me.isRadiant) : false,
		heroId: me.heroId,
		kills: num(me.kills),
		deaths: num(me.deaths),
		assists: num(me.assists),
		networth: num(me.networth),
		gpm: num(me.goldPerMinute),
		xpm: num(me.experiencePerMinute),
		lastHits: num(me.numLastHits),
		denies: num(me.numDenies),
		level: num(me.level),
		imp: numOrNull(me.imp),
		position: me.position ?? null,
		items,
		gameMode: raw.gameMode ?? null,
		lobbyType: raw.lobbyType ?? null,
		averageRank: numOrNull(raw.averageRank),
	};
}

function toGroupRows(rows: RawGroup[] | null | undefined, keyName: string): GroupRow[] {
	return (rows ?? [])
		.map((row) => {
			const value = row[keyName];
			return {
				key: String(value ?? ''),
				matches: num(row.matchCount),
				wins: num(row.winCount),
				imp: numOrNull(row.avgImp),
			};
		})
		.filter((row) => row.key !== '' && row.matches > 0);
}

// ---------------------------------------------------------------- 对外接口

/**
 * 资料与英雄统计来自**同一个** GraphQL 文档，所以只发一次请求、只缓存一份。
 *
 * 拆成两个函数各缓存各的（第一个版本就是）会让概览页把同一个查询打两遍——
 * 而它是全站最贵的查询之一，还白占 STRATZ 的额度。
 */
interface PlayerBundle {
	profile: PlayerProfile;
	heroes: HeroPerformance[];
}

async function loadPlayerBundle(accountId: number, heroTake: number): Promise<PlayerBundle | null> {
	return cached(`player:bundle:${accountId}:${heroTake}`, PROFILE_TTL_MS, async () => {
		const data = await gql<{ player: RawPlayer | null }>(PROFILE_DOCUMENT, { id: accountId, heroTake });
		if (!data.player) return null;
		const profile = toProfile(data.player);
		if (!profile) return null;
		return { profile, heroes: toHeroPerformance(data.player.heroesPerformance) };
	});
}

export async function loadPlayerProfile(accountId: number, heroTake = 60): Promise<PlayerProfile | null> {
	return (await loadPlayerBundle(accountId, heroTake))?.profile ?? null;
}

/**
 * 昵称与头像，别的都不要。
 *
 * 开黑房间允许「不登录、只填 Steam ID」来认脸，但**不能**复用 `loadPlayerProfile`：
 * 那条查询会顺带把 60 个英雄的统计一起拉回来，为了一个头像付这个代价太贵了
 * （STRATZ 的额度按次算，而这条路径任何人都能触发）。这里只取两个字段。
 */
const AVATAR_DOCUMENT = `query PlayerAvatar($id: Long!) {
  player(steamAccountId: $id) {
    steamAccountId
    steamAccount { name avatar isAnonymous }
  }
}`;

/** 昵称头像几乎不变，而这条路径对公网开放，缓存给长一点省额度。 */
const AVATAR_TTL_MS = 6 * 3600 * 1000;

/**
 * 按账号 id 取昵称与头像。账号不存在返回 null（调用方据此说「查不到这个账号」）；
 * 上游故障仍然抛 `StratzError`，两者不能混为一谈。
 */
export async function loadPlayerAvatar(accountId: number): Promise<PlayerAvatar | null> {
	return cached(`player:avatar:${accountId}`, AVATAR_TTL_MS, async () => {
		const data = await gql<{ player: RawPlayer | null }>(AVATAR_DOCUMENT, { id: accountId });
		const player = data.player;
		if (!player || typeof player.steamAccountId !== 'number') return null;
		return {
			accountId: player.steamAccountId,
			name: player.steamAccount?.name?.trim() ?? '',
			avatar: player.steamAccount?.avatar ?? '',
		};
	});
}

export async function loadPlayerHeroes(accountId: number, heroTake = 60): Promise<HeroPerformance[]> {
	return (await loadPlayerBundle(accountId, heroTake))?.heroes ?? [];
}

export async function loadPlayerMatches(accountId: number, query: MatchQuery): Promise<PlayerMatch[]> {
	const request: Record<string, unknown> = {
		take: query.take,
		skip: query.skip,
		// 只带本人那一行，见文档注释。
		playerList: 'SINGLE',
	};
	if (query.gameModeIds?.length) request.gameModeIds = query.gameModeIds;
	if (query.lobbyTypeIds?.length) request.lobbyTypeIds = query.lobbyTypeIds;
	if (query.heroIds?.length) request.heroIds = query.heroIds;
	if (query.positionIds?.length) request.positionIds = query.positionIds;
	if (typeof query.isVictory === 'boolean') request.isVictory = query.isVictory;

	const key = `player:matches:${accountId}:${JSON.stringify(request)}`;
	return cached(key, MATCHES_TTL_MS, async () => {
		const data = await gql<{ player: { matches?: RawMatch[] | null } | null }>(MATCHES_DOCUMENT, {
			id: accountId,
			request,
		});
		return (data.player?.matches ?? [])
			.map(toMatch)
			.filter((match): match is PlayerMatch => match !== null);
	});
}

function toMatchDetailPlayer(raw: RawMatchPlayer): MatchDetailPlayer | null {
	if (typeof raw.heroId !== 'number') return null;
	const slots = [raw.item0Id, raw.item1Id, raw.item2Id, raw.item3Id, raw.item4Id, raw.item5Id];
	const award = (raw.award ?? '').trim();
	return {
		accountId: numOrNull(raw.steamAccountId),
		name: raw.steamAccount?.name?.trim() || '匿名选手',
		avatar: raw.steamAccount?.avatar ?? '',
		isRadiant: Boolean(raw.isRadiant),
		heroId: raw.heroId,
		kills: num(raw.kills),
		deaths: num(raw.deaths),
		assists: num(raw.assists),
		networth: num(raw.networth),
		gpm: num(raw.goldPerMinute),
		xpm: num(raw.experiencePerMinute),
		lastHits: num(raw.numLastHits),
		denies: num(raw.numDenies),
		level: num(raw.level),
		imp: numOrNull(raw.imp),
		// 上游用一个真实的枚举值 `NONE` 表示「没拿奖」，别把它当成奖项画出来。
		award: award && award !== 'NONE' ? award : null,
		position: raw.position ?? null,
		lane: raw.lane ?? null,
		items: slots.map((id) => (typeof id === 'number' && id > 0 ? id : null)),
	};
}

function toMatchDetail(raw: RawMatch): MatchDetail | null {
	if (typeof raw.id !== 'number') return null;
	const players = (raw.players ?? [])
		.map(toMatchDetailPlayer)
		.filter((player): player is MatchDetailPlayer => player !== null);
	// 一个选手都没有说明这场还没解析，当作「拿不到」而不是「一场空比赛」。
	if (players.length === 0) return null;

	return {
		matchId: raw.id,
		startTime: num(raw.startDateTime),
		durationSeconds: num(raw.durationSeconds),
		radiantWin: typeof raw.didRadiantWin === 'boolean' ? raw.didRadiantWin : null,
		gameMode: raw.gameMode ?? null,
		lobbyType: raw.lobbyType ?? null,
		averageRank: numOrNull(raw.averageRank),
		players,
	};
}

/**
 * 单场对局。缓存给得比列表长：已解析的比赛内容不会再变，会变的只有「还没解析完」的那批，
 * 而这种比赛通常几小时内有结果，30 分钟足够把重复点击挡掉。
 */
const MATCH_DETAIL_TTL_MS = 30 * 60 * 1000;

export async function loadMatchDetail(matchId: number): Promise<MatchDetail | null> {
	return cached(`player:match:${matchId}`, MATCH_DETAIL_TTL_MS, async () => {
		const data = await gql<{ match: RawMatch | null }>(MATCH_DETAIL_DOCUMENT, { id: matchId });
		return data.match ? toMatchDetail(data.match) : null;
	});
}

/**
 * 把「没有位置/分路/定位记录」的那一批比赛从三个维度里摘出来。
 *
 * STRATZ 对这类比赛（远古局、未解析局）不返回「未知」，而是把它们塞进各维度的
 * **默认枚举值**：位置记成 `POSITION_1`、分路记成 `ROAMING`、定位记成 `CORE`。
 * 实测某个 1338 场的账号，这三处都是同一批 1071 场，且 `avgImp` 一律为 0。
 *
 * 直接展示会有两个后果，都是硬伤：
 * - 同一维度出现两个同名分组（`POSITION_1` 两条），看着像页面渲染坏了；
 * - 把「没记录」当成「1 号位」，整个位置分布彻底失真（1071 场对 23 场）。
 *
 * 识别依据是**三个维度里 (场次, 胜场) 完全相同**——真实的「位置 × 分路 × 定位」组合
 * 撞成同一组数字的概率可以忽略。摘出来的场次由页面单独注明，不混进任何一档。
 */
function splitUnclassified(
	position: GroupRow[],
	lane: GroupRow[],
	role: GroupRow[],
): { position: GroupRow[]; lane: GroupRow[]; role: GroupRow[]; unclassifiedMatches: number } {
	const signature = (row: GroupRow): string => `${row.matches}:${row.wins}`;
	const laneSignatures = new Set(lane.map(signature));
	const roleSignatures = new Set(role.map(signature));

	const suspicious = new Set(
		position.map(signature).filter((key) => laneSignatures.has(key) && roleSignatures.has(key)),
	);
	if (suspicious.size === 0) return { position, lane, role, unclassifiedMatches: 0 };

	const dropped = position.filter((row) => suspicious.has(signature(row)));
	const keep = (rows: GroupRow[]): GroupRow[] => rows.filter((row) => !suspicious.has(signature(row)));

	return {
		position: keep(position),
		lane: keep(lane),
		role: keep(role),
		unclassifiedMatches: dropped.reduce((acc, row) => acc + row.matches, 0),
	};
}

export async function loadPlayerBreakdown(accountId: number, matchCount: number): Promise<PlayerBreakdown> {
	// 场次少的账号没必要按上限聚合，省掉一次没意义的扫描。
	const take = Math.max(1, Math.min(matchCount || AGG_TAKE, AGG_TAKE));
	return cached(`player:breakdown:${accountId}:${take}`, AGGREGATE_TTL_MS, async () => {
		const data = await gql<{ player: Record<string, RawGroup[] | null> | null }>(BREAKDOWN_DOCUMENT, {
			id: accountId,
			take,
		});
		const p = data.player ?? {};
		// role 是标量枚举（CORE / LIGHT_SUPPORT / HARD_SUPPORT），排序交给页面按语义来。
		const { position, lane, role, unclassifiedMatches } = splitUnclassified(
			toGroupRows(p.position, 'position'),
			toGroupRows(p.lane, 'lane'),
			toGroupRows(p.role, 'role'),
		);

		return {
			position: position.sort((a, b) => a.key.localeCompare(b.key)),
			lane: lane.sort((a, b) => b.matches - a.matches),
			role,
			unclassifiedMatches,
			gameMode: toGroupRows(p.gameMode, 'gameMode').sort((a, b) => b.matches - a.matches),
			lobbyType: toGroupRows(p.lobbyType, 'lobbyType').sort((a, b) => b.matches - a.matches),
			faction: toGroupRows(p.faction, 'isRadiant'),
			party: toGroupRows(p.party, 'isParty'),
			duration: toGroupRows(p.duration, 'durationMinutes').sort((a, b) => Number(a.key) - Number(b.key)),
			hour: toGroupRows(p.hour, 'hour').sort((a, b) => Number(a.key) - Number(b.key)),
			region: toGroupRows(p.region, 'region').sort((a, b) => b.matches - a.matches),
			// 趋势按时间正序，画折线时从左到右才是时间流逝的方向。
			trend: toGroupRows(p.day, 'dateDay').sort((a, b) => Number(a.key) - Number(b.key)),
		};
	});
}

export async function loadPlayerPeers(accountId: number, list: 'WITH' | 'AGAINST', take = 50): Promise<PeerRow[]> {
	const request = { groupBy: 'STEAM_ACCOUNT_ID', playerList: list, take: AGG_TAKE };
	return cached(`player:peers:${accountId}:${list}:${take}`, AGGREGATE_TTL_MS, async () => {
		const data = await gql<{ player: { matchesGroupBy?: unknown[] | null } | null }>(PEERS_DOCUMENT, {
			id: accountId,
			request,
		});
		const rows = (data.player?.matchesGroupBy ?? []) as Array<{
			steamAccountId?: number | null;
			matchCount?: number | null;
			winCount?: number | null;
			avgImp?: number | null;
			avgKDA?: number | null;
			steamAccount?: { name?: string | null; avatar?: string | null } | null;
		}>;
		return rows
			.filter((row): row is typeof row & { steamAccountId: number } => typeof row.steamAccountId === 'number')
			.map((row) => ({
				accountId: row.steamAccountId,
				name: row.steamAccount?.name?.trim() || `玩家 ${row.steamAccountId}`,
				avatar: row.steamAccount?.avatar ?? '',
				matches: num(row.matchCount),
				wins: num(row.winCount),
				imp: numOrNull(row.avgImp),
				kda: numOrNull(row.avgKDA),
			}))
			// 同队/对抗场次多的排前面，这就是「最常一起玩的人」。
			.sort((a, b) => b.matches - a.matches)
			.slice(0, take);
	});
}

export interface ProgressionData {
	ranks: { seasonRankId: number; rank: number; isCore: boolean; at: number }[];
	names: { name: string; lastSeen: number }[];
	leaderboard: { divisionId: number; rank: number }[];
}

export async function loadPlayerProgression(accountId: number): Promise<ProgressionData> {
	return cached(`player:progression:${accountId}`, AGGREGATE_TTL_MS, async () => {
		const data = await gql<{
			player: {
				ranks?: { seasonRankId?: number | null; rank?: number | null; isCore?: boolean | null; asOfDateTime?: number | null }[] | null;
				names?: { name?: string | null; lastSeenDateTime?: number | null }[] | null;
				leaderboardRanks?: { seasonLeaderBoardDivisionId?: number | null; rank?: number | null }[] | null;
			} | null;
		}>(PROGRESSION_DOCUMENT, { id: accountId });
		const p = data.player;
		return {
			ranks: (p?.ranks ?? [])
				.map((row) => ({
					seasonRankId: num(row.seasonRankId),
					rank: num(row.rank),
					isCore: Boolean(row.isCore),
					at: num(row.asOfDateTime),
				}))
				.sort((a, b) => a.at - b.at),
			names: (p?.names ?? [])
				.map((row) => ({ name: row.name?.trim() || '未知', lastSeen: num(row.lastSeenDateTime) }))
				.sort((a, b) => a.lastSeen - b.lastSeen),
			leaderboard: (p?.leaderboardRanks ?? [])
				.map((row) => ({ divisionId: num(row.seasonLeaderBoardDivisionId), rank: num(row.rank) }))
				.filter((row) => row.rank > 0),
		};
	});
}

/**
 * 地区 id → 名称。STRATZ 的地区表跟着版本变，硬编码容易错位，
 * 所以取一次存 24 小时；取不到就退化成 `地区 N`，不影响其它数字。
 */
export async function loadRegionNames(): Promise<Map<number, string>> {
	return cached('stratz:regions', CONSTANTS_TTL_MS, async () => {
		const data = await gql<{ constants: { regions?: { id?: number | null; name?: string | null }[] | null } }>(
			REGIONS_DOCUMENT,
			{},
		);
		const map = new Map<number, string>();
		for (const region of data.constants?.regions ?? []) {
			if (typeof region.id === 'number' && region.name) map.set(region.id, region.name);
		}
		return map;
	});
}
