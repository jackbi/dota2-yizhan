import path from 'node:path';
import { isFresh, readCacheJson, writeCacheFile } from './buildCache';
import { reportSource } from './dataHealth';
import { extractJson, fetchText } from './fetchText';
import {
	groupByMajor,
	heroKeyFromName,
	itemKeyFromName,
	type PatchNames,
	type PatchNotes,
} from './patchNotes';

export { groupByMajor };

/**
 * 官方更新日志层：构建期抓取 dota2.com 的 `datafeed/patchnotes`。
 *
 * ## 为什么从中文站换到这里
 *
 * 中文站（`dota2.com.cn/news/gamepost`）的「游戏性更新」只发到 7.41d，再往前就断了；
 * 而这份 datafeed 是官网 `/patches` 页自己的数据源，**从 7.08 起 118 个版本一个不缺**，
 * 而且 `language=schinese` 直接给中文正文，不用自己翻译。顺带还解决了另一个老问题：
 * 中文站给的是排好版的 HTML，只能整段塞进页面；datafeed 给的是结构（哪条是英雄改动、
 * 哪条它下面的技能），可以按结构排版。
 *
 * 代价是名字：datafeed 里只有 `hero_id` / `ability_id`，名字要另查
 * `herolist` / `itemlist` / `abilitylist`（见 `fetchPatchNames()`）。
 *
 * 列表缓存 30 分钟；更新日志与名字表 7 天——官方发布后基本不改，但偶尔会回填错别字，
 * 一周重抓一次全套也就 2MB 出头。
 */

const BASE = 'https://www.dota2.com/datafeed';
const CACHE_DIR = path.join(process.cwd(), '.cache', 'patches');
const OFFLINE = process.env.TOURNAMENTS_OFFLINE === '1';

const LIST_TTL_SECONDS = 30 * 60;
const NOTES_TTL_SECONDS = 7 * 24 * 60 * 60;
/** 英雄/物品/技能名字表只在出新英雄新物品时变，慢慢更就行。 */
const NAMES_TTL_SECONDS = 7 * 24 * 60 * 60;

export interface PatchUpdate {
	/** 网址里的 id，就是版本号本身（`7.41f`）。 */
	id: string;
	version: string;
	/** 去掉尾字母的大版本（`7.41`），列表页按它分组。 */
	major: string;
	date: string;
	/** 官网对应页面，正文出问题时给用户一个去处。 */
	href: string;
	/**
	 * 7.23「世外之争」、7.28「林渊秘境」这类大版本，官方把日志做成了专题站，
	 * 数据接口里一个字都没有，只留了这个 slug。
	 */
	siteUrl?: string;
}

/** 本轮联网抓了几次，用来区分「新抓的」和「吃缓存的」。 */
let networkFetches = 0;

// ---------------------------------------------------------------- 抓取与缓存

/**
 * 带缓存的 JSON 取数：新鲜缓存优先，其次联网，最后退回旧缓存。
 *
 * 上游失败时**保留旧数据**而不是清空——`patches.astro` 有「本次未能刷新」的提示，
 * 总比整页变成空状态强。
 */
async function loadJson<T>(
	file: string,
	url: string,
	ttlSeconds: number,
	validate: (value: unknown) => boolean,
): Promise<T | null> {
	const cached = await readCacheJson<T>(file, validate);
	if (cached && isFresh(cached.ageMs, ttlSeconds)) return cached.value;

	const text = OFFLINE ? null : await fetchText(url);
	const value = text ? extractJson(text) : null;
	if (value !== null && validate(value)) {
		networkFetches += 1;
		await writeCacheFile(file, JSON.stringify(value));
		return value as T;
	}
	return cached?.value ?? null;
}

function cachePath(...parts: string[]): string {
	return path.join(CACHE_DIR, ...parts);
}

function isPatchList(value: unknown): boolean {
	const list = (value as { patches?: unknown }).patches;
	return Array.isArray(list) && list.length > 0;
}

function isPatchNotes(value: unknown): boolean {
	const notes = value as PatchNotes;
	return typeof notes?.patch_number === 'string';
}

function isNameTable(key: string) {
	return (value: unknown): boolean => {
		const rows = (value as { result?: { data?: Record<string, unknown> } }).result?.data?.[key];
		return Array.isArray(rows) && rows.length > 0;
	};
}

// ---------------------------------------------------------------- 版本列表

interface RawPatchListEntry {
	patch_number: string;
	patch_timestamp?: number;
	patch_website?: string;
	patch_website_anchor?: string;
}

let listPromise: Promise<PatchUpdate[]> | null = null;

/**
 * 构建期抓取版本列表，按时间倒序（datafeed 本来就是从旧到新，这里翻过来）。
 * 列表页、首页与详情页的 `getStaticPaths` 共用同一份结果，一次构建只抓一轮。
 */
export function fetchPatchUpdates(): Promise<PatchUpdate[]> {
	if (!listPromise) listPromise = loadList();
	return listPromise;
}

function majorOf(version: string): string {
	return version.match(/^\d+(?:\.\d+)+/)?.[0] ?? version;
}

function formatDate(timestamp: number): string {
	if (!Number.isFinite(timestamp) || timestamp <= 0) return '—';
	// 用 UTC 而不是本机时区：时间戳是「当天 0 点」的近似值，本地时区会让 CI 和服务端
	// 生成出不同的日期，构建产物就不再稳定了。
	return new Date(timestamp * 1000).toISOString().slice(0, 10);
}

async function loadList(): Promise<PatchUpdate[]> {
	const raw = await loadJson<{ patches: RawPatchListEntry[] }>(
		cachePath('list.json'),
		`${BASE}/patchnoteslist?language=schinese`,
		LIST_TTL_SECONDS,
		isPatchList,
	);

	const updates = (raw?.patches ?? [])
		.filter((p) => typeof p?.patch_number === 'string' && p.patch_number.length > 0)
		.map((p): PatchUpdate => {
			const version = p.patch_number;
			const timestamp = Number(p.patch_timestamp) || 0;
			const site = typeof p.patch_website === 'string' ? p.patch_website.trim() : '';
			return {
				id: version,
				version,
				major: majorOf(version),
				date: formatDate(timestamp),
				href: `https://www.dota2.com/patches/${version}`,
				siteUrl: site
					? `https://www.dota2.com/${site}${p.patch_website_anchor ? `#${p.patch_website_anchor}` : ''}`
					: undefined,
			};
		})
		.reverse();

	await reportSource(
		'patches',
		'官方更新日志',
		networkFetches > 0 ? 'fresh' : updates.length > 0 ? 'cache' : 'empty',
		`${updates.length} 个版本，最新 ${updates[0]?.version ?? '未知'}（${updates[0]?.date ?? '—'}），联网抓取 ${networkFetches} 次`,
	);
	return updates;
}

// ---------------------------------------------------------------- 更新日志正文

/** 进程内再去一次重：构建时一个 worker 会连着渲染很多页，同一份 JSON 不必反复读盘解析。 */
const notesPromises = new Map<string, Promise<PatchNotes | null>>();

/**
 * 抓取某个版本的更新日志（结构化）。
 *
 * 每个版本一个缓存文件：`getStaticPaths` 会为全部 118 个版本各建一页，
 * 分开存之后改动一个版本不会让整份缓存失效。
 */
export function fetchPatchNotes(version: string): Promise<PatchNotes | null> {
	let pending = notesPromises.get(version);
	if (!pending) {
		const file = cachePath(`notes-${version.replace(/[^\w.]+/g, '_')}.json`);
		const url = `${BASE}/patchnotes?version=${encodeURIComponent(version)}&language=schinese`;
		pending = loadJson<PatchNotes>(file, url, NOTES_TTL_SECONDS, isPatchNotes);
		notesPromises.set(version, pending);
	}
	return pending;
}

/**
 * 先并发把全部版本的正文取回来（并发受限，别把上游打疼）。
 *
 * **只在构建时跑**：dev 下 Astro 每次请求动态路由都会重新执行 `getStaticPaths`，
 * 不拦一下的话打开任意一个版本页都要先把 118 份 JSON 过一遍。
 */
export async function prefetchPatchNotes(updates: PatchUpdate[], limit = 4): Promise<void> {
	let cursor = 0;
	const workers = Array.from({ length: Math.min(limit, updates.length) }, async () => {
		while (cursor < updates.length) await fetchPatchNotes(updates[cursor++].id);
	});
	await Promise.all(workers);
}

// ---------------------------------------------------------------- 名字表

let namesPromise: Promise<PatchNames> | null = null;

/** datafeed 里的英雄/物品/技能只有 id，名字在另外三张表里。 */
export function fetchPatchNames(): Promise<PatchNames> {
	if (!namesPromise) namesPromise = loadNames();
	return namesPromise;
}

async function loadNames(): Promise<PatchNames> {
	const [heroRaw, itemRaw, abilityRaw] = await Promise.all([
		loadJson<{ result: { data: { heroes: RawNamed[] } } }>(
			cachePath('herolist.json'),
			`${BASE}/herolist?language=schinese`,
			NAMES_TTL_SECONDS,
			isNameTable('heroes'),
		),
		loadJson<{ result: { data: { itemabilities: RawNamed[] } } }>(
			cachePath('itemlist.json'),
			`${BASE}/itemlist?language=schinese`,
			NAMES_TTL_SECONDS,
			isNameTable('itemabilities'),
		),
		loadJson<{ result: { data: { itemabilities: RawNamed[] } } }>(
			cachePath('abilitylist.json'),
			`${BASE}/abilitylist?language=schinese`,
			NAMES_TTL_SECONDS,
			isNameTable('itemabilities'),
		),
	]);

	const heroes = new Map<number, { key: string; name: string }>();
	for (const hero of heroRaw?.result?.data?.heroes ?? []) {
		const id = hero?.id;
		if (typeof id !== 'number' || !hero.name_loc) continue;
		heroes.set(id, { key: heroKeyFromName(hero.name ?? ''), name: hero.name_loc });
	}
	// 熊灵在 datafeed 里占一个「英雄」位（1961），但名字表里没有它，只能自己补。
	// key 留空 → 渲染时退化成占位方块，不会去下一张不存在的图。
	if (!heroes.has(1961)) heroes.set(1961, { key: '', name: '熊灵' });

	const items = new Map<number, { key: string; name: string }>();
	for (const item of itemRaw?.result?.data?.itemabilities ?? []) {
		const id = item?.id;
		if (typeof id !== 'number' || !item.name_loc) continue;
		items.set(id, { key: itemKeyFromName(item.name ?? ''), name: item.name_loc });
	}

	const abilities = new Map<number, { key: string; name: string }>();
	for (const ability of abilityRaw?.result?.data?.itemabilities ?? []) {
		const id = ability?.id;
		if (typeof id !== 'number') continue;
		// 少数技能（多为神杖/魔晶升级）没有中文名，渲染时只出改动文字。
		abilities.set(id, { key: ability.name ?? '', name: ability.name_loc ?? '' });
	}

	return { heroes, items, abilities };
}

interface RawNamed {
	id?: number;
	name?: string;
	name_loc?: string;
}
