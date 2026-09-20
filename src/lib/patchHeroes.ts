import { fetchPatchNotes, fetchPatchNames, fetchPatchUpdates, prefetchPatchNotes } from './patchesApi';
import { summarizePatch } from './patchNotes';

/**
 * 「这个英雄在哪些版本里被改过」——版本页 ↔ 英雄页之间的反向索引。
 *
 * 为什么要单独做这一层：英雄页与更新日志页原来是两座孤岛，而**站内链接是权重在站内流动的
 * 唯一途径**（比在标题里堆关键词有用得多）。玩家查英雄时最想知道的一件事也正好是
 * 「最近被削了没有」——这不是为了 SEO 硬加的入口，是本来就缺的一块内容。
 *
 * 数据全部来自构建期已经落盘的版本日志：先 `prefetchPatchNotes` 并发预热（版本详情页本来就会
 * 做这一步，这里只是保证英雄页先渲染时也不至于串行抓一百多次），再在内存里折成一张表。
 */

export interface HeroPatchRef {
	/** 版本详情页的路径参数，就是版本号本身（`7.41f`）。 */
	id: string;
	version: string;
	date: string;
	/** 一句话摘要，形如「12 名英雄 · 3 件物品」。 */
	summary: string;
}

let indexPromise: Promise<Map<number, HeroPatchRef[]>> | null = null;

/** 英雄 id → 改过它的版本，按「新 → 旧」。整轮构建只算一次。 */
export function heroPatchIndex(): Promise<Map<number, HeroPatchRef[]>> {
	indexPromise ??= (async () => {
		const [updates, names] = await Promise.all([fetchPatchUpdates(), fetchPatchNames()]);
		await prefetchPatchNotes(updates);

		const index = new Map<number, HeroPatchRef[]>();
		for (const update of updates) {
			const notes = await fetchPatchNotes(update.id);
			if (!notes) continue;
			const ref: HeroPatchRef = {
				id: update.id,
				version: update.version,
				date: update.date,
				summary: summarizePatch(notes),
			};
			// 取的是日志里**真正被改到**的英雄（`notes.heroes`），不是整份英雄表。
			// 名字表里没有的跳过：datafeed 里「熊灵」占一个英雄位但没有名字，也就没有英雄页。
			for (const hero of notes.heroes ?? []) {
				const heroId = hero.hero_id;
				if (!names.heroes.has(heroId)) continue;
				const list = index.get(heroId);
				if (list) list.push(ref);
				else index.set(heroId, [ref]);
			}
		}
		return index;
	})();
	return indexPromise;
}
