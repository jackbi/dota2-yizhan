import path from 'node:path';
import type { EsportsMatch } from '../data/types';
import { readCacheJson, writeCacheFile } from './buildCache';
import { parseBracketMatches, parseMatches } from './liquipediaParse';

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

interface CacheEntry {
	at: number;
	value: EsportsMatch[];
}

async function readCache(): Promise<CacheEntry | null> {
	const hit = await readCacheJson<CacheEntry>(CACHE_FILE, (value) => {
		const entry = value as CacheEntry;
		return typeof entry?.at === 'number' && Array.isArray(entry.value);
	});
	return hit?.value ?? null;
}

function writeCache(value: EsportsMatch[]): Promise<void> {
	return writeCacheFile(CACHE_FILE, JSON.stringify({ at: Date.now(), value }));
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
	at: number;
	matches: EsportsMatch[];
}

type EventCache = Record<string, EventCacheEntry>;

async function readEventCache(): Promise<EventCache> {
	const hit = await readCacheJson<EventCache>(EVENT_CACHE_FILE, (value) => typeof value === 'object' && value !== null);
	return hit?.value ?? {};
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
		next[pagePath] = { at: Date.now(), matches };
		out.push(...matches);
	}

	await writeEventCache(next);
	return out;
}
