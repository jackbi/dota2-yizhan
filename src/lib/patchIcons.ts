import type { ImageChannel, LocalImageSource } from './localImages';
import { localizeImages } from './localImages';
import { heroIconKey, itemIconKey, type PatchEntityRef, type PatchIconMap } from './patchNotes';

/**
 * 更新日志里的英雄 / 物品图标：构建期从 Steam 的图片 CDN 取回来，换成本站路径。
 *
 * 官方 datafeed 只给 `hero_id` / `item_id`，图标得自己按内部名拼地址
 * （`dota_react/heroes/icons/<名>.png`、`dota_react/items/<名>.png`）。
 * 这两张 CDN 在国内是连不通的（直连 TLS 就被重置），交给浏览器就是满屏破图，
 * 所以走和其他图片一样的本地化流程（见 `localImages.ts`）。
 *
 * 只取小图：英雄图标 4.8KB、物品图标 12.7KB，成套下载也不过几 MB；
 * 技能图标一张 24KB、8 年下来 760 个，就为了配个名字不值当，所以技能只出文字。
 */
export const PATCH_HERO_ICON_CHANNEL: ImageChannel = {
	dir: 'patch-heroes',
	width: 56,
	height: 56,
	maxBytes: 256 * 1024,
	concurrency: 6,
};

export const PATCH_ITEM_ICON_CHANNEL: ImageChannel = {
	dir: 'patch-items',
	width: 56,
	height: 56,
	maxBytes: 256 * 1024,
	concurrency: 6,
};

const HERO_ICON_BASE = 'https://cdn.steamstatic.com/apps/dota2/images/dota_react/heroes/icons';
const ITEM_ICON_BASE = 'https://cdn.steamstatic.com/apps/dota2/images/dota_react/items';

function heroIconUrl(key: string): string {
	return `${HERO_ICON_BASE}/${key}.png`;
}

function itemIconUrl(key: string): string {
	return `${ITEM_ICON_BASE}/${key}.png`;
}

/**
 * 下载这一页要用到的图标，返回 `hero:<名>` / `item:<名>` → `/patch-heroes/xxx.jpg`。
 *
 * 拿不到的键不会出现在返回值里，渲染时退化成占位方块，不会留破图。
 */
export async function localizePatchIcons(refs: {
	heroes: PatchEntityRef[];
	items: PatchEntityRef[];
}): Promise<PatchIconMap> {
	// 名字表里补出来的条目（如熊灵）没有内部名，拼不出图标地址，直接跳过。
	const heroSources: LocalImageSource[] = refs.heroes
		.filter((ref) => ref.key.length > 0)
		.map((ref) => ({
			key: heroIconKey(ref.key),
			url: heroIconUrl(ref.key),
			slug: `hero-${ref.key}`,
		}));
	const itemSources: LocalImageSource[] = refs.items
		.filter((ref) => ref.key.length > 0)
		.map((ref) => ({
			key: itemIconKey(ref.key),
			url: itemIconUrl(ref.key),
			slug: `item-${ref.key}`,
		}));

	const [heroes, items] = await Promise.all([
		localizeImages(PATCH_HERO_ICON_CHANNEL, heroSources),
		localizeImages(PATCH_ITEM_ICON_CHANNEL, itemSources),
	]);

	const out: PatchIconMap = new Map(heroes);
	for (const [key, value] of items) out.set(key, value);
	return out;
}
