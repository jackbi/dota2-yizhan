import assert from 'node:assert/strict';
import { createPace } from '../src/lib/pace.ts';

/**
 * `src/lib/pace.ts` 的自检。
 *
 * 这个模块是**上游的防弹衣**：STRATZ 的额度按秒/分/时/天四档计，NGA、虎扑、Liquipedia 也都
 * 会因为请求太密直接封。它坏掉的表现不是报错，而是"偶发 429 / 偶发拉不到数据"——而偶发的
 * 失败最难往回查。所以把两件事钉住：
 *
 * 1. 连着调 N 次，总耗时不能少于 (N-1) × 间隔（排队排的是等待，不是请求，但效果上等价）；
 * 2. 排队**按调用顺序**，而且中间已经等够了就不再补等——否则一轮构建会被无谓地拖长。
 *
 * 第 1 条是**墙钟量调度器**，量不准：`setTimeout` 不保证准点，实测会早 1ms 左右，CI 上就因此
 * 偶发挂过（连着两次 30ms 间隔量到 59ms）。所以墙钟那条留 3ms 余量——它要抓的是"完全没排队"
 * （那只有 0~2ms），而不是毫秒级的抖动。真正的「误差不累积」由第 5 组用假时钟钉死。
 *
 * 跑：`pnpm check`（或 `node --experimental-strip-types scripts/pace.check.ts`）。
 */

let cases = 0;
const ok = (label: string): void => {
	cases += 1;
	console.log(`  ✓ ${label}`);
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// 1. 连着调五次：至少隔出四个间隔（余量 3ms，见文件头）
{
	const pace = createPace(30);
	const started = Date.now();
	for (let i = 0; i < 5; i += 1) await pace();
	const elapsed = Date.now() - started;
	assert.ok(elapsed >= 120 - 3, `五次调用至少要隔 4×30ms，实际只有 ${elapsed}ms——限速没生效`);
	ok('连着调用按间隔排队');
}

// 2. 排队按调用顺序，不是"最后调的先跑"
{
	const pace = createPace(10);
	const order: number[] = [];
	await Promise.all(
		[0, 1, 2, 3].map(async (i) => {
			await pace();
			order.push(i);
		}),
	);
	assert.deepEqual(order, [0, 1, 2, 3], '一次并发调用里，谁先排队谁先过');
	ok('排队按调用顺序');
}

// 3. 中间已经等够了就不再补等：否则一轮构建会凭空多出几百次无谓的 sleep
{
	const pace = createPace(50);
	await pace();
	await sleep(70);
	const started = Date.now();
	await pace();
	const elapsed = Date.now() - started;
	assert.ok(elapsed < 40, `距上次已经过了 70ms（超过 50ms 的间隔），这一次不该再等，实际等了 ${elapsed}ms`);
	ok('距上次已超过间隔时不再补等');
}

// 4. 间隔为 0 就是不限速（有的调用点只是要串行，不要求间隔）
{
	const pace = createPace(0);
	const started = Date.now();
	for (let i = 0; i < 5; i += 1) await pace();
	assert.ok(Date.now() - started < 100, 'interval 为 0 时不该引入延迟');
	ok('间隔为 0 时不引入延迟');
}

/*
 * 5. 假时钟：**「早醒」的误差不许一轮轮累积**。
 *
 * 真定时器每次早醒 1ms，如果每次也把「实际醒来的时刻」当成下一次的基准，误差就会随调用次数
 * 线性叠加——调用 20 次，实际间隔会变成 29ms 而不是 30ms，等于把上游的限速悄悄放宽 3%。
 * 这件事在墙钟上量不准（上面那条只能靠余量兜），所以这里换一个**完全确定的时钟**：
 * `Date.now()` 归我们管，`setTimeout(fn, ms)` 一律「过 ms-1 毫秒后同步执行」。
 */
{
	const realNow = Date.now;
	const realSetTimeout = globalThis.setTimeout;
	let clock = 1_000;

	Date.now = () => clock;
	globalThis.setTimeout = ((fn: () => void, ms?: number) => {
		clock += Math.max(0, (ms ?? 0) - 1);
		fn();
		return 0;
	}) as unknown as typeof globalThis.setTimeout;

	try {
		const calls = 20;
		const pace = createPace(30);
		const started = clock;
		for (let i = 0; i < calls; i += 1) await pace();
		const elapsed = clock - started;
		assert.ok(
			elapsed >= (calls - 1) * 30 - 1,
			`${calls} 次调用应当至少推进 ${(calls - 1) * 30}ms（允许早醒 1ms），实际只有 ${elapsed}ms——` +
				'早醒的误差在累积，限速被悄悄放宽了',
		);
		ok('定时器早醒时，误差不随调用次数累积');
	} finally {
		Date.now = realNow;
		globalThis.setTimeout = realSetTimeout;
	}
}

console.log(`pace 全部断言通过（${cases} 组）`);
