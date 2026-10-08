import path from 'node:path';
import { cacheFile as cachePath, readCacheJson, writeCacheFile } from './buildCache';
import { reportSource, sourceState } from './dataHealth';
import { type ImageChannel, localizeImages } from './localImages';
import { createPace } from './pace';
import { CHAOHUA_HEADERS, chaohuaFeedUrl, parseChaohuaFeed } from './weiboChaohua';
import type { WeiboPost } from './weiboChaohua';

/**
 * 微博 DOTA2 超话的取数层：构建期抓「最新 · 最新发帖」的第一屏，配图取回站内。
 *
 * 解析与地址形态在 `weiboChaohua.ts`（纯模块）——列表的「加载更多」是运行时按需往下翻的，
 * 那边不能引 `node:fs`。这里再导出一次，页面与自检的引用不用改。
 */
export { toWeiboCard } from './weiboChaohua';
export type { WeiboPost } from './weiboChaohua';

/**
 * 为什么这条能接（而 `data-sources.md` 里早先写着"微博取不到"）
 *
 * 原先试的是三个入口：`weibo.com/ajax/side/hotSearch` 403、`s.weibo.com` 302、
 * `m.weibo.cn/api/container/getIndex` 302/432——那几条确实都要登录态或访客 cookie。
 * 但**超话页面走的是另一条路**：它自己调 `weibo.com/ajax_proxy/chaohua/page?flowId=…`，
 * 实测免登录、免 cookie 直接返回 JSON（连着 6 次都是 200，0.35–0.55 秒）。
 *
 * 一页 15 条，翻页靠响应里回传的 `since_id` 游标（见 `chaohuaNextCursor`）。
 */

const CACHE_DIR = path.join(process.cwd(), '.cache', 'weibo');
const OFFLINE = process.env.TOURNAMENTS_OFFLINE === '1';

/**
 * 列表缓存 10 分钟。
 *
 * 站点每 30 分钟重建一轮，取 10 分钟等于每轮都重新抓一次、而同一个进程里连续取两次只有一次
 * 打上游。超话的活跃度是**几十条一天**（实测 8 页 120 条跨了 76 小时，约 40 条/天），
 * 再短没有意义。
 */
const LIST_TTL_SECONDS = 10 * 60;
/** 超话这边没见到限流，但没必要打太急。 */
const MIN_INTERVAL_MS = 1000;
const FETCH_TIMEOUT_MS = 20 * 1000;
const USER_AGENT =
	'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/**
 * 超话配图频道。
 *
 * **必须构建期取回本地**：微博图床判 Referer，且判法与别家相反——不带 Referer 是 403、
 * 带站外 Referer 也是 403，只有它自己家的 Referer 才给 200。站里的 `<img>` 控制不了浏览器
 * 发什么（为了迁就 Steam 的 CDN 还统一 `referrerpolicy="no-referrer"`），热链必然是裂图。
 *
 * 取的就是卡片要用的那档（`bmiddle`，约 360px 宽、实测十几到几十 KB），所以不额外指定尺寸：
 * 直连拿到的字节原样落盘，只有走代理兜底时才会按 `width`/`height` 缩放。
 */
const WEIBO_PIC_CHANNEL: ImageChannel = {
	dir: 'weibo-pics',
	maxBytes: 512 * 1024,
	concurrency: 4,
	headers: { Referer: 'https://weibo.com/' },
};

/** 串行化请求间隔，避免并发同时穿过限速窗口。 */
const pace = createPace(MIN_INTERVAL_MS);

/** 抓一页。拿不到、或一条都没解析出来（页面改版）都算失败：`null` 让调用方退缓存。 */
async function fetchFeedPage(sinceId?: string | null): Promise<WeiboPost[] | null> {
	await pace();
	try {
		const response = await fetch(chaohuaFeedUrl(sinceId), {
			headers: { ...CHAOHUA_HEADERS, 'User-Agent': USER_AGENT },
			signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
		});
		if (!response.ok) return null;
		const posts = parseChaohuaFeed(await response.json());
		return posts.length > 0 ? posts : null;
	} catch {
		return null;
	}
}

/** 列表本轮是联网抓到的，还是吃缓存/没抓到。 */
interface LoadedFeed {
	posts: WeiboPost[];
	network: boolean;
}

async function loadFeed(): Promise<LoadedFeed> {
	const file = cachePath(CACHE_DIR, 'chaohua-latest.json');
	const cached = await readCacheJson<WeiboPost[]>(file);
	if (cached && cached.ageMs < LIST_TTL_SECONDS * 1000) return { posts: cached.value, network: false };

	let posts: WeiboPost[] | null = null;
	// 抖音/贴吧那种"一次抖动就整栏空掉"的坑没必要重踩：失败重试一次再退缓存。
	for (let attempt = 0; attempt < 2 && posts === null; attempt++) posts = await fetchFeedPage();
	if (posts === null) return { posts: cached?.value ?? [], network: false };

	await writeCacheFile(file, JSON.stringify(posts));
	return { posts, network: true };
}

let feedPromise: Promise<WeiboPost[]> | null = null;

/**
 * 首屏那一批超话帖（最新发帖序），一次构建只抓一轮。取不到就退回旧缓存，再取不到返回空数组。
 */
export function fetchWeiboPosts(): Promise<WeiboPost[]> {
	if (!feedPromise) feedPromise = loadWithPictures();
	return feedPromise;
}

async function loadWithPictures(): Promise<WeiboPost[]> {
	const feed = await loadFeed();

	/*
	 * 配图每一轮都要过一遍 `localizeImages`，**列表命中缓存的那一轮也一样**：
	 * 那个函数命中已有文件时会把 mtime 刷成当前时间，而构建末尾正是按 mtime 判断
	 * 「这张图本轮用到过、要拷进 dist」。跳过这一步的表现是缓存里的图不被发布，
	 * 页面上一排 404（`wmpvpApi` 那边同样的理由）。
	 */
	const pictures = await localizeImages(
		WEIBO_PIC_CHANNEL,
		feed.posts
			.filter((post) => post.image)
			.map((post) => ({ key: post.id, url: post.image, slug: post.id })),
	);
	const posts = feed.posts.map((post) => ({ ...post, localImage: pictures.get(post.id) }));

	const withPicture = posts.filter((post) => post.localImage).length;
	await reportSource(
		'weibo',
		'微博 DOTA2 超话',
		sourceState(feed.network, posts.length),
		posts.length === 0
			? '构建期没取到超话的最新发帖，也没有可用的本地缓存'
			: `${posts.length} 条（最新发帖序），列表${feed.network ? '联网抓取' : '用缓存'}，配图落地 ${withPicture} 张`,
	);
	return posts;
}
