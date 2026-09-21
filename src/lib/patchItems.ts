import { fetchPatchNames, fetchPatchNotes, fetchPatchUpdates, prefetchPatchNotes } from './patchesApi';
import { summarizePatch } from './patchNotes';
import type { HeroPatchRef } from './patchHeroes';

/**
 * 「这件装备在哪些版本里被改过」——版本页 ↔ 装备页之间的反向索引。
 *
 * 和 `patchHeroes` 是同一套做法、同一份已落盘的版本日志，只是把索引的键从英雄 id 换成物品内部名
 * （`item_power_treads` → `power_treads`，与 `items/json` 的键、`/items/[id]` 的路径参数一致）。
 *
 * 装备页原先只有参数（价格、效果、配方），没有「最近被削了没有」这一层——而那恰好是玩家查装备时
 * 最想先知道的一句话，也是英雄页早就有、装备页缺着的一块。顺带把版本页里的装备名接上（见
 * `patchNotes.renderItem`）：站内链接是权重在站内流动的唯一途径。
 */

/** 与英雄那边同形，直接复用，免得两个页面对「一个版本引用」的形状各有一套。 */
export type ItemPatchRef = HeroPatchRef;

let indexPromise: Promise<Map<string, ItemPatchRef[]>> | null = null;

/** 物品内部名 → 改过它的版本，按「新 → 旧」。整轮构建只算一次。 */
export function itemPatchIndex(): Promise<Map<string, ItemPatchRef[]>> {
	indexPromise ??= (async () => {
		const [updates, names] = await Promise.all([fetchPatchUpdates(), fetchPatchNames()]);
		await prefetchPatchNotes(updates);

		const index = new Map<string, ItemPatchRef[]>();
		for (const update of updates) {
			const notes = await fetchPatchNotes(update.id);
			if (!notes) continue;
			const ref: ItemPatchRef = {
				id: update.id,
				version: update.version,
				date: update.date,
				summary: summarizePatch(notes),
			};
			// 只认日志里**真正被改到**的物品，不是整份物品表。
			// 名字表里查不到的跳过（官方偶尔插的分组说明就是这种，它本来也不指向具体物品）。
			for (const item of notes.items ?? []) {
				const named = names.items.get(item.ability_id);
				if (!named?.key) continue;
				const list = index.get(named.key);
				if (list) list.push(ref);
				else index.set(named.key, [ref]);
			}
		}
		return index;
	})();
	return indexPromise;
}
