import assert from 'node:assert/strict';
import { createCache } from '../src/lib/ssrCache.ts';

/**
 * `src/lib/ssrCache.ts` 的自检。
 *
 * 这个缓存是 SSR 侧唯一的内存表，而它的上限原先只按**条数**算（400 条）。条数跟风险
 * 对不上：个人战绩页那份 `MatchDetail` 一份就几百 KB，400 条是上百 MB，Worker 的内存
 * 上限只有 128MB——撞上去是整个实例被回收，所有并发请求一起失败，而不是安静地少几条缓存。
 *
 * 所以这里盯三件事：
 *
 * 1. 不管往表里塞多大的值，记账的字节数都不能越过预算（预算才是防内存的那条线）；
 * 2. 条数上限还在，兜住"一堆小条目"那种撑法；
 * 3. 淘汰永远从最旧的开始，不能把刚写进去的那条挤掉——否则热门对局会一直重拉。
 *
 * 另外把「失败不缓存」「同一个 key 并发只发一次」也一起钉住，它们是这个模块的既有约定，
 * 正好在这里一并守住。
 *
 * 跑：`pnpm check`（或 `node --experimental-strip-types scripts/ssrCache.check.ts`）。
 */

let cases = 0;
const ok = (label: string): void => {
	cases += 1;
	console.log(`  ✓ ${label}`);
};

/** 一份约 10KB 的值，用来撑预算；`JSON.stringify` 之后约 20KB。 */
const bigValue = (): string => 'x'.repeat(10 * 1024);

// 1. 字节预算：塞的份数远超预算能装下的量，记账的字节数也不许越线
{
	const limits = { maxEntries: 1000, maxBytes: 60_000 };
	const cache = createCache(limits);
	const loads = new Map<string, number>();
	const load = (key: string) => async (): Promise<string> => {
		loads.set(key, (loads.get(key) ?? 0) + 1);
		return bigValue();
	};

	for (let i = 0; i < 8; i += 1) await cache.cached(`k${i}`, 60_000, load(`k${i}`));

	const { bytes, entries } = cache.stats();
	assert.ok(bytes <= limits.maxBytes, `记账字节数越过了预算：${bytes} > ${limits.maxBytes}`);
	assert.ok(entries < 8, `8 份 10KB 的值不可能都留在 60KB 的预算里，实际留了 ${entries} 条`);
	assert.equal(loads.get('k7'), 1, '刚写进去的那条必须在表里');
	assert.equal(loads.get('k0'), 1, '最旧的那条这时应当已经被淘汰，不该再多发一次请求');
	await cache.cached('k7', 60_000, load('k7'));
	assert.equal(loads.get('k7'), 1, '最新的那条不该被淘汰：热门对局一直重拉是明显更差的结果');
	await cache.cached('k0', 60_000, load('k0'));
	assert.equal(loads.get('k0'), 2, '最旧的那条要真的走了：再取一次必须重新加载');
	ok('字预算：总字节不越线，淘汰从最旧的开始');
}

// 2. 条数兜底：一堆小条目也不能把表撑成无界
{
	const cache = createCache({ maxEntries: 3, maxBytes: 10 * 1024 * 1024 });
	for (let i = 0; i < 6; i += 1) await cache.cached(`small${i}`, 60_000, async () => i);
	assert.equal(cache.stats().entries, 3, `条数上限应当是 3，实际 ${cache.stats().entries}`);
	assert.equal(await cache.cached('small5', 60_000, async () => -1), 5, '最新的小条目要留着');
	assert.equal(await cache.cached('small0', 60_000, async () => -1), -1, '被淘汰的那条要重新加载');
	ok('条数兜底：小条目按上限淘汰');
}

// 3. 同一个 key 重写：只记一份账，不能把上一次的字节留在预算里
{
	const cache = createCache({ maxEntries: 100, maxBytes: 10 * 1024 * 1024 });
	await cache.cached('same', 60_000, async () => bigValue());
	const afterBig = cache.stats().bytes;
	// ttl 给 0 就是"立刻过期"，逼出一次真正的重写。
	await cache.cached('same', 0, async () => 'tiny');
	const afterSmall = cache.stats().bytes;
	assert.equal(afterSmall, JSON.stringify('tiny').length * 2, `重写小值后应当只记小值的账，实际 ${afterSmall}`);
	assert.ok(afterSmall < afterBig, '重写同一 key 不能把两份字节叠在一起记账');
	ok('同一个 key 重写只记一份账');
}

// 4. 命中与 TTL：没过期不再加载，过期了要重新加载
{
	const cache = createCache({ maxEntries: 10, maxBytes: 10 * 1024 * 1024 });
	let calls = 0;
	const load = async (): Promise<number> => {
		calls += 1;
		return calls;
	};
	assert.equal(await cache.cached('ttl', 60_000, load), 1);
	assert.equal(await cache.cached('ttl', 60_000, load), 1, '没过期就该直接命中');
	assert.equal(calls, 1, '命中时不该再发请求');
	assert.equal(await cache.cached('ttl', 0, load), 2, 'ttl 为 0 等于立刻过期，必须重新加载');
	ok('命中与 TTL');
}

// 5. 并发同一个 key 只加载一次；失败既不写表、也不留在表里
{
	const cache = createCache({ maxEntries: 10, maxBytes: 10 * 1024 * 1024 });
	let started = 0;
	const slow = (): Promise<string> =>
		new Promise((resolve) => {
			started += 1;
			setTimeout(() => resolve('done'), 5);
		});
	const [a, b] = await Promise.all([cache.cached('race', 60_000, slow), cache.cached('race', 60_000, slow)]);
	assert.equal(a, 'done');
	assert.equal(b, 'done');
	assert.equal(started, 1, '同一个 key 并发未命中时只该发一次请求，其余复用同一个 Promise');

	let attempts = 0;
	const flaky = async (): Promise<string> => {
		attempts += 1;
		if (attempts === 1) throw new Error('上游挂了');
		return '第二次成功';
	};
	await assert.rejects(() => cache.cached('flaky', 60_000, flaky), '加载失败必须抛给调用方，不能吞掉');
	assert.equal(await cache.cached('flaky', 60_000, flaky), '第二次成功', '失败的那次不能留在缓存里，下一次要能重试');
	assert.equal(attempts, 2);
	ok('并发合并与失败不缓存');
}

console.log(`ssrCache.check 通过（${cases} 组用例）`);
