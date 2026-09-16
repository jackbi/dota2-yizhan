import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CACHE_KEEP_DAYS, pruneCacheDirs } from '../src/lib/cachePrune.ts';

/**
 * `src/lib/cachePrune.ts` 的自检。
 *
 * 这个函数**会删文件**，所以边界必须钉死：老的删、新的留、被跳过的目录一个都不动、根目录的散文件
 * 不动、`*.tmp` 无论年龄都清。整棵测试树建在 `mkdtemp` 里，跑完就删。
 *
 * 跑：`pnpm check`（或 `node --experimental-strip-types scripts/cachePrune.check.ts`）。
 */
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cacheprune-check-'));
const DAY = 24 * 60 * 60 * 1000;
const now = Date.UTC(2026, 0, 1);
const old = new Date(now - (CACHE_KEEP_DAYS + 1) * DAY);
const fresh = new Date(now - 1 * DAY);
let cases = 0;

/** 建一个文件并把它设成指定年龄。 */
async function plant(rel: string, mtime: Date): Promise<string> {
	const file = path.join(root, rel);
	await fs.mkdir(path.dirname(file), { recursive: true });
	await fs.writeFile(file, 'x');
	await fs.utimes(file, mtime, mtime);
	return file;
}

const exists = (file: string): Promise<boolean> =>
	fs.access(file).then(
		() => true,
		() => false,
	);

try {
	const oldJson = await plant('news/old.json', old);
	const freshJson = await plant('news/fresh.json', fresh);
	const boundary = await plant('news/boundary.json', new Date(now - CACHE_KEEP_DAYS * DAY));
	const freshTmp = await plant('news/half.json.1234.0.tmp', fresh);
	const oldTmp = await plant('community/old.json.99.3.tmp', old);
	// 图片频道（30 天规则）与 health（每轮清空）都不该被这里动。
	const imageOld = await plant('avatars/keep.jpg', old);
	const healthOld = await plant('health/live.json', old);
	// 根目录的散文件同样不动。
	const rootFile = await plant('tournaments.json', old);

	const summary = await pruneCacheDirs(root, { skip: ['avatars', 'health'], now });

	// 1. 老的删了，新的留着。
	assert.equal(await exists(oldJson), false, '超过 180 天的 JSON 应该删掉');
	assert.equal(await exists(freshJson), true, '一天前的 JSON 不该动');
	cases += 1;

	// 2. 边界：正好 180 天的留着（判据是 `>=` cutoff）。
	assert.equal(await exists(boundary), true, '正好等于 180 天的应该留着');
	cases += 1;

	// 3. `*.tmp` 无论年龄都清（它只是写入中转，从来不是有效缓存）。
	assert.equal(await exists(freshTmp), false, '新的 `.tmp` 也该清掉');
	assert.equal(await exists(oldTmp), false, '老的 `.tmp` 该清掉');
	cases += 1;

	// 4. 被跳过的目录一个都不动。
	assert.equal(await exists(imageOld), true, '图片频道有自己的回收规则，这里不该删');
	assert.equal(await exists(healthOld), true, 'health 每轮构建开头整目录清空，这里不动');
	cases += 1;

	// 5. 根目录散文件不动。
	assert.equal(await exists(rootFile), true, '根目录的散文件各有各的覆盖策略，不该删');
	cases += 1;

	// 6. 计数对得上（news 里删了 1 个过期 + 1 个 tmp，community 里 1 个 tmp）。
	assert.equal(summary.removed, 1, `removed 计数不对：${summary.removed}`);
	assert.equal(summary.tmpRemoved, 2, `tmpRemoved 计数不对：${summary.tmpRemoved}`);
	assert.ok(summary.dirs >= 2, `dirs 计数不对：${summary.dirs}`);
	cases += 1;

	// 7. 目录不存在时安静返回（第一次构建就是这种状态）。
	const missing = await pruneCacheDirs(path.join(root, 'nope'), { now });
	assert.deepEqual(missing, { removed: 0, tmpRemoved: 0, dirs: 0 }, '没有缓存目录时应该什么都不做');
	cases += 1;
} finally {
	await fs.rm(root, { recursive: true, force: true });
}

console.log(`cachePrune.check: ${cases} 组用例通过`);
