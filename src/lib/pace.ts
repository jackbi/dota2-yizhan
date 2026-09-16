/**
 * 串行限速：保证两次请求之间至少隔 `intervalMs`。
 *
 * 单独一个文件、**不碰 `node:*`**：构建期（`ngaApi` / `opendota` / `stratzApi` …）与运行时
 * （`ssrCache`）都要用它，而运行时那份要能上 Cloudflare Workers——`buildCache.ts` 里有
 * `node:fs`，SSR 侧不能引它。
 *
 * 排队的是**等待**，不是请求本身。（`translate.ts` 那个把工作一起排进队列的版本语义不同，
 * 没有并到这里。）
 */
export function createPace(intervalMs: number): () => Promise<void> {
	let lastRequestAt = 0;
	let queue: Promise<void> = Promise.resolve();
	return () => {
		queue = queue.then(async () => {
			const wait = lastRequestAt + intervalMs - Date.now();
			if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
			lastRequestAt = Date.now();
		});
		return queue;
	};
}
