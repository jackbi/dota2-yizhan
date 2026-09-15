import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { mapLimit } from './concurrency';
import { PROXY_MODE } from './fetchText';

/**
 * 图片本地化：构建期把第三方 CDN 上的图取回来，换成本站路径。
 *
 * ## 为什么要自己存一份
 *
 * 最直接的原因是**本机到这些 CDN 的连接会被网络重置**：`curl https://i0.hdslb.com/...`
 * 连 TLS 握手都过不去（ClientHello 发出去就 RST），斗鱼的 `douyucdn`、虎牙的 `huyaimg`
 * 也一样。直链交给浏览器，出不出图就取决于访客自己走的那条线路——B站封面就是
 * 「首次打开一排破图、刷几次又慢慢出来」。
 *
 * 另外三个理由：
 * - 虎牙给的是 `http://` 地址，站点走 HTTPS 就是混合内容，浏览器直接拦掉；
 * - 允不允许外链由平台随时决定，判不判 Referer 我们控制不了，失败就是一排破图；
 * - 顺带也不把访客的 IP 送给平台 CDN。
 *
 * ## 两条路
 *
 * 直连优先，被重置时退回 `wsrv.nl` 图片代理——顺便让它裁成需要的尺寸，
 * 因为各家原图的比例和体积都不一样。`LIVE_PROXY` 同样管这里：`off` 只直连，
 * `jina` 只走代理。
 *
 * ## 落盘与发布
 *
 * 字节存在 `.cache/<dir>/`（不进 git），文件名是「调用方的键 + 地址哈希」——
 * 地址一变就是新文件，不会串图。构建结束由 `astro.config.mjs` 的集成把**本轮用到过**
 * 的文件拷进 `dist/<dir>/`：用到的文件在这里会把 mtime 刷新成当前时间，拷的时候以此判断，
 * 免得像房间列表那样越攒越多（房间下榜后它的头像也不该继续占着 dist）。
 *
 * 多进程：Astro 会并行开多个渲染进程，每个进程都会跑一遍本模块，可能重复下载同一个文件。
 * 内容一样、后写的覆盖先写的，所以只是多花一点流量，不会出错。
 */

/** 一个图片频道：一类尺寸相同、发布到同一个目录的图。 */
export interface ImageChannel {
	/** `.cache/` 与 `dist/` 下的子目录名，页面里用的就是 `/<dir>/xxx.jpg`。 */
	dir: string;
	/** 代理裁剪出的尺寸，也是落盘尺寸。 */
	width: number;
	height: number;
	/** 单张字节上限：一张卡片图不该有这么大，超过就当成出错了。 */
	maxBytes: number;
	/** 同一个主机的并发数。 */
	concurrency: number;
}

/** 一个待本地化的图片来源。 */
export interface LocalImageSource {
	/** 调用方回查用的键，例如 `douyu:9999` 或封面原地址。 */
	key: string;
	/** 第三方 CDN 地址；没有就不渲染这张图。 */
	url?: string;
	/** 文件名的可读前缀，默认由 `key` 推导。 */
	slug?: string;
}

const CACHE_ROOT = path.join(process.cwd(), '.cache');
const OFFLINE = process.env.TOURNAMENTS_OFFLINE === '1';
const DIRECT_TIMEOUT_MS = 8000;
const PROXY_TIMEOUT_MS = 25_000;
const IMAGE_PROXY = 'https://wsrv.nl/';

const UA =
	'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/** `.cache/<dir>` 的绝对路径。 */
export function imageCacheDir(channel: ImageChannel): string {
	return path.join(CACHE_ROOT, channel.dir);
}

/** 站内路径，页面与 payload 里用的都是它。 */
export function imageUrl(channel: ImageChannel, fileName: string): string {
	return `/${channel.dir}/${fileName}`;
}

/**
 * 文件名带调用方的键，出问题时一眼能看出是谁的；哈希保证地址变化会换文件。
 *
 * 键里的非字母数字会被压成 `-`（`douyu:9999` → `douyu-9999`），所以键只要稳定，
 * 换不换 slug 都不影响缓存命中。
 */
export function imageFileName(key: string, slug: string | undefined, url: string): string {
	const base = (slug ?? key)
		.replace(/[^a-zA-Z0-9]+/g, '-')
		.replace(/^-|-$/g, '')
		.toLowerCase();
	const hash = createHash('sha1').update(url).digest('hex').slice(0, 8);
	return `${base}-${hash}.jpg`;
}

async function readImage(res: Response, maxBytes: number): Promise<Uint8Array | null> {
	if (!res.ok) return null;
	const type = res.headers.get('content-type') ?? '';
	// 平台挡外链时返回的是一张 HTML 提示页，content-type 一看就知道。
	if (!type.startsWith('image/')) return null;
	const bytes = new Uint8Array(await res.arrayBuffer());
	return bytes.byteLength > 0 && bytes.byteLength <= maxBytes ? bytes : null;
}

async function tryDirect(url: string, channel: ImageChannel): Promise<Uint8Array | null> {
	if (PROXY_MODE === 'jina') return null;
	try {
		const res = await fetch(url, {
			headers: { 'User-Agent': UA, Accept: 'image/avif,image/webp,image/*,*/*;q=0.8' },
			signal: AbortSignal.timeout(DIRECT_TIMEOUT_MS),
		});
		return await readImage(res, channel.maxBytes);
	} catch {
		// 本机到 douyucdn / huyaimg / hdslb 就是被重置的，换代理。
		return null;
	}
}

async function tryProxy(url: string, channel: ImageChannel): Promise<Uint8Array | null> {
	if (PROXY_MODE === 'off') return null;
	try {
		const query = `url=${encodeURIComponent(url)}&w=${channel.width}&h=${channel.height}&fit=cover&output=jpg`;
		const res = await fetch(`${IMAGE_PROXY}?${query}`, { signal: AbortSignal.timeout(PROXY_TIMEOUT_MS) });
		return await readImage(res, channel.maxBytes);
	} catch {
		return null;
	}
}

/**
 * 把一批图下载到本地，返回 `key → /<dir>/xxx.jpg`。
 *
 * 拿不到的不会出现在返回值里——调用方据此退回首字母占位或原始外链，
 * 所以不存在「文件没拷过去、页面上留一堆破图」的情况。
 */
export async function localizeImages(
	channel: ImageChannel,
	sources: LocalImageSource[],
): Promise<Map<string, string>> {
	const cacheDir = imageCacheDir(channel);
	const out = new Map<string, string>();
	const wanted = sources.filter((s): s is LocalImageSource & { url: string } => !!s.url);

	let reused = 0;
	let downloaded = 0;
	let failed = 0;

	await mapLimit(wanted, channel.concurrency, async (item) => {
		const file = path.join(cacheDir, imageFileName(item.key, item.slug, item.url));

		let has = false;
		try {
			await fs.access(file);
			has = true;
		} catch {
			has = false;
		}

		if (has) {
			reused += 1;
		} else {
			if (OFFLINE) {
				failed += 1;
				return;
			}
			const bytes = (await tryDirect(item.url, channel)) ?? (await tryProxy(item.url, channel));
			if (!bytes) {
				failed += 1;
				return;
			}
			try {
				await fs.mkdir(cacheDir, { recursive: true });
				await fs.writeFile(file, bytes);
				downloaded += 1;
			} catch {
				failed += 1;
				return;
			}
		}

		// 标记「本轮用到过」，构建结束只拷这些（见 astro.config.mjs）。
		try {
			const now = new Date();
			await fs.utimes(file, now, now);
		} catch {
			// 刷不了 mtime 就只是这一轮不会被拷进 dist，不影响构建。
		}
		out.set(item.key, imageUrl(channel, path.basename(file)));
	});

	const parts = [`${out.size} / ${wanted.length} 张`];
	if (downloaded > 0) parts.push(`新下载 ${downloaded}`);
	if (reused > 0) parts.push(`命中缓存 ${reused}`);
	if (failed > 0) parts.push(`拿不到 ${failed}（页面降级显示）`);
	// 仅调试用：Astro 不会转发 lib 里的 console，构建汇总由 astro.config.mjs 出。
	if (process.env.IMAGE_DEBUG === '1') console.log(`[${channel.dir}] ${parts.join('，')}`);

	return out;
}
