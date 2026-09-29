import path from 'node:path';
import type { EsportsMatch } from '../data/types';
import { readCacheJson, writeCacheFile } from './buildCache';
import type { LeagueTierInfo, TeamRoster } from './liquipediaParse';
import { eventPathOf, parseBracketMatches, parseLeagueTier, parseMatches, parseTeamRoster } from './liquipediaParse';

/**
 * Liquipedia 赛事日历（MediaWiki `action=parse`）。
 *
 * 为什么换源：原来的 `api-pc.chaofan.com` 已经不再响应——DNS、TCP 与 TLS 都正常，
 * 但请求发出去一个字节都不回；同一个路径换到 `api.chaofan.com` 会立刻返回
 * `{"code":100009,"msg":"签名错误"}`，说明服务活着但那个 vhost 要签名。实测同一时间窗内
 * api-pc 0/6 成功、api.chaofan.com 根路径 6/6 成功。
 *
 * 为什么是 Liquipedia：`Liquipedia:Matches` 一个页面同时给出未来赛程与已完赛结果，
 * 正是日历需要的东西（OpenDota 只有已结束的比赛，STRATZ 的 leagues 只有跨年长期赛事）。
 *
 * 使用条款（liquipedia.net/api-terms-of-use）：
 * - 必须带能识别调用方的 User-Agent，不带直接 406；联系信息用 `LIQUIPEDIA_CONTACT` 配；
 * - `action=parse` 是重接口，靠缓存把频率压到每次构建一次；
 * - 必须署名并链接回 Liquipedia，页面上的来源标注与赛事链接就是为此。
 */

const API = 'https://liquipedia.net/dota2/api.php';
/** 赛程页；`Liquipedia:Upcoming_and_ongoing_matches` 是它的重定向。 */
const PAGE = 'Liquipedia:Matches';
/** 署名与回链用的地址。 */
export const LIQUIPEDIA_SOURCE_URL = 'https://liquipedia.net/dota2/Liquipedia:Matches';
export const LIQUIPEDIA_LABEL = 'Liquipedia';

const CONTACT = (process.env.LIQUIPEDIA_CONTACT ?? '').trim();
/**
 * Liquipedia 明确要求 User-Agent 能标识调用方并带上联系方式，否则一律 406。
 * 没有配 `LIQUIPEDIA_CONTACT` 时仍然能用，但建议补上。
 */
const USER_AGENT = CONTACT ? `dota2-news-portal/1.0 (contact: ${CONTACT})` : 'dota2-news-portal/1.0';

const CACHE_FILE = path.join(process.cwd(), '.cache', 'liquipedia', 'matches.json');
/** 赛程页本身有 2 分钟左右的缓存，这里 30 分钟足够，也把请求频率压到最低。 */
const TTL_SECONDS = 30 * 60;
const OFFLINE = process.env.TOURNAMENTS_OFFLINE === '1';

/**
 * 解析结果的缓存版本。**给解析出来的对象加字段就要加一。**
 *
 * 缓存里存的是**解析后**的 `EsportsMatch`，老缓存不会自己长出字段：给队伍加 `wiki`
 * （战队页取名单要用它）那次忘了升版本，于是那一轮构建吃到旧缓存，全站队伍都拿不到名单，
 * 而构建汇总还写着「联网抓取」——看着像上游的问题，实际是拿了一份旧形状的数据。
 * 同一个坑 `roomList.ts` 里踩过，处理办法也一样：版本对不上就当没有。
 */
const CACHE_VERSION = 3;

interface CacheEntry {
	v?: number;
	at: number;
	value: EsportsMatch[];
}

async function readCache(): Promise<CacheEntry | null> {
	const hit = await readCacheJson<CacheEntry>(CACHE_FILE, (value) => {
		const entry = value as CacheEntry;
		return entry?.v === CACHE_VERSION && typeof entry.at === 'number' && Array.isArray(entry.value);
	});
	return hit?.value ?? null;
}

function writeCache(value: EsportsMatch[]): Promise<void> {
	return writeCacheFile(CACHE_FILE, JSON.stringify({ v: CACHE_VERSION, at: Date.now(), value }));
}

/** 解析一个页面。`page` 只由站内自己拼出来的路径传入（赛事页补全见下），不是用户输入。 */
async function fetchPage(page: string = PAGE): Promise<string | null> {
	const url = `${API}?action=parse&format=json&page=${encodeURIComponent(page)}`;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 45_000);
	try {
		const res = await fetch(url, { signal: controller.signal, headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' } });
		if (!res.ok) return null;
		const body = (await res.json()) as { parse?: { text?: { '*'?: string } }; error?: unknown };
		if (body.error) return null;
		return body.parse?.text?.['*'] ?? null;
	} catch {
		return null;
	} finally {
		clearTimeout(timer);
	}
}

let matchesPromise: Promise<EsportsMatch[]> | null = null;

/**
 * 赛程与赛果。一次构建最多发一个请求（命中缓存则不发），失败时退回过期缓存；
 * 拿不到就返回空数组，由 `tournamentsApi` 继续往下降级。
 */
export function fetchLiquipediaMatches(): Promise<EsportsMatch[]> {
	matchesPromise ??= (async () => {
		const cached = await readCache();
		if (cached && Date.now() - cached.at < TTL_SECONDS * 1000) return cached.value;
		if (OFFLINE) return cached?.value ?? [];

		const html = await fetchPage();
		if (!html) return cached?.value ?? [];

		const matches = parseMatches(html, Math.floor(Date.now() / 1000));
		if (matches.length === 0) return cached?.value ?? [];
		await writeCache(matches);
		return matches;
	})();
	return matchesPromise;
}

/*
 * ---- 赛事页补全 ------------------------------------------------------------------
 *
 * 主赛程页是**滚动窗口**，它只保证「未来赛程 + 近期赛果」；一届赛事打了一周之后，前面的对阵
 * 就滚出去了。读者点进赛事页看到的于是只是其中一角——「PGL Wallachia 9 显示即将开始、
 * 9013522151 不在列表里」就是这一类。
 *
 * 赛事页（含阶段子页）才是完整的，所以按主表里出现过的页面路径再补一遍。抓哪些页面完全由
 * 已有数据决定，不做「遍历所有赛事」那种事——那是拿别人的重接口当爬虫。
 */

const EVENT_CACHE_FILE = path.join(process.cwd(), '.cache', 'liquipedia', 'events.json');
/** 赛事页变得慢（对阵公布、比分陆续补上），而且它补的是已经滚出去的历史，缓存给到 6 小时。 */
const EVENT_TTL_SECONDS = 6 * 3600;
/** 一轮构建最多补几个页面：这是在别人家的重接口上花钱，宁可少抓几个。 */
const MAX_EVENT_PAGES = 8;
/** 两次赛事页请求之间的间隔，Liquipedia 的 API 条款要求低频调用。 */
const EVENT_PAGE_GAP_MS = 1200;

interface EventCacheEntry {
	v?: number;
	at: number;
	matches: EsportsMatch[];
}

type EventCache = Record<string, EventCacheEntry>;

async function readEventCache(): Promise<EventCache> {
	const hit = await readCacheJson<EventCache>(EVENT_CACHE_FILE, (value) => typeof value === 'object' && value !== null);
	if (!hit) return {};
	// 形状变过的条目当没有（见 `CACHE_VERSION`）：老条目里的对阵没有 `wiki` 字段。
	return Object.fromEntries(Object.entries(hit.value).filter(([, entry]) => entry?.v === CACHE_VERSION));
}

function writeEventCache(cache: EventCache): Promise<void> {
	return writeCacheFile(EVENT_CACHE_FILE, JSON.stringify(cache));
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

let eventMatchesPromise: Promise<EsportsMatch[]> | null = null;

/**
 * 给定主表里出现过的页面路径，取回这些页面的完整对阵。
 *
 * 拿不到页面一律**退回旧缓存**、连缓存都没有就跳过——补全失败不该让赛事页整块消失，
 * 主表那份数据照常展示。
 */
export function fetchLiquipediaEventMatches(pagePaths: string[]): Promise<EsportsMatch[]> {
	eventMatchesPromise ??= loadEventMatches(pagePaths);
	return eventMatchesPromise;
}

async function loadEventMatches(pagePaths: string[]): Promise<EsportsMatch[]> {
	const wanted = [...new Set(pagePaths.map((pagePath) => pagePath.trim()).filter(Boolean))].slice(0, MAX_EVENT_PAGES);
	if (wanted.length === 0) return [];

	const cache = await readEventCache();
	const nowSec = Math.floor(Date.now() / 1000);
	// 只留这一轮要用的键：赛事结束后它的页面自然从缓存里消失，不会越攒越多。
	const next: EventCache = {};
	const out: EsportsMatch[] = [];
	let fetched = 0;

	for (const pagePath of wanted) {
		const cached = cache[pagePath];
		const carry = (): void => {
			if (!cached) return;
			next[pagePath] = cached;
			out.push(...cached.matches);
		};

		if (cached && Date.now() - cached.at < EVENT_TTL_SECONDS * 1000) {
			carry();
			continue;
		}
		if (OFFLINE) {
			carry();
			continue;
		}
		// 第二次请求起才等：大多数轮次整页命中缓存，不该平白多等。
		if (fetched > 0) await sleep(EVENT_PAGE_GAP_MS);
		fetched += 1;

		const html = await fetchPage(pagePath);
		if (!html) {
			carry();
			continue;
		}
		const matches = parseBracketMatches(html, pagePath, nowSec);
		if (matches.length === 0) {
			carry();
			continue;
		}
		next[pagePath] = { v: CACHE_VERSION, at: Date.now(), matches };
		out.push(...matches);
	}

	await writeEventCache(next);
	return out;
}

/*
 * ---- 赛事档位 --------------------------------------------------------------------
 *
 * 档位（Tier 1–4）在赛事页的 Infobox 里，用来回答"这支队算不算一线队"——
 * 判据与理由见 `lib/leagueTier.ts`。
 *
 * **抓根页面，不抓阶段子页**：实测阶段子页上没有 Infobox（`PGL/Wallachia/9/Group_Stage`
 * 就没有），而 `sourceUrl` 恰恰常常指向子页。所以这里统一按 `eventPathOf()` 归到根页面。
 */

const TIER_CACHE_FILE = path.join(process.cwd(), '.cache', 'liquipedia', 'tiers.json');
/**
 * 档位几乎不变（Liquipedia 定档之后就不动了），缓存给一周。
 *
 * 第一次引入这个字段时每届赛事多一次请求，之后就都是命中缓存——所以
 * `EVENT_PAGE_GAP_MS` 那条节流也照旧用，不因为"反正只有一次"就把节奏放开。
 */
const TIER_TTL_SECONDS = 7 * 24 * 3600;
/**
 * 「附加信息」那几条流的请求间隔：档位、战队名单。
 *
 * **刻意比 `EVENT_PAGE_GAP_MS`（1.2s）长**：每条流各自节流，赛事页补全那批刚跑完、
 * 这边紧接着又是一串，对方看到的是几批加起来的频率。第一次跑就中过一招——5 个赛事的档位
 * 请求里 1 个没拿到页面（路径在输入里、缓存里没有），赛事页上那届于是整轮没有档位徽章。
 */
const SLOW_PAGE_GAP_MS = 2000;
/**
 * 取不到页面时再试一次。
 *
 * 失败**不写缓存**，所以下一轮本来就会补上——但"下一轮"对读者来说就是这一届赛事一直不显示
 * 档位，而档位筛选里它还会被归到「其他」。多花一次请求换当场补上，划算。
 */
const TIER_FETCH_ATTEMPTS = 2;

interface TierCacheEntry {
	v?: number;
	at: number;
	/** 取到了页面、但页面上没有档位时也记一笔，免得每轮都白问一次。 */
	tier?: LeagueTierInfo;
}

type TierCache = Record<string, TierCacheEntry>;

async function readTierCache(): Promise<TierCache> {
	const hit = await readCacheJson<TierCache>(TIER_CACHE_FILE, (value) => typeof value === 'object' && value !== null);
	if (!hit) return {};
	return Object.fromEntries(Object.entries(hit.value).filter(([, entry]) => entry?.v === CACHE_VERSION));
}

function writeTierCache(cache: TierCache): Promise<void> {
	return writeCacheFile(TIER_CACHE_FILE, JSON.stringify(cache));
}

let eventTiersPromise: Promise<Map<string, LeagueTierInfo>> | null = null;

/**
 * 赛事档位，键是**赛事根页面路径**（如 `PGL/Wallachia/9`，阶段子页归到它）。
 *
 * 拿不到的赛事不会出现在返回值里——调用方据此不显示档位徽章，这不算故障。
 * 页面数量与赛事页补全共用同一个上限（见 `MAX_EVENT_PAGES`）：都是在别人的重接口上花钱。
 */
export function fetchLiquipediaEventTiers(pagePaths: string[]): Promise<Map<string, LeagueTierInfo>> {
	eventTiersPromise ??= loadEventTiers(pagePaths);
	return eventTiersPromise;
}

async function loadEventTiers(pagePaths: string[]): Promise<Map<string, LeagueTierInfo>> {
	const roots = [...new Set(pagePaths.map(eventPathOf))].filter(Boolean).slice(0, MAX_EVENT_PAGES);
	const out = new Map<string, LeagueTierInfo>();
	if (roots.length === 0) return out;

	const cache = await readTierCache();
	const next: TierCache = {};
	let fetched = 0;

	for (const root of roots) {
		const cached = cache[root];
		const carry = (): void => {
			if (!cached) return;
			next[root] = cached;
			if (cached.tier) out.set(root, cached.tier);
		};

		if (cached && Date.now() - cached.at < TIER_TTL_SECONDS * 1000) {
			carry();
			continue;
		}
		if (OFFLINE) {
			carry();
			continue;
		}
		let html: string | null = null;
		for (let attempt = 0; attempt < TIER_FETCH_ATTEMPTS && !html; attempt += 1) {
			// 第一次请求起就等（`fetched` 计数跨赛事累加），重试也照等。
			if (fetched > 0) await sleep(SLOW_PAGE_GAP_MS);
			fetched += 1;
			html = await fetchPage(root);
		}
		if (!html) {
			carry();
			continue;
		}
		const tier = parseLeagueTier(html);
		next[root] = { v: CACHE_VERSION, at: Date.now(), tier };
		if (tier) out.set(root, tier);
	}

	await writeTierCache(next);
	return out;
}

/*
 * ---- 战队名单 --------------------------------------------------------------------
 *
 * 现役五人 + 替补 + 教练组，来自各队战队页的 wikitext（解析见 `parseTeamRoster`）。
 *
 * 为什么不用 OpenDota 的 `/teams/<id>/players`：那个接口给的是**历史全量**——实测 Team Liquid
 * 名下同时有现役的 miCKe、Boxi、tOfu，也有几年前的 Miracle-、GH、kky，连教练 Jabbz 都被
 * 标成"在队"。页面上看着就是"名单不完整、又混着离队的人"。Liquipedia 的名单是人工维护的。
 *
 * 取数用 `action=query`（轻接口）而不是 `action=parse`（重接口），并且**一次带 50 个标题**：
 * 整个站点几十支队伍两批就取完，一轮构建最多两个请求，之后 12 小时都吃缓存。
 * Liquipedia 的 API 条款要求低频调用，这条比按队逐个抓省得多。
 */

const ROSTER_CACHE_FILE = path.join(process.cwd(), '.cache', 'liquipedia', 'rosters.json');
/** 名单只在转会期变，12 小时足够；站点每 30 分钟重建一次，绝大多数轮次是零请求。 */
const ROSTER_TTL_SECONDS = 12 * 3600;
/** MediaWiki 的 `titles=` 一次上限 50。 */
const ROSTER_BATCH = 50;

interface RosterCacheEntry {
	v?: number;
	at: number;
	/** 取到页面但没有名单时也记一笔，免得每轮都白问。 */
	roster?: TeamRoster;
}

type RosterCache = Record<string, RosterCacheEntry>;

async function readRosterCache(): Promise<RosterCache> {
	const hit = await readCacheJson<RosterCache>(ROSTER_CACHE_FILE, (value) => typeof value === 'object' && value !== null);
	if (!hit) return {};
	return Object.fromEntries(Object.entries(hit.value).filter(([, entry]) => entry?.v === CACHE_VERSION));
}

function writeRosterCache(cache: RosterCache): Promise<void> {
	return writeCacheFile(ROSTER_CACHE_FILE, JSON.stringify(cache));
}

interface WikitextQuery {
	query?: {
		/** 标题是重定向时，MediaWiki 会给出 from → to。 */
		redirects?: { from: string; to: string }[];
		pages?: { title: string; missing?: boolean; revisions?: { slots?: { main?: { content?: string } } }[] }[];
	};
	error?: unknown;
}

/** 比较标题时忽略下划线、大小写与多余空白——我们手里的路径和返回的标题写法不一定一样。 */
const titleKey = (title: string): string => title.replace(/_/g, ' ').trim().toLowerCase();

/**
 * 批量取 wikitext，返回 `请求用的标题 → 正文`。
 *
 * 返回 null 表示这一批**整批失败**（网络/上游抖动），调用方据此退回过期缓存；
 * 请求成功但某个标题不存在，则不会出现在返回值里——那是"这支队没被收录"，不是故障。
 */
async function fetchWikitext(titles: string[]): Promise<Map<string, string> | null> {
	const url = `${API}?action=query&format=json&formatversion=2&prop=revisions&rvprop=content&rvslots=main&titles=${encodeURIComponent(titles.join('|'))}`;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 45_000);
	try {
		const res = await fetch(url, { signal: controller.signal, headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' } });
		if (!res.ok) return null;
		const body = (await res.json()) as WikitextQuery;
		if (body.error || !body.query) return null;

		const redirects = new Map((body.query.redirects ?? []).map((item) => [titleKey(item.from), item.to]));
		const pages = new Map((body.query.pages ?? []).map((page) => [titleKey(page.title), page]));
		const out = new Map<string, string>();
		for (const title of titles) {
			const finalTitle = redirects.get(titleKey(title)) ?? title;
			const content = pages.get(titleKey(finalTitle))?.revisions?.[0]?.slots?.main?.content;
			if (typeof content === 'string' && content.length > 0) out.set(title, content);
		}
		return out;
	} catch {
		return null;
	} finally {
		clearTimeout(timer);
	}
}

let teamRostersPromise: Promise<Map<string, TeamRoster>> | null = null;

/**
 * 战队名单，键是**Liquipedia 页面标题**（`Team_Liquid`，取自对阵页里那条队伍链接的 href）。
 * 页面上没有名单、或页面不存在时不会出现在返回值里。
 */
export function fetchLiquipediaTeamRosters(wikiPaths: string[]): Promise<Map<string, TeamRoster>> {
	teamRostersPromise ??= loadTeamRosters(wikiPaths);
	return teamRostersPromise;
}

async function loadTeamRosters(wikiPaths: string[]): Promise<Map<string, TeamRoster>> {
	const wanted = [...new Set(wikiPaths.map((page) => page.trim()).filter(Boolean))];
	const out = new Map<string, TeamRoster>();
	if (wanted.length === 0) return out;

	const cache = await readRosterCache();
	const next: RosterCache = {};
	const stale: string[] = [];
	for (const page of wanted) {
		const hit = cache[page];
		if (hit && Date.now() - hit.at < ROSTER_TTL_SECONDS * 1000) {
			next[page] = hit;
			if (hit.roster) out.set(page, hit.roster);
			continue;
		}
		stale.push(page);
	}

	/** 拿不到新的就退旧的：过期名单也比空着强，而且不写回 `at`，下一轮还会再试。 */
	const carry = (page: string): void => {
		const hit = cache[page];
		if (!hit) return;
		next[page] = hit;
		if (hit.roster) out.set(page, hit.roster);
	};

	if (OFFLINE) {
		for (const page of stale) carry(page);
	} else {
		let fetched = 0;
		for (let i = 0; i < stale.length; i += ROSTER_BATCH) {
			const batch = stale.slice(i, i + ROSTER_BATCH);
			if (fetched > 0) await sleep(SLOW_PAGE_GAP_MS);
			fetched += 1;

			const pages = await fetchWikitext(batch);
			if (!pages) {
				for (const page of batch) carry(page);
				continue;
			}
			for (const page of batch) {
				const wikitext = pages.get(page);
				// 页面不存在（`missing`）也写一笔：那是"Liquipedia 没收录这支队"，不是这一轮的故障。
				const roster = wikitext ? parseTeamRoster(wikitext) : undefined;
				next[page] = { v: CACHE_VERSION, at: Date.now(), roster };
				if (roster) out.set(page, roster);
			}
		}
	}

	await writeRosterCache(next);
	return out;
}

/*
 * ---- 选手的 Steam 账号 -------------------------------------------------------------
 *
 * 账号 id 写在**选手页**的 Infobox 里（`|playerid=152962063`），不在战队页上，所以要多取一层。
 * 有了它才能去 STRATZ 查这个人的对局——按昵称搜是不行的：STRATZ 的根查询里没有按名字搜的字段，
 * 而玩家昵称本来就随时改（实测一个账号在 Liquipedia 上叫 Gotthejuice，游戏里已经改叫 realm，
 * 九月的比赛里就是这个名字）。
 *
 * 和名单一样批量取：一次 50 个标题。选手页比战队页多（一支队五个），几十支队也就三四批。
 */

const PLAYER_ID_CACHE_FILE = path.join(process.cwd(), '.cache', 'liquipedia', 'player-ids.json');
/** 账号 id 基本不会变（换号才变），缓存给一周。 */
const PLAYER_ID_TTL_SECONDS = 7 * 24 * 3600;

interface PlayerIdCacheEntry {
	v?: number;
	at: number;
	/** 取到页面但页面上没有 `playerid` 时留空，免得每轮白问。 */
	accountId?: number;
}

type PlayerIdCache = Record<string, PlayerIdCacheEntry>;

async function readPlayerIdCache(): Promise<PlayerIdCache> {
	const hit = await readCacheJson<PlayerIdCache>(PLAYER_ID_CACHE_FILE, (value) => typeof value === 'object' && value !== null);
	if (!hit) return {};
	return Object.fromEntries(Object.entries(hit.value).filter(([, entry]) => entry?.v === CACHE_VERSION));
}

function writePlayerIdCache(cache: PlayerIdCache): Promise<void> {
	return writeCacheFile(PLAYER_ID_CACHE_FILE, JSON.stringify(cache));
}

/** 选手页 Infobox 里的 `|playerid=152962063`。 */
const PLAYER_ID_RE = /^\|\s*playerid\s*=\s*(\d+)\s*$/m;

let playerIdsPromise: Promise<Map<string, number>> | null = null;

/**
 * 选手页面标题 → Steam 账号 id。页面不存在、或那一行是空的时候不会出现在返回值里。
 */
export function fetchLiquipediaPlayerIds(playerPages: string[]): Promise<Map<string, number>> {
	playerIdsPromise ??= loadPlayerIds(playerPages);
	return playerIdsPromise;
}

async function loadPlayerIds(playerPages: string[]): Promise<Map<string, number>> {
	const wanted = [...new Set(playerPages.map((page) => page.trim()).filter(Boolean))];
	const out = new Map<string, number>();
	if (wanted.length === 0) return out;

	const cache = await readPlayerIdCache();
	const next: PlayerIdCache = {};
	const stale: string[] = [];
	for (const page of wanted) {
		const hit = cache[page];
		if (hit && Date.now() - hit.at < PLAYER_ID_TTL_SECONDS * 1000) {
			next[page] = hit;
			if (hit.accountId) out.set(page, hit.accountId);
			continue;
		}
		stale.push(page);
	}

	const carry = (page: string): void => {
		const hit = cache[page];
		if (!hit) return;
		next[page] = hit;
		if (hit.accountId) out.set(page, hit.accountId);
	};

	if (OFFLINE) {
		for (const page of stale) carry(page);
	} else {
		let fetched = 0;
		for (let i = 0; i < stale.length; i += ROSTER_BATCH) {
			const batch = stale.slice(i, i + ROSTER_BATCH);
			if (fetched > 0) await sleep(SLOW_PAGE_GAP_MS);
			fetched += 1;

			const pages = await fetchWikitext(batch);
			if (!pages) {
				for (const page of batch) carry(page);
				continue;
			}
			for (const page of batch) {
				const wikitext = pages.get(page);
				const accountId = wikitext ? Number(wikitext.match(PLAYER_ID_RE)?.[1]) || undefined : undefined;
				next[page] = { v: CACHE_VERSION, at: Date.now(), accountId };
				if (accountId) out.set(page, accountId);
			}
		}
	}

	await writePlayerIdCache(next);
	return out;
}
