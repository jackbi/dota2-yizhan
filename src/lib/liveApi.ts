import path from 'node:path';
// 带扩展名：自检（`scripts/liveApi.check.ts`）要用 Node 直接跑这个模块，Node 的 ESM 解析不补扩展名。
import { isFresh, readCacheJson, writeCacheFile } from './buildCache.ts';
import { mapLimit } from './concurrency.ts';
import { reportSource } from './dataHealth.ts';
import { extractJson, fetchText, sleep } from './fetchText.ts';
import { OB_ROOMS } from '../data/ob.ts';
import type { LiveSnapshot, LiveState, LiveStatus, Platform } from '../data/types';

/**
 * 直播间开播状态层。
 *
 * ## 数据源
 *
 * 斗鱼用 `https://www.douyu.com/betard/{id}`——房间页自己加载的那份 JSON，房主昵称与
 * 开播状态都是当前值。npm 上的 `douyu-api` 包（renmu123/douyu-video-cli）里的
 * `live.getRoomInfo` 就是这一行 `axios.get(\`https://www.douyu.com/betard/${roomId}\`)`，
 * 没有更神奇的东西；它的直播流接口要 eval 平台 JS 拿签名，跟开播状态无关。
 *
 * **斗鱼的「靓号」不能喂给 betard。** 82088 是 820 的靓号别名：
 * `www.douyu.com/82088` 与 `www.douyu.com/507882` 的 `<title>` 一字不差，但 betard/82088
 * 返回的是「您观看的房间已被关闭」提示页，betard/507882 才是真正的房间 JSON。
 * 曾据此把正在直播的 820 误报成「房间已关闭」，所以房间号一律以平台接口认的规范号为准。
 *
 * **不要用 `open.douyucdn.cn/api/RoomApi/room/{id}`**：它返回的是十几年前的僵尸记录
 * （820 的旧房间返回 2014-10-27 的 start_time、房主「用户已注销」、分区「英雄联盟」）。
 * 整条链路里已经不碰它了。
 *
 * 虎牙用 `https://mp.huya.com/cache.php?m=Live&do=profileRoom&roomid={id}`。
 *
 * 两家接口都没有 CORS 头，浏览器里取不到，只能在构建期由 Node 抓；所以静态站上显示的
 * 是**构建那一刻的快照**，页面必须把抓取时间写出来。
 *
 * ## 拿不到的时候
 *
 * 部分网络（本机就是）到 douyu/huya 的 TLS 握手会被直接重置，因此直连优先、失败退回
 * `r.jina.ai` 读取代理（`LIVE_PROXY` 控制：auto / jina / off）。两条路都会偶发失败，
 * 所以各重试若干次。
 *
 * 主接口失败时，退一步只读房间页标题，用来说明"这个房间号现在显示的是谁"，状态仍标未知。
 *
 * **不下"房间换人"的结论。** 昵称对不上可能只是改了账号名——狗哥的 312407 现在叫「叁肆叁肆」，
 * 之前据昵称断言"房间已由他人使用"是错的。所以昵称只原样展示，判断交给读者。
 * 同理，曾经据 `open.douyucdn.cn` 的房主字段断言"房间已注销"，也是错的。**任何情况下都不编状态。**
 */

const CACHE_DIR = path.join(process.cwd(), '.cache', 'live');
const OFFLINE = process.env.TOURNAMENTS_OFFLINE === '1';

/** 开播状态变化很快，缓存只用来省掉同一轮构建里的重复请求。 */
const TTL_SECONDS = 5 * 60;
/**
 * 网络兜底时旧缓存最多能有多旧。
 *
 * 缓存文件是**上一次构建**留下的，可能是好几天前那份。开播状态按分钟变，把几天前的
 * 「直播中」当现在渲染出来就是编状态——页面上那是个绿点，而 `docs/live.md` 里写死了
 * 「任何情况下都不写死假的正在直播」。所以只拿它兜"连续几次构建都没抓到"这种短暂故障，
 * 超过这个上限就当没有缓存，老老实实标「状态未知」。
 */
export const STALE_MAX_MS = 2 * 60 * 60 * 1000;
/**
 * 离线构建（`TOURNAMENTS_OFFLINE=1`）时能用到多久以前的那份。
 *
 * 离线构建的承诺就是「只用 `.cache/` 里的数据」（README 的变量表），所以门槛比网络兜底宽得多：
 * 卡在 2 小时的话，几天没构建过就整块变「状态未知」，等于一份缓存都没用上。也不能不设上限——
 * 开播状态按分钟变，把上个月的「直播中」画成绿点是同一类错误。
 */
export const OFFLINE_STALE_MAX_MS = 7 * 24 * 60 * 60 * 1000;
/** 代理是第三方服务，别把它打爆。 */
const CONCURRENCY = 3;
/** 抓取失败后等同伴进程写缓存的轮次与间隔。 */
const PEER_WAIT_ROUNDS = 5;
const PEER_WAIT_MS = 500;

export const LIVE_STATE_LABEL: Record<LiveState, string> = {
	live: '直播中',
	replay: '轮播中',
	offline: '未开播',
	closed: '房间已关闭',
	unknown: '状态未知',
};

/**
 * 斗鱼把房间播放关掉时，房间数据接口返回的是一张 HTML 提示页而不是 JSON：
 * 「您观看的房间已被关闭，请选择其他直播进行观看哦！」。房间页本身还在
 * （标题仍挂着主播名），所以这是"平台关闭了播放"，不是"主播没开播"。
 */
const ROOM_CLOSED_RE = /房间已被关闭|房间已下线|房间不存在/;

// ---------------------------------------------------------------- 解析

interface ParsedRoom {
	state: LiveState;
	ownerName?: string;
	roomName?: string;
	avatar?: string;
}

function str(value: unknown): string | undefined {
	return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

/**
 * 头像：`room.avatar` 是个 `{big, middle, small}` 对象，另有一个扁平的 `owner_avatar`
 * 与 big 相同。取 middle——页面上最大也只显示到 56px，没必要拉 big。
 * `isDefaultAvatar` 为 1 时斗鱼给的是系统默认图，那种图不如页面自己的首字母占位，
 * 所以直接不要。
 */
function douyuAvatar(room: Record<string, unknown>): string | undefined {
	if (Number(room.isDefaultAvatar) === 1) return undefined;
	const sizes = (room.avatar ?? {}) as Record<string, unknown>;
	return str(sizes.middle) ?? str(sizes.small) ?? str(room.owner_avatar);
}

function parseDouyu(json: unknown): ParsedRoom | null {
	const room = (json as { room?: Record<string, unknown> } | null)?.room;
	if (!room) return null;
	// 开播标志是 show_status（1 开播 / 2 未开播）。同一个 room 对象里还有个
	// status，它在开播和未开播的房间上都是 '1'（实测 9999/110/88660/8445951/312407
	// 全是 '1'），拿它判断会把所有房间都算成直播中——npm 包 douyu-api 的
	// getRoomInfo 文档注释就写错了，别照抄。
	const status = String(room.show_status ?? '');
	// videoLoop=1 表示房间在放录像轮播：房间挂的是"开播"，但主播本人不在播。
	// 虎牙同类状态是 liveStatus=REPLAY，两边都归到 replay。
	const looping = Number(room.videoLoop) === 1;
	return {
		state: status === '1' ? (looping ? 'replay' : 'live') : status === '2' ? 'offline' : 'unknown',
		ownerName: str(room.nickname),
		roomName: str(room.room_name),
		avatar: douyuAvatar(room),
	};
}

function parseHuya(json: unknown): ParsedRoom | null {
	const root = json as { status?: unknown; data?: Record<string, unknown> } | null;
	if (!root || Number(root.status) !== 200 || !root.data) return null;
	const liveData = (root.data.liveData ?? {}) as Record<string, unknown>;
	const profile = (root.data.profileInfo ?? {}) as Record<string, unknown>;
	const live = String(root.data.liveStatus ?? '');
	return {
		state: live === 'ON' ? 'live' : live === 'REPLAY' ? 'replay' : live === 'OFF' ? 'offline' : 'unknown',
		ownerName: str(profile.nick),
		roomName: str(liveData.roomName),
		// 虎牙给的是 http:// 地址，落地成本地文件后与协议无关，原样留着。
		avatar: str(profile.avatar180),
	};
}

function apiUrl(platform: Platform, roomId: string): string | null {
	if (platform === 'douyu') return `https://www.douyu.com/betard/${roomId}`;
	if (platform === 'huya') return `https://mp.huya.com/cache.php?m=Live&do=profileRoom&roomid=${roomId}`;
	return null;
}

function parseByPlatform(platform: Platform, json: unknown): ParsedRoom | null {
	if (platform === 'douyu') return parseDouyu(json);
	if (platform === 'huya') return parseHuya(json);
	return null;
}

/**
 * 房间页标题里形如 `{分区}_{昵称}直播_{昵称}直播_{昵称}{游戏}直播_{昵称}斗鱼直播`，
 * 取第 2 段去掉「直播」。仅用于主接口失败时判断房间归属。
 */
function pageOwnerFromTitle(platform: Platform, text: string): string | undefined {
	if (platform !== 'douyu') return undefined;
	const title = text.match(/<title>([^<]*)<\/title>/i)?.[1] ?? text.match(/^Title:\s*(.+)$/m)?.[1] ?? '';
	if (!title) return undefined;
	const second = title.split('_')[1]?.replace(/直播$/, '').trim();
	return second || undefined;
}

// ---------------------------------------------------------------- 缓存

/** 命中新鲜缓存的开播状态；过期或坏掉返回 null。 */
async function readCache(file: string, ttlSeconds: number): Promise<LiveStatus | null> {
	const hit = await readCacheJson<LiveStatus>(file);
	return hit && isFresh(hit.ageMs, ttlSeconds) ? hit.value : null;
}

/** 读缓存文件的内容与年龄（不判合不合用）。坏文件、半截 JSON 都当没有缓存。 */
export async function readCachedStatus(file: string): Promise<{ status: LiveStatus; ageMs: number } | null> {
	const hit = await readCacheJson<LiveStatus>(file);
	return hit ? { status: hit.value, ageMs: hit.ageMs } : null;
}

/** 用旧缓存顶上时，把它有多旧写进 `note`：绿点仍是那次抓到的结论，读者得知道是什么时候下的。 */
export function withStaleNote(hit: { status: LiveStatus; ageMs: number }): LiveStatus {
	const minutes = Math.max(1, Math.round(hit.ageMs / 60_000));
	const ago = minutes < 60 ? `${minutes} 分钟前` : `${Math.round(minutes / 60)} 小时前`;
	const note = `本次没取到开播状态，这是 ${ago}的快照`;
	return { ...hit.status, note: hit.status.note ? `${hit.status.note}；${note}` : note };
}

/**
 * 旧缓存按这个场景的年龄上限能不能顶用：能顶就返回带 `note` 的状态，超龄返回 null（当没缓存）。
 *
 * 上限由调用方给，因为两个场景的要求不同：网络兜底只兜短暂故障（`STALE_MAX_MS`），
 * 离线构建要真的用起 `.cache/`（`OFFLINE_STALE_MAX_MS`）。
 */
export function usableStale(hit: { status: LiveStatus; ageMs: number } | null, maxAgeMs: number): LiveStatus | null {
	if (!hit || hit.ageMs > maxAgeMs) return null;
	return withStaleNote(hit);
}

function writeCache(file: string, status: LiveStatus): Promise<void> {
	return writeCacheFile(file, JSON.stringify(status));
}

// ---------------------------------------------------------------- 单个房间

/** 平台没给昵称时不标记为"对不上"——不能凭缺失的信息下结论。 */
function ownerUnrecognized(ownerName: string | undefined, keys: string[]): boolean {
	if (!ownerName) return false;
	const lower = ownerName.toLowerCase();
	return !keys.some((key) => lower.includes(key.toLowerCase()));
}

function unknownStatus(note: string): LiveStatus {
	return { state: 'unknown', ownerUnrecognized: false, note, fetchedAt: new Date().toISOString() };
}

/**
 * 一个房间的结果，外加**它是怎么来的**。
 *
 * 构建摘要要分得清「这一轮真的联网抓到了」与「吃了缓存兜底」——只按进程级的抓取次数判断
 * 会把兜底说成新数据（上游挂了两小时、旧缓存顶上时，摘要照旧写"联网抓取"）。
 */
interface LoadedRoom {
	status: LiveStatus;
	/** `none` = 既没联网拿到、也没有缓存可用（离线构建且没有缓存、上游没响应且没有缓存）。 */
	source: RoomSource;
}

/** 一个房间的状态是从哪来的。 */
export type RoomSource = 'network' | 'cache' | 'none';

/**
 * 构建汇总那一行里的"怎么来的"。
 *
 * 单独抽出来是为了能自检——原先这段逻辑 inline 在 `loadAll` 里，只能靠肉眼看：
 *
 * - `usable === 0` 时这一源就是**没拿到**（全房间状态未知），不能因为"发过请求"写 fresh；
 * - 有房间吃了缓存就写 `cache`（那份状态是旧构建的结论）；
 * - 「没有缓存可用」那批**不算吃缓存**：一份缓存都没读到却印出"吃缓存 11 个"就是假账。
 */
export function sourceSummary(
	sources: readonly RoomSource[],
	usable: number,
): { status: 'fresh' | 'cache' | 'empty'; text: string } {
	const network = sources.filter((source) => source === 'network').length;
	const cache = sources.filter((source) => source === 'cache').length;
	const none = sources.filter((source) => source === 'none').length;
	const parts = [`本轮联网 ${network} 个`, `吃缓存 ${cache} 个`];
	if (none > 0) parts.push(`没取到 ${none} 个`);
	return { status: usable === 0 ? 'empty' : cache > 0 ? 'cache' : 'fresh', text: parts.join('、') };
}

async function loadRoom(room: (typeof OB_ROOMS)[number]): Promise<LoadedRoom> {
	const file = path.join(CACHE_DIR, `${room.platform}-${room.roomId}.json`);
	const cached = await readCache(file, TTL_SECONDS);
	if (cached) return { status: cached, source: 'cache' };

	if (OFFLINE) {
		const hit = await readCachedStatus(file);
		const stale = usableStale(hit, OFFLINE_STALE_MAX_MS);
		if (stale) return { status: stale, source: 'cache' };
		// 「没有缓存」与「有缓存但太旧」分开说：后者说明缓存策略没问题，只是太久没构建过。
		const why = hit ? `离线构建，缓存超过 ${OFFLINE_STALE_MAX_MS / 86_400_000} 天没用上` : '离线构建且没有缓存';
		return { status: unknownStatus(why), source: 'none' };
	}

	const url = apiUrl(room.platform, room.roomId);
	if (!url) return { status: unknownStatus('暂不支持该平台'), source: 'none' };

	const text = await fetchText(url);
	if (text) {
		const parsed = parseByPlatform(room.platform, extractJson(text));
		if (parsed) {
			// 昵称对不上只作为提示，不改状态、也不下"房间换人"的结论。
			const status: LiveStatus = {
				state: parsed.state,
				ownerName: parsed.ownerName,
				roomName: parsed.roomName,
				avatar: parsed.avatar,
				ownerUnrecognized: ownerUnrecognized(parsed.ownerName, room.ownerMatch),
				fetchedAt: new Date().toISOString(),
			};
			await writeCache(file, status);
			return { status, source: 'network' };
		}

		// 斗鱼关闭房间播放时给的是一张提示页，这里如实记成 closed。
		if (room.platform === 'douyu' && ROOM_CLOSED_RE.test(text)) {
			const page = await fetchText(`https://www.douyu.com/${room.roomId}`);
			const pageOwner = page ? pageOwnerFromTitle(room.platform, page) : undefined;
			const status: LiveStatus = {
				state: 'closed',
				ownerName: pageOwner,
				ownerUnrecognized: ownerUnrecognized(pageOwner, room.ownerMatch),
				note: pageOwner
					? `斗鱼已关闭该房间的播放（房间页仍显示主播为「${pageOwner}」）`
					: '斗鱼已关闭该房间的播放',
				fetchedAt: new Date().toISOString(),
			};
			await writeCache(file, status);
			return { status, source: 'network' };
		}
	}

	// 主接口没通。Astro 会并行开多个渲染进程，每个进程各自跑一遍本模块（单飞只在进程内生效），
	// 于是可能出现"这个进程失败了、另一个进程刚抓到并写了缓存"。直接标未知会让同一个房间
	// 在不同进程渲染出的页面里不一致，所以先等一下看看同伴有没有写进来。
	const raced = await waitForPeerCache(file);
	if (raced) return { status: raced, source: 'cache' };

	// 退一步只读房间页标题，确认这个房间号现在显示的是谁，状态仍标未知。
	if (room.platform === 'douyu') {
		const page = await fetchText(`https://www.douyu.com/${room.roomId}`);
		const pageOwner = page ? pageOwnerFromTitle(room.platform, page) : undefined;
		if (pageOwner) {
			return { status: unknownStatus(`房间页显示的主播是「${pageOwner}」，但本次未取到开播状态`), source: 'network' };
		}
	}

	const stale = usableStale(await readCachedStatus(file), STALE_MAX_MS);
	return { status: stale ?? unknownStatus('平台接口没有响应'), source: stale ? 'cache' : 'none' };
}

/**
 * 等一会儿再看缓存：并行的渲染进程可能刚好抓到了同一个房间。
 * 宁可慢一点，也不要把"这个进程没抓到"渲染成"状态未知"。
 *
 * **必须按 TTL 判**：这里等的是"同一个构建里另一个进程刚抓到并写了缓存"，只有 TTL 内的
 * 才算"刚写的"。用更宽的门槛（`STALE_MAX_MS` 那档）会把上一轮构建留下的旧文件当成同伴的
 * 结果直接返回，还跳过"这是旧快照"那句提示——那恰恰是这条兜底最该说出来的话。
 */
async function waitForPeerCache(file: string): Promise<LiveStatus | null> {
	for (let i = 0; i < PEER_WAIT_ROUNDS; i++) {
		await sleep(PEER_WAIT_MS);
		const cached = await readCache(file, TTL_SECONDS);
		if (cached) return cached;
	}
	return null;
}

// ---------------------------------------------------------------- 对外接口

let snapshotPromise: Promise<LiveSnapshot> | null = null;

/**
 * 构建期抓取全部房间的开播状态。页面、首页与分屏页共用同一份结果，一次构建只抓一轮。
 */
export function fetchLiveSnapshot(): Promise<LiveSnapshot> {
	if (!snapshotPromise) snapshotPromise = loadAll();
	return snapshotPromise;
}

async function loadAll(): Promise<LiveSnapshot> {
	const statuses: Record<string, LiveStatus> = {};
	// 按房间记来源：进程级的抓取次数分不出"这一格是抓的"还是"吃了旧缓存兜底"。
	const sources: RoomSource[] = [];
	await mapLimit(OB_ROOMS, CONCURRENCY, async (room) => {
		const loaded = await loadRoom(room);
		statuses[room.key] = loaded.status;
		sources.push(loaded.source);
	});

	const counts = new Map<LiveState, number>();
	let unrecognized = 0;
	for (const status of Object.values(statuses)) {
		counts.set(status.state, (counts.get(status.state) ?? 0) + 1);
		if (status.ownerUnrecognized) unrecognized += 1;
	}

	const parts = (['live', 'replay', 'offline', 'closed', 'unknown'] as LiveState[])
		.filter((state) => counts.has(state))
		.map((state) => `${LIVE_STATE_LABEL[state]} ${counts.get(state)}`);
	if (unrecognized > 0) parts.push(`平台昵称与旧叫法不同 ${unrecognized}`);

	// 「拿没拿到」看的是**能用**的状态有几个：全是「状态未知」时这一源就是没拿到，
	// 不能因为"这一轮确实发过请求"就写成 fresh（上游挂掉那一轮正是这个形状）。
	const usable = (counts.get('live') ?? 0) + (counts.get('replay') ?? 0) + (counts.get('offline') ?? 0) + (counts.get('closed') ?? 0);
	const summary = sourceSummary(sources, usable);

	await reportSource(
		'live',
		'直播开播状态',
		summary.status,
		`${OB_ROOMS.length} 个房间：${parts.join('、') || '无数据'}（${summary.text}）`,
	);

	return { at: new Date().toISOString(), statuses };
}
