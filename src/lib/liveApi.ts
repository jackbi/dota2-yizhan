import { promises as fs } from 'node:fs';
import path from 'node:path';
import { mapLimit } from './concurrency';
import { reportSource } from './dataHealth';
import { extractJson, fetchNote, fetchText, sleep } from './fetchText';
import { OB_ROOMS } from '../data/ob';
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

async function readCache(file: string, ttlSeconds: number): Promise<LiveStatus | null> {
	try {
		const stat = await fs.stat(file);
		if (Date.now() - stat.mtimeMs >= ttlSeconds * 1000) return null;
		return JSON.parse(await fs.readFile(file, 'utf8')) as LiveStatus;
	} catch {
		return null;
	}
}

async function readStale(file: string): Promise<LiveStatus | null> {
	try {
		return JSON.parse(await fs.readFile(file, 'utf8')) as LiveStatus;
	} catch {
		return null;
	}
}

async function writeCache(file: string, status: LiveStatus): Promise<void> {
	try {
		await fs.mkdir(CACHE_DIR, { recursive: true });
		await fs.writeFile(file, JSON.stringify(status), 'utf8');
	} catch {
		// 缓存写不进去不影响构建。
	}
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

async function loadRoom(room: (typeof OB_ROOMS)[number]): Promise<LiveStatus> {
	const file = path.join(CACHE_DIR, `${room.platform}-${room.roomId}.json`);
	const cached = await readCache(file, TTL_SECONDS);
	if (cached) return cached;

	const stale = OFFLINE ? await readStale(file) : null;
	if (stale) return stale;
	if (OFFLINE) return unknownStatus('离线构建且没有缓存');

	const url = apiUrl(room.platform, room.roomId);
	if (!url) return unknownStatus('暂不支持该平台');

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
			return status;
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
			return status;
		}
	}

	// 主接口没通。Astro 会并行开多个渲染进程，每个进程各自跑一遍本模块（单飞只在进程内生效），
	// 于是可能出现"这个进程失败了、另一个进程刚抓到并写了缓存"。直接标未知会让同一个房间
	// 在不同进程渲染出的页面里不一致，所以先等一下看看同伴有没有写进来。
	const raced = await waitForPeerCache(file);
	if (raced) return raced;

	// 退一步只读房间页标题，确认这个房间号现在显示的是谁，状态仍标未知。
	if (room.platform === 'douyu') {
		const page = await fetchText(`https://www.douyu.com/${room.roomId}`);
		const pageOwner = page ? pageOwnerFromTitle(room.platform, page) : undefined;
		if (pageOwner) {
			return unknownStatus(`房间页显示的主播是「${pageOwner}」，但本次未取到开播状态`);
		}
	}

	return (await readStale(file)) ?? unknownStatus('平台接口没有响应');
}

/**
 * 等一会儿再看缓存：并行的渲染进程可能刚好抓到了同一个房间。
 * 宁可慢一点，也不要把"这个进程没抓到"渲染成"状态未知"。
 */
async function waitForPeerCache(file: string): Promise<LiveStatus | null> {
	for (let i = 0; i < PEER_WAIT_ROUNDS; i++) {
		await sleep(PEER_WAIT_MS);
		const cached = await readStale(file);
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
	await mapLimit(OB_ROOMS, CONCURRENCY, async (room) => {
		statuses[room.key] = await loadRoom(room);
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

	const usable = (counts.get('live') ?? 0) + (counts.get('replay') ?? 0) + (counts.get('offline') ?? 0) + (counts.get('closed') ?? 0);
	const note = fetchNote();

	await reportSource(
		'live',
		'直播开播状态',
		note ? 'fresh' : usable > 0 ? 'cache' : 'empty',
		`${OB_ROOMS.length} 个房间：${parts.join('、') || '无数据'}${note}`,
	);

	return { at: new Date().toISOString(), statuses };
}
