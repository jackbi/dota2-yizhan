import assert from 'node:assert/strict';

/**
 * 英雄详情缓存的自检：**失败不能被缓存**。
 *
 * `heroApi` 把「按 id 去重」做在 promise 上——英雄页的 `getStaticPaths` 会拉 127 份，没有这层
 * 去重就白拉第二遍。但缓存一个**失败的** promise 就完全是另一回事：一次网络抖动会让这个英雄在本
 * 进程里永久坏掉（构建要么整轮失败，要么把它烘成全 0 的角色数据），而页面上只表现为"这个英雄没数据"。
 *
 * 所以两个方向都钉住：失败要抛给调用方、并且能被下一个调用者重试；成功要留在缓存里、不再发第二次请求。
 *
 * 跑：`pnpm check`（或 `node --experimental-strip-types scripts/heroCache.check.ts`）。
 */

const realFetch = globalThis.fetch;
let calls = 0;
/** 官方的英雄详情要 `status: 'success'`，缺了会被 `getJson` 当成失败。 */
const okBody = JSON.stringify({
	status: 'success',
	result: { heroes: { abilities: [], role_levels: [], bio_loc: '', hype_loc: '' } },
});

globalThis.fetch = (async () => {
	calls += 1;
	if (calls === 1) throw new TypeError('fetch failed');
	return new Response(okBody, { status: 200, headers: { 'content-type': 'application/json' } });
}) as typeof fetch;

try {
	const { fetchHero } = await import('../src/lib/heroApi.ts');

	await assert.rejects(() => fetchHero(1), '第一次失败要抛给调用方，不能吞掉');
	assert.equal(calls, 1, '第一次应当真的发了请求');

	let hero: { id?: unknown } | null = null;
	try {
		hero = await fetchHero(1);
	} catch (error) {
		// 旧实现下会走到这里：缓存里还是那个失败的 promise，第二个调用者拿到的是无重试的失败。
		assert.fail(`第二次调用又拿到了那次失败的结果（没有重试）：${error instanceof Error ? error.message : String(error)}`);
	}
	assert.equal(calls, 2, '第二次必须重新发请求：失败的那次不能留在缓存里');
	assert.equal(hero?.id, undefined, '桩数据没有 id，能走到这里说明拿到的确实是桩返回');

	await fetchHero(1);
	assert.equal(calls, 2, '成功的结果要留在缓存里（英雄页会拉 127 份，重复请求等于白拉）');
} finally {
	globalThis.fetch = realFetch;
}

console.log('heroCache.check 通过');
