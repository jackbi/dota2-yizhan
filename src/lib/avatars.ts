import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { mapLimit } from './concurrency';
import { PROXY_MODE } from './fetchText';

/**
 * 主播头像：构建期把平台 CDN 上的图取回来，换成本站路径。
 *
 * ## 为什么要自己存一份
 *
 * 头像地址本来就跟着房间数据一起取回来了，**不需要额外请求元数据**：
 * 斗鱼 `betard` 的 `room.owner_avatar`（OB 成员）、虎牙 `profileInfo.avatar180`、
 * 斗鱼分区页的 `av`、虎牙榜单里的 `avatar180`（热门榜）。多出来的工作只有下载图片本身。
 *
 * 之所以不直接热链：
 * - 虎牙给的是 `http://` 地址，站点一旦走 HTTPS 就是混合内容，浏览器直接拦掉；
 * - 允不允许外链由平台随时决定，判不判 Referer 我们控制不了，失败就是一排破图；
 * - 顺带也不把访客的 IP 送给平台 CDN。
 *
 * ## 两条路
 *
 * 直连优先（国内机器上直接就能下），被重置时退回 `wsrv.nl` 图片代理——顺便让它
 * 裁成正方、缩到 128px，因为两家原图的比例和体积都不一样。
 * `LIVE_PROXY` 同样管这里：`off` 只直连，`jina` 只走代理（jina 只能转文本，对图片就是纯代理）。
 *
 * ## 落盘与发布
 *
 * 字节存在 `.cache/avatars/`（不进 git），文件名带房间号和地址哈希——地址一变就是新文件，
 * 不会串图。构建结束由 `astro.config.mjs` 的集成把**本轮用到过**的文件拷进 `dist/avatars/`：
 * 用到的文件在这里会把 mtime 刷新成当前时间，拷的时候以此判断，
 * 免得像房间列表那样越攒越多（房间下榜后它的头像也不该继续占着 dist）。
 *
 * 多进程：Astro 会并行开多个渲染进程，每个进程都会跑一遍本模块，可能重复下载同一个文件。
 * 内容一样、后写的覆盖先写的，所以只是多花一点流量，不会出错。
 */

const CACHE_DIR = path.join(process.cwd(), '.cache', 'avatars');

/** 站内路径前缀，页面与 payload 里用的都是它。 */
export const AVATAR_URL_PREFIX = '/avatars/';

const OFFLINE = process.env.TOURNAMENTS_OFFLINE === '1';
/** 图片比文本重，但对同一个主机不用太客气。 */
const CONCURRENCY = 4;
const DIRECT_TIMEOUT_MS = 8000;
const PROXY_TIMEOUT_MS = 25_000;
/** 一张头像不该有这么大，超过就当成出错了。 */
const MAX_BYTES = 512 * 1024;
/** 卡片最大 56px，2x 屏幕 112px，128 够用。 */
const SIZE = 128;
const IMAGE_PROXY = 'https://wsrv.nl/';

const UA =
	'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/** 一个待本地化的头像来源。`avatar` 是平台 CDN 地址。 */
export interface AvatarSource {
	/** 稳定标识，用来生成文件名，例如 `douyu:9999` */
	key: string;
	avatar?: string;
}

/** 文件名带房间号，出问题时一眼能看出是谁的；哈希保证地址变化会换文件。 */
function fileName(key: string, url: string): string {
	const slug = key.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase();
	const hash = createHash('sha1').update(url).digest('hex').slice(0, 8);
	return `${slug}-${hash}.jpg`;
}

async function readImage(res: Response): Promise<Uint8Array | null> {
	if (!res.ok) return null;
	const type = res.headers.get('content-type') ?? '';
	// 平台挡外链时返回的是一张 HTML 提示页，content-type 一看就知道。
	if (!type.startsWith('image/')) return null;
	const bytes = new Uint8Array(await res.arrayBuffer());
	return bytes.byteLength > 0 && bytes.byteLength <= MAX_BYTES ? bytes : null;
}

async function tryDirect(url: string): Promise<Uint8Array | null> {
	if (PROXY_MODE === 'jina') return null;
	try {
		const res = await fetch(url, {
			headers: { 'User-Agent': UA, Accept: 'image/avif,image/webp,image/*,*/*;q=0.8' },
			signal: AbortSignal.timeout(DIRECT_TIMEOUT_MS),
		});
		return await readImage(res);
	} catch {
		// 本机到 douyucdn / huyaimg 就是被重置的，换代理。
		return null;
	}
}

async function tryProxy(url: string): Promise<Uint8Array | null> {
	if (PROXY_MODE === 'off') return null;
	try {
		const query = `url=${encodeURIComponent(url)}&w=${SIZE}&h=${SIZE}&fit=cover&output=jpg`;
		const res = await fetch(`${IMAGE_PROXY}?${query}`, { signal: AbortSignal.timeout(PROXY_TIMEOUT_MS) });
		return await readImage(res);
	} catch {
		return null;
	}
}

/**
 * 把所有房间的头像下载到本地，返回 `key → /avatars/xxx.jpg`。
 *
 * 拿不到的房间不会出现在返回值里——调用方据此退回首字母占位，不渲染 `<img>`，
 * 所以不存在"文件没拷过去、页面上留一堆破图"的情况。
 */
export async function localizeAvatars(sources: AvatarSource[]): Promise<Map<string, string>> {
	const out = new Map<string, string>();
	const wanted = sources.filter((s): s is AvatarSource & { avatar: string } => !!s.avatar);

	let reused = 0;
	let downloaded = 0;
	let failed = 0;

	await mapLimit(wanted, CONCURRENCY, async (item) => {
		const file = path.join(CACHE_DIR, fileName(item.key, item.avatar));

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
			const bytes = (await tryDirect(item.avatar)) ?? (await tryProxy(item.avatar));
			if (!bytes) {
				failed += 1;
				return;
			}
			try {
				await fs.mkdir(CACHE_DIR, { recursive: true });
				await fs.writeFile(file, bytes);
				downloaded += 1;
			} catch {
				failed += 1;
				return;
			}
		}

		// 标记"本轮用到过"，构建结束只拷这些（见 astro.config.mjs）。
		try {
			const now = new Date();
			await fs.utimes(file, now, now);
		} catch {
			// 刷不了 mtime 就只是这一轮不会被拷进 dist，不影响构建。
		}
		out.set(item.key, `${AVATAR_URL_PREFIX}${path.basename(file)}`);
	});

	const parts = [`${out.size} / ${wanted.length} 张`];
	if (downloaded > 0) parts.push(`新下载 ${downloaded}`);
	if (reused > 0) parts.push(`命中缓存 ${reused}`);
	if (failed > 0) parts.push(`拿不到 ${failed}（页面显示首字母）`);
	// 仅调试用：Astro 不会转发 lib 里的 console，构建汇总由 astro.config.mjs 出。
	if (process.env.AVATAR_DEBUG === '1') console.log(`[avatars] ${parts.join('，')}`);

	return out;
}
