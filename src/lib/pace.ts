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
			/*
			 * 记的是**本该出发的时刻**，不是实际醒来的时刻。
			 *
			 * `setTimeout` 不保证准点，实测能比墙钟早 1ms 左右；而 `Date.now()` 只有毫秒精度，
			 * 每次记「实际时刻」等于把这 1ms 误差一轮轮累加下去——连着两次 30ms 间隔，CI 上量到过
			 * 只有 59ms（`pace.check` 就是这么挂的，而且只在负载高的机器上挂）。
			 * 按计划时刻记，误差不会累积：第 N 次调用不会早于「第一次 + N × 间隔」。
			 *
			 * 空闲很久时计划时刻早就过去了，`Math.max` 会把它拉回当前时间，语义与之前一致。
			 */
			lastRequestAt = Math.max(lastRequestAt + intervalMs, Date.now());
		});
		return queue;
	};
}
