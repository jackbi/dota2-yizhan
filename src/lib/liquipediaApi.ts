import path from 'node:path';
import type { EsportsMatch } from '../data/types';
import { readCacheJson, writeCacheFile } from './buildCache';

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
 * 站内 id 只保留字母、数字与汉字，其余一律折叠成连字符。
 * 赛事页路径里带 `/`，直接当路由参数会让 `/tournaments/[id]` 匹配失败。
 */
const slug = (value: string): string =>
	value
		.toLowerCase()
		.replace(/[^\p{L}\p{N}]+/gu, '-')
		.replace(/^-+|-+$/g, '');

/** 赛事页路径 → 站内展示用的赛事名，例如 `BLAST/SLAM/9/Southeast_Asia` → `BLAST SLAM 9 Southeast Asia`。 */
function eventNameFromPath(wikiPath: string): string {
	return wikiPath
		.split('/')
		.map((segment) => segment.replace(/_/g, ' ').trim())
		.filter(Boolean)
		.join(' ');
}

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

async function fetchPage(): Promise<string | null> {
	const url = `${API}?action=parse&format=json&page=${encodeURIComponent(PAGE)}`;
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

// ---------------------------------------------------------------- 解析

interface ParsedTeam {
	name: string;
	short: string;
	logo?: string;
}

const TEAM_ANCHOR_RE = /team-template-image-icon">\s*<a[^>]*title="([^"]*)"/;
const TEAM_SHORT_RE = /<span class="name"[^>]*>\s*<a[^>]*>([^<]*)<\/a>/;
const TEAM_LOGO_RE = /<img[^>]*src="([^"]*)"/;

/**
 * 从"主队或客队那一段"里取队伍信息。
 * 调用方已经用比分栏把一段比赛切成左右两半，所以这里取第一支队伍即可；
 * 找不到（对阵未定，Liquipedia 用 TBD 占位）时返回 null，整场跳过。
 */
function parseTeam(part: string): ParsedTeam | null {
	const start = part.indexOf('<div class="block-team');
	if (start === -1) return null;
	const segment = part.slice(start);
	const name = segment.match(TEAM_ANCHOR_RE)?.[1]?.trim();
	if (!name) return null;
	const logo = segment.match(TEAM_LOGO_RE)?.[1];
	return {
		name,
		short: segment.match(TEAM_SHORT_RE)?.[1]?.trim() ?? '',
		logo: logo ? `https://liquipedia.net${logo}` : undefined,
	};
}

/** 比分栏在未开赛时是 "vs"，已开赛是 `2 : 0` 这种带标签的结构，去掉标签再取数字。 */
function parseScore(upperHtml: string | undefined): [number, number] | null {
	if (!upperHtml) return null;
	const text = upperHtml.replace(/<[^>]+>/g, ' ').trim();
	if (!text || /vs/i.test(text)) return null;
	const numbers = text.match(/\d+/g);
	return numbers && numbers.length >= 2 ? [Number(numbers[0]), Number(numbers[1])] : null;
}

function parseMatches(html: string, nowSec: number): EsportsMatch[] {
	const out: EsportsMatch[] = [];
	const seen = new Set<string>();
	// 每场比赛是一个 `<div class="match-info">`；切出来的一段自然以该场开头，
	// 所以"第一处匹配"必定属于这一场，不会串到下一场。
	for (const block of html.split('<div class="match-info">').slice(1)) {
		const timerAttrs = block.match(/<span class="timer-object[^"]*"([^>]*)>/)?.[1];
		const startTime = Number(timerAttrs?.match(/data-timestamp="(\d+)"/)?.[1] ?? 0);
		if (!startTime) continue;

		const [leftPart, rightPart] = block.split('class="match-info-header-scoreholder"');
		const home = leftPart ? parseTeam(leftPart) : null;
		const away = rightPart ? parseTeam(rightPart) : null;
		// 一方未定的比赛没有对阵，跳过而不是编一个占位队名。
		if (!home || !away) continue;

		const finished = Boolean(timerAttrs?.includes('data-finished="finished"'));
		const status = finished ? 'completed' : startTime > nowSec ? 'upcoming' : 'live';

		const boText = block.match(/scoreholder-lower">\(?Bo(\d)\)?/)?.[1];
		const upperHtml = block.match(
			/scoreholder-upper">([\s\S]*?)<\/span>\s*<span class="match-info-header-scoreholder-lower"/,
		)?.[1];
		const score = status === 'upcoming' ? null : parseScore(upperHtml);
		// 胜方由比分区上的高亮决定，比"比谁大"更可靠（也适用于还没显示比分的场景）。
		const homeWon = /match-info-header-opponent-left[^"]*match-info-header-winner|match-info-header-winner[^"]*match-info-header-opponent-left/.test(
			leftPart ?? '',
		);
		const awayWon = Boolean(rightPart && rightPart.split('match-info-tournament')[0]?.includes('match-info-header-winner'));

		const eventPath = block.match(/league-icon-small-image[^>]*>\s*<a href="([^"]+)"/)?.[1]?.replace(/^\/dota2\//, '').split('#')[0];
		if (!eventPath) continue;

		const id = `lp-${startTime}-${slug(home.name)}-${slug(away.name)}`;
		if (seen.has(id)) continue;
		seen.add(id);

		out.push({
			id,
			eventId: slug(eventPath),
			eventName: eventNameFromPath(eventPath) || eventPath,
			startTime,
			status,
			bo: boText ? Number(boText) : undefined,
			home: { id: `lp-team-${slug(home.name)}`, name: home.name, logo: home.logo, score: score?.[0] },
			away: { id: `lp-team-${slug(away.name)}`, name: away.name, logo: away.logo, score: score?.[1] },
			winner: homeWon ? 'home' : awayWon ? 'away' : undefined,
			source: 'liquipedia',
			sourceUrl: `https://liquipedia.net/dota2/${eventPath}`,
		});
	}
	return out;
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
