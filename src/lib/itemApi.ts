const CATEGORY_URL = 'https://www.dota2.com.cn/itemscategory/json';
const DETAIL_URL = 'https://www.dota2.com.cn/items/json?callback=HeropediaDFReceive';

const SECTION_LABEL: Record<string, string> = { basic: '基础', upgrade: '升级', neutral: '中立' };
const SECTION_ORDER = ['basic', 'upgrade', 'neutral'];

export interface ItemListItem {
	id: string;
	name: string;
	nameLoc: string;
	cost: number;
	img: string;
	imgUrl: string;
	sort: number;
}

export interface ItemCategoryGroup {
	name: string;
	items: ItemListItem[];
}

export interface ItemSection {
	key: string;
	label: string;
	groups: ItemCategoryGroup[];
}

export interface ItemDetail {
	id: string;
	nameLoc: string;
	nameEn: string;
	cost: number;
	desc: string;
	attrib: string;
	notes: string;
	lore: string;
	mc: string;
	cd: string;
	/**
	 * 合成配方：散件的内部名，`recipe_*` 是图纸。
	 *
	 * 接口里 `components` 这个字段**恒为空**（实测 614 件全空），配方其实写在 `requirements`：
	 * 137 件有值，`*` 后缀表示那件要拿升级件来合。以前这里读的是 `components`，
	 * 所以"合成配方"从来没显示过。
	 */
	requirements: string[];
	imgUrl: string;
}

/** 清洗官方下发的富文本：保留行结构，去掉标签与 HTML 实体。 */
function cleanRich(input: string): string {
	return String(input || '')
		.replace(/<br\s*\/?>/gi, '\n')
		.replace(/<\/(p|div|h1|h2|h3|h4|li|ul|ol)>/gi, '\n')
		.replace(/<[^>]+>/g, '')
		.replace(/&nbsp;/g, ' ')
		.replace(/&amp;/g, '&')
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/[ \t]+/g, ' ')
		.replace(/\n{3,}/g, '\n\n')
		.trim();
}

export function cleanItemText(input: string): string {
	return cleanRich(input);
}

async function getJson(url: string): Promise<any> {
	const res = await fetch(url, { headers: { Accept: 'application/json' } });
	if (!res.ok) throw new Error(`HTTP ${res.status}`);
	return res.json();
}

/** 拉取装备分类（基础/升级/中立）+ 每组物品。 */
export async function fetchItemSections(): Promise<ItemSection[]> {
	const data = await getJson(CATEGORY_URL);
	const result = data.result;
	return SECTION_ORDER
		.filter((key) => Array.isArray(result?.[key]))
		.map((key) => ({
			key,
			label: SECTION_LABEL[key] ?? key,
			groups: result[key].map((group: any): ItemCategoryGroup => ({
				name: group.name,
				items: (group.items ?? []).map((it: any): ItemListItem => ({
					id: String(it.item_id ?? it.name),
					name: it.name,
					nameLoc: it.name_loc ?? it.name,
					cost: Number(it.cost) || 0,
					img: it.img,
					imgUrl: it.img_url,
					sort: Number(it.sort_value) || 0,
				})),
			})),
		}));
}

let detailCache: Promise<Record<string, ItemDetail>> | null = null;

/**
 * JSONP 加载：items/json 是 JSONP 接口，响应没有 Access-Control-Allow-Origin，
 * fetch 会被 CORS 拦截，因此用 <script> 注入方式加载（绕过跨域）。
 */
function loadJsonp(url: string, callbackName: string): Promise<any> {
	return new Promise((resolve, reject) => {
		const script = document.createElement('script');
		script.src = url;
		script.async = true;
		const win = window as any;
		const prev = win[callbackName];
		win[callbackName] = (data: any) => {
			cleanup();
			resolve(data);
		};
		const cleanup = () => {
			delete win[callbackName];
			if (prev) win[callbackName] = prev;
			script.remove();
		};
		script.onerror = () => {
			cleanup();
			reject(new Error('装备详情加载失败'));
		};
		document.head.appendChild(script);
	});
}

/**
 * 把 `items/json` 里的一条原始记录折成 `ItemDetail`。
 *
 * 服务端（`itemCatalog.ts`，给构建期的装备详情页用）与浏览器（下面的 `loadItemDetails`，
 * 给装备库的悬浮框用）共用这一份——两边要是各写一份，字段漏一个就会出现
 * 「页面上有、悬浮框里没有」这种只有肉眼才看得出来的差异。
 */
export function normalizeItemDetail(key: string, v: any): ItemDetail {
	return {
		id: key,
		nameLoc: v.dname,
		nameEn: v.en,
		cost: Number(v.cost) || 0,
		desc: v.desc,
		attrib: v.attrib,
		notes: v.notes,
		lore: v.lore,
		mc: v.mc,
		cd: v.cd,
		requirements: Array.isArray(v.requirements) ? v.requirements.map((item: string) => String(item)) : [],
		imgUrl: v.img_url,
	};
}

/** 懒加载全部装备详情（JSONP），缓存复用。 */
export function loadItemDetails(): Promise<Record<string, ItemDetail>> {
	if (!detailCache) {
		detailCache = (async () => {
			const payload = await loadJsonp(DETAIL_URL, 'HeropediaDFReceive');
			const itemdata = payload.itemdata;
			const map: Record<string, ItemDetail> = {};
			for (const [key, v] of Object.entries<any>(itemdata)) {
				map[key] = normalizeItemDetail(key, v);
			}
			return map;
		})();
	}
	return detailCache;
}
