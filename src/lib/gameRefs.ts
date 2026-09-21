import { fetchHeroList, type HeroListEntry } from './heroApi';
import { cached } from './ssrCache';

/**
 * 个人战绩页要用到的「查表数据」：英雄 id → 中文名与图标、装备 id → 中文名与图标。
 *
 * 为什么单独一层：`heroApi.fetchHeroList()` 与官方装备接口都是**纯 fetch**，运行时能用，
 * 但它们没有缓存，而个人页要按几十条比赛里的每个英雄/装备反查名字。这里统一加上
 * 内存 TTL 缓存，把每次请求的十几次查表压成一次。
 *
 * 图标沿用站内既有约定：英雄走官方 `img.dota2.com.cn`（与英雄页同源，中文名也一致），
 * 装备走官方 `items/png/*.png`。**没有引入 STRATZ 的 CDN**，免得同一个站两套素材风格。
 */

const HERO_TTL_MS = 24 * 3600 * 1000;
const ITEM_TTL_MS = 24 * 3600 * 1000;

export interface HeroRef {
	id: number;
	name: string;
	img: string;
	attr: string;
}

/** 英雄 id → 中文名与图标。取不到时返回空表，页面退化成显示 id。 */
export async function heroRefMap(): Promise<Map<number, HeroRef>> {
	return cached('refs:heroes', HERO_TTL_MS, async () => {
		const list = await fetchHeroList();
		const map = new Map<number, HeroRef>();
		for (const hero of list as HeroListEntry[]) {
			map.set(hero.id, { id: hero.id, name: hero.name, img: hero.img, attr: hero.attr });
		}
		return map;
	});
}

export interface ItemRef {
	id: number;
	name: string;
	img: string;
	/** 单价。英雄攻略用它区分"成型件"与散件，见 `stratzGuides.ts`。 */
	cost: number;
}

/**
 * 官方装备接口是 JSONP（`callback(...)` 包裹），而且响应头没有 CORS，
 * 浏览器里只能靠 `<script>` 注入（见 `itemApi.ts`）。服务端没这个限制，
 * 直接把包裹剥掉按 JSON 解析即可。
 *
 * 用 `items/json` 而不是 `itemscategory/json`：前者 614 件，后者只有 229 件且缺合成件
 * （实测缺 220 动力鞋等），比赛里出现合成件时就会开天窗。
 */
const ITEM_JSONP = 'https://www.dota2.com.cn/items/json?callback=HeropediaDFReceive';

interface RawItem {
	id?: string | number | null;
	dname?: string | null;
	img_url?: string | null;
}

function parseJsonp(text: string): Record<string, RawItem> | null {
	const start = text.indexOf('(');
	const end = text.lastIndexOf(')');
	if (start < 0 || end <= start) return null;
	try {
		const payload = JSON.parse(text.slice(start + 1, end)) as { itemdata?: Record<string, RawItem> };
		return payload.itemdata ?? null;
	} catch {
		return null;
	}
}

export async function itemRefMap(): Promise<Map<number, ItemRef>> {
	return cached('refs:items', ITEM_TTL_MS, async () => {
		const res = await fetch(ITEM_JSONP, {
			headers: { Accept: 'text/javascript, application/javascript, */*' },
			signal: AbortSignal.timeout(20_000),
		});
		if (!res.ok) throw new Error(`装备接口 HTTP ${res.status}`);
		const itemdata = parseJsonp(await res.text());
		if (!itemdata) throw new Error('装备接口返回无法解析');

		const map = new Map<number, ItemRef>();
		for (const item of Object.values(itemdata)) {
			const id = Number(item.id);
			if (!Number.isFinite(id) || id <= 0) continue;
			map.set(id, { id, name: item.dname?.trim() || `装备 ${id}`, img: item.img_url ?? '', cost: Number(item.cost) || 0 });
		}
		return map;
	});
}
