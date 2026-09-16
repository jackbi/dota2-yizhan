import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * 构建期缓存与限速的公共实现。
 *
 * 这些取数 lib 原先各写一份 `readCache` / `writeCache` / `pace`（十几个文件里重复），
 * 行为已经开始漂移：TTL 有的比文件 `mtimeMs`、有的靠内容里存的 `at`、有的干脆没有；
 * 写入失败有的吞掉、有的会让整个构建挂掉。
 *
 * 这里只收敛**机制**——路径、读写、过期判断、串行限速。TTL 与形状校验留在各文件，
 * 因为那些差异是有意的（缓存里存的形状、版本号、离线兜底各不同），统一反而会改行为。
 */

/** 缓存文件路径。各文件自己拼文件名（键、哈希、固定名都行）。 */
export function cacheFile(dir: string, name: string): string {
	return path.join(dir, name);
}

/**
 * 读一个 JSON 缓存，连带它的年龄。
 * 文件不存在、内容坏掉、或 `validate` 不通过，都算没命中。
 */
export async function readCacheJson<T>(
	file: string,
	validate?: (value: unknown) => boolean,
): Promise<{ value: T; ageMs: number } | null> {
	try {
		const stat = await fs.stat(file);
		const value = JSON.parse(await fs.readFile(file, 'utf8')) as T;
		if (validate && !validate(value)) return null;
		return { value, ageMs: Date.now() - stat.mtimeMs };
	} catch {
		return null;
	}
}

/** 读一个文本缓存（HTML 等），连带它的年龄。 */
export async function readCacheText(file: string): Promise<{ text: string; ageMs: number } | null> {
	try {
		const stat = await fs.stat(file);
		return { text: await fs.readFile(file, 'utf8'), ageMs: Date.now() - stat.mtimeMs };
	} catch {
		return null;
	}
}

/** 只读内容、不看年龄：离线构建与「上游失败就退回旧缓存」两条路用它。 */
export async function readRawText(file: string): Promise<string | null> {
	try {
		return await fs.readFile(file, 'utf8');
	} catch {
		return null;
	}
}

/** 同上，但解析成 JSON。 */
export async function readRawJson<T>(file: string): Promise<T | null> {
	const raw = await readRawText(file);
	if (raw === null) return null;
	try {
		return JSON.parse(raw) as T;
	} catch {
		return null;
	}
}

/**
 * 写缓存。失败只吞掉——缓存写不进去不该让构建挂掉（原先只有一半的调用点这么做）。
 */
export async function writeCacheFile(file: string, data: string): Promise<void> {
	try {
		await fs.mkdir(path.dirname(file), { recursive: true });
		await fs.writeFile(file, data, 'utf8');
	} catch {
		// 缓存写不进去不影响构建。
	}
}

/** 年龄是否还在 TTL 内。 */
export function isFresh(ageMs: number, ttlSeconds: number): boolean {
	return ageMs < ttlSeconds * 1000;
}
