import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * 构建期缓存的回收（图片之外的那些）。
 *
 * 图片有自己的回收：`astro.config.mjs` 的 `pruneImages()` 按「30 天没被用到」删，因为
 * `localImages()` 特意把 mtime 用作「本轮用到过」的标记。这里管其余按 key 落盘的 JSON / HTML——
 * 它们写下去之后就再没人看过年龄，而 key 有相当一部分来自「当前内容」（热帖详情、新闻正文、
 * 翻译），于是缓存随每次重建单调增长：实测 `community/` 196 个、`patches/` 122 个、
 * `translate/` 240 个文件，总共十几 MB。单条都小，但几年下来是几万个文件，备份与同步的代价会浮出来。
 *
 * 判据和图片一样用 mtime，但**语义不同**：JSON 缓存的 mtime 是「上次写入」（命中缓存**不会**
 * 刷新它，只有真正联网抓回来才写）。所以窗口必须放得很宽——删早了的代价是「上游恢复后本来能命中的
 * 兜底缓存没了，得重抓一次」，因此 `CACHE_KEEP_DAYS` 给到 180 天：TTL 最长的那几种也就 30 天，
 * 半年没写过的条目，对应的内容多半早就不在页面上了。
 */

/** 多久没写过就删（天）。 */
export const CACHE_KEEP_DAYS = 180;

export interface PruneSummary {
	/** 删掉的过期缓存文件数。 */
	removed: number;
	/** 顺手清掉的 `*.tmp` 残留：`writeCacheFile()` 的中转文件，进程被 kill 时会留下。 */
	tmpRemoved: number;
	/** 扫过的目录数。 */
	dirs: number;
}

/**
 * 扫 `.cache/<dir>/` 删掉过期文件，返回这次动了多少。
 *
 * `skip` 里的目录一律不碰：图片频道有自己那套 30 天规则，`health/` 每轮构建开头整目录清空。
 * 只扫**一级子目录**（实测缓存就是这个形状），根目录下的散文件（`tournaments.json` 等）也不动——
 * 它们各有各的覆盖策略。
 *
 * 删除失败只跳过那一个文件：回收是维护动作，不该让构建挂掉。
 */
export async function pruneCacheDirs(
	root: string,
	options: { keepDays?: number; skip?: string[]; now?: number } = {},
): Promise<PruneSummary> {
	const keepDays = options.keepDays ?? CACHE_KEEP_DAYS;
	const skip = new Set(options.skip ?? []);
	const cutoff = (options.now ?? Date.now()) - keepDays * 24 * 60 * 60 * 1000;
	const summary: PruneSummary = { removed: 0, tmpRemoved: 0, dirs: 0 };

	let entries;
	try {
		entries = await fs.readdir(root, { withFileTypes: true });
	} catch {
		// 还没有 `.cache/`（第一次构建）——没什么可回收的。
		return summary;
	}

	for (const entry of entries) {
		if (!entry.isDirectory() || skip.has(entry.name)) continue;
		const dir = path.join(root, entry.name);
		summary.dirs += 1;

		let files;
		try {
			files = await fs.readdir(dir, { withFileTypes: true });
		} catch {
			continue;
		}

		for (const file of files) {
			if (!file.isFile()) continue;
			const target = path.join(dir, file.name);
			try {
				// `*.tmp` 是写入中转，任何年龄都不该留（见 `buildCache.ts` 的原子写）。
				if (file.name.endsWith('.tmp')) {
					await fs.rm(target, { force: true });
					summary.tmpRemoved += 1;
					continue;
				}
				// 正好等于 cutoff 的留着：`>=` 而不是 `>`，边界上是「还没到 180 天」。
				if ((await fs.stat(target)).mtimeMs >= cutoff) continue;
				await fs.rm(target, { force: true });
				summary.removed += 1;
			} catch {
				// 单个文件删不掉不影响构建。
			}
		}
	}

	return summary;
}
