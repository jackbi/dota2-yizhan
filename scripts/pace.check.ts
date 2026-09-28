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
 * 跑：`pnpm check`（或 `node --experimental-strip-types scripts/pace.check.ts`）。
 */

let cases = 0;
const ok = (label: string): void => {
	cases += 1;
	console.log(`  ✓ ${label}`);
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// 1. 连着调三次：至少隔出两个间隔
{
	const pace = createPace(30);
	const started = Date.now();
	await pace();
	await pace();
	await pace();
	const elapsed = Date.now() - started;
	assert.ok(elapsed >= 60, `三次调用至少要隔 2×30ms，实际只有 ${elapsed}ms——限速没生效`);
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

console.log(`pace 全部断言通过（${cases} 组）`);
