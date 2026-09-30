import path from 'node:path';
import { seedEvents } from '../data/tournaments';
import { readCacheJson, writeCacheFile } from './buildCache';
import { reportSource } from './dataHealth';
import { applyEventTiers, tierMapOf } from './leagueTier';
import type { LeagueTierInfo } from './liquipediaParse';
import {
	LIQUIPEDIA_LABEL,
	fetchLiquipediaEventMatches,
	fetchLiquipediaEventTiers,
	fetchLiquipediaMatches,
} from './liquipediaApi';
import { routeSlug } from './routeSlug';
import { isPlaceholderLogo } from './teamLogoSource';
import { localizeTeamLogos } from './teamLogos';
import type {
	DataSource,
	DataSourceStatus,
	EsportsEvent,
	EsportsMatch,
	MatchStatus,
	TeamRef,
	TournamentsBundle,
} from '../data/types';

/**
 * 赛事数据层。
 *
 * 分层原则：
 * 1. Liquipedia 的赛程页提供完整日历——未开赛、进行中、已完场都有，还带 BO 与队标，
 *    所以它是赛事列表的主数据源（原因见 `liquipediaApi.ts`，原来的超凡接口已不再响应）。
 * 2. OpenDota 提供实时进行中的职业对局与赛果，作为实时区块和降级兜底。
 * 3. 两者都失败时读本地缓存，再失败才回退到 `data/tournaments.ts` 的种子数据。
 *
 * 这些接口都没有 CORS 头，只能在构建期由 Node 抓取。抓取结果会落到
 * `.cache/tournaments.json`，保证断网时仍能构建出完整页面。
 */

const OPENDOTA_LIVE_URL = 'https://api.opendota.com/api/live';
const OPENDOTA_PRO_URL = 'https://api.opendota.com/api/proMatches';

const CACHE_FILE = path.join(process.cwd(), '.cache', 'tournaments.json');

const SOURCE_LABEL: Record<DataSource, string> = {
	liquipedia: LIQUIPEDIA_LABEL,
	opendota: 'OpenDota',
	seed: '本地兜底',
};

/**
 * 队伍 id 会变成 `/teams/[id]` 的路径段，所以**只能**用字母数字汉字与连字符。
 *
 * 这里是踩过的坑：`/api/live` 的队名直接进 id，而实时对局里出现过 `team yosi/vape`
 * （还出现过队名就是一个 `?`）。带 `/` 的名字会让 Astro 把 `/teams/od-team-team yosi/vape`
 * 当成两段，抛 `Missing parameter: id` 把**整个构建**打断——线上于是永远停在上一份产物上。
 * Liquipedia 那条线早就用同一套 slug 处理过赛事 id，这条线当时漏了。
 */
const teamPath = (name: string): string => `od-team-${routeSlug(name) || 'team'}`;

/** 数据源中文名，供页面标注出处。 */
export function dataSourceLabel(id: DataSource): string {
	return SOURCE_LABEL[id];
}

// ---------------------------------------------------------------- 请求工具

async function getJson<T>(url: string, init: RequestInit = {}, timeoutMs = 15_000): Promise<T> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const res = await fetch(url, { ...init, signal: controller.signal });
		if (!res.ok) throw new Error(`${url} 返回 HTTP ${res.status}`);
		return (await res.json()) as T;
	} finally {
		clearTimeout(timer);
	}
}

// ---------------------------------------------------------------- OpenDota

interface OpenDotaLive {
	match_id?: string | number;
	league_id?: number;
	activate_time?: number;
	team_name_radiant?: string;
	team_name_dire?: string;
	radiant_score?: number;
	dire_score?: number;
}

interface OpenDotaProMatch {
	match_id?: number;
	start_time?: number;
	/** 0 表示对局尚未结束；缺省时按已结束处理（保持旧行为）。 */
	duration?: number;
	radiant_team_id?: number;
	radiant_name?: string;
	dire_team_id?: number;
	dire_name?: string;
	leagueid?: number;
	league_name?: string;
	radiant_score?: number;
	dire_score?: number;
	radiant_win?: boolean;
}

/** 只用带真实队名的对局——其余是路人局，对赛事页没有意义。 */
async function fetchOpenDotaLive(): Promise<EsportsMatch[]> {
	/*
	 * 这是全站唯一「拿不到就没有实时区块」的来源，而它在构建期并不稳定：同一台机器上单独的
	 * 请求是 200（实测 0.7 秒、11 场进行中），构建里却常常失败——构建期有几十个请求同时飞。
	 * 所以给它重试，并把每次失败的原因打进构建日志：页面上只显示「0 场进行中」，
	 * 不说清是「真没有」还是「没取到」，查起来得从头翻一遍构建记录。
	 */
	let lastError: unknown = new Error('未知错误');
	for (let attempt = 1; attempt <= 3; attempt += 1) {
		try {
			return await loadOpenDotaLive();
		} catch (error) {
			lastError = error;
			if (attempt < 3) {
				console.warn(`[tournaments] OpenDota /api/live 第 ${attempt} 次失败：${error instanceof Error ? error.message : String(error)}`);
				await new Promise((resolve) => setTimeout(resolve, 600 * attempt));
			}
		}
	}
	throw lastError;
}

async function loadOpenDotaLive(): Promise<EsportsMatch[]> {
	const list = await getJson<OpenDotaLive[]>(OPENDOTA_LIVE_URL);
	const out: EsportsMatch[] = [];
	for (const item of list) {
		if (!item.team_name_radiant || !item.team_name_dire) continue;
		out.push({
			id: `od-live-${item.match_id}`,
			eventId: `od-league-${item.league_id ?? 0}`,
			eventName: item.league_id ? `职业联赛 #${item.league_id}` : '职业对局',
			/*
			 * `activate_time` 是 0 时说明还没定开赛时间，用当前时刻兜底——`??` 挡不住 0
			 * （它只挡 null / undefined），照原样传下去卡片上会印出 1970 年。
			 * 进行中的比赛本来就是"现在在打"，取当前时刻语义也对。
			 */
			startTime: item.activate_time || Math.floor(Date.now() / 1000),
			status: 'live',
			home: { id: teamPath(item.team_name_radiant), name: item.team_name_radiant, score: item.radiant_score },
			away: { id: teamPath(item.team_name_dire), name: item.team_name_dire, score: item.dire_score },
			source: 'opendota',
		});
	}
	return out;
}

async function fetchOpenDotaPro(): Promise<EsportsMatch[]> {
	const list = await getJson<OpenDotaProMatch[]>(OPENDOTA_PRO_URL);
	return list
		.filter((item) => item.radiant_name && item.dire_name && item.start_time)
		.map((item) => {
			// duration > 0 才是真正打完的对局；缺省 duration 时按已结束处理，保持旧行为。
			const finished = typeof item.duration !== 'number' || item.duration > 0;
			const home: TeamRef = {
				// 有数字 id 就用它（路径安全），没有才退回队名——退回时必须过 slug。
				id: item.radiant_team_id ? `od-team-${item.radiant_team_id}` : teamPath(item.radiant_name!),
				name: item.radiant_name!,
				score: item.radiant_score,
			};
			const away: TeamRef = {
				id: item.dire_team_id ? `od-team-${item.dire_team_id}` : teamPath(item.dire_name!),
				name: item.dire_name!,
				score: item.dire_score,
			};
			// 只有打完的对局才判胜负；radiant_win 缺省时不要凭空造一个胜者。
			let winner: EsportsMatch['winner'];
			if (finished) {
				if (item.radiant_win === true) winner = 'home';
				else if (item.radiant_win === false) winner = 'away';
			}
			return {
				id: `od-${item.match_id}`,
				eventId: `od-league-${item.leagueid ?? 0}`,
				eventName: item.league_name?.trim() || '职业比赛',
				startTime: item.start_time!,
				status: finished ? ('completed' as const) : ('live' as const),
				home,
				away,
				winner,
				source: 'opendota' as const,
			};
		});
}

// ---------------------------------------------------------------- 组装

/** 归一化队名，用于跨数据源判重。 */
function normTeam(name: string): string {
	return name.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]/g, '');
}

/**
 * 判断两场比赛是否为"同一场"。
 *
 * 必须**两支队伍都重合**：只按一支队伍判重时，同一赛事里 A vs B、A vs C 这种
 * 相隔几小时的小组赛会被误判成重复而被丢掉。
 */
function isSameMatch(a: EsportsMatch, b: EsportsMatch): boolean {
	const aTeams = new Set([normTeam(a.home.name), normTeam(a.away.name)]);
	const bTeams = [normTeam(b.home.name), normTeam(b.away.name)];
	if (aTeams.size < 2) return false;
	if (!bTeams.every((name) => name !== '' && aTeams.has(name))) return false;
	// 两场比赛在同一时间窗口内且双方队伍都一致，视为同一场。
	return Math.abs(a.startTime - b.startTime) < 6 * 3600;
}

function dedupeMatches(matches: EsportsMatch[]): EsportsMatch[] {
	const out: EsportsMatch[] = [];
	for (const match of matches) {
		if (out.some((kept) => isSameMatch(kept, match))) continue;
		out.push(match);
	}
	return out;
}

/**
 * 从 `sourceUrl` 取回 Liquipedia 的页面路径（去掉主机与锚点），给赛事页补全用。
 * 只认站内自己拼出来的 liquipedia 链接，不是用户输入。
 */
function liquipediaPagePath(match: EsportsMatch): string {
	if (match.source !== 'liquipedia' || !match.sourceUrl) return '';
	return match.sourceUrl.match(/^https:\/\/liquipedia\.net\/dota2\/(.+)$/)?.[1] ?? '';
}

function eventStatus(matches: EsportsMatch[]): MatchStatus {
	if (matches.some((m) => m.status === 'live')) return 'live';
	if (matches.some((m) => m.status === 'upcoming')) return 'upcoming';
	// 延期/中断的场次不应把已经打完的赛事永久钉在"即将开始"；
	// 只有全部场次都延期时，才认为赛事还没开赛。
	if (matches.length > 0 && matches.every((m) => m.status === 'postponed')) return 'upcoming';
	return 'completed';
}

function buildEvents(matches: EsportsMatch[]): EsportsEvent[] {
	const groups = new Map<string, EsportsMatch[]>();
	for (const match of matches) {
		const bucket = groups.get(match.eventId);
		if (bucket) bucket.push(match);
		else groups.set(match.eventId, [match]);
	}

	const events: EsportsEvent[] = [];
	for (const [id, group] of groups) {
		const sorted = [...group].sort((a, b) => a.startTime - b.startTime);
		const teams = new Map<string, TeamRef>();
		for (const match of sorted) {
			for (const team of [match.home, match.away]) {
				const key = normTeam(team.name);
				const existing = teams.get(key);
				if (existing) {
					if (!existing.logo && team.logo) existing.logo = team.logo;
				} else {
					teams.set(key, { ...team, score: undefined });
				}
			}
		}
		events.push({
			id,
			name: sorted[0].eventName,
			status: eventStatus(sorted),
			startTime: sorted[0].startTime,
			endTime: sorted[sorted.length - 1].startTime,
			matches: sorted,
			teams: [...teams.values()],
			source: sorted[0].source,
			sourceUrl: sorted[0].sourceUrl,
		});
	}
	return events;
}

const STATUS_ORDER: Record<MatchStatus, number> = { live: 0, upcoming: 1, postponed: 2, completed: 3 };

function sortEvents(events: EsportsEvent[]): EsportsEvent[] {
	return [...events].sort((a, b) => {
		const byStatus = STATUS_ORDER[a.status] - STATUS_ORDER[b.status];
		if (byStatus !== 0) return byStatus;
		// 进行中/未开赛按最近的排前面，已结束按刚打完的排前面。
		return a.status === 'completed' ? b.endTime - a.endTime : a.startTime - b.startTime;
	});
}

// ---------------------------------------------------------------- 缓存

async function readCache(): Promise<TournamentsBundle | null> {
	const hit = await readCacheJson<TournamentsBundle>(CACHE_FILE, (value) => {
		const bundle = value as TournamentsBundle;
		return Array.isArray(bundle?.events) && bundle.events.length > 0;
	});
	return hit?.value ?? null;
}

function writeCache(bundle: TournamentsBundle): Promise<void> {
	return writeCacheFile(CACHE_FILE, JSON.stringify(bundle));
}

// ---------------------------------------------------------------- 缓存刷新

/**
 * 缓存里"未开始/进行中"的对阵超过这个时长就不可能还成立。
 * 用来丢弃结果已经不可知的陈旧条目，避免把早已打完的比赛继续显示成未开赛。
 */
const STALE_PENDING_SECONDS = 6 * 3600;

/**
 * 用最新的 OpenDota 赛果刷新上次成功的日历。
 *
 * 匹配规则与实时判重一致（双方队伍都相同且开赛时间接近），匹配不上就保留缓存原样；
 * 既没匹配到新赛果、又早已超过开赛时间的"未开始/进行中"条目直接丢弃——结果不可知，
 * 继续展示只会给出错误状态（延期场次不受影响）。
 */
function refreshCachedMatches(cached: EsportsMatch[], fresh: EsportsMatch[], nowSec: number): EsportsMatch[] {
	const remaining = [...fresh];
	const out: EsportsMatch[] = [];
	for (const match of cached) {
		const index = remaining.findIndex((candidate) => isSameMatch(match, candidate));
		let next = match;
		if (index !== -1) {
			const [result] = remaining.splice(index, 1);
			next = {
				...match,
				status: result.status,
				home: { ...match.home, score: result.home.score },
				away: { ...match.away, score: result.away.score },
				winner: result.winner,
			};
		}
		if (
			(next.status === 'upcoming' || next.status === 'live') &&
			next.startTime + STALE_PENDING_SECONDS < nowSec
		) {
			continue;
		}
		out.push(next);
	}
	return out;
}

// ---------------------------------------------------------------- 对外入口

function sourceStatus(id: DataSource, ok: boolean, label?: string): DataSourceStatus {
	return { id, label: label ?? SOURCE_LABEL[id], ok };
}

/**
 * 记录本轮结果并原样返回。
 * 日历有四个返回点（正常、缓存刷新、种子兜底），集中在这一层上报，避免漏报。
 */
async function assemble(): Promise<TournamentsBundle> {
	const bundle = await assembleBundle();
	const events = bundle.events.length;
	const state = bundle.degraded ? (events > 0 ? 'cache' : 'empty') : 'fresh';
	const sources = bundle.sources.map((source) => `${source.label}${source.ok ? '' : '（不可用）'}`).join(' / ');
	await reportSource('tournaments', '赛事日历', state, `${events} 个赛事，${bundle.live.length} 场进行中；来源：${sources}`);
	return bundle;
}

async function assembleBundle(): Promise<TournamentsBundle> {
	const updatedAt = new Date().toISOString();
	const nowSec = Math.floor(Date.now() / 1000);

	let opendotaOk = false;
	/**
	 * 日历是否**真的**来自 Liquipedia。
	 * 不能只看 `allSettled` 是否 fulfilled：空列表同样会让数据实际来自 OpenDota 兜底，
	 * 那种情况既不该标成健康，也不该写进缓存。
	 */
	let calendarFromPrimary = false;
	let calendarMatches: EsportsMatch[] = [];
	let opendotaLive: EsportsMatch[] = [];
	let proMatches: EsportsMatch[] = [];
	/** 赛事 id → 档位。取不到就是空表，页面上不显示档位徽章。 */
	const eventTiers = new Map<string, LeagueTierInfo>();

	// `TOURNAMENTS_OFFLINE=1` 跳过所有网络请求，直接走缓存/兜底，
	// 便于在无网络环境下构建，也用于验证降级链路。
	if (process.env.TOURNAMENTS_OFFLINE !== '1') {
		// 赛事日历与实时对局并行抓取，任意一个失败都不影响另一个。
		// Liquipedia 的赛程页自带 30 分钟缓存，一次构建最多发一个请求。
		const [calendarRes, liveRes] = await Promise.allSettled([fetchLiquipediaMatches(), fetchOpenDotaLive()]);
		// 先落到局部常量再取 value：把结果存进布尔变量后 TypeScript 就无法收窄联合类型了。
		const calendarOk = calendarRes.status === 'fulfilled';
		const liveOk = liveRes.status === 'fulfilled';
		opendotaOk = liveOk;
		calendarMatches = calendarOk ? calendarRes.value : [];
		calendarFromPrimary = calendarMatches.length > 0;
		opendotaLive = liveOk ? liveRes.value : [];

		/*
		 * 补全整届赛事。主表是滚动窗口，一届赛事打了一周之后前面的对阵就滚出去了，
		 * 赛事页（含小组赛这类阶段子页）才是完整的。
		 *
		 * 主表那份排在前面：它的状态与比分随每轮重建更新，赛事页补的是主表没有的历史。
		 * 补全失败不影响主表那份——顶多是赛事页少几场旧对阵。
		 */
		if (calendarMatches.length > 0) {
			const pages = calendarMatches.map(liquipediaPagePath).filter(Boolean);
			try {
				const complete = await fetchLiquipediaEventMatches(pages);
				calendarMatches = dedupeMatches([...calendarMatches, ...complete]);
			} catch {
				// 上游抖动：照旧用主表那份。
			}

			/*
			 * 赛事档位。同样是上面那批页面，但**按赛事根页面取**——阶段子页上没有 Infobox
			 * （实测 `PGL/Wallachia/9/Group_Stage` 就没有那一行），`fetchLiquipediaEventTiers`
			 * 内部会归到根页面。
			 *
			 * 档位是附加信息：取不到就算了，日历与对阵照常展示，只是没有档位徽章。
			 */
			try {
				const tiers = await fetchLiquipediaEventTiers(pages);
				// 键统一成站内赛事 id，和 `parseMatchBlock` 里的 `eventId` 是同一条规则。
				for (const [page, info] of tiers) eventTiers.set(routeSlug(page), info);
			} catch {
				// 同上，不影响日历。
			}
		}

		if (calendarMatches.length === 0) {
			// 主源不可用：赛果先留着，既能刷新缓存日历，也是没有缓存时的兜底日历。
			try {
				proMatches = await fetchOpenDotaPro();
				if (proMatches.length > 0) opendotaOk = true;
			} catch {
				proMatches = [];
			}
		}
	}

	// 主源不可用时优先复用上次成功的日历：它比 proMatches 结构完整得多（有赛事分组、
	// BO 与队标），缺点只是状态是快照，所以用最新赛果刷新一遍再展示。
	if (calendarMatches.length === 0) {
		const cached = await readCache();
		const cachedMatches = cached?.events.flatMap((event) => event.matches ?? []) ?? [];
		const refreshed = refreshCachedMatches(cachedMatches, proMatches, nowSec);
		if (cached && refreshed.length > 0) {
			const events = sortEvents(buildEvents(refreshed));
			/*
			 * 档位挂**赛事**上、不在对阵上，这一轮又没抓页面——只能从缓存里那份赛事还原。
			 * 不还原的后果实测过：离线构建那一轮所有赛事都没档位徽章，档位筛选把每届都归进
			 * 「其他」，而数据其实就在缓存里。
			 */
			applyEventTiers(events, tierMapOf(cached.events));
			return {
				events,
				live: dedupeMatches([...(cached.live ?? []), ...opendotaLive]),
				updatedAt: cached.updatedAt,
				degraded: true,
				sources: [
					sourceStatus('liquipedia', false),
					sourceStatus('opendota', opendotaOk),
					sourceStatus('seed', true, '本地缓存'),
				],
			};
		}
		// 没有缓存、或缓存已经全部过期时，才退到 OpenDota 的赛果列表。
		calendarMatches = proMatches;
	}

	if (calendarMatches.length === 0) {
		return {
			events: sortEvents(seedEvents()),
			live: dedupeMatches(opendotaLive),
			updatedAt,
			degraded: true,
			sources: [sourceStatus('liquipedia', false), sourceStatus('opendota', opendotaOk), sourceStatus('seed', true)],
		};
	}

	const events = sortEvents(buildEvents(calendarMatches));
	applyEventTiers(events, eventTiers);

	const bundle: TournamentsBundle = {
		events,
		live: dedupeMatches([...calendarMatches.filter((m) => m.status === 'live'), ...opendotaLive]),
		updatedAt,
		degraded: !calendarFromPrimary,
		sources: [sourceStatus('liquipedia', calendarFromPrimary), sourceStatus('opendota', opendotaOk)],
	};

	// 只有拿到主源的完整日历才写缓存；OpenDota 兜底的结果不值得留，否则会污染缓存。
	if (calendarFromPrimary) await writeCache(bundle);
	return bundle;
}

let bundlePromise: Promise<TournamentsBundle> | null = null;

/**
 * 把外链队标换成本站路径。
 *
 * 放在这里而不是各页面里：`MatchRow`、`/matches/[id]`、`/tournaments/[id]`、`/teams/[id]`
 * 四个地方都要队标，拿到的是同一批 `TeamRef`。在各页面上分别做一次等于同一张图检查四遍，
 * 而且一定会漏掉一处，漏掉的表现是"只有那个页面还在热链"。
 *
 * 只改**内存里这一份**：落进 `.cache/tournaments.json` 的仍是原始外链。那是数据缓存，
 * 混进构建产物路径之后，离线构建会拿到一堆 `dist/` 里其实没有的地址。
 *
 * 拿不到字节就保留原外链，和 `covers.ts` 一样——不会比改造前更差。
 */
async function localizeLogos(bundle: TournamentsBundle): Promise<TournamentsBundle> {
	/*
	 * 这里刻意**不去重**：一支队在 bundle 里是一堆各自独立的 `TeamRef` 对象（每场对阵两个），
	 * 而本地化只下一张。去重成"每队一个引用"的话，只有那一个对象被改写，同一支队在别的
	 * 对阵里的引用还留着外链——线上表现是一部分页面对了、另一部分还在热链。
	 * 做法是：交给 `localizeTeamLogos` 去重下载（它取最宽的那张），这里再把**每一个**引用
	 * 都指到同一个站内地址上。
	 *
	 * `event.teams` 也要收：那是 `buildEvents()` 按队名归并出来的**拷贝**（`{ ...team }`），
	 * 不是对阵里那些对象，漏掉它赛事页的「参赛队伍」那一栏就还是热链——实测漏过一次。
	 */
	const refs: TeamRef[] = [];
	for (const event of bundle.events) {
		refs.push(...event.teams);
		for (const match of event.matches) refs.push(match.home, match.away);
	}
	for (const match of bundle.live) refs.push(match.home, match.away);

	const local = await localizeTeamLogos(refs);
	for (const team of refs) {
		const path = local.get(team.id);
		if (path) team.logo = path;
		// 占位图不是这支队自己的队标，去掉，让页面退回首字母（判据见 `teamLogoSource.ts`）。
		else if (isPlaceholderLogo(team.logo)) delete team.logo;
	}

	return bundle;
}

/**
 * 取赛事数据。构建期多个页面（列表页、详情页的 getStaticPaths）会重复调用，
 * 这里用模块级 Promise 做单飞，保证一次构建只抓一轮。
 *
 * 单飞要盖住本地化这一步：`assemble()` 之后、任何页面拿到 bundle 之前必须已经换好路径，
 * 否则先渲染的那个页面会拿到外链、后渲染的拿到本地路径——同一轮构建两种结果。
 */
export function getTournaments(): Promise<TournamentsBundle> {
	bundlePromise ??= assemble().then(localizeLogos);
	return bundlePromise;
}
