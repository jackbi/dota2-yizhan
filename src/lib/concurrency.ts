/**
 * 并发小工具。
 *
 * 三个数据层（新闻、社区、Reddit）都要「限制并发地遍历一批异步任务」，
 * 之前各自抄了一份，统一放这里。
 */
export async function mapLimit<T>(items: T[], limit: number, run: (item: T) => Promise<void>): Promise<void> {
	let cursor = 0;
	const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
		while (cursor < items.length) await run(items[cursor++]);
	});
	await Promise.all(workers);
}
