import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { isFresh, readCacheJson, readCacheText, writeCacheFile } from '../src/lib/buildCache.ts';

/**
 * `src/lib/buildCache.ts` 的自检。
 *
 * 这一层的失败模式都很安静：写坏了只当没命中、读到半截内容却会照用（新闻正文那份缓存的 TTL
 * 是「永久」）。所以这里盯三件事：**能读回来**、**校验不过就是没命中**、**并发写读不会读到半截**。
 *
 * 最后一条是这次改动的核心（`writeFile` → 临时文件 + `rename`）。它有竞态成分，注释里写明了它
 * 是「不变量检查」而不是「确定能复现旧 bug 的用例」——旧实现下读到大载荷的概率很高，但不是 100%。
 *
 * 跑：`pnpm check`（或 `node --experimental-strip-types scripts/buildCache.check.ts`）。
 */
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'buildcache-check-'));
let cases = 0;

try {
	// 1. 写进去、读回来，年龄是新的。
	{
		const file = path.join(dir, 'roundtrip.json');
		await writeCacheFile(file, JSON.stringify({ a: 1 }));
		const hit = await readCacheJson<{ a: number }>(file);
		assert.ok(hit, '写完立刻读应该命中');
		assert.equal(hit.value.a, 1);
		// `mtimeMs` 的精度比 `Date.now()` 高，刚写完时年龄可能是 -0.3ms 这样的极小负数。
		assert.ok(hit.ageMs > -1000 && hit.ageMs < 60_000, `年龄不对：${hit.ageMs}`);
		// 目录不存在也要能写（构建第一次跑时 `.cache/` 是空的）。
		const nested = path.join(dir, 'deep', 'nested', 'x.json');
		await writeCacheFile(nested, '{"ok":true}');
		assert.ok(await readCacheJson(nested), '嵌套目录应该被自动创建');
		cases += 1;
	}

	// 2. 校验不过 = 没命中（两个 reader 都是这个语义）。
	{
		const json = path.join(dir, 'invalid.json');
		await writeCacheFile(json, JSON.stringify({ v: 1 }));
		assert.equal(await readCacheJson(json, () => false), null, '校验不过的 JSON 不该命中');
		assert.ok(await readCacheJson(json, () => true), '校验通过才命中');

		const text = path.join(dir, 'invalid.html');
		await writeCacheFile(text, '<html>半截');
		assert.equal(await readCacheText(text, (t) => t.trimEnd().endsWith('</html>')), null, '半截 HTML 不该命中');
		await writeCacheFile(text, '<html></html>');
		assert.ok(await readCacheText(text, (t) => t.trimEnd().endsWith('</html>')), '完整 HTML 应该命中');
		cases += 1;
	}

	// 3. 并发写 + 并发读：读到的要么是「还没有这个文件」，要么是**某一个完整载荷**，绝不会是半截。
	{
		const file = path.join(dir, 'race.json');
		const payloads = Array.from({ length: 6 }, (_, i) => JSON.stringify({ i, pad: 'x'.repeat(1_000_000) }));
		let writing = true;
		let sawTorn = 0;
		let seen = 0;
		let reads = 0;
		const reader = (async () => {
			while (writing) {
				const hit = await readCacheText(file);
				reads += 1;
				if (!hit) continue; // 第一轮写还没落下，正常。
				if (!payloads.includes(hit.text)) sawTorn += 1;
				else seen += 1;
			}
		})();
		for (const payload of payloads) await writeCacheFile(file, payload);
		writing = false;
		await reader;
		assert.equal(sawTorn, 0, `读到了 ${sawTorn} 次半截内容`);
		assert.ok(seen > 0 && reads > seen, '读者没有真正与写重叠，这条用例没说明力');
		cases += 1;
	}

	// 4. 写完不留临时文件（`*.tmp` 是 `rename` 之前的中转，留在缓存目录里只会越攒越多）。
	{
		const leftovers = (await fs.readdir(dir)).filter((name) => name.endsWith('.tmp'));
		assert.deepEqual(leftovers, [], `留下了临时文件：${leftovers.join('、')}`);
		cases += 1;
	}

	// 5. `isFresh` 的边界：正好等于 TTL 时不算新鲜（`<`，不是 `<=`）。
	{
		assert.ok(isFresh(0, 60));
		assert.ok(isFresh(59_999, 60));
		assert.ok(!isFresh(60_000, 60));
		assert.ok(!isFresh(0, 0));
		cases += 1;
	}
} finally {
	await fs.rm(dir, { recursive: true, force: true });
}

console.log(`buildCache.check: ${cases} 组用例通过`);
