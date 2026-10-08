import path from 'node:path';
import { cacheFile as cachePath, isFresh, readCacheJson, writeCacheFile } from './buildCache';
import { mapLimit } from './concurrency';
import { reportSource, sourceState } from './dataHealth';
import { type ImageChannel, localizeImages } from './localImages';
import { createPace } from './pace';
import {
	CHAOHUA_HEADERS,
	WEIBO_FIRST_SCREEN,
	WEIBO_WINDOW_PAGES,
	chaohuaFeedUrl,
	chaohuaNextCursor,
	cleanWeiboText,
	parseChaohuaFeed,
} from './weiboChaohua';
import type { WeiboPost } from './weiboChaohua';

/**
 * 微博 DOTA2 超话的取数层：构建期抓「最新 · 最新发帖」的整个窗口，正文补全、配图取回站内。
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
 * 实测免登录、免 cookie 直接返回 JSON。
 *
 * 一页 15 条，翻页靠响应里回传的 `since_id` 游标（见 `chaohuaNextCursor`）。
 *
 * ## 为什么要抓整个窗口（而不是只抓首屏）
 *
 * 站内的超话详情页是**预渲染**的（`/weibo/<mid>/`，与官网新闻、完美世界、Reddit 一致），
 * 而列表的「加载更多」翻出来的卡片也指回站内。两边窗口对不上的话，翻出来的卡片就是死链——
 * 所以构建期把 `WEIBO_WINDOW_PAGES` 页全部抓下来（8 页 120 条，实测覆盖约 3 天），
 * 逐条生成详情页，而那个页数同时就是「加载更多」的上限（`listMore.ts` 从这里取）。
 */

const CACHE_DIR = path.join(process.cwd(), '.cache', 'weibo');
const OFFLINE = process.env.TOURNAMENTS_OFFLINE === '1';

/**
 * 窗口缓存 10 分钟。
 *
 * 站点每 30 分钟重建一轮，取 10 分钟等于每轮都重新抓一次、而同一轮里只抓一次。
 * 超话的活跃度是**几十条一天**（实测 8 页 120 条跨了 76 小时，约 40 条/天）。
 */
const LIST_TTL_SECONDS = 10 * 60;
/** 访客 cookie 官方给一年，但站点每 30 分钟就重建一轮，取 7 天足够、也留了失效重取的机会。 */
const GUEST_COOKIE_TTL_SECONDS = 7 * 24 * 3600;
/** 超话这边没见到限流，但没必要打太急。 */
const MIN_INTERVAL_MS = 1000;
/** 补全文那条是另一个接口，可以密一点。 */
const LONG_TEXT_INTERVAL_MS = 400;
const FETCH_TIMEOUT_MS = 20 * 1000;
const USER_AGENT =
	'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/**
 * 超话配图的两个频道。
 *
 * **必须构建期取回本地**：微博图床判 Referer，且判法与别家相反——不带 Referer 是 403、
 * 带站外 Referer 也是 403，只有它自己家的 Referer 才给 200。站里的 `<img>` 控制不了浏览器
 * 发什么（为了迁就 Steam 的 CDN 还统一 `referrerpolicy="no-referrer"`），热链必然是裂图。
 *
 * 分两档是因为**卡片和详情页要的尺寸差一倍多**：卡片 360px 实测 18 KB、详情 720px 实测 106 KB，
 * 直接拿详情那张当缩略图，等于让列表首屏多下二十倍字节。
 */
const THUMB_CHANNEL: ImageChannel = {
	dir: 'weibo-pics',
	maxBytes: 512 * 1024,
	concurrency: 4,
	headers: { Referer: 'https://weibo.com/' },
};
const DETAIL_CHANNEL: ImageChannel = {
	dir: 'weibo-detail',
	maxBytes: 1024 * 1024,
	concurrency: 4,
	headers: { Referer: 'https://weibo.com/' },
};

/** 串行化请求间隔，避免并发同时穿过限速窗口。 */
const pace = createPace(MIN_INTERVAL_MS);
const longTextPace = createPace(LONG_TEXT_INTERVAL_MS);

interface FeedPage {
	posts: WeiboPost[];
	next: string | null;
}

/** 抓一页。拿不到、或一条都没解析出来（页面改版）都算失败：`null` 让调用方退缓存。 */
async function fetchFeedPage(sinceId?: string | null): Promise<FeedPage | null> {
	await pace();
	try {
		const response = await fetch(chaohuaFeedUrl(sinceId), {
			headers: { ...CHAOHUA_HEADERS, 'User-Agent': USER_AGENT },
			signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
		});
		if (!response.ok) return null;
		const json = await response.json();
		const posts = parseChaohuaFeed(json);
		return posts.length > 0 ? { posts, next: chaohuaNextCursor(json) } : null;
	} catch {
		return null;
	}
}

// ---------------------------------------------------------------- 长帖全文

/**
 * 访客 cookie。
 *
 * 列表接口本身不需要它，但**长帖全文那条要**：`ajax/statuses/longtext` 不带 cookie 会 302 到
 * 「Sina Visitor System」。这条 cookie 是免登录的访客身份（`SUB` / `SUBP`），拿法就是页面
 * 那两步：`genvisitor` 换 tid、`visitor?a=incarnate` 换 cookie。拿不到就算了——
 * 全文是锦上添花，正文退回首 150 字，并在详情页上说明。
 */
async function guestCookie(): Promise<string | null> {
	const file = cachePath(CACHE_DIR, 'guest-cookie.json');
	const cached = await readCacheJson<string>(file);
	if (cached && isFresh(cached.ageMs, GUEST_COOKIE_TTL_SECONDS)) return cached.value;
	if (OFFLINE) return cached?.value ?? null;

	try {
		const fingerprint = JSON.stringify({
			os: '1',
			browser: 'Chrome120',
			fonts: '1',
			screenInfo: '1920*1080*24',
			plugins: '',
		});
		const visit = await fetch('https://passport.weibo.com/visitor/genvisitor', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/x-www-form-urlencoded',
				'User-Agent': USER_AGENT,
				Referer: 'https://passport.weibo.com/visitor/visitor',
			},
			body: `cb=gen_callback&fp=${encodeURIComponent(fingerprint)}`,
			signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
		});
		const tid = (await visit.text()).match(/"tid":"([^"]+)"/)?.[1];
		if (!tid) return null;

		const incarnate = await fetch(
			`https://passport.weibo.com/visitor/visitor?a=incarnate&t=${tid}&w=3&c=095&gc=&cb=cross_domain&from=weibo&_rand=0.1`,
			{
				headers: { 'User-Agent': USER_AGENT, Referer: 'https://passport.weibo.com/visitor/visitor' },
				signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
			},
		);
		/*
		 * `SUB` 是身份、`SUBP` 是它的配对串，两个都要带。同一个响应里还有几个 passport 域下的
		 * cookie（`SVB`/`SRT`/`SRF`），带去 weibo.com 没有意义，丢掉。
		 */
		// `getSetCookie()` 要 Node 20+；老运行时上退回只读得到一条的那种取法（够用：SUB 在最前）。
		const setCookies =
			typeof incarnate.headers.getSetCookie === 'function'
				? incarnate.headers.getSetCookie()
				: [incarnate.headers.get('set-cookie') ?? ''];
		const jar = setCookies
			.map((cookie) => cookie.split(';')[0])
			.filter((pair) => /^(SUB|SUBP)=/.test(pair))
			.join('; ');
		if (!/SUB=/.test(jar)) return null;

		await writeCacheFile(file, JSON.stringify(jar));
		return jar;
	} catch {
		return null;
	}
}

/** 一条长帖的全文。拿不到就是 `null`（正文保持截断的那份）。 */
async function fetchLongText(id: string, cookie: string): Promise<string | null> {
	await longTextPace();
	try {
		const response = await fetch(`https://weibo.com/ajax/statuses/longtext?id=${encodeURIComponent(id)}`, {
			headers: { ...CHAOHUA_HEADERS, 'User-Agent': USER_AGENT, Cookie: cookie },
			signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
		});
		if (!response.ok) return null;
		const json = (await response.json()) as { data?: { longTextContent?: unknown } };
		const raw = json.data?.longTextContent;
		if (typeof raw !== 'string') return null;
		const text = cleanWeiboText(raw);
		return text.length > 0 ? text : null;
	} catch {
		return null;
	}
}

/** 把窗口里被上游截断的那些长帖补成全文。任一环节失败都只是保持截断，不影响别的帖。 */
async function fillLongText(posts: WeiboPost[]): Promise<{ posts: WeiboPost[]; filled: number }> {
	const truncated = posts.filter((post) => post.truncated);
	if (truncated.length === 0 || OFFLINE) return { posts, filled: 0 };
	const cookie = await guestCookie();
	if (!cookie) return { posts, filled: 0 };

	const full = new Map<string, string>();
	await mapLimit(truncated, 2, async (post) => {
		const text = await fetchLongText(post.id, cookie);
		if (text) full.set(post.id, text);
	});
	if (full.size === 0) return { posts, filled: 0 };
	return {
		posts: posts.map((post) => {
			const text = full.get(post.id);
			return text ? { ...post, text, truncated: false } : post;
		}),
		filled: full.size,
	};
}

// ---------------------------------------------------------------- 窗口

/** 窗口本轮是联网抓到的，还是吃缓存/没抓到。 */
interface LoadedWindow {
	posts: WeiboPost[];
	network: boolean;
	/** 本轮实际抓到了几页（吃缓存时是 0）。 */
	pages: number;
	filled: number;
}

async function loadWindow(): Promise<LoadedWindow> {
	const file = cachePath(CACHE_DIR, 'chaohua-window.json');
	const cached = await readCacheJson<WeiboPost[]>(file);
	if (cached && isFresh(cached.ageMs, LIST_TTL_SECONDS)) {
		return { posts: cached.value, network: false, pages: 0, filled: 0 };
	}

	const collected: WeiboPost[] = [];
	let cursor: string | null = null;
	let pages = 0;
	if (!OFFLINE) {
		for (let page = 1; page <= WEIBO_WINDOW_PAGES; page++) {
			const batch = await fetchFeedPage(cursor);
			/*
			 * 第 1 页拿不到就是整窗没拿到（退缓存）；后面某一页断了就**用已经拿到的那些**——
			 * 少几页只是镜像窗口短一点，总比整栏空掉强。
			 */
			if (!batch) break;
			collected.push(...batch.posts);
			pages = page;
			cursor = batch.next;
			if (!cursor) break;
		}
	}
	if (pages === 0) return { posts: cached?.value ?? [], network: false, pages: 0, filled: 0 };

	// 相邻页偶尔会重叠（推荐位与时间序混在一起），按 mid 去重。
	const seen = new Set<string>();
	const unique = collected.filter((post) => {
		if (seen.has(post.id)) return false;
		seen.add(post.id);
		return true;
	});

	const { posts, filled } = await fillLongText(unique);
	await writeCacheFile(file, JSON.stringify(posts));
	return { posts, network: true, pages, filled };
}

/**
 * 把窗口里每条帖的图都落到站内。
 *
 * 分两趟：先按 720px 那档取，取不到的（地址形态变了之类）再拿接口直接给的 960px 那档兜一次。
 * 两趟都拿不到的那张就从详情页上消失——不留一个 403 的破图。
 */
async function localizePictures(posts: WeiboPost[]): Promise<Map<string, string>> {
	const wanted = new Map<string, { key: string; url: string; slug: string }>();
	const fallbackOf = new Map<string, string>();
	for (const post of posts) {
		for (const picture of post.pictures) {
			if (!wanted.has(picture.id)) {
				wanted.set(picture.id, { key: picture.id, url: picture.url, slug: picture.id });
				fallbackOf.set(picture.id, picture.fallback);
			}
		}
	}

	const list = [...wanted.values()];
	const found = await localizeImages(DETAIL_CHANNEL, list);
	const missing = list.filter((item) => !found.has(item.key));
	if (missing.length > 0) {
		const retry = missing.map((item) => ({
			key: item.key,
			url: fallbackOf.get(item.key) ?? item.url,
			slug: item.slug,
		}));
		for (const [key, value] of await localizeImages(DETAIL_CHANNEL, retry)) found.set(key, value);
	}
	return found;
}

let windowPromise: Promise<WeiboPost[]> | null = null;

/**
 * 窗口内的全部超话帖（最新发帖序，新在前），一次构建只抓一轮。
 *
 * 页面拿它做两件事：资讯页取前 `WEIBO_FIRST_SCREEN` 条当首屏，`/weibo/<mid>/` 逐条生成详情页。
 * 取不到就退回旧缓存，再取不到返回空数组。
 */
export function fetchWeiboPosts(): Promise<WeiboPost[]> {
	if (!windowPromise) windowPromise = loadWithPictures();
	return windowPromise;
}

async function loadWithPictures(): Promise<WeiboPost[]> {
	const window = await loadWindow();

	/*
	 * 缩略图只给首屏那几条：卡片只有首屏有图（运行时翻出来的在 Workers 上落不了地），
	 * 而详情图是整窗都要的。
	 *
	 * 每一轮都要过一遍 `localizeImages`，**窗口命中缓存的那一轮也一样**：它命中已有文件时会把
	 * mtime 刷成当前时间，而构建末尾正是按 mtime 判断「这张图本轮用到过、要拷进 dist」。
	 * 跳过这一步的表现是缓存里的图不被发布，页面上一排 404（`wmpvpApi` 那边同样的理由）。
	 */
	const thumbs = await localizeImages(
		THUMB_CHANNEL,
		window.posts
			.slice(0, WEIBO_FIRST_SCREEN)
			.filter((post) => post.image)
			.map((post) => ({ key: post.id, url: post.image, slug: post.id })),
	);
	const details = await localizePictures(window.posts);
	const posts = window.posts.map((post) => ({
		...post,
		localImage: thumbs.get(post.id),
		localPictures: post.pictures.map((picture) => details.get(picture.id) ?? null),
	}));

	const pictureTotal = posts.reduce((sum, post) => sum + post.pictures.length, 0);
	const pictureLocal = posts.reduce((sum, post) => sum + post.localPictures.filter(Boolean).length, 0);
	const truncated = posts.filter((post) => post.truncated).length;
	await reportSource(
		'weibo',
		'微博 DOTA2 超话',
		sourceState(window.network, posts.length),
		posts.length === 0
			? '构建期没取到超话的最新发帖，也没有可用的本地缓存'
			: `${posts.length} 条（最新发帖序），列表${window.network ? `联网抓取 ${window.pages} 页` : '用缓存'}，` +
					`长帖补全 ${window.filled} 条${truncated > 0 ? `（还有 ${truncated} 条只剩前 150 字）` : ''}，` +
					`详情配图落地 ${pictureLocal} / ${pictureTotal} 张`,
	);
	return posts;
}
