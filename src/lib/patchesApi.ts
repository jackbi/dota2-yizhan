import { promises as fs } from 'node:fs';
import path from 'node:path';
import { toArticleContent } from './articleHtml';
import { reportSource } from './dataHealth';

/**
 * 官方更新日志层：构建期抓取 dota2.com.cn 的「游戏性更新」列表与正文。
 *
 * 和官网新闻一样，页面是服务端渲染的 HTML 且不带 CORS 头，只能在构建期由 Node 抓取。
 * 列表缓存 30 分钟、正文永久（发布后不再改动），离线构建完全读缓存。
 */

const LIST_BASE = 'https://www.dota2.com.cn/news/gamepost';
const CACHE_DIR = path.join(process.cwd(), '.cache', 'patches');
const OFFLINE = process.env.TOURNAMENTS_OFFLINE === '1';
const USER_AGENT =
	'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const LIST_TTL_SECONDS = 30 * 60;
/** 官方正文发布后不会再改，命中后永久使用缓存。 */
const ARTICLE_TTL_SECONDS = Number.POSITIVE_INFINITY;

export interface PatchUpdate {
	title: string;
	date: string;
	href: string;
	img: string;
	version: string;
	id: string;
}

const ITEM_RE =
	/<a href="(https:\/\/www\.dota2\.com\.cn\/article\/details\/[^"]+)" class="item"[^>]*>[\s\S]*?<div class="news_logo"><img src="([^"]+)" alt="([^"]*)"[^>]*>[\s\S]*?<h2 class="title">([^<]+)<\/h2>[\s\S]*?<p class="date">([^<]+)<\/p>/g;

function parseList(html: string): PatchUpdate[] {
	const out: PatchUpdate[] = [];
	for (const m of html.matchAll(ITEM_RE)) {
		const title = m[4].replace(/&amp;/g, '&').trim();
		out.push({
			href: m[1],
			img: m[2],
			title,
			date: m[5].trim(),
			version: title.match(/\d+(?:\.\d+)+[a-z]?/)?.[0] ?? title,
			id: articleIdFromHref(m[1]),
		});
	}
	return out;
}

function articleIdFromHref(href: string): string {
	return href.match(/\/(\d+)\.html$/)?.[1] ?? href;
}

// ---------------------------------------------------------------- 缓存

async function readCache(file: string, ttlSeconds: number): Promise<string | null> {
	try {
		const stat = await fs.stat(file);
		if (Date.now() - stat.mtimeMs >= ttlSeconds * 1000) return null;
		return await fs.readFile(file, 'utf8');
	} catch {
		return null;
	}
}

async function readStale(file: string): Promise<string | null> {
	try {
		return await fs.readFile(file, 'utf8');
	} catch {
		return null;
	}
}

async function writeCache(file: string, text: string): Promise<void> {
	try {
		await fs.mkdir(CACHE_DIR, { recursive: true });
		await fs.writeFile(file, text, 'utf8');
	} catch {
		// 缓存写入失败不影响构建。
	}
}

/** 本轮联网抓了几次，用来区分"新抓的"和"吃缓存的"。 */
let networkFetches = 0;

/** 缓存优先；失败时退回过期缓存；离线构建只读缓存。 */
async function loadHtml(file: string, url: string, ttlSeconds: number): Promise<string | null> {
	const cached = await readCache(file, ttlSeconds);
	if (cached !== null) return cached;
	if (OFFLINE) return readStale(file);

	try {
		const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
		if (!res.ok) return readStale(file);
		const text = await res.text();
		networkFetches += 1;
		await writeCache(file, text);
		return text;
	} catch {
		return readStale(file);
	}
}

// ---------------------------------------------------------------- 对外接口

const listPromises = new Map<number, Promise<PatchUpdate[]>>();

/**
 * 构建时抓取官方「更新日志」列表页并解析条目，按时间倒序。
 * 列表页、首页与详情页的 getStaticPaths 共用同一份结果，一次构建只抓一轮。
 */
export function fetchPatchUpdates(pages = 3): Promise<PatchUpdate[]> {
	let pending = listPromises.get(pages);
	if (!pending) {
		pending = loadList(pages);
		listPromises.set(pages, pending);
	}
	return pending;
}

async function loadList(pages: number): Promise<PatchUpdate[]> {
	const seen = new Set<string>();
	const all: PatchUpdate[] = [];
	for (let p = 1; p <= pages; p++) {
		const url = p === 1 ? `${LIST_BASE}/index1.htm` : `${LIST_BASE}/index${p}.htm`;
		const text = await loadHtml(path.join(CACHE_DIR, `list-${p}.html`), url, LIST_TTL_SECONDS);
		if (!text) break;
		for (const item of parseList(text)) {
			if (seen.has(item.href)) continue;
			seen.add(item.href);
			all.push(item);
		}
		if (all.length === 0) break;
	}

	await reportSource(
		'patches',
		'官方更新日志',
		networkFetches > 0 ? 'fresh' : all.length > 0 ? 'cache' : 'empty',
		`${all.length} 条，最新 ${all[0]?.version ?? '未知'}（${all[0]?.date ?? '—'}），联网抓取 ${networkFetches} 次`,
	);
	return all;
}

/**
 * 构建期抓取官方文章，返回清洗后的正文 HTML（去脚本/样式/内联样式）。
 * 官方文章无 CORS 头，仅能在 Node 构建期请求。
 */
export async function fetchArticle(url: string): Promise<string> {
	const file = path.join(CACHE_DIR, `article-${articleIdFromHref(url)}.html`);
	const cached = await readCache(file, ARTICLE_TTL_SECONDS);
	if (cached !== null) return cached;
	if (OFFLINE) return (await readStale(file)) ?? '';

	const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
	if (!res.ok) throw new Error(`HTTP ${res.status}`);
	const content = toArticleContent(await res.text());
	await writeCache(file, content);
	return content;
}
