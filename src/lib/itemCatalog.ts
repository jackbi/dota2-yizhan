import path from 'node:path';
import { cacheFile, isFresh, readCacheJson, writeCacheFile } from './buildCache';
import { type ItemDetail, type ItemSection, cleanItemText, fetchItemSections, normalizeItemDetail } from './itemApi';

/**
 * 装备目录：详情 + 所属分类 + 反向的「能合成什么」。
 *
 * 为什么要单独一层：装备数据本来只在浏览器里组装（`items/json` 是 JSONP，绕跨域用的），
 * 构建期拿不到，于是 614 件装备全挤在 `/items` 一个 URL 里——用户搜「闪烁匕首 合成」时
 * 一个能承接的页面都没有，版本日志里的装备名也无处可链。这里在构建期把同一份数据落一次盘，
 * `/items/[id]` 才有东西可渲染。
 *
 * 缓存 6 小时：装备只在版本更新时动，而站点半小时重建一次，没必要每轮都拉 400KB。
 * 上游挂了就退回旧缓存（多旧都用），一件装备都拿不到时返回 null，页面自己显示说明。
 */

const CACHE_DIR = path.join(process.cwd(), '.cache', 'items');
const CACHE_TTL_SECONDS = 6 * 3600;
/** 缓存里存的是折好的形状，字段一改就得换号，否则会拿到半新半旧的条目。 */
const CACHE_VERSION = 2;
const DETAIL_URL = 'https://www.dota2.com.cn/items/json?callback=HeropediaDFReceive';

export interface ItemCatalogEntry {
	/** 内部名，同时就是页面路径（`/items/blink`）与 `items/json` 的键。 */
	key: string;
	detail: ItemDetail;
	/** 所属分类：`basic` / `upgrade` / `neutral`；不在装备库分类视图里的条目为空串。 */
	section: string;
	/** 分类的中文名，如「基础」。 */
	sectionLabel: string;
	/** 分类里的分组名，如「武器」。 */
	group: string;
	/** 由它合成的装备（内部名）。基础件靠着这张表才看得出「往上能合什么」。 */
	buildsInto: string[];
}

export interface ItemCatalog {
	/** 按装备库的展示顺序：先分类视图里的（基础 → 升级 → 中立），再是图纸之类不在分类里的。 */
	entries: ItemCatalogEntry[];
	byKey: Map<string, ItemCatalogEntry>;
}

interface CachedCatalog {
	version: number;
	sections: ItemSection[];
	details: Record<string, ItemDetail>;
}

/**
 * `items/json` 是 JSONP：响应体是 `HeropediaDFReceive({...})`。
 * 服务端没有跨域一说，把外面的包裹剥掉直接当 JSON 解析（和 `gameRefs` 同一套做法）。
 */
function parseJsonp(text: string): Record<string, any> | null {
	const start = text.indexOf('(');
	const end = text.lastIndexOf(')');
	if (start < 0 || end <= start) return null;
	try {
		return (JSON.parse(text.slice(start + 1, end)) as { itemdata?: Record<string, any> }).itemdata ?? null;
	} catch {
		return null;
	}
}

async function fetchCatalog(): Promise<CachedCatalog | null> {
	const [detailRes, sections] = await Promise.all([
		fetch(DETAIL_URL, {
			headers: { Accept: 'text/javascript, application/javascript, */*' },
			signal: AbortSignal.timeout(30_000),
		}),
		// 分类视图只有 229 件，拿不到也不算失败——最多是这些条目少了「所属分组」。
		fetchItemSections().catch(() => [] as ItemSection[]),
	]);
	if (!detailRes.ok) throw new Error(`装备详情接口 HTTP ${detailRes.status}`);
	const itemdata = parseJsonp(await detailRes.text());
	if (!itemdata) throw new Error('装备详情接口返回的不是 JSONP');

	const details: Record<string, ItemDetail> = {};
	for (const [key, raw] of Object.entries<any>(itemdata)) details[key] = normalizeItemDetail(key, raw);
	return { version: CACHE_VERSION, sections, details };
}

function isCachedCatalog(value: unknown): boolean {
	const cached = value as CachedCatalog;
	return cached?.version === CACHE_VERSION && !!cached.details && typeof cached.details === 'object';
}

function build(cached: CachedCatalog): ItemCatalog {
	const entries: ItemCatalogEntry[] = [];
	const byKey = new Map<string, ItemCatalogEntry>();

	const push = (key: string, where: { section: string; sectionLabel: string; group: string } | null): void => {
		if (byKey.has(key)) return;
		const detail = cached.details[key];
		if (!detail) return;
		/*
		 * 接口里有 94 条没有中文名的记录（`recipe_phase_boots`、`mystery_hook`、`winter_cake`
		 * 这类历史遗留与活动道具），它们既不在商店里也没有可展示的内容，给它们做页面只是给
		 * 爬虫喂空页。合成配方里引用到它们时按纯文字渲染（查不到条目 = 不给链接）。
		 */
		if (!detail.nameLoc.trim()) return;
		const entry: ItemCatalogEntry = {
			key,
			detail,
			section: where?.section ?? '',
			sectionLabel: where?.sectionLabel ?? '',
			group: where?.group ?? '',
			// 先建条目、后面统一补反向关系，所以这里不能来自 where。
			buildsInto: [],
		};
		entries.push(entry);
		byKey.set(key, entry);
	};

	// 先按装备库的顺序摆放，这样详情页的「上一件 / 下一件」与列表页的顺序一致。
	for (const section of cached.sections) {
		for (const group of section.groups) {
			for (const item of group.items) {
				push(item.name, { section: section.key, sectionLabel: section.label, group: group.name });
			}
		}
	}

	/*
	 * 剩下的是分类视图里没有、但接口里有的（图纸、短棍、奶酪、信使这类）。
	 * 一样给页面：合成配方里的那些图纸正是靠这个链接才不是死链。
	 */
	const rest = Object.keys(cached.details)
		.filter((key) => !byKey.has(key))
		.sort((a, b) => cached.details[a].nameLoc.localeCompare(cached.details[b].nameLoc, 'zh-Hans-CN'));
	for (const key of rest) push(key, null);

	// 反向关系：谁用到了我。`*` 是接口的标记（那件要拿升级件来合），比对时去掉。
	for (const entry of entries) {
		for (const raw of entry.detail.requirements) {
			const key = raw.replace(/\*$/, '');
			const reagent = byKey.get(key);
			if (reagent && !reagent.buildsInto.includes(entry.key)) reagent.buildsInto.push(entry.key);
		}
	}

	return { entries, byKey };
}

let catalogPromise: Promise<ItemCatalog | null> | null = null;

/**
 * 「只有价格、一句描述都没有」的条目——实测 121 个，图纸、活动道具与一部分中立物品。
 *
 * 页面照旧给它们生成：合成配方里的图纸、散件总得有个落脚点，点进去不能 404。
 * 但**不给搜索引擎**：一页二十几个字，对它自己是零收益，对整站的「内容质量」判断还是负分。
 * 判据放在这里，是为了让页面上的 `noindex` 与 `astro.config.mjs` 里的 sitemap 过滤用同一份，
 * 免得哪天调了一边、另一边还在收录（版本日志提到过的装备另有内容，由调用方再补一条判断）。
 */
export function isThinItem(entry: ItemCatalogEntry): boolean {
	const { detail } = entry;
	// 和页面一样走 `cleanItemText`：接口下发的是富文本，`<h1></h1>` 这种空标签不能算有内容。
	return [detail.desc, detail.attrib, detail.notes, detail.lore].every((field) => !cleanItemText(field).trim());
}

/** 整轮构建只算一次；多个渲染进程各自算一份，靠的是 `.cache/` 里那份 JSON。 */
export function itemCatalog(): Promise<ItemCatalog | null> {
	catalogPromise ??= (async () => {
		const file = cacheFile(CACHE_DIR, 'catalog.json');
		const cached = await readCacheJson<CachedCatalog>(file, isCachedCatalog);
		if (cached && isFresh(cached.ageMs, CACHE_TTL_SECONDS)) return build(cached.value);

		const fresh = await fetchCatalog().catch(() => null);
		if (fresh) {
			await writeCacheFile(file, JSON.stringify(fresh));
			return build(fresh);
		}
		// 上游挂了：缓存多旧都用，总比把 614 个页面变成空壳强。
		return cached ? build(cached.value) : null;
	})();
	return catalogPromise;
}
