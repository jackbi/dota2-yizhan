import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
	imageIntegrity,
	inspectImageFile,
	isFresh,
	readCacheJson,
	readCacheText,
	writeCacheBytes,
	writeCacheFile,
} from '../src/lib/buildCache.ts';

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

	/*
	 * 6. 二进制那份（图片走它）：写得进去、读得回来、不留临时文件，而且**写不进去要抛**。
	 *
	 * 图片的命中判定是 `fs.access`，所以半张 JPG 一旦落到最终路径上就会被当成已有缓存、
	 * 还会被拷进 dist 变成永久破图；而写失败必须让调用方知道，它要按"取失败"计数。
	 */
	{
		const file = path.join(dir, 'image.bin');
		await writeCacheBytes(file, new Uint8Array([1, 2, 3]));
		assert.deepEqual([...(await fs.readFile(file))], [1, 2, 3], '字节要原样写进去');
		const nested = path.join(dir, 'images', 'deep', 'x.jpg');
		await writeCacheBytes(nested, new Uint8Array([9]));
		assert.deepEqual([...(await fs.readFile(nested))], [9], '嵌套目录也要能写');

		const leftovers = (await fs.readdir(dir)).filter((name) => name.endsWith('.tmp'));
		assert.deepEqual(leftovers, [], `二进制写留下了临时文件：${leftovers.join('、')}`);

		// 把文件当目录用：必然失败，且要抛出来（不是像文本那份那样吞掉）。
		await assert.rejects(
			() => writeCacheBytes(path.join(file, 'inner.bin'), new Uint8Array([1])),
			'二进制缓存写失败必须抛给调用方，图片那边要按失败计数',
		);
			cases += 1;
		}
} finally {
	await fs.rm(dir, { recursive: true, force: true });
}

/*
 * 图片缓存的**读侧**：命中判定不能只看"文件在不在"。
 *
 * 原子写只护住了新产生的文件；被 kill 掉的构建、或 CI 把 `.cache/` 的滚动缓存还原到一半，
 * 留下的半张 JPG 会被当成命中，刷一下 mtime 就照旧拷进 `dist/`。所以这里按头尾两小段判。
 */
{
	const jpegHead = [0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10];
	const jpegTail = [0x00, 0x11, 0xff, 0xd9];
	const pngHead = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
	const pngTail = [0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82];
	const u8 = (bytes: number[]): Uint8Array => new Uint8Array(bytes);

	assert.equal(imageIntegrity(u8(jpegHead), u8(jpegTail)), 'complete', 'JPEG 的 FFD9 收尾 = 写完');
	assert.equal(imageIntegrity(u8(jpegHead), u8([0x00, 0x11])), 'incomplete', '没有 FFD9 就是半张');
	assert.equal(imageIntegrity(u8(pngHead), u8(pngTail)), 'complete', 'PNG 的 IEND 块 = 写完');
	assert.equal(imageIntegrity(u8(pngHead), u8([1, 2, 3])), 'incomplete');
	assert.equal(imageIntegrity(u8([0x47, 0x49, 0x46, 0x38]), u8([0x3b])), 'unknown', '认不出的格式别当坏了：否则每轮重下一遍');

	const imgDir = await fs.mkdtemp(path.join(os.tmpdir(), 'buildcache-img-'));
	const file = path.join(imgDir, 'integrity.jpg');
	await writeCacheBytes(file, u8([...jpegHead, 0x01, 0x02, ...jpegTail]));
	assert.equal(await inspectImageFile(file), 'complete');
	// 半张：只有头，没有收尾（模拟构建被 kill / 缓存还原到一半）
	await fs.writeFile(file, u8(jpegHead));
	assert.equal(await inspectImageFile(file), 'incomplete', '半张 JPG 必须被认出来，否则它会一直当命中');
	assert.equal(await inspectImageFile(path.join(os.tmpdir(), 'no-such-image-check.jpg')), 'incomplete', '文件不在也算没写完');
	await fs.rm(imgDir, { recursive: true, force: true });
	cases += 1;
}

console.log(`buildCache.check: ${cases} 组用例通过`);
